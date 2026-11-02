const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-env-detail-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

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

// ── 分层的基本契约：默认不下发内部细节 ──────────────────────────
test("describeError: 默认不下发 internalDetail（省 Agent 上下文）", () => {
  for (const e of errorCodes.listErrors()) {
    const info = errorCodes.describeError(e.code);
    assert.equal(
      Object.prototype.hasOwnProperty.call(info, "internalDetail"),
      false,
      "错误码 " + e.code + " 默认不应带 internalDetail"
    );
    assert.ok(info.description && info.description.length > 0);
    assert.ok(info.action && info.action.length > 0);
  }
});

test("describeError: verbose=true 时才附带 internalDetail", () => {
  for (const e of errorCodes.listErrors()) {
    const info = errorCodes.describeError(e.code, { verbose: true });
    assert.equal(typeof info.internalDetail, "string", "错误码 " + e.code + " 应有 internalDetail");
    assert.ok(info.internalDetail.length > 0, "错误码 " + e.code + " 的 internalDetail 不应为空");
    assert.ok(
      info.internalDetail.indexOf("\u001B") === -1,
      "internalDetail 不应含 ESC 控制字符"
    );
    assert.equal(
      info.internalDetail.indexOf("</untrusted_file>"),
      -1,
      "internalDetail 不应含边界标记"
    );
  }
});

test("describeError: 结论与内部细节分层不互相污染", () => {
  const plain = errorCodes.describeError("31066");
  const deep = errorCodes.describeError("31066", { verbose: true });
  assert.equal(plain.code, deep.code);
  assert.equal(plain.name, deep.name);
  assert.equal(plain.severity, deep.severity);
  assert.equal(plain.retryable, deep.retryable);
  assert.equal(plain.description, deep.description, "description 不应因 verbose 而变化");
  assert.equal(plain.action, deep.action, "action 不应因 verbose 而变化");
  assert.ok(deep.internalDetail.length > 0);
  assert.ok(
    JSON.stringify(deep).length > JSON.stringify(plain).length,
    "verbose 版整体应更大（内部细节确实多给了内容）"
  );
});

test("listErrors: 默认不带 internalDetail，verbose 时才带", () => {
  const plain = errorCodes.listErrors();
  const deep = errorCodes.listErrors({ verbose: true });
  assert.equal(plain.length, deep.length);
  for (const e of plain) {
    assert.equal(Object.prototype.hasOwnProperty.call(e, "internalDetail"), false);
  }
  for (const e of deep) {
    assert.ok(typeof e.internalDetail === "string" && e.internalDetail.length > 0);
  }
});

test("describeError: 未登记错误码 verbose 时也给出内部细节", () => {
  const plain = errorCodes.describeError("999999");
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "internalDetail"), false);
  const deep = errorCodes.describeError("999999", { verbose: true });
  assert.equal(typeof deep.internalDetail, "string");
  assert.ok(deep.internalDetail.length > 0);
  assert.equal(deep.name, "UNKNOWN_ERROR");
});

test("explainError: verbose 时人类可读输出多一段「内部细节」", () => {
  const plain = errorCodes.explainError("31066");
  const deep = errorCodes.explainError("31066", { verbose: true });
  assert.equal(plain.indexOf("内部细节"), -1, "默认输出不应含内部细节段");
  assert.ok(deep.indexOf("内部细节") >= 0, "verbose 输出应含内部细节段");
  assert.ok(deep.length > plain.length);
  assert.equal(deep.indexOf("\u001B"), -1);
});

// ── CLI 侧 ─────────────────────────────────────────────────────
test("CLI: bdp error --json 默认不带 internalDetail", () => {
  const r = cliRun(["error", "-3", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "SHARE_API_REJECTED");
  assert.equal(Object.prototype.hasOwnProperty.call(j, "internalDetail"), false);
});

test("CLI: bdp error --json --verbose 才带 internalDetail", () => {
  const r = cliRun(["error", "-3", "--json", "--verbose"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "SHARE_API_REJECTED");
  assert.equal(typeof j.internalDetail, "string");
  assert.ok(j.internalDetail.length > 0);
  assert.equal(Object.prototype.hasOwnProperty.call(j.meta, "internalDetail"), false);
});

test("CLI: bdp error 人类可读输出默认不泄露内部细节，--verbose 才显示", () => {
  const plain = cliRun(["error", "31066"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.indexOf("内部细节"), -1);
  const deep = cliRun(["error", "31066", "--verbose"]);
  assert.equal(deep.status, 0, deep.stderr);
  assert.ok(deep.stdout.indexOf("内部细节") >= 0);
});

test("CLI: bdp error --list --json 的 internalDetail 受 --verbose 控制", () => {
  const plain = JSON.parse(cliRun(["error", "--list", "--json"]).stdout);
  const deep = JSON.parse(cliRun(["error", "--list", "--json", "--verbose"]).stdout);
  assert.equal(plain.count, deep.count);
  for (const e of plain.errors) {
    assert.equal(Object.prototype.hasOwnProperty.call(e, "internalDetail"), false);
  }
  for (const e of deep.errors) {
    assert.ok(typeof e.internalDetail === "string" && e.internalDetail.length > 0);
  }
  // 分层确实省体积：verbose 版更大
  const plainSize = JSON.stringify(plain.errors).length;
  const deepSize = JSON.stringify(deep.errors).length;
  assert.ok(deepSize > plainSize, "verbose 版应更大");
});

test("CLI: --verbose 放在命令之前也能生效", () => {
  const r = cliRun(["--verbose", "error", "31066", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.internalDetail, "string");
});

// ── MCP 侧 ─────────────────────────────────────────────────────
test("MCP: bdp_error 默认不带 internalDetail", async () => {
  const r = await mcp.callTool("bdp_error", { code: "31066" });
  assert.equal(r.name, "FILE_NOT_FOUND");
  assert.equal(Object.prototype.hasOwnProperty.call(r, "internalDetail"), false);
});

test("MCP: bdp_error verbose:true 时才带 internalDetail", async () => {
  const r = await mcp.callTool("bdp_error", { code: "31066", verbose: true });
  assert.equal(typeof r.internalDetail, "string");
  assert.ok(r.internalDetail.length > 0);
});

test("MCP: bdp_error list 的 internalDetail 受 verbose 控制", async () => {
  const plain = await mcp.callTool("bdp_error", { list: true });
  const deep = await mcp.callTool("bdp_error", { list: true, verbose: true });
  assert.equal(plain.count, deep.count);
  for (const e of plain.errors) {
    assert.equal(Object.prototype.hasOwnProperty.call(e, "internalDetail"), false);
  }
  for (const e of deep.errors) {
    assert.ok(typeof e.internalDetail === "string" && e.internalDetail.length > 0);
  }
});

test("MCP 与 CLI 的分层口径一致（默认与 verbose 都逐字段相同）", async () => {
  const cliPlain = JSON.parse(cliRun(["error", "-3", "--json"]).stdout);
  const cliDeep = JSON.parse(cliRun(["error", "-3", "--json", "--verbose"]).stdout);
  const mcpPlain = await mcp.callTool("bdp_error", { code: "-3" });
  const mcpDeep = await mcp.callTool("bdp_error", { code: "-3", verbose: true });
  const strip = (o) => {
    const c = Object.assign({}, o);
    delete c.meta;
    return c;
  };
  assert.deepEqual(strip(cliPlain), strip(mcpPlain), "默认口径必须一致");
  assert.deepEqual(strip(cliDeep), strip(mcpDeep), "verbose 口径必须一致");
});

test("MCP: bdp_error 的 inputSchema 声明了 verbose", () => {
  const def = mcp.toolDefs().find((t) => t.name === "bdp_error");
  assert.ok(def, "应有 bdp_error 工具");
  assert.ok(def.inputSchema.properties.verbose, "应声明 verbose 参数");
  assert.equal(def.inputSchema.properties.verbose.type, "boolean");
});
