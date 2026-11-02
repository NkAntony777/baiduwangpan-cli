// lib/engine-timeout.js — 引擎调用的超时策略（**所有**引擎调用点共用）
//
// 为什么单独成文件：
//   引擎调用散落在 lib/pan.js（异步 + 同步）与 lib/pcs-extra.js（同步）三处。
//   只要有一处漏了 timeout，"引擎挂死 → 服务器不可用" 的故障就还在：
//     - 异步 spawn 漏 timeout → Promise 永不 settle → MCP 闸门槽位永不释放（4 个即瘫痪）
//     - 同步 spawnSync 漏 timeout → **冻结整个 Node 进程** → 整个服务器不可用，无自愈
//   所以这套策略必须是**单一事实来源**，不能各写各的。
//
// 默认值：读操作 120s、写操作 600s。
//   读操作实测 0.4–0.6s，120s 留了 200 倍余量；写操作（大文件上传/目录下载）需要更久。
// 覆盖：BDP_ENGINE_TIMEOUT_MS（读）/ BDP_ENGINE_TIMEOUT_SLOW_MS（写）。
// Node 的 setTimeout 时长是 **32 位有符号整数** —— 超过 2^31-1 会被**静默截断成 1ms**
// （只打一条 TimeoutOverflowWarning）。表现为「用户把超时调大了，反而每一次引擎调用都在 4ms 内失败」，
// 且错误消息宣称「超时 2147484 秒」——与实际行为完全矛盾。所以这里必须加上界。
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1

/**
 * 归一化超时值：非法/非正 → 回落到默认值；超上界 → 截到上界。
 * @param {*} raw 环境变量原值
 * @param {number} fallback 默认值
 */
function normalizeTimeout(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_TIMEOUT_MS);
}

const ENGINE_TIMEOUT_MS = normalizeTimeout(process.env.BDP_ENGINE_TIMEOUT_MS, 120000);
const ENGINE_TIMEOUT_SLOW_MS = normalizeTimeout(process.env.BDP_ENGINE_TIMEOUT_SLOW_MS, 600000);

// 走「长耗时档」的引擎**真实子命令**（BaiduPCS-Go 的子命令名，不是 CLI 命令名）。
// ⚠️ 必须按引擎子命令填 —— 填 CLI 命令名会出现「永不生效的死条目」
//    （例如引擎的离线下载子命令是 offlinedl，不是 offline）。
const SLOW_ENGINE_COMMANDS = new Set([
  "u", // put 上传
  "mkdir", // 建目录
  "rm", // 删除
  "mv", // 移动/改名
  "cp", // 拷贝
  "share", // 分享
  "recycle", // 回收站
  "offlinedl", // 离线下载（add / list）
  "d", // 目录下载（web API 不可用时回退引擎）
]);

/**
 * 按引擎子命令给出超时档位（毫秒）。
 * @param {string[]} args 引擎参数数组
 * @returns {number}
 */
function engineTimeoutMs(args) {
  const cmd = args && args[0] ? String(args[0]) : "";
  return SLOW_ENGINE_COMMANDS.has(cmd) ? ENGINE_TIMEOUT_SLOW_MS : ENGINE_TIMEOUT_MS;
}

module.exports = {
  ENGINE_TIMEOUT_MS,
  ENGINE_TIMEOUT_SLOW_MS,
  MAX_TIMEOUT_MS,
  SLOW_ENGINE_COMMANDS,
  engineTimeoutMs,
  normalizeTimeout,
};
