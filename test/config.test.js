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

// ---------- profile（多账号）----------
// 每个用例开头显式重置全局配置与激活状态，保证用例间隔离
function resetGlobal(values = {}) {
  config.unsetProfile();
  config.save({ ...values });
}

test("useProfile activates a profile and setAuth writes into it", () => {
  resetGlobal({ bduss: "global-bduss", stoken: "global-stoken", maxBytes: 2048 });

  assert.equal(config.useProfile("svip"), "svip");
  assert.equal(config.getProfile(), "svip");
  config.setAuth({ bduss: "svip-bduss", stoken: "svip-stoken", webTransport: "browser" });

  const cfg = config.load();
  assert.equal(cfg.activeProfile, "svip");
  assert.equal(cfg.bduss, "global-bduss", "global bduss untouched");
  assert.equal(cfg.stoken, "global-stoken", "global stoken untouched");
  assert.equal(cfg.maxBytes, 2048, "global maxBytes untouched");
  assert.deepEqual(cfg.profiles.svip, {
    bduss: "svip-bduss",
    stoken: "svip-stoken",
    webTransport: "browser",
  });

  const merged = config.get();
  assert.equal(merged.bduss, "svip-bduss");
  assert.equal(merged.stoken, "svip-stoken");
  assert.equal(merged.webTransport, "browser");
  assert.equal(merged.maxBytes, 2048, "pcsPath/ua/maxBytes stay global");
  assert.equal(config.isLoggedIn(), true);
  config.unsetProfile();
});

test("get() falls back to global auth fields the profile does not override", () => {
  resetGlobal({ bduss: "global-bduss", stoken: "global-stoken", cookie: "BDUSS=global-cookie" });
  config.useProfile("svip");
  config.setAuth({ bduss: "svip-bduss", stoken: "svip-stoken" });

  const merged = config.get();
  assert.equal(merged.bduss, "svip-bduss");
  assert.equal(merged.cookie, "BDUSS=global-cookie", "profile without cookie falls back to global");
  assert.equal(merged.webTransport, "curl", "defaults still apply under profile");
  config.unsetProfile();
});

test("profile cannot override global pcsPath/ua/maxBytes (hand-edited profile ignored)", () => {
  resetGlobal({ bduss: "g", stoken: "g", maxBytes: 4096 });
  config.useProfile("svip");
  const cfg = config.load();
  cfg.profiles.svip.maxBytes = 9999;
  cfg.profiles.svip.pcsPath = "/fake/path";
  config.save(cfg);

  const merged = config.get();
  assert.equal(merged.maxBytes, 4096);
  assert.notEqual(merged.pcsPath, "/fake/path");
  config.unsetProfile();
});

test("setAuth with active profile preserves other profiles and global fields", () => {
  resetGlobal({ bduss: "g", stoken: "g" });
  config.useProfile("svip");
  config.setAuth({ bduss: "svip-bduss", stoken: "svip-stoken" });
  config.useProfile("work");
  config.setAuth({ bduss: "work-bduss" });
  config.useProfile("svip");
  config.setAuth({ bduss: "svip-bduss2", stoken: "svip-stoken" });

  const cfg = config.load();
  assert.deepEqual(cfg.profiles.work, { bduss: "work-bduss" });
  assert.deepEqual(cfg.profiles.svip, { bduss: "svip-bduss2", stoken: "svip-stoken" });
  assert.equal(cfg.bduss, "g");
  assert.equal(cfg.activeProfile, "svip");
  config.unsetProfile();
});

test("listProfiles returns [{name, bduss?}] in stored order", () => {
  resetGlobal();
  config.useProfile("svip");
  config.setAuth({ bduss: "svip-bduss", stoken: "svip-stoken" });
  config.useProfile("work");
  config.setAuth({ bduss: "work-bduss" });
  config.useProfile("empty");

  assert.deepEqual(config.listProfiles(), [
    { name: "svip", bduss: "svip-bduss" },
    { name: "work", bduss: "work-bduss" },
    { name: "empty" },
  ]);
  assert.equal(config.getProfile(), "empty");
  config.unsetProfile();
});

test("useProfile('') / unsetProfile switch back to global and setAuth writes global again", () => {
  resetGlobal({ bduss: "global-bduss", stoken: "global-stoken" });
  config.useProfile("svip");
  config.setAuth({ bduss: "svip-bduss", stoken: "svip-stoken" });
  assert.equal(config.get().bduss, "svip-bduss");

  assert.equal(config.useProfile(""), null);
  assert.equal(config.getProfile(), null);
  assert.equal(config.get().bduss, "global-bduss", "back to global credentials");

  config.setAuth({ bduss: "new-global-bduss", stoken: "new-global-stoken" });
  const cfg = config.load();
  assert.equal(cfg.bduss, "new-global-bduss", "setAuth writes global when no active profile");
  assert.equal(cfg.activeProfile, undefined);
  assert.deepEqual(cfg.profiles.svip, { bduss: "svip-bduss", stoken: "svip-stoken" }, "profiles data kept");
  assert.equal(config.get().bduss, "new-global-bduss");
});

test("useProfile creates an empty profile for a new name", () => {
  resetGlobal();
  config.useProfile("brand-new");
  const cfg = config.load();
  assert.deepEqual(cfg.profiles["brand-new"], {});
  assert.equal(cfg.activeProfile, "brand-new");
  config.unsetProfile();
});

test("no profile configured: get/setAuth behave exactly as before", () => {
  resetGlobal({ bduss: "g", stoken: "s", maxBytes: 1024 });
  assert.equal(config.getProfile(), null);
  assert.deepEqual(config.listProfiles(), []);
  config.setAuth({ bduss: "new-g", stoken: "new-s" });
  assert.deepEqual(config.load(), { bduss: "new-g", stoken: "new-s", maxBytes: 1024 });
  assert.equal(config.get().bduss, "new-g");
});
