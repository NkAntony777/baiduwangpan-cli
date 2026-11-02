// lib/index-store.js — 本地全文索引（SQLite FTS5 + CJK 二元分词）
//
// 目标：让网盘里的内容可被检索。用户的中医知识图谱 CSV 有几百万条三元组，
// 但 bdp cat 只能读前 1MB；建索引后才能真正查。
//
// 为什么自己分词：SQLite FTS5 的 unicode61 分词器不切分中文
// （"倪海厦讲的风水古籍" 会被当成 1 个 token，"风水" 查不中），
// trigram 又要求查询词 ≥3 字（"风水" 2 字查不中）。
// 折中方案：建索引时把中文切成二元组（bigram），用空格连接后交给
// unicode61 —— 实测 "风水"/"倪海"/"配伍" 均可命中。
//
// 技术选型：Node 24 内置 node:sqlite（含 FTS5），零外部依赖。

const fs = require("fs");
const os = require("os");
const path = require("path");

// ── CJK 分词 ──────────────────────────────────────────────
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 把文本切成检索 token 串：
 *   - CJK 连续段 → 二元组（单字则保留单字）
 *   - 拉丁字母/数字 → 整词小写
 *   - 其余字符丢弃
 * @param {string} text
 * @returns {string} 空格分隔的 token 串
 */
function tokenize(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < s.length && CJK_RE.test(s[j])) j++;
      const seg = s.slice(i, j);
      if (seg.length === 1) {
        out.push(seg);
      } else {
        for (let k = 0; k + 1 < seg.length; k++) out.push(seg.slice(k, k + 2));
      }
      i = j;
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      out.push(s.slice(i, j).toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return out.join(" ");
}

/**
 * 把查询串转成 FTS5 MATCH 表达式。
 * 每个 token 加引号，避免 FTS5 语法字符（AND/OR/NEAR/* 等）引发解析错误。
 */
function buildMatchQuery(query) {
  const tokens = tokenize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR ");
}

// ── 索引库 ────────────────────────────────────────────────

/**
 * 索引文件默认位置：~/.bdp/index/<profile>.db
 */
function defaultIndexPath(profile) {
  const base = process.env.BDP_HOME || path.join(os.homedir(), ".bdp");
  const dir = path.join(base, "index");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, (profile || "default") + ".db");
}

/**
 * 打开索引库（不存在则创建）。
 * @param {string} dbPath
 * @returns {{ db, path, close }}
 */
function openIndex(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const file = dbPath || defaultIndexPath();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT UNIQUE NOT NULL,
      name         TEXT,
      dir          TEXT,
      size         INTEGER,
      mtime        INTEGER,
      md5          TEXT,
      ext          TEXT,
      content      TEXT,
      indexed_at   INTEGER,
      content_len  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_files_dir ON files(dir);
    CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5);
    -- 注意：不能用 content='files' 外部内容表 —— FTS5 的 snippet()
    -- 在外部内容表下会报 "SQL logic error"（实测 node:sqlite 3.53.4）。
    -- 因此正文直接存在 FTS 表自己的 body 列里，snippet 才能工作。
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      tokens,
      body,
      tokenize='unicode61'
    );
  `);
  return {
    db,
    path: file,
    close() {
      try { db.close(); } catch {}
    },
  };
}

/**
 * 写入/更新一个文件的索引条目。
 * @param {object} handle openIndex 的返回值
 * @param {object} item { path, name, dir, size, mtime, md5, ext, content }
 */
function upsertFile(handle, item) {
  const { db } = handle;
  const tokens = tokenize(item.content || "");
  const existing = db.prepare("SELECT id FROM files WHERE path = ?").get(item.path);
  let id;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE files SET name=?, dir=?, size=?, mtime=?, md5=?, ext=?, content=?,
       indexed_at=?, content_len=? WHERE id=?`
    ).run(
      item.name || null,
      item.dir || null,
      item.size || 0,
      item.mtime || 0,
      item.md5 || null,
      item.ext || null,
      item.content || "",
      Date.now(),
      (item.content || "").length,
      id
    );
    // FTS5 外部内容表需要先删旧行再插新行
    // FTS 表是独立表（不是外部内容表），直接删旧行再插新行
    db.prepare("DELETE FROM fts WHERE rowid = ?").run(id);
  } else {
    const r = db
      .prepare(
        `INSERT INTO files (path,name,dir,size,mtime,md5,ext,content,indexed_at,content_len)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        item.path,
        item.name || null,
        item.dir || null,
        item.size || 0,
        item.mtime || 0,
        item.md5 || null,
        item.ext || null,
        item.content || "",
        Date.now(),
        (item.content || "").length
      );
    id = Number(r.lastInsertRowid);
  }
  db.prepare("INSERT INTO fts(rowid, tokens, body) VALUES (?, ?, ?)").run(id, tokens, item.content || "");
  return id;
}

/**
 * 从索引中删除一个路径。
 */
function removeFile(handle, filePath) {
  const { db } = handle;
  const row = db.prepare("SELECT id FROM files WHERE path = ?").get(filePath);
  if (!row) return false;
  db.prepare("DELETE FROM fts WHERE rowid = ?").run(row.id);
  db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
  return true;
}

/**
 * 检索。
 * @param {object} handle
 * @param {string} query 自然语言查询
 * @param {object} options { limit, dirPrefix, ext, pathPrefix }
 * @returns {Array} [{ path, name, size, mtime, ext, snippet, score }]
 */
function search(handle, query, options = {}) {
  const { db } = handle;
  const limit = Math.max(1, Math.min(options.limit || 20, 500));
  const match = buildMatchQuery(query);
  if (!match) return [];

  const where = [];
  const params = [];
  if (options.dirPrefix) {
    where.push("f.path LIKE ?");
    params.push(options.dirPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "%");
  }
  if (options.ext) {
    where.push("f.ext = ?");
    params.push(String(options.ext).toLowerCase());
  }
  const whereSql = where.length ? " AND " + where.join(" AND ") : "";

  const sql =
    `SELECT f.id, f.path, f.name, f.dir, f.size, f.mtime, f.ext,
        snippet(fts, 1, '\u3010', '\u3011', '…', 24) AS snip,
        bm25(fts) AS rank
     FROM fts JOIN files f ON f.id = fts.rowid
     WHERE fts MATCH ?${whereSql}
     ORDER BY rank LIMIT ?`;

  let rows;
  try {
    rows = db.prepare(sql).all(match, ...params, limit);
  } catch (e) {
    // MATCH 语法错误（例如全是停用词）→ 退化为全文 LIKE
    return fallbackSearch(handle, query, options);
  }
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    name: r.name,
    dir: r.dir,
    size: r.size,
    mtime: r.mtime,
    ext: r.ext,
    snippet: r.snip,
    score: -r.rank,
  }));
}

/** FTS 不可用时的 LIKE 兜底 */
function fallbackSearch(handle, query, options = {}) {
  const { db } = handle;
  const limit = Math.max(1, Math.min(options.limit || 20, 500));
  const terms = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const like = "%" + terms.map((t) => t.replace(/[%_]/g, "\\$&")).join("%") + "%";
  const rows = db
    .prepare(
      `SELECT id, path, name, dir, size, mtime, ext,
          substr(content, 1, 200) AS snip, 0 AS rank
       FROM files WHERE content LIKE ?
       ORDER BY size DESC LIMIT ?`
    )
    .all(like, limit);
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    name: r.name,
    dir: r.dir,
    size: r.size,
    mtime: r.mtime,
    ext: r.ext,
    snippet: r.snip,
    score: 0,
  }));
}

/**
 * 索引状态统计。
 */
function status(handle) {
  const { db } = handle;
  const total = db.prepare("SELECT COUNT(*) c FROM files").get();
  const bytes = db.prepare("SELECT COALESCE(SUM(content_len),0) s FROM files").get();
  const latest = db.prepare("SELECT MAX(indexed_at) t FROM files").get();
  let dbSize = 0;
  try {
    dbSize = fs.statSync(handle.path).size;
  } catch {}
  return {
    path: handle.path,
    files: total.c,
    contentBytes: bytes.s,
    dbBytes: dbSize,
    lastIndexedAt: latest.t || null,
  };
}

/**
 * 列出已索引文件（可按前缀过滤）。
 */
function listFiles(handle, options = {}) {
  const { db } = handle;
  const limit = Math.max(1, Math.min(options.limit || 50, 1000));
  let sql = "SELECT path, name, size, mtime, ext, content_len FROM files";
  const params = [];
  if (options.dirPrefix) {
    sql += " WHERE path LIKE ?";
    params.push(options.dirPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "%");
  }
  sql += " ORDER BY indexed_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * 增量判断：文件是否需要重新索引。
 * 依据 md5（内容指纹）+ size；mtime 变化但内容不变时跳过。
 */
function needsReindex(handle, item) {
  const { db } = handle;
  const row = db
    .prepare("SELECT md5, size, content_len FROM files WHERE path = ?")
    .get(item.path);
  if (!row) return true;
  if (item.md5 && row.md5 && item.md5 !== row.md5) return true;
  if (item.size != null && row.size != null && item.size !== row.size) return true;
  return false;
}

module.exports = {
  tokenize,
  buildMatchQuery,
  defaultIndexPath,
  openIndex,
  upsertFile,
  removeFile,
  search,
  status,
  listFiles,
  needsReindex,
};
