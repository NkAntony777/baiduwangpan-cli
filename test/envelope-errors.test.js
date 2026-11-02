const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");
const VERSION = require("../package.json").version;

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-env-cfg-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

const errorCodes = require("../lib/error-codes");

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

// ══════════════════════════════════════════════════════════
// 1. lib/error-codes.js —— 错误码表本身
// ══════════════════════════════════════════════════════════

test("error-codes: 已知错误码返回结构化结果（code 为数值）", () => {
  const info = errorCodes.describeError("-3");
  assert.equal(info.code, -3);
  assert.equal(typeof info.code, "number");
  assert.equal(info.name, "SHARE_API_REJECTED");
  assert.equal(info.severity, "retryable");
  assert.equal(info.retryable, true);
  assert.ok(info.action && info.action.length > 0, "必须有可执行的 action");
  assert.ok(info.description && info.description.length > 0);
});

test("error-codes: severity 三态齐备，且 retryable 与 severity 一致", () => {
  const all = errorCodes.listErrors();
  assert.ok(all.length >= 12, "错误码应 ≥12 条，实际 " + all.length);
  const severities = new Set(all.map((e) => e.severity));
  for (const s of ["retryable", "fatal", "user-error"]) {
    assert.ok(severities.has(s), "缺少 severity: " + s);
  }
  for (const e of all) {
    assert.equal(typeof e.code, "number");
    assert.ok(e.name && e.description && e.action);
    assert.equal(e.retryable, e.severity === "retryable");
  }
});

test("error-codes: 未登记的错误码也能给出可用结构", () => {
  const info = errorCodes.describeError("999999");
  assert.equal(info.code, 999999);
  assert.equal(info.name, "UNKNOWN_ERROR");
  assert.equal(info.severity, "unknown");
  assert.equal(info.retryable, false);
  assert.ok(info.action.length > 0);
});

test("error-codes: 容忍 errno=31066 这类写法", () => {
  assert.equal(errorCodes.lookup("errno=31066").name, "FILE_NOT_FOUND");
  assert.equal(errorCodes.lookup(" 31066 ").name, "FILE_NOT_FOUND");
  assert.equal(errorCodes.lookup(31066).name, "FILE_NOT_FOUND");
});

// ══════════════════════════════════════════════════════════
// 2. CLI —— 统一响应信封 + 结构化错误码
// ══════════════════════════════════════════════════════════

test("CLI: bdp error --json 返回结构化错误码（含 action 与 severity）", () => {
  const r = cliRun(["error", "-3", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.code, -3);
  assert.equal(typeof j.code, "number", "code 必须是数值");
  assert.equal(j.name, "SHARE_API_REJECTED");
  assert.equal(j.severity, "retryable");
  assert.equal(j.retryable, true);
  assert.ok(j.action.length > 0);
});

test("CLI: bdp error --list --json 列出全部错误码", () => {
  const r = cliRun(["error", "--list", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.count >= 12);
  assert.equal(j.errors.length, j.count);
});

test("CLI: 所有 --json 输出都带 meta 信封（command/version/profile/elapsedMs）", () => {
  const r = cliRun(["help", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.meta, "应有 meta");
  assert.equal(j.meta.command, "help");
  assert.equal(j.meta.version, VERSION);
  assert.equal(typeof j.meta.elapsedMs, "number");
  assert.ok(j.meta.elapsedMs >= 0);
  assert.ok("profile" in j.meta);
});

test("CLI: --no-meta 可以关掉信封", () => {
  const r = cliRun(["help", "--json", "--no-meta"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.meta, undefined, "--no-meta 时不应有 meta");
});

test("CLI: 信封只追加字段，不改动既有字段", () => {
  const withMeta = JSON.parse(cliRun(["help", "--json"]).stdout);
  const without = JSON.parse(cliRun(["help", "--json", "--no-meta"]).stdout);
  const a = Object.assign({}, withMeta);
  const b = Object.assign({}, without);
  delete a.meta;
  assert.deepEqual(a, b, "除了 meta 之外字段必须完全一致");
});

test("CLI: 非 --json 输出不受信封影响", () => {
  const r = cliRun(["error", "-3"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.indexOf("SHARE_API_REJECTED") >= 0, "人类可读输出应含错误名");
  assert.equal(r.stdout.indexOf('"meta"'), -1, "非 JSON 输出不应出现 meta");
});

// ══════════════════════════════════════════════════════════
// 3. MCP —— 工具、错误结构、信封
// ══════════════════════════════════════════════════════════

const mcp = require("../lib/mcp");

test("MCP: 工具清单包含 bdp_error", () => {
  const names = mcp.toolDefs().map((t) => t.name);
  assert.ok(names.includes("bdp_error"));
  assert.ok(names.length >= 19, "工具数应 ≥19，实际 " + names.length);
});

test("MCP: bdp_error 与 CLI bdp error 返回同一份结构（逐字段）", async () => {
  const cli = JSON.parse(cliRun(["error", "-3", "--json"]).stdout);
  const mcpRes = await mcp.callTool("bdp_error", { code: "-3" });
  const a = Object.assign({}, cli);
  const b = Object.assign({}, mcpRes);
  delete a.meta; // CLI 的信封字段不算在内
  assert.deepEqual(a, b, "CLI 与 MCP 的错误码结构必须逐字段一致");
});

test("MCP: bdp_error --list 列出全部错误码", async () => {
  const r = await mcp.callTool("bdp_error", { list: true });
  assert.ok(r.count >= 12);
  assert.equal(r.errors.length, r.count);
});

test("MCP: 未知工具返回结构化错误（error.code 为数值、可 JSON 解析）", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "env-test-token-123" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer env-test-token-123" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.ok(payload.error, "应有 error 字段");
    assert.equal(typeof payload.error.code, "number", "error.code 必须是数值");
    assert.equal(typeof payload.error.name, "string");
    assert.equal(typeof payload.error.message, "string");
    assert.equal(typeof payload.error.retryable, "boolean");
    assert.equal(typeof payload.error.action, "string");
    assert.ok(payload.error.action.length > 0);
  } finally {
    await srv.close();
  }
});

test("MCP: 工具结果带 meta 信封", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "env-test-token-456" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer env-test-token-456" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_error", arguments: { code: "31066" } },
      }),
    });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    assert.ok(payload.meta, "工具结果应有 meta");
    assert.equal(payload.meta.command, "bdp_error");
    assert.equal(payload.meta.version, VERSION);
    assert.equal(typeof payload.meta.elapsedMs, "number");
  } finally {
    await srv.close();
  }
});

test("MCP: 已知 errno 的工具错误应命中错误码表（severity/retryable 正确）", async () => {
  const errCodes = require("../lib/error-codes");
  const info = errCodes.describeError(31066);
  assert.equal(info.severity, "user-error");
  assert.equal(info.retryable, false);
});
