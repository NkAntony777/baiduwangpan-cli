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
/**
 * 把文本切成检索 token 串。
 *   - CJK 连续段 → 二元组（bigram）
 *   - 拉丁字母/数字 → 整词小写
 *   - 其余字符丢弃
 *
 * 为什么用二元组：FTS5 的 unicode61 不切分中文
 * （"风水" 查不中"倪海厦讲的风水古籍"），trigram 又要求查询词 ≥3 字。
 * 二元组是折中：两字查询能命中。
 *
 * 但二元组有固有盲区：原文"元气充足"切成 [元气,气充,充足]，
 * 单字查询"气"永远命中不了 —— 而中文单字查询（药/气/风/水）在
 * 中医知识库这类场景里非常常见。
 *
 * 解法：**索引侧同时补入单字 token**（tokenize 的结果 = 二元组 + 单字），
 * 查询侧对单字查询降级为 LIKE 兜底（避免索引体积翻倍到不可接受）。
 *
 * @param {string} text
 * @param {object} options { includeSingle: 是否补入单字（默认 true） }
 * @returns {string} 空格分隔的 token 串
 */
function tokenize(text, options = {}) {
  const includeSingle = options.includeSingle !== false;
  const s = String(text == null ? "" : text);
  const out = [];
  const singles = [];
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
        if (includeSingle) {
          // 单字也入索引：让「气」「药」这类单字查询能命中
          for (let k = 0; k < seg.length; k++) singles.push(seg[k]);
        }
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
  return out.concat(singles).join(" ");
}


/**
 * 把查询串转成 FTS5 MATCH 表达式。
 * 每个 token 加引号，避免 FTS5 语法字符（AND/OR/NEAR/* 等）引发解析错误。
 */
/**
 * 把查询串转成 FTS5 MATCH 表达式。
 *
 * 策略：每个 CJK 词按长度决定 token 形态 ——
 *   - 单字 → 单字 token（索引侧已补入）
 *   - 多字 → 二元组（更精确，多字全匹配才命中）
 * 若把单字也加进多字查询，会让结果集显著变宽（"风水" 命中所有含"风"或"水"的文档）。
 *
 * 所有 token 都用双引号包裹，避免 FTS5 语法字符（AND/OR/NEAR/* 等）引发解析错误。
 */
function buildMatchQuery(query) {
  const segments = String(query == null ? "" : query)
    .split(/\s+/)
    .filter(Boolean);
  const tokens = [];
  for (const seg of segments) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) {
        tokens.push(seg);
      } else {
        for (let k = 0; k + 1 < seg.length; k++) tokens.push(seg.slice(k, k + 2));
      }
    } else {
      // 拉丁词：只保留字母/数字/下划线，纯标点不是有效 token
      const w = seg.toLowerCase().replace(/[^a-z0-9_]+/g, "");
      if (w) tokens.push(w);
    }
  }
  if (!tokens.length) return null;
  return tokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR ");
}


// ── 索引库 ────────────────────────────────────────────────

/**
 * 转义 SQL LIKE 的通配符（% 和 _）。
 * 用 '~' 作转义字符而不是反斜杠 —— 反斜杠在 JS 字符串与 SQL 字面量两层里
 * 极易转义错位（实测导致匹配结果为空）。
 */
function escapeLike(s) {
  return String(s == null ? "" : s).replace(/[~%_]/g, (m) => "~" + m);
}

/**
 * 索引文件默认位置：~/.bdp/index/<profile>.db
 */
// 索引写入策略的版本号。
// 变更「入库内容构成」（例如把路径/文件名也写进 FTS）时必须 +1，
// 否则旧库会被增量逻辑跳过，新策略永远不生效。
const INDEX_FORMAT_VERSION = 2;

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
/**
 * 检查 FTS 表结构是否与当前版本一致。
 * v1.8.0 把 FTS 从「外部内容表(content='files')」改成「独立表 + body 列」，
 * 因为外部内容表下 snippet() 会报 SQL logic error。
 * 旧库的表结构不会被 CREATE ... IF NOT EXISTS 改写，
 * 因此必须显式检测并重建，否则 snippet(fts, 1) 会报 column index out of range。
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkSchema(db) {
  let row;
  try {
    row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'fts'").get();
  } catch {
    return { ok: false, reason: '无法读取 fts 表定义' };
  }
  if (!row || !row.sql) return { ok: false, reason: 'fts 表不存在' };
  const sql = String(row.sql);
  if (/content\s*=\s*'files'/i.test(sql)) {
    return { ok: false, reason: 'FTS 表是旧版外部内容表结构，需要重建' };
  }
  if (!/\bbody\b/i.test(sql)) {
    return { ok: false, reason: 'FTS 表缺少 body 列，需要重建' };
  }
  return { ok: true };
}

/**
 * 重建 FTS 表并从 files 表回填内容。
 * files 表仍保留正文，因此可以无损重建。
 */
function rebuildFts(db) {
  db.exec("DROP TABLE IF EXISTS fts");
  db.exec([
    "CREATE VIRTUAL TABLE fts USING fts5(",
    "  tokens,",
    "  body,",
    "  tokenize='unicode61'",
    ")",
  ].join("\n"));
  const rows = db.prepare("SELECT id, content FROM files").all();
  const ins = db.prepare("INSERT INTO fts(rowid, tokens, body) VALUES (?, ?, ?)");
  for (const r of rows) {
    ins.run(r.id, tokenize(r.content || ""), r.content || "");
  }
  return rows.length;
}
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
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    -- 注意：不能用 content='files' 外部内容表 —— FTS5 的 snippet()
    -- 在外部内容表下会报 "SQL logic error"（实测 node:sqlite 3.53.4）。
    -- 因此正文直接存在 FTS 表自己的 body 列里，snippet 才能工作。
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      tokens,
      body,
      tokenize='unicode61'
    );
  `);
  // ── 升级分两步，顺序不能反 ──
  //
  // 第 1 步：schema 迁移（旧版 FTS 表结构 → 新结构）。
  //   旧版是外部内容表，snippet() 会报 column index out of range；
  //   但 files 表里正文还在，可以无损重建并回填 —— 不丢数据。
  const schema = checkSchema(db);
  if (!schema.ok) {
    const n = rebuildFts(db);
    if (process.env.BDP_INDEX_VERBOSE) {
      process.stderr.write(
        '[bdp] 索引库结构升级：' + schema.reason + '，已重建 FTS 表（' + n + ' 行）' + String.fromCharCode(10)
      );
    }
  }

  // 第 2 步：写入策略版本检查。
  //   版本变化说明「入库内容构成」变了（如把路径/文件名也写进 FTS），
  //   旧条目的内容形态不对，必须清空强制全量重建，
  //   否则增量逻辑会把所有文件判为「未变」而跳过，新策略永远不生效。
  let storedVersion = null;
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k = 'format_version'").get();
    storedVersion = row ? row.v : null;
  } catch {
    storedVersion = null;
  }
  if (storedVersion !== null && storedVersion !== String(INDEX_FORMAT_VERSION)) {
    // 只有「已有版本号且版本不同」才清空。
    // 存量库（storedVersion === null）无法区分旧 schema 与旧策略，
    // 此时不清空 —— 保留正文，下次 build 时按新策略增量更新即可。
    db.exec("DROP TABLE IF EXISTS fts");
    db.exec("DELETE FROM files");
    db.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(" +
        "  tokens," +
        "  body," +
        "  tokenize='unicode61'" +
        ")"
    );
    if (process.env.BDP_INDEX_VERBOSE) {
      process.stderr.write(
        '[bdp] 索引写入策略版本变化（→ ' + INDEX_FORMAT_VERSION + '），已清空索引待重建' + String.fromCharCode(10)
      );
    }
  }
  if (storedVersion !== String(INDEX_FORMAT_VERSION)) {
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('format_version', ?)").run(
      String(INDEX_FORMAT_VERSION)
    );
  }
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
    // LIKE 的通配符是 % 和 _，必须转义，否则目录过滤会比预期更宽。
    // SQL 侧同时加 ESCAPE '\\'。
    where.push("f.path LIKE ? ESCAPE '~'");
    params.push(escapeLike(options.dirPrefix) + "%");
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
  // noLimit 用于 prune 这类需要全量遍历的场景；
  // 硬上限 1000 会让 prune 只能看到前 1000 条，超出的失效条目永远清不掉。
  const limit = options.noLimit ? -1 : Math.max(1, Math.min(options.limit || 50, 1000));
  let sql = "SELECT path, name, size, mtime, ext, content_len FROM files";
  const params = [];
  if (options.dirPrefix) {
    sql += " WHERE path LIKE ? ESCAPE '~'";
    params.push(escapeLike(options.dirPrefix) + "%");
  }
  if (limit >= 0) {
    sql += " ORDER BY indexed_at DESC LIMIT ?";
    params.push(limit);
  } else {
    sql += " ORDER BY indexed_at DESC";
  }
  return db.prepare(sql).all(...params);
}

/**
 * 增量判断：文件是否需要重新索引。
 * 依据 md5（内容指纹）+ size；mtime 变化但内容不变时跳过。
 */
function needsReindex(handle, item) {
  const { db } = handle;
  const row = db
    .prepare("SELECT md5, size, mtime, content FROM files WHERE path = ?")
    .get(item.path);
  if (!row) return true;
  if (item.md5 && row.md5) {
    // 两边都有 md5 → 以内容指纹为准
    if (item.md5 !== row.md5) return true;
    if (item.size != null && row.size != null && item.size !== row.size) return true;
    return false;
  }
  // 只有一边有 md5（首建时无 md5，本次拿到了）→ 视为变化，需要重建，
  // 否则此后同尺寸的内容变更会被漏掉。
  if ((item.md5 && !row.md5) || (!item.md5 && row.md5)) return true;
  // 内容形态检查：v1.8.0 之前入库的条目只存正文（不含路径/文件名），
  // 那些条目搜文件名搜不到 → 需要按新策略重写。
  if (typeof row.content === "string" && item.path) {
    if (!row.content.startsWith(item.path)) return true;
  }
  // md5 不可用（百度未返回）：退化为 size + mtime，
  // 否则「md5 为空 + size 未变」的内容变化会被永远漏掉。
  if (item.size != null && row.size != null && item.size !== row.size) return true;
  if (item.mtime != null && row.mtime != null && item.mtime !== row.mtime) return true;
  return false;
}

module.exports = {
  INDEX_FORMAT_VERSION,
  escapeLike,
  checkSchema,
  rebuildFts,
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
