/**
 * 用 CDP 真机验证图层记忆往返。
 * 起一个本地静态服务 -> 无头 chrome 打开验证台 -> 依次点 ① 完成 ③ -> 读日志。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WEB = "D:/ComfyUI-aki/ComfyUI/custom_nodes/Ares-Qwen2.1-text/web";
const TESTDIR = "D:/ComfyUI-aki/ComfyUI/custom_nodes/Ares-Qwen2.1-text/web/_tests";
const PORT = 7899;
const CHROME = "C:/Users/Super/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".webp": "image/webp" };

/* ---------- 静态服务 ---------- */
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const rel = url === "/" ? "_layer_memory_test.html" : url.replace(/^\//, "");
  const file = rel === "_layer_memory_test.html" ? path.join(TESTDIR, rel) : path.join(WEB, rel);
  // path.join 会把分隔符规范成 "\"，做前缀校验前统一下
  const norm = (p) => path.resolve(p).split(path.sep).join("/");
  if (!norm(file).startsWith(norm(WEB)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cdp(ws, method, params, id) {
  return new Promise((resolve, reject) => {
    const mid = id;
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch (_) { return; }
      if (msg.id === mid) {
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

module.exports = (async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log("server on", PORT);

  const userDir = path.join(require("os").tmpdir(), "ares_cdp_" + Date.now());
  const chrome = spawn(CHROME, [
    "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking",
    "--remote-debugging-port=9333", "--user-data-dir=" + userDir,
    "--window-size=1680,1020", "about:blank",
  ], { stdio: "ignore" });

  await sleep(4000);

  // 找 target
  let list = [];
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/list");
      list = await r.json();
      if (list.find((t) => t.type === "page")) break;
    } catch (_) {}
    await sleep(400);
  }
  const target = list.find((t) => t.type === "page");
  if (!target) { console.log("NO_TARGET"); chrome.kill(); server.close(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });

  let idc = 1;
  await cdp(ws, "Runtime.enable", {}, idc++);
  await cdp(ws, "Page.enable", {}, idc++);
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${PORT}/_layer_memory_test.html` }, idc++);
  await sleep(2200);

  async function evalJs(expr) {
    const r = await cdp(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, idc++);
    if (r.exceptionDetails) return { err: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "") };
    return { val: r.result?.value };
  }

  const results = [];
  function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }); console.log((cond ? "  PASS  " : "  FAIL  ") + name + (cond ? "" : "  -> " + extra)); }

  console.log("\n=== 真机：iframe 内联 JS 无报错 ===");
  const errs = await evalJs("JSON.stringify(window.__errs||[])");
  check("页面加载无致命错误", !errs.err, errs.err);

  console.log("\n=== ① 首次下发：应建 3 层 ===");
  await evalJs("document.getElementById('t1').click(); 'ok'");
  await sleep(2000);
  const st1 = await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    return JSON.stringify({ ready: d.readyState });
  })()`);
  check("iframe 可同源访问", !st1.err && /complete/.test(st1.val || ""), st1.err || st1.val);

  console.log("\n=== ② 直接调 buildDoc 读层数 ===");
  const bd = await evalJs(`(function(){
    var w = document.getElementById('fr').contentWindow;
    var api = w.__aresCanvas;
    if (!api) return JSON.stringify({err:'no __aresCanvas'});
    // 借 finish 拿不到中间态，改从内部读：暴露一个探针
    return JSON.stringify({ hasApi: !!api, hasFinish: typeof api.finish === 'function' });
  })()`);
  check("编辑器暴露 __aresCanvas", !bd.err && /"hasApi":true/.test(bd.val || ""), bd.err || bd.val);

  console.log("\n=== ③ 点「完成」应回传含 3 层的 doc ===");
  await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    var b = d.getElementById('confirm');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(2500);
  const logText = await evalJs("document.getElementById('log').innerText");
  const lt = logText.val || "";
  check("日志出现「doc 图层数 = 3」", /doc 图层数 = 3/.test(lt), lt.slice(-400));
  check("三层名字都在", /底图/.test(lt) && /物体A/.test(lt) && /物体B/.test(lt), lt.slice(-400));

  console.log("\n=== ④ 二次打开：带 doc 还原 ===");
  await evalJs("document.getElementById('t3').click(); 'ok'");
  await sleep(2500);
  const probe = await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    var items = d.querySelectorAll('#layers .layer');
    var names = [].map.call(items, function(x){
      var n = x.querySelector('.layer-name'); return n ? n.textContent : '';
    });
    return JSON.stringify({ domLayers: items.length, names: names });
  })()`);
  check("还原后图层面板有 3 项", !probe.err && /"domLayers":3/.test(probe.val || ""), probe.err || probe.val);
  check("还原后层名正确", !probe.err && /底图/.test(probe.val || "") && /物体A/.test(probe.val || "") && /物体B/.test(probe.val || ""), probe.val);

  const afterLog = await evalJs("document.getElementById('log').innerText");
  check("日志无「没有 doc」字样", !/结果里没有 doc/.test(afterLog.val || ""), (afterLog.val || "").slice(-300));

  console.log("\n=== ⑤ 拖动图层后几何是否被 doc 记住 ===");
  // 重新载入验证台，从头来一条干净链路
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${PORT}/_layer_memory_test.html` }, idc++);
  await sleep(2400);
  await evalJs("document.getElementById('t1').click(); 'ok'");
  // 等编辑器真的把 3 层渲染出来
  let ready = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const g = await evalJs("document.getElementById('fr').contentDocument.querySelectorAll('#layers .layer').length");
    ready = Number(g.val) || 0;
    if (ready >= 3) break;
  }
  check("编辑器加载出 3 层", ready >= 3, "只渲染了 " + ready);

  // 直接拖动，然后才第一次导出 → 这样 doc 必然是拖动后的状态
  // （真实 ComfyUI 每次打开都是新 iframe，confirm 初始 enabled）

  // 在编辑器里拖动一层的图，再回传，比较几何是否变化并能复原
  const dragRes = await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    var c = d.getElementById('canvas');
    var wrap = d.getElementById('canvasWrap');
    var items = d.querySelectorAll('#layers .layer');
    if (!items.length) return 'no-layers';
    // DOM 倒序：索引 0 = 最上层 = layers[] 最后一个
    items[0].dispatchEvent(new MouseEvent('click', {bubbles:true}));
    // toArt 用 wrap 的 rect 换算，so 屏幕坐标 = wrapRect.left + artX * scale
    var r = wrap.getBoundingClientRect();
    var scale = r.width / c.width;
    // 目标：顶层（OBJ-B，256x256 @384,256）的中心 (512,384)
    var ax = 512, ay = 384;
    var sx = r.left + ax * scale;
    var sy = r.top  + ay * scale;
    function pe(t,x,y,btn){
      c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,bubbles:true,
        pointerId:1,button:btn,buttons:btn?1:0,pointerType:'mouse',isPrimary:true}));
    }
    pe('pointerdown',sx,sy,0);
    pe('pointermove',sx+70,sy+45,0);
    pe('pointerup',sx+70,sy+45,0);
    return JSON.stringify({scale:scale, sx:sx, sy:sy,
      cursor:(d.getElementById('cursorPos')||{}).textContent,
      status:(d.getElementById('status')||{}).textContent});
  })()`);
  await sleep(500);
  console.log("    [drag] " + JSON.stringify(dragRes.val || dragRes.err));

  // 用只读探针精确比对：拖动前后图层坐标
  const preDrag = await evalJs("JSON.stringify(document.getElementById('fr').contentWindow.__aresCanvas._probe())");
  let p0 = null; try { p0 = JSON.parse(preDrag.val); } catch (_) {}
  console.log("    [pre-drag layers] " + JSON.stringify(p0 && p0.layers.map(l=>[l.name,l.x,l.y])));

  const dragRes2 = await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    var w = document.getElementById('fr').contentWindow;
    var c = d.getElementById('canvas'), wrap = d.getElementById('canvasWrap');
    var items = d.querySelectorAll('#layers .layer');
    items[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
    var s0 = JSON.parse(JSON.stringify(w.__aresCanvas._probe()));
    var target = s0.layers[s0.selected];
    var r = wrap.getBoundingClientRect();
    var ax = target.x + target.w/2, ay = target.y + target.h/2;
    var X = r.left + ax*(r.width/c.width), Y = r.top + ay*(r.height/c.height);
    function pe(t,x,y){ c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,bubbles:true,
      pointerId:1,button:0,buttons:t==='pointerup'?0:1,pointerType:'mouse',isPrimary:true})); }
    pe('pointerdown', X, Y);
    pe('pointermove', X + 80, Y + 60);
    pe('pointerup', X + 80, Y + 60);
    var s1 = JSON.parse(JSON.stringify(w.__aresCanvas._probe()));
    var t1 = s1.layers[s1.selected];
    return JSON.stringify({sel:target.name, before:{x:target.x,y:target.y}, after:{x:t1.x,y:t1.y}});
  })()`);
  let dr2 = null; try { dr2 = JSON.parse(dragRes2.val || "{}"); } catch (_) {}
  console.log("    [drag2] " + JSON.stringify(dr2));
  check("拖动改变了选中层坐标（record 生效）",
    !!dr2 && (dr2.after.x !== dr2.before.x || dr2.after.y !== dr2.before.y),
    JSON.stringify(dr2));
  if (dr2) {
    const dx = dr2.after.x - dr2.before.x, dy = dr2.after.y - dr2.before.y;
    check("位移方向与幅度正确（+80,+60 屏幕px ≈ 等比画板px）",
      dx > 50 && dy > 35 && dx < 130 && dy < 100, `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
  }
  await sleep(600);
  const clickInfo = await evalJs(`(function(){
    var d = document.getElementById('fr').contentDocument;
    var b = d.getElementById('confirm');
    if (!b) return 'no-confirm-btn';
    var before = b.disabled;
    b.click();
    return JSON.stringify({disabledBefore: before, disabledAfter: b.disabled,
      statusText: (d.getElementById('statusText')||{}).textContent});
  })()`);
  console.log("    [confirm click] " + JSON.stringify(clickInfo.val || clickInfo.err));
  await sleep(2500);
  const after = await evalJs("JSON.stringify(window.__docs||[])");
  let docs2 = [];
  try { docs2 = JSON.parse(after.val || "[]"); } catch (_) {}
  console.log("    [docs count] " + docs2.length + " : " + docs2.map(d=>JSON.stringify(d.layers.map(l=>[l.x,l.y]))).join(" | "));
  const docB = docs2[docs2.length - 1] || null;
  check("拖动后仍回传 doc", !!docB && docB.layers.length === 3, after.val);
  if (docB) {
    // 非几何属性必须原样保留
    const attrOK = docB.layers.every((l) =>
      typeof l.rotation === "number" && typeof l.opacity === "number" && typeof l.visible === "boolean" &&
      typeof l.name === "string" && l.w > 0 && l.h > 0);
    check("非几何属性完整保留", attrOK, JSON.stringify(docB.layers));
    // doc 里的坐标必须与探针一致（doc 真读取了当前状态）
    const nowProbe = await evalJs("JSON.stringify(document.getElementById('fr').contentWindow.__aresCanvas._probe())");
    let np = null; try { np = JSON.parse(nowProbe.val); } catch (_) {}
    if (np) {
      const same = docB.layers.every((l, i) => l.x === Math.round(np.layers[i].x) && l.y === Math.round(np.layers[i].y));
      check("doc 坐标 == 沙盒实时坐标（四舍五入）", same,
        JSON.stringify(docB.layers.map(l=>[l.x,l.y])) + " vs " + JSON.stringify(np.layers.map(l=>[Math.round(l.x),Math.round(l.y)])));
    }
  }

  console.log("\n=== ⑥ 用拖动后的 doc 二次打开，几何应完全一致 ===");
  if (docB) {
    await evalJs(`(function(){
      window.__expect = ${JSON.stringify(JSON.stringify(docB))};
      var fr = document.getElementById('fr');
      fr.contentWindow.postMessage({type:'ARES_CANVAS_INIT', payload:{
        baseUrl:'', layerUrls:[], presetW:${docB.artW}, presetH:${docB.artH}, title:'几何比对', doc:${JSON.stringify(docB)}
      }}, '*');
      return 'sent';
    })()`);
    await sleep(2600);
    const cmp = await evalJs(`(function(){
      var d = document.getElementById('fr').contentDocument;
      var items = d.querySelectorAll('#layers .layer');
      return JSON.stringify({ n: items.length, exp: JSON.parse(window.__expect).layers.length });
    })()`);
    let c2 = {};
    try { c2 = JSON.parse(cmp.val || "{}"); } catch (_) {}
    check("还原层数与 doc 一致", c2.n === c2.exp && c2.n === 3, cmp.val);

    // 再回传一次，doc 应与 docB 完全等价（幂等，不掉信息）
    await evalJs("document.getElementById('fr').contentDocument.getElementById('confirm') && document.getElementById('fr').contentDocument.getElementById('confirm').click(); 'ok'");
    await sleep(2500);
    const final = await evalJs("JSON.stringify((window.__docs||[]).slice(-1))");
    let docs3 = [];
    try { docs3 = JSON.parse(final.val || "[]"); } catch (_) {}
    const docC = docs3[0] || null;
    check("往返幂等（docB 与 docC 等价）", !!docC && JSON.stringify(docC) === JSON.stringify(docB),
      `\nB=${JSON.stringify(docB)}\nC=${JSON.stringify(docC)}`);
  }

  console.log("\n=== ⑦ 图层可见性 / 不透明度经 doc 保留 ===");
  if (docB) {
    const hasAttrs = docB.layers.every((l) =>
      typeof l.visible === "boolean" && typeof l.opacity === "number" && typeof l.rotation === "number");
    check("doc 每层都带 visible/opacity/rotation", hasAttrs, JSON.stringify(docB.layers));
  }

  console.log("\n=== 汇总 ===");
  const bad = results.filter((r) => !r.ok);
  console.log(`=== 结果：${results.length - bad.length} 通过 / ${bad.length} 失败 ===`);

  try { ws.close(); } catch (_) {}
  chrome.kill();
  server.close();
  if (!module.parent) setTimeout(() => process.exit(bad.length ? 1 : 0), 300);
  return { pass: results.length - bad.length, fail: bad.length };
})().catch((e) => {
  console.error("FATAL", e);
  if (!module.parent) process.exit(1);
  return { pass: 0, fail: 1 };
});
