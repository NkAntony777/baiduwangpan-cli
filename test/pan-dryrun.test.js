const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 隔离配置：本测试绝不能读用户的真实 ~/.bdp/config.json ──
// （此前没设 BDP_CONFIG_DIR —— 结果 pcsPath 取决于本机配置，测试不确定。）
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-dryrun-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// ── mock child_process：引擎一旦被要求「下载」就报错 ──
//
// ⚠️ v1.11.0 起引擎调用走**异步 spawn**，只 mock spawnSync 是不够的 ——
// 未 mock 的 spawn 会落到真实 BaiduPCS-Go（本机有引擎时「碰巧」能过，
// 干净 checkout 里则因找不到引擎而失败）。两条路径都 mock，测试才是 hermetic 的。
// 另外按 **basename** 判定引擎（不是精确字符串），这样与 pcsPath 解析结果无关。
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const engineCalls = [];

function isEngine(cmd) {
  return /BaiduPCS-Go/i.test(path.basename(String(cmd || "")));
}

function fakeSpawn(cmd, args, opts) {
  if (!isEngine(cmd)) return realCp.spawn(cmd, args, opts);
  engineCalls.push(args.slice());
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setTimeout(() => {
    if (args[0] === "d") {
      child.emit("error", new Error("引擎下载命令被调用（dry-run 不该走到这里）"));
      return;
    }
    // locate / meta 等只读子命令：给空输出即可（本用例只关心「有没有走 d」）
    child.stdout.write("");
    child.stdout.end();
    child.emit("close", 0);
  }, 0);
  return child;
}

require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, {
    spawn: fakeSpawn,
    spawnSync: (cmd, args) => {
      if (!isEngine(cmd)) return realCp.spawnSync(cmd, args);
      engineCalls.push(args.slice());
      if (args[0] === "d") throw new Error("引擎下载命令被调用（dry-run 不该走到这里）");
      return { stdout: "", status: 0, error: null };
    },
  }),
};

// ── mock lib/http.js：让 web API 返回一个目录条目 ──
const httpPath = require.resolve("../lib/http");
const realHttp = require("../lib/http");
const dirList = { errno: 0, list: [{ path: "/dir/", server_filename: "dir", isdir: 1, size: 0 }] };
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: Object.assign({}, realHttp, {
    webJson: async () => dirList,
    webJsonAsync: async () => dirList,
  }),
};

const pan = require("../lib/pan");

test.after(() => {
  delete require.cache[cpPath];
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

// 回归自：dry-run 判定排在「目录 → 回退引擎」之后 → bdp get <目录> --dry-run
// 会真的把整个目录下载下来（实测 47MB）
test("pan: get <目录> --dry-run 不落盘，也不触发引擎下载", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-dryrun-"));
  try {
    const r = await pan.download("/dir", tmp, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.engine, "dry-run");
    assert.ok(
      !engineCalls.some((a) => a[0] === "d"),
      "引擎下载命令不应被调用: " + JSON.stringify(engineCalls)
    );
    assert.deepEqual(fs.readdirSync(tmp), [], "dry-run 不应落盘");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
