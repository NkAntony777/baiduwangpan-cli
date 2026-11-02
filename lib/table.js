// lib/table.js — BaiduPCS-Go pcstable 表格解析（共享模块）
//
// BaiduPCS-Go 用 tablewriter 渲染表格：无边框、无列分隔符、列按**显示宽度**对齐。
// 含 CJK 时各行的码元偏移并不一致（一个汉字占 2 列），必须先换算成显示宽度再切片。
//
// 本模块被 pan.js（ls/search 结构化）与 pcs-extra.js（share list 等）共用。

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };

// 解析 "1.234567GB" / "129B" / "100 MB" → 字节数；无法解析返回 null
function parseSizeText(text) {
  const m = String(text || "").trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB)?$/i);
  if (!m) return null;
  const unit = (m[2] || "B").toUpperCase();
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[unit]);
}

// 东亚宽字符（CJK/全角等）显示宽度近似，对应 go-runewidth 的 East Asian Width W/F:
// 计 2 列，其余字符计 1 列。表头/数据行均按此规则渲染，切分即自洽。
const WIDE_CHAR_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function dispWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return w;
}

// 在 line 中取显示宽度 [startDisp, endDisp) 覆盖的码元区间
function sliceByDisplay(line, startDisp, endDisp) {
  const len = line.length;
  const dispAt = new Array(len + 1);
  let d = 0;
  for (let i = 0; i < len; i++) {
    dispAt[i] = d;
    d += dispWidth(line[i]);
  }
  dispAt[len] = d;
  let s = len;
  let e = len;
  for (let i = 0; i <= len; i++) {
    if (s === len && dispAt[i] >= startDisp) s = i;
    if (dispAt[i] >= endDisp) {
      e = i;
      break;
    }
  }
  return line.slice(s, e);
}

// 解析 BaiduPCS-Go 的 pcstable 表格。
// 原理: 表头与数据行在同一表格渲染下列起始显示偏移一致 → 用表头标题的显示位置切分每行。
// 表头找不到返回 null。
function parseTable(output, titles) {
  const lines = String(output).split(/\r?\n/).filter((l) => l.trim() !== "");
  const headerIdx = lines.findIndex((l) => titles.every((t) => l.includes(t)));
  if (headerIdx === -1) return null;
  const header = lines[headerIdx];
  const offsets = [];
  let pos = 0;
  for (const t of titles) {
    const idx = header.indexOf(t, pos);
    if (idx === -1) return null;
    offsets.push(dispWidth(header.slice(0, idx)));
    pos = idx + t.length;
  }
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = [];
    for (let c = 0; c < titles.length; c++) {
      const start = offsets[c];
      const end = c + 1 < titles.length ? offsets[c + 1] : dispWidth(lines[i]);
      cells.push(sliceByDisplay(lines[i], start, end).trim());
    }
    rows.push(cells);
  }
  return rows;
}

// "2026-01-07 14:15:59" → 本地时区 epoch 毫秒；无法解析返回 null
function parseMtime(text) {
  const s = String(text || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const t = new Date(s.replace(" ", "T")).getTime();
  return Number.isNaN(t) ? null : t;
}

// 引擎数据行的结构：<序号> <大小> <日期时间> <名称/路径>
//
// 关键：不能用"表头标题的显示偏移"来切列 —— go-olekukonko/tablewriter 的
// 表头是**居中**的，数据单元格按类型对齐（数字右对齐、字符串左对齐），
// 因此表头与数据的列偏移并不一致（实测 ls 表头"修改日期"在 disp 25，
// 数据日期在 disp 19），按偏移切会整体错位。
//
// 可靠锚点是日期列："YYYY-MM-DD HH:MM:SS" 格式唯一且固定宽度。
const ROW_RE = /^\s*(\d+)\s+(.*?)\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s+(.*?)\s*$/;

// 解析一行 → { index, sizeText, mtimeText, rest }；不是数据行返回 null
function parseEngineRow(line) {
  const m = String(line).match(ROW_RE);
  if (!m) return null;
  let sizeText = m[2].trim();
  if (sizeText === "-" || sizeText === "") sizeText = null;
  return {
    index: parseInt(m[1], 10),
    sizeText,
    mtimeText: m[3],
    rest: m[4],
  };
}

// ls / search 共用的行 → 结构化条目
function rowToEntry(row, { pathPrefix, isSearch }) {
  if (!row) return null;
  const isDir = row.rest.endsWith("/") || row.sizeText === null;
  const name = isSearch
    ? (row.rest.split("/").pop() || row.rest)
    : row.rest.replace(/\/+$/, "");
  const fullPath = isSearch ? row.rest : joinPath(pathPrefix, row.rest);
  return {
    index: row.index,
    name,
    path: fullPath,
    isDir,
    sizeText: row.sizeText,
    size: row.sizeText ? parseSizeText(row.sizeText) : null,
    mtimeText: row.mtimeText,
    mtime: parseMtime(row.mtimeText),
  };
}

function joinPath(prefix, name) {
  if (!prefix || prefix === "/") return "/" + name;
  return prefix.replace(/\/+$/, "") + "/" + name;
}

// 表尾汇总行： "总: 239.34MB   文件总数: 5, 目录总数: 19"
function parseFooter(output) {
  const m = String(output).match(/总:\s*([^\s]+)\s+文件总数:\s*(\d+),\s*目录总数:\s*(\d+)/);
  if (!m) return { totalText: null, fileCount: null, dirCount: null };
  return {
    totalText: m[1],
    fileCount: parseInt(m[2], 10),
    dirCount: parseInt(m[3], 10),
  };
}

// bdp ls 输出 → { entries, totalText, fileCount, dirCount }
function parseLsTable(output, pathPrefix = "/") {
  const lines = String(output).split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const e = rowToEntry(parseEngineRow(line), { pathPrefix, isSearch: false });
    if (e) entries.push(e);
  }
  return { entries, ...parseFooter(output) };
}

// bdp search 输出 → { entries, totalText, fileCount, dirCount }
function parseSearchTable(output) {
  const lines = String(output).split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const e = rowToEntry(parseEngineRow(line), { pathPrefix: null, isSearch: true });
    if (e) entries.push(e);
  }
  return { entries, ...parseFooter(output) };
}

module.exports = {
  dispWidth, sliceByDisplay, parseTable,
  parseSizeText, parseMtime, parseEngineRow,
  parseLsTable, parseSearchTable,
};
