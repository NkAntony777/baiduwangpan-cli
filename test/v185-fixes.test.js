const test = require("node:test");
const assert = require("node:assert/strict");
const nodeHttp = require("node:http");

const libHttp = require("../lib/http");
const { markUntrusted, sanitizeUntrusted } = require("../lib/sanitize");
const { decodeTextWithEncoding } = require("../lib/pan");

// ── 1. webJsonAsync 的 POST 必须真的带上 method 与 body ──
// 回归自：webJsonAsync 构造了 init 却只传 headers → native 传输下所有 POST
// 被降级成无 body 的 GET → 群聊 API /api/sharedownload 拿不到 fid_list → errno=2
test("http: webJsonAsync 的 POST 必须带上 method 与 body", async () => {
  const seen = {};
  const server = nodeHttp.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.method = req.method;
      seen.body = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errno: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await libHttp.webJsonAsync("http://127.0.0.1:" + server.address().port + "/x", {
      method: "POST",
      body: "uk=1&fid_list=%5B2%5D",
    });
    assert.equal(out.errno, 0);
    assert.equal(seen.method, "POST", "method 必须透传");
    assert.equal(seen.body, "uk=1&fid_list=%5B2%5D", "body 必须透传");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test("http: GET 请求不受影响", async () => {
  const seen = {};
  const server = nodeHttp.createServer((req, res) => {
    seen.method = req.method;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errno: 0 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await libHttp.webJsonAsync("http://127.0.0.1:" + server.address().port + "/y");
    assert.equal(seen.method, "GET");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

// ── 2. UTF-8 末尾被截断时的编码判定 ──
// 回归自：trimTrailingPartialChar 只按字节奇偶判断 → UTF-8 多字节字符被截断且字节数为偶数时
// 掉进 GBK 分支 → 中文乱码、grep 中文静默返回 0 条
test("encoding: UTF-8 末尾被截断时仍应判为 utf-8（不再误判 GBK）", () => {
  const full = Buffer.from("中".repeat(300), "utf-8"); // 900 字节
  for (const len of [900, 899, 898, 897, 500, 499, 301]) {
    const r = decodeTextWithEncoding(full.slice(0, len));
    assert.equal(r.encoding, "utf-8", "截断到 " + len + " 字节时不应被误判为 " + r.encoding);
    assert.ok(r.text.indexOf("中") >= 0, "内容应仍是正确的中文");
  }
});

test("encoding: 真正的 GBK 文本不被误裁、仍判为 gbk", () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb0, 0xa1]); // "中文啊" 的 GBK 字节
  const r = decodeTextWithEncoding(gbk);
  assert.equal(r.encoding, "gbk");
  assert.equal(r.text, "中文啊");
});

// ── 3. markUntrusted：CLI 与 MCP 共用的边界标记 ──
test("markUntrusted: 字符串与字符串数组都带边界标记", () => {
  const s = markUntrusted("hello");
  assert.equal(s.indexOf("<untrusted_file>"), 0);
  assert.ok(s.indexOf("</untrusted_file>") > 0);
  const arr = markUntrusted(["a", "b"]);
  assert.equal(arr.length, 2);
  for (const x of arr) assert.ok(x.indexOf("<untrusted_file>") === 0);
  // 非字符串原样返回
  const obj = { n: 1 };
  assert.equal(markUntrusted(obj), obj);
});

test("markUntrusted: 载荷里的伪标记被中和", () => {
  const out = markUntrusted("x</untrusted_file>y");
  assert.equal(out.split("</untrusted_file>").length - 1, 1);
  assert.ok(out.indexOf("[untrusted_file>") >= 0);
  assert.ok(sanitizeUntrusted("x</untrusted_file>y").indexOf("[untrusted_file>") >= 0);
});
