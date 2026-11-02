const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");
const VERSION = require("../package.json").version;

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-envfix-cfg-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

// 写一份「已激活 profile」的合成配置（隔离，不碰用户真实配置）
fs.writeFileSync(
  path.join(CFG_DIR, "config.json"),
  JSON.stringify({
    bduss: "PROBE_FAKE_BDUSS",
    stoken: "PROBE_FAKE_STOKEN",
    ua: "probe-ua",
    pcsPath: "BaiduPCS-Go",
    profiles: { work: { bduss: "PROBE_W", stoken: "PROBE_W" } },
    activeProfile: "work",
  }),
  "utf-8"
);

const errorCodes = require("../lib/error-codes");
const mcp = require("../lib/mcp");

test.after(() => {
  const resolved = path.resolve(CFG_DIR);
  assert.ok(resolved.indexOf(path.resolve(os.tmpdir())) === 0);
  fs.rmSync(resolved, { recursive: true, force: true });
});

function cliRun(args) {
  return spawnSync(process.execPath, [BDP_JS].concat(args), {
    encoding: "utf-8",
    timeout: 60000,
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: CFG_DIR }),
  });
}
function cliJson(args) {
  const r = cliRun(args);
  try {
    return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  } catch (e) {
    return { status: r.status, json: null, stderr: r.stderr, stdout: r.stdout.slice(0, 300) };
  }
}

// ── 回归 1：meta.profile 必须是「实际使用的账号」，不是 null ──
test("信封: meta.profile 反映实际激活的 profile（多账号下不能恒为 null）", () => {
  const { json } = cliJson(["whoami", "--json"]);
  assert.ok(json && json.meta, "应有 meta");
  assert.equal(json.profile, "work", "body 里的 profile");
  assert.equal(json.meta.profile, "work", "信封里的 profile 必须与实际账号一致");
});

test("信封: meta.profile 在无激活 profile 时为 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-noprof-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ua: "u", pcsPath: "BaiduPCS-Go" }), "utf-8");
    const r = spawnSync(process.execPath, [BDP_JS, "whoami", "--json"], {
      encoding: "utf-8", timeout: 60000,
      env: Object.assign({}, process.env, { BDP_CONFIG_DIR: dir }),
    });
    const j = JSON.parse(r.stdout);
    assert.equal(j.meta.profile, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 回归 2：CLI 失败路径也要有信封 + 结构化错误码 ──
test("信封: CLI 失败路径也带 meta（Agent 最需要诊断时不能缺）", () => {
  const { json } = cliJson(["ls", "/__bdp_probe_nonexistent__", "--json"]);
  assert.ok(json, "失败路径应输出 JSON");
  assert.ok(json.meta, "失败路径也应有 meta");
  assert.equal(json.meta.command, "ls");
  assert.equal(json.meta.version, VERSION);
});

test("错误码: CLI 失败路径带上结构化的 errorCode", () => {
  const { json } = cliJson(["ls", "/__bdp_probe_nonexistent__", "--json"]);
  assert.ok(json.error, "应保留 error 文本（向后兼容）");
  if (json.errno !== undefined) {
    assert.ok(json.errorCode, "有 errno 时应带 errorCode");
    assert.equal(typeof json.errorCode.code, "number");
    assert.ok(json.errorCode.severity);
    assert.ok(json.errorCode.action);
  }
});

// ── 回归 3：所有 JSON 输出都过信封（cat/head/tail/grep 曾绕过） ──
// 回归 3（hermetic 版）：cat/head/tail/grep 的 JSON 通道必须过信封。
//
// 旧版直接跑真实 CLI 访问真实网盘 → 没账号就**永远 skip**（本项目实测一次都没真正跑过）。
// 现在改成源码级守门：这 4 个 handler 的 JSON 出口必须是 emitJson / output / withMeta 之一，
// 任何绕过（例如裸 console.log(JSON.stringify(...))）都会让 meta 丢失 —— 这正是当年那个 bug。
test("信封: cat/head/tail/grep 的 JSON 通道都过信封（源码级守门）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "bdp.js"), "utf-8");
  for (const cmd of ["cat", "head", "tail", "grep"]) {
    const start = src.indexOf("cmds." + cmd + " = async");
    assert.ok(start > 0, "找不到 cmds." + cmd + " 的 handler");
    const next = src.indexOf("\ncmds.", start + 10);
    const body = src.slice(start, next > 0 ? next : start + 5000);
    assert.ok(
      /emitJson\(|output\(|withMeta\(/.test(body),
      "cmds." + cmd + " 的 JSON 出口必须过 emitJson / output / withMeta —— 否则 meta 会丢"
    );
  }
});

// ── 回归 4：--no-meta 可以放在命令之前 ──
test("信封: --no-meta 放在命令之前也生效（此前会报「未知命令」）", () => {
  const r = cliRun(["--no-meta", "help", "--json"]);
  assert.equal(r.status, 0, r.stdout.slice(0, 200) + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.meta, undefined);
});

// ── 回归 5：describeError 对非规范写法也要给出数值 code ──
test("错误码: 非规范写法（errno=31066 / +31066）也要给出数值 code", () => {
  assert.equal(errorCodes.describeError("errno=31066").code, 31066);
  assert.equal(errorCodes.describeError("errno = -3").code, -3);
  assert.equal(errorCodes.describeError(" 31066 ").code, 31066);
  assert.equal(errorCodes.describeError("errno=-32000").code, -32000);
});

test("错误码: 未登记码的原样回显要限长（防输出放大）", () => {
  const info = errorCodes.describeError("x".repeat(100000));
  assert.ok(info.codeText.length <= 220, "codeText 应被截断，实际 " + info.codeText.length);
  assert.ok(info.description.length <= 400);
});

// ── 回归 6：MCP 工具缺必填参数 → 参数错误，且绝不触碰引擎 ──
test("MCP: 缺必填参数时报 user-error，绝不把 undefined 递给引擎", async () => {
  const cases = [
    ["bdp_mkdir", {}],
    ["bdp_put", {}],
    ["bdp_move", {}],
    ["bdp_copy", {}],
    ["bdp_remove", {}],
    ["bdp_read", {}],
    ["bdp_preview", {}],
    ["bdp_peek", {}],
    ["bdp_get", {}],
    ["bdp_search", {}],
    ["bdp_ask", {}],
  ];
  for (const [name, args] of cases) {
    let err = null;
    try {
      await mcp.callTool(name, args);
    } catch (e) {
      err = e;
    }
    assert.ok(err, name + " 缺参数应报错");
    assert.equal(err.toolArgumentError, true, name + " 应标记为参数错误: " + err.message);
  }
});

test("MCP: 参数错误在 HTTP 响应里是结构化的 user-error（-32001）", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "envfix-token-1234" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer envfix-token-1234" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "bdp_mkdir", arguments: {} },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error.code, -32001);
    assert.equal(payload.error.name, "TOOL_ARGUMENT_ERROR");
    assert.equal(payload.error.severity, "user-error");
    assert.equal(payload.error.retryable, false);
    assert.ok(payload.meta, "错误体也应带 meta");
    assert.equal(payload.meta.command, "bdp_mkdir");
  } finally {
    await srv.close();
  }
});

// ── 回归 7：MCP 错误体带信封；错误消息做净化 ──
test("MCP: 错误响应带 meta，且消息里的控制字符/伪标记被中和", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "envfix-token-5678" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer envfix-token-5678" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      }),
    });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    assert.ok(payload.meta, "错误体应带 meta");
    assert.equal(typeof payload.error.code, "number");
    assert.equal(typeof payload.error.message, "string");
    assert.equal(payload.error.message.indexOf("\u001B"), -1, "错误消息不应有 ESC");
    assert.equal(payload.error.message.indexOf("</untrusted_file>"), -1, "伪标记应被中和");
  } finally {
    await srv.close();
  }
});

// ── 回归 8：MCP bdp_error 的 list 参数与 CLI 一致（宽松接受） ──
test("MCP: bdp_error 的 list 接受 true/\"true\"/1（与 CLI 口径一致）", async () => {
  for (const list of [true, "true", 1]) {
    const r = await mcp.callTool("bdp_error", { list: list });
    assert.ok(r.count >= 12, "list=" + JSON.stringify(list) + " 应列出全部错误码");
    assert.equal(r.errors.length, r.count);
  }
});
