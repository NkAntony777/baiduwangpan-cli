/**
 * 临时工作目录落点（**产品代码与开发脚本共用**的底层原语）。
 *
 * 为什么要有这个文件（2026-11-25 扩族修，见 docs/tmp-leak-fix.md）：
 *   测试侧的落点早就收进 <repo>/.tmp/（test/tmp-store.js），但**产品代码**与
 *   **开发脚本**仍在往系统 TEMP（C 盘）写：
 *     · lib/shared-folder.js  → bdp-shared-upload-（共享上传分块中转目录）
 *     · scripts/bench-concurrency.js → bdp-bench-（并发压测隔离配置目录）
 *   而 test/ 目录**不进 npm 包**（package.json 的 files 只含 bin/ lib/ 与两个脚本），
 *   所以产品代码不能 require("../test/tmp-store") —— 只能有一份**产品侧可用**的落点逻辑。
 *   这就是本文件：只负责「落在哪」，不负责「谁来删」。
 *
 * 落点优先级（第一个可用者胜）：
 *   ① BDP_SCRATCH_DIR 环境变量（显式指定，最优先）
 *   ② <包根>/.tmp/ —— 本仓即 <repo>/.tmp/（D 盘）；全局安装副本是指向源仓的
 *      Junction，所以全局跑也是同一个 .tmp/
 *   ③ ~/.bdp/scratch/ —— 兜底：包目录不可写（例如只读挂载）时的最后一站
 *
 * ⚠ **任何情况下都不落系统 TEMP（os.tmpdir()）**。
 *   系统 TEMP 在 Windows 上是 C 盘 —— 那正是历史上被撑出 887 个目录 / 7.383 GB 的地方。
 *   本仓所有临时目录一律落 D 盘（项目内）或用户主目录。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

/** 包根目录（本文件在 <pkg>/lib/ 下）。 */
const PKG_ROOT = path.resolve(__dirname, "..");

/** 项目内临时工作目录名（与 test/tmp-store.js 的 TMP_ROOT 同名同义）。 */
const SCRATCH_DIR_NAME = ".tmp";

/** 仓内临时工作目录根 —— 测试侧与产品侧同一个落点。 */
function repoScratchRoot() {
  return path.join(PKG_ROOT, SCRATCH_DIR_NAME);
}

/** 目录是否可写（不存在则先尝试创建）。 */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedRoot = null;

/**
 * 解析临时工作目录根（带缓存 —— 一个进程内只探一次盘）。
 * @returns {string} 绝对路径
 */
function scratchRoot() {
  if (cachedRoot) return cachedRoot;
  const env = process.env.BDP_SCRATCH_DIR;
  if (typeof env === "string" && env.trim()) {
    cachedRoot = path.resolve(env.trim());
    fs.mkdirSync(cachedRoot, { recursive: true });
    return cachedRoot;
  }
  const repo = repoScratchRoot();
  if (isWritableDir(repo)) {
    cachedRoot = repo;
    return cachedRoot;
  }
  // 兜底：包目录不可写时用用户主目录 —— 仍然**不是**系统 TEMP。
  cachedRoot = path.join(os.homedir(), ".bdp", "scratch");
  fs.mkdirSync(cachedRoot, { recursive: true });
  return cachedRoot;
}

/**
 * 在临时工作目录根下建一个唯一目录。
 * @param {string} prefix 目录前缀（保持与历史同名 ⇒ 计数/清扫口径一致）
 * @returns {string} 目录绝对路径
 */
function makeScratchDir(prefix) {
  const root = scratchRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

/** 异步版 makeScratchDir（产品代码保持 async 风格）。 */
async function makeScratchDirAsync(prefix) {
  const root = scratchRoot();
  await fsp.mkdir(root, { recursive: true });
  return fsp.mkdtemp(path.join(root, prefix));
}

/**
 * 删掉临时目录（Windows 上被占用会 EPERM/EBUSY，故带重试）。
 * @returns {boolean} 是否删掉了（已不存在也算成功）
 */
function removeScratchDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PKG_ROOT: PKG_ROOT,
  SCRATCH_DIR_NAME: SCRATCH_DIR_NAME,
  repoScratchRoot: repoScratchRoot,
  scratchRoot: scratchRoot,
  makeScratchDir: makeScratchDir,
  makeScratchDirAsync: makeScratchDirAsync,
  removeScratchDir: removeScratchDir,
};
