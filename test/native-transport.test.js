// v1.11.1：默认的 native 传输下，常规读路径不得再同步 fork curl。
//
// 回归背景：v1.10.x/v1.11.0 的「全异步」声明被四路审核实测证伪 ——
// lib/pan.js 的 fetchRangeBuf **无条件**走 http.curlRange（内部 spawnSync），
// 于是**默认配置**下 cat/head/tail/grep 每次都同步 fork curl，冻结整个事件循环。
// 现在按传输模式分流：native → http.fetchRange（异步），curl → http.curlRange。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const ROOT = path.join(__dirname, "..");

// ── 隔离配置（默认 webTransport = native）────────────────────────────
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-native-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// ── mock child_process：记录所有 spawnSync ──────────────────────────
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const syncCalls = [];
function fakeSpawnSync(cmd, args, opts) {
  syncCalls.push(cmd);
  return { stdout: "", status: 0, error: null };
}
function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setTimeout(() => {
    const sub = args[0];
    const out =
      sub === "locate"
        ? "  0  https://d.example.com/file/abc?size=1000\n"
        : sub === "meta"
        ? "  文件大小          1000, 0.98KB\n"
        : "";
    child.stdout.write(out);
    child.stdout.end();
    child.emit("close", 0);
  }, 5);
  return child;
}
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, { spawn: fakeSpawn, spawnSync: fakeSpawnSync }),
};

// ── mock lib/http.js：记录 fetchRange / curlRange ─────────────────────
const httpPath = require.resolve(path.join(ROOT, "lib", "http.js"));
const calls = { fetchRange: 0, curlRange: 0 };
const realHttp = require(httpPath);
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: Object.assign({}, realHttp, {
    fetchRange: async (...a) => {
      calls.fetchRange++;
      return Buffer.from("hello native");
    },
    curlRange: (...a) => {
      calls.curlRange++;
      return Buffer.from("hello curl");
    },
  }),
};

const pan = require(path.join(ROOT, "lib", "pan.js"));

test("v1.11.1: native 传输下 cat 走异步 fetchRange，不同步 fork curl", async () => {
  const before = syncCalls.length;
  const text = await pan.cat("/x.txt");
  assert.equal(typeof text, "string");
  assert.ok(text.indexOf("hello native") >= 0, "应读到 native fetch 的内容: " + text);
  assert.equal(calls.curlRange, 0, "native 传输下不应调用 curlRange");
  assert.ok(calls.fetchRange > 0, "应调用 fetchRange");
  assert.equal(syncCalls.length, before, "native 传输下不应有任何 spawnSync 调用");
});

test("v1.11.1: native 传输下 head/tail/grep 同样不走同步 curl", async () => {
  const before = syncCalls.length;
  await pan.head("/x.txt", 2);
  await pan.tail("/x.txt", 2);
  await pan.grep("hello", "/x.txt");
  assert.equal(calls.curlRange, 0, "native 传输下不应调用 curlRange");
  assert.equal(syncCalls.length, before, "native 传输下不应有任何 spawnSync 调用");
});
