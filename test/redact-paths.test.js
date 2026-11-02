// T-05：路径脱敏抽成公共函数，CLI 与 MCP 共用 —— 两侧对同一输入必须产出**一致**的结果。
//
// 回归背景（两条独立缺陷）：
//   1. MCP 侧的正则以**空白**为终止符 → 含空格的路径（`C:\Program Files\...`）
//      只遮蔽第一段，残留目录结构与文件名；
//   2. CLI 侧顶层 catch **完全不做脱敏** → 引擎缺失时 stderr 输出完整绝对路径
//      （含 Windows 用户名）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { redactLocalPaths } = require("../lib/sanitize");

// ── 隔离环境：含空格的假引擎绝对路径 + 隔离配置目录 ──────────────────
// （真实场景就是 `C:\Program Files\BaiduPCS-Go\BaiduPCS-Go.exe`）
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-redact-"));
const ENGINE_DIR = path.join(TMP_ROOT, "Program Files", "BaiduPCS-Go");
fs.mkdirSync(ENGINE_DIR, { recursive: true });
const FAKE_ENGINE = path.join(ENGINE_DIR, "BaiduPCS-Go.exe");
fs.writeFileSync(FAKE_ENGINE, "not a real engine");

const TMP_CFG = path.join(TMP_ROOT, "cfg");
fs.mkdirSync(TMP_CFG, { recursive: true });
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: FAKE_ENGINE }),
  "utf-8"
);

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("T-05: 含空格的本地绝对路径被**整体**遮蔽（不残留目录片段）", () => {
  const msg = "未找到 BaiduPCS-Go 可执行文件: " + FAKE_ENGINE + "。请在 config 中设置 pcsPath。";
  const out = redactLocalPaths(msg);
  assert.ok(out.indexOf("<local-path>") >= 0, "应出现 <local-path> 标记: " + out);
  assert.equal(out.indexOf("Program Files"), -1, "不应残留目录片段: " + out);
  assert.equal(out.indexOf("BaiduPCS-Go.exe"), -1, "不应残留文件名: " + out);
  assert.ok(out.indexOf("请在 config 中设置 pcsPath") >= 0, "路径之后的说明文字应保留: " + out);
});

test("T-05: CLI 侧顶层 catch 会脱敏本地绝对路径", () => {
  const r = spawnSync(process.execPath, [BDP_JS, "ls", "/"], {
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: TMP_CFG }),
    encoding: "utf-8",
  });
  const err = r.stderr || "";
  assert.notEqual(err, "", "引擎缺失时 stderr 应该有内容");
  assert.ok(err.indexOf("<local-path>") >= 0, "CLI stderr 应有 <local-path>: " + err);
  assert.equal(err.indexOf("Program Files"), -1, "CLI stderr 不应泄漏本地路径: " + err);
  assert.equal(err.indexOf(FAKE_ENGINE), -1, "CLI stderr 不应出现完整路径: " + err);
});

test("T-05: MCP 侧与 CLI 侧对同一路径产出**一致**的脱敏结果", async () => {
  const mcp = require("../lib/mcp");
  const srv = await mcp.startHttpServer({ port: 0, token: "vfy-token-1101c" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer vfy-token-1101c" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_ls", arguments: { path: "/" } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true, "引擎不可用时应是错误响应");
    const payload = JSON.parse(body.result.content[0].text);
    const msg = payload.error.message;
    assert.ok(/<local-path>/.test(msg), "MCP message 应有 <local-path>: " + msg);
    assert.equal(msg.indexOf("Program Files"), -1, "MCP message 不应残留目录片段: " + msg);
    assert.equal(msg.indexOf(FAKE_ENGINE), -1, "MCP message 不应出现完整路径: " + msg);
  } finally {
    await srv.close();
  }
});
