// lib/dedup.js — 重复文件检测与清理
//
// 核心难点：百度 /api/list 返回的 md5 是「混淆 md5」——
// 同一份内容放在不同路径，返回值竟不同（实测 d8df7aa4do… vs 512b5f54d9…）。
// 不反混淆就做去重，会把同一份文件误判成两份不同文件（漏报）。
// 解密后，同内容 → 同 md5，去重才成立。算法见 lib/md5.js。
//
// 策略（与路线图一致）：
//   阶段 1（粗筛）：递归遍历拿到全量文件，按 size 分组。
//                   只有 size 相同的候选才需要精算 —— 零额外请求。
//   阶段 2（精算）：对候选组用反混淆后的 md5 细分，确认真正重复。
//
// 删除走百度回收站（引擎 rm 输出「可在网盘文件回收站找回」），可恢复。

const http = require("./http");
const { decryptMD5, isObfuscatedMD5 } = require("./md5");

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_DEPTH = 12; // 去重必须扫全，深度限制放宽
const DEFAULT_MIN_SIZE = 1;   // 0 字节文件不算重复

/**
 * 递归遍历网盘，返回文件清单（含反混淆后的真实 md5）。
 * 只用 /api/list（一次请求一页 100 条），不下载任何文件内容。
 *
 * @param {string} root 起始目录
 * @param {object} options { concurrency, maxDepth, onProgress, minSize, includeDirs }
 * @returns {Promise<{files: Array, dirs: number, failed: number, partial: boolean, elapsedMs: number}>}
 */
async function scanFiles(root, options = {}) {
  const concurrency = Math.min(Math.max(1, options.concurrency || DEFAULT_CONCURRENCY), 16);
  const maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;
  const minSize = options.minSize != null ? options.minSize : DEFAULT_MIN_SIZE;
  const startedAt = Date.now();

  const files = [];
  const pending = [root];
  let failed = 0;
  let scannedDirs = 0;
  let depthCapped = false;
  const seen = new Set();

  async function worker() {
    for (;;) {
      const dir = pending.pop();
      if (dir === undefined) return;
      if (seen.has(dir)) continue;
      seen.add(dir);

      let dirOk = false;
      try {
        for (let page = 1; page <= 200; page++) {
          const data = await listPage(dir, page);
          if (!data || data.errno !== 0 || !Array.isArray(data.list)) break;
          dirOk = true;
          for (const item of data.list) {
            const isDir = item.isdir === 1 || item.isdir === "1";
            if (isDir) {
              // 深度必须相对扫描根计算：item.path 是绝对路径，
              // 若用绝对深度比较，根目录本身较深时会把所有子目录误判为超限。
              if (relDepth(item.path, root) <= maxDepth) {
                pending.push(item.path);
              } else {
                depthCapped = true;
              }
              continue;
            }
            const size = Number(item.size) || 0;
            if (size < minSize) continue;
            const rawMd5 = item.md5 || "";
            files.push({
              path: item.path,
              name: item.server_filename,
              size,
              md5: decryptMD5(rawMd5),
              rawMd5,
              obfuscated: isObfuscatedMD5(rawMd5),
              mtime: item.server_mtime || item.local_mtime || 0,
              fsId: item.fs_id,
            });
          }
          if (data.list.length < 100) break;
        }
      } catch {
        // 网络异常 → 计入失败，不中断整体扫描
      }
      scannedDirs++;
      if (!dirOk) failed++;
      if (typeof options.onProgress === "function" && scannedDirs % 20 === 0) {
        options.onProgress({
          scannedDirs,
          pending: pending.length,
          files: files.length,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);

  return {
    root,
    files,
    dirs: scannedDirs,
    failed,
    partial: depthCapped,
    depthLimit: maxDepth,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 相对于扫描根的深度（根=0，直接子目录=1） */
function relDepth(p, root) {
  if (!p || p === root) return 0;
  const base = root && root !== "/" ? root.replace(/\/+$/, "") : "";
  const tail = base && p.startsWith(base) ? p.slice(base.length) : p;
  return tail.split("/").filter(Boolean).length;
}

/** /api/list 单页 */
async function listPage(dir, page) {
  const bdstoken = await http.getBdstoken();
  const url =
    "https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1" +
    "&page=" + page + "&num=100&dir=" + encodeURIComponent(dir) +
    "&channel=chunlei&app_id=" + http.APP_ID + "&bdstoken=" + encodeURIComponent(bdstoken);
  return http.webJson(url);
}

/**
 * 按 size 粗筛出候选重复组。
 * @param {Array} files
 * @param {object} options { minGroupSize }
 */
function groupBySize(files, options = {}) {
  const minGroupSize = options.minGroupSize || 2;
  const bySize = new Map();
  for (const f of files) {
    if (!f.size) continue;
    const arr = bySize.get(f.size);
    if (arr) arr.push(f);
    else bySize.set(f.size, [f]);
  }
  const groups = [];
  for (const [size, arr] of bySize) {
    if (arr.length >= minGroupSize) groups.push({ size, files: arr });
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  return groups;
}

/**
 * 对候选组按真实 md5 细分，得到真正的重复簇。
 * @param {Array} sizeGroups groupBySize 的输出
 * @returns {Array} 重复簇 [{ size, md5, files[], wasted }]
 */
function refineByMd5(sizeGroups) {
  const clusters = [];
  for (const group of sizeGroups) {
    const byMd5 = new Map();
    for (const f of group.files) {
      const key = f.md5 || ("__nohash__" + f.path);
      const arr = byMd5.get(key);
      if (arr) arr.push(f);
      else byMd5.set(key, [f]);
    }
    for (const [md5, arr] of byMd5) {
      if (arr.length < 2) continue;
      clusters.push({
        size: group.size,
        md5,
        files: arr,
        wasted: group.size * (arr.length - 1),
        noHash: md5.startsWith("__nohash__"),
      });
    }
  }
  clusters.sort((a, b) => b.wasted - a.wasted);
  return clusters;
}

/**
 * 完整去重扫描：遍历 → 粗筛 → 精算。
 */
async function scanDuplicates(root, options = {}) {
  const scan = await scanFiles(root, options);
  const sizeGroups = groupBySize(scan.files, options);
  const clusters = refineByMd5(sizeGroups);

  const wasted = clusters.reduce((sum, c) => sum + c.wasted, 0);
  const dupFiles = clusters.reduce((sum, c) => sum + (c.files.length - 1), 0);

  // 粗筛阶段就已知的候选规模（用于报告"如果只按大小算能省多少"）
  const sizeOnlyWasted = sizeGroups.reduce(
    (sum, g) => sum + g.size * (g.files.length - 1),
    0
  );

  return {
    root,
    scannedFiles: scan.files.length,
    scannedDirs: scan.dirs,
    failedDirs: scan.failed,
    partial: scan.partial,
    elapsedMs: scan.elapsedMs,
    sizeGroups: sizeGroups.length,
    clusters,
    clusterCount: clusters.length,
    duplicateFiles: dupFiles,
    wastedBytes: wasted,
    sizeOnlyWastedBytes: sizeOnlyWasted,
    obfuscatedCount: scan.files.filter((f) => f.obfuscated).length,
  };
}

/**
 * 为每个重复簇挑选「保留哪一个」。
 * 默认策略：保留路径最短（最靠近根）的那份，其余作为可删除候选。
 */
function pickKeepers(clusters, options = {}) {
  const keepStrategy = options.keep || "shortest";
  return clusters.map((c) => {
    let keep = c.files[0];
    for (const f of c.files) {
      if (keepStrategy === "shortest") {
        if (f.path.length < keep.path.length) keep = f;
      } else if (keepStrategy === "oldest") {
        if ((f.mtime || 0) < (keep.mtime || 0)) keep = f;
      } else if (keepStrategy === "newest") {
        if ((f.mtime || 0) > (keep.mtime || 0)) keep = f;
      }
    }
    return {
      ...c,
      keep: keep.path,
      removable: c.files.filter((f) => f.path !== keep.path).map((f) => f.path),
    };
  });
}

module.exports = {
  scanFiles,
  groupBySize,
  refineByMd5,
  scanDuplicates,
  pickKeepers,
};
