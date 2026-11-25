// 索引健康状态：把「**输入降级**」与「**分析缺数据**」分成两件事。
//
// 之前 bdp ask / bdp_ask 只会说两种话：
//   索引里一个文件都没有 → 报错「索引为空」
//   查不到匹配            → total=0
// 三件不同的事被混成了一件：
//   missing  从没建过索引（openIndex 会现场建一个空库，于是「没建过」与
//            「建过但空」在 status() 里长得一模一样）
//   empty    建过，但一条都没索引进去
//   stale    索引还在但已过期 —— 此时**查询结论仍然成立**，只是**输入已降级**
//
// 本文件断言这四档，以及「过期索引不得把结论抹掉」。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "bdp.js");
const store = require("../lib/index-store");
const { makeTempDir } = require("./tmp-helper");

const tmpRoot = makeTempDir("bdp-index-health-", { scope: "file" });
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function dbPath() {
  return path.join(tmpRoot, "idx-" + (++seq) + ".db");
}

/** 建一个索引库，可选地写入文件与「建过」标记。 */
function makeIndex({ files = 0, builtAt = null, indexedAt = null, content = "量子力学与意识" } = {}) {
  const h = store.openIndex(dbPath());
  for (let i = 0; i < files; i++) {
    store.upsertFile(h, {
      path: "/资料/doc" + i + ".txt",
      name: "doc" + i + ".txt",
      dir: "/资料",
      size: 10,
      mtime: 1700000000,
      md5: "d" + i,
      ext: ".txt",
      content,
      indexedAt,
    });
  }
  // 回填行级 indexed_at —— upsertFile 永远写 Date.now()，不直接改就只能测到「新鲜」。
  if (indexedAt !== null) h.db.prepare("UPDATE files SET indexed_at = ?").run(Number(indexedAt));
  if (builtAt !== null) store.writeMeta(h, "indexed_at", String(builtAt));
  return h;
}

const DAY = 24 * 60 * 60 * 1000;

test("indexHealth: 从没建过索引 -> missing（不是 empty）", () => {
  const h = makeIndex({ files: 0 });
  try {
    const health = store.indexHealth(h);
    assert.equal(health.state, "missing");
    assert.equal(health.files, 0);
    assert.equal(health.fresh, false);
  } finally { h.close(); }
});

test("indexHealth: 建过但一条都没有 -> empty（与 missing 区分开）", () => {
  const h = makeIndex({ files: 0, builtAt: Date.now() - DAY });
  try {
    const health = store.indexHealth(h);
    assert.equal(health.state, "empty", "有 meta 标记说明建过 → empty，不能说成 missing");
    assert.equal(health.files, 0);
  } finally { h.close(); }
});

test("indexHealth: 索引新鲜 -> complete", () => {
  const h = makeIndex({ files: 3, builtAt: Date.now(), indexedAt: Date.now() - 1000 });
  try {
    const health = store.indexHealth(h);
    assert.equal(health.state, "complete");
    assert.equal(health.fresh, true);
    assert.equal(health.files, 3);
    assert.ok(health.ageHours !== null && health.ageHours >= 0);
  } finally { h.close(); }
});

test("indexHealth: 索引过期 -> stale（结论仍在，只是输入降级）", () => {
  const old = Date.now() - 30 * DAY;
  const h = makeIndex({ files: 3, builtAt: old, indexedAt: old });
  try {
    const health = store.indexHealth(h);
    assert.equal(health.state, "stale");
    assert.equal(health.fresh, false);
    assert.equal(health.files, 3, "过期索引里文件还在 —— 不能因为降级就把结论抹掉");
    assert.ok(health.ageHours > 7 * 24, "ageHours 应反映过期时长");
  } finally { h.close(); }
});

test("indexHealth: 过期阈值只有一个事实来源（doctor 与 ask 同一口径）", () => {
  const doctor = require("../lib/doctor");
  assert.equal(doctor.INDEX_FRESH_MS, store.INDEX_FRESH_MS);
  assert.equal(store.INDEX_FRESH_MS, 7 * 24 * 60 * 60 * 1000);
});

// ── CLI：bdp ask 的四档 ─────────────────────────────────────────────────

function cliAsk(db, extra = []) {
  const cfgDir = makeTempDir("bdp-ask-cfg-");
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ ua: "t", pcsPath: "BaiduPCS-Go" }), "utf8");
  const r = spawnSync(process.execPath, [CLI, "ask", "量子力学", "--db", db, "--json", ...extra], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, BDP_CONFIG_DIR: cfgDir },
  });
  fs.rmSync(cfgDir, { recursive: true, force: true });
  return r;
}

test("CLI bdp ask: 索引未建立 -> indexState=missing 且 total=null（不是「查到 0 条」）", () => {
  const h = makeIndex({ files: 0 });
  const db = h.path;
  h.close();
  const r = cliAsk(db);
  assert.equal(r.status, 1, "没得查应当报错退出");
  const out = JSON.parse(r.stdout);
  assert.equal(out.indexState, "missing");
  assert.equal(out.total, null, "没执行检索就不能报 0 —— 那是「分析缺数据」");
  assert.deepEqual(out.hits, []);
  assert.match(out.error, /索引尚未建立/);
});

test("CLI bdp ask: 过期索引仍给出命中，并标明 indexState=stale（结论不被抹掉）", () => {
  const old = Date.now() - 30 * DAY;
  const h = makeIndex({ files: 2, builtAt: old, indexedAt: old });
  const db = h.path;
  h.close();
  const r = cliAsk(db);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.indexState, "stale");
  assert.ok(out.total > 0, "过期索引里的命中仍应返回");
  assert.ok(out.hits.length > 0);
  assert.match(out.note, /过期索引/, "必须说明来源已降级");
});

test("CLI bdp ask: 新鲜索引 -> indexState=complete 且无 note", () => {
  const h = makeIndex({ files: 2, builtAt: Date.now(), indexedAt: Date.now() - 1000 });
  const db = h.path;
  h.close();
  const r = cliAsk(db);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.indexState, "complete");
  assert.equal(out.note, undefined, "索引新鲜时不该有降级说明");
});

// ── MCP：bdp_ask 同一口径 ──────────────────────────────────────────────

test("MCP bdp_ask: 过期索引 -> indexState=stale，命中照给", async () => {
  const old = Date.now() - 30 * DAY;
  const h = makeIndex({ files: 2, builtAt: old, indexedAt: old });
  const db = h.path;
  h.close();
  const mcp = require("../lib/mcp");
  const out = await mcp.callTool("bdp_ask", { query: "量子力学", db });
  assert.equal(out.indexState, "stale");
  assert.ok(out.total > 0, "降级不得抹掉结论");
  assert.match(out.note, /过期索引/);
});

test("MCP bdp_ask: 索引未建立 -> 报错并带 indexState=missing", async () => {
  const h = makeIndex({ files: 0 });
  const db = h.path;
  h.close();
  const mcp = require("../lib/mcp");
  await assert.rejects(
    () => mcp.callTool("bdp_ask", { query: "量子力学", db }),
    (err) => {
      assert.equal(err.indexState, "missing");
      assert.match(err.message, /索引尚未建立/);
      return true;
    }
  );
});
