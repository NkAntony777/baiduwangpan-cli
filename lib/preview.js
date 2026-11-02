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
function getDlink(remotePath) {
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

/** 通过 Range 读取文件的 [start, end] 字节 */
function readRange(dlink, start, end) {
  const cfg = require("./config").get();
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

  const dlink = getDlink(remotePath);
  if (!dlink) {
    result.error = "无法获取文件直链（引擎 locate 失败）";
    return result;
  }
  result.dlink = true;

  // 读文件头，判定类型
  const head = readRange(dlink, 0, 4095);
  const ft = detectFileType(head, remotePath);
  result.type = ft.type;
  result.detectReason = ft.reason;
  result.binary = ft.binary;

  const ext = extOf(remotePath);
  result.ext = ext;

  try {
    if (ft.type === "text" || ft.type === "text-ish") {
      return previewText(remotePath, dlink, maxBytes, result);
    }
    if (ft.type === "zip" || ft.type === "docx" || ft.type === "xlsx" || ft.type === "pptx" || ft.type === "epub") {
      return previewZip(remotePath, dlink, ext, options, result);
    }
    if (ft.type === "pdf") {
      return previewPdf(remotePath, dlink, options, result);
    }
    if (ft.type === "image") {
      return previewImage(remotePath, dlink, head, result);
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
function previewText(remotePath, dlink, maxBytes, result) {
  const buf = readRange(dlink, 0, maxBytes - 1);
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
function previewZip(remotePath, dlink, ext, options, result) {
  // 需要文件大小来算尾部偏移 —— 用 HEAD 请求
  const size = fetchSize(dlink);
  result.size = size;
  if (!size) {
    result.error = "无法获取文件大小";
    return result;
  }

  const tailLen = Math.min(size, DEFAULT_ZIP_TAIL);
  const tailStart = Math.max(0, size - tailLen);
  const tail = readRange(dlink, tailStart, size - 1);
  const parsed = zip.parseCentralDirectory(tail, tailStart);
  if (!parsed) {
    result.error = "未找到 ZIP 中央目录（可能不是 ZIP 或已损坏）";
    return result;
  }
  if (parsed.needCentralDirectory) {
    // 中央目录太大没落在尾部缓冲里 → 精确拉取
    const cd = readRange(dlink, parsed.cdOffset, parsed.cdOffset + parsed.cdSize - 1);
    const p2 = zip.parseCentralDirectory(cd, parsed.cdOffset);
    if (!p2 || p2.needCentralDirectory) {
      result.error = "ZIP 中央目录定位失败";
      return result;
    }
    parsed.entries = p2.entries;
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
      const meta = readZipMemberRemote(dlink, size, opf);
      if (meta) {
        result.metadata = parseOpfMetadata(meta);
      }
    }
  }
  // DOCX：抽 word/document.xml 的文字
  if (ext === "docx") {
    const doc = entries.find((e) => e.name === "word/document.xml");
    if (doc) {
      const xml = readZipMemberRemote(dlink, size, doc);
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
      const xml = readZipMemberRemote(dlink, size, ss);
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
function readZipMemberRemote(dlink, fileSize, entry) {
  try {
    const lfhBuf = readRange(dlink, entry.localOffset, entry.localOffset + 30 + 512);
    const lfh = zip.parseLocalFileHeader(lfhBuf);
    if (!lfh) return null;
    const start = entry.localOffset + lfh.dataOffset;
    const comp = readRange(dlink, start, start + entry.compSize - 1);
    return zip.inflateMember(comp, entry.method, { maxBytes: MAX_MEMBER_BYTES });
  } catch {
    return null;
  }
}

/** 取文件大小（Content-Length / Content-Range） */
function fetchSize(dlink) {
  const { spawnSync } = require("child_process");
  const cfg = require("./config").get();
  try {
    const r = spawnSync("curl", ["-s", "-I", "-L", "--max-time", "20", dlink], {
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const headers = (r.stdout || "").split(/\r?\n/);
    for (const h of headers) {
      const m = h.match(/^content-length:\s*(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
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
    const m = xml.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
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
function previewPdf(remotePath, dlink, options, result) {
  const size = fetchSize(dlink);
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
  const buf = readRange(dlink, 0, size - 1);
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
function previewImage(remotePath, dlink, head, result) {
  result.size = fetchSize(dlink);
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
