/**
 * lib/partial.js — gsearch --save-partial 的纯工具函数
 *
 * 用途：搜索未完整（超时/限流/预算耗尽/失败）时，自动把已搜到的部分结果
 * 落盘到 JSON 文件，避免"跑完了才发现只有 partial:true、结果却没保存"。
 */

const path = require("path");

// 非法文件名字符（Windows/Linux 通用）
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * --save-partial 未指定 --json-file 时的默认保存路径：
 *   <cwd>/bdp-gsearch-<gid>-<keyword>-partial-<timestamp>.json
 */
function defaultPartialFile(gid, keyword, options = {}) {
  const cwd = options.cwd || process.cwd();
  const date = options.date || new Date();
  const safeKw = String(keyword == null ? "" : keyword).replace(ILLEGAL, "_").slice(0, 40) || "search";
  const ts = date.toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, `bdp-gsearch-${String(gid)}-${safeKw}-partial-${ts}.json`);
}

/**
 * 部分结果落盘对象：results 为已搜到的全部匹配（不翻页切片），
 * 附带扫描诊断（scannedShares/totalShares/failedShares/stoppedReason 等），
 * 供 Agent / 用户超时后直接读取。
 */
function buildPartialPayload(result, meta = {}) {
  return {
    saved: "partial",
    partial: true,
    complete: false,
    timedOut: !!result.timedOut,
    stoppedReason: result.stoppedReason || null,
    gid: meta.gid,
    keyword: meta.keyword,
    page: result.page,
    pageSize: result.pageSize,
    total: result.results.length,
    results: result.results,
    scannedShares: result.scannedShares,
    totalShares: result.totalShares,
    failedShares: result.failedShares,
    throttledShares: result.throttledShares,
    cachedDirs: result.cachedDirs,
    budgetUsed: result.budgetUsed,
    depth: result.depth,
    maxPages: result.maxPages,
  };
}

module.exports = { defaultPartialFile, buildPartialPayload };
