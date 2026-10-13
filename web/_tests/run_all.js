/**
 * Ares 画布编辑器 · 图层记忆测试总入口
 *
 *   node run_all.js [套件名]
 *   node run_all.js                 # 全部
 *   node run_all.js cdp             # 只跑真机
 *
 * 三套：
 *  doc     _doc_roundtrip_test.js  纯逻辑：doc 序列化 / 还原 / 体积闸
 *  host    _host_upload_test.js    宿主上传：data:URL 归一化 / 失败兜底
 *  cdp     _cdp_test.js            真机：iframe 往返 / 拖动记录 / 幂等
 *
 * 说明：沙箱里 spawnSync 嵌套起 node 会 EBUSY（系统 node 一样），
 * 所以同进程 require。各套件已改成"被 require 时返回 {pass,fail} 而不 exit"，
 * 且都打印 `=== 结果：N 通过 / M 失败 ===` 供本文件解析。
 */
const path = require("path");

const suites = [
  ["doc", "纯逻辑 doc 序列化/还原/体积闸", "_doc_roundtrip_test.js"],
  ["host", "宿主上传 data:URL 归一化", "_host_upload_test.js"],
  ["cdp", "真机 iframe 往返/拖动/幂等", "_cdp_test.js"],
];

const want = (process.argv[2] || "").toLowerCase();
const chosen = want ? suites.filter((s) => s[0] === want || s[2].includes(want)) : suites;

if (!chosen.length) {
  console.log("未知套件：" + want);
  console.log("可选：" + suites.map((s) => s[0]).join(" / "));
  process.exit(2);
}

const all = [];
const realExit = process.exit.bind(process);

async function runOne(tag, label, file) {
  console.log(`\n──── ${tag} · ${label} (${file}) ────`);
  const buf = [];
  const origLog = console.log;
  console.log = (...a) => { buf.push(a.join(" ")); };
  let thrown = null;
  let reported = null;
  try {
    const mod = path.join(__dirname, file);
    delete require.cache[require.resolve(mod)];
    reported = await require(mod);
    // 异步套件返回 Promise，await 到它真正跑完
    if (reported && typeof reported.then === "function") reported = await reported;
  } catch (e) {
    thrown = e;
  } finally {
    console.log = origLog;
  }

  const text = buf.join("\n");
  let pass = reported && typeof reported.pass === "number" ? reported.pass : null;
  let fail = reported && typeof reported.fail === "number" ? reported.fail : null;
  if (pass === null) {
    const m = text.match(/结果：(\d+) 通过 \/ (\d+) 失败/);
    pass = m ? Number(m[1]) : 0;
    fail = m ? Number(m[2]) : 1;
  }
  if (thrown) fail = fail || 1;

  console.log(`  ${pass} 通过 / ${fail} 失败`);
  text.split("\n").filter((l) => /FAIL |FATAL/.test(l)).slice(0, 12)
    .forEach((l) => console.log("  " + l.trim()));
  if (thrown) console.log("  异常：" + thrown.message);
  all.push({ tag, pass, fail });
}

(async () => {
  for (const s of chosen) await runOne(...s);

  console.log("\n════════ 汇总 ════════");
  let tp = 0, tf = 0;
  for (const s of all) {
    tp += s.pass; tf += s.fail;
    console.log(`  ${s.fail === 0 ? "OK  " : "FAIL"}  ${s.tag.padEnd(5)} ${String(s.pass).padStart(3)} / ${s.pass + s.fail}`);
  }
  console.log("  ────────────────────────");
  console.log(`  合计 ${tp} 通过 / ${tf} 失败`);
  console.log(tf === 0 ? "\n全部通过\n" : "\n有失败\n");
  realExit(tf === 0 ? 0 : 1);
})();
