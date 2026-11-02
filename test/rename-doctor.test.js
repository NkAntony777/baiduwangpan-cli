const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

function run(args, env) {
  return spawnSync(process.execPath, [BDP_JS].concat(args), {
    encoding: "utf-8",
    timeout: 20000,
    env: Object.assign({}, process.env, env),
  });
}

test("bdp rename 默认 dry-run，目标含 / 或 .. 会被拒绝", () => {
  const ok = run(["rename", "/文档/a.txt", "b.txt", "--json"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.dryRun, true);
  assert.equal(j.results[0].to, "/文档/b.txt");
  assert.equal(j.meta.command, "rename");

  const slash = run(["rename", "/文档/a.txt", "sub/c.txt", "--json"]);
  assert.equal(slash.status, 1, slash.stdout);
  const bad = JSON.parse(slash.stdout);
  assert.equal(bad.results[0].ok, false);
  assert.match(bad.results[0].error, /不能含/);

  const dot = run(["rename", "/文档/a.txt", "..", "--json"]);
  assert.equal(dot.status, 1);
  assert.equal(JSON.parse(dot.stdout).failed, 1);
});

test("bdp doctor --json 不泄漏本地路径，引擎文件无效时失败", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-doctor-"));
  const home = path.join(dir, "home");
  const pcs = path.join(dir, "BaiduPCS-Go.exe");
  fs.mkdirSync(home);
  fs.writeFileSync(pcs, "");
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ bduss: "x", stoken: "y", ua: "ua", pcsPath: pcs, webTransport: "native" })
  );
  try {
    const r = run(["doctor", "--json"], { BDP_CONFIG_DIR: dir, BDP_HOME: home, BAIDUPCS_CMD: "" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.login.ok, true);
    assert.equal(j.engine.ok, false);
    assert.equal(j.ok, false);
    const blob = r.stdout + r.stderr;
    assert.equal(blob.includes(pcs), false);
    assert.equal(blob.includes(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
