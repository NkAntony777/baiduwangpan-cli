// T-04 续：并发上限由 BDP_MCP_MAX_CONCURRENCY 控制（stdio 与 HTTP 共用同一个值）。
//
// 单独一个文件是因为 MAX_CONCURRENT_TOOLS 在 lib/mcp.js **模块加载时**读取环境变量 ——
// 想测另一个档位就必须换一个进程。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const LIMIT = 2;
process.env.BDP_MCP_MAX_CONCURRENCY = String(LIMIT);

const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-concenv-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const DELAY_MS = 60;

let live = 0;
let maxLive = 0;

function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
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

test("T-04: BDP_MCP_MAX_CONCURRENCY 生效（stdio 同样受限）", async () => {
  const N = 8;
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
  for (let i = 1; i <= N; i++) {
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
  while (Date.now() < deadline && replies.filter((r) => r.id !== undefined).length < N) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(replies.filter((r) => r.id !== undefined).length, N, "应收到全部响应");
  assert.ok(
    maxLive <= LIMIT,
    "同时存活的引擎进程应 ≤ " + LIMIT + "（BDP_MCP_MAX_CONCURRENCY），实际 " + maxLive
  );
});
