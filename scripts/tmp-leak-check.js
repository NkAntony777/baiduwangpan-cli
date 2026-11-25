#!/usr/bin/env node
/**
 * scripts/tmp-leak-check.js —— 端到端验收：**全量跑完，系统 TEMP 的 bdp-* 增量为 0**。
 *
 * 为什么要有它（2026-11-25 扩族修，见 docs/tmp-leak-fix.md）：
 *   单元测试只能证明「某个文件不往系统 TEMP 写」；
 *   「全量跑完到底有没有新增」这件事只有**在跑之前取一次基线、跑完再取一次**才能回答 ——
 *   这就是本脚本。CI / 本地一条命令即可复现：
 *       npm run test:tmp-leak
 *
 * 口径（三条都要成立才算过）：
 *   ① 系统 TEMP 的 bdp-* 目录计数：**跑前 → 跑后，增量 = 0**（新增集合必须为空）
 *   ② 仓内 <repo>/.tmp/：跑完不许留**未登记前缀**的目录
 *   ③ 全量测试本身：退出码 0
 *
 * 为什么先扫一遍再取基线：
 *   启动清扫（默认开着）会把系统 TEMP 里**超期**的历史残留删掉 —— 那是好事，
 *   但它会让「跑前 → 跑后」出现负增量，掩盖真实结论。先扫一遍再取基线，
 *   基线就稳定了，跑完的增量只反映**本次跑出来的东西**。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const store = require(path.join(ROOT, "test", "tmp-store.js"));

/** 系统 TEMP 里现存的 bdp-* 目录名集合。 */
function systemTempBdpDirs() {
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("bdp-")).map((e) => e.name).sort();
}

/** 仓内 .tmp/ 下未登记前缀的目录（应当为空）。 */
function unregisteredLeftovers() {
  if (!fs.existsSync(store.TMP_ROOT)) return [];
  return fs
    .readdirSync(store.TMP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !store.TMP_PREFIXES.some((p) => name.startsWith(p)))
    .sort();
}

/**
 * 跑一次端到端检查。
 * @param {{quiet?:boolean}} options
 * @returns {{ok:boolean, before:number, after:number, delta:number, added:string[], removed:string[], leftovers:string[], status:number|null}}
 */
function runLeakCheck(options) {
  const opts = options || {};
  const log = (s) => { if (!opts.quiet) console.log(s); };

  // ① 先扫一遍历史残留（超期）—— 让基线稳定，也顺带验证启动清扫本身是通的
  const sweep = store.sweepStaleTempDirs({ legacy: true });
  log("[1/5] 启动清扫：扫 " + sweep.scanned + " 个同族目录，删掉超期残留 " + sweep.removed +
      " 个（失败 " + sweep.failed + "，新鲜保留 " + sweep.fresh + "），阈值 " + sweep.hours + "h");

  // ② 跑前基线
  const before = systemTempBdpDirs();
  log("[2/5] 跑前：系统 TEMP 的 bdp-* 目录 " + before.length + " 个");

  // ③ 全量测试
  const testDir = path.join(ROOT, "test");
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f));
  const env = Object.assign({}, process.env);
  delete env.BDP_TMP_LEAK_FULLRUN; // 防递归：子进程里的闸门测试不许再跑一遍全量
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--test"].concat(files), {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 900000,
    env: env,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = (out.match(/# (pass|fail|skipped|todo) \d+/g) || []).join("  ");
  log("[3/5] 全量测试跑完：exit " + r.status + "，用时 " + secs + "s" + (summary ? "（" + summary + "）" : ""));

  // ④ 跑后
  const after = systemTempBdpDirs();
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  log("[4/5] 跑后：系统 TEMP 的 bdp-* 目录 " + after.length + " 个");

  // ⑤ 仓内残留
  const leftovers = unregisteredLeftovers();
  const delta = after.length - before.length;
  log("[5/5] 仓内 .tmp/ 未登记残留：" + leftovers.length + " 个");

  const ok = r.status === 0 && added.length === 0 && delta === 0 && leftovers.length === 0;
  if (!ok && !opts.quiet) {
    console.log("");
    console.log("❌ 未通过：");
    if (r.status !== 0) console.log("  · 全量测试退出码 " + r.status);
    if (added.length) console.log("  · 系统 TEMP 新增 " + added.length + " 个目录：" + added.join(", "));
    if (delta !== 0) console.log("  · 计数增量 " + delta + "（期望 0）");
    if (leftovers.length) console.log("  · .tmp/ 未登记残留：" + leftovers.join(", "));
    console.log(out.split("\n").slice(-40).join("\n"));
  }
  return { ok: ok, before: before.length, after: after.length, delta: delta, added: added, removed: removed, leftovers: leftovers, status: r.status, summary: summary, seconds: Number(secs) };
}

module.exports = { runLeakCheck: runLeakCheck, systemTempBdpDirs: systemTempBdpDirs, unregisteredLeftovers: unregisteredLeftovers };

if (require.main === module) {
  const result = runLeakCheck({});
  console.log("");
  console.log("系统 TEMP bdp-* 计数：跑前 " + result.before + " → 跑后 " + result.after +
              "，增量 " + result.delta + "（新增 " + result.added.length + " / 消失 " + result.removed.length + "）");
  console.log("仓内 .tmp/ 未登记残留：" + result.leftovers.length + " 个");
  console.log(result.ok ? "✅ 通过：全量跑完系统 TEMP 没有新增任何 bdp-* 目录" : "❌ 未通过（见上）");
  process.exit(result.ok ? 0 : 1);
}
