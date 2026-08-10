const test = require("node:test");
const assert = require("node:assert/strict");

const { _internals } = require("../lib/browser-login");

test("evaluateFetch runs a credentialed request in the page", async () => {
  let request;
  const cdp = {
    async send(method, params) {
      request = { method, params };
      return {
        result: {
          value: { ok: true, status: 200, url: "https://pan.baidu.com/api/test", text: '{"errno":0}' },
        },
      };
    },
  };

  const response = await _internals.evaluateFetch(
    cdp,
    "https://pan.baidu.com/api/test",
    { method: "POST", body: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  assert.equal(request.method, "Runtime.evaluate");
  assert.equal(request.params.awaitPromise, true);
  assert.match(request.params.expression, /credentials":"include/);
  assert.match(request.params.expression, /method":"POST/);
  assert.deepEqual(response, {
    ok: true,
    status: 200,
    url: "https://pan.baidu.com/api/test",
    text: '{"errno":0}',
  });
});

test("evaluateFetch surfaces browser-side exceptions", async () => {
  const cdp = {
    async send() {
      return { exceptionDetails: { exception: { description: "TypeError: Failed to fetch" } } };
    },
  };

  await assert.rejects(
    _internals.evaluateFetch(cdp, "https://pan.baidu.com/api/test"),
    /Failed to fetch/
  );
});
