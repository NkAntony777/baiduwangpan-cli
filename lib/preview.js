// lib/preview.js — 多类型内容预览（尽量不下载整个文件）
//
// 目标：让 Agent 能「看懂」网盘里的文件，而不必先下载再处理。
// 核心策略：按类型走不同的「最省字节」路径：
//   - 文本类（TXT/MD/CSV/JSON）：Range 读前 N KB，复用 GBK/UTF-8 自动解码
//   - ZIP 家族（ZIP/EPUB/DOCX/XLSX/PPTX）：只拉文件尾部的中央目录，
//     列出成员；EPUB/DOCX 进一步按需拉单个成员解出正文
//   - PDF：Range 读尾部找 xref/trailer，再拉内容流，抽取文本算子
//   - 图片：读文件头解析尺寸/色彩信息
//
// 全部走 Range 请求，不整包下载。

const zlib = require("zlib");
const http = require("./http");
const zip = require("./zip");
const { detectFileType, extOf } = require("./file-type");
const { decodeTextWithEncoding } = require("./pan");
const pdfLib = require("./pdf");

const DEFAULT_TEXT_BYTES = 64 * 1024;      // 文本预览 64KB
const DEFAULT_ZIP_TAIL = 128 * 1024;       // 中央目录尾读 128KB
const MAX_PREVIEW_BYTES = 512 * 1024;      // 单次 Range 读取上限
const MAX_PDF_BYTES = 64 * 1024 * 1024;      // PDF 整文件读取上限 64MB（防超大文件 OOM）
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;   // ZIP 单成员解压上限 64MB（防 zip bomb）

/**
 * 取文件直链。优先用引擎 locate（快），失败回退 web API。
 */
/**
 * 取文件的下载直链。
 *
 * 优先走 web API（/api/filemetas?dlink=1）—— 纯异步，不阻塞事件循环；
 * 失败时回退引擎 locate（同步 spawnSync，会阻塞）。
 *
 * 为什么重要：preview/index 的每个文件都要取一次直链。
 * 若这一步是同步的，整个索引构建就退化成串行（实测 1.6 s/文件）。
 *
 * @param {string} remotePath
 * @param {object} options { fsId } 已知 fs_id 时可省一次 list 查询
 * @returns {Promise<string|null>}
 */
// /api/list 分页大小（与 pan.js / dedup.js 保持一致）
const API_LIST_PAGE_SIZE = (http && http.API_LIST_PAGE_SIZE) || 500;

async function getDlink(remotePath, options = {}) {
  // 1) web API 路径（异步）
  try {
    const bdstoken = await http.getBdstoken();
    let fsId = options.fsId;
    if (!fsId) {
      // 父目录可能超过一页：必须翻页找，不能只看 page=1
      // （此前只查 page=1 → 文件排在第 100 条之后时静默回落到阻塞的引擎 locate，
      //   表现为「大目录里的文件预览悄悄慢 10 倍」）。
      const base = baseNameOf(remotePath);
      const parent = parentDirOf(remotePath);
      let hit = null;
      for (let page = 1; page <= 20 && !hit; page++) {
        const listUrl =
          "https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1" +
          "&page=" + page + "&num=" + API_LIST_PAGE_SIZE +
          "&dir=" + encodeURIComponent(parent) +
          "&channel=chunlei&app_id=" + http.APP_ID + "&bdstoken=" + encodeURIComponent(bdstoken);
        const list = await http.webJson(listUrl);
        if (!list || list.errno !== 0 || !Array.isArray(list.list)) break;
        hit = list.list.find((x) => x.server_filename === base) || null;
        if (!hit && list.list.length < API_LIST_PAGE_SIZE) break; // 翻页结束仍未找到
      }
      if (!hit) return null;
      fsId = hit.fs_id;
    }
    const fmUrl =
      "https://pan.baidu.com/api/filemetas?dlink=1&fsids=" + encodeURIComponent(JSON.stringify([fsId])) +
      "&web=1&app_id=" + http.APP_ID + "&bdstoken=" + encodeURIComponent(bdstoken);
    const fm = await http.webJson(fmUrl);
    const item = fm.info && fm.info[0];
    if (item && item.dlink) return item.dlink;
  } catch {
    // 落回引擎
  }

  // 2) 引擎 locate（同步，作为兜底）
  const { spawnSync } = require("child_process");
  const config = require("./config");
  const cfg = config.get();
  try {
    const r = spawnSync(cfg.pcsPath, ["locate", remotePath], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const urls = out.match(/https?:\/\/[^\s]+/g);
    if (urls && urls.length) return urls[0].replace(/[,\s]+$/, "");
  } catch {}
  return null;
}

/** 取父目录（根路径的父是 /） */
function parentDirOf(p) {
  const s = String(p || "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  if (i <= 0) return "/";
  return s.slice(0, i);
}

/** 取文件名 */
function baseNameOf(p) {
  const s = String(p || "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}


/** 通过 Range 读取文件的 [start, end] 字节 */
/**
 * Range 读取（异步）。
 * native 传输走 fetch（真并发 + keep-alive）；curl 传输退回同步 spawnSync。
 */
async function readRange(dlink, start, end) {
  const cfg = require("./config").get();
  if (cfg.webTransport === "native") {
    return http.fetchRange(dlink, start, end, cfg.ua);
  }
  const buf = http.curlRange(dlink, start, end, cfg.ua);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
}

/**
 * 预览一个网盘文件。
 * @param {string} remotePath
 * @param {object} options { maxBytes, depth }
 */
async function preview(remotePath, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_TEXT_BYTES;
  const result = {
    path: remotePath,
    type: "unknown",
    truncated: false,
    size: null,
  };

  const dlink = await getDlink(remotePath, { fsId: options.fsId });
  if (!dlink) {
    result.error = "无法获取文件直链（引擎 locate 失败）";
    return result;
  }
  result.dlink = true;

  // 读文件头，判定类型
  const head = await readRange(dlink, 0, 4095);
  const ft = detectFileType(head, remotePath);
  result.type = ft.type;
  result.detectReason = ft.reason;
  result.binary = ft.binary;

  const ext = extOf(remotePath);
  result.ext = ext;

  try {
    if (ft.type === "text" || ft.type === "text-ish") {
      return await previewText(remotePath, dlink, maxBytes, result);
    }
    if (ft.type === "zip" || ft.type === "docx" || ft.type === "xlsx" || ft.type === "pptx" || ft.type === "epub") {
      return await previewZip(remotePath, dlink, ext, options, result);
    }
    if (ft.type === "pdf") {
      return await previewPdf(remotePath, dlink, options, result);
    }
    if (ft.type === "image") {
      return await previewImage(remotePath, dlink, head, result);
    }
    // 其他二进制：只报元信息
    result.note = "该类型暂不支持内容预览，仅返回元信息";
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

/** 文本预览：拉前 N KB 并按编码解码 */
async function previewText(remotePath, dlink, maxBytes, result) {
  const buf = await readRange(dlink, 0, maxBytes - 1);
  const dec = decodeTextWithEncoding(buf);
  result.encoding = dec.encoding;
  result.text = dec.text;
  result.bytes = buf.length;
  result.lines = dec.text.split("\n").length;
  result.truncated = buf.length >= maxBytes;
  return result;
}

/**
 * ZIP 家族预览：只拉尾部中央目录，列出成员。
 * EPUB / DOCX 额外抽取正文。
 */
async function previewZip(remotePath, dlink, ext, options, result) {
  // 文件大小：优先用调用方提供的（index-builder 从 /api/list 已拿到），
  // 否则发 HEAD 请求。
  const size = options.size || await fetchSize(dlink);
  result.size = size;
  if (!size) {
    result.error = "无法获取文件大小";
    return result;
  }

  const tailLen = Math.min(size, DEFAULT_ZIP_TAIL);
  const tailStart = Math.max(0, size - tailLen);
  const tail = await readRange(dlink, tailStart, size - 1);
  const parsed = zip.parseCentralDirectory(tail, tailStart);
  if (!parsed) {
    result.error = "未找到 ZIP 中央目录（可能不是 ZIP 或已损坏）";
    return result;
  }
  if (parsed.needCentralDirectory) {
    // 中央目录本身超过了尾部窗口（>128KB，约 1500+ 条目）→
    // 按 EOCD 记录的 cdOffset/cdSize 精确拉取中央目录再解析。
    // 注意：这块缓冲区内没有 EOCD，必须用 parseCentralDirectoryEntries，
    // 不能用 parseCentralDirectory（后者依赖 EOCD 定位，逻辑上必然失败）。
    const cd = await readRange(dlink, parsed.cdOffset, parsed.cdOffset + parsed.cdSize - 1);
    const entries = zip.parseCentralDirectoryEntries(cd, parsed.entryCount);
    if (!entries.length) {
      result.error = "ZIP 中央目录定位失败";
      return result;
    }
    parsed.entries = entries;
  }

  const entries = parsed.entries || [];
  result.entryCount = entries.length;
  result.entries = entries.map((e) => ({
    name: e.name,
    size: e.size,
    compSize: e.compSize,
    method: e.method,
    isDir: e.isDir,
  }));
  result.compressedTotal = entries.reduce((s, e) => s + (e.compSize || 0), 0);
  result.uncompressedTotal = entries.reduce((s, e) => s + (e.size || 0), 0);

  // EPUB：抽正文
  if (ext === "epub") {
    const opf = entries.find((e) => e.name && e.name.toLowerCase().endsWith(".opf"));
    if (opf) {
      const meta = await readZipMemberRemote(dlink, size, opf);
      if (meta) {
        result.metadata = parseOpfMetadata(meta);
      }
    }
  }
  // DOCX：抽 word/document.xml 的文字
  if (ext === "docx") {
    const doc = entries.find((e) => e.name === "word/document.xml");
    if (doc) {
      const xml = await readZipMemberRemote(dlink, size, doc);
      if (xml) {
        result.text = extractDocxText(xml);
        result.truncated = false;
      }
    }
  }
  // XLSX：抽共享字符串
  if (ext === "xlsx") {
    const ss = entries.find((e) => e.name === "xl/sharedStrings.xml");
    if (ss) {
      const xml = await readZipMemberRemote(dlink, size, ss);
      if (xml) {
        const strings = extractSharedStrings(xml);
        result.text = strings.join("\n");
        result.stringCount = strings.length;
      }
    }
  }
  return result;
}

/** 远程读取 ZIP 单个成员 */
async function readZipMemberRemote(dlink, fileSize, entry) {
  try {
    const lfhBuf = await readRange(dlink, entry.localOffset, entry.localOffset + 30 + 512);
    const lfh = zip.parseLocalFileHeader(lfhBuf);
    if (!lfh) return null;
    const start = entry.localOffset + lfh.dataOffset;
    const comp = await readRange(dlink, start, start + entry.compSize - 1);
    return zip.inflateMember(comp, entry.method, { maxBytes: MAX_MEMBER_BYTES });
  } catch {
    return null;
  }
}

/** 取文件大小（Content-Length / Content-Range） */
/**
 * 取文件大小。
 *
 * 优先异步 HEAD（不阻塞事件循环）；取 Content-Range 的总长（更可靠，
 * 因为部分 CDN 的 HEAD 响应 Content-Length 是 0 —— 那是 302 重定向的响应体）。
 * 失败时回退 curl -I。
 */
async function fetchSize(dlink) {
  const cfg = require("./config").get();
  try {
    // 走 http.fetchHead —— 带超时的 HEAD。裸 fetch 会让挂起的请求永久占住调用方。
    const res = await http.fetchHead(dlink, {
      "User-Agent": cfg.ua,
      // 百度 dlink 必须带 Cookie（实测：不带 → 403）
      Cookie: cfg.cookie || `BDUSS=${cfg.bduss}; STOKEN=${cfg.stoken}`,
      Referer: "https://pan.baidu.com/disk/main",
    });
    // Content-Range: bytes 0-4095/12345 → 总长 12345
    const cr = res.headers.get("content-range");
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    const cl = res.headers.get("content-length");
    if (cl && parseInt(cl, 10) > 0) return parseInt(cl, 10);
  } catch {
    // 落回 curl
  }

  const { spawnSync } = require("child_process");
  try {
    const r = spawnSync("curl", ["-s", "-I", "-L", "--max-time", "20", dlink], {
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const headers = (r.stdout || "").split(/\r?\n/);
    // 遍历所有 header 块，取**最后一个** content-length ——
    // curl -L 会依次打印 302 与最终响应，302 的 Content-Length 往往是 0
    let best = 0;
    for (const h of headers) {
      const m = h.match(/^content-length:\s*(\d+)/i);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v > best) best = v;
      }
    }
    if (best > 0) return best;
    for (const h of headers) {
      const m = h.match(/^content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
  } catch {}
  return null;
}


/** EPUB 的 OPF 元数据 */
function parseOpfMetadata(buf) {
  const xml = decodeXmlText(buf);
  const pick = (tag) => {
    const m = xml.match(new RegExp("<" + tag + "[^>]*>([\s\S]*?)</" + tag + ">", "i"));
    return m ? m[1].trim() : null;
  };
  const meta = {};
  for (const tag of ["title", "language", "creator", "publisher", "date", "identifier"]) {
    const v = pick(tag);
    if (v) meta[tag] = v.replace(/<[^>]+>/g, "").trim();
  }
  return meta;
}

/** DOCX 正文文字 */
function extractDocxText(xmlBuf) {
  const xml = decodeXmlText(xmlBuf);
  const out = [];
  const re = /<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>|<w:p[\s>]/g;
  const parts = xml.split(/<w:p[\s>]/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const texts = [];
    const tre = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = tre.exec(chunk)) !== null) {
      texts.push(decodeXmlEntities(m[1]));
    }
    if (texts.length) out.push(texts.join(""));
  }
  void re;
  return out.join("\n");
}

/** XLSX 共享字符串 */
function extractSharedStrings(xmlBuf) {
  const xml = decodeXmlText(xmlBuf);
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const texts = [];
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tre.exec(m[1])) !== null) texts.push(decodeXmlEntities(tm[1]));
    if (texts.length) out.push(texts.join(""));
  }
  return out;
}

/** OOXML 内部统一是 UTF-8；先剥 BOM 再解码 */
function decodeXmlText(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.slice(3);
  return b.toString('utf-8');
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&/g, "&");
}

/**
 * PDF 预览：定位 xref → 找页面内容流 → 抽取文本算子。
 * 这不是完整 PDF 解析器，只做「尽力而为」的文本提取。
 */
async function previewPdf(remotePath, dlink, options, result) {
  const size = options.size || await fetchSize(dlink);
  result.size = size;
  if (!size) {
    result.error = "无法获取 PDF 大小";
    return result;
  }
  // PDF 需要完整解析（xref/字体/内容流），因此整文件读入；
  // 但必须有上限 —— 用户网盘有 12GB 的 PDF，无上限会直接 OOM。
  // 这是唯一的例外——其余类型都走 Range 只读需要的字节。
  if (size > MAX_PDF_BYTES) {
    result.error =
      'PDF 超过预览上限 ' + Math.round(MAX_PDF_BYTES / 1048576) + 'MB（' +
      Math.round(size / 1048576) + 'MB），请用 bdp get 下载后本地处理';
    return result;
  }
  const buf = await readRange(dlink, 0, size - 1);
  const r = pdfLib.extractText(buf, { maxPages: options.maxPages || 200 });
  result.pages = r.pages;
  result.fonts = r.fonts;
  result.degraded = !!r.degraded;
  if (r.hasText) {
    result.text = r.text;
    result.extracted = true;
    result.truncated = r.pages >= (options.maxPages || 200);
  } else {
    result.note = r.note || "未提取到文本层";
    result.extracted = false;
  }
  return result;
}
/** 图片预览：解析尺寸 */
async function previewImage(remotePath, dlink, head, result) {
  result.size = result.size || await fetchSize(dlink);
  const dims = imageDimensions(head);
  if (dims) {
    result.width = dims.width;
    result.height = dims.height;
    result.format = dims.format;
  }
  result.note = "图片不做内容渲染；如需查看请用 bdp get 下载后本地处理";
  return result;
}

/** 从文件头解析图片尺寸 */
function imageDimensions(buf) {
  if (!buf || buf.length < 16) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  // GIF
  if (buf.slice(0, 3).toString("latin1") === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), format: "bmp" };
  }
  // JPEG：遍历段找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
          format: "jpeg",
        };
      }
      off += 2 + len;
    }
  }
  // WEBP
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
    const fmt = buf.slice(12, 16).toString("latin1");
    if (fmt === "VP8 " && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        format: "webp",
      };
    }
    if (fmt === "VP8X" && buf.length >= 30) {
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w + 1, height: h + 1, format: "webp" };
    }
  }
  return null;
}

module.exports = {
  preview,
  previewText,
  previewZip,
  previewPdf,
  previewImage,
  imageDimensions,
  extractDocxText,
  extractSharedStrings,
  parseOpfMetadata,
};
