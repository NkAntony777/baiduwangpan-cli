// 并发基准脚本的防退化测试（库式 + CLI 式两种入口都要守）。
//
// 为什么要有：`scripts/bench-concurrency.js` 是「全异步化」的**验收工具** ——
// 它把「并发是否真的生效」变成可复现的数据。如果将来有人又用回同步 spawn，
// 或者基准脚本本身被改坏（比如 `--levels` 解析退化），这里必须先红。
//
// 历史教训：
//   1. `--levels` 曾用 `parseInt("1,4")` 解析 → 恒等于 1 → 曲线只剩一档，
//      而判定条件写的是 `results.length > 1 && …`，单档时直接跳过 FAIL → **静默通过**。
//   2. 脚本此前是纯 CLI（IIFE），测试只能整进程 spawn；现在导出 `runLevel`，
//      可以不起进程直接测曲线。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "bench-concurrency.js");

function runBench(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args), {
    encoding: "utf-8",
    timeout: 120000,
    env: Object.assign({}, process.env, env || {}),
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("并发 spawn 的 4 路墙钟明显小于 4 倍单路（库式入口）", async () => {
  const { runLevel } = require("../scripts/bench-concurrency.js");
  const one = await runLevel(1, 40);
  const four = await runLevel(4, 40);
  assert.ok(four.ticks > 0, "并发期间定时器应触发（同步引擎会是 0）");
  assert.ok(four.ms < one.ms * 3, "4 路 " + Math.round(four.ms) + "ms，单路 " + Math.round(one.ms) + "ms");
});

test("bench:concurrency 能跑通，曲线真的下降（CLI 入口）", () => {
  // 延时取 60ms 而不是 20/30ms：单路基数（8×60=480ms）必须远大于机器噪声，
  // 否则并发跑测试文件时的调度抖动会让「加速比」偶发翻转（实测过 delay=20 会 flaky）。
  const r = runBench(["--calls", "8", "--delay", "60", "--rounds", "1", "--levels", "1,4"]);
  assert.equal(r.status, 0, "基准脚本应以 0 退出，实际 " + r.status + "\n" + r.out.slice(0, 500));
  assert.match(r.out, /OK: 并发生效/, "应输出「OK: 并发生效」");
  assert.match(r.out, /\|\s*1\s*\|\s*\d+ms\s*\|/, "应输出 1 档的耗时");
  assert.match(r.out, /\|\s*4\s*\|\s*\d+ms\s*\|/, "应输出 4 档的耗时");
});

test("bench:concurrency 覆盖外部闸门上限（不受 BDP_MCP_MAX_CONCURRENCY 影响）", () => {
  const r = runBench(["--calls", "8", "--delay", "20", "--rounds", "1", "--levels", "1,4"], {
    BDP_MCP_MAX_CONCURRENCY: "1",
  });
  assert.match(r.out, /闸门上限 = 16/, "脚本应忽略外部 env，自己把闸门抬到 16");
  assert.match(r.out, /\|\s*1\s*\|\s*\d+ms\s*\|/, "应输出 1 档数据");
  assert.match(r.out, /\|\s*4\s*\|\s*\d+ms\s*\|/, "应输出 4 档数据");
  // ⚠️ 这里**不断言退出码**：`node --test` 会并发跑多个测试文件，机器负载会让
  // 「加速比 < 2×」这条性能判定偶发翻转（实测同一份代码一次红一次绿）。
  // 性能结论由上面那条库式用例负责（同进程内比值，稳定得多）；
  // 本条只守「闸门覆盖」与「事件循环没被冻住」这两个确定性事实。
  assert.doesNotMatch(r.out, /FAIL: 有档位的事件循环触发次数为 0/, "并发期间定时器不应为 0");
});

test("bench:concurrency 只有一档时报 FAIL（守住 --levels 解析退化）", () => {
  const r = runBench(["--calls", "8", "--delay", "20", "--rounds", "1", "--levels", "4"]);
  assert.match(r.out, /FAIL: 只测到 1 档/, "单档必须显式 FAIL，实际：\n" + r.out.slice(0, 500));
  assert.equal(r.status, 1, "单档时退出码应为 1");
});
