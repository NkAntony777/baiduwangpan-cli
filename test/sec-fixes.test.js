const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-sec-cfg-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

const config = require("../lib/config");
const { sanitizeControl } = require("../lib/sanitize");

test.after(() => {
  const resolved = path.resolve(CFG_DIR);
  assert.ok(resolved.indexOf(path.resolve(os.tmpdir())) === 0);
  fs.rmSync(resolved, { recursive: true, force: true });
});

// ── MCP 写工具：mock pcs-extra 以捕获引擎实参 ──────────────
const extraPath = require.resolve("../lib/pcs-extra");
const realExtra = require("../lib/pcs-extra");
const mvCalls = [];
require.cache[extraPath] = {
  id: extraPath,
  filename: extraPath,
  loaded: true,
  exports: Object.assign({}, realExtra, {
    mv: (s, d) => {
      mvCalls.push([s, d]);
      return { src: s, dst: d, op: "rename", renamed: true, raw: "ok" };
    },
  }),
};
const mcp = require("../lib/mcp");

// A-1：bdp_rename 的「只改文件名」约束不能被 . / .. / 控制字符绕过
test("MCP: bdp_rename 拒绝 . / .. / 控制字符作为目标名（否则可跨目录移动）", async () => {
  for (const bad of ["..", ".", "a\u0000b.txt", "a\u001Bb.txt"]) {
    mvCalls.length = 0;
    const r = await mcp.callTool("bdp_rename", {
      files: [{ from: "/docs/a.txt", to: bad }],
      dryRun: false,
    });
    assert.equal(r.results[0].ok, false, "目标名 " + JSON.stringify(bad) + " 应被拒绝");
    assert.match(r.results[0].error, /只允许改文件名/);
    assert.equal(mvCalls.length, 0, "引擎不应被调用");
  }
});

test("MCP: bdp_rename 正常改名仍然可用，且回报路径 == 实际执行路径", async () => {
  mvCalls.length = 0;
  const r = await mcp.callTool("bdp_rename", {
    files: [{ from: "/docs/a.txt", to: "b.txt" }],
    dryRun: false,
  });
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].to, "/docs/b.txt");
  assert.deepEqual(mvCalls[0], ["/docs/a.txt", "/docs/b.txt"], "引擎实参与回报必须一致");
});

test("MCP: bdp_rename 的 from 含 .. 时拒绝（归一化会预览≠执行，见 v1.11.3 审核 4-M2）", async () => {
  // 这条原先断言「.. 会被归一化」—— 出发点（不能拼到目录外）对，但归一化本身就是缺陷：
  // /docs/sub/../a.txt 归一后是 /docs/a.txt，可回传的 from 与实际下发的路径**不是同一个字符串**，
  // 更狠的是 /a/../../etc/passwd 归一成 /etc/passwd —— 用户以为改 A、实际改 B。
  // 现在含 .. 段一律拒绝，并要求调用方自己传规范化后的绝对路径。
  mvCalls.length = 0;
  const r = await mcp.callTool("bdp_rename", {
    files: [{ from: "/docs/sub/../a.txt", to: "b.txt" }],
    dryRun: false,
  });
  assert.equal(r.results[0].ok, false, "含 .. 的 from 应被拒绝");
  assert.match(r.results[0].error, /\.\./, "错误消息应说明 .. 的问题");
  assert.equal(mvCalls.length, 0, "不得下发任何 mv");
});

// A-5：控制字符不能交给引擎
test("MCP: bdp_move / bdp_copy 拒绝含控制字符的路径", async () => {
  await assert.rejects(() => mcp.callTool("bdp_move", { src: "/a\u0000b.txt", dst: "/x" }), /控制字符/);
  await assert.rejects(() => mcp.callTool("bdp_copy", { src: "/a.txt", dst: "/b\u001Bc" }), /控制字符/);
});

// A-9：MCP depth 有上限
test("MCP: bdp_dedup / bdp_organize 的 depth 被钳制到 32", async () => {
  const dedupPath = require.resolve("../lib/dedup");
  const realDedup = require("../lib/dedup");
  let seenDepth = null;
  require.cache[dedupPath] = {
    id: dedupPath,
    filename: dedupPath,
    loaded: true,
    exports: Object.assign({}, realDedup, {
      scanDuplicates: async (root, opts) => {
        seenDepth = opts.maxDepth;
        return { root, scannedFiles: 0, scannedDirs: 0, failedDirs: 0, clusters: [], wastedBytes: 0, partial: false, badEntries: 0, pagedOut: false };
      },
      scanFiles: async (root, opts) => {
        seenDepth = opts.maxDepth;
        return { root, files: [], dirs: 0, failed: 0, failedDirs: [], badEntries: 0, pagedOut: false, depthCapped: false, partial: false, depthLimit: opts.maxDepth };
      },
    }),
  };
  const mcp2 = require("../lib/mcp");
  try {
    await mcp2.callTool("bdp_dedup", { path: "/", depth: 1000000 });
    assert.ok(seenDepth <= 32, "depth 应被钳制，实际 " + seenDepth);
    await mcp2.callTool("bdp_organize", { path: "/", byType: true, depth: 999999 });
    assert.ok(seenDepth <= 32, "depth 应被钳制，实际 " + seenDepth);
  } finally {
    require.cache[dedupPath] = realDedup;
  }
});

// A-10：pcsPath 必须精确匹配引擎名
test("config: pcsPath 只接受精确的引擎文件名（前缀匹配会放行任意 exe）", () => {
  assert.equal(config.validateConfigValue("pcsPath", "BaiduPCS-Go.exe").ok, true);
  assert.equal(config.validateConfigValue("pcsPath", "BaiduPCS-Go-v4.0.1-windows-x64.exe").ok, true);
  for (const bad of ["BaiduPCS-GoX.exe", "BaiduPCS-Gonevil.exe", "C:/Windows/System32/hostname.exe"]) {
    const r = config.validateConfigValue("pcsPath", bad);
    assert.equal(r.ok, false, bad + " 应被拒绝");
  }
});

// A-4：合法排版字符保留、RLO 剔除
test("sanitize: RLO/ESC 剔除，ZWSP/ZWNJ/LRM 保留（路径仍可寻址）", () => {
  assert.equal(sanitizeControl("a\u202Eb").indexOf("\u202E"), -1);
  assert.equal(sanitizeControl("a\u001Bb").indexOf("\u001B"), -1);
  assert.equal(sanitizeControl("a\u200Bb").indexOf("\u200B"), 1);
  assert.equal(sanitizeControl("a\u200Cb").indexOf("\u200C"), 1);
  assert.equal(sanitizeControl("a\u200Eb").indexOf("\u200E"), 1);
});

// A-13：sanitizeDeep 不把 __proto__ 变成原型
test("MCP: 返回值里的 __proto__ 不会变成原型", async () => {
  const panPath = require.resolve("../lib/pan");
  const realPan = require.cache[panPath];
  require.cache[panPath] = {
    id: panPath,
    filename: panPath,
    loaded: true,
    exports: Object.assign({}, require("../lib/pan"), {
      lsEntries: () => ({
        path: "/",
        entries: [{ index: 0, name: "x", path: "/x", isDir: false }],
        totalText: "1 B",
        fileCount: 1,
        dirCount: 0,
        raw: "",
        warning: null,
      }),
    }),
  };
  try {
    const evil = JSON.parse('{"__proto__":{"polluted":"YES"},"normal":1}');
    const r = await mcp.callTool("bdp_ls", { path: "/" });
    assert.ok(r && typeof r === "object");
    assert.equal(({}).polluted, undefined, "全局原型不得被污染");
    assert.equal(Object.prototype.hasOwnProperty.call(r, "__proto__"), false);
    assert.ok(evil);
  } finally {
    if (realPan) require.cache[panPath] = realPan;
    else delete require.cache[panPath];
  }
});

// A-6：CLI 闸门
function cliRun(args) {
  return spawnSync(process.execPath, [BDP_JS].concat(args), {
    encoding: "utf-8",
    timeout: 60000,
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: CFG_DIR }),
  });
}

test("CLI: share set 没有 --yes 时拒绝（创建公开链接 = 对外暴露数据）", () => {
  const r = cliRun(["share", "set", "/x", "--pwd", "1234"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--yes/);
});

test("CLI: offline add 拒绝内网/本机地址（SSRF 跳板）", () => {
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/x", "http://192.168.1.1/x", "file:///etc/passwd"]) {
    const r = cliRun(["offline", "add", u, "--yes"]);
    assert.equal(r.status, 1, u + " 应被拒绝");
    assert.match(r.stderr + r.stdout, /拒绝|只支持/);
  }
});

test("CLI: offline add 没有 --yes 时拒绝", () => {
  const r = cliRun(["offline", "add", "http://example.com/a.iso"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--yes/);
});

test("CLI: recycle restore 批量还原需要 --yes", () => {
  const r = cliRun(["recycle", "restore", "111", "222"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--yes/);
});
