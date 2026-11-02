const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/index-store");
const os = require("os");
const path = require("path");
const fs = require("fs");

let dbPath;
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-idx-"));
  return path.join(dir, "test.db");
}

test("tokenize: 中文切二元组 + 单字（单字用于支持「药」「气」这类查询）", () => {
  assert.equal(store.tokenize("风水"), "风水 风 水");
  assert.equal(store.tokenize("倪海厦"), "倪海 海厦 倪 海 厦");
  assert.equal(store.tokenize("中医知识"), "中医 医知 知识 中 医 知 识");
});

test("tokenize: 可选关闭单字 token", () => {
  assert.equal(store.tokenize("风水", { includeSingle: false }), "风水");
});

test("tokenize: 单字中文保留", () => {
  assert.equal(store.tokenize("气"), "气");
});

test("tokenize: 拉丁词小写并保留", () => {
  assert.equal(store.tokenize("Hello World"), "hello world");
  assert.equal(store.tokenize("GPT-4 模型"), "gpt 4 模型 模 型");
});

test("tokenize: 标点被丢弃", () => {
  assert.equal(store.tokenize("你好，世界！"), "你好 世界 你 好 世 界");
});

test("buildMatchQuery: 生成带引号的 FTS5 表达式", () => {
  const q = store.buildMatchQuery("风水");
  assert.equal(q, '"风水"');
});

test("buildMatchQuery: 多词用 OR 连接", () => {
  const q = store.buildMatchQuery("风水 中医");
  assert.equal(q, '"风水" OR "中医"');
});

test("buildMatchQuery: FTS5 关键字被引号包裹成字面量（不会触发语法错误）", () => {
  // tokenizer 会把英文单词保留下来，包括 AND / OR / NOT 这些 FTS5 运算符关键字。
  // 关键保证是：每个 token 都被双引号包裹，因此它们是字面量而非运算符。
  const q = store.buildMatchQuery('a AND b');
  assert.ok(q.includes('"and"'), "q=" + q);
  assert.ok(!/[^"]\bAND\b[^"]/.test(q), "AND 必须是引号内的字面量: " + q);
});

test("search: 特殊字符查询不抛异常（走 fallback）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-idx-"));
  const h = store.openIndex(path.join(dir, "t.db"));
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "甘草内容" });
    const hits = store.search(h, 'AND OR NEAR "() *', { limit: 5 });
    assert.ok(Array.isArray(hits));
  } finally {
    h.close();
  }
});

test("buildMatchQuery: 空查询返回 null", () => {
  assert.equal(store.buildMatchQuery(""), null);
  assert.equal(store.buildMatchQuery("   "), null);
  assert.equal(store.buildMatchQuery("!!!"), null);
});

test("索引: 写入后可检索到中文内容", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, {
      path: "/中医/甘草.txt",
      name: "甘草.txt",
      size: 100,
      md5: "abc",
      ext: "txt",
      content: "甘草与甘遂配伍禁忌",
    });
    const hits = store.search(h, "甘草配伍", { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].path, "/中医/甘草.txt");
  } finally {
    h.close();
  }
});

test("索引: 两字中文查询也能命中（unicode61 分词器的已知陷阱）", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "倪海厦讲的风水古籍" });
    const hits = store.search(h, "风水", { limit: 5 });
    assert.equal(hits.length, 1);
  } finally {
    h.close();
  }
});

test("索引: 单字中文查询能命中（二元分词的固有盲区）", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    // 「元气充足」按二元组会切成 [元气,气充,充足]，单字「气」本应查不到
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "元气充足" });
    const hits = store.search(h, "气", { limit: 5 });
    assert.equal(hits.length, 1, "单字查询应命中");
  } finally {
    h.close();
  }
});

test("索引: 单字查询不影响多字查询的精度", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "风水古籍" });
    store.upsertFile(h, { path: "/b.txt", name: "b.txt", content: "中医书籍" });
    // 「风水」应只命中 a，不应因单字 token 而命中 b
    const hits = store.search(h, "风水", { limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "/a.txt");
  } finally {
    h.close();
  }
});

test("索引: 更新同一路径不产生重复行", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "旧内容" });
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "新内容" });
    const st = store.status(h);
    assert.equal(st.files, 1);
    const hits = store.search(h, "新内容", { limit: 5 });
    assert.equal(hits.length, 1);
  } finally {
    h.close();
  }
});

test("索引: removeFile 删除条目", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", content: "可删除内容" });
    assert.equal(store.removeFile(h, "/a.txt"), true);
    assert.equal(store.status(h).files, 0);
    assert.equal(store.removeFile(h, "/a.txt"), false);
  } finally {
    h.close();
  }
});

test("索引: needsReindex 依据 md5/size 判定", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", size: 10, md5: "m1", mtime: 1000, content: "/a.txt\\nx" });
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "m1", mtime: 1000 }), false);
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 11, md5: "m1", mtime: 1000 }), true);
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "m2", mtime: 1000 }), true);
    assert.equal(store.needsReindex(h, { path: "/new.txt", size: 10, md5: "m1" }), true);
  } finally {
    h.close();
  }
});

test("索引: md5 缺失时退化为 size+mtime 判定（否则内容变化会被漏掉）", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    // 百度未返回 md5 的文件：空字符串
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", size: 10, md5: "", mtime: 1000, content: "/a.txt\\n旧" });
    // mtime 变了 → 必须重建
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "", mtime: 2000 }), true);
    // size 变了 → 必须重建
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 11, md5: "", mtime: 1000 }), true);
    // 全同 → 无需重建
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "", mtime: 1000 }), false);
  } finally {
    h.close();
  }
});

test("索引: 目录前缀过滤生效", () => {
  dbPath = tmpDb();
  const h = store.openIndex(dbPath);
  try {
    store.upsertFile(h, { path: "/中医/a.txt", name: "a.txt", content: "甘草内容" });
    store.upsertFile(h, { path: "/玄学/b.txt", name: "b.txt", content: "甘草内容" });
    const hits = store.search(h, "甘草", { dirPrefix: "/中医", limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "/中医/a.txt");
  } finally {
    h.close();
  }
});

// ── schema 迁移 ─────────────────────────────────────────
test("索引: 旧版外部内容表结构会被自动重建", () => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-idx-"));
  const p = path.join(dir, "old.db");
  const old = new DatabaseSync(p);
  old.exec(
    "CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL," +
    " name TEXT, dir TEXT, size INTEGER, mtime INTEGER, md5 TEXT, ext TEXT," +
    " content TEXT, indexed_at INTEGER, content_len INTEGER)"
  );
  old.exec(
    "CREATE VIRTUAL TABLE fts USING fts5(tokens, content='files', content_rowid='id', tokenize='unicode61')"
  );
  old.prepare("INSERT INTO files (id,path,content) VALUES (1,'/a.txt','甘草内容')").run();
  old.prepare("INSERT INTO fts(rowid,tokens) VALUES (1,'甘草 内容')").run();
  old.close();

  const h = store.openIndex(p);
  try {
    const sql = h.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'fts'")
      .get().sql;
    assert.ok(!/content\s*=\s*'files'/i.test(sql), "旧结构应被重建: " + sql);
    assert.ok(/body/i.test(sql), "新结构应含 body 列: " + sql);
    // 重建后仍可检索，且 snippet 不再报 column index out of range
    const hits = store.search(h, "甘草", { limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "/a.txt");
    assert.ok(hits[0].snippet);
  } finally {
    h.close();
  }
});

test("索引: checkSchema 判定新旧结构", () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, content TEXT)"
  );
  db.exec(
    "CREATE VIRTUAL TABLE fts USING fts5(tokens, body, tokenize='unicode61')"
  );
  assert.equal(store.checkSchema(db).ok, true);
  db.exec("DROP TABLE fts");
  db.exec(
    "CREATE VIRTUAL TABLE fts USING fts5(tokens, content='files', content_rowid='id')"
  );
  assert.equal(store.checkSchema(db).ok, false);
});
