/**
 * 临时工作目录存储层（**纯逻辑**，无副作用、无 node:test 依赖）。
 *
 * 纪律（2026-11-24 修，见 docs/tmp-leak-fix.md）：
 *   · 临时工作目录一律落**项目内** <repo>/.tmp/（D 盘），**不落系统 TEMP（C 盘）**；
 *   · 每个目录/文件都登记在册，由 tmp-helper.js 的四道钩子（afterEach / after /
 *     process exit / SIGINT·SIGTERM·SIGHUP）在测试结束必删；
 *   · 进程启动时清扫超过 N 小时（默认 6h）的旧同类残留，并落 append-only 对账台账。
 *
 * 历史背景：test/pan.test.js 曾往 os.tmpdir()（C 盘系统 TEMP）丢
 * `mkdtempSync(..., "bdp-pan-out-")` 目录（16 处调用点）与
 * `mkdtempSync(..., "bdp-pan-cfg-")` 配置目录（1 处），
 * 而且**从来没有删除逻辑** —— 不是「异常路径没走 finally」，是压根没写清理。
 * 于是每跑一次全量测试就再攒一批（实测 C 盘曾累计 887 个目录 / 7.383 GB）。
 *
 * 设计取自玄学起盘 CLI 的 docs/034_测试临时目录泄漏修复.md 与
 * slatesync 的 docs/测试临时目录泄漏修复.md（同一套做法，不另发明）——
 * 本文件是那套做法在 CommonJS 仓（baiduwangpan-cli）里的等价实现。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 仓库根目录（本文件在 <repo>/test/ 下）。 */
const REPO_ROOT = path.resolve(__dirname, "..");

/** 临时工作目录根：**项目内**（D 盘），不是系统 TEMP（C 盘）。 */
const TMP_ROOT = path.join(REPO_ROOT, ".tmp");

/** 过期临时目录判定阈值（小时）。 */
const STALE_TMP_HOURS = 6;

/**
 * 本仓已迁移到 .tmp/ 的临时目录前缀。
 * 目录名保持与历史 C 盘残留同名 ⇒ 计数、清扫、判废口径与历史一致，
 * 同一把尺子量「跑前 / 跑后 / 差值」。
 */
const TMP_PREFIXES = ["bdp-pan-out-", "bdp-pan-cfg-"];

/** 台账文件（append-only）与最近一次清扫摘要。 */
const SWEEP_LEDGER = path.join(TMP_ROOT, "sweep-ledger.jsonl");
const SWEEP_SUMMARY = path.join(TMP_ROOT, "sweep-last.json");

/**
 * 本进程登记在册的临时目录/文件。
 * scope = "test"：用例级，afterEach 删；
 * scope = "file"：文件级共享夹具（如整个测试文件共用的配置目录），after 删。
 */
const live = new Set();

let processHooksInstalled = false;

/** 递归删目录；Windows 上被占用会 EPERM/EBUSY，故带重试。 */
function removeTree(dir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return true;
    } catch {
      /* 正在被别人删 / 被占用 → 再试一次 */
    }
  }
  return false;
}

/** 删单个文件（临时文件等）。 */
function removeFile(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 100 });
      return true;
    } catch {
      /* 已删 / 被占用 → 再试一次 */
    }
  }
  return false;
}

/**
 * 删掉本进程登记在册的临时目录与文件，返回删除成功个数。
 * @param {"test"|"file"|"all"} scope 只删某一层；删不掉的留在册上，下一轮重试。
 */
function cleanupTempDirs(scope) {
  const want = scope || "all";
  let removed = 0;
  for (const entry of Array.from(live)) {
    if (want !== "all" && entry.scope !== want) continue;
    const ok = entry.kind === "dir" ? removeTree(entry.path) : removeFile(entry.path);
    if (ok) {
      live.delete(entry);
      removed += 1;
    }
  }
  return removed;
}

/** 本进程还登记在册的临时项数量（给测试/诊断用）。 */
function liveTempCount() {
  return live.size;
}

/** 清扫台账：每删一个目录记一行，便于与并行清理任务对账。 */
function appendSweepLedger(entry) {
  try {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    fs.appendFileSync(SWEEP_LEDGER, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* 台账写不进去不影响清扫结论 */
  }
}

/** 最近一次清扫的摘要（覆盖写）。 */
function writeSweepSummary(result) {
  try {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    fs.writeFileSync(SWEEP_SUMMARY, JSON.stringify(Object.assign({}, result, { ts: new Date().toISOString() }), null, 2), "utf8");
  } catch {
    /* 同上 */
  }
}

function matchesPrefix(name) {
  return TMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 清扫过期临时目录：删掉超过 N 小时（默认 6h）的同类残留。
 *
 * 默认**只扫项目内 .tmp/**。历史 C 盘（os.tmpdir()）那批残留需显式开
 * BDP_SWEEP_LEGACY_TEMP=1 才动 —— 避免与并行清理任务抢删同一批目录、
 * 导致两边对不上账。
 *
 * @param {{hours?:number, legacy?:boolean}} options
 */
function sweepStaleTempDirs(options) {
  const opts = options || {};
  const rawHours = opts.hours != null ? opts.hours : process.env.BDP_TMP_SWEEP_HOURS;
  const hours = Number(rawHours);
  const useHours = Number.isFinite(hours) && hours > 0 ? hours : STALE_TMP_HOURS;
  const cutoff = Date.now() - useHours * 3600_000;
  const legacy = opts.legacy === true || process.env.BDP_SWEEP_LEGACY_TEMP === "1";
  const roots = legacy ? [TMP_ROOT, os.tmpdir()] : [TMP_ROOT];
  const result = {
    removed: 0,
    failed: 0,
    scanned: 0,
    fresh: 0,
    roots: roots,
    hours: useHours,
    legacy: legacy,
    pid: process.pid,
  };
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !matchesPrefix(entry.name)) continue;
      const full = path.join(root, entry.name);
      result.scanned += 1;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs > cutoff) {
        result.fresh += 1;
        continue;
      }
      const ageHours = Number(((Date.now() - st.mtimeMs) / 3600_000).toFixed(2));
      if (removeTree(full)) {
        result.removed += 1;
        appendSweepLedger({ ts: new Date().toISOString(), path: full, root: root, ageHours: ageHours });
      } else {
        result.failed += 1;
        /* 被占用 / 正在被别人删 → 留给下一轮 */
      }
    }
  }
  writeSweepSummary(result);
  return result;
}

/**
 * 在项目内 .tmp/ 下建临时目录（登记在册，测试结束必删）。
 * @param {string} prefix 目录前缀（保持与历史同名）
 * @param {{scope?: "test"|"file"}} options scope="file" 的目录整个测试文件共用，
 *        由 after 钩子删，不在 afterEach 里删。
 */
function makeTempDir(prefix, options) {
  const opts = options || {};
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  live.add({ path: dir, kind: "dir", scope: opts.scope === "file" ? "file" : "test" });
  return dir;
}

/** 在项目内 .tmp/ 下造一个唯一临时文件（登记在册，退出钩子一并删）。 */
function makeTempFile(prefix, suffix, options) {
  const opts = options || {};
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const unique = process.pid + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const file = path.join(TMP_ROOT, (prefix || "bdp-tmp-") + unique + (suffix || ""));
  live.add({ path: file, kind: "file", scope: opts.scope === "file" ? "file" : "test" });
  return file;
}

/**
 * 装「进程级」清理钩子：exit + SIGINT / SIGTERM / SIGHUP。
 * 覆盖进程提前退出（process.exit）、Ctrl+C、任务被 kill、窗口关闭。
 *
 * ⚠️ Windows 上的实情：在 Windows 上 `process.kill(pid, "SIGINT")` 实际执行的是
 * TerminateProcess（等价 SIGKILL），**JS 侧的信号处理器根本不会被调用** ——
 * 这条只对真实 Ctrl+C（console control event 路径）有效。
 * 不可捕获的强杀（TerminateProcess / 断电）无法靠钩子兜底，
 * 兜底靠的是「落项目内 .tmp/」+「启动时清扫超期残留」这两条。
 */
function installProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("exit", function () {
    cleanupTempDirs("all");
  });
  const signals = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
  for (const pair of signals) {
    try {
      process.on(pair[0], function () {
        cleanupTempDirs("all");
        process.exit(pair[1]);
      });
    } catch {
      /* 该平台不支持该信号 → 交给 exit 钩子兜底 */
    }
  }
}

/**
 * 启动即生效：装进程级清理钩子 + 清扫超期残留。
 * 测试文件由 tmp-helper.js 调用。
 */
function bootstrapTempDirs(options) {
  installProcessHooks();
  return sweepStaleTempDirs(options);
}

module.exports = {
  REPO_ROOT: REPO_ROOT,
  TMP_ROOT: TMP_ROOT,
  STALE_TMP_HOURS: STALE_TMP_HOURS,
  TMP_PREFIXES: TMP_PREFIXES,
  SWEEP_LEDGER: SWEEP_LEDGER,
  SWEEP_SUMMARY: SWEEP_SUMMARY,
  removeTree: removeTree,
  removeFile: removeFile,
  cleanupTempDirs: cleanupTempDirs,
  liveTempCount: liveTempCount,
  sweepStaleTempDirs: sweepStaleTempDirs,
  makeTempDir: makeTempDir,
  makeTempFile: makeTempFile,
  installProcessHooks: installProcessHooks,
  bootstrapTempDirs: bootstrapTempDirs,
};
