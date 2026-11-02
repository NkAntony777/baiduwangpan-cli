// lib/pdf.js — PDF 文本提取（纯 JS 实现，无外部依赖）
//
// 难点：中文 PDF 通常用 Type0 字体 + Identity-H 编码，
// 文本在内容流里是十六进制 CID（如 <0797>），必须解析字体对象的
// ToUnicode CMap 才能还原成中文。
//
// 流程：
//   1. 读文件尾部 → 找 startxref → 定位 xref 表 → 解析对象偏移
//   2. 收集所有对象；找出 /Type /Page 的页面对象与其 /Contents 流
//   3. 收集字体对象的 /ToUnicode → 解析 bfchar/bfrange → 建 CID→Unicode 映射
//   4. 解压内容流 → 抽 Tj/TJ → 经当前字体映射还原文本
//
// 局限（诚实说明）：
//   - 不支持加密 PDF
//   - 不做完整 CID 字体 fallback，只用 ToUnicode
//   - 扫描件（无文本层）无法提取，会明确报告
//   - 对象流（ObjStm）内的对象可能取不到，此时降级为全文件流扫描

const zlib = require("zlib");

/**
 * 从 PDF 字节中提取文本。
 * @param {Buffer} buf 完整 PDF（或至少覆盖大部分对象的部分）
 * @param {object} options { maxPages }
 * @returns {{ text: string, pages: number, fonts: number, hasText: boolean, note?: string }}
 */
function extractText(buf, options = {}) {
  const maxPages = options.maxPages || 50;
  const result = { text: "", pages: 0, fonts: 0, hasText: false };

  if (!buf || buf.length < 16) {
    result.note = "文件太小，不是有效 PDF";
    return result;
  }
  const s = buf.toString("latin1");
  if (!s.startsWith("%PDF")) {
    result.note = "不是 PDF 文件（缺少 %PDF 头）";
    return result;
  }
  // 加密判定要早于"文件太小"——否则短小的加密 PDF 会误报为格式错误
  if (/\/Encrypt\s/.test(s)) {
    result.note = "PDF 已加密，无法提取文本";
    return result;
  }
  if (buf.length < 32) {
    result.note = "文件太小，不是有效 PDF";
    return result;
  }

  const objects = collectObjects(buf, s);

  // 建立对象号 → 偏移 的索引（xref 或暴力扫描）
  const offsets = parseXrefOffsets(s) || bruteForceOffsets(s);

  // 字体 → ToUnicode 映射
  const fontMaps = buildFontMaps(s, objects, offsets, buf);

  // 页面资源里的 字体名 → 字体对象号（全局并集，够用且不依赖页序）
  const resFonts = buildGlobalResourceFonts(s, objects, offsets);

  // 页面内容流 + 每页的字体资源映射
  const collected = collectPageContents(s, objects, offsets);
  const contentRefs = collected.refs;

  const chunks = [];
  let pages = 0;
  let fontCount = 0;

  if (contentRefs.length) {
    // 建立 全局字体名 → 对象号 的兜底表（页面资源可能不全，用全局补齐）
    const globalFonts = new Map();
    for (const [, num] of objects) {
      if (num && /\/Type\s*\/Font/.test(num.body)) {
        const nu = num.body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
        if (nu) globalFonts.set(String(parseInt(nu[1], 10)), true);
      }
    }
    void globalFonts;

    for (const ref of contentRefs.slice(0, maxPages)) {
      const stream = getStream(buf, s, objects, offsets, ref);
      if (!stream) continue;
      let inflated = null;
      try {
        inflated = zlib.inflateSync(stream);
      } catch {
        try {
          inflated = zlib.inflateRawSync(stream);
        } catch {
          inflated = stream;
        }
      }
      const text = extractTextFromContent(inflated, fontMaps, resFonts);
      if (text.trim()) {
        chunks.push(text);
        pages++;
      }
    }
    fontCount = fontMaps.size;
  }

  if (!chunks.length) {
    // 降级：扫描全文件所有流
    const fallback = scanAllStreams(buf, s, fontMaps);
    if (fallback.trim()) {
      result.text = fallback;
      result.hasText = true;
      result.pages = pages || 1;
      result.fonts = fontCount;
      result.degraded = true;
      return result;
    }
    result.note =
      "未提取到文本层（可能是扫描件/图片型 PDF）；可 bdp get 下载后本地 OCR";
    return result;
  }

  result.text = chunks.join("\n\n");
  result.hasText = true;
  result.pages = pages;
  result.fonts = fontCount;
  return result;
}

/**
 * 收集 PDF 中所有 "N G obj ... endobj" 的原始文本。
 * 用于暴力模式下按对象号取内容。
 */
/**
 * 收集 PDF 中所有 "N G obj ... endobj" 的原始文本。
 *
 * 安全：早先的实现对每个匹配到的 obj 都从当前位置重新 indexOf("endobj") 扫到文件尾，
 * 单次 O(n)、匹配次数 n → 总计 O(n^2)。构造一个只有大量 obj、故意不写 endobj 的 PDF
 * 就能让 CPU 占用飙升数小时（实测 64K obj / 1.86MB → 25 秒；按 n^2 外推 64MB → 数小时）。
 * 改为单条正则的非重叠匹配 —— 全局惰性匹配的总扫描量是 O(n)。
 * 同时加对象数上限，超限时停止收集（降级即可，不能被拖死）。
 */
const MAX_PDF_OBJECTS = 200000;

/**
 * 收集 PDF 中所有 "N G obj ... endobj" 的原始文本。
 *
 * 安全：早先的实现对每个匹配到的 obj 都从当前位置重新 indexOf("endobj") 扫到文件尾，
 * 单次 O(n)、匹配次数 n → 总计 O(n^2)。构造一个只有大量 obj、故意不写 endobj 的 PDF
 * 就能让 CPU 占用飙升数小时（实测 64K obj / 1.86MB → 25 秒；按 n^2 外推 64MB → 数小时）。
 *
 * 改为两步线性扫描：
 *   1. 一次性收集所有 endobj 的位置（单趟正则扫描，O(n)）
 *   2. 单趟扫描所有 obj 关键字，用二分查找定位它后面的第一个 endobj
 * 全程 O(n log n)，且没有任何从当前位置扫到文件尾的操作。
 */

function collectObjects(buf, s) {
  const map = new Map();

  // 第 1 步：收集所有 endobj 位置（单趟扫描）
  const endPositions = [];
  const endRe = /endobj\b/g;
  let em;
  while ((em = endRe.exec(s)) !== null) {
    endPositions.push(em.index);
    if (endPositions.length > MAX_PDF_OBJECTS) break;
  }

  // 第 2 步：单趟扫描 obj 关键字
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let om;
  let count = 0;
  while ((om = objRe.exec(s)) !== null) {
    if (++count > MAX_PDF_OBJECTS) break;
    const num = parseInt(om[1], 10);
    const bodyStart = om.index + om[0].length;

    // 二分查找 bodyStart 之后的第一个 endobj
    let lo = 0;
    let hi = endPositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (endPositions[mid] < bodyStart) lo = mid + 1;
      else hi = mid;
    }
    const endIdx = lo < endPositions.length ? endPositions[lo] : s.length;
    const body = s.slice(bodyStart, endIdx);

    map.set(num, {
      start: bodyStart,
      end: endIdx,
      body,
      bodyStart, // 字节偏移，供在原始 Buffer 上精确切流
    });
  }
  return map;
}



/** 解析 startxref → xref 表 → { objNum: offset } */
function parseXrefOffsets(s) {
  const m = s.match(/startxref\s+(\d+)\s+%%EOF/);
  if (!m) return null;
  const offsets = new Map();
  const xrefPos = parseInt(m[1], 10);
  // 简易 xref 表解析：连续 "N G obj" 形式
  const table = s.slice(xrefPos, xrefPos + 200000);
  const re = /^(\d+)\s+(\d+)\s+obj\s*$/gm;
  let mm;
  while ((mm = re.exec(table)) !== null) {
    // 找到该行前面 20 字节里的 offset 字段
    const lineStart = table.lastIndexOf("\n", mm.index);
    const prev = table.slice(Math.max(0, lineStart - 24), lineStart).trim();
    const fields = prev.split(/\s+/);
    const off = parseInt(fields[0], 10);
    if (!Number.isNaN(off)) offsets.set(parseInt(mm[1], 10), off);
  }
  if (!offsets.size) return null;
  return offsets;
}

/** 暴力扫描所有 obj 的偏移（xref 不可靠时的 fallback） */
function bruteForceOffsets(s) {
  const offsets = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    offsets.set(parseInt(m[1], 10), m.index);
  }
  return offsets;
}

/**
 * 建立字体对象号 → CID→Unicode 映射。
 */
function buildFontMaps(s, objects, offsets, buf) {
  const maps = new Map(); // fontObjNum → Map(cid -> unicode string)
  const fontObjNums = new Set();

  // 找所有字体对象
  const re = /\/Type\s*\/Font\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // 向前找最近的 "N 0 obj"
    const before = s.lastIndexOf("obj", m.index);
    if (before < 0) continue;
    const head = s.slice(Math.max(0, before - 20), before);
    const numMatch = head.match(/(\d+)\s+\d+\s*$/);
    if (numMatch) fontObjNums.add(parseInt(numMatch[1], 10));
  }

  for (const num of fontObjNums) {
    const body = getObjectBody(s, objects, offsets, num);
    if (!body) continue;
    const tuMatch = body.match(/\/ToUnicode\s+(\d+)\s+(\d+)\s+R/);
    if (!tuMatch) continue;
    const cmapObjNum = parseInt(tuMatch[1], 10);
    const cmapBody = getObjectBody(s, objects, offsets, cmapObjNum);
    if (!cmapBody) continue;
    const cmapObj = objects.get(cmapObjNum);
    const stream = extractStreamBytes(cmapBody, buf, cmapObj ? cmapObj.bodyStart : undefined);
    if (!stream) continue;
    let text = "";
    let inflated = null;
    try {
      inflated = zlib.inflateSync(stream);
      text = inflated.toString("latin1");
    } catch {
      try {
        inflated = zlib.inflateRawSync(stream);
        text = inflated.toString("latin1");
      } catch {
        text = stream.toString("latin1");
      }
    }
    const map = parseToUnicodeCMap(text);
    if (map && map.size) maps.set(num, map);
  }
  return maps;
}

/** 取对象号对应的对象体文本 */
function getObjectBody(s, objects, offsets, num) {
  if (objects.has(num)) return objects.get(num).body;
  const off = offsets && offsets.get(num);
  if (off === undefined) return null;
  const head = s.slice(off, off + 200);
  const m = head.match(/(\d+)\s+(\d+)\s+obj\b/);
  if (!m) return null;
  const endIdx = s.indexOf("endobj", off);
  if (endIdx < 0) return null;
  return s.slice(off + m[0].length, endIdx);
}

/**
 * 从对象体里取出 stream 的原始字节。
 * 注意：body 是 latin1 字符串，往返转换会破坏二进制流内容，
 * 因此当提供了原始 buf 与 bodyStart 时，直接在 Buffer 上按字节偏移切。
 */
function extractStreamBytes(body, buf, bodyStart) {
  const idx = body.indexOf("stream");
  if (idx < 0) return null;
  let start = idx + "stream".length;
  if (body[start] === "\r") start++;
  if (body[start] === "\n") start++;
  const end = body.indexOf("endstream", start);
  if (end < 0) return null;

  if (buf && typeof bodyStart === "number") {
    // 字符串索引 == latin1 字节索引（每个字符 1 字节），可直接换算
    const bStart = bodyStart + start;
    const bEnd = bodyStart + end;
    if (bStart >= 0 && bEnd <= buf.length) return buf.slice(bStart, bEnd);
  }
  return Buffer.from(body.slice(start, end), "latin1");
}

/**
 * 解析 ToUnicode CMap：bfchar / bfrange。
 */
function parseToUnicodeCMap(text) {
  const map = new Map();
  // bfchar: <src> <dst>
  const bcRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bcRe.exec(text)) !== null) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) {
      const src = parseInt(mm[1], 16);
      const dst = mm[2] ? hexToUnicode(mm[2]) : "";
      if (!Number.isNaN(src)) map.set(src, dst);
    }
  }
  // bfrange: <lo> <hi> <dst>  或 <lo> <hi> [<d1> <d2> ...]
  const brRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = brRe.exec(text)) !== null) {
    const body = m[1];
    // 数组形式：<lo> <hi> [<d1> <d2> ...]
    const arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    let mm;
    while ((mm = arrRe.exec(body)) !== null) {
      const lo = parseInt(mm[1], 16);
      const hi = parseInt(mm[2], 16);
      const items = mm[3].match(/<([0-9A-Fa-f]*)>/g) || [];
      for (let i = 0; i < items.length && lo + i <= hi; i++) {
        map.set(lo + i, hexToUnicode(items[i].slice(1, -1)));
      }
    }
    // 连续形式：<lo> <hi> <dstStart>
    // 注意必须排除数组形式（dst 后面紧跟 [ 时不是连续形式）
    const seqRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>(?!\s*\[)/g;
    while ((mm = seqRe.exec(body)) !== null) {
      const lo = parseInt(mm[1], 16);
      const hi = parseInt(mm[2], 16);
      const baseHex = mm[3];
      const base = parseInt(baseHex, 16);
      const width = baseHex.replace(/^0+/, "").length || 1;
      for (let i = 0; i <= hi - lo && i < 65536; i++) {
        const v = (base + i).toString(16).padStart(width, "0");
        map.set(lo + i, hexToUnicode(v));
      }
    }
  }
  return map;
}

/** 十六进制字符串 → Unicode（UTF-16BE） */
function hexToUnicode(hex) {
  if (!hex) return '';
  let out = '';
  // bfrange 连续形式的 dst 可能是 1-4 位（单字节码）
  const step = hex.length % 4 === 0 ? 4 : 2;
  for (let i = 0; i + step <= hex.length; i += step) {
    const chunk = hex.slice(i, i + step);
    const code = parseInt(chunk, 16);
    if (Number.isNaN(code)) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

/** 收集页面内容流引用 */
function collectPageContents(s, objects, offsets) {
  const refs = [];
  const pageFonts = [];
  const re = /\/Type\s*\/Page[^s]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // 找该 Page 对象内的 /Contents
    const before = s.lastIndexOf("obj", m.index);
    if (before < 0) continue;
    const head = s.slice(Math.max(0, before - 20), before);
    const numMatch = head.match(/(\d+)\s+\d+\s*$/);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1], 10);
    const body = getObjectBody(s, objects, offsets, num);
    if (!body) continue;
    const cRe = /\/Contents\s+(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/g;
    let cm;
    while ((cm = cRe.exec(body)) !== null) {
      if (cm[1]) {
        refs.push(parseInt(cm[1], 10));
      } else if (cm[2]) {
        const arrRe = /(\d+)\s+\d+\s+R/g;
        let am;
        while ((am = arrRe.exec(cm[2])) !== null) refs.push(parseInt(am[1], 10));
      }
    }
    // 字体资源映射挂在 Page 对象的 /Resources 里（内联字典或间接引用）
    const resFont = extractResourceFonts(body, objects, offsets, s);
    for (const [name, num] of resFont) pageFonts.push({ page: num, name, obj: num });
  }
  // 去重保序
  return { refs: [...new Set(refs)], pageFonts };
}

/**
 * 汇总所有页面的字体资源映射：字体名 → 字体对象号。
 * PDF 里 /FT13 这类资源名通常全局唯一（各页复用同一套），
 * 因此取并集即可，无需严格按页配对。
 */
function buildGlobalResourceFonts(s, objects, offsets) {
  const map = new Map();
  for (const [, o] of objects) {
    if (!/\/Type\s*\/Page[^s]/.test(o.body)) continue;
    const res = extractResourceFonts(o.body, objects, offsets, s);
    for (const [name, num] of res) {
      if (!map.has(name)) map.set(name, num);
    }
  }
  return map;
}

/**
 * 从 Page 对象的 /Resources 字典里解析 /Font 名字 → 字体对象号。
 * 形如 /Resources<</Font<</FT13 13 0 R /FT8 8 0 R>>>> 或 /Resources 5 0 R
 */
function extractResourceFonts(pageBody, objects, offsets, s) {
  const map = new Map();

  const collectFrom = (text) => {
    // 找 /Font 后面的字典
    const fi = text.indexOf("/Font");
    if (fi < 0) return;
    const after = text.slice(fi);
    const re = /\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = re.exec(after)) !== null) {
      // 只取 /Font 字典范围内的引用（遇到下一个顶层键就停）
      const idx = m.index;
      const between = after.slice(0, idx);
      // 若中途出现新的顶级字典起点，说明已越界
      const closeIdx = between.lastIndexOf("<<");
      const openIdx = between.lastIndexOf(">>");
      if (openIdx > closeIdx) break;
      map.set("/" + m[1], parseInt(m[2], 10));
    }
  };

  // 情况 1：内联 /Resources<</Font<...>>>
  const inline = pageBody.match(/\/Resources\s*<<([\s\S]*)/);
  if (inline) collectFrom(inline[1]);

  // 情况 2：/Resources N 0 R → 间接对象
  const ind = pageBody.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if (ind) {
    const resBody = getObjectBody(s, objects, offsets, parseInt(ind[1], 10));
    if (resBody) collectFrom(resBody);
  }
  return map;
}

/** 取指定对象号的 stream 字节 */
function getStream(buf, s, objects, offsets, num) {
  const body = getObjectBody(s, objects, offsets, num);
  if (!body) return null;
  const obj = objects.get(num);
  return extractStreamBytes(body, buf, obj ? obj.bodyStart : undefined);
}

/**
 * 从内容流抽文本，跟踪当前字体（Tf）以套用对应 ToUnicode 映射。
 */
function extractTextFromContent(content, fontMaps, resFonts) {
  const cs = content.toString('latin1');
  const out = [];
  const resFontMap = resFonts || new Map();
  let currentMap = null;

  // PDF 运算符不带斜杠（Tj / TJ / Tf / BT / ET）；
  // 只有具名对象引用带斜杠（/FT8）。因此顺序：先匹配具名引用，再匹配运算符。
  const tokenRe = /(\/[A-Za-z0-9#+._-]+)|([A-Za-z]+)|(\([^)]*\))|(<[0-9A-Fa-f\s]*>)|(-?\d+\.?\d*)|(\[[^\]]*\])/g;
  let stack = [];
  let t;
  let pendingNewline = false;
  while ((t = tokenRe.exec(cs)) !== null) {
    if (t[1]) {
      if (stack.length > 12) stack.shift();
      stack.push(t[1]);
      continue;
    }
    if (t[2]) {
      const op = t[2];
      if (op === 'Tf') {
        const rawName = stack[stack.length - 2];
        if (rawName !== undefined) {
          const fontName = rawName.startsWith('/') ? rawName : '/' + rawName;
          const objNum = resFontMap.get(fontName);
          currentMap = objNum !== undefined ? fontMaps.get(objNum) : null;
        }
        stack = [];
      } else if (op === 'Tj' || op === 'TJ' || op === String.fromCharCode(39) || op === String.fromCharCode(34)) {
        const raw = stack[stack.length - 1];
        if (raw !== undefined) {
          const txt = decodePdfOperand(raw, currentMap);
          if (txt) {
            if (pendingNewline && out.length) out.push('\n');
            pendingNewline = false;
            out.push(txt);
          }
        }
        stack = [];
      } else if (op === 'Tm' || op === 'T*') {
        // Tm（文本矩阵）或 T*（下一行）才是换行；
        // Td/TD 只是相对位移，常用于逐字排版，不能当换行。
        pendingNewline = true;
        stack = [];
      } else {
        stack = [];
      }
      continue;
    }
    if (stack.length > 12) stack.shift();
    stack.push(t[0]);
  }
  return out.join('');
}

/**
 * 解码一个 PDF 字符串操作数。
 * 支持三种形态：
 *   <hex>      十六进制串（Identity-H 时每 4 位 = 一个 2 字节 CID）
 *   (literal)  字面量串
 *   [ ... ]    TJ 数组 —— 元素为字符串，数字是字距修正量（忽略）
 *
 * TJ 数组是 PDF 生成器最常见的写法（带字距调整的文本）。
 * 早先的实现把整个数组当成一个 token 压栈，而解码函数只认 < 与 ( 开头，
 * 于是数组被静默丢弃 → 有文本层的 PDF 被误报为「扫描件」。
 */
function decodePdfOperand(raw, fontMap) {
  if (raw === undefined || raw === null) return "";

  // TJ 数组：逐元素解码，数字（字距修正）忽略
  if (raw.startsWith("[")) {
    const inner = raw.slice(1, raw.endsWith("]") ? -1 : undefined);
    const re = /(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()])*\))/g;
    let m;
    let out = "";
    while ((m = re.exec(inner)) !== null) {
      out += decodePdfOperand(m[0], fontMap);
    }
    return out;
  }

  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/\s+/g, "");
    if (!hex) return "";
    if (fontMap && fontMap.size) {
      // Identity-H：每 4 位十六进制 = 一个 2 字节 CID
      let out = "";
      const step = 4;
      for (let i = 0; i + step <= hex.length; i += step) {
        const cid = parseInt(hex.slice(i, i + step), 16);
        const u = fontMap.get(cid);
        if (u !== undefined) out += u;
      }
      if (out) return out;
    }
    // 无映射：当作 UTF-16BE 直解
    return hexToUnicode(hex);
  }

  if (raw.startsWith("(")) {
    const inner = raw.slice(1, -1);
    let bytes = "";
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "\\") {
        const c = inner[++i];
        if (c === "n") bytes += "\n";
        else if (c === "r") bytes += "\r";
        else if (c === "t") bytes += "\t";
        else bytes += c;
      } else bytes += inner[i];
    }
    // latin1 字节 → 若 fontMap 存在则按单字节 CID 查
    if (fontMap && fontMap.size) {
      let out = "";
      for (const ch of bytes) {
        const cid = ch.charCodeAt(0);
        const u = fontMap.get(cid);
        if (u !== undefined) out += u;
      }
      if (out) return out;
    }
    return bytes;
  }
  return "";
}


/** 降级：扫描文件里所有流，尝试抽文本 */
function scanAllStreams(buf, s, fontMaps) {
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  let count = 0;
  while ((m = re.exec(s)) !== null && count < 400) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const raw = buf.slice(start, end);
    let inflated = null;
    try {
      inflated = zlib.inflateSync(raw);
    } catch {
      try {
        inflated = zlib.inflateRawSync(raw);
      } catch {
        continue;
      }
    }
    count++;
    const t = inflated.toString("latin1");
    if (!/\bTj\b|\bTJ\b/.test(t)) continue;
    // 无字体映射时按字面文本算子抽
    const text = extractLiteralText(t);
    if (text.trim()) chunks.push(text);
    if (chunks.length > 30) break;
  }
  return chunks.join("\n");
}

/** 只抽字面量字符串（无 CID 映射时的兜底） */
function extractLiteralText(cs) {
  const out = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(cs)) !== null) {
    out.push(m[1].replace(/\\([nrtbf()\\])/g, " "));
  }
  return out.join("\n");
}

module.exports = {
  extractText,
  parseToUnicodeCMap,
  hexToUnicode,
  extractTextFromContent,
  collectObjects,
};
