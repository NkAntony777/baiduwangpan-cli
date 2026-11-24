/**
 * 测试临时目录清理钩子装配（被测试文件 require 即生效）。
 *
 * ⚠ 临时目录纪律（2026-11-24 修，见 docs/tmp-leak-fix.md）
 * ============================================================================
 * 泄漏根因：test/pan.test.js 曾往 **os.tmpdir()（C 盘系统 TEMP）** 丢
 * `mkdtempSync(..., "bdp-pan-out-")`（16 个调用点）与
 * `mkdtempSync(..., "bdp-pan-cfg-")`（1 处）目录，而且**从来没有删除逻辑** ——
 * 不是「异常路径没走 finally」，是压根没写清理。于是每跑一次全量测试就再攒一批
 * （实测 C 盘曾累计 887 个目录 / 7.383 GB）。
 *
 * 三条修法（缺一不可）：
 *   ① **测试结束必删**（正常结束 / 断言失败 / 异常抛出 / 进程提前退出都要删）：
 *      目录登记在册，四道钩子覆盖全部退出路径 ——
 *      afterEach（用例级）/ after（文件级）/ process 'exit' /
 *      SIGINT·SIGTERM·SIGHUP。
 *   ② **临时工作目录不落 C 盘系统 TEMP**：改到**项目内** <repo>/.tmp/（D 盘）。
 *      这是根本修法——即使清理失败也不会撑爆系统盘。
 *   ③ **进程启动时清扫过期残留**：删掉超过 N 小时（默认 6h）的同类旧目录，
 *      防止「上次跑崩了」的残留永久占盘，并落 append-only 对账台账。
 *
 * 目录/文件的实际存取逻辑在 test/tmp-store.js（纯逻辑，无副作用），
 * 本文件只负责：装钩子 + 进程启动清扫。
 */
"use strict";

const test = require("node:test");
const store = require("./tmp-store");

// ① 兜底 A：exit + 三个信号（覆盖进程提前退出 / Ctrl+C / 被 kill）。
// ③ 兜底：启动时清扫超过 N 小时的旧同类临时目录（默认只扫项目内 .tmp/）。
store.bootstrapTempDirs();

// ① 兜底 B：node:test 用例级 + 文件级钩子（覆盖正常结束 / 断言失败 / 异常抛出）。
// 钩子装在被 require 的测试文件上 ⇒ 那里每个用例跑完就删本用例建的临时目录；
// 文件级 "file" 作用域夹具由 after 钩子删（afterEach 不动，避免中途被删掉）。
try {
  test.afterEach(function () {
    store.cleanupTempDirs("test");
  });
  test.after(function () {
    store.cleanupTempDirs("all");
  });
} catch {
  /* 不在 node:test 上下文里（当作普通脚本跑）→ 只靠 exit + 信号钩子兜底 */
}

module.exports = {
  REPO_ROOT: store.REPO_ROOT,
  TMP_ROOT: store.TMP_ROOT,
  STALE_TMP_HOURS: store.STALE_TMP_HOURS,
  TMP_PREFIXES: store.TMP_PREFIXES,
  SWEEP_LEDGER: store.SWEEP_LEDGER,
  SWEEP_SUMMARY: store.SWEEP_SUMMARY,
  cleanupTempDirs: store.cleanupTempDirs,
  liveTempCount: store.liveTempCount,
  sweepStaleTempDirs: store.sweepStaleTempDirs,
  makeTempDir: store.makeTempDir,
  makeTempFile: store.makeTempFile,
  removeTree: store.removeTree,
  bootstrapTempDirs: store.bootstrapTempDirs,
};
