const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── mock child_process：引擎一旦被要求「下载」就报错 ──
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const engineCalls = [];
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, {
    spawnSync: (cmd, args) => {
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
