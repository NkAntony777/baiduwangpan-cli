// T-04：stdio 传输也必须有并发闸门（与 HTTP 一致）
//
// 回归背景：闸门自 8e68545 起就只覆盖 HTTP 路径，stdio 完全没有 ——
// 实测 12 个并发 bdp_ls → 12 个同时存活的 BaiduPCS-Go.exe。
// v1.10.0 把 spawnSync 换成 spawn 之后，这个既有缺口第一次真正暴露
// （过去 spawnSync 冻结事件循环，天然把并发压成 1）。
//
// 验收口径：stdio 下 12 个并发 bdp_ls → 同时存活的引擎进程 ≤ 4。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 隔离配置（pcsPath 必须是 "BaiduPCS-Go"，mock 才会拦截）─────────────
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-conc-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// ── Mock 引擎：记录「同时存活」的引擎进程数 ────────────────────────────
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const DELAY_MS = 60;

let spawnCalls = 0;
let live = 0;
let maxLive = 0;

function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
  spawnCalls++;
  live++;
  if (live > maxLive) maxLive = live;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setTimeout(() => {
    live--;
    child.stdout.write("  0   2025-11-26 20:49:09  med/\n");
    child.stdout.end();
    child.emit("close", 0);
  }, DELAY_MS);
  return child;
}
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, { spawn: fakeSpawn }),
};

const mcp = require("../lib/mcp");

test.after(() => {
  delete require.cache[cpPath];
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

// 通过 stdio 传输发 N 个并发工具调用，返回收到的响应
async function runStdioCalls(n) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  let buf = "";
  output.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        replies.push(JSON.parse(line));
      } catch {}
    }
  });
  mcp.startServer({ input, output });
  for (let i = 1; i <= n; i++) {
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "bdp_ls", arguments: { path: "/" } },
      }) + "\n"
    );
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && replies.filter((r) => r.id !== undefined).length < n) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return replies;
}

test("T-04: stdio 传输也有并发闸门（同时存活的引擎进程 ≤ 4）", async () => {
  const N = 12;
  const replies = await runStdioCalls(N);
  assert.equal(replies.filter((r) => r.id !== undefined).length, N, "应收到全部 " + N + " 个响应");
  assert.equal(spawnCalls, N, "应起了 " + N + " 个引擎进程");
  assert.ok(
    maxLive <= 4,
    "同时存活的引擎进程应 ≤ 4（与 HTTP 一致），实际 " + maxLive + " —— stdio 没有闸门"
  );
});

test("T-04: 闸门释放后所有调用都拿到正常结果（没有槽位泄漏）", async () => {
  const replies = await runStdioCalls(12);
  const results = replies.filter((r) => r.result);
  assert.equal(results.length, 12, "12 个调用都应成功返回");
  for (const r of results) {
    assert.equal(r.result.isError, false, "不应是错误响应");
  }
});
