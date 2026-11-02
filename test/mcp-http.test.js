const test = require("node:test");
const assert = require("node:assert/strict");
const mcp = require("../lib/mcp");

test("MCP: 写操作工具齐备（Agent 能自主整理）", () => {
  const names = mcp.toolDefs().map((t) => t.name);
  for (const n of ["bdp_move", "bdp_copy", "bdp_remove", "bdp_rename", "bdp_organize"]) {
    assert.ok(names.includes(n), "缺少工具: " + n);
  }
});

test("MCP: bdp_remove 的 schema 要求显式 confirm", () => {
  const t = mcp.toolDefs().find((x) => x.name === "bdp_remove");
  assert.ok(t.inputSchema.required.includes("confirm"));
  assert.ok(t.inputSchema.properties.confirm, "应声明 confirm 参数");
});

test("MCP: bdp_rename 的 schema 有 files 与 dryRun", () => {
  const t = mcp.toolDefs().find((x) => x.name === "bdp_rename");
  assert.ok(t.inputSchema.properties.files);
  assert.ok(t.inputSchema.properties.dryRun);
});

test("MCP: startHttpServer 导出且可启动", async () => {
  assert.equal(typeof mcp.startHttpServer, "function");
  const srv = await mcp.startHttpServer({ port: 0, token: "t-unit-test" });
  try {
    assert.ok(srv.port > 0);
    assert.equal(srv.host, "127.0.0.1", "默认必须只绑定本机");
    assert.equal(srv.token, "t-unit-test");
  } finally {
    await srv.close();
  }
});

test("MCP: HTTP 无令牌被拒（401），健康检查免令牌", async () => {
  const srv = await mcp.startHttpServer({ port: 0, token: "t-secret" });
  try {
    const health = await fetch("http://127.0.0.1:" + srv.port + "/health");
    assert.equal(health.status, 200);
    const hj = await health.json();
    assert.equal(hj.ok, true);
    assert.equal(hj.transport, "http");

    const noAuth = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(badAuth.status, 401);

    const ok = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.result.tools.length >= 18);
  } finally {
    await srv.close();
  }
});
