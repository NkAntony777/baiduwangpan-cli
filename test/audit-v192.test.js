const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

// 关键：配置目录指向临时目录 —— 本文件会跑 --profile，绝不能碰用户的真实配置
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-env-v192-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

const errorCodes = require("../lib/error-codes");
const flags = require("../lib/flags");
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

// ── 审核发现 1：错误码查表被宽松正则误伤 ──────────────────────
test("lookup: 只接受 errno=NNN 形态，不再从任意字符串抽数字", () => {
  assert.equal(errorCodes.lookup("abc31066"), null, "abc31066 不该命中");
  assert.equal(errorCodes.lookup("31066abc"), null, "31066abc 不该命中");
  assert.equal(errorCodes.lookup("pid=2"), null, "pid=2 不该命中");
  assert.equal(errorCodes.lookup("v2"), null, "v2 不该命中");
  assert.equal(errorCodes.lookup("-3abc"), null, "-3abc 不该命中");
});

test("lookup: 承诺支持的写法仍然命中", () => {
  assert.equal(errorCodes.lookup("errno=31066").name, "FILE_NOT_FOUND");
  assert.equal(errorCodes.lookup("errno = -3").name, "SHARE_API_REJECTED");
  assert.equal(errorCodes.lookup("errno=-32000").name, "TOOL_ERROR");
  assert.equal(errorCodes.lookup(" 31066 ").name, "FILE_NOT_FOUND");
  assert.equal(errorCodes.lookup("31066").name, "FILE_NOT_FOUND");
  assert.equal(errorCodes.lookup(31066).name, "FILE_NOT_FOUND");
});

test("describeError: 控制字符输入不再被误判成另一个错误码", () => {
  const info = errorCodes.describeError("\u001b[2J\u001b[H31066");
  assert.equal(info.name, "UNKNOWN_ERROR", "不能命中 errno=2");
  assert.equal(info.code, null);
  assert.equal(info.severity, "unknown");
});

test("describeError: 明显无关的输入给 UNKNOWN 而不是错误的确切码", () => {
  assert.equal(errorCodes.describeError("abc31066").name, "UNKNOWN_ERROR");
  assert.equal(errorCodes.describeError("pid=2").name, "UNKNOWN_ERROR");
});

// ── 审核发现 2：布尔口径分叉 ───────────────────────────────────
test("flags.toBool: 字符串 false/0 是 false，不是真值", () => {
  assert.equal(flags.toBool("false"), false);
  assert.equal(flags.toBool("0"), false);
  assert.equal(flags.toBool(""), false);
  assert.equal(flags.toBool(undefined), false);
  assert.equal(flags.toBool(null), false);
  assert.equal(flags.toBool({}), false);
  assert.equal(flags.toBool([]), false);
});

test("flags.toBool: 明确的真值形态都认", () => {
  assert.equal(flags.toBool(true), true);
  assert.equal(flags.toBool(1), true);
  assert.equal(flags.toBool("true"), true);
  assert.equal(flags.toBool("TRUE"), true);
  assert.equal(flags.toBool(" 1 "), true);
  assert.equal(flags.toBool("yes"), true);
  assert.equal(flags.toBool("on"), true);
});

test("flags.parseBool: 未给参数时是 false（不是错误）", () => {
  assert.equal(flags.parseBool(undefined, "x"), false);
  assert.equal(flags.parseBool(null, "x"), false);
});

test("flags.parseBool: 非法值抛出带 toolArgumentError 标记的错误", () => {
  let err = null;
  try {
    flags.parseBool("maybe", "list");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应抛错");
  assert.equal(err.toolArgumentError, true, "应带 toolArgumentError 标记（MCP 侧转 -32001）");
  assert.ok(err.message.indexOf("list") >= 0, "错误消息应含参数名");
});

test("describeError/listErrors: 与 MCP 同口径（\"false\" 不开启 internalDetail）", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(errorCodes.describeError("31066", { verbose: "false" }), "internalDetail"),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(errorCodes.listErrors({ verbose: "false" })[0], "internalDetail"),
    false
  );
  assert.equal(
    typeof errorCodes.describeError("31066", { verbose: "1" }).internalDetail,
    "string"
  );
});

// ── 审核发现 3：只给全局选项不给命令 ───────────────────────────
test("CLI: 只给全局选项不给命令 → 退出码 1 + 明确错误（不是退出 0 的纯文本帮助）", () => {
  const r = cliRun(["--json"]);
  assert.equal(r.status, 1, "退出码必须是 1");
  const j = JSON.parse(r.stdout);
  assert.ok(j.error, "应有 error 字段");
  assert.ok(j.error.indexOf("缺少命令") >= 0, "错误消息应说明缺少命令: " + j.error);
  assert.ok(j.meta, "失败路径也应带信封");
});

test("CLI: 裸跑 bdp 仍然是「打印帮助 + 退出 0」", () => {
  const r = cliRun([]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.indexOf("bdp — 百度网盘 CLI") >= 0);
});

// ── 审核发现 4：带值全局选项的前置换 ───────────────────────────
test("CLI: --profile 可以跟在布尔开关之后", () => {
  const r = cliRun(["--json", "--profile", "t1", "error", "-3"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "SHARE_API_REJECTED");
});

test("CLI: --profile 仍然可以放在最前面", () => {
  const r = cliRun(["--profile", "t2", "--json", "error", "-3"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).name, "SHARE_API_REJECTED");
});

test("CLI: --json-file 可以放在命令之前", () => {
  const outFile = path.join(CFG_DIR, "pre.json");
  const r = cliRun(["--json-file", outFile, "error", "-3"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(outFile, "utf-8"));
  assert.equal(j.name, "SHARE_API_REJECTED");
});

// ── 审核发现 5：空串 code 的 CLI/MCP 一致性 ────────────────────
test("CLI 与 MCP: 空串错误码口径一致（都是未登记）", () => {
  const cli = JSON.parse(cliRun(["error", "", "--json"]).stdout);
  assert.equal(cli.name, "UNKNOWN_ERROR");
  assert.equal(cli.code, null);
});

test("CLI: 单个 - 按位置参数处理（不再是「不支持选项」）", () => {
  const r = cliRun(["error", "-", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "UNKNOWN_ERROR");
  assert.equal(j.codeText, "-");
});

// ── 审核发现 6：MCP 布尔参数静默降级 ───────────────────────────
test("MCP: bdp_error 的 list 接受 \"1\"（此前被静默当成不列清单）", async () => {
  const r = await mcp.callTool("bdp_error", { list: "1" });
  assert.ok(Array.isArray(r.errors), "应返回清单");
  assert.equal(r.errors.length, r.count);
});

test("MCP: bdp_error 的 verbose 接受 \"1\" 与 \"true\"", async () => {
  const a = await mcp.callTool("bdp_error", { code: "31066", verbose: "1" });
  assert.equal(typeof a.internalDetail, "string");
  const b = await mcp.callTool("bdp_error", { code: "31066", verbose: "true" });
  assert.equal(typeof b.internalDetail, "string");
});

test("MCP: bdp_error 的 verbose=false 不下发 internalDetail", async () => {
  const r = await mcp.callTool("bdp_error", { code: "31066", verbose: false });
  assert.equal(Object.prototype.hasOwnProperty.call(r, "internalDetail"), false);
});

test("MCP: 无法识别的布尔值报参数错误（-32001），不静默降级", async () => {
  let err = null;
  try {
    await mcp.callTool("bdp_error", { list: "maybe" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应抛错");
  assert.equal(err.toolArgumentError, true);
});

test("MCP: 参数错误在 JSON-RPC 层映射为 -32001", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "v192-token-123456" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer v192-token-123456" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_error", arguments: { list: "maybe" } },
      }),
    });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error.code, -32001);
    assert.equal(payload.error.severity, "user-error");
    assert.equal(payload.error.retryable, false);
  } finally {
    await srv.close();
  }
});

// ── 审核发现 7：错误消息的无界回显 ─────────────────────────────
test("flags.safeString: 超长输入被限长（不把 10 万字符灌进错误消息）", () => {
  const huge = "x".repeat(100000);
  const s = flags.safeString(huge);
  assert.ok(s.length <= 81, "回显应限长到 80 字符 + 省略号，实际 " + s.length);
  assert.ok(s.endsWith("…"));
});

test("flags.safeString: 控制字符被剔除（不会打到终端）", () => {
  const s = flags.safeString("\u001b[2Jabc");
  assert.equal(s.indexOf("\u001B"), -1);
});

test("flags.parseBool: 超长非法值的错误消息有上限", () => {
  let err = null;
  try {
    flags.parseBool("y".repeat(100000), "list");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应抛错");
  assert.ok(err.message.length < 200, "错误消息应有上限，实际 " + err.message.length);
});

test("flags.safeString: 无法转字符串的值不抛异常", () => {
  assert.equal(typeof flags.safeString({}), "string");
  assert.equal(typeof flags.safeString(Symbol("x")), "string");
});

// ── 审核发现 8：--profile 的取值校验 ───────────────────────────
test("CLI: --profile 后面跟选项名时报错，且不建出垃圾 profile", () => {
  const localCfg = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-prof-guard-"));
  try {
    const run = (args) =>
      spawnSync(process.execPath, [BDP_JS].concat(args), {
        encoding: "utf-8",
        timeout: 60000,
        env: Object.assign({}, process.env, { BDP_CONFIG_DIR: localCfg }),
      });
    const r = run(["--profile", "--json", "error", "-3"]);
    assert.equal(r.status, 1, "应报错退出");
    assert.ok((r.stderr || "").indexOf("--profile") >= 0, "错误消息应提到 --profile");
    const cfgFile = path.join(localCfg, "config.json");
    if (fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      assert.equal(cfg.activeProfile, undefined, "不应激活任何 profile");
      assert.equal(
        Object.prototype.hasOwnProperty.call(cfg.profiles || {}, "--json"),
        false,
        "不应建出名为 --json 的 profile"
      );
    }
    // 合法用法仍然可用
    assert.equal(run(["--json", "--profile", "good", "error", "-3"]).status, 0);
  } finally {
    fs.rmSync(localCfg, { recursive: true, force: true });
  }
});
