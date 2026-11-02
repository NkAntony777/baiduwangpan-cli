const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 隔离配置：写临时 BDP_CONFIG_DIR，pcsPath 指向 mock 认得的名字 ──
// （与 test/pan.test.js 同一手法：pcsPath 必须是 "BaiduPCS-Go"，
//   mock 才会拦截；写绝对路径会被 mock 放行给真实引擎）
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-async-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// ── Mock child_process（pan.js 惰性 require）──────────────────────
// 目的：验证**异步引擎执行**真的重叠，而不是排队串行。
// mock 的 spawn 延迟 DELAY_MS 后才 emit('close') ——
// 若实现退回同步，4 次并发会耗时 ≈ 4×DELAY；重叠时应接近 1×DELAY。
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const DELAY_MS = 120;

const ENGINE_TABLE = [
  "  0                     2025-11-26 20:49:09  med/",
  "  1      1.50KB         2025-11-26 20:49:10  med/报告.pdf",
  "",
].join("\n");

// 引擎错误输出（模拟百度侧返回错误）：失败判定只看文本，不看退出码
const ENGINE_ERROR = "遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件不存在\n";

let spawnCalls = 0;
let mockOutput = ENGINE_TABLE;
function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
  spawnCalls++;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setTimeout(() => {
    child.stdout.write(mockOutput);
    child.stdout.end();
    child.emit("close", 0); // 引擎出错时退出码仍是 0 —— 必须靠文本判定
  }, DELAY_MS);
  return child;
}
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, { spawn: fakeSpawn }),
};

const pan = require("../lib/pan");

test.after(() => {
  delete require.cache[cpPath];
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

// ── 异步契约 ──────────────────────────────────────────────────────
test("pan.lsEntries / searchEntries 返回 Promise（不再是同步阻塞）", async () => {
  assert.equal(typeof pan.lsEntries, "function");
  const p = pan.lsEntries("/");
  assert.ok(p && typeof p.then === "function", "lsEntries 必须返回 Promise");
  await p;
});

test("pan.ls / pan.search 返回 Promise", async () => {
  const a = pan.ls("/");
  const b = pan.search("x", "/");
  assert.ok(a && typeof a.then === "function");
  assert.ok(b && typeof b.then === "function");
  await Promise.all([a, b]);
});

// ── 并发必须真的重叠 ─────────────────────────────────────────────
test("4 个并发 lsEntries 的耗时应接近 1 次，而不是 4 次", async () => {
  spawnCalls = 0;
  const t0 = Date.now();
  const rs = await Promise.all([
    pan.lsEntries("/"),
    pan.lsEntries("/"),
    pan.lsEntries("/"),
    pan.lsEntries("/"),
  ]);
  const wall = Date.now() - t0;
  assert.equal(spawnCalls, 4, "应起了 4 个引擎进程");
  assert.equal(rs.length, 4);
  // 串行下界是 4×DELAY_MS；重叠时应明显小于 3×DELAY
  assert.ok(
    wall < DELAY_MS * 3,
    "并发未重叠：耗时 " + wall + "ms，期望 < " + DELAY_MS * 3 + "ms（串行会是 " + DELAY_MS * 4 + "ms）"
  );
});

test("并发调用期间事件循环仍能转动（不再被冻结）", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  await Promise.all([pan.lsEntries("/"), pan.lsEntries("/"), pan.lsEntries("/")]);
  clearInterval(timer);
  assert.ok(ticks > 0, "并发期间定时器应至少触发一次（同步引擎会一次都触发不了）");
});

// ── 输出契约不变 ──────────────────────────────────────────────────
test("异步版 lsEntries 的解析结果与同步版一致", async () => {
  mockOutput = ENGINE_TABLE;
  const info = await pan.lsEntries("/");
  assert.equal(info.path, "/");
  assert.equal(info.entries.length, 2);
  const e = info.entries[0];
  for (const k of ["index", "name", "path", "isDir", "sizeText", "size", "mtimeText", "mtime"]) {
    assert.ok(k in e, "entries 缺字段: " + k);
  }
  assert.equal(e.name, "med");
  assert.equal(e.isDir, true);
  assert.equal(e.path, "/med/");
  assert.equal(e.mtimeText, "2025-11-26 20:49:09");
  const f = info.entries[1];
  assert.equal(f.isDir, false);
  // name 保留引擎给出的相对路径（既有语义：ls 的 name 是目录内相对路径，不是纯文件名）
  assert.equal(f.name, "med/报告.pdf");
  assert.equal(f.path, "/med/报告.pdf");
  assert.equal(f.sizeText, "1.50KB");
  assert.equal(f.size, 1536);
});

test("异步版 searchEntries 解析结果正确", async () => {
  mockOutput = ENGINE_TABLE;
  const info = await pan.searchEntries("报告", "/", { mode: "substring" });
  assert.equal(info.keyword, "报告");
  assert.equal(info.mode, "substring");
  assert.equal(info.entries.length, 2);
  // search 的 name 取路径末段；末段为空（目录以 / 结尾）时回退为整串（既有语义）
  assert.equal(info.entries[0].name, "med/");
  assert.equal(info.entries[1].name, "报告.pdf");
});

// ── 失败语义不变：引擎出错仍按文本判定（退出码是 0）────────────────
test("异步版：引擎错误文本仍被识别为失败（errno 正确）", async () => {
  mockOutput = ENGINE_ERROR;
  await assert.rejects(
    () => pan.lsEntries("/"),
    (err) => {
      assert.equal(err.errno, 31066, "errno 应从引擎文本解析出来");
      assert.ok(/31066|文件不存在/.test(err.message));
      return true;
    }
  );
  mockOutput = ENGINE_TABLE;
});
