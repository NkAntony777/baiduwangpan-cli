const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-config-test-"));
process.env.BDP_CONFIG_DIR = configDir;
const config = require("../lib/config");

test.after(() => {
  const resolved = path.resolve(configDir);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test("setAuth replaces all transport-specific authentication state", () => {
  config.save({
    bduss: "old",
    stoken: "old",
    cookie: "BDUSS=stale",
    webTransport: "browser",
    browserProfile: "old-profile",
    browserPort: 9999,
    maxBytes: 2048,
  });

  config.setAuth({ bduss: "new-bduss", stoken: "new-stoken", webTransport: "curl" });

  assert.deepEqual(config.load(), {
    bduss: "new-bduss",
    stoken: "new-stoken",
    webTransport: "curl",
    maxBytes: 2048,
  });
});
