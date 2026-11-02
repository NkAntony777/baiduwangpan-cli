#!/usr/bin/env node
/**
 * scripts/bench-concurrency.js —— MCP 并发基准（可复现，**不需要真实网盘**）
 *
 * 用法：
 *   npm run bench:concurrency
 *   node scripts/bench-concurrency.js --calls 32 --delay 80 --rounds 3
 *
 * 为什么要有它：
 *   v1.10.0 之前，引擎调用走 spawnSync —— 一次调用就把整个 Node 进程冻住，
 *   MCP 单进程下**所有并发请求排队**，8 并发 4047ms（加速比 1.0×，等于没有并发）。
 *   这个问题靠「读代码」是看不出来的，只能压测。本脚本把这条曲线固化成**可复现的验收**。
 *
 * 设计要点（缺一条数据就没意义）：
 *   1. **mock 引擎**：延迟固定（默认 60ms），数据与网络/账号无关 → 任何人跑都一样。
 *   2. **闸门不能成为瓶颈**：把 BDP_MCP_MAX_CONCURRENCY 抬到 16，否则测的是闸门不是并发。
 *   3. **worker 池**：N 个调用由 level 个 worker 取，这样「并发数」才真的是 level。
 *   4. **同时测事件循环活性**：并发期间 10ms 定时器的触发次数 —— 同步引擎会是 0。
 *   5. **多轮取最小值**：排除 GC/调度抖动。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 参数 ──────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const n = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CALLS = arg("calls", 16);
const DELAY_MS = arg("delay", 60);
const ROUNDS = arg("rounds", 3);
// 注意：--levels 是**逗号列表**，不能走 parseInt（parseInt("1,4") === 1，
// 会把"4 档"整档吃掉，曲线只剩一档，基准就退化成"必然通过"）。
function argRaw(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
const LEVELS = Array.from(
  new Set(
    argRaw("levels", "1,2,4,8")
      .split(",")
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  )
).sort((a, b) => a - b);
if (!LEVELS.length) LEVELS.push(1);

// ── 环境：闸门抬到 16（否则测的是闸门，不是并发）─────────────────────
const GATE = Math.max(16, Math.max.apply(null, LEVELS));
process.env.BDP_MCP_MAX_CONCURRENCY = String(GATE);
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-bench-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "bench", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// ── mock 引擎：固定延迟后吐一张合法的 ls 表 ──────────────────────────
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const TABLE = [
  "  0                     2025-11-26 20:49:09  med/",
  "  1      1.50KB         2025-11-26 20:49:10  med/报告.pdf",
  "",
].join("\n");

// 每次 runLevel 可以覆盖延迟（导出给测试用时按档位设定，别依赖全局常量）
let CURRENT_DELAY = DELAY_MS;

function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.write(TABLE);
    child.stdout.end();
    child.emit("close", 0);
  }, CURRENT_DELAY);
  return child;
}
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, { spawn: fakeSpawn }),
};

// 被当成库 require 时（测试直接调 runLevel）主流程不会跑，临时目录要靠这里清理
process.once("exit", () => {
  try {
    fs.rmSync(TMP_CFG, { recursive: true, force: true });
  } catch {}
});

const mcp = require("../lib/mcp");

// ── 一个 stdio 会话 ──────────────────────────────────────────────────
function openSession() {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  let buf = "";
  output.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  mcp.startServer({ input, output });
  let nextId = 1;
  return {
    call(name, args) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        input.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }) + "\n"
        );
      });
    },
    close() {
      try {
        input.end();
      } catch {}
    },
  };
}

// ── 单个并发档位：level 个 worker 从队列取 CALLS 个调用 ───────────────
async function runLevel(level, delayMs) {
  if (typeof delayMs === "number" && delayMs > 0) CURRENT_DELAY = delayMs;
  const session = openSession();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  const queue = Array.from({ length: CALLS }, (_, i) => i);
  const t0 = process.hrtime.bigint();
  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (job === undefined) return;
      await session.call("bdp_ls", { path: "/" });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(level, CALLS) }, () => worker()));
  } finally {
    clearInterval(timer);
    session.close();
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ticks };
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  console.log("MCP 并发基准（mock 引擎，延迟 " + DELAY_MS + "ms/次）");
  console.log("每次 " + CALLS + " 个 bdp_ls，每档 " + ROUNDS + " 轮取最小值；闸门上限 = " + GATE);
  console.log("");

  const results = [];
  for (const level of LEVELS) {
    let best = Infinity;
    let ticks = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const out = await runLevel(level, DELAY_MS);
      if (out.ms < best) {
        best = out.ms;
        ticks = out.ticks;
      }
    }
    results.push({ level, ms: best, ticks });
  }

  const base = results[0].ms;
  console.log("| 并发数 | 总耗时 | 实测加速比 | 理想耗时 | 事件循环触发 |");
  console.log("|:--|--:|--:|--:|--:|");
  for (const r of results) {
    const speedup = base / r.ms;
    const idealMs = Math.ceil(CALLS / r.level) * DELAY_MS;
    console.log(
      "| " +
        r.level +
        " | " +
        Math.round(r.ms) +
        "ms | " +
        speedup.toFixed(2) +
        "x | " +
        idealMs +
        "ms | " +
        r.ticks +
        " |"
    );
  }
  console.log("");

  const last = results[results.length - 1];
  const speedupAtMax = base / last.ms;
  if (results.length < 2) {
    // 只有一档 = 没有曲线 = 这个脚本什么都不能证明（历史 bug：--levels 被 parseInt 吃掉）
    console.log("FAIL: 只测到 " + results.length + " 档，没有曲线可比 —— 检查 --levels 解析");
    process.exitCode = 1;
  } else if (CALLS > last.level && speedupAtMax < 2) {
    console.log("FAIL: 曲线几乎是平的（加速比 " + speedupAtMax.toFixed(2) + "x < 2x）—— 并发没有生效，检查是否有人又用回了同步 spawn");
    process.exitCode = 1;
  } else {
    console.log("OK: 并发生效（最高档加速比 " + speedupAtMax.toFixed(2) + "x）");
  }
  const zeroTicks = results.filter((r) => r.ticks === 0);
  if (zeroTicks.length) {
    console.log("FAIL: 有档位的事件循环触发次数为 0 —— 引擎调用把事件循环冻住了");
    process.exitCode = 1;
  }

  fs.rmSync(TMP_CFG, { recursive: true, force: true });
}

if (require.main === module) main();

// 供测试直接调用：不必起一个完整进程就能验证「并发曲线真的会降」
module.exports = { runLevel, openSession, DEFAULT_CALLS: CALLS };
