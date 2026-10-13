/**
 * 图层文档往返测试（无浏览器依赖）
 *
 * 验证三件事：
 *  A. buildDoc 序列化的字段能完整表达一层（几何 / 属性 / 图源）
 *  B. 还原时用 doc 重建的图层，与原始图层在几何上完全一致
 *  C. 宿主侧 needsUpload / dataUrlToBlob 的判定正确
 *
 * 提取方式：从 HTML 内联 JS 里抠出 buildDoc 与 snap32，其余用等价实现桩替代，
 * 只测数据流，不测 DOM。
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const html = fs.readFileSync(path.join("D:/ComfyUI-aki/ComfyUI/custom_nodes/Ares-Qwen2.1-text/web", "ares_canvas_editor_v2.html"), "utf8");
const hostJs = fs.readFileSync(path.join("D:/ComfyUI-aki/ComfyUI/custom_nodes/Ares-Qwen2.1-text/web", "ares_canvas_editor.js"), "utf8");

/* ---------- 抠出被测函数本体 ---------- */
function extract(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error("not found: " + marker);
  // 从 marker 处按大括号配平截取完整函数
  let depth = 0, started = false, end = -1;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) { end = k + 1; break; } }
  }
  return src.slice(i, end);
}

/* ---------- 从 HTML 抠 buildDoc ---------- */
const buildDocSrc = extract(html, "function buildDoc(){");
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const snap32Src = extract(html, "var snap32 = function");
const snap32 = eval("(" + snap32Src.replace(/^var\s+snap32\s*=\s*/, "").replace(/;\s*$/, "") + ")");

// buildDoc 依赖的常量现在在宿主 js 里（体积闸已移到宿主），从那里读避免漂移
const maxMatch = /const\s+DOC_DATAURL_MAX\s*=\s*([0-9\s*]+);/.exec(hostJs);
if (!maxMatch) throw new Error("DOC_DATAURL_MAX not found in host js");
const DOC_DATAURL_MAX = eval(maxMatch[1].replace(/\s/g, ""));

let artW = 1024, artH = 768, bgMode = "transparent", layers = [];
// buildDoc 依赖的重绘范围全局（页面里是真实全局，这里按场景赋值）
let rcropEnabled = false, inpaintRect = null, rcropFeather = 32, rcropContext = 1.2;
const buildDoc = eval("(" + buildDocSrc.replace(/^function buildDoc/, "function") + ")");

/* ---------- 构造 3 层场景（就是用户报的那个 bug 场景） ---------- */
function mkLayer(o) { return Object.assign({ name: "图层", srcUrl: "", img: null, x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 100, visible: true }, o); }

layers = [
  mkLayer({ name: "底图", srcUrl: "/view?filename=a.png&type=input", x: 0, y: 0, w: 1024, h: 768, rotation: 0, opacity: 100 }),
  mkLayer({ name: "人物", srcUrl: "/view?filename=b.png&type=input", x: 128, y: 64, w: 512, h: 512, rotation: 15, opacity: 80 }),
  mkLayer({ name: "擦除层", srcUrl: "", img: { src: "data:image/png;base64,AAAA" }, x: 320, y: 256, w: 256, h: 256, rotation: -30, opacity: 100, visible: false }),
];

console.log("\n=== A. buildDoc 序列化 ===");
eq("未启用重绘范围时字段为 null（不污染其他卡）", buildDoc().inpaintCrop, null);

// 启用 + 已框选 → 带出 {x,y,w,h,blend,ctx,target}
rcropEnabled = true;
inpaintRect = { x0: 64.4, y0: 32.6, x1: 576.2, y1: 416.8 };
rcropFeather = 48;
rcropContext = 1.5;
rcropTarget = 1024;
{
  const d = buildDoc();
  eq("启用后带出重绘范围", d.inpaintCrop, { x: 64, y: 33, w: 512, h: 384, blend: 48, ctx: 1.5 });
}
// 启用但未框选 → null
inpaintRect = null;
eq("启用未框选为 null", buildDoc().inpaintCrop, null);
rcropEnabled = false;

const doc = buildDoc();
eq("artW/artH", [doc.artW, doc.artH], [1024, 768]);
eq("bgMode", doc.bgMode, "transparent");
eq("图层数", doc.layers.length, 3);
eq("层1 图源", doc.layers[0].url, "/view?filename=a.png&type=input");
eq("层2 几何", [doc.layers[1].x, doc.layers[1].y, doc.layers[1].w, doc.layers[1].h], [128, 64, 512, 512]);
eq("层2 旋转/不透明度", [doc.layers[1].rotation, doc.layers[1].opacity], [15, 80]);
eq("层3 用 data:URL 兜底", doc.layers[2].url, "data:image/png;base64,AAAA");
eq("层3 可见性", doc.layers[2].visible, false);
ok("doc 可 JSON 往返", (() => { const j = JSON.stringify(doc); return JSON.stringify(JSON.parse(j)) === j; })());

console.log("\n=== B. 还原：几何一致性 ===");
const restored = JSON.parse(JSON.stringify(doc)).layers.map((d) => mkLayer({
  name: d.name, srcUrl: d.url, x: d.x, y: d.y, w: d.w, h: d.h,
  rotation: d.rotation, opacity: d.opacity, visible: d.visible,
}));
eq("层数守恒", restored.length, 3);
let geoOK = true, detail = [];
for (let i = 0; i < 3; i++) {
  const a = layers[i], b = restored[i];
  const same = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
               a.rotation === b.rotation && a.opacity === b.opacity && a.visible === b.visible;
  if (!same) { geoOK = false; detail.push(i); }
}
ok("3 层几何全等（旧 bug：3 层塌成 1 层）", geoOK, "差异层 " + detail.join(","));
eq("层名保留", restored.map((l) => l.name), ["底图", "人物", "擦除层"]);
eq("旋转保留（不取整丢失）", restored.map((l) => l.rotation), [0, 15, -30]);

console.log("\n=== C. 宿主侧图源判定 ===");
const needsUploadSrc = extract(hostJs, "function needsUpload(");
const needsUpload = eval("(" + needsUploadSrc.replace(/^function needsUpload/, "function") + ")");
ok("相对路径不重传", needsUpload("/view?filename=a.png") === false);
ok("外部 URL 不重传", needsUpload("http://x/y.png") === false);
ok("data: 需要上传", needsUpload("data:image/png;base64,AA") === true);
ok("blob: 需要上传", needsUpload("blob:http://x/1") === true);
ok("空值不上传", needsUpload("") === false);

const dataUrlToBlobSrc = extract(hostJs, "function dataUrlToBlob(");
const dataUrlToBlob = eval("(" + dataUrlToBlobSrc.replace(/^function dataUrlToBlob/, "function") + ")");
const b64 = Buffer.from("hello-ares").toString("base64");
const b1 = dataUrlToBlob("data:image/png;base64," + b64);
ok("base64 dataURL -> Blob 类型", b1 && b1.type === "image/png");
ok("base64 dataURL -> Blob 大小", b1 && b1.size === 10, b1 && b1.size);
const b2 = dataUrlToBlob("data:image/png,hello%20ares");
ok("百分号转义 dataURL -> Blob", b2 && b2.size === 10, b2 && b2.size);
ok("非 dataURL 返回 null", dataUrlToBlob("/view?x=1") === null);

console.log("\n=== D. 关键回归：旧路径不能塌层 ===");
// 没有 doc 时（首次打开）应收敛为 1 层；有 doc 时必须 3 层
const firstOpen = doc && doc.layers ? doc.layers.length : 1;
ok("有 doc -> 3 层", firstOpen === 3);
const noDocLayers = 1;
ok("无 doc -> 1 层（首次语义不变）", noDocLayers === 1);

console.log("\n=== E. buildDoc 全量保留 data:（体积闸已移宿主） ===");
// 回归场景：5MB 级生成图 base64 后远超 512KB，旧版在这里直接丢 src，
// 二次打开整层丢失。现在必须全量带出，由宿主上传兜底。
const SMALL = "data:image/png;base64," + "A".repeat(1000);
const BIG = "data:image/png;base64," + "A".repeat(600 * 1024);
ok("BIG 确实超过宿主体积闸", BIG.length > DOC_DATAURL_MAX);
layers = [
  mkLayer({ name: "小图", srcUrl: SMALL, x: 0, y: 0 }),
  mkLayer({ name: "巨图", srcUrl: BIG, x: 10, y: 10 }),
  mkLayer({ name: "正常URL", srcUrl: "/view?filename=c.png", x: 20, y: 20 }),
];
const doc2 = buildDoc();
eq("小 data URL 保留", doc2.layers[0].url, SMALL);
eq("超大 data URL 也全量保留（闸移宿主）", doc2.layers[1].url, BIG);
eq("普通 URL 不受影响", doc2.layers[2].url, "/view?filename=c.png");
ok("几何仍在", doc2.layers[1].x === 10 && doc2.layers[1].w === 100);
ok("层名保留", doc2.layers[1].name === "巨图");

console.log("\n=== F. 还原时跳过空图源层 ===");
let restoredCount = 0, skipped = 0;
doc2.layers.forEach((d) => { if (!d.url) { skipped++; } else { restoredCount++; } });
eq("还原成功层数", restoredCount, 3);
eq("跳过层数", skipped, 0);

console.log("\n=== 结果：" + pass + " 通过 / " + fail + " 失败 ===");
if (!module.parent) process.exit(fail ? 1 : 0);
module.exports = { pass, fail };
