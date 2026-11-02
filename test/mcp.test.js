const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { toolDefs, PROTOCOL_VERSION, SERVER_NAME } = require("../lib/mcp");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

test("toolDefs: 暴露的工具都带 name/description/inputSchema", () => {
  const defs = toolDefs();
  assert.ok(defs.length >= 8, "工具数应 ≥8");
  for (const d of defs) {
    assert.equal(typeof d.name, "string");
    assert.equal(typeof d.description, "string");
    assert.equal(d.inputSchema.type, "object");
    assert.ok(d.inputSchema.properties, d.name + " 缺 properties");
  }
  const names = defs.map((d) => d.name);
  for (const n of ["bdp_ls", "bdp_search", "bdp_read", "bdp_peek", "bdp_quota"]) {
    assert.ok(names.includes(n), "缺少工具 " + n);
  }
});

test("MCP 服务: initialize / tools/list 协议握手", async () => {
  const child = spawn(process.execPath, [BDP_JS, "serve", "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) responses.set(m.id, m);
      } catch {}
    }
  });

  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (!responses.has(1) || !responses.has(2))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();

  assert.ok(responses.has(1), "未收到 initialize 响应");
  const init = responses.get(1);
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(init.result.serverInfo.name, SERVER_NAME);
  assert.ok(init.result.capabilities.tools, "应声明 tools capability");

  assert.ok(responses.has(2), "未收到 tools/list 响应");
  const list = responses.get(2);
  assert.ok(Array.isArray(list.result.tools));
  assert.equal(list.result.tools.length, toolDefs().length);
  assert.ok(list.result.tools.some((t) => t.name === "bdp_ls"));
});

test("MCP 服务: 未知方法返回 JSON-RPC 错误", async () => {
  const child = spawn(process.execPath, [BDP_JS, "serve", "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let msg = null;
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const idx = buf.indexOf("\n");
    if (idx !== -1 && !msg) {
      try { msg = JSON.parse(buf.slice(0, idx)); } catch {}
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "no/such/method", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  assert.ok(msg, "未收到错误响应");
  assert.equal(msg.id, 9);
  assert.equal(msg.error.code, -32601);
});
