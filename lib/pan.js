const { spawnSync } = require("child_process");
const config = require("./config");
const http = require("./http");

function runPCS(args) {
  const cfg = config.get();
  const result = spawnSync(cfg.pcsPath, args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`BaiduPCS-Go not found at: ${cfg.pcsPath}. Set pcsPath in config or BAIDUPCS_CMD env.`);
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

function getFileMeta(remotePath) {
  const output = runPCS(["meta", remotePath]);
  let size = null;

  let m = output.match(/大小[::]\s*([\d,]+)/);
  if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  if (!size) {
    m = output.match(/size[":\s]+(\d+)/i);
    if (m) size = parseInt(m[1], 10);
  }
  if (!size) {
    m = output.match(/(\d[\d,]*)\s*B\b/);
    if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  }

  let isDir = false;
  if (/目录|isdir.*1|is_dir.*true/i.test(output)) isDir = true;

  return { size, isDir, raw: output };
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
  if (!dlink) throw new Error(`Cannot get dlink for: ${remotePath}`);

  const readBytes = Math.min(meta.size || limit, limit) - 1;
  return fetchRangeText(dlink, 0, readBytes);
}

function head(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`Cannot get dlink for: ${remotePath}`);

  const chunkSize = Math.min(n * 4096 + 1024, limit);
  const text = fetchRangeText(dlink, 0, chunkSize - 1);
  const lines = text.split("\n");
  return lines.slice(0, n);
}

function tail(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const meta = getFileMeta(remotePath);
  if (!meta.size) throw new Error(`Cannot get file size for: ${remotePath}`);

  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`Cannot get dlink for: ${remotePath}`);

  const chunkSize = Math.min(n * 4096 + 1024, limit, meta.size);
  const start = Math.max(0, meta.size - chunkSize);
  const text = fetchRangeText(dlink, start, meta.size - 1);
  const lines = text.split("\n");
  return lines.slice(-n);
}

function grep(pattern, remotePath, options = {}) {
  const cfg = config.get();
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error(`Cannot get dlink for: ${remotePath}`);

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

function peek(remotePath) {
  const meta = getFileMeta(remotePath);
  const dlink = getDlink(remotePath);

  const result = {
    path: remotePath,
    size: meta.size,
    isDir: meta.isDir,
    dlink: !!dlink,
  };

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

function download(remotePath, saveTo) {
  const args = ["d", remotePath];
  if (saveTo) args.push("--saveto", saveTo);
  return runPCS(args);
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

module.exports = {
  ls, search, cat, head, tail, grep, peek,
  download, upload, mkdir, remove,
  getDlink, getFileMeta, fetchRangeText,
};
