const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const http = require("./http");

// child_process 延迟加载：测试可整体替换 require.cache["child_process"] 注入 mock
function childProc() {
  return require("child_process");
}

function runPCS(args) {
  const cfg = config.get();
  const { spawnSync } = childProc();
  const result = spawnSync(cfg.pcsPath, args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`未找到 BaiduPCS-Go 可执行文件: ${cfg.pcsPath}。请在 config 中设置 pcsPath，或设置环境变量 BAIDUPCS_CMD。`);
  }
  return result.stdout || "";
}

function getDlink(remotePath) {
  const output = runPCS(["locate", remotePath]);
  const urls = output.match(/https?:\/\/[^\s]+/g);
  if (urls && urls.length > 0) {
    return urls[0].replace(/[,\s]+$/, "");
  }
  return null;
}

// 通过 web 前端同款 /api/list 获取文件元信息（size/md5/isdir/ctime 一次拿全）。
// 实测 (2026-08): /api/filemetas 与 xpan filemetas 均返回 errno=2 不可用，
// 而 /api/list（父目录列表 + bdstoken）可用，md5 与 dlink URL 前缀一致，比
// BaiduPCS-Go meta 文本输出（"md5 (可能不正确)"）更可靠。
// 失败（未登录/接口异常/文件不在前 2000 条）返回 null，由调用方回退文本解析。
async function getFileMetaWeb(remotePath) {
  const bdstoken = await http.getBdstoken();
  const trimmed = remotePath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const parent = idx <= 0 ? "/" : trimmed.slice(0, idx);
  const base = idx === -1 ? trimmed : trimmed.slice(idx + 1);

  for (let page = 1; page <= 20; page++) {
    const url =
      `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1` +
      `&page=${page}&num=100&dir=${encodeURIComponent(parent)}` +
      `&channel=chunlei&app_id=${http.APP_ID}&bdstoken=${encodeURIComponent(bdstoken)}`;
    const data = await http.webJson(url);
    if (!data || data.errno !== 0 || !Array.isArray(data.list)) return null;
    const item = data.list.find((f) => f.server_filename === base);
    if (item) {
      return {
        size: typeof item.size === "number" ? item.size : parseInt(item.size, 10) || null,
        md5: item.md5 || null,
        isDir: item.isdir === 1 || item.isdir === "1",
        serverCtime: item.server_ctime != null ? item.server_ctime : null,
        localCtime: item.local_ctime != null ? item.local_ctime : null,
      };
    }
    if (data.list.length < 100) return null; // 翻页结束仍未找到
  }
  return null;
}

function getFileMeta(remotePath) {
  const output = runPCS(["meta", remotePath]);
  let size = null;

  // BaiduPCS-Go v4.0.1 实测输出: "文件大小          7297727, 6.959655MB"
  // （首个数字为精确字节数；旧正则要求 "大小:" 冒号，实际是空格，永远匹配不到）
  let m = output.match(/文件大小\s*[:：]?\s*(\d[\d,]*)/);
  if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  if (!size) {
    m = output.match(/size[":\s]+(\d+)/i);
    if (m) size = parseInt(m[1], 10);
  }
  if (!size) {
    m = output.match(/(\d[\d,]*)\s*B\b/);
    if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  }

  // md5（BaiduPCS-Go meta 输出 "md5 (可能不正确)  xxxx"，仅作文本回退参考）
  let md5 = null;
  m = output.match(/md5[^0-9a-fA-F]*([0-9a-fA-F]{32})/);
  if (m) md5 = m[1].toLowerCase();

  // 只看 "类型" 行，避免文件名含"目录"字样时误判（旧正则 /目录/ 会误伤）
  const isDir = /类型\s*[:：]?\s*目录/.test(output) || /isdir.*1|is_dir.*true/i.test(output);

  return { size, isDir, md5, raw: output };
}

function fetchRangeText(url, start, end) {
  const cfg = config.get();
  const buf = http.curlRange(url, start, end, cfg.ua);
  return decodeText(buf);
}

function fetchRangeBuf(url, start, end) {
  const cfg = config.get();
  return http.curlRange(url, start, end, cfg.ua);
}

function decodeText(buf) {
  if (typeof buf === "string") return buf;
  for (const enc of ["utf-8", "gbk", "gb2312", "latin-1"]) {
    try {
      return buf.toString(enc);
    } catch {
      continue;
    }
  }
  return buf.toString("utf-8");
}

// ── Pan Operations ─────────────────────────────────────

function ls(dirPath = "/") {
  return runPCS(["ls", dirPath]);
}

function search(keyword, searchPath = "/") {
  return runPCS(["search", `-path=${searchPath}`, "-r", keyword]);
}

function cat(remotePath, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const meta = getFileMeta(remotePath);

  if (meta.size && meta.size > 50 * 1024 * 1024) {
    process.stderr.write(`[WARN] File is ${(meta.size / 1024 / 1024).toFixed(1)}MB, truncating to ${(limit / 1024).toFixed(0)}KB\n`);
  }

  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`无法获取 ${remotePath} 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。`);

  const readBytes = Math.min(meta.size || limit, limit) - 1;
  return fetchRangeText(dlink, 0, readBytes);
}

function head(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`无法获取 ${remotePath} 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。`);

  const chunkSize = Math.min(n * 4096 + 1024, limit);
  const text = fetchRangeText(dlink, 0, chunkSize - 1);
  const lines = text.split("\n");
  return lines.slice(0, n);
}

function tail(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const meta = getFileMeta(remotePath);
  if (!meta.size) throw new Error(`无法获取 ${remotePath} 的文件大小。`);

  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`无法获取 ${remotePath} 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。`);

  const chunkSize = Math.min(n * 4096 + 1024, limit, meta.size);
  const start = Math.max(0, meta.size - chunkSize);
  const text = fetchRangeText(dlink, start, meta.size - 1);
  const lines = text.split("\n");
  return lines.slice(-n);
}

function grep(pattern, remotePath, options = {}) {
  const cfg = config.get();
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`无法获取 ${remotePath} 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。`);

  const text = fetchRangeText(dlink, 0, cfg.maxBytes - 1);

  let regex;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "gi" : "g");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.ignoreCase ? "gi" : "g");
  }

  const matches = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (regex.test(line)) {
      matches.push({ line: i + 1, content: line });
    }
    regex.lastIndex = 0;
  });
  return matches;
}

async function peek(remotePath) {
  // web 元信息优先（含权威 md5/ctime），失败回退 meta 文本解析
  let webMeta = null;
  try {
    webMeta = await getFileMetaWeb(remotePath);
  } catch {}
  const meta = webMeta || getFileMeta(remotePath);
  const dlink = getDlink(remotePath);

  const result = {
    path: remotePath,
    size: meta.size,
    isDir: meta.isDir,
    dlink: !!dlink,
  };

  if (webMeta) {
    if (webMeta.md5) result.md5 = webMeta.md5;
    if (webMeta.serverCtime) result.serverCtime = webMeta.serverCtime;
    if (webMeta.localCtime) result.localCtime = webMeta.localCtime;
  }

  if (dlink && !meta.isDir) {
    const cfg = config.get();
    const previewBytes = Math.min(512, meta.size || 512) - 1;
    const buf = fetchRangeBuf(dlink, 0, previewBytes);

    let isBinary = false;
    for (const b of buf.slice(0, 200)) {
      if (b < 9 || (b > 13 && b < 32)) {
        isBinary = true;
        break;
      }
    }

    result.type = isBinary ? "binary" : "text";
    if (!isBinary) {
      result.preview = decodeText(buf).split("\n").slice(0, 10);
    }
  }

  return result;
}

// ── 下载 ────────────────────────────────────────────────
//
// v1.2.0 起 bdp get 不再裸跑 BaiduPCS-Go（其 download 无断点续传，且自动跳过
// 重名文件导致中断后无法续）。改为：
//   filemetas 元信息（/api/list）→ locate dlink → curl 直链分块下载
// 分块原因（实测 2026-08）：部分 CDN 节点（*ct11.baidupcs.com）拒绝无界请求
// （HTTP 403, error_code 31326, hitcode 104），只允许 ≤~5MB 的有界 Range。
// 4MB 分块 + 每块失败换新 dlink 重试，同时天然支持断点续传与坏主机规避。
// 目录或无 dlink 的边界场景仍回退 BaiduPCS-Go 引擎（无校验/续传，保持原行为）。
//
// options: { resume, force, progress, verifySize }
//   硬校验：size 对比 + 0 字节检测（默认全开，失败保留文件供排查）
//   软校验：md5（百度 /api/list 的 md5 是混淆值，仅本地计算+标注，不阻断）

const DOWNLOAD_CHUNK = 4 * 1024 * 1024; // 4MB/块（CT11 节点 range 上限约 5MB）
const DEFAULT_CONCURRENCY = 3; // 并发分块路数（绕开单连接限速；仅大文件启用）
const CONCURRENT_THRESHOLD = 32 * 1024 * 1024; // 剩余 >32MB 才启用并发（小文件串行开销更小）

async function download(remotePath, saveTo, options = {}) {
  const cfg = config.get();
  const opts = { resume: false, force: false, progress: false, verifySize: true, dryRun: false, concurrency: DEFAULT_CONCURRENCY, ...options };

  // 1) 元信息：web /api/list 优先（size 权威）→ 失败回退 meta 文本解析。
  //    注：API 的 md5 为混淆键（非内容哈希，实测含非 hex 字符），仅作参考不参与硬校验
  let webMeta = null;
  try {
    webMeta = await getFileMetaWeb(remotePath);
  } catch {}
  const meta = webMeta || getFileMeta(remotePath);
  const remoteMd5 = webMeta ? webMeta.md5 || null : null;

  // 2) dlink（locate 每次返回新链接；分块失败时自动换新，规避过期/坏节点）
  const dlink = getDlink(remotePath);
  let dlinkExpiry = null;
  if (dlink) {
    const sizeInDlink = dlink.match(/[?&]size=(\d+)/);
    if (sizeInDlink && !meta.size) meta.size = parseInt(sizeInDlink[1], 10);
    const exp = dlink.match(/[?&]expires=([^&]+)/);
    if (exp) dlinkExpiry = exp[1];
  }

  // 3) 目录或无 dlink → 回退 BaiduPCS-Go 引擎
  if ((meta && meta.isDir) || !dlink) {
    const args = ["d", remotePath];
    if (saveTo) args.push("--saveto", saveTo);
    return {
      path: remotePath,
      engine: "pcs",
      raw: runPCS(args),
      warning: meta && meta.isDir
        ? "目录下载走 BaiduPCS-Go 引擎（无校验/断点续传）"
        : "获取 dlink 失败，走 BaiduPCS-Go 引擎",
    };
  }

  // 4) 本地目标路径：-o 视为目录（自动创建）；默认当前目录（与 gdownload 一致）
  const baseName = path.basename(remotePath.replace(/[\\/]+$/, ""));
  const localPath = saveTo ? path.join(saveTo, baseName) : path.join(process.cwd(), baseName);

  // 已有文件决策
  let existingSize = null;
  try {
    existingSize = fs.statSync(localPath).size;
  } catch {}

  // --dry-run：不落盘、不创建目录、不请求下载，仅报告将执行的动作
  if (opts.dryRun) {
    let action = "download";
    if (existingSize !== null && !opts.force) {
      if (meta.size != null && existingSize === meta.size) action = "skip";
      else if (meta.size != null && existingSize > meta.size) action = "overwrite";
      else action = "resume";
    }
    return {
      path: remotePath,
      dryRun: true,
      engine: "dry-run",
      action,
      size: meta.size,
      localPath,
      existingSize,
      dlinkExpiry,
    };
  }

  if (saveTo) fs.mkdirSync(saveTo, { recursive: true });

  if (!opts.force && existingSize !== null) {
    if (meta.size != null && existingSize === meta.size) {
      return verifyAndBuild(remotePath, localPath, existingSize, remoteMd5, dlinkExpiry, {
        skipped: true, resumed: false,
      });
    }
    if (meta.size != null && existingSize > meta.size) {
      throw new Error(
        `本地文件大于远端: 本地 ${existingSize} 字节 > 远端 ${meta.size} 字节\n` +
        `      已保留: ${localPath}\n      处理: --force 覆盖重下`
      );
    }
    if (existingSize < (meta.size != null ? meta.size : Infinity)) {
      if (!opts.resume) {
        process.stderr.write(
          `[auto-resume] 检测到部分文件 ${existingSize}/${meta.size != null ? meta.size : "?"} 字节，自动断点续传（--force 可强制重下）\n`
        );
      }
      opts.resume = true;
    }
  }

  // --force：分块下载是追加写，必须先清掉旧文件
  if (opts.force && existingSize !== null) {
    fs.unlinkSync(localPath);
    existingSize = null;
  }

  // 6) 分块下载（有界 Range，天然续传）
  const startedAt = Date.now();
  if (meta.size != null && meta.size > 0) {
    await curlChunkedDownload(dlink, remotePath, localPath, meta.size, existingSize || 0, opts);
  } else {
    // 拿不到远端大小（罕见）：单请求无界下载（部分节点会拒绝，但无更好的办法）
    const exitCode = await spawnCurl(
      ["-s", "-L", "-C", "-", "--connect-timeout", "30", "-H", `User-Agent: ${cfg.ua}`, "-o", localPath, dlink],
      opts.progress
    );
    if (exitCode !== 0) {
      throw new Error(
        `curl 下载失败 (exit=${exitCode})，已保留部分文件: ${localPath}\n` +
        `      处理: 重跑 bdp get --resume（会重新获取 dlink）`
      );
    }
  }
  const seconds = (Date.now() - startedAt) / 1000;

  // 7) 校验（失败均保留文件供排查）
  let stat = null;
  try {
    stat = fs.statSync(localPath);
  } catch {}
  if (!stat) {
    throw new Error(
      `下载失败，目标文件缺失: ${localPath}\n      处理: 重跑 bdp get --resume`
    );
  }
  if (opts.verifySize && meta.size != null) {
    if (stat.size === 0 && meta.size > 0) {
      throw new Error(
        `下载结果 0 字节: dlink 过期或网络中断\n` +
        `      已保留: ${localPath}\n      处理: 重跑 bdp get --resume（会重新获取 dlink）`
      );
    }
    if (stat.size !== meta.size) {
      throw new Error(
        `大小校验失败: 远端 ${meta.size} 字节 vs 本地 ${stat.size} 字节\n` +
        `      已保留: ${localPath}\n      处理: --resume 续传 或 --force 重下`
      );
    }
  }

  return verifyAndBuild(remotePath, localPath, stat.size, remoteMd5, dlinkExpiry, {
    skipped: false, resumed: opts.resume && existingSize > 0, seconds, avgSpeedBps: seconds > 0 ? Math.round(stat.size / seconds) : null,
  });
}

// 分块下载主循环：从 existingSize 开始，每块 ≤4MB 有界 Range，
// 追加写入目标文件；块失败重试（每次换新 dlink，天然规避过期/坏节点）。
// 大文件（剩余 >32MB）默认 3 路并发分块（绕开单连接限速），--concurrency 1 可回串行
async function curlChunkedDownload(dlink, remotePath, localPath, metaSize, existingSize, opts) {
  // 清理同目录残留的陈旧分块临时文件（上次硬中断留下的 .bdp-chunk-*.tmp）
  cleanupStaleChunks(path.dirname(localPath));
  const fd = fs.openSync(localPath, "a");
  const state = { downloaded: existingSize, lastProgress: 0, startedAt: Date.now() };
  try {
    const concurrency = Math.min(Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY), 8);
    if (concurrency > 1 && metaSize - existingSize > CONCURRENT_THRESHOLD) {
      await concurrentChunkLoop(dlink, remotePath, localPath, fd, metaSize, state, concurrency, opts);
    } else {
      // 串行（小文件 / --concurrency 1）
      while (state.downloaded < metaSize) {
        const end = Math.min(state.downloaded + DOWNLOAD_CHUNK - 1, metaSize - 1);
        const data = await fetchRangeChunk(dlink, remotePath, localPath, state.downloaded, end, metaSize, opts);
        fs.writeSync(fd, data);
        state.downloaded += data.length;
        emitProgressIfDue(state, metaSize, opts);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (opts.progress) process.stderr.write("\n");
  return (Date.now() - state.startedAt) / 1000;
}

// 并发分块主循环：固定窗口预取（每块独立有界 Range + 独立 tmp 文件），
// 按序落盘（fd 写入保持顺序，文件永远是完整前缀）；
// 任一块重试后仍失败 → 等待在途块结束、丢弃其结果，降级串行补齐剩余
async function concurrentChunkLoop(dlink, remotePath, localPath, fd, metaSize, state, concurrency, opts) {
  let nextStart = state.downloaded;
  let nextWrite = state.downloaded;
  const active = new Map(); // start -> Promise<{start, data} | {start, error}>
  while (nextWrite < metaSize) {
    // 填充并发窗口
    while (active.size < concurrency && nextStart < metaSize) {
      const start = nextStart;
      const end = Math.min(start + DOWNLOAD_CHUNK - 1, metaSize - 1);
      active.set(
        start,
        fetchRangeChunk(dlink, remotePath, localPath, start, end, metaSize, opts)
          .then((data) => ({ start, data }))
          .catch((e) => ({ start, error: e }))
      );
      nextStart = end + 1;
    }
    const result = await active.get(nextWrite);
    active.delete(nextWrite);
    if (result.error) {
      // 并发下块失败（已内部重试换 dlink）→ 丢弃在途结果，降级串行补齐剩余
      await Promise.allSettled([...active.values()]);
      active.clear();
      while (nextWrite < metaSize) {
        const end = Math.min(nextWrite + DOWNLOAD_CHUNK - 1, metaSize - 1);
        const data = await fetchRangeChunk(dlink, remotePath, localPath, nextWrite, end, metaSize, opts);
        fs.writeSync(fd, data);
        nextWrite += data.length;
        state.downloaded = nextWrite;
        emitProgressIfDue(state, metaSize, opts);
      }
      return;
    }
    fs.writeSync(fd, result.data);
    nextWrite += result.data.length;
    state.downloaded = nextWrite;
    emitProgressIfDue(state, metaSize, opts);
  }
}

function emitProgressIfDue(state, metaSize, opts) {
  if (!opts.progress) return;
  const now = Date.now();
  if (now - state.lastProgress > 200 || state.downloaded >= metaSize) {
    state.lastProgress = now;
    emitProgress(state.downloaded, metaSize, state.startedAt);
  }
}

// 下载一个分块；失败重试 3 次，每次重新 locate 换新 dlink
async function fetchRangeChunk(dlink, remotePath, localPath, start, end, metaSize, opts, attempt = 0) {
  const cfg = config.get();
  const expected = end - start + 1;
  const tmpPath = path.join(
    path.dirname(localPath),
    `.bdp-chunk-${process.pid}-${start}.tmp`
  );
  const args = [
    "-s", "-L",
    "-r", `${start}-${end}`,
    "-o", tmpPath,
    "-w", "%{http_code} %{size_download}",
    "--connect-timeout", "30",
    "--speed-limit", "10240", "--speed-time", "30",
    "-H", `User-Agent: ${cfg.ua}`,
    dlink,
  ];
  const { exitCode, stdout } = await spawnCurlCapture(args);
  if (exitCode === 0) {
    const m = (stdout || "").trim().match(/^(\d+) (\d+)$/);
    if (m && m[1] === "206" && parseInt(m[2], 10) === expected) {
      const data = fs.readFileSync(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
      return data;
    }
  }
  try { fs.unlinkSync(tmpPath); } catch {}

  if (attempt < 3) {
    process.stderr.write(`[retry] 分块 ${start}-${end} 失败 (exit=${exitCode} resp=${(stdout || "").trim() || "?"})，换新 dlink 重试...\n`);
    const freshDlink = getDlink(remotePath);
    if (freshDlink) return fetchRangeChunk(freshDlink, remotePath, localPath, start, end, metaSize, opts, attempt + 1);
  }
  throw new Error(
    `下载中断于 ${start}/${metaSize} 字节: dlink 过期或网络中断或 CDN 拒绝（resp=${(stdout || "").trim() || "?"}）\n` +
    `      已保留部分文件: ${localPath}\n      处理: 重跑 bdp get --resume（会重新获取 dlink 续传）`
  );
}

// 清理下载目录中残留的陈旧分块临时文件（硬中断（SIGKILL/断电）留下的
// .bdp-chunk-<pid>-<start>.tmp）。判定：
//   1) 文件名 pid ≠ 当前进程 → 陈旧（并发下载的占用文件在 Windows 上删除会
//      EPERM 安全跳过；Unix 上 unlink 后 curl 继续写已打开 fd，仅浪费一块重试）
//   2) mtime 超 10 分钟 → 陈旧兜底
function cleanupStaleChunks(dir) {
  const myPid = process.pid;
  const cutoff = Date.now() - 10 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(".bdp-chunk-") || !name.endsWith(".tmp")) continue;
    const m = name.match(/^\.bdp-chunk-(\d+)-/);
    try {
      const st = fs.statSync(path.join(dir, name));
      const staleByPid = m && parseInt(m[1], 10) !== myPid;
      const staleByAge = st.mtimeMs < cutoff;
      if (staleByPid || staleByAge) fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
}

function emitProgress(downloaded, total, startedAt) {  const seconds = (Date.now() - startedAt) / 1000;
  const speed = seconds > 0 ? downloaded / seconds : 0;
  const pct = Math.round((downloaded / total) * 100);
  const units = ["B", "KB", "MB", "GB"];
  const fmt = (n) => {
    if (!n) return "0B";
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(1) + units[i];
  };
  process.stderr.write(
    `\r[get] ${fmt(downloaded)}/${fmt(total)} (${pct}%)  ${fmt(speed)}/s  `
  );
}

// 最终校验并组装返回信息。
// md5 为软校验：实测百度 /api/list 返回的 md5 是混淆键（含 o/t 等非 hex 字符，
// 与真实内容不符，dlink URL 里也用它做文件键），无法作为完整性依据。
// 仅当远端 md5 是标准 32 位 hex 且与本地一致时才能确认（md5Match=true）；
// 混淆时标注 md5Obfuscated，从不硬失败。size 校验由调用方负责（精确）。
function verifyAndBuild(remotePath, localPath, size, remoteMd5, dlinkExpiry, extra) {
  const localMd5 = md5File(localPath);
  const remoteHex = typeof remoteMd5 === "string" && /^[0-9a-f]{32}$/i.test(remoteMd5);
  let md5Match = null;
  if (remoteMd5 && remoteHex) {
    md5Match = localMd5 === remoteMd5.toLowerCase();
  }
  return {
    path: remotePath,
    localPath,
    size,
    md5: localMd5,
    remoteMd5,
    md5Match,
    md5Obfuscated: !!remoteMd5 && !remoteHex,
    dlinkExpiry,
    verified: true,
    ...extra,
  };
}

function md5File(filePath) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function spawnCurl(args, forwardStderr) {
  return new Promise((resolve) => {
    const { spawn } = childProc();
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => {
      if (forwardStderr) process.stderr.write(chunk);
    });
    child.on("error", (err) => resolve("SPAWN:" + err.message));
    child.on("close", (code) => resolve(code === null ? "CLOSED" : code));
  });
}

// 捕获 curl 的 -w 输出（stdout）+ 退出码
function spawnCurlCapture(args) {
  return new Promise((resolve) => {
    const { spawn } = childProc();
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => resolve({ exitCode: "SPAWN:" + err.message, stdout: "", stderr: "" }));
    child.on("close", (code) => resolve({ exitCode: code === null ? "CLOSED" : code, stdout, stderr }));
  });
}

function upload(localPath, remotePath) {
  return runPCS(["u", localPath, remotePath]);
}

function mkdir(remotePath) {
  return runPCS(["mkdir", remotePath]);
}

function remove(remotePath) {
  return runPCS(["rm", remotePath]);
}

// ── 容量分析 (du) ──────────────────────────────────────
//
// 百度没有服务端目录大小接口，只能递归 /api/list 求和。
// 并发遍历 + 深度限制 + 失败容忍；目录过多时给出部分结果与 failed 计数。

const DU_DEFAULT_DEPTH = 3;
const DU_DEFAULT_TOP = 15;
const DU_DEFAULT_CONCURRENCY = 8;

// 递归统计目录大小。返回 { size, files, dirs, failed }
async function du(dirPath, options = {}) {
  const depth = Math.min(Math.max(1, options.depth || DU_DEFAULT_DEPTH), 8);
  const concurrency = Math.min(Math.max(1, options.concurrency || DU_DEFAULT_CONCURRENCY), 16);
  const top = Math.max(1, options.top || DU_DEFAULT_TOP);
  const root = dirPath && dirPath !== "/" ? dirPath.replace(/\/+$/, "") : "/";

  const result = {
    path: root,
    size: 0,
    files: 0,
    dirs: 0,
    failed: 0,
    children: [], // { path, size, files }
    truncated: false,
    elapsedMs: 0,
  };
  const startedAt = Date.now();

  // 目录 → { size, files, children: Map<name, child> }
  const nodeFor = (p) => {
    let node = tree.get(p);
    if (!node) { node = { size: 0, files: 0, dirs: 0, children: new Map() }; tree.set(p, node); }
    return node;
  };

  const tree = new Map();
  const pending = [root];
  let completed = 0;
  const failedDirs = [];

  async function worker() {
    for (;;) {
      const dir = pending.pop();
      if (dir === undefined) return;
      const node = nodeFor(dir);
      let ok = false;
      try {
        for (let page = 1; page <= 50; page++) {
          const data = await getFileListPage(dir, page);
          if (!data || data.errno !== 0 || !Array.isArray(data.list)) break;
          ok = true;
          const list = data.list;
          for (const item of list) {
            const isDir = item.isdir === 1 || item.isdir === "1";
            const size = Number(item.size) || 0;
            node.size += size;
            if (isDir) {
              node.dirs++;
              const childPath = (dir === "/" ? "" : dir) + "/" + item.server_filename;
              const childNode = nodeFor(childPath);
              node.children.set(item.server_filename, childNode); // 登记父子关系
              if (dirDepth(childPath) <= depth) {
                pending.push(childPath);
              } else {
                // 深度封顶：不再下钻，只记录该子目录为独立叶子
                childNode.capped = true;
              }
            } else {
              node.files++;
            }
          }
          if (list.length < 100) break;
        }
      } catch {
        // 网络异常 → 计入失败
      }
      completed++;
      if (!ok) failedDirs.push(dir);
    }
  }

  function dirDepth(p) {
    if (p === "/") return 0;
    return p.split("/").filter(Boolean).length;
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);

  // 汇总：自底向上把 children 的聚合大小并入父节点（深度降序 → 子节点 total 先算好）
  const sortedPaths = [...tree.keys()].sort((a, b) => dirDepth(b) - dirDepth(a));
  for (const p of sortedPaths) {
    const node = tree.get(p);
    let childTotal = 0;
    for (const child of node.children.values()) {
      childTotal += child.total;
      node.files += child.files; // 文件/目录数同样聚合到父节点
      node.dirs += child.dirs;
    }
    node.total = node.size + childTotal;
    node.childList = [...node.children.entries()]
      .map(([name, c]) => ({ name, path: (p === "/" ? "" : p) + "/" + name, size: c.total, files: c.files, dirs: c.dirs, capped: !!c.capped }))
      .sort((a, b) => b.size - a.size);
  }

  const rootNode = tree.get(root);
  result.size = rootNode ? rootNode.total : 0;
  result.files = rootNode ? rootNode.files : 0;
  result.dirs = rootNode ? rootNode.dirs : 0;
  result.children = rootNode ? rootNode.childList.slice(0, top) : [];
  result.truncated = rootNode ? rootNode.childList.length > top : false;
  result.failed = failedDirs.length;
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

// /api/list 单页（含 bdstoken，复用 getFileMetaWeb 的链路）
async function getFileListPage(dir, page) {
  const bdstoken = await http.getBdstoken();
  const url =
    `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1` +
    `&page=${page}&num=100&dir=${encodeURIComponent(dir)}` +
    `&channel=chunlei&app_id=${http.APP_ID}&bdstoken=${encodeURIComponent(bdstoken)}`;
  return http.webJson(url);
}

module.exports = {
  ls, search, cat, head, tail, grep, peek,
  download, upload, mkdir, remove, du,
  getDlink, getFileMeta, getFileMetaWeb, fetchRangeText,
};
