// lib/index-builder.js — 从网盘构建本地全文索引
//
// 流程：遍历 → 过滤可索引类型 → 抽取文本 → 写入 SQLite FTS5
//
// 抽取策略（按类型选最省的路径）：
//   - 文本类（TXT/MD/CSV/JSON/XML/LOG…）：Range 读前 N KB → 自动识别 GBK/UTF-8
//   - PDF：读全文 → lib/pdf.js 抽取文本层
//   - DOCX/XLSX/PPTX/EPUB：读 ZIP 中央目录 → 抽正文
//   - 其他：只索引文件名与路径（轻量，永远可搜到）
//
// 增量：md5 + size 未变则跳过，重复 build 只更新变化的文件。

const http = require("./http");
const preview = require("./preview");
const { detectFileType, extOf } = require("./file-type");
const { decodeTextWithEncoding } = require("./pan");
const store = require("./index-store");

// 可做全文抽取的类型
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm",
  "log", "ini", "cfg", "conf", "yaml", "yml", "toml", "js", "mjs", "ts", "jsx",
  "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "php",
  "sh", "bat", "ps1", "sql", "srt", "vtt", "tex", "rst", "org", "srt",
]);

const DOC_EXTS = new Set(["docx", "xlsx", "pptx", "epub"]);
const PDF_EXTS = new Set(["pdf"]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件抽取上限 2MB
const DEFAULT_MAX_CONTENT = 512 * 1024;         // 入库文本上限 512KB

/**
 * 判断该文件是否值得做全文抽取。
 */
function isIndexable(file) {
  const ext = (file.ext || extOf(file.path)).toLowerCase();
  if (TEXT_EXTS.has(ext) || DOC_EXTS.has(ext) || PDF_EXTS.has(ext)) return true;
  return false;
}

/**
 * 抽取单个文件的文本内容。
 * @returns {Promise<{ text: string, kind: string, note?: string }>}
 */
async function extractContent(file, options = {}) {
  const maxBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const ext = (file.ext || extOf(file.path)).toLowerCase();

  try {
    if (TEXT_EXTS.has(ext)) {
      if (file.size > maxBytes) {
        // 太大：只取头部，标注截断
        const p = await preview.preview(file.path, { maxBytes: Math.min(maxBytes, 256 * 1024) });
        return { text: p.text || "", kind: "text", note: "文件过大，仅索引前部分" };
      }
      const p = await preview.preview(file.path, { maxBytes });
      if (p.error) return { text: "", kind: "text", note: p.error };
      return { text: p.text || "", kind: "text", encoding: p.encoding };
    }
    if (PDF_EXTS.has(ext)) {
      const p = await preview.preview(file.path, { maxPages: options.maxPages || 50 });
      if (p.error) return { text: "", kind: "pdf", note: p.error };
      if (!p.extracted) return { text: "", kind: "pdf", note: p.note || "无文本层" };
      return { text: p.text || "", kind: "pdf", pages: p.pages };
    }
    if (DOC_EXTS.has(ext)) {
      const p = await preview.preview(file.path);
      if (p.error) return { text: "", kind: "doc", note: p.error };
      return { text: p.text || "", kind: "doc" };
    }
  } catch (e) {
    return { text: "", kind: "unknown", note: e.message };
  }
  return { text: "", kind: "skipped" };
}

/**
 * 构建索引。
 * @param {string} root 起始目录
 * @param {object} options
 *   - dbPath    索引文件路径
 *   - maxFiles  最多索引多少个文件（0 = 不限）
 *   - include   只索引路径包含这些关键词的文件
 *   - exclude   排除路径包含这些关键词的文件
 *   - extract   是否做全文抽取（false = 只索引文件名）
 *   - onProgress 进度回调
 * @returns {Promise<object>} 统计
 */
async function buildIndex(root, options = {}) {
  const { scanFiles } = require("./dedup");
  const handle = store.openIndex(options.dbPath);
  const startedAt = Date.now();

  try {
    const scan = await scanFiles(root, {
      concurrency: options.concurrency || 6,
      maxDepth: options.maxDepth || 12,
      onProgress: options.onProgress,
    });

    let considered = 0;
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let contentBytes = 0;
    const maxFiles = options.maxFiles || 0;

    const includes = toArray(options.include);
    const excludes = toArray(options.exclude);

    for (const file of scan.files) {
      if (maxFiles && indexed >= maxFiles) break;

      if (includes.length && !includes.some((k) => file.path.includes(k))) continue;
      if (excludes.length && excludes.some((k) => file.path.includes(k))) continue;

      considered++;

      // 增量：内容未变则跳过
      if (options.incremental !== false && !store.needsReindex(handle, file)) {
        skipped++;
        continue;
      }

      let text = "";
      let kind = "name-only";
      if (options.extract !== false && isIndexable(file)) {
        const ex = await extractContent(file, options);
        text = ex.text || "";
        kind = ex.kind;
        if (ex.note) {
          // 抽取失败/无文本层：仍索引文件名，内容留空
          text = "";
        }
        contentBytes += text.length;
      }

      // 无论是否抽到正文，都把路径与文件名放进索引（保证可搜到）
      const indexable = text
        ? text
        : file.path + "\n" + (file.name || "");

      try {
        store.upsertFile(handle, {
          path: file.path,
          name: file.name,
          dir: file.path.replace(/\/[^/]*$/, ""),
          size: file.size,
          mtime: file.mtime,
          md5: file.md5,
          ext: (file.ext || extOf(file.path)).toLowerCase(),
          content: indexable.slice(0, DEFAULT_MAX_CONTENT),
        });
        indexed++;
      } catch (e) {
        failed++;
      }

      if (typeof options.onProgress === "function" && indexed % 20 === 0) {
        options.onProgress({
          indexed,
          considered,
          skipped,
          scanned: scan.files.length,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    const st = store.status(handle);
    return {
      root,
      scannedFiles: scan.files.length,
      scannedDirs: scan.dirs,
      failedDirs: scan.failed,
      considered,
      indexed,
      skipped,
      failed,
      contentBytes,
      indexPath: st.path,
      dbBytes: st.dbBytes,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    handle.close();
  }
}

/**
 * 清理索引中已不存在于网盘的文件。
 * 需要传入当前网盘文件清单。
 */
async function pruneIndex(root, options = {}) {
  const { scanFiles } = require("./dedup");
  const handle = store.openIndex(options.dbPath);
  try {
    const scan = await scanFiles(root, {
      concurrency: options.concurrency || 6,
      maxDepth: options.maxDepth || 12,
    });
    const live = new Set(scan.files.map((f) => f.path));
    const rows = store.listFiles(handle, { limit: 100000 });
    const removed = [];
    for (const row of rows) {
      if (!live.has(row.path)) {
        store.removeFile(handle, row.path);
        removed.push(row.path);
      }
    }
    return { removed: removed.length, paths: removed.slice(0, 50), indexPath: handle.path };
  } finally {
    handle.close();
  }
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

module.exports = {
  buildIndex,
  pruneIndex,
  extractContent,
  isIndexable,
  TEXT_EXTS,
  DOC_EXTS,
  PDF_EXTS,
};
