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
const MAX_PAGES_PER_DIR = 200; // 单目录最多翻多少页（100 条/页）

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
  let pagedOut = false;   // 目录分页达到上限 → 扫描不完整
  let badEntries = 0;     // 缺 path 等畸形条目
  const seen = new Set();
  let activeWorkers = 0; // 正在处理目录的 worker 数
  const failedDirs = []; // 扫描失败的目录路径（partial 时一并报出）

  // 任务唤醒：worker 放入新目录、或某个 worker 结束时通知等待者。
  // 这里**不能用 setImmediate 忙等** —— 那样 CPU 会被打满 100%
  // （实测 3s 墙钟烧掉 3.05s CPU，且请求挂起时扫描永不返回）。
  let waiters = [];
  function notifyWork() {
    if (!waiters.length) return;
    const list = waiters;
    waiters = [];
    for (const fn of list) fn();
  }
  function waitForWork() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      waiters.push(finish);
      // 兜底：50ms 后醒一次，防止任何漏通知导致永久挂起
      setTimeout(finish, 50);
    });
  }

  async function worker() {
    for (;;) {
      const dir = pending.pop();
      if (dir === undefined) {
        // 队列空 ≠ 任务全部完成。
        // 其他 worker 可能正在处理目录，子目录还没放回队列 ——
        // 若此时直接 return，worker 会永久退出，并发度退化为 1
        // （实测：初始只有根目录时，8 个 worker 里有 7 个立刻退出）。
        // 正确做法：等其它 worker 推进（让出事件循环）后再看队列。
        if (activeWorkers === 0) return; // 真的没有活跃 worker → 全部结束
        await waitForWork();
        continue;
      }
      if (seen.has(dir)) continue;
      seen.add(dir);
      activeWorkers++;

      let dirOk = false;
      try {
        for (let page = 1; page <= MAX_PAGES_PER_DIR; page++) {
          const data = await listPage(dir, page);
          if (!data || data.errno !== 0 || !Array.isArray(data.list)) break;
          // 注意：dirOk 必须在**每一页**都置位。若只在首页置位，
          // 「首页成功、第 2 页失败」会被当成成功 → 静默少扫且不计入 failed。
          dirOk = true;
          for (const item of data.list) {
            const isDir = item.isdir === 1 || item.isdir === "1";
            // 返回的路径不在扫描根之下 → 越界条目，直接丢弃（并计为畸形 → partial）
            if (item.path && !isUnderRoot(item.path, root)) { badEntries++; continue; }
            if (isDir) {
              if (!item.path) { badEntries++; continue; }
              // 深度必须相对扫描根计算：item.path 是绝对路径，
              // 若用绝对深度比较，根目录本身较深时会把所有子目录误判为超限。
              if (relDepth(item.path, root) <= maxDepth) {
                pending.push(item.path);
                notifyWork();
              } else {
                depthCapped = true;
              }
              continue;
            }
            const size = Number(item.size) || 0;
            if (size < minSize) continue;
            if (!item.path) { badEntries++; continue; }
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
          // 这一页是满的且已达上限 → 后面还有内容没扫
          if (page === MAX_PAGES_PER_DIR) pagedOut = true;
        }
      } catch {
        // 网络异常 → 计入失败，不中断整体扫描
      }
      if (!dirOk) failedDirs.push(dir);
      activeWorkers--;
      notifyWork();
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
    failedDirs,
    badEntries,
    pagedOut,
    depthCapped,
    // partial：扫描不完整（深度封顶 / 分页截断 / 有畸形条目 / **有目录扫描失败**）
    // failed 一定要计入：否则某个目录请求失败时，那批文件会静默消失，
    // 而用户看到的仍是「扫描完整」。
    partial: depthCapped || pagedOut || badEntries > 0 || failed > 0,
    depthLimit: maxDepth,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 路径是否位于扫描根之下（前缀必须带分隔符，/medsub 不算 /med 的子目录） */
function isUnderRoot(p, root) {
  if (!root || root === "/") return true;
  const base = root.replace(/\/+$/, "");
  return p === base || p.startsWith(base + "/");
}

/** 相对于扫描根的深度（根=0，直接子目录=1） */
function relDepth(p, root) {
  if (!p || p === root) return 0;
  const base = root && root !== "/" ? root.replace(/\/+$/, "") : "";
  // 前缀匹配必须带分隔符：否则 /medsub/x 会被当成 /med 的子目录（越界扫描）
  const tail = base && (p === base || p.startsWith(base + "/")) ? p.slice(base.length) : p;
  return tail.split("/").filter(Boolean).length;
}

/** /api/list 单页 */
async function listPage(dir, page) {
  const bdstoken = await http.getBdstoken();
  const url =
    "https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1" +
    "&page=" + page + "&num=100&dir=" + encodeURIComponent(dir) +
    "&channel=chunlei&app_id=" + http.APP_ID + "&bdstoken=" + encodeURIComponent(bdstoken);
  // webTransport = "native" 时走异步 fetch —— 真正的并发
  // （curl 版用 spawnSync 同步阻塞，会让所有 worker 串行化）
  return http.webJson(url);
}

/**
 * 按 size 粗筛出候选重复组。
 * @param {Array} files
 * @param {object} options { minGroupSize }
 */
/**
 * 合法 md5 判据：32 位十六进制。
 * 分组键只接受合法哈希 —— 百度在部分场景返回 "0" 这类短常量，
 * 若直接当分组键，所有同尺寸且 md5="0" 的**完全不同的文件**会被聚成一簇，
 * 随后被标记为「可删」→ 误删用户文件。宁可漏报，不可误删。
 */
function isValidHash(m) {
  return typeof m === "string" && /^[0-9a-f]{32}$/i.test(m);
}

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
      const key = isValidHash(f.md5) ? f.md5 : "__nohash__" + f.path;
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
        noHash: !isValidHash(md5),
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
    failedDirPaths: scan.failedDirs,
    partial: scan.partial,
    badEntries: scan.badEntries,
    pagedOut: scan.pagedOut,
    depthCapped: scan.depthCapped,
    depthLimit: scan.depthLimit,
    elapsedMs: scan.elapsedMs,
    sizeGroups: sizeGroups.length,
    clusters,
    clusterCount: clusters.length,
    duplicateFiles: dupFiles,
    wastedBytes: wasted,
    sizeOnlyWastedBytes: sizeOnlyWasted,
    obfuscatedCount: scan.files.filter((f) => f.obfuscated).length,
    // 百度未返回 md5 的文件无法参与精算（只能按 size 粗筛），
    // 如实计数，避免用户误以为已完整比对。
    noMd5Count: scan.files.filter((f) => !f.md5).length,
  };
}

/**
 * 为每个重复簇挑选「保留哪一个」。
 * 默认策略：保留路径最短（最靠近根）的那份，其余作为可删除候选。
 */
/**
 * 为每个重复簇挑选「保留哪一个」。
 * 策略：
 *   - shortest（默认）：保留路径最短的
 *   - oldest / newest：保留修改时间最早/最新的
 *   - 显式路径：如果 options.keep 是以 "/" 开头的路径，
 *     则该簇保留这份（路径必须在该簇内，否则回退到默认策略）
 *
 * 注意：默认的 shortest 只是启发式，不保证符合用户意图
 * （短路径可能是自动整理产生的副本，长路径才是用户手动归档的原件）。
 * 删除前务必先 --dry-run 确认保留的是哪一份。
 */
function pickKeepers(clusters, options = {}) {
  const keepStrategy = options.keep || "shortest";
  const explicit = typeof keepStrategy === "string" && keepStrategy.startsWith("/");
  return clusters.map((c) => {
    let keep = c.files[0];
    if (explicit) {
      const hit = c.files.find((f) => f.path === keepStrategy);
      if (hit) {
        keep = hit;
      } else {
        // 该簇里没有这份路径 → 回退到 shortest
        for (const f of c.files) {
          if (f.path.length < keep.path.length) keep = f;
        }
      }
    } else {
      for (const f of c.files) {
        if (keepStrategy === "shortest") {
          if (f.path.length < keep.path.length) keep = f;
        } else if (keepStrategy === "oldest") {
          if ((f.mtime || 0) < (keep.mtime || 0)) keep = f;
        } else if (keepStrategy === "newest") {
          if ((f.mtime || 0) > (keep.mtime || 0)) keep = f;
        }
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
  isValidHash,  scanFiles,
  groupBySize,
  refineByMd5,
  scanDuplicates,
  pickKeepers,
};
