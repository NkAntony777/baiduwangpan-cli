const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findBrowser, _internals } = require("../lib/browser-login");

// Use the real PATH lookup with isolated executable names; no installed browser
// or user-created microsoft-edge symlink should be needed for discovery.
test("findBrowser detects Linux Edge channel executable names", { skip: process.platform !== "linux" }, () => {
  for (const name of ["microsoft-edge", "microsoft-edge-stable", "microsoft-edge-beta", "microsoft-edge-dev"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-browser-path-"));
    const previousPath = process.env.PATH;
    try {
      const executable = path.join(dir, name);
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = dir;
      assert.equal(findBrowser(), executable);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

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
