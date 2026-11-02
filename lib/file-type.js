// lib/file-type.js — 二进制文件类型识别（魔数 + 扩展名兜底）
//
// 目标不是完整 MIME 表，而是回答两个问题：
//   1) 这是不是可以当文本读的文件？（否则 bdp cat 会把二进制乱码灌进 Agent 上下文）
//   2) 大概是什么类型？（让 bdp peek 报出 pdf/zip/image 这类可用的标签）

const MAGIC = [
  { type: "pdf",    bytes: [0x25, 0x50, 0x44, 0x46] },                              // %PDF
  { type: "zip",    bytes: [0x50, 0x4b, 0x03, 0x04] },                              // PK\x03\x04
  { type: "gzip",   bytes: [0x1f, 0x8b] },
  { type: "png",    bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "jpg",    bytes: [0xff, 0xd8, 0xff] },
  { type: "gif",    bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "bmp",    bytes: [0x42, 0x4d] },
  { type: "webp",   bytes: [0x52, 0x49, 0x46, 0x46] },                              // RIFF
  { type: "wav",    bytes: [0x52, 0x49, 0x46, 0x46] },                              // RIFF（容器，看扩展名细分）
  { type: "mp3",    bytes: [0x49, 0x44, 0x33] },
  { type: "flac",   bytes: [0x66, 0x4c, 0x61, 0x43] },
  { type: "elf",    bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { type: "exe",    bytes: [0x4d, 0x5a] },                                          // MZ
  { type: "rar",    bytes: [0x52, 0x61, 0x72, 0x21] },
  { type: "7z",     bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { type: "mkv",    bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { type: "mp4",    bytes: [0x66, 0x74, 0x79, 0x70] },                              // ftyp（偏移 4）
  { type: "sqlite", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] },
];

const EXT_TYPES = {
  pdf: "pdf", doc: "doc", docx: "docx", xls: "xls", xlsx: "xlsx", ppt: "ppt", pptx: "pptx",
  txt: "text", md: "text", markdown: "text", csv: "text", json: "text", jsonl: "text",
  xml: "text", html: "text", htm: "text", log: "text", ini: "text", cfg: "text",
  js: "text", mjs: "text", ts: "text", jsx: "text", tsx: "text", py: "text", rb: "text",
  c: "text", cpp: "text", h: "text", hpp: "text", go: "text", rs: "text", java: "text",
  sh: "text", bat: "text", ps1: "text", sql: "text", yaml: "text", yml: "text", toml: "text",
  epub: "epub", mobi: "book", azw3: "book", djvu: "book",
  zip: "zip", rar: "zip", "7z": "zip", gz: "zip", tgz: "zip", tar: "zip", bz2: "zip", xz: "zip",
  png: "image", jpg: "image", jpeg: "image", gif: "image", bmp: "image", webp: "image",
  tif: "image", tiff: "image", heic: "image", svg: "image",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio", wma: "audio",
  mp4: "video", mkv: "video", mov: "video", avi: "video", wmv: "video", flv: "video", m4v: "video",
};

const ZIP_CONTAINER_TYPES = ["docx", "xlsx", "pptx", "epub"];
const BINARY_CATEGORIES = ["image", "audio", "video"];

function extOf(p) {
  const base = String(p || "").split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

// 魔数检测（支持偏移量，如 mp4 的 "ftyp" 在偏移 4）
function magicType(buf) {
  if (!buf || buf.length < 4) return null;
  for (const m of MAGIC) {
    const off = m.type === "mp4" ? 4 : 0;
    if (buf.length < off + m.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (buf[off + i] !== m.bytes[i]) { ok = false; break; }
    }
    if (ok) return m.type;
  }
  return null;
}

// NUL 字节是二进制最可靠的信号之一（纯文本文件里几乎不会出现）
function hasNul(buf, limit = 8192) {
  const end = Math.min(buf.length, limit);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 综合判定文件类型。
 * @param {Buffer} buf 文件头部字节
 * @param {string} p   文件路径（用于扩展名兜底）
 * @returns {{ type: string, binary: boolean, reason: string }}
 */
function detectFileType(buf, p) {
  const magic = magicType(buf);
  const ext = extOf(p);
  const extType = EXT_TYPES[ext] || null;

  if (magic) {
    if (magic === "zip") {
      const t = extType && ZIP_CONTAINER_TYPES.includes(extType) ? extType : "zip";
      return { type: t, binary: true, reason: "magic:zip" };
    }
    if (magic === "riff") {
      const t = extType === "wav" ? "wav" : extType === "webp" ? "webp" : "binary";
      return { type: t, binary: true, reason: "magic:riff" };
    }
    return { type: magic, binary: true, reason: `magic:${magic}` };
  }
  if (hasNul(buf)) {
    return { type: extType || "binary", binary: true, reason: "nul-byte" };
  }
  if (extType === "book") {
    return { type: extType, binary: true, reason: `ext:${ext}` };
  }
  if (extType && BINARY_CATEGORIES.includes(extType)) {
    return { type: extType, binary: true, reason: `ext:${ext}` };
  }
  return { type: extType || "text", binary: false, reason: "text" };
}

module.exports = { detectFileType, magicType, hasNul, extOf, EXT_TYPES };
