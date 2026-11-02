// MCP 参数校验：一律 -32001（TOOL_ARGUMENT_ERROR），而不是 -32000（服务端错误）
//
// 回归背景（四路审核实测）：
//   - `bdp_mkdir {path: 123}` 会把数字拼进引擎参数，**真的在网盘根目录建出一个名为 "123" 的目录**
//   - `bdp_gsearch {}` 缺参时先走到网络层，报「无法获取 bdstoken: Web 会话未认证」(-32000) ——
//     参数错误被误报成服务端错误，还白打了一次网络请求
//   - `bdp_remove` 缺 confirm / confirm 传字符串 → -32000
//   - `bdp_organize` 缺维度 / layout 非法 → -32000
//   - `bdp_read {lines:"abc"}` 静默回落 20（调用方以为参数生效了）
//   - 超长 path → 真 spawn 报 ENAMETOOLONG，被映射成「未找到 BaiduPCS-Go 可执行文件」（误导）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-mcp-args-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

test.after(() => {
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

const mcp = require("../lib/mcp");

// 参数错误矩阵：每条都必须带 toolArgumentError（→ -32001）
const CASES = [
  ["bdp_mkdir", { path: 123 }, /必须是字符串/],
  ["bdp_mkdir", { path: "/x".repeat(3000) }, /过长/],
  ["bdp_mkdir", {}, /不能为空/],
  ["bdp_mkdir", { path: "/a\u0001b" }, /控制字符/],
  ["bdp_remove", { path: "/x" }, /显式确认/],
  ["bdp_remove", { path: "/x", confirm: "true" }, /显式确认/],
  ["bdp_remove", { path: 123, confirm: true }, /必须是字符串/],
  ["bdp_organize", { path: "/" }, /归类维度/],
  ["bdp_organize", { path: "/", byType: true, layout: "bogus" }, /layout 取值非法/],
  ["bdp_gsearch", {}, /gid 不能为空/],
  ["bdp_gsearch", { gid: "1" }, /keyword 不能为空/],
  ["bdp_read", { path: "/x", lines: "abc" }, /必须是整数/],
  ["bdp_read", { path: "/x", lines: 0 }, /超出范围/],
  ["bdp_move", { src: 1, dst: "/y" }, /必须是字符串/],
  ["bdp_ls", { path: 42 }, /必须是字符串/],
];

test("参数校验: 15 种非法参数一律报参数错误（-32001），不是服务端错误", async () => {
  for (const [name, args, re] of CASES) {
    let err = null;
    try {
      await mcp.callTool(name, args);
    } catch (e) {
      err = e;
    }
    assert.ok(err, name + " " + JSON.stringify(args) + " 应报错（不应成功）");
    assert.equal(
      err.toolArgumentError,
      true,
      name + " " + JSON.stringify(args) + " 应标记为参数错误，实际: " + err.message
    );
    assert.match(err.message, re, name + " " + JSON.stringify(args) + " 的错误消息不符");
  }
});

test("参数校验: bdp_mkdir {path:123} 不得触发引擎（否则会真的建出名为 123 的目录）", async () => {
  const panPath = require.resolve("../lib/pan");
  const realPan = require(panPath);
  let engineCalled = 0;
  require.cache[panPath] = {
    id: panPath,
    filename: panPath,
    loaded: true,
    exports: Object.assign({}, realPan, {
      mkdir: async () => {
        engineCalled++;
        return { path: "/123", created: true };
      },
    }),
  };
  try {
    let err = null;
    try {
      await mcp.callTool("bdp_mkdir", { path: 123 });
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.toolArgumentError, "应报参数错误");
    assert.equal(engineCalled, 0, "引擎不得被调用");
  } finally {
    delete require.cache[panPath];
  }
});

test("参数校验: MCP 响应里的 error.code 恒为 -32001（端到端）", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "vfy-args-token" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer vfy-args-token" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_mkdir", arguments: { path: 123 } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error.code, -32001, "参数错误必须是 -32001，实际 " + payload.error.code);
    assert.equal(payload.error.severity, "user-error");
    assert.equal(payload.error.retryable, false);
  } finally {
    await srv.close();
  }
});

test("参数校验: 合法参数不受影响（路径校验不误伤正常调用）", async () => {
  // 用 mock pan 避免真的打网盘
  const panPath = require.resolve("../lib/pan");
  const realPan = require(panPath);
  const seen = [];
  require.cache[panPath] = {
    id: panPath,
    filename: panPath,
    loaded: true,
    exports: Object.assign({}, realPan, {
      head: async (p, n) => {
        seen.push([p, n]);
        return ["line1"];
      },
      mkdir: async (p) => ({ path: p, created: true }),
    }),
  };
  try {
    const r = await mcp.callTool("bdp_read", { path: "/a b/c.txt", lines: 5 });
    assert.equal(r.path, "/a b/c.txt", "含空格的合法路径应原样通过");
    assert.deepEqual(seen[0], ["/a b/c.txt", 5]);
    await mcp.callTool("bdp_mkdir", { path: "/new dir" });
  } finally {
    delete require.cache[panPath];
  }
});
