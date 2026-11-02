// 必须在 require("../lib/http") 之前设置：超时上限在模块加载时读取
process.env.BDP_REQUEST_TIMEOUT_MS = "300";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeHttp = require("node:http");
const libHttp = require("../lib/http");

test("http: 挂起的请求会在超时后中止（不会永久挂起 + 烧满 CPU）", async () => {
  const server = nodeHttp.createServer(() => {
    // 永不响应 —— 模拟 TCP 半开 / 百度侧不回包
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const started = Date.now();
    await assert.rejects(() => libHttp.fetchText("http://127.0.0.1:" + port + "/hang", {}));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, "应在超时后返回，实际 " + elapsed + "ms");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});
