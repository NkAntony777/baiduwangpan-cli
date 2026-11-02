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

test("tokenize: 中文切二元组", () => {
  assert.equal(store.tokenize("风水"), "风水");
  assert.equal(store.tokenize("倪海厦"), "倪海 海厦");
  assert.equal(store.tokenize("中医知识"), "中医 医知 知识");
});

test("tokenize: 单字中文保留", () => {
  assert.equal(store.tokenize("气"), "气");
});

test("tokenize: 拉丁词小写并保留", () => {
  assert.equal(store.tokenize("Hello World"), "hello world");
  assert.equal(store.tokenize("GPT-4 模型"), "gpt 4 模型");
});

test("tokenize: 标点被丢弃", () => {
  assert.equal(store.tokenize("你好，世界！"), "你好 世界");
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
    store.upsertFile(h, { path: "/a.txt", name: "a.txt", size: 10, md5: "m1", content: "x" });
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "m1" }), false);
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 11, md5: "m1" }), true);
    assert.equal(store.needsReindex(h, { path: "/a.txt", size: 10, md5: "m2" }), true);
    assert.equal(store.needsReindex(h, { path: "/new.txt", size: 10, md5: "m1" }), true);
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
