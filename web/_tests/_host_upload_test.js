/**
 * 宿主侧 normalizeDocSources 端到端验证。
 * 起一个假 ComfyUI /upload/image 服务，喂一个含 data: URL 的 doc，
 * 断言：data: 被换成相对路径、已有路径不重传、失败时保留原值不抛。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + "  -> " + extra); } }

const hostJs = fs.readFileSync(path.join("D:/ComfyUI-aki/ComfyUI/custom_nodes/Ares-Qwen2.1-text/web", "ares_canvas_editor.js"), "utf8");

  function extract(src, marker) {
    const i = src.indexOf(marker);
    if (i < 0) throw new Error("not found: " + marker);
    // 保留 async 关键字（marker 是从 function 开始的）
    let start = i;
    if (src.slice(Math.max(0, i - 6), i) === "async ") start = i - 6;
    let depth = 0, started = false, end = -1;
    for (let k = i; k < src.length; k++) {
      const ch = src[k];
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; if (started && depth === 0) { end = k + 1; break; } }
    }
    return src.slice(start, end);
  }

/* ---------- 假 ComfyUI 后端 ---------- */
let uploads = [];
let lastBody = Buffer.alloc(0);
let failNext = false;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/upload/image") && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => { chunks.push(c); });
    req.on("end", () => {
      lastBody = Buffer.concat(chunks);
      if (failNext) { res.writeHead(500); res.end('{"error":"boom"}'); return; }
      uploads.push(lastBody.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: `up_${uploads.length}.png`, subfolder: "ares", type: "input" }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

/* ---------- 在假环境里 eval 宿主函数 ---------- */
async function main() {
  const PORT = 7898;
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const base = `http://127.0.0.1:${PORT}`;

  // 桩：api.fetchApi 指到假后端；Blob / atob / fetch 用 Node 原生
  const api = {
    fetchApi: (u, o) => fetch(base + u, o),
  };
  const maxMatch = /const\s+DOC_DATAURL_MAX\s*=\s*([0-9\s*]+);/.exec(hostJs);
  if (!maxMatch) throw new Error("DOC_DATAURL_MAX not found in host js");
  const DOC_DATAURL_MAX = eval(maxMatch[1].replace(/\s/g, ""));
  const sandbox = { api, Blob, atob, Uint8Array, fetch, FormData, console, DOC_DATAURL_MAX, URLSearchParams };

  const names = ["dataUrlToBlob", "urlToBlob", "uploadBlob", "needsUpload", "viewPath", "normalizeDocSources"];
  let code = "'use strict';\n";
  for (const n of names) code += extract(hostJs, "function " + n + "(") + "\n";
  code += "return { dataUrlToBlob, urlToBlob, uploadBlob, needsUpload, normalizeDocSources };";
  const fn = new Function(...Object.keys(sandbox), code);
  const H = fn(...Object.values(sandbox));

  const b64 = Buffer.from("some-image-bytes-here").toString("base64");

  console.log("\n=== A. 已有路径不重传 ===");
  uploads = [];
  let doc = { artW: 1024, artH: 768, layers: [
    { url: "/view?filename=a.png&type=input", name: "底图", x: 0, y: 0, w: 1024, h: 768 },
    { url: "ares/up_9.png", name: "层2", x: 10, y: 10, w: 100, h: 100 },
  ] };
  const r1 = await H.normalizeDocSources(doc);
  ok("没有触发任何上传", uploads.length === 0, "uploads=" + uploads.length);
  ok("原 url 未被改写", r1.layers[0].url === "/view?filename=a.png&type=input" && r1.layers[1].url === "ares/up_9.png",
     JSON.stringify(r1.layers.map(l=>l.url)));

  console.log("\n=== B. data: URL 被上传并替换 ===");
  uploads = [];
  doc = { artW: 512, artH: 512, layers: [
    { url: "/view?filename=a.png", name: "底图", x: 0, y: 0, w: 512, h: 512 },
    { url: "data:image/png;base64," + b64, name: "擦除层", x: 20, y: 20, w: 200, h: 200 },
  ] };
  const r2 = await H.normalizeDocSources(doc);
  ok("触发 1 次上传", uploads.length === 1, "uploads=" + uploads.length);
  // 上传体会是 multipart，里面必须含原始字节 + 文件名
  const bodyStr = lastBody.toString("latin1");
  ok("上传体含原始字节", bodyStr.indexOf("some-image-bytes-here") >= 0, "len=" + lastBody.length);
  ok("上传体带 filename", /filename="ares_layer_\d+_1\.png"/.test(bodyStr), bodyStr.slice(0, 200));
  ok("上传体带 overwrite=true", bodyStr.indexOf("true") >= 0);
  ok("data: 被换成带参数的 /view URL（裸路径当 img.src 会 404）",
     r2.layers[1].url === "/view?filename=up_1.png&type=input&subfolder=ares", r2.layers[1].url);
  ok("补上了 type/subfolder", r2.layers[1].type === "input" && r2.layers[1].subfolder === "ares",
     JSON.stringify({t:r2.layers[1].type, s:r2.layers[1].subfolder}));
  ok("已有路径不受影响", r2.layers[0].url === "/view?filename=a.png");
  ok("非图源字段保留", r2.layers[1].name === "擦除层" && r2.layers[1].x === 20);

  console.log("\n=== C. 多张 data: 全部上传 ===");
  uploads = [];
  doc = { artW: 256, artH: 256, layers: [
    { url: "data:image/png;base64," + b64, name: "A", x: 0, y: 0, w: 1, h: 1 },
    { url: "blob:http://x/1", name: "B", x: 0, y: 0, w: 1, h: 1 },
    { url: "/view?filename=c.png", name: "C", x: 0, y: 0, w: 1, h: 1 },
  ] };
  // blob: URL 在 Node 里 fetch 会失败 → 应被 catch 吞掉、保留原值
  const r3 = await H.normalizeDocSources(doc);
  ok("data: 已上传且为带参数 /view", /^\/view\?filename=up_\d+\.png&type=input&subfolder=ares$/.test(r3.layers[0].url), r3.layers[0].url);
  ok("blob: 抓取失败但保留原值不抛", r3.layers[1].url === "blob:http://x/1", r3.layers[1].url);
  ok("普通路径跳过", r3.layers[2].url === "/view?filename=c.png");

  console.log("\n=== D. 上传失败不阻断 ===");
  uploads = [];
  failNext = true;
  doc = { artW: 128, artH: 128, layers: [
    { url: "data:image/png;base64," + b64, name: "X", x: 0, y: 0, w: 1, h: 1 },
    { url: "data:image/png;base64," + b64, name: "Y", x: 0, y: 0, w: 1, h: 1 },
  ] };
  let threw = false;
  let r4 = null;
  try { r4 = await H.normalizeDocSources(doc); } catch (e) { threw = true; }
  failNext = false;
  ok("没有抛异常", !threw);
  ok("失败层保留 data: 原值（小图不设闸）", r4 && r4.layers[0].url.indexOf("data:") === 0, r4 && r4.layers[0].url.slice(0, 30));
  ok("第二层仍尝试处理（不短路）", r4 && r4.layers[1] && r4.layers[1].name === "Y");

  console.log("\n=== D2. 上传失败 + 超限 base64 -> 丢图源（体积闸在宿主） ===");
  uploads = [];
  failNext = true;
  const BIGB64 = "data:image/png;base64," + "A".repeat(600 * 1024);
  doc = { artW: 128, artH: 128, layers: [
    { url: BIGB64, name: "巨图", x: 0, y: 0, w: 1, h: 1 },
    { url: "data:image/png;base64," + b64, name: "小图", x: 0, y: 0, w: 1, h: 1 },
  ] };
  r4 = null; threw = false;
  try { r4 = await H.normalizeDocSources(doc); } catch (e) { threw = true; }
  failNext = false;
  ok("没有抛异常", !threw);
  ok("超限层 url 被置空（几何仍留着）", r4 && r4.layers[0].url === "", r4 && r4.layers[0].url.slice(0, 30));
  ok("超限层名字/几何保留", r4 && r4.layers[0].name === "巨图" && r4.layers[0].x === 0);
  ok("小图层保留 data: 原值", r4 && r4.layers[1].url.indexOf("data:") === 0);

  console.log("\n=== E. 边界 ===");
  ok("null doc 安全", (await H.normalizeDocSources(null)) === null);
  ok("无 layers 安全", (await H.normalizeDocSources({ artW: 1 })).artW === 1);
  ok("空 layers 安全", (await H.normalizeDocSources({ layers: [] })).layers.length === 0);
  ok("空 url 跳过", (() => !H.needsUpload(""))());

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  srv.close();
  if (!module.parent) process.exit(fail ? 1 : 0);
  return { pass, fail };
}

module.exports = main().catch((e) => {
  console.error("FATAL", e);
  if (!module.parent) process.exit(1);
  return { pass: 0, fail: 1 };
});
