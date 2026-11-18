// 引擎版本闸门（上游缺陷 #534）—— 转存前必须确认引擎 >= v4.0.2。
//
// 背景（实测，见 CHANGELOG v1.12.1）：
//   引擎 v4.0.1 → 分享链接转存到网盘失败: 请确认登录参数中已经包含了网盘STOKEN
//   引擎 v4.0.2 → 分享链接转存到网盘成功, 保存了<文件名>到当前目录
// v4.0.1 的报错极具误导性（实际是百度反爬拦了分享页，STOKEN 没问题），
// 所以 CLI 必须在跑转存**之前**就把版本卡住，并给出可执行的升级指引。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 隔离配置：绝不碰真实 ~/.bdp ────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-engine-ver-"));
process.env.BDP_CONFIG_DIR = dir;
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pcsPath: "BaiduPCS-Go" }), "utf8");

// ── Mock child_process：把 lib/pan.js 的惰性 require 换成假引擎 ──────────
const calls = [];
let engineVersion = "BaiduPCS-Go version v4.0.2";
let transferRan = false;

function fakeSpawn(cmd, args, opts) {
  calls.push(args);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    let stdout = "";
    if (args[0] === "--version") {
      stdout = engineVersion;
    } else if (args[0] === "transfer") {
      transferRan = true;
      stdout = "分享链接转存到网盘成功, 保存了[报告.pdf 资料]到当前目录\n";
    }
    child.stdout.write(stdout);
    child.stdout.end();
    child.emit("close", 0);
  });
  return child;
}
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
require.cache[cpPath] = {
  id: cpPath, filename: cpPath, loaded: true,
  exports: { ...realCp, spawn: fakeSpawn },
};

const {
  parseEngineVersion, engineSupportsTransfer, transferShare, MIN_ENGINE_VERSION,
} = require("../lib/share-transfer");

const URL = "https://pan.baidu.com/s/1Example";

test("parseEngineVersion: 解析引擎 --version 输出", () => {
  assert.deepEqual(parseEngineVersion("BaiduPCS-Go version v4.0.2"), { major: 4, minor: 0, patch: 2 });
  assert.deepEqual(parseEngineVersion("BaiduPCS-Go version v4.0.1"), { major: 4, minor: 0, patch: 1 });
  assert.deepEqual(parseEngineVersion("v3.9.12"), { major: 3, minor: 9, patch: 12 });
  assert.equal(parseEngineVersion("no version here"), null);
  assert.equal(parseEngineVersion(""), null);
  assert.equal(parseEngineVersion(undefined), null);
});

test("engineSupportsTransfer: v4.0.2 是分水岭", () => {
  assert.equal(MIN_ENGINE_VERSION, "4.0.2");
  const v = (s) => parseEngineVersion(s);
  assert.equal(engineSupportsTransfer(v("4.0.1")), false, "4.0.1 有 #534，必须拦下");
  assert.equal(engineSupportsTransfer(v("4.0.0")), false);
  assert.equal(engineSupportsTransfer(v("3.9.9")), false);
  assert.equal(engineSupportsTransfer(v("4.0.2")), true);
  assert.equal(engineSupportsTransfer(v("4.0.3")), true);
  assert.equal(engineSupportsTransfer(v("4.1.0")), true);
  assert.equal(engineSupportsTransfer(v("5.0.0")), true);
  assert.equal(engineSupportsTransfer(null), true, "探测不出版本时不该拦用户");
});

test("transferShare: 引擎 < v4.0.2 时拒绝转存并给出升级指引", async () => {
  engineVersion = "BaiduPCS-Go version v4.0.1";
  transferRan = false;
  calls.length = 0;
  await assert.rejects(
    () => transferShare(URL, { password: "a1b2", confirm: true }),
    (err) => {
      assert.match(err.message, /4\.0\.2/, "应写明需要的最低版本");
      assert.match(err.message, /升级引擎|npm i -g baiduwangpan-cli/, "应给出可执行的升级方式");
      assert.match(err.message, /#534/, "应指出这是上游缺陷而非 STOKEN 问题");
      return true;
    }
  );
  assert.equal(transferRan, false, "版本过旧时不应真的去跑转存");
  assert.deepEqual(calls.map((a) => a[0]), ["--version"], "只应探测版本，不应跑 transfer");
});

test("transferShare: 引擎 >= v4.0.2 时正常转存", async () => {
  engineVersion = "BaiduPCS-Go version v4.0.2";
  transferRan = false;
  const result = await transferShare(URL, { password: "a1b2", confirm: true });
  assert.equal(result.success, true);
  assert.equal(transferRan, true);
});

test("transferShare: 探测不出引擎版本时不阻断（不制造新的失败点）", async () => {
  engineVersion = "";
  transferRan = false;
  const result = await transferShare(URL, { password: "a1b2", confirm: true });
  assert.equal(result.success, true);
  assert.equal(transferRan, true);
});

test("transferShare: --dry-run 不触碰引擎", async () => {
  calls.length = 0;
  const result = await transferShare(URL, { password: "a1b2", dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, [], "dry-run 不应启动任何引擎进程");
});
