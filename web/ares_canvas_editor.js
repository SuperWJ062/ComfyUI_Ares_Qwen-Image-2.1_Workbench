/**
 * Ares Canvas Editor —— iframe 宿主
 *
 * 职责：把 `ares_canvas_editor_v2.html` 以 iframe 浮层方式嵌进 ComfyUI，
 *       负责初始参数下发、结果回传、以及外层样式（遮罩/尺寸/卸载）。
 *
 * 对外契约（与旧版完全一致，调用方无需改动）：
 *   openCanvasEditor(opts) -> Promise<{blob,width,height} | null>
 *   closeCanvasEditor()    -> void
 *
 * opts:
 *   baseUrl   : string            底图 URL（省略则空画板）
 *   baseName  : string            底图图层名
 *   layerUrls : (string|{url,name})[]  追加图层
 *   presetW   : number            画板初始宽（省略则取底图原始宽度）
 *   presetH   : number            画板初始高
 *   title     : string            顶栏标题
 *
 * 为什么走 iframe：
 *   独立文档 + 原生 canvas，绘制事件与主线程 ComfyUI 的 DOM 完全隔离；
 *   8192 级画布不会因宿主重排而掉帧。
 */

import { api } from "../../scripts/api.js";

const EDITOR_PAGE = "ares_canvas_editor_v2.html";
const PAGE_URL = new URL(EDITOR_PAGE, import.meta.url).href;

/** 单例宿主元素与当前会话 */
let hostEl = null;        // 遮罩层
let frameEl = null;       // iframe
let currentResolve = null;
let currentToken = 0;

/* ---------------- 外层浮层样式 ---------------- */
const HOST_CSS = {
  position: "fixed",
  inset: "0",
  zIndex: "99998",
  background: "rgba(4,6,9,.72)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const FRAME_CSS = {
  width: "100%",
  height: "100%",
  maxWidth: "1680px",
  maxHeight: "1020px",
  border: "1px solid #2b333d",
  borderRadius: "10px",
  background: "#090b0f",
  boxShadow: "0 30px 90px rgba(0,0,0,.7)",
  display: "block",
};

function applyStyle(el, css) {
  for (const k in css) el.style[k] = css[k];
}

/* ---------------- 图层文档：图源上传 ---------------- */

/** data: URL -> Blob，宿主侧负责转换（iframe 不能直接调 upload 接口） */
function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || "");
  const m = /^data:([^;,]+)?(;base64)?,/.exec(s);
  if (!m) return null;
  const mime = m[1] || "image/png";
  const body = s.slice(m[0].length);
  try {
    if (m[2]) {
      const bin = atob(body);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch (_) {
    return null;
  }
}

/** 把任意 URL 抓成 Blob（同源 /view、blob:、data: 都走这条路） */
async function urlToBlob(url) {
  const s = String(url || "");
  if (!s) return null;
  if (s.startsWith("data:")) return dataUrlToBlob(s);
  const res = await fetch(s);
  if (!res.ok) throw new Error(`抓取图层失败 HTTP ${res.status}`);
  return await res.blob();
}

/** blob -> /upload/image，返回相对路径（与 target.image 同格式） */
async function uploadBlob(blob, filename) {
  const form = new FormData();
  form.append("image", blob, filename);
  form.append("overwrite", "true");
  const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok || !data?.name) throw new Error(`上传失败 HTTP ${res.status}`);
  const sub = String(data?.subfolder || "");
  return {
    path: sub ? `${sub}/${data.name}` : data.name,
    type: "input",
    subfolder: sub,
    name: data.name,
  };
}

/** 判断一个图源是否已经是 ComfyUI 能直接 /view 的路径（非 data:/blob:） */
function needsUpload(url) {
  const s = String(url || "");
  if (!s) return false;
  if (s.startsWith("data:") || s.startsWith("blob:")) return true;
  return false;
}

/** 上传失败的 base64 体积上限：超过就丢图源，防工作流 JSON 膨胀 */
const DOC_DATAURL_MAX = 512 * 1024;

/** 上传结果 -> 画布页 img 可直接加载的 /view URL。
 *  裸相对路径（如 ares_layer_x.png）当 img.src 会请求到站点根 404，
 *  /view 必须带 filename/type/subfolder 参数。 */
function viewPath(up) {
  const p = new URLSearchParams();
  p.set("filename", up.name);
  p.set("type", up.type || "input");
  p.set("subfolder", up.subfolder || "");
  return `/view?${p.toString()}`;
}

/**
 * 把 doc 里每个图层的图源统一成"/view 可访问的 input 路径"。
 * 已经上传过的（相对路径）原样保留，避免每次打开都重传。
 * 上传失败不阻断主流程，只是该层下次打开会缺图源。
 */
async function normalizeDocSources(doc) {
  if (!doc || !Array.isArray(doc.layers)) return doc;
  for (let i = 0; i < doc.layers.length; i++) {
    const layer = doc.layers[i];
    const src = layer && layer.url;
    if (!src || !needsUpload(src)) continue;
    try {
      const blob = await urlToBlob(src);
      if (!blob) continue;
      const up = await uploadBlob(blob, `ares_layer_${Date.now()}_${i}.png`);
      layer.url = viewPath(up);
      layer.type = up.type;
      layer.subfolder = up.subfolder;
    } catch (_) {
      // 上传失败才设闸：超限 base64 丢图源（防工作流 JSON 膨胀），
      // 小于阈值的保留 —— 画布页还能直接显示，只是不进工作流序列化
      if (src.startsWith("data:") && src.length > DOC_DATAURL_MAX) {
        layer.url = "";
      }
    }
  }
  return doc;
}

/* ---------------- 消息处理 ---------------- */
function onMessage(ev) {
  // 只接受自己这个 iframe 发来的消息
  if (!frameEl || ev.source !== frameEl.contentWindow) return;
  const d = ev.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "ARES_CANVAS_RESULT") {
    const raw = d.result && d.result.blob ? d.result : null;
    // 先把浮层收掉，再回调调用方，避免"点了按钮界面还在"的错觉
    const fn = currentResolve;
    currentResolve = null;
    closeCanvasEditor();
    if (!fn) return;
    if (!raw) { fn(null); return; }
    // 图层文档的图源要在关闭浮层后补一轮上传，再把完整结果交出去
    normalizeDocSources(raw.doc)
      .then(() => raw.doc)
      .catch(() => raw.doc)
      .then((doc) => fn({ ...raw, doc }));
  }
}

function settle(result) {
  if (!currentResolve) return;
  const fn = currentResolve;
  currentResolve = null;
  closeCanvasEditor();
  if (!result || !result.blob) { fn(null); return; }
  normalizeDocSources(result.doc)
    .then(() => result.doc)
    .catch(() => result.doc)
    .then((doc) => fn({ ...result, doc }));
}

/* ---------------- 开 / 关 ---------------- */
export function closeCanvasEditor() {
  if (currentResolve) {
    const fn = currentResolve;
    currentResolve = null;
    fn(null);
  }
  currentToken++;
  window.removeEventListener("message", onMessage);
  if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
  if (frameEl && frameEl.parentNode) frameEl.parentNode.removeChild(frameEl);
  hostEl = null;
  frameEl = null;
}

export function openCanvasEditor(opts = {}) {
  closeCanvasEditor();

  const token = ++currentToken;

  hostEl = document.createElement("div");
  applyStyle(hostEl, HOST_CSS);

  frameEl = document.createElement("iframe");
  applyStyle(frameEl, FRAME_CSS);
  frameEl.setAttribute("allow", "clipboard-write");
  // 不要 sandbox：需要同源读 /view 图与上传 blob
  // 时间戳防缓存：同 URL 的 iframe 重载会命中浏览器缓存，导致改了页面不生效
  frameEl.src = PAGE_URL + "?v=" + Date.now();

  hostEl.appendChild(frameEl);
  document.body.appendChild(hostEl);

  window.addEventListener("message", onMessage);

  const payload = {
    baseUrl: opts.baseUrl || "",
    baseName: opts.baseName || "底图",
    layerUrls: Array.isArray(opts.layerUrls) ? opts.layerUrls : [],
    presetW: Number(opts.presetW) || 0,
    presetH: Number(opts.presetH) || 0,
    title: opts.title || "画布编辑器",
    // 重绘范围工具：仅第 1 张参考图的编辑器启用
    inpaintCrop: !!opts.inpaintCrop,
    // 上一轮的图层文档：有则整体还原（图层模式 + 记忆上次编辑），无则按 baseUrl 建单层
    doc: opts.doc || null,
  };

  return new Promise((resolve) => {
    currentResolve = resolve;

    // 页面加载完再下发初始数据；轮询兜底应对 load 事件丢失
    let sent = false;
    const send = () => {
      if (sent || token !== currentToken) return;
      if (!frameEl || !frameEl.contentWindow) return;
      sent = true;
      frameEl.contentWindow.postMessage(
        { type: "ARES_CANVAS_INIT", payload },
        "*"
      );
    };

    frameEl.addEventListener("load", () => {
      // 让子页把 boot() 里的首帧渲染跑完，再灌真实数据
      setTimeout(send, 30);
    });

    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (token !== currentToken || tries > 120) {
        clearInterval(poll);
        return;
      }
      if (sent) { clearInterval(poll); return; }
      // iframe 同源可访问 contentDocument 时才尝试；跨源会抛错，忽略
      try {
        const doc = frameEl.contentDocument;
        if (doc && doc.readyState === "complete") send();
      } catch (_) {}
    }, 50);

    // 兜底：极端情况下 6 秒后仍未收到结果，视为失败但保留界面
    setTimeout(() => {
      if (token === currentToken && !sent) send();
    }, 6000);
  });
}

/* 让调用方也能主动喂消息（调试用） */
export function postToCanvasEditor(msg) {
  if (frameEl && frameEl.contentWindow) {
    frameEl.contentWindow.postMessage(msg, "*");
  }
}
