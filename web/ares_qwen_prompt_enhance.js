/**
 * Ares Qwen 工作台：风格样图 / 最多 6 张参考图（遮罩）/ 按行提示词。
 */
import { app, ComfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  bindDomWidgetWidthToNode,
  configureFullWidthDomWidget,
} from "./dom_widget_layout.js";
import { openCanvasEditor, closeCanvasEditor } from "./ares_canvas_editor.js";

function getComfyApp() {
  if (ComfyApp && (ComfyApp.open_maskeditor || ComfyApp.copyToClipspace)) return ComfyApp;
  if (typeof window !== "undefined" && window.ComfyApp) return window.ComfyApp;
  const C = app?.constructor;
  if (C && (C.open_maskeditor || C.copyToClipspace)) return C;
  return ComfyApp || C || null;
}

const NODE_NAME = "AresQwenWorkbench";
const MAX_IMAGES = 6;
const H_KEY = "ares_qwen_pe_heights";
const NONE_THUMB = "/ares_qwen/styles/image?file=style_none.webp";

function findW(node, name) {
  return node.widgets?.find((w) => w?.name === name);
}
function hideWidget(w) {
  if (!w) return;
  if (w.type !== "hidden") {
    w.origType = w.type;
    w.origComputeSize = w.computeSize;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
  }
  try {
    w.hidden = true;
  } catch (_) {}
  if (w.element) w.element.style.display = "none";
}
function setVal(w, v) {
  if (!w) return;
  w.value = v;
  try {
    w.callback?.(v);
  } catch (_) {}
}
function parseJSON(raw, fallback) {
  try {
    const v = JSON.parse(raw || "");
    return v ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function makeSplitter(getH, setH, save) {
  const sp = document.createElement("div");
  sp.title = "拖动调整高度";
  sp.style.cssText =
    "height:8px;cursor:row-resize;flex-shrink:0;background:#333;border-radius:2px;margin:2px 0;touch-action:none;";
  sp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = getH();
    const pid = e.pointerId;
    let ended = false;
    try {
      sp.setPointerCapture(pid);
    } catch (_) {}
    const end = (ev) => {
      if (ended) return;
      if (ev && ev.type !== "blur" && ev.pointerId != null && ev.pointerId !== pid) return;
      ended = true;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end, true);
      try {
        sp.releasePointerCapture(pid);
      } catch (_) {}
      save?.();
    };
    const move = (ev) => {
      if (ended || (ev.pointerId != null && ev.pointerId !== pid)) return;
      if (ev.buttons != null && (ev.buttons & 1) === 0) {
        end(ev);
        return;
      }
      ev.preventDefault?.();
      ev.stopPropagation?.();
      setH(Math.max(90, startH + (ev.clientY - startY)));
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end, true);
  });
  return sp;
}

function cardCss(sel) {
  return `cursor:pointer;border:2px solid ${sel ? "#6af" : "#333"};border-radius:6px;padding:4px;background:${sel ? "#1a2a3a" : "#222"};`;
}

let _closeStyleDialog = null;
function closeStyleDialog() {
  try {
    _closeStyleDialog?.();
  } catch (_) {}
}

function fileToPreviewJpeg(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error("预览图过大"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const max = 512;
        let w = img.naturalWidth || img.width || 1;
        let h = img.naturalHeight || img.height || 1;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("预览图无法识别"));
    };
    img.src = url;
  });
}

function openStyleDialog(item, onDone) {
  closeStyleDialog();
  const editing = !!(item && item.name);
  const mask = document.createElement("div");
  mask.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;pointer-events:auto;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "width:360px;max-width:calc(100vw - 32px);background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:8px;padding:12px;box-sizing:border-box;font-size:12px;";
  const title = document.createElement("div");
  title.textContent = editing ? "编辑风格" : "添加风格";
  title.style.cssText = "font-weight:600;margin-bottom:8px;color:#cfd3dc;";
  panel.appendChild(title);

  const lab = (text) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "margin:8px 0 4px;color:#bbb;";
    return d;
  };
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "名字";
  nameInput.title = "名字";
  nameInput.value = editing ? item.name : "";
  nameInput.style.cssText =
    "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";
  const promptInput = document.createElement("textarea");
  promptInput.placeholder = "提示词";
  promptInput.title = "提示词";
  promptInput.value = editing ? item.prompt || "" : "";
  promptInput.style.cssText =
    "width:100%;box-sizing:border-box;height:96px;resize:vertical;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";

  const preview = document.createElement("div");
  preview.title = "预览图";
  preview.style.cssText =
    "height:96px;border:1px dashed #555;border-radius:6px;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;color:#888;font-size:28px;";
  preview.textContent = "+";
  let picked = null;
  let previewUrl = null;
  const showPreview = (src, isObject) => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview.textContent = "";
    if (!src) {
      preview.textContent = "+";
      return;
    }
    if (isObject) previewUrl = src;
    const img = document.createElement("img");
      img.draggable = false;
    img.src = src;
    img.alt = "预览图";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;";
    preview.appendChild(img);
  };
  if (editing && item.thumbnail) {
    let src = item.thumbnail;
    try {
      if (String(src).startsWith("/") && typeof api?.apiURL === "function") src = api.apiURL(src);
    } catch (_) {}
    showPreview(src);
  }
  const filePick = document.createElement("input");
  filePick.type = "file";
  filePick.accept = "image/*";
  filePick.style.display = "none";
  preview.onclick = () => filePick.click();
  filePick.onchange = () => {
    const file = filePick.files && filePick.files[0];
    filePick.value = "";   // 允许同对话框内再次选择同一文件
    if (!file) return;
    picked = file;
    showPreview(URL.createObjectURL(file), true);
  };

  const err = document.createElement("div");
  err.style.cssText = "min-height:16px;color:#f66;margin-top:6px;";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.title = "取消";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = "保存";
  okBtn.title = "保存";
  const btnCss =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:4px 12px;background:#333;color:#eee;";
  cancelBtn.style.cssText = btnCss;
  okBtn.style.cssText = btnCss;
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);

  panel.appendChild(lab("名字"));
  panel.appendChild(nameInput);
  panel.appendChild(lab("提示词"));
  panel.appendChild(promptInput);
  panel.appendChild(lab("预览图"));
  panel.appendChild(preview);
  panel.appendChild(filePick);
  panel.appendChild(err);
  panel.appendChild(actions);
  mask.appendChild(panel);

  const stop = (e) => e.stopPropagation();
  mask.addEventListener("pointerdown", stop);
  mask.addEventListener("wheel", stop, { passive: true });
  panel.addEventListener("pointerdown", stop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    try {
      mask.remove();
    } catch (_) {}
    if (_closeStyleDialog === close) _closeStyleDialog = null;
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  cancelBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  okBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    err.textContent = "";
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name) {
      err.textContent = "请填写名字";
      return;
    }
    okBtn.disabled = true;
    try {
      let image_b64 = "";
      if (picked) image_b64 = await fileToPreviewJpeg(picked);
      await onDone?.({
        action: "save",
        name,
        prompt,
        old_name: editing ? item.name : "",
        image_b64,
      });
      close();
    } catch (ex) {
      err.textContent = ex?.message || "保存失败";
      okBtn.disabled = false;
    }
  };
  _closeStyleDialog = close;
  document.body.appendChild(mask);
  try {
    nameInput.focus();
  } catch (_) {}
}

app.registerExtension({
  name: "Ares.Qwen.PromptEnhance",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // 延后一帧，确保 widget 已建好
      requestAnimationFrame(() => {
        try {
          setupWorkbench(this);
        } catch (e) {
          console.error("[AresQwenPE] 初始化失败:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          if (!this._aresWorkbench) setupWorkbench(this);
          else this._aresWorkbench.refresh?.();
        } catch (e) {
          console.error("[AresQwenPE] configure:", e);
        }
      });
      return r;
    };
  },
});

function setupWorkbench(node) {
  if (node._aresWorkbench) return;
  let hoverBox = null;          // 悬浮大图（挂在 body 上，节点删除时一并移除）
  const prevRemoved = node.onRemoved;
  let activeMaskSession = null; // 原生遮罩编辑会话，节点删除时强制收尾
  node.onRemoved = function () {
    closeStyleDialog();
    closeCanvasEditor();   // 画布编辑器是独立浮层，节点删除时一并收尾
    try {
      activeMaskSession?.finish(false);
    } catch (_) {}
    activeMaskSession = null;
    try {
      hoverBox?.remove();
    } catch (_) {}
    hoverBox = null;
    if (prevRemoved) return prevRemoved.apply(this, arguments);
  };

  const wLib = findW(node, "风格库");
  const wStyle = findW(node, "风格");
  const wMedia = findW(node, "图片数据");
  const wText = findW(node, "提示词文本");
  const textWidgetOk = () => Boolean(wText && node.widgets?.includes(wText));
  const wStart = findW(node, "起始索引");
  const wRows = findW(node, "最大行数");
  const wEmpty = findW(node, "去除空行");
  hideWidget(wMedia);
  hideWidget(wStyle);
  hideWidget(wText);
  hideWidget(wStart);
  hideWidget(wRows);
  hideWidget(wEmpty);
  // 采样参数（官方默认值）、cfg（推荐值）、max_length —— 全部隐藏，数值仍随工作流保存
  hideWidget(findW(node, "do_sample"));
  hideWidget(findW(node, "temperature"));
  hideWidget(findW(node, "top_p"));
  hideWidget(findW(node, "top_k"));
  hideWidget(findW(node, "cfg_t2i"));
  hideWidget(findW(node, "cfg_i2i"));
  hideWidget(findW(node, "max_length"));

  // 高度随节点实例保存在工作流里，不再用全局 localStorage
  const heights = Object.assign(
    { style: 210, img: 240, prompt: 220 },
    node.properties?.[H_KEY] || {}
  );
  const saveHeights = () => {
    try {
      node.properties[H_KEY] = { ...heights };
    } catch (_) {}
  };

  let domWidget = null;
  let advBar = null;   // 参数折叠条（顶部），高度动态计入
  const contentHeight = () =>
    Number(heights.style || 210) +
    Number(heights.img || 240) +
    Number(heights.prompt || 220) +
    (advBar ? advBar.offsetHeight : 0) +
    36;
  const contentWidth = () => Math.max(Number(node.size?.[0]) || 0, 420);
  const refreshDomSize = () => {
    const total = contentHeight();
    if (domWidget) {
      domWidget.computeSize = () => [contentWidth(), Math.max(320, total)];
    }
    configureFullWidthDomWidget(root);
    try {
      const w = Math.max(Number(node.size?.[0]) || 420, 420);
      const h = total + 90;
      if (!node.size || node.size[1] !== h) node.setSize([w, h]);
      node.setDirtyCanvas?.(true, true);
    } catch (_) {}
  };

  const root = document.createElement("div");
  root.style.cssText =
    "width:100%;max-width:100%;min-width:0;height:auto;max-height:100%;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;pointer-events:auto;color:#ddd;font-size:12px;";
  configureFullWidthDomWidget(root);

  // —— ① 风格 ——
  const styleBox = document.createElement("div");
  styleBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const styleHead = document.createElement("div");
  styleHead.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-shrink:0;";
  const styleTitle = document.createElement("span");
  styleTitle.style.cssText = "font-weight:600;color:#cfd3dc;";
  styleTitle.textContent = "① 风格";
  const styleHint = document.createElement("span");
  styleHint.style.cssText =
    "flex:1;color:#7a8694;font-size:11px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 8px;";
  styleHint.textContent = "点卡片套用 · 悬浮右上角可编辑/删除 · 自定义库内 + 新建";
  styleHint.title =
    "点击卡片选中风格，再点或点「清除」取消；悬浮卡片右上角可编辑/删除；切到「自定义」库可用「+」新建自定义风格；下拉可切换风格库。「无」=不套风格。";
  const clearStyleBtn = document.createElement("button");
  clearStyleBtn.type = "button";
  clearStyleBtn.textContent = "清除";
  clearStyleBtn.title = "取消风格";
  clearStyleBtn.style.cssText =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:2px 8px;background:#333;color:#ccc;font-size:11px;";
  const styleSearch = document.createElement("input");
  styleSearch.type = "text";
  styleSearch.placeholder = "搜索风格";
  styleSearch.style.cssText =
    "width:110px;flex-shrink:0;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 6px;font-size:11px;";
  let searchTimer = null;
  let searchSeq = 0;   // 自增序号：过期搜索响应直接丢弃
  styleSearch.addEventListener("input", () => {
    stylePage = 1;
    clearTimeout(searchTimer);
    searchSeq += 1;
    const kw = styleSearch.value.trim();
    if (!kw) {
      renderStyleCards(styleItemsCache);
      return;
    }
    searchTimer = setTimeout(() => globalSearch(kw), 300);
  });
  styleHead.appendChild(styleTitle);
  styleHead.appendChild(styleHint);
  styleHead.appendChild(styleSearch);
  styleHead.appendChild(clearStyleBtn);
  const subTabs = document.createElement("div");
  subTabs.style.cssText =
    "display:none;flex-wrap:wrap;gap:5px;margin-bottom:6px;flex-shrink:0;";
  styleBox.appendChild(styleHead);
  styleBox.appendChild(subTabs);
  const styleScroll = document.createElement("div");
  styleScroll.style.cssText = "flex:1;width:100%;max-width:100%;min-width:0;overflow:auto;min-height:0;";
  const styleGrid = document.createElement("div");
  styleGrid.style.cssText =
    "width:100%;min-width:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;";
  styleScroll.appendChild(styleGrid);
  styleBox.appendChild(styleScroll);

  const applyStyleH = (h) => {
    heights.style = h;
    styleBox.style.height = h + "px";
    refreshDomSize();
  };

  let styleItemsCache = [];
  let userStylesCache = [];
  let stylePage = 1;
  let activeGroup = "";
  const STYLE_PAGE_SIZE = 120;
  // 收藏：[{lib, name, t}]，lib=中文库名（自定义风格为「自定义」），t=收藏时间戳。
  // 存 ComfyUI 根目录 ares_style_favorites.json（经 /ares_qwen/style_favorites 读写），
  // 跟随 ComfyUI 而非浏览器。「★ 收藏」伪分组用 FAV_GROUP 标记 activeGroup。
  let styleFavs = [];
  const FAV_GROUP = "__fav__";

  function isStyleFav(lib, name) {
    return styleFavs.some((f) => f.lib === lib && f.name === name);
  }
  async function loadStyleFavs() {
    try {
      const res = await api.fetchApi(`/ares_qwen/style_favorites?t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data?.ok) {
        styleFavs = (Array.isArray(data.items) ? data.items : [])
          .filter((f) => f && f.lib && f.name)
          .sort((a, b) => (b.t || 0) - (a.t || 0));
      }
    } catch (e) {
      console.warn("[AresQwenPE] 风格收藏读取失败:", e);
    }
  }
  async function saveStyleFavs() {
    try {
      const res = await api.fetchApi("/ares_qwen/style_favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: styleFavs }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.warn("[AresQwenPE] 风格收藏保存失败:", e);
    }
  }
  async function toggleStyleFav(lib, name) {
    const at = styleFavs.findIndex((f) => f.lib === lib && f.name === name);
    if (at >= 0) styleFavs.splice(at, 1);
    else styleFavs.unshift({ lib, name, t: Date.now() });
    saveStyleFavs();
  }
  /** 缩略图左上角的收藏星：未收藏悬浮卡片时浮现，已收藏常显金星 */
  function attachFavStar(thumbWrap, lib, name, card) {
    thumbWrap.style.position = "relative";
    const star = document.createElement("button");
    star.type = "button";
    star.title = "收藏 / 取消收藏";
    const paint = () => {
      const on = isStyleFav(lib, name);
      star.textContent = on ? "★" : "☆";
      star.style.color = on ? "#ffd15c" : "#ddd";
      star.style.opacity = on ? "1" : "0";
    };
    star.style.cssText =
      "position:absolute;top:3px;left:3px;z-index:2;cursor:pointer;border:none;border-radius:3px;" +
      "padding:1px 4px;background:rgba(0,0,0,.55);font-size:11px;line-height:1.4;transition:opacity .12s;";
    const show = (on) => {
      if (isStyleFav(lib, name)) return;   // 已收藏常显，不跟随悬浮
      star.style.opacity = on ? "1" : "0";
      star.style.pointerEvents = on ? "auto" : "none";
    };
    paint();
    star.style.pointerEvents = isStyleFav(lib, name) ? "auto" : "none";
    if (card) {
      card.addEventListener("pointerenter", () => show(true));
      card.addEventListener("pointerleave", () => show(false));
    }
    const halt = (e) => { e.preventDefault(); e.stopPropagation(); };
    star.addEventListener("pointerdown", halt);
    star.onclick = (e) => {
      halt(e);
      toggleStyleFav(lib, name).then(() => {
        paint();
        if (activeGroup === FAV_GROUP) renderStyleCards(styleItemsCache);
      });
    };
    thumbWrap.appendChild(star);
  }
  // 全部库 + 自定义风格的名字集合（reloadStyles 时刷新）。
  // 「模板不存在」警告必须查全库：只查当前浏览的库会把"选中的模板在别的库"误报成丢失。
  let knownStyleNames = null;

  function makeThumb(name, label, thumbUrl) {
    const thumb = document.createElement("div");
    thumb.style.cssText =
      "height:70px;border-radius:4px;overflow:hidden;background:#111;display:flex;align-items:center;justify-content:center;";
    if (thumbUrl) {
      const img = document.createElement("img");
      img.draggable = false;
      let src = thumbUrl;
      try {
        if (String(thumbUrl).startsWith("/") && typeof api?.apiURL === "function") {
          src = api.apiURL(thumbUrl);
        }
      } catch (_) {}
      img.src = src;
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = label;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      img.onerror = () => {
        thumb.textContent = "无样图";
        thumb.style.color = "#666";
        thumb.style.fontSize = "10px";
        try {
          img.remove();
        } catch (_) {}
      };
      thumb.appendChild(img);
    } else {
      thumb.textContent = (name === "none" || name === "无") ? "不套风格" : "无样图";
      thumb.style.color = "#888";
      thumb.style.fontSize = "11px";
    }
    return thumb;
  }

  async function postUserStyle(payload) {
    allStylesCache = null;   // 风格增删改后，全局搜索的聚合缓存同步失效
    const res = await api.fetchApi("/ares_qwen/user_styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || "操作失败");
    }
    return data;
  }

  function renderStyleCards(items, opts = {}) {
    const { suppressMissingWarn = false } = opts;
    const cur = wStyle?.value || "none";
    const isCustomLib = (wLib?.value || "none") === "自定义";
    const kw = (styleSearch?.value || "").trim().toLowerCase();
    styleGrid.innerHTML = "";
    // 选中值指向不存在的模板（被重命名/删除）时给出警告，避免静默不套用
    // suppressMissingWarn：用户主动切库后，原选中的模板可能不在新库里——这是预期行为，不打扰
    const selExists =
      cur === "none" ||
      (items || []).some((it) => it.name === cur) ||
      (userStylesCache || []).some((s) => s.name === cur || `user:${s.name}` === cur) ||
      (knownStyleNames && knownStyleNames.has(cur));
    // knownStyleNames 还没建好（首次加载失败等）时信息不全，不警告以免误报
    if (!selExists && !suppressMissingWarn && knownStyleNames) {
      const warn = document.createElement("div");
      warn.style.cssText = "grid-column:1/-1;color:#f66;font-size:11px;margin-bottom:4px;";
      warn.textContent = "⚠ 当前选中的模板已不存在（可能被重命名或删除），请重新点选卡片";
      styleGrid.appendChild(warn);
    }
    // 子分类标签：库里存在多个 group 或有收藏时才显示
    const groupCount = {};
    (items || []).forEach((it) => {
      const gp = it.group || "";
      groupCount[gp] = (groupCount[gp] || 0) + 1;
    });
    const gps = Object.keys(groupCount).filter((gp) => gp);
    const showFavTab = styleFavs.length > 0;
    if (activeGroup === FAV_GROUP && !showFavTab) activeGroup = "";
    subTabs.style.display = gps.length > 1 || showFavTab ? "flex" : "none";
    if (!gps.includes(activeGroup) && activeGroup !== FAV_GROUP) activeGroup = "";
    if (gps.length > 1 || showFavTab) {
      subTabs.innerHTML = "";
      const mkTab = (gp, label, count) => {
        const t = document.createElement("button");
        t.type = "button";
        t.textContent = `${label} (${count})`;
        t.style.cssText =
          "cursor:pointer;white-space:nowrap;border:1px solid " +
          (activeGroup === gp ? "#6af" : "#555") + ";border-radius:12px;padding:3px 10px;" +
          "background:" + (activeGroup === gp ? "#1a2a3a" : "#222") + ";color:" +
          (activeGroup === gp ? "#fff" : "#bbb") + ";font-size:11px;";
        t.onclick = () => {
          activeGroup = gp;
          stylePage = 1;
          clearTimeout(searchTimer);
          searchSeq += 1;
          if (styleSearch) styleSearch.value = "";
          renderStyleCards(items);
        };
        subTabs.appendChild(t);
      };
      if (showFavTab) mkTab(FAV_GROUP, "★ 收藏", styleFavs.length);
      mkTab("", "全部", (items || []).length);
      gps.sort((a, b) => groupCount[b] - groupCount[a]).forEach((gp) => mkTab(gp, gp, groupCount[gp]));
    }
    if (activeGroup === FAV_GROUP) {
      renderFavCards();
      return;
    }
    const useGroup = activeGroup && !kw;
    const list = (items || [])
      .filter((it) => (!kw || (it.name || "").toLowerCase().includes(kw) ||
        (it.name_cn || "").toLowerCase().includes(kw)) &&
        (!useGroup || (it.group || "") === activeGroup));
    const addCard = (name, label, thumbUrl, selected) => {
      const card = document.createElement("div");
      card.style.cssText = cardCss(selected);
      card.title = label;
      const lab = document.createElement("div");
      lab.style.cssText =
        "margin-top:4px;font-size:10px;text-align:center;color:#ccc;max-height:2.4em;overflow:hidden;line-height:1.2;";
      lab.textContent = label;
      const tw = makeThumb(name, label, thumbUrl);
      card.appendChild(tw);
      card.appendChild(lab);
      if (name !== "none") {
        const libLabel = (wLib?.value || "none") === "none" ? "自定义" : (wLib?.value || "");
        attachFavStar(tw, libLabel, name, card);
      }
      card.onclick = () => {
        setVal(wStyle, name);
        renderStyleCards(styleItemsCache);
      };
      styleGrid.appendChild(card);
    };
    if (!isCustomLib) addCard("none", "none", NONE_THUMB, cur === "none");
    list.slice(0, stylePage * STYLE_PAGE_SIZE).forEach((it) => {
      addCard(it.name, it.name_cn || it.name, it.thumbnail || "",
        cur === it.name || (isCustomLib && it.name === "无" && cur === "none"));
    });
    if (list.length > stylePage * STYLE_PAGE_SIZE) {
      const more = document.createElement("div");
      more.style.cssText =
        "cursor:pointer;border:2px dashed #555;border-radius:6px;background:#1a1a1a;" +
        "min-height:96px;display:flex;align-items:center;justify-content:center;" +
        "color:#9ab;font-size:12px;grid-column:1/-1;";
      more.textContent = "显示更多（剩余 " + (list.length - stylePage * STYLE_PAGE_SIZE) + "）";
      more.onclick = () => {
        stylePage += 1;
        renderStyleCards(items);
      };
      styleGrid.appendChild(more);
    }
    const sameCustom = (name) => cur === name || cur === `user:${name}`;
    if (isCustomLib) (userStylesCache || []).forEach((it) => {
      const card = document.createElement("div");
      const selected = sameCustom(it.name);
      card.style.cssText = cardCss(selected);
      card.title = it.name;
      const thumbWrap = makeThumb(it.name, it.name, it.thumbnail || "");
      thumbWrap.style.position = "relative";
      // 编辑/删除悬浮在缩略图右上角，不占独立一行、不挤压图片
      // 平时隐藏，悬浮卡片才浮现，避免误触
      const ops = document.createElement("div");
      ops.style.cssText =
        "position:absolute;top:3px;right:3px;display:flex;gap:3px;z-index:2;" +
        "opacity:0;pointer-events:none;transition:opacity .12s;";
      const showOps = (on) => {
        ops.style.opacity = on ? "1" : "0";
        ops.style.pointerEvents = on ? "auto" : "none";
      };
      card.addEventListener("pointerenter", () => showOps(true));
      card.addEventListener("pointerleave", () => showOps(false));
      const mk = (glyph, label, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = glyph;
        b.title = label;
        b.style.cssText =
          "cursor:pointer;border:none;border-radius:3px;padding:1px 4px;" +
          "background:rgba(0,0,0,.55);color:#ddd;font-size:11px;line-height:1.4;";
        b.addEventListener("pointerenter", () => {
          b.style.background = "rgba(30,90,150,.9)";
        });
        b.addEventListener("pointerleave", () => {
          b.style.background = "rgba(0,0,0,.55)";
        });
        const halt = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        b.addEventListener("pointerdown", halt);
        b.onclick = (e) => {
          halt(e);
          fn();
        };
        return b;
      };
      ops.appendChild(
        mk("✎", "编辑", () => {
          openStyleDialog(it, async (payload) => {
            try {
              const data = await postUserStyle(payload);
              const saved = data?.item?.name || payload.name;
              if (sameCustom(it.name)) setVal(wStyle, `user:${saved}`);
            } finally {
              await reloadStyles();
            }
          });
        })
      );
      ops.appendChild(
        mk("✕", "删除", async () => {
          if (!window.confirm("删除这个风格？")) return;
          try {
            await postUserStyle({ action: "delete", name: it.name });
            if (sameCustom(it.name)) setVal(wStyle, "none");
            await reloadStyles();
          } catch (ex) {
            window.alert(ex?.message || "删除失败");
          }
        })
      );
      thumbWrap.appendChild(ops);
      attachFavStar(thumbWrap, "自定义", it.name, card);
      const lab = document.createElement("div");
      lab.style.cssText =
        "margin-top:4px;font-size:10px;text-align:center;color:#ccc;max-height:2.4em;overflow:hidden;line-height:1.2;";
      lab.textContent = it.name;
      card.appendChild(thumbWrap);
      card.appendChild(lab);
      card.onclick = () => {
        setVal(wStyle, `user:${it.name}`);
        renderStyleCards(styleItemsCache);
      };
      styleGrid.appendChild(card);
    });
    if (!isCustomLib) return;   // 预设库不显示「+」：新建的自定义风格只在自定义库里可见
    const plus = document.createElement("div");
    plus.title = "添加风格";
    plus.textContent = "+";
    plus.style.cssText =
      "cursor:pointer;border:2px dashed #555;border-radius:6px;background:#222;min-height:96px;display:flex;align-items:center;justify-content:center;color:#9ab;font-size:28px;";
    plus.addEventListener("pointerdown", (e) => e.stopPropagation());
    plus.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStyleDialog(null, async (payload) => {
        try {
          const data = await postUserStyle(payload);
          setVal(wStyle, `user:${data?.item?.name || payload.name}`);
        } finally {
          await reloadStyles();
        }
      });
    };
    styleGrid.appendChild(plus);
  }

  /** 「★ 收藏」跨库视图：按收藏时间倒序，条目数据取自全库聚合缓存 */
  function renderFavCards() {
    const kw = (styleSearch?.value || "").trim().toLowerCase();
    styleGrid.innerHTML = "";
    const cur = wStyle?.value || "none";
    const build = (all) => {
      const byKey = new Map();
      for (const it of all) byKey.set(`${it.lib}\n${it.name}`, it);
      const list = styleFavs
        .map((f) => byKey.get(`${f.lib}\n${f.name}`))
        .filter(Boolean)
        .filter((it) => !kw || (it.name || "").toLowerCase().includes(kw) ||
          (it.name_cn || "").toLowerCase().includes(kw));
      const missing = styleFavs.filter((f) => !byKey.has(`${f.lib}\n${f.name}`)).length;
      if (missing) {
        const tip = document.createElement("div");
        tip.style.cssText = "grid-column:1/-1;color:#889;font-size:10px;margin-bottom:2px;";
        tip.textContent = `（${missing} 条收藏的风格已不在库中，已隐藏）`;
        styleGrid.appendChild(tip);
      }
      if (!list.length) {
        const none = document.createElement("div");
        none.style.cssText = "color:#888;font-size:12px;grid-column:1/-1;padding:20px 0;text-align:center;";
        none.textContent = kw ? "收藏里没有匹配的风格" : "还没有收藏的风格：悬浮卡片点左上角 ☆";
        styleGrid.appendChild(none);
        return;
      }
      list.slice(0, stylePage * STYLE_PAGE_SIZE).forEach((it) => {
        const val = it.user ? `user:${it.name}` : it.name;
        const card = document.createElement("div");
        card.style.cssText = cardCss(cur === val);
        card.title = `${it.lib || ""} · ${it.name}`;
        const tw = makeThumb(it.name, it.name_cn || it.name, it.thumbnail || "");
        attachFavStar(tw, it.lib, it.name, card);
        card.appendChild(tw);
        const lab = document.createElement("div");
        lab.style.cssText = "margin-top:4px;font-size:10px;text-align:center;color:#ccc;line-height:1.25;overflow:hidden;";
        lab.innerHTML = `${escapeHtml(it.name_cn || it.name)}<div style="color:#788;font-size:9px;">${escapeHtml(it.lib || "")}</div>`;
        card.appendChild(lab);
        card.onclick = () => {
          setVal(wStyle, val);
          const curLib = (wLib?.value || "none") === "none" ? "自定义" : (wLib?.value || "");
          if (curLib !== it.lib) setVal(wLib, it.lib);   // callback → reloadStyles 渲染新库
          else renderStyleCards(styleItemsCache);
        };
        styleGrid.appendChild(card);
      });
      if (list.length > stylePage * STYLE_PAGE_SIZE) {
        const more = document.createElement("div");
        more.style.cssText =
          "cursor:pointer;border:2px dashed #555;border-radius:6px;background:#1a1a1a;" +
          "min-height:96px;display:flex;align-items:center;justify-content:center;" +
          "color:#9ab;font-size:12px;grid-column:1/-1;";
        more.textContent = "显示更多（剩余 " + (list.length - stylePage * STYLE_PAGE_SIZE) + "）";
        more.onclick = () => {
          stylePage += 1;
          renderStyleCards(styleItemsCache);
        };
        styleGrid.appendChild(more);
      }
    };
    if (allStylesCache) {
      build(allStylesCache);
    } else {
      const loading = document.createElement("div");
      loading.style.cssText = "color:#888;font-size:12px;grid-column:1/-1;padding:20px 0;text-align:center;";
      loading.textContent = "加载收藏…";
      styleGrid.appendChild(loading);
      fetchAllStyles().then(() => {
        if (activeGroup === FAV_GROUP) renderStyleCards(styleItemsCache);
      });
    }
  }

  let libPairs = [];

  async function loadLibPairs() {
    try {
      const res = await api.fetchApi("/ares_qwen/style_libs");
      const data = await res.json();
      libPairs = Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
      console.warn("[AresQwenPE] 库名表读取失败:", e);
      libPairs = [];
    }
  }

  /** 旧工作流存的是原始文件名（krea2_xxx），这里换成中文显示名。 */
  function migrateLibValue() {
    if (!wLib || !libPairs.length) return;
    const cur = String(wLib.value || "");
    const hit = libPairs.find((p) => p.value === cur);
    if (hit && hit.label !== cur) setVal(wLib, hit.label);
  }

  async function fetchUserStyles() {
    try {
      const res = await api.fetchApi(`/ares_qwen/user_style_list?t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "读取失败");
      }
      userStylesCache = Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
      console.warn("[AresQwenPE] 自定义风格读取失败（保留上次列表）:", e);
    }
  }

  let allStylesCache = null;
  /** 统一构造搜索条目：可搜索字段一次性算好，库风格与用户风格共用。 */
  function mkStyleEntry(lib, it, isUser) {
    const name = it.name || "";
    const name_cn = it.name_cn || name;
    const txt = `${name} ${name_cn} ${it.prompt || ""} ${it.group || ""} ${lib}`.toLowerCase();
    return {
      lib, name, name_cn,
      prompt: it.prompt || "", thumbnail: it.thumbnail || "",
      group: it.group || "",
      user: !!isUser,
      _txt: txt,
      _words: new Set(txt.match(/[a-z0-9]{3,}/g) || []),
      _chars: new Set(txt.match(/[一-鿿]/g) || []),
    };
  }

  async function fetchAllStyles() {
    if (allStylesCache) return allStylesCache;
    let libs = [];
    let libsOk = false;
    try {
      const res = await api.fetchApi("/ares_qwen/style_libs");
      const data = await res.json();
      libs = (data?.items || []).map((x) => x.label);
      libsOk = true;
    } catch (_) {}
    const lists = await Promise.all(libs.map((label) =>
      api.fetchApi(`/ares_qwen/styles?name=${encodeURIComponent(label)}`)
        .then((r) => r.json())
        .then((d) => ({ lib: label, items: d?.items || [] }))
        .catch(() => ({ lib: label, items: [] }))
    ));
    const aggregated = [];
    for (const { lib, items } of lists) {
      for (const it of items) aggregated.push(mkStyleEntry(lib, it, false));
    }
    try {
      const res = await api.fetchApi("/ares_qwen/user_style_list");
      const data = await res.json();
      for (const u of data?.items || []) {
        aggregated.push(mkStyleEntry("自定义", { ...u, name_cn: u.name }, true));
      }
    } catch (_) {}
    // 库名表读取失败时不缓存，下次搜索自动重试
    if (libsOk) allStylesCache = aggregated;
    return aggregated;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function renderGlobalSearch(items, kw) {
    subTabs.style.display = "none";
    styleGrid.innerHTML = "";
    const cur = wStyle?.value || "none";
    const head = document.createElement("div");
    head.style.cssText = "color:#9ab;font-size:11px;grid-column:1/-1;margin-bottom:2px;";
    if (!items) {
      head.textContent = "搜索中…";
      styleGrid.appendChild(head);
      return;
    }
    const totalTag = globalSearch.total ? `（共 ${globalSearch.total}，显示前 ${items.length}）` : "";
    const fz = globalSearch.fuzzy ? " · 含模糊匹配" : "";
    head.textContent = kw ? `全局搜索「${kw}」：${items.length} 个匹配${totalTag}${fz}` : "";
    styleGrid.appendChild(head);
    if (items) {
      for (const it of items) {
        const val = it.user ? `user:${it.name}` : it.name;
        const card = document.createElement("div");
        card.style.cssText = cardCss(cur === val);
        card.title = `${it.lib || ""} · ${it.name}`;
        const tw = makeThumb(it.name, it.name, it.thumbnail || "");
        attachFavStar(tw, it.lib, it.name, card);
        card.appendChild(tw);
        const lab = document.createElement("div");
        lab.style.cssText = "margin-top:4px;font-size:10px;text-align:center;color:#ccc;line-height:1.25;overflow:hidden;";
        lab.innerHTML = `${escapeHtml(it.name_cn || it.name)}<div style="color:#788;font-size:9px;">${escapeHtml(it.lib || "")}</div>`;
        card.appendChild(lab);
        card.onclick = () => {
          setVal(wStyle, val);
          renderGlobalSearch(items, kw);
        };
        styleGrid.appendChild(card);
      }
      if (!items.length) {
        const none = document.createElement("div");
        none.style.cssText = "color:#888;font-size:12px;grid-column:1/-1;padding:20px 0;text-align:center;";
        none.textContent = "没有匹配的风格";
        styleGrid.appendChild(none);
      }
    }
  }

  function lev(a, b) {   // Damerau-Levenshtein：含相邻换位，打字错误容错
    if (Math.abs(a.length - b.length) > 2) return 3;
    const m = a.length, n = b.length;
    const d = [];
    for (let i = 0; i <= m; i++) d.push([i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, d[i - 2][j - 2] + 1);
        }
        d[i][j] = v;
      }
    }
    return d[m][n];
  }

  function matchEntry(it, tokens, q) {
    if (!it._txt) return 0;                            // 缺字段的条目跳过而非崩溃
    if (it._txt.includes(q)) return 3;                 // 整句精确
    if (!tokens.length) return 0;
    let allSub = true, allOk = true, anyFuzzy = false;
    for (const t of tokens) {
      if (it._txt.includes(t)) continue;               // 该词精确命中
      allSub = false;
      let ok = false;
      if (/^[一-鿿]{2,4}$/.test(t)) {          // 中文：逐字包含
        ok = [...t].every((ch) => it._chars.has(ch));
      } else if (t.length >= 3 && /^[a-z0-9]+$/.test(t)) {  // 英文：编辑距离容错
        const max = t.length >= 6 ? 2 : 1;
        for (const w of it._words) {
          if (Math.abs(w.length - t.length) <= max && lev(t, w) <= max) { ok = true; break; }
        }
      }
      if (ok) anyFuzzy = true; else allOk = false;
    }
    if (allSub) return 2;                              // 多词 AND
    if (allOk && anyFuzzy) return 1;                   // 模糊
    return 0;
  }

  async function globalSearch(kw) {
    const seq = ++searchSeq;
    try {
      renderGlobalSearch(null, kw);
      const all = await fetchAllStyles();
      if (seq !== searchSeq) return;   // 输入已变化，丢弃过期结果
      const q = kw.toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      const hits = [];
      for (const it of all) {
        const sc = matchEntry(it, tokens, q);
        if (sc > 0) { it._score = sc; hits.push(it); }
      }
      hits.sort((a, b) => b._score - a._score);        // 精确在前、模糊在后
      globalSearch.total = hits.length;
      globalSearch.fuzzy = hits.some((it) => it._score === 1);
      if (seq !== searchSeq) return;
      renderGlobalSearch(hits.slice(0, 300), kw);
    } catch (e) {
      console.warn("[AresQwenPE] 全局搜索失败:", e);
    }
  }

  let reloadSeq = 0;
  async function reloadStyles(opts = {}) {
    if (styleSearch) styleSearch.value = "";
    activeGroup = "";
    stylePage = 1;
    const lib = !wLib?.value || wLib.value === "none" ? "自定义" : wLib.value;
    const seq = ++reloadSeq;
    const userTask = fetchUserStyles();
    try {
      const res = await api.fetchApi(
        `/ares_qwen/styles?name=${encodeURIComponent(lib)}`
      );
      const data = await res.json();
      if (seq !== reloadSeq) return;   // 库已切走，丢弃过期响应
      styleItemsCache = data?.items || [];
    } catch (e) {
      if (seq !== reloadSeq) return;
      console.warn("[AresQwenPE] 风格列表失败:", e);
      styleItemsCache = [];
    }
    await userTask;
    if (seq !== reloadSeq) return;
    // 全库名字集合：失败时（空列表）保留旧值，避免误报全部模板丢失
    const all = await fetchAllStyles();
    if (all.length) {
      knownStyleNames = new Set(all.map((it) => (it.user ? `user:${it.name}` : it.name)));
    }
    renderStyleCards(styleItemsCache, opts);
  }
  clearStyleBtn.onclick = (e) => {
    e.stopPropagation();
    setVal(wStyle, "none");
    clearTimeout(searchTimer);
    searchSeq += 1;
    if (styleSearch) styleSearch.value = "";   // 残留搜索词会滤空本地列表，必须一并清掉
    stylePage = 1;
    renderStyleCards(styleItemsCache);
  };
  if (wLib) {
    const prev = wLib.callback;
    wLib.callback = (v) => {
      try {
        prev?.(v);
      } catch (_) {}
      // 用户主动切库：原选中的模板可能不在新库里，静默接受
      reloadStyles({ suppressMissingWarn: true });
    };
  }

  // —— ② 参考图 ——
  const imgBox = document.createElement("div");
  imgBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const imgHead = document.createElement("div");
  imgHead.style.cssText =
    "display:flex;align-items:center;gap:8px;font-weight:600;color:#cfd3dc;margin-bottom:6px;flex-shrink:0;";
  const imgTitle = document.createElement("span");
  imgTitle.textContent = "② 参考图（最多6张）";
  const imgHint = document.createElement("span");
  imgHint.style.cssText =
    "flex:1;color:#7a8694;font-size:11px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      imgHint.textContent = "点击虚线区或拖入图片 · 图1用「遮罩」按钮涂改区 · 重绘范围在画布里画 · 悬浮✎打开画布编辑器";
      imgHint.title =
        "点击虚线区或拖入本地/资产图片，最多 6 张，按 <image1~6> 顺序引用；第 1 张图用「遮罩」按钮打开原生遮罩编辑器涂抹要修改的区域（红罩标注给模型），重绘范围工具在画布编辑器里框选裁剪重绘范围（可配缝合羽化）；悬浮 ✎ 打开画布；鼠标悬停缩略图可看大图。";
  imgHead.appendChild(imgTitle);
  imgHead.appendChild(imgHint);
  const dropZone = document.createElement("div");
  dropZone.style.cssText =
    "flex:1;min-height:100px;border:2px dashed #555;border-radius:8px;background:#141414;display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start;padding:10px;overflow:auto;position:relative;";
  const dropHint = document.createElement("div");
  dropHint.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#777;font-size:13px;pointer-events:none;text-align:center;padding:12px;";
  dropHint.textContent = "点击添加，或拖入本地/资产图片";
  dropZone.appendChild(dropHint);
  imgBox.appendChild(imgHead);
  imgBox.appendChild(dropZone);

  const applyImgH = (h) => {
    heights.img = h;
    imgBox.style.height = h + "px";
    refreshDomSize();
  };

  const fileImg = document.createElement("input");
  fileImg.type = "file";
  fileImg.accept = "image/*";
  fileImg.multiple = true;
  fileImg.style.display = "none";
  function getMedia() {
    const arr = parseJSON(wMedia?.value, []);
    return Array.isArray(arr) ? arr : [];
  }
  function setMedia(arr) {
    setVal(wMedia, JSON.stringify((arr || []).slice(0, MAX_IMAGES)));
    renderMedia();
  }
  function viewUrl(item) {
    const raw = String(item?.image || "").replace(/\\/g, "/");
    const type = item?.type || "input";
    const sub = item?.subfolder || "";
    let filename = raw.split("/").pop() || raw;
    let subfolder = sub;
    // image 里可能已带 subfolder/xxx.png
    if (!subfolder && raw.includes("/")) {
      const parts = raw.split("/").filter(Boolean);
      filename = parts.pop();
      subfolder = parts.join("/");
    }
    const q = new URLSearchParams({
      filename,
      type,
      subfolder,
    });
    try {
      return api.apiURL(`/view?${q.toString()}`);
    } catch (_) {
      return `/view?${q.toString()}`;
    }
  }

  function parseImageRef(item) {
    const raw = String(item?.image || "").replace(/\\/g, "/");
    const type = item?.type || "input";
    let filename = raw.split("/").pop() || raw;
    let subfolder = String(item?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!subfolder && raw.includes("/")) {
      const parts = raw.split("/").filter(Boolean);
      filename = parts.pop();
      subfolder = parts.join("/");
    }
    return { filename, subfolder, type };
  }

  function loadImageWidgetValue(item) {
    const { filename, subfolder, type } = parseImageRef(item);
    return `${subfolder ? subfolder + "/" : ""}${filename} [${type}]`;
  }

  function nodeImageSig(n) {
    const w = n?.widgets?.find((x) => x?.name === "image");
    if (w?.value) return String(w.value);
    if (n?.images?.[0]) return JSON.stringify(n.images[0]);
    return "";
  }

  function waitForNodeImgs(n, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (n?.imgs?.length) return resolve(n.imgs);
        if (Date.now() - t0 > ms) return reject(new Error("图片预览加载超时"));
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  function hideHoverPreview() {
    if (hoverBox) hoverBox.style.display = "none";
  }
  function placeHoverBox(rect) {
    if (!hoverBox || hoverBox.style.display === "none") return;
    const bw = hoverBox.offsetWidth;
    const bh = hoverBox.offsetHeight;
    let left = rect.right + 10;
    if (left + bw > window.innerWidth - 8) left = rect.left - bw - 10;
    if (left < 8) left = Math.max(8, (window.innerWidth - bw) / 2);
    let top = rect.top;
    if (top + bh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - bh - 8);
    hoverBox.style.left = left + "px";
    hoverBox.style.top = top + "px";
  }
  function showHoverPreview(src, rect) {
    // 棋盘格底：透明区一眼可辨（PS 式）
    const CHECKER =
      "background-color:#171a1f;background-image:linear-gradient(45deg,#2a2f36 25%,transparent 25%)," +
      "linear-gradient(-45deg,#2a2f36 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2f36 75%)," +
      "linear-gradient(-45deg,transparent 75%,#2a2f36 75%);background-size:16px 16px;" +
      "background-position:0 0,0 8px,8px -8px,-8px 0;";
    if (!hoverBox) {
      hoverBox = document.createElement("div");
      hoverBox.style.cssText =
        "position:fixed;z-index:9999;pointer-events:none;display:none;" +
        "border:1px solid #666;border-radius:8px;padding:4px;box-shadow:0 6px 24px rgba(0,0,0,.6);";
      document.body.appendChild(hoverBox);
    }
    let img = hoverBox.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.style.cssText = "display:block;max-width:420px;max-height:420px;border-radius:6px;" + CHECKER;
      hoverBox.appendChild(img);
    }
    if (img.getAttribute("src") !== src) {
      img.onload = () => placeHoverBox(rect);
      img.src = src;
    }
    hoverBox.style.display = "block";
    placeHoverBox(rect);
  }

  let dragSrcIdx = null;
  function renderMedia() {
    const arr = getMedia();
    dragSrcIdx = null;
    hideHoverPreview();
    dropZone.querySelectorAll("[data-card]").forEach((el) => el.remove());
    dropHint.style.display = arr.length ? "none" : "flex";
    arr.forEach((item, idx) => {
      const card = document.createElement("div");
      card.dataset.card = "1";
      card.style.cssText =
        "width:176px;border:1px solid #555;border-radius:8px;padding:6px;background:#222;flex-shrink:0;";
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        dragSrcIdx = idx;
        e.dataTransfer.setData("text/plain", String(idx));
        e.dataTransfer.effectAllowed = "move";
        card.style.opacity = "0.45";
        hideHoverPreview();
      });
      card.addEventListener("dragend", () => {
        card.style.opacity = "1";
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.style.borderColor = "#6af";
      });
      card.addEventListener("dragleave", () => {
        card.style.borderColor = "#555";
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.style.borderColor = "#555";
        if (dragSrcIdx == null || dragSrcIdx === idx) return;
        const arr2 = getMedia();
        if (!arr2[dragSrcIdx] || !arr2[idx]) return;
        const [moved] = arr2.splice(dragSrcIdx, 1);
        arr2.splice(idx, 0, moved);
        dragSrcIdx = null;
        // 画布文档必须与"第 1 张"这套内容绑定。重排后若第 1 张换了图，
        // doc 里的底图路径就与当前图不符 → 清掉，避免下次打开还原出别的图。
        const first = arr2[0];
        if (first && first._canvasDoc) {
          // doc.baseImage = 生成这份 doc 时的出图文件名。不能拿 doc 层 1 的
          // url 来比 —— 那是带 query 的 /view URL，basename 提取永远不等，
          // 拖一下卡片就会把 doc 误删。
          const docBase = String(first._canvasDoc.baseImage || "");
          const now = String(first.image || "").replace(/\\/g, "/").split("/").pop();
          if (docBase && now && docBase !== now) {
            delete first._canvasDoc;
            delete first._canvasW;
            delete first._canvasH;
            delete first.inpaintCrop;
          }
        }
        setMedia(arr2);
        // 任何带遮罩/重绘范围的卡片不在第 1 位都提示（含被其他卡挤走的情形）
        if (arr2.some((it, i) => (it.mask || it.inpaintCrop) && i !== 0)) {
          alert("提示：遮罩和重绘范围只对第 1 张参考图生效——带遮罩/重绘范围的卡片现在不在第 1 位，不会参与生成。");
        }
      });
      const previewWrap = document.createElement("div");
      previewWrap.style.cssText =
        "position:relative;width:100%;height:148px;border-radius:4px;overflow:hidden;cursor:zoom-in;" +
        "background-color:#171a1f;background-image:linear-gradient(45deg,#2a2f36 25%,transparent 25%)," +
        "linear-gradient(-45deg,#2a2f36 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2f36 75%)," +
        "linear-gradient(-45deg,transparent 75%,#2a2f36 75%);background-size:16px 16px;" +
        "background-position:0 0,0 8px,8px -8px,-8px 0;";
      const img = document.createElement("img");
      img.draggable = false;
      const name = String(item.image || "").replace(/\\/g, "/").split("/").pop();
      img.src = item.maskPreview || viewUrl(item);
      img.style.cssText =
        "width:100%;height:148px;object-fit:cover;display:block;";
      img.onerror = () => {
        if ((item.type || "input") === "input" && !item.maskPreview) {
          img.onerror = () => {
            img.style.opacity = "0.3";
          };
          img.src = viewUrl({ ...item, type: "output" });
        } else {
          img.style.opacity = "0.3";
        }
      };
      previewWrap.appendChild(img);
      // 悬浮图标组：✎画布编辑器（全部，从第 2 张起该图自动作为图层加入）、↩还原原图（编辑过）
      const hoverDefs = [
        {
          glyph: "✎",
          title: idx === 0
            ? "画布编辑器（画板尺寸 / 图层布局 / 视图缩放）"
            : "画布编辑器（独立编辑本图，结果写回本卡，不并入图1）",
          open: () => openWorkbenchCanvasEditor(item, idx),
        },
      ];
      if ((item.editHistory || []).length) hoverDefs.push({ glyph: "↩", title: "还原原图（撤销所有画布/裁切编辑）", open: () => restoreOriginal(idx) });
      hoverDefs.forEach((d, i) => {
        const b = document.createElement("div");
        b.textContent = d.glyph;
        b.title = d.title;
        b.style.cssText =
          "position:absolute;top:3px;right:" + (3 + i * 34) + "px;z-index:3;cursor:pointer;opacity:0;transition:opacity .12s;" +
          "background:rgba(0,0,0,.7);color:#fff;border-radius:4px;padding:3px 8px;font-size:13px;line-height:1.2;box-shadow:0 2px 6px rgba(0,0,0,.4);";
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.onclick = (e) => {
          e.stopPropagation();
          d.open();
        };
        previewWrap.appendChild(b);
        card.addEventListener("pointerenter", () => {
          b.style.opacity = "1";
        });
        card.addEventListener("pointerleave", () => {
          b.style.opacity = "0";
        });
      });
      previewWrap.addEventListener("mouseenter", () => {
        if (img.src) showHoverPreview(img.src, previewWrap.getBoundingClientRect());
      });
      previewWrap.addEventListener("mouseleave", hideHoverPreview);
      if ((item.mask || item.inpaintCrop) && !item.maskPreview) {
        // 异步合成标注预览：红罩（有遮罩时）+ 重绘范围绿框
        composeMaskPreview(item).then((url) => {
          if (url) {
            const arr = getMedia();
            // 合成期间卡片可能被删除/重排，条目对不上就丢弃
            if (arr[idx]?.image !== item.image) return;
            img.src = url;
            arr[idx].maskPreview = url;
            setVal(wMedia, JSON.stringify(arr));
          }
        });
      }
      if (item.mask) {
        const badge = document.createElement("div");
        badge.style.cssText =
          "position:absolute;left:4px;top:4px;background:rgba(0,120,255,.85);color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;";
        badge.textContent = "遮罩";
        previewWrap.appendChild(badge);
      }
      if (item.inpaintCrop) {
        const badge = document.createElement("div");
        badge.style.cssText =
          "position:absolute;left:4px;top:20px;background:rgba(0,160,80,.85);color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;";
        badge.textContent = "重绘范围";
        badge.title = `画布已框选局部重绘范围 ${item.inpaintCrop.w}×${item.inpaintCrop.h} @ ${item.inpaintCrop.x},${item.inpaintCrop.y}`;
        previewWrap.appendChild(badge);
      }
      const lab = document.createElement("div");
      lab.style.cssText =
        "font-size:10px;color:#aaa;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      lab.textContent = `<image${idx + 1}> ${name}`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;margin-top:4px;";
      const mkBtn = (t, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t;
        b.title = title;
        b.style.cssText =
          "flex:1;font-size:10px;cursor:pointer;border:1px solid #555;border-radius:3px;background:#333;color:#eee;padding:3px;";
        return b;
      };
      const maskBtn = mkBtn(item.mask ? "改遮罩" : "遮罩",
        idx === 0 ? "打开原生遮罩编辑器" : "遮罩只对第 1 张图生效");
      if (idx === 0) {
        maskBtn.onclick = (e) => {
          e.stopPropagation();
          openNativeMaskEditor(item, idx);
        };
      } else {
        maskBtn.disabled = true;
        maskBtn.style.opacity = "0.4";
        maskBtn.style.cursor = "not-allowed";
      }
      const clearMask = mkBtn("清罩", "清除遮罩");
      clearMask.onclick = (e) => {
        e.stopPropagation();
        const next = getMedia();
        if (!next[idx]) return;
        next[idx].mask = "";
        next[idx].maskType = "";
        next[idx].maskSubfolder = "";
        next[idx].maskPreview = "";
        setMedia(next);
      };
      const del = mkBtn("删除", "删除");
      del.onclick = (e) => {
        e.stopPropagation();
        const next = getMedia();
        next.splice(idx, 1);
        setMedia(next);
      };
      row.appendChild(maskBtn);
      if (item.mask) row.appendChild(clearMask);
      row.appendChild(del);
      card.appendChild(previewWrap);
      card.appendChild(lab);
      card.appendChild(row);
      dropZone.appendChild(card);
    });
  }

  /** 预览统一压到 512 以内再转 data URL，避免撑大工作流 JSON */
  function composeMaskPreview(item) {
    return new Promise((resolve) => {
      const base = new Image();
      base.crossOrigin = "anonymous";
      base.onload = () => {
        const scale = Math.min(1, 512 / Math.max(base.width || 1, base.height || 1));
        const w = Math.max(1, Math.round((base.width || 1) * scale));
        const h = Math.max(1, Math.round((base.height || 1) * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(base, 0, 0, w, h);
        const finish = () => {
          // 重绘范围绿框（仅预览）
          const rc = item.inpaintCrop;
          if (rc && rc.w > 0 && rc.h > 0) {
            ctx.strokeStyle = "#3dffa8";
            ctx.lineWidth = Math.max(1, Math.round(w / 180));
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(rc.x * scale, rc.y * scale, rc.w * scale, rc.h * scale);
          }
          resolve(c.toDataURL("image/jpeg", 0.8));
        };
        if (!item.mask) { finish(); return; }
        const mask = new Image();
        mask.crossOrigin = "anonymous";
        mask.onload = () => {
          const mc = document.createElement("canvas");
          mc.width = w;
          mc.height = h;
          const mctx = mc.getContext("2d");
          mctx.drawImage(mask, 0, 0, w, h);
          const md = mctx.getImageData(0, 0, w, h);
          const id = ctx.getImageData(0, 0, w, h);
          for (let i = 0; i < md.data.length; i += 4) {
            const v = md.data[i];
            if (v > 20) {
              // 缩略图半透明红罩（仅预览）
              id.data[i] = Math.min(255, Math.round(id.data[i] * 0.55 + 255 * 0.45));
              id.data[i + 1] = Math.round(id.data[i + 1] * 0.55);
              id.data[i + 2] = Math.round(id.data[i + 2] * 0.55);
            }
          }
          ctx.putImageData(id, 0, 0);
          finish();
        };
        mask.onerror = () => finish();
        mask.src = viewUrl({
          image: item.mask,
          type: item.maskType || "input",
          subfolder: item.maskSubfolder || "",
        });
      };
      base.onerror = () => resolve("");
      base.src = viewUrl(item);
    });
  }

  function removeTempNode(n) {
    try {
      if (n && app.graph) app.graph.remove(n);
    } catch (_) {}
  }

  /** 调用 Comfy 原生遮罩编辑器，保存后写回工作台 */
  async function openNativeMaskEditor(item, idx) {
    const CA = getComfyApp();
    try {
      if (typeof CA?.open_maskeditor !== "function" || typeof CA?.copyToClipspace !== "function") {
        alert("当前前端没有原生遮罩编辑器入口。");
        return;
      }
      if (typeof LiteGraph === "undefined" || !LiteGraph.createNode) {
        alert("无法创建临时节点（LiteGraph 不可用）。");
        return;
      }

      const temp = LiteGraph.createNode("LoadImage");
      if (!temp) {
        alert("无法创建 LoadImage 临时节点。");
        return;
      }
      temp.title = "Ares临时遮罩";
      temp.pos = [-12000, -12000];
      temp.size = [220, 80];
      temp.flags = temp.flags || {};
      temp.flags.collapsed = true;
      app.graph.add(temp);

      const imgW = temp.widgets?.find((w) => w?.name === "image");
      if (!imgW) {
        removeTempNode(temp);
        alert("临时节点缺少 image 控件。");
        return;
      }
      const widgetVal = loadImageWidgetValue(item);
      imgW.value = widgetVal;
      try {
        await imgW.callback?.(widgetVal, undefined, temp, undefined, undefined);
      } catch (_) {}
      // 强制塞预览图，保证原生编辑器能打开
      if (!temp.imgs?.length) {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.src = viewUrl(item);
        await new Promise((res, rej) => {
          im.onload = () => res();
          im.onerror = () => rej(new Error("原图加载失败"));
        });
        temp.imgs = [im];
        temp.images = [parseImageRef(item)];
      } else {
        await waitForNodeImgs(temp).catch(() => {});
      }

      const initialSig = nodeImageSig(temp);
      const prevReturn = CA.clipspace_return_node;
      const prevClipspace = CA.clipspace;
      CA.copyToClipspace(temp);
      const tempClipspace = CA.clipspace;
      CA.clipspace_return_node = temp;

      let watcher = null;
      let done = false;
      const finish = async (saved) => {
        if (done) return;
        done = true;
        if (watcher) clearInterval(watcher);
        activeMaskSession = null;
        try {
          if (saved) await syncNativeMaskToWorkbench(temp, idx, item);
        } catch (err) {
          console.warn("[AresQwenPE] 同步原生遮罩失败", err);
          alert("同步原生遮罩失败：" + (err?.message || err));
        } finally {
          if (CA.clipspace_return_node === temp) {
            CA.clipspace_return_node = prevReturn ?? null;
          }
          if (tempClipspace && CA.clipspace === tempClipspace) {
            CA.clipspace = prevClipspace ?? null;
          }
          removeTempNode(temp);
          app.graph?.setDirtyCanvas?.(true, true);
        }
      };
      activeMaskSession = { finish };

      // 原生编辑器保存/关闭（含取消）都会回调 return_node 上的钩子，
      // 两条路径都立即收尾；不依赖下面的兜底看门狗
      const sigChanged = () => {
        const s = nodeImageSig(temp);
        return !!s && s !== initialSig;
      };
      temp.onClipspaceEditorSave = () => finish(true);
      temp.onClipspaceEditorClosed = () => finish(sigChanged());

      // 兜底：钩子不可用的前端版本里，节点被外部移除或超时（24 分钟）才清理
      let attempts = 0;
      watcher = setInterval(() => {
        attempts += 1;
        if (sigChanged()) {
          finish(true);
          return;
        }
        const stillThere =
          !!temp.graph ||
          (Array.isArray(app.graph?._nodes) && app.graph._nodes.includes(temp));
        if (attempts > 3600 || !stillThere) {
          finish(false);
        }
      }, 400);

      CA.open_maskeditor();
    } catch (err) {
      console.warn("[AresQwenPE] 打开原生遮罩失败", err);
      alert("打开原生遮罩失败：" + (err?.message || err));
    }
  }

  async function syncNativeMaskToWorkbench(tempNode, idx, origItem) {
    // 原生保存 painted-masked：遮罩在 alpha（刷过=低 alpha）
    let ref = tempNode.images?.[0];
    if (!ref) {
      const w = tempNode.widgets?.find((x) => x?.name === "image");
      const v = String(w?.value || "");
      const m = v.match(/^(.*?)(?:\s*\[(input|output|temp)\])?\s*$/i);
      if (!m || !m[1]) throw new Error("未拿到遮罩结果文件");
      const path = m[1].replace(/\\/g, "/");
      const parts = path.split("/").filter(Boolean);
      const filename = parts.pop();
      const subfolder = parts.join("/");
      ref = { filename, subfolder, type: (m[2] || "input").toLowerCase() };
    }

    const paintedUrl = viewUrl({
      image: ref.filename,
      subfolder: ref.subfolder || "",
      type: ref.type || "input",
    });

    // 用 fetch+bitmap 保留 alpha，避免 <img> 丢透明通道
    const resp = await fetch(paintedUrl);
    if (!resp.ok) throw new Error("读取遮罩结果图失败");
    const paintedBlob = await resp.blob();
    const bmp = await createImageBitmap(paintedBlob);

    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);

    const maskC = document.createElement("canvas");
    maskC.width = c.width;
    maskC.height = c.height;
    const mctx = maskC.getContext("2d");
    const md = mctx.createImageData(c.width, c.height);
    let paintedPx = 0;
    let minA = 255;
    for (let i = 0; i < id.data.length; i += 4) {
      const a = id.data[i + 3];
      if (a < minA) minA = a;
    }
    // 自适应阈值：有透明则按 alpha；否则退回亮度差
    const useAlpha = minA < 250;
    for (let i = 0; i < id.data.length; i += 4) {
      let on = false;
      if (useAlpha) {
        on = id.data[i + 3] < 200;
      } else {
        // 极端情况 alpha 丢失：用相对暗/亮差异不可靠，尽量不误判
        on = false;
      }
      const v = on ? 255 : 0;
      if (v) paintedPx++;
      md.data[i] = md.data[i + 1] = md.data[i + 2] = v;
      md.data[i + 3] = 255;
    }
    if (!paintedPx) {
      alert("未检测到遮罩笔触（请在原生编辑器画完后点保存）。");
      return;
    }
    mctx.putImageData(md, 0, 0);

    // 缩略图：原图 + 半透明红罩（仅预览，绝不进模型）
    const preview = document.createElement("canvas");
    preview.width = c.width;
    preview.height = c.height;
    const pctx = preview.getContext("2d");
    pctx.fillStyle = "#111";
    pctx.fillRect(0, 0, preview.width, preview.height);
    const baseImg = new Image();
    baseImg.crossOrigin = "anonymous";
    await new Promise((res) => {
      baseImg.onload = () => res();
      baseImg.onerror = () => res();
      baseImg.src = viewUrl(origItem);
    });
    if (baseImg.width) pctx.drawImage(baseImg, 0, 0, c.width, c.height);
    else pctx.drawImage(bmp, 0, 0);
    const overlay = document.createElement("canvas");
    overlay.width = c.width;
    overlay.height = c.height;
    const octx = overlay.getContext("2d");
    const od = octx.createImageData(c.width, c.height);
    for (let i = 0; i < md.data.length; i += 4) {
      if (md.data[i] > 20) {
        od.data[i] = 255;
        od.data[i + 1] = 64;
        od.data[i + 2] = 64;
        od.data[i + 3] = 120;
      }
    }
    octx.putImageData(od, 0, 0);
    pctx.drawImage(overlay, 0, 0);

    const blob = await new Promise((r) => maskC.toBlob(r, "image/png"));
    if (!blob) throw new Error("导出遮罩失败");
    const filename = `ares_mask_${Date.now()}.png`;
    const form = new FormData();
    form.append("image", blob, filename);
    form.append("overwrite", "true");
    const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
    const data = await res.json();

    const arr = getMedia();
    if (arr[idx] && arr[idx].image === origItem.image) {
      arr[idx].mask = data?.name || filename;
      arr[idx].maskType = "input";
      arr[idx].maskSubfolder = data?.subfolder || "";
      // 预览压到 512 以内再存，JPEG 体积比 PNG 小一个量级，避免撑大工作流
      const prevScale = Math.min(1, 512 / Math.max(preview.width || 1, preview.height || 1));
      let prevOut = preview;
      if (prevScale < 1) {
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.round(preview.width * prevScale));
        small.height = Math.max(1, Math.round(preview.height * prevScale));
        small.getContext("2d").drawImage(preview, 0, 0, small.width, small.height);
        prevOut = small;
      }
      arr[idx].maskPreview = prevOut.toDataURL("image/jpeg", 0.8);
      // 确保原图路径不被原生编辑器结果覆盖
      if (!arr[idx].image) {
        arr[idx].image = origItem.image;
        arr[idx].type = origItem.type || "input";
        arr[idx].subfolder = origItem.subfolder || "";
      }
      setMedia(arr);
    }
    try {
      bmp.close?.();
    } catch (_) {}
  }

  async function uploadFiles(files) {
    let arr = getMedia();
    const failed = [];
    for (const file of files) {
      if (arr.length >= MAX_IMAGES) break;
      const ok =
        file?.type?.startsWith?.("image/") ||
        /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file?.name || "");
      if (!ok) continue;
      try {
        const form = new FormData();
        form.append("image", file);
        form.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok || !data?.name) throw new Error(`HTTP ${res.status}`);
        const sub = data?.subfolder || "";
        const fname = data?.name;
        arr.push({
          image: sub ? `${sub}/${fname}` : fname,
          mask: "",
          type: "input",
          subfolder: sub,
        });
      } catch (err) {
        console.warn("[AresQwenPE] 上传失败", err);
        failed.push(file.name);
      }
    }
    setMedia(arr);
    if (failed.length) {
      alert("以下图片上传失败：\n" + failed.join("\n"));
    }
  }

  /** 解析 Comfy 资产拖放（侧栏/资产面板拖入的引用或 URL） */
  function parseAssetRef(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    if (!s || s.startsWith("#")) return null;
    if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(s.split("?")[0].split("/").pop() || s) &&
        !/filename=/i.test(s)) {
      return null;
    }
    try {
      let url = null;
      if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
        url = new URL(s, window.location.origin);
      } else if (s.includes("filename=")) {
        url = new URL(s.startsWith("?") ? s : `?${s}`, window.location.origin);
      }
      if (url && url.searchParams.get("filename")) {
        const filename = decodeURIComponent(url.searchParams.get("filename"));
        const subfolder = decodeURIComponent(url.searchParams.get("subfolder") || "");
        const type = url.searchParams.get("type") || "input";
        return {
          image: subfolder ? `${subfolder}/${filename}` : filename,
          mask: "",
          type,
          subfolder,
        };
      }
    } catch (_) {}
    s = s.replace(/\s*\[(input|output|temp)\]\s*$/i, "").trim().replace(/\\/g, "/");
    if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(s)) return null;
    const parts = s.split("/").filter(Boolean);
    const filename = parts.pop();
    const subfolder = parts.join("/");
    return {
      image: subfolder ? `${subfolder}/${filename}` : filename,
      mask: "",
      type: "input",
      subfolder,
    };
  }

  function extractAssetRefs(dt) {
    if (!dt) return [];
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      const ref = parseAssetRef(raw);
      if (!ref?.image || seen.has(ref.image + "|" + (ref.type || ""))) return;
      seen.add(ref.image + "|" + (ref.type || ""));
      out.push(ref);
    };
    const tryGet = (mime) => {
      try {
        return dt.getData(mime) || "";
      } catch (_) {
        return "";
      }
    };
    const uriList = tryGet("text/uri-list");
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        if (line && !line.startsWith("#")) add(line);
      }
    }
    const moz = tryGet("text/x-moz-url");
    if (moz) {
      const lines = moz.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 2) if (lines[i]) add(lines[i]);
    }
    for (const mime of ["text/plain", "text", "application/json", "application/x-comfy-asset", "comfy/asset"]) {
      const plain = tryGet(mime);
      if (!plain) continue;
      if (mime.includes("json") || mime.includes("asset")) {
        try {
          const obj = JSON.parse(plain);
          const list = Array.isArray(obj) ? obj : [obj];
          for (const o of list) {
            if (!o) continue;
            if (typeof o === "string") add(o);
            else {
              const fn = o.filename || o.name || o.fileName || "";
              const sub = o.subfolder || "";
              const type = o.type || "input";
              if (fn) {
                add(`/view?filename=${encodeURIComponent(fn)}&type=${type}&subfolder=${encodeURIComponent(sub)}`);
              }
            }
          }
        } catch (_) {
          for (const line of plain.split(/\r?\n/)) if (line.trim()) add(line.trim());
        }
      } else {
        for (const line of plain.split(/\r?\n/)) if (line.trim()) add(line.trim());
      }
    }
    return out;
  }

  dropZone.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("[data-card]")) return;
    if (getMedia().length >= MAX_IMAGES) {
      alert("最多 6 张参考图。");
      return;
    }
    fileImg.click();
  });
  fileImg.onchange = async () => {
    const files = [...(fileImg.files || [])];
    fileImg.value = "";
    await uploadFiles(files);
  };

  /**
   * 【已退役】旧「裁切 / 分辨率」对话框。
   * 职责已由 ares_canvas_editor.js 的画布编辑器取代（两者入口均在卡片 ✎）。
   * 代码暂留作回滚参考，当前无任何调用点；确认新编辑器稳定后可整体删除。
   */
  function _legacyOpenImageEditDialog(item, idx) {
    closeStyleDialog();
    hideHoverPreview();
    const snap32 = (v) => Math.max(64, Math.round((Number(v) || 0) / 32) * 32);
    const mask = document.createElement("div");
    mask.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;pointer-events:auto;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "width:min(960px, 92vw);max-width:calc(100vw - 32px);max-height:94vh;overflow-y:auto;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:8px;padding:12px;box-sizing:border-box;font-size:12px;";
    const title = document.createElement("div");
    title.textContent = "裁切 / 分辨率调整";
    title.style.cssText = "font-weight:600;margin-bottom:4px;color:#cfd3dc;";
    panel.appendChild(title);
    const hint = document.createElement("div");
    hint.textContent = "在图上拖拽画出裁切框（不画 = 整图）；宽高可直接改比例，输出自动对齐 32 的倍数。";
    hint.style.cssText = "color:#7a8694;font-size:11px;margin-bottom:8px;";
    panel.appendChild(hint);

    const stage = document.createElement("div");
    stage.style.cssText =
      "position:relative;background:#0d0d0d;border:1px solid #333;border-radius:6px;overflow:hidden;user-select:none;touch-action:none;line-height:0;";
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.draggable = false;
    img.src = viewUrl(item);
    img.onerror = () => { info.textContent = "图片加载失败"; };
    img.style.cssText = "display:block;max-width:100%;max-height:66vh;width:auto;height:auto;margin:0 auto;";
    stage.appendChild(img);
    panel.appendChild(stage);

    const rectEl = document.createElement("div");
    rectEl.style.cssText =
      "position:absolute;border:1px dashed #6af;background:rgba(60,130,255,.18);display:none;pointer-events:none;box-sizing:border-box;z-index:2;";
    stage.appendChild(rectEl);

    let sel = null;
    let dragStart = null;
    const imgRect = () => img.getBoundingClientRect();
    const stageRect = () => stage.getBoundingClientRect();
    const toLocal = (e) => {
      const r = imgRect();
      return {
        x: Math.min(Math.max(e.clientX, r.left), r.right) - r.left,
        y: Math.min(Math.max(e.clientY, r.top), r.bottom) - r.top,
      };
    };
    const paintRect = () => {
      if (!sel) return;
      const r = imgRect(), s = stageRect();
      rectEl.style.left = (r.left - s.left + sel.x) + "px";
      rectEl.style.top = (r.top - s.top + sel.y) + "px";
      rectEl.style.width = sel.w + "px";
      rectEl.style.height = sel.h + "px";
    };
    stage.addEventListener("pointerdown", (e) => {
      if (!img.complete || !img.naturalWidth) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      dragStart = toLocal(e);
      sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
      rectEl.style.display = "block";
      paintRect();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragStart) return;
      const p = toLocal(e);
      sel = {
        x: Math.min(dragStart.x, p.x),
        y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x),
        h: Math.abs(p.y - dragStart.y),
      };
      paintRect();
      refreshInfo();
    });
    stage.addEventListener("pointerup", () => {
      if (!dragStart) return;
      dragStart = null;
      if (sel && (sel.w < 8 || sel.h < 8)) {   // 太小的框视为整图
        sel = null;
        rectEl.style.display = "none";
      }
      fillInputs();
      refreshInfo();
    });

    const info = document.createElement("div");
    info.style.cssText = "margin:8px 0 6px;color:#9ab;font-size:11px;";
    panel.appendChild(info);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:#bbb;";
    const modeSel = document.createElement("select");
    modeSel.style.cssText = "background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px;";
    [["orig", "原图尺寸"], ["1024", "长边 1024"], ["1216", "长边 1216"], ["1440", "长边 1440"], ["2048", "长边 2048"], ["custom", "自定义"]].forEach(([v, t]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      modeSel.appendChild(o);
    });
    const mkNum = (ph) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "32";
      inp.placeholder = ph;
      inp.style.cssText = "width:76px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 4px;";
      return inp;
    };
    const wIn = mkNum("宽");
    const hIn = mkNum("高");
    row.appendChild(modeSel);
    row.appendChild(document.createTextNode("宽"));
    row.appendChild(wIn);
    row.appendChild(document.createTextNode("高"));
    row.appendChild(hIn);
    const tip = document.createElement("span");
    tip.textContent = "×32 对齐";
    tip.style.cssText = "color:#7a8694;font-size:10px;";
    row.appendChild(tip);
    panel.appendChild(row);

    const cropNat = () => {
      if (!sel) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const sx = img.clientWidth ? img.naturalWidth / img.clientWidth : 1;
      const sy = img.clientHeight ? img.naturalHeight / img.clientHeight : 1;
      return { x: sel.x * sx, y: sel.y * sy, w: sel.w * sx, h: sel.h * sy };
    };
    const fillInputs = () => {
      const c = cropNat();
      if (modeSel.value === "orig") {
        wIn.value = String(snap32(c.w));
        hIn.value = String(snap32(c.h));
      } else if (modeSel.value !== "custom") {
        const long = parseInt(modeSel.value, 10);
        const scale = long / Math.max(c.w, c.h);
        wIn.value = String(snap32(c.w * scale));
        hIn.value = String(snap32(c.h * scale));
      }
    };
    const refreshInfo = () => {
      if (!img.naturalWidth) { info.textContent = "图片加载中…"; return; }
      const c = cropNat();
      info.textContent =
        `原图 ${img.naturalWidth}×${img.naturalHeight} · 裁切 ${Math.round(c.w)}×${Math.round(c.h)}` +
        ` · 输出 ${wIn.value || "?"}×${hIn.value || "?"}（32 对齐）`;
    };
    modeSel.onchange = () => {
      fillInputs();
      refreshInfo();
    };
    wIn.oninput = refreshInfo;
    hIn.oninput = refreshInfo;
    img.onload = () => { fillInputs(); refreshInfo(); };

    const err = document.createElement("div");
    err.style.cssText = "min-height:16px;color:#f66;margin-top:6px;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "应用";
    const btnCss = "cursor:pointer;border:1px solid #555;border-radius:4px;padding:4px 12px;background:#333;color:#eee;";
    cancelBtn.style.cssText = btnCss;
    okBtn.style.cssText = btnCss;
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    panel.appendChild(err);
    panel.appendChild(actions);
    mask.appendChild(panel);

    const stop = (e) => e.stopPropagation();
    mask.addEventListener("pointerdown", stop);
    mask.addEventListener("wheel", stop, { passive: true });
    panel.addEventListener("pointerdown", stop);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      try { mask.remove(); } catch (_) {}
      if (_closeStyleDialog === close) _closeStyleDialog = null;
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    okBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      err.textContent = "";
      if (!img.complete || !img.naturalWidth) {
        err.textContent = "图片未加载";
        return;
      }
      const w = snap32(wIn.value);
      const h = snap32(hIn.value);
      if (w < 64 || h < 64) {
        err.textContent = "输出尺寸太小";
        return;
      }
      const c = cropNat();
      if (c.w < 8 || c.h < 8) {
        err.textContent = "图片无效";
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, c.x, c.y, c.w, c.h, 0, 0, w, h);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!blob) {
        err.textContent = "导出失败";
        return;
      }
      okBtn.disabled = true;
      try {
        const filename = `ares_edit_${Date.now()}.png`;
        const form = new FormData();
        form.append("image", blob, filename);
        form.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok || !data?.name) throw new Error(`上传失败 HTTP ${res.status}`);
        const arr = getMedia();
        if (arr[idx] && arr[idx].image === item.image) {
          const hist = arr[idx].editHistory || (arr[idx].editHistory = []);
          hist.push({ image: arr[idx].image, type: arr[idx].type || "input", subfolder: arr[idx].subfolder || "" });
          const sub = String(data?.subfolder || "");
          arr[idx].image = sub ? `${sub}/${data.name}` : data.name;
          arr[idx].type = "input";
          arr[idx].subfolder = sub;
          // 走了一次裁切/缩放，画布文档的图层结构已不再对应当前图
          delete arr[idx]._canvasDoc;
          delete arr[idx]._canvasW;
          delete arr[idx]._canvasH;
          if (arr[idx].mask || arr[idx].maskPreview) {
            arr[idx].mask = "";
            arr[idx].maskType = "";
            arr[idx].maskSubfolder = "";
            arr[idx].maskPreview = "";
            alert("图片尺寸已变化，该图原有遮罩已清除，需要时请重新绘制。");
          }
          setMedia(arr);
        }
        close();
      } catch (ex) {
        err.textContent = ex?.message || "操作失败";
        okBtn.disabled = false;
      }
    };
    _closeStyleDialog = close;
    document.body.appendChild(mask);
    // 缓存图不会再触发 onload，挂载后补一次信息填充
    if (img.complete) { fillInputs(); refreshInfo(); }
  }

  /**
   * 打开画布编辑器并处理结果。
   *
   * idx === 0：编辑第 1 张（底图 + 已有图层），应用后替换第 1 张；
   * idx > 0 ：以第 1 张为底图打开，把本图作为新图层加入（旧 ⧉ 叠加对话框的职责）。
   */
  async function openWorkbenchCanvasEditor(item, idx) {
    closeStyleDialog();
    hideHoverPreview();
    const arr = getMedia();
    const target = arr[idx];
    if (!target) {
      alert("没有参考图，无法打开画布编辑器。");
      return;
    }
    const isBase = idx === 0;
    const baseUrl = viewUrl(target);
    // 画板初始尺寸 = 该图当前实际尺寸（读不到时交给编辑器自行探测）
    let presetW = 0;
    let presetH = 0;
    try {
      const im = await new Promise((res, rej) => {
        const t = new Image();
        // ComfyUI 的 /view 是同源接口且不带 CORS 响应头；同源时加 crossOrigin
        // 会让浏览器改走 CORS 模式校验，反而加载失败。
        if (new URL(baseUrl, window.location.href).origin !== window.location.origin) {
          t.crossOrigin = "anonymous";
        }
        t.onload = () => res(t);
        t.onerror = () => rej(new Error("load"));
        t.src = baseUrl;
      });
      presetW = im.naturalWidth || 0;
      presetH = im.naturalHeight || 0;
    } catch (_) {}
    const out = await openCanvasEditor({
      baseUrl,
      baseName: isBase ? "底图" : (String(target.image || "").replace(/\\/g, "/").split("/").pop() || "图层"),
      layerUrls: [],
      presetW: presetW || undefined,
      presetH: presetH || undefined,
      title: isBase
        ? "画布编辑器 · <image1>"
        : `画布编辑器 · <image${idx + 1}>（独立编辑）`,
      // 重绘范围工具只给第 1 张参考图
      inpaintCrop: isBase,
      // 图层文档按卡保存：每张卡记住自己的编辑结构，进入时还原
      doc: target._canvasDoc || null,
    });
    if (!out?.blob) return;

    // 上传合成结果
    let data = null;
    try {
      const filename = `ares_canvas_${Date.now()}.png`;
      const form = new FormData();
      form.append("image", out.blob, filename);
      form.append("overwrite", "true");
      const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
      data = await res.json();
      if (!res.ok || !data?.name) throw new Error(`上传失败 HTTP ${res.status}`);
    } catch (ex) {
      alert(ex?.message || "画布合成图上传失败");
      return;
    }

    const next = getMedia();
    const t = next[idx];
    if (!t) return;
    // 旧状态入历史（↩ 可回到任何编辑之前）
    const hist = t.editHistory || (t.editHistory = []);
    hist.push({ image: t.image, type: t.type || "input", subfolder: t.subfolder || "" });
    const sub = String(data?.subfolder || "");
    t.image = sub ? `${sub}/${data.name}` : data.name;
    t.type = "input";
    t.subfolder = sub;

    // 重绘范围随画布文档走，画板尺寸变化不需要清；
    // 遮罩画在原图上，画板尺寸变了必然错位 → 清除并告知（遮罩只有第 1 张有）
    const sizeChanged = Number(t._canvasW) !== out.width || Number(t._canvasH) !== out.height;
    if (isBase && sizeChanged && (t.mask || t.maskPreview)) {
      t.mask = "";
      t.maskType = "";
      t.maskSubfolder = "";
      t.maskPreview = "";
      alert(`画板尺寸已变为 ${out.width}×${out.height}，该图原有遮罩已清除，需要时请重新绘制。`);
    }
    t._canvasW = out.width;
    t._canvasH = out.height;
    // 重绘范围随画布文档带回（仅第 1 张生效，后端按 范围+羽化 裁剪）
    if (out.doc && out.doc.inpaintCrop && out.doc.inpaintCrop.w >= 16 && out.doc.inpaintCrop.h >= 16) {
      t.inpaintCrop = out.doc.inpaintCrop;
    } else {
      delete t.inpaintCrop;
    }
    // 记住这一轮的图层结构：按卡保存，下次打开该卡原样还原
    if (out.doc && Array.isArray(out.doc.layers) && out.doc.layers.length) {
      // 绑定生成这份 doc 的底图文件名，判断"卡是否换图"用
      out.doc.baseImage = String(t.image || "").replace(/\\/g, "/").split("/").pop();
      t._canvasDoc = out.doc;
    } else {
      // 没带回有效 doc（空画布或导出异常）：旧 doc 与新出图不再对应，作废
      delete t._canvasDoc;
      delete t.inpaintCrop;
    }
    setMedia(next);
  }

  function restoreOriginal(idx) {
    const arr = getMedia();
    const cur = arr[idx];
    if (!cur || !(cur.editHistory || []).length) return;
    const first = cur.editHistory[0];
    cur.image = first.image;
    cur.type = first.type || "input";
    cur.subfolder = first.subfolder || "";
    cur.editHistory = [];
    // 图层文档随之作废：图片已回到原图，旧 doc 的图层结构不再对应当前图
    delete cur._canvasDoc;
    delete cur._canvasW;
    delete cur._canvasH;
    delete cur.inpaintCrop;
    // 尺寸回到原图，遮罩必然错位，一并清除
    cur.mask = "";
    cur.maskType = "";
    cur.maskSubfolder = "";
    cur.maskPreview = "";
    setMedia(arr);
  }

  /**
   * 【已退役】旧「叠加到图1（图层合成）」对话框。
   * 职责已并入画布编辑器（从第 2 张卡片的 ✎ 进入即自动作为图层加入）。
   * 代码暂留作回滚参考，当前无任何调用点；确认新编辑器稳定后可整体删除。
   */
  function _legacyOpenLayerCompositeDialog(item, idx) {
    const base = getMedia()[0];
    if (!base) {
      alert("没有第 1 张参考图作为底图，无法叠加。");
      return;
    }
    closeStyleDialog();
    hideHoverPreview();
    const mask = document.createElement("div");
    mask.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;pointer-events:auto;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "width:min(1100px, 94vw);max-width:calc(100vw - 32px);max-height:94vh;overflow-y:auto;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:8px;padding:12px;box-sizing:border-box;font-size:12px;";
    const title = document.createElement("div");
    title.textContent = "图层叠加到图1";
    title.style.cssText = "font-weight:600;margin-bottom:4px;color:#cfd3dc;";
    panel.appendChild(title);
    const hint = document.createElement("div");
    hint.textContent =
      "拖动图层=移动，拖四角=缩放，拖顶部圆点=旋转（底图区域拖动也可旋转）；羽化/不透明度用滑杆。应用后合成图替换第 1 张参考图（可点其 ↩ 还原），再配「图层融合」模板跑。";
    hint.style.cssText = "color:#7a8694;font-size:11px;margin-bottom:8px;";
    panel.appendChild(hint);

    const stage = document.createElement("div");
    stage.style.cssText =
      "position:relative;background:#0d0d0d;border:1px solid #333;border-radius:6px;overflow:hidden;line-height:0;";
    const baseImg = new Image();
    baseImg.crossOrigin = "anonymous";
    baseImg.draggable = false;
    baseImg.src = viewUrl(base);
    baseImg.style.cssText = "display:block;max-width:100%;max-height:72vh;width:auto;height:auto;margin:0 auto;";
    stage.appendChild(baseImg);
    // 图层盒：图 + 四角手柄，PS 自由变换式操作
    const layerBox = document.createElement("div");
    layerBox.style.cssText =
      "position:absolute;left:0;top:0;display:none;cursor:move;transform-origin:center center;outline:1px solid rgba(80,150,255,.9);";
    const layerImg = new Image();
    layerImg.crossOrigin = "anonymous";
    layerImg.draggable = false;
    layerImg.src = viewUrl(item);
    layerImg.style.cssText = "display:block;width:100%;height:100%;pointer-events:none;";
    layerBox.appendChild(layerImg);
    stage.appendChild(layerBox);
    panel.appendChild(stage);
    baseImg.onload = () => { baseReady = true; placeOnce(); };
    layerImg.onload = () => { layerReady = true; placeOnce(); };

    let cx = 0, cy = 0, placed = false;
    let dispW = 120, dispH = 160;
    let rotDeg = 0, featherPx = 24, opaPct = 100;
    let scalePct = 100;
    let baseReady = false, layerReady = false;
    let moveActive = false, moveOff = null, scaleState = null, rotState = null;

    function refreshInfo() {
      readout.textContent =
        `缩放 ${scalePct}% · 旋转 ${rotDeg}° · 羽化 ${featherPx}px · 不透明度 ${opaPct}%`;
    }
    const layoutLayer = () => {
      layerBox.style.left = cx + "px";
      layerBox.style.top = cy + "px";
      layerBox.style.width = dispW + "px";
      layerBox.style.height = dispH + "px";
      layerBox.style.transform = `translate(-50%,-50%) rotate(${rotDeg}deg)`;
      layerBox.style.opacity = String(opaPct / 100);
      scalePct = Math.round(dispW / (layerImg.naturalWidth || dispW) * 100);
      refreshInfo();
    };
    const placeOnce = () => {
      if (baseReady && layerReady && !placed && baseImg.clientWidth) {
        placed = true;
        cx = baseImg.clientWidth / 2;
        cy = baseImg.clientHeight / 2;
        dispW = Math.max(40, Math.round(baseImg.clientWidth * 0.4));
        dispH = Math.round(dispW * (layerImg.naturalHeight || 3) / (layerImg.naturalWidth || 4));
        layoutLayer();
        layerBox.style.display = "block";
      }
    };

    // 四角手柄：拖角缩放
    ["nw", "ne", "sw", "se"].forEach((pos) => {
      const h = document.createElement("div");
      h.style.cssText =
        "position:absolute;width:11px;height:11px;background:#fff;border:1px solid #4a90ff;box-sizing:border-box;z-index:2;";
      if (pos.includes("n")) h.style.top = "-6px"; else h.style.bottom = "-6px";
      if (pos.includes("w")) h.style.left = "-6px"; else h.style.right = "-6px";
      h.style.cursor = (pos === "nw" || pos === "se") ? "nwse-resize" : "nesw-resize";
      h.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { h.setPointerCapture(e.pointerId); } catch (_) {}
        const s = stage.getBoundingClientRect();
        const dx = e.clientX - (s.left + cx), dy = e.clientY - (s.top + cy);
        scaleState = { dist: Math.max(8, Math.hypot(dx, dy)), w: dispW, h: dispH };
      });
      h.addEventListener("pointermove", (e) => {
        if (!scaleState) return;
        const s = stage.getBoundingClientRect();
        const dx = e.clientX - (s.left + cx), dy = e.clientY - (s.top + cy);
        const factor = Math.max(0.05, Math.hypot(dx, dy) / scaleState.dist);
        dispW = Math.max(24, Math.round(scaleState.w * factor));
        dispH = Math.max(24, Math.round(scaleState.h * factor));
        layoutLayer();
      });
      h.addEventListener("pointerup", () => { scaleState = null; });
      layerBox.appendChild(h);
    });

    // 旋转手柄：盒顶中央圆点，拖动旋转（随盒子转动，不受底图可见区域限制）
    const rotStem = document.createElement("div");
    rotStem.style.cssText =
      "position:absolute;top:-24px;left:50%;width:1px;height:24px;background:rgba(80,150,255,.9);z-index:1;pointer-events:none;";
    const rotH = document.createElement("div");
    rotH.style.cssText =
      "position:absolute;top:-32px;left:50%;margin-left:-6px;width:12px;height:12px;border-radius:50%;" +
      "background:#fff;border:1px solid #4a90ff;box-sizing:border-box;cursor:grab;z-index:2;";
    rotH.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { rotH.setPointerCapture(e.pointerId); } catch (_) {}
      const s = stage.getBoundingClientRect();
      rotState = { a0: Math.atan2(e.clientY - (s.top + cy), e.clientX - (s.left + cx)), r0: rotDeg };
    });
    rotH.addEventListener("pointermove", (e) => {
      if (!rotState) return;
      const s = stage.getBoundingClientRect();
      const a = Math.atan2(e.clientY - (s.top + cy), e.clientX - (s.left + cx));
      rotDeg = Math.round(rotState.r0 + (a - rotState.a0) * 180 / Math.PI);
      layoutLayer();
    });
    rotH.addEventListener("pointerup", () => { rotState = null; });
    layerBox.appendChild(rotStem);
    layerBox.appendChild(rotH);

    // 盒内拖动 = 移动
    layerBox.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { layerBox.setPointerCapture(e.pointerId); } catch (_) {}
      const s = stage.getBoundingClientRect();
      moveOff = { x: e.clientX - cx - s.left, y: e.clientY - cy - s.top };
      moveActive = true;
    });
    layerBox.addEventListener("pointermove", (e) => {
      if (!moveActive) return;
      const s = stage.getBoundingClientRect();
      cx = Math.min(Math.max(e.clientX - moveOff.x - s.left, 0), s.width);
      cy = Math.min(Math.max(e.clientY - moveOff.y - s.top, 0), s.height);
      layoutLayer();
    });
    layerBox.addEventListener("pointerup", () => { moveActive = false; });

    // 底图区域拖动 = 旋转（图层的盒外，PS 习惯）
    baseImg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { baseImg.setPointerCapture(e.pointerId); } catch (_) {}
      const s = stage.getBoundingClientRect();
      rotState = { a0: Math.atan2(e.clientY - (s.top + cy), e.clientX - (s.left + cx)), r0: rotDeg };
    });
    baseImg.addEventListener("pointermove", (e) => {
      if (!rotState) return;
      const s = stage.getBoundingClientRect();
      const a = Math.atan2(e.clientY - (s.top + cy), e.clientX - (s.left + cx));
      rotDeg = Math.round(rotState.r0 + (a - rotState.a0) * 180 / Math.PI);
      layoutLayer();
    });
    baseImg.addEventListener("pointerup", () => { rotState = null; });

    const readout = document.createElement("div");
    readout.style.cssText = "margin:8px 0 6px;color:#9ab;font-size:11px;";
    panel.appendChild(readout);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#bbb;";
    const mkSlider = (label, min, max, val) => {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
      wrap.appendChild(document.createTextNode(label));
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = String(min);
      inp.max = String(max);
      inp.value = String(val);
      inp.style.cssText = "width:110px;";
      const num = document.createElement("span");
      num.style.cssText = "min-width:34px;color:#9ab;font-size:11px;";
      num.textContent = String(val);
      inp.oninput = () => {
        num.textContent = inp.value;
        if (label === "羽化px") { featherPx = Number(inp.value); }
        if (label === "不透明度%") { opaPct = Number(inp.value); layoutLayer(); }
        refreshInfo();
      };
      wrap.appendChild(inp);
      wrap.appendChild(num);
      row.appendChild(wrap);
    };
    mkSlider("羽化px", 0, 100, featherPx);
    mkSlider("不透明度%", 20, 100, opaPct);
    panel.appendChild(row);
    baseImg.onerror = () => { err.textContent = "底图加载失败"; };
    layerImg.onerror = () => { err.textContent = "图层加载失败"; };
    // 双保险：定位未完成前，面板内任何点击先触发初始定位
    stage.addEventListener("pointerdown", () => { if (!placed) placeOnce(); }, true);
    if (baseImg.complete) { baseReady = true; }
    if (layerImg.complete) { layerReady = true; }
    placeOnce();

    const err = document.createElement("div");
    err.style.cssText = "min-height:16px;color:#f66;margin-top:6px;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "应用合成";
    const btnCss = "cursor:pointer;border:1px solid #555;border-radius:4px;padding:4px 12px;background:#333;color:#eee;";
    cancelBtn.style.cssText = btnCss;
    okBtn.style.cssText = btnCss;
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    panel.appendChild(err);
    panel.appendChild(actions);
    mask.appendChild(panel);

    const stop = (e) => e.stopPropagation();
    mask.addEventListener("pointerdown", stop);
    mask.addEventListener("wheel", stop, { passive: true });
    panel.addEventListener("pointerdown", stop);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      try { mask.remove(); } catch (_) {}
      if (_closeStyleDialog === close) _closeStyleDialog = null;
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    okBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      err.textContent = "";
      if (!baseImg.complete || !baseImg.naturalWidth || !layerImg.complete || !layerImg.naturalWidth) {
        err.textContent = "图片未加载完成";
        return;
      }
      const bw = baseImg.naturalWidth, bh = baseImg.naturalHeight;
      const k = baseImg.clientWidth ? bw / baseImg.clientWidth : 1;
      const baseRect = baseImg.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const offX = baseRect.left - stageRect.left;
      const offY = baseRect.top - stageRect.top;
      // 图层画布取旋转后的外接框，避免转角被裁
      const rad = rotDeg * Math.PI / 180;
      const lw0 = dispW * k;
      const lh0 = dispH * k;
      const lw = Math.max(1, Math.round(Math.abs(lw0 * Math.cos(rad)) + Math.abs(lh0 * Math.sin(rad))));
      const lh = Math.max(1, Math.round(Math.abs(lw0 * Math.sin(rad)) + Math.abs(lh0 * Math.cos(rad))));
      const lc = document.createElement("canvas");
      lc.width = lw;
      lc.height = lh;
      const lctx = lc.getContext("2d");
      lctx.save();
      lctx.translate(lw / 2, lh / 2);
      lctx.rotate(rad);
      lctx.drawImage(layerImg, -lw0 / 2, -lh0 / 2, lw0, lh0);
      lctx.restore();
      if (featherPx > 0) {
        // 用自身模糊后的 alpha 收边：边缘羽化，内部颜色不受影响
        const m = document.createElement("canvas");
        m.width = lw;
        m.height = lh;
        const mctx = m.getContext("2d");
        mctx.filter = `blur(${featherPx}px)`;
        mctx.drawImage(lc, 0, 0);
        lctx.globalCompositeOperation = "destination-in";
        lctx.drawImage(m, 0, 0);
        lctx.globalCompositeOperation = "source-over";
      }
      const canvas = document.createElement("canvas");
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(baseImg, 0, 0, bw, bh);
      ctx.globalAlpha = opaPct / 100;
      ctx.drawImage(lc, Math.round((cx - offX) * k - lw / 2), Math.round((cy - offY) * k - lh / 2));
      ctx.globalAlpha = 1;
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!blob) {
        err.textContent = "导出失败";
        return;
      }
      okBtn.disabled = true;
      try {
        const filename = `ares_layer_${Date.now()}.png`;
        const form = new FormData();
        form.append("image", blob, filename);
        form.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok || !data?.name) throw new Error(`上传失败 HTTP ${res.status}`);
        const arr = getMedia();
        if (arr[0]) {
          const hist = arr[0].editHistory || (arr[0].editHistory = []);
          hist.push({ image: arr[0].image, type: arr[0].type || "input", subfolder: arr[0].subfolder || "" });
          const sub = String(data?.subfolder || "");
          arr[0].image = sub ? `${sub}/${data.name}` : data.name;
          arr[0].type = "input";
          arr[0].subfolder = sub;
          // 旧图层合成对话框直出平面图，画布文档随之作废
          delete arr[0]._canvasDoc;
          delete arr[0]._canvasW;
          delete arr[0]._canvasH;
          setMedia(arr);
        }
        close();
      } catch (ex) {
        err.textContent = ex?.message || "操作失败";
        okBtn.disabled = false;
      }
    };
    _closeStyleDialog = close;
    document.body.appendChild(mask);
    // 挂到 DOM 后 clientWidth 才有效；缓存图不会触发 onload，挂载后补跑初始定位
    if (baseImg.complete) { baseReady = true; }
    if (layerImg.complete) { layerReady = true; }
    requestAnimationFrame(() => placeOnce());
  }

  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = "#6af";
    });
  });
  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#555";
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.borderColor = "#555";
    const dt = e.dataTransfer;
    // 资产优先：侧栏拖图常同时带空 files + uri-list
    const refs = extractAssetRefs(dt || {});
    const files = [...(dt?.files || [])].filter(
      (f) => f?.type?.startsWith?.("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f?.name || "")
    );
    if (refs.length) {
      let arr = getMedia();
      for (const ref of refs) {
        if (arr.length >= MAX_IMAGES) break;
        arr.push(ref);
      }
      setMedia(arr);
      return;
    }
    if (files.length) {
      await uploadFiles(files);
    }
  });

  const promptBox = document.createElement("div");
  promptBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const promptHead = document.createElement("div");
  promptHead.style.cssText =
    "display:flex;align-items:center;gap:8px;font-weight:600;color:#cfd3dc;margin-bottom:6px;flex-shrink:0;";
  const promptTitle = document.createElement("span");
  promptTitle.textContent = "③ 提示词";
  const promptHint = document.createElement("span");
  promptHint.style.cssText =
    "flex:1;color:#7a8694;font-size:11px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  promptHint.textContent = "一行一段 · 一行一张图 · 下方可分批";
  promptHint.title =
    "一行一段，每行套用当前风格并出一张图；「起始索引/最大行数/去除空行」控制本次跑哪几行；节点开启「改写」时每行先经 PE 扩写再输出。";
  promptHead.appendChild(promptTitle);
  promptHead.appendChild(promptHint);
  const promptArea = document.createElement("textarea");
  promptArea.placeholder = "";
  promptArea.spellcheck = false;
  promptArea.style.cssText =
    "flex:1;width:100%;min-height:72px;resize:none;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:4px;padding:6px;font-size:13px;";
  const optRow = document.createElement("div");
  optRow.style.cssText =
    "display:flex;gap:8px;align-items:center;margin-top:6px;flex-shrink:0;color:#bbb;";
  function numField(label, widget, fallback) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
    wrap.appendChild(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = "number";
    const opts = widget?.options || {};
    if (opts.min != null) input.min = String(opts.min);
    if (opts.max != null) input.max = String(opts.max);
    input.value = String(widget?.value ?? fallback);
    input.style.cssText =
      "width:72px;background:#1a1a1a;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px;";
    const clamp = (raw) => {
      let n = Number(raw);
      if (!Number.isFinite(n)) n = Number(fallback) || 0;
      if (opts.min != null) n = Math.max(Number(opts.min), n);
      if (opts.max != null) n = Math.min(Number(opts.max), n);
      return n;
    };
    input.oninput = () => setVal(widget, clamp(input.value));
    input.onchange = () => {
      input.value = String(clamp(input.value));
    };
    wrap.appendChild(input);
    return { wrap, input };
  }
  const startField = numField("起始索引", wStart, 0);
  const rowsField = numField("最大行数", wRows, 1000);
  const emptyWrap = document.createElement("label");
  emptyWrap.style.cssText = "display:flex;align-items:center;gap:4px;margin-left:auto;";
  emptyWrap.appendChild(document.createTextNode("去除空行"));
  const emptyInput = document.createElement("input");
  emptyInput.type = "checkbox";
  emptyInput.checked = Boolean(wEmpty?.value);
  emptyInput.onchange = () => setVal(wEmpty, emptyInput.checked);
  emptyWrap.appendChild(emptyInput);
  optRow.appendChild(startField.wrap);
  optRow.appendChild(rowsField.wrap);
  optRow.appendChild(emptyWrap);

  // —— 参数折叠区：默认收起，展开可调（数值存于隐藏的原生 widget，随工作流序列化）——
  let advOpen = !!node.properties.ares_adv_open;
  const advBtn = document.createElement("button");
  advBtn.type = "button";
  advBtn.title = "展开/收起采样与 cfg 参数";
  advBtn.style.cssText =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:2px 8px;background:#333;color:#ccc;font-size:11px;";
  const advFold = document.createElement("div");
  advFold.style.cssText =
    "display:none;flex-wrap:wrap;gap:8px;align-items:center;";
  const paintAdv = () => {
    advBtn.textContent = advOpen ? "参数 ▴" : "参数 ▸";
    advFold.style.display = advOpen ? "flex" : "none";
  };
  advBtn.onclick = () => {
    advOpen = !advOpen;
    try { node.properties.ares_adv_open = advOpen; } catch (_) {}
    paintAdv();
    refreshDomSize();
  };
  function advNum(label, w, fallback, step) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;color:#aaa;";
    wrap.appendChild(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = "number";
    const opts = w?.options || {};
    if (opts.min != null) input.min = String(opts.min);
    if (opts.max != null) input.max = String(opts.max);
    if (step) input.step = String(step);
    input.value = String(w?.value ?? fallback);
    input.style.cssText = "width:76px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px;";
    const clamp = (raw) => {
      let n = Number(raw);
      if (!Number.isFinite(n)) n = Number(fallback) || 0;
      if (opts.min != null) n = Math.max(Number(opts.min), n);
      if (opts.max != null) n = Math.min(Number(opts.max), n);
      return n;
    };
    input.oninput = () => setVal(w, clamp(input.value));
    input.onchange = () => {
      input.value = String(clamp(input.value));
    };
    wrap.appendChild(input);
    return wrap;
  }
  function advCheck(label, w, fallback) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:#aaa;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(w?.value ?? fallback);
    input.onchange = () => setVal(w, input.checked);
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(label));
    return wrap;
  }
  advFold.appendChild(advNum("cfg_t2i", findW(node, "cfg_t2i"), 1.0, 0.1));
  advFold.appendChild(advNum("cfg_i2i", findW(node, "cfg_i2i"), 3.0, 0.1));
  advFold.appendChild(advCheck("采样", findW(node, "do_sample"), true));
  advFold.appendChild(advNum("温度", findW(node, "temperature"), 1.0, 0.01));
  advFold.appendChild(advNum("top_p", findW(node, "top_p"), 0.95, 0.01));
  advFold.appendChild(advNum("top_k", findW(node, "top_k"), 20, 1));
  advFold.appendChild(advNum("max_len", findW(node, "max_length"), 0, 1));
  paintAdv();

  promptBox.appendChild(promptHead);
  promptBox.appendChild(promptArea);
  promptBox.appendChild(optRow);

  const applyPromptH = (h) => {
    heights.prompt = h;
    promptBox.style.height = h + "px";
    refreshDomSize();
  };
  promptArea.oninput = () => setVal(wText, promptArea.value);
  function renderPrompt() {
    // widget 被原生「转输入」后仍保留原引用，此时只在框内留旧值、不再回写
    if (textWidgetOk()) promptArea.value = wText?.value || "";
    startField.input.value = String(wStart?.value ?? 0);
    rowsField.input.value = String(wRows?.value ?? 1000);
    emptyInput.checked = Boolean(wEmpty?.value);
  }

  // —— 提示词外部接入：接上「提示词接入」后框置灰只读，避免以为框内文字生效 ——
  const FEED_INPUT = "提示词接入";
  const HINT_IDLE = "一行一段 · 一行一张图 · 下方可分批";
  const HINT_IDLE_TIP =
    "一行一段，每行套用当前风格并出一张图；「起始索引/最大行数/去除空行」控制本次跑哪几行；节点开启「改写」时每行先经 PE 扩写再输出。";
  const feedLinkOn = () => {
    const slot = node.inputs?.find((i) => i?.name === FEED_INPUT);
    return Boolean(slot && slot.link != null);
  };
  const paintFeed = () => {
    const on = feedLinkOn() || !textWidgetOk();
    promptTitle.textContent = on ? "③ 提示词 · 已接入" : "③ 提示词";
    promptArea.readOnly = on;
    promptArea.style.opacity = on ? "0.5" : "1";
    promptArea.style.cursor = on ? "not-allowed" : "text";
    promptArea.title = on
      ? "文本由「提示词接入」连线提供，框内文字本轮不生效；断开连线即可继续编辑。"
      : "";
    promptHint.textContent = on ? "上游文本接入中 · 本框只读" : HINT_IDLE;
    promptHint.title = on
      ? "提示词来自「提示词接入」上游节点；起始索引/最大行数/去除空行、风格与 PE 改写照常生效。"
      : HINT_IDLE_TIP;
  };
  const prevConnChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo, ioSlot) {
    try {
      const name = ioSlot?.name || node.inputs?.[index]?.name;
      if (name === FEED_INPUT) paintFeed();
    } catch (_) {}
    if (prevConnChange) return prevConnChange.apply(this, arguments);
  };

  advBar = document.createElement("div");
  advBar.style.cssText =
    "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;flex-shrink:0;";
  advBar.appendChild(advBtn);
  advBar.appendChild(advFold);
  root.appendChild(advBar);
  root.appendChild(styleBox);
  root.appendChild(
    makeSplitter(
      () => heights.style,
      applyStyleH,
      saveHeights
    )
  );
  root.appendChild(imgBox);
  root.appendChild(
    makeSplitter(
      () => heights.img,
      applyImgH,
      saveHeights
    )
  );
  root.appendChild(promptBox);
  root.appendChild(
    makeSplitter(
      () => heights.prompt,
      applyPromptH,
      saveHeights
    )
  );
  root.appendChild(fileImg);

  domWidget = node.addDOMWidget("ares_qwen_pe", "div", root, {
    serialize: false,
  });
  bindDomWidgetWidthToNode(domWidget, node);

  applyStyleH(heights.style);
  applyImgH(heights.img);
  applyPromptH(heights.prompt);

  node._aresWorkbench = {
    refresh() {
      loadLibPairs().then(() => {
        migrateLibValue();
        reloadStyles();
      });
      loadStyleFavs().then(() => renderStyleCards(styleItemsCache));
      renderMedia();
      renderPrompt();
      paintFeed();
      refreshDomSize();
    },
  };

  loadLibPairs().then(() => {
    migrateLibValue();
    reloadStyles();
  });
  loadStyleFavs().then(() => renderStyleCards(styleItemsCache));
  renderMedia();
  renderPrompt();
  paintFeed();
  refreshDomSize();
}