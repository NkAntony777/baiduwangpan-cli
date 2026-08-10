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

test("findPCS discovers binary inside versioned subdirectory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-pcs-dir-"));
  try {
    const sub = path.join(dir, "BaiduPCS-Go-v4.0.1-windows-x64");
    fs.mkdirSync(sub);
    const exe = path.join(sub, "BaiduPCS-Go.exe");
    fs.writeFileSync(exe, "dummy");
    assert.equal(config.findPCSInDir(dir), exe);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePcsPath keeps a valid stored absolute path", () => {
  const auto = config.findPCS();
  assert.ok(auto, "auto-discovery should find a binary in this repo");
  assert.equal(config.resolvePcsPath({ pcsPath: auto }), auto);
});

test("resolvePcsPath falls back to auto-discovery when stored absolute path is dead (1.1.0 upgrade loss)", () => {
  const auto = config.findPCS();
  const dead = path.join(os.tmpdir(), "no-such-BaiduPCS-Go.exe");
  assert.equal(config.resolvePcsPath({ pcsPath: dead }), auto);
  // 裸命令名（PATH 查找）保持原样
  assert.equal(config.resolvePcsPath({ pcsPath: "BaiduPCS-Go" }), "BaiduPCS-Go");
  assert.equal(config.resolvePcsPath({}), auto);
});
