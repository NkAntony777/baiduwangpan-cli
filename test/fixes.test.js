const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

// 隔离配置目录：避免触碰真实 ~/.bdp
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-fixes-cfg-"));
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({
    bduss: "SECRETBDUSSVALUE0123456789",
    stoken: "SECRETSTOKENVALUE0123456789",
    ua: "test-ua",
    pcsPath: "BaiduPCS-Go",
  }),
  "utf-8"
);

function run(...args) {
  return spawnSync(process.execPath, [BDP_JS, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, BDP_CONFIG_DIR: TMP_CFG },
  });
}

// ── P0-1 凭证脱敏 ─────────────────────────────────────────

test("config --json: 凭证被脱敏且标注 redacted", () => {
  const r = run("config", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.redacted, true);
  assert.ok(!j.bduss.includes("SECRETBDUSSVALUE0123456789"), "BDUSS 不得明文出现");
  assert.ok(!j.stoken.includes("SECRETSTOKENVALUE0123456789"), "STOKEN 不得明文出现");
  assert.match(j.bduss, /\.\.\./, "应保留掩码形式");
  assert.ok(!r.stdout.includes("SECRETBDUSSVALUE0123456789"), "stdout 整体不得含明文密钥");
});

test("config --json --show-secrets: 显式要求时输出原值并标注未脱敏", () => {
  const r = run("config", "--json", "--show-secrets");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.redacted, false);
  assert.equal(j.bduss, "SECRETBDUSSVALUE0123456789");
});

test("config（人类可读）: 凭证始终脱敏", () => {
  const r = run("config");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("SECRETBDUSSVALUE0123456789"));
});

// ── P1-4 负数参数 ─────────────────────────────────────────

test("error -3: 负数参数可用（文档范例不再失效）", () => {
  const r = run("error", "-3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /群分享 API 拒绝请求/);
});

test("error -- -3: 分隔符形式同样可用", () => {
  const r = run("error", "--", "-3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /群分享 API 拒绝请求/);
});

test("error 2131: 正数错误码仍正常", () => {
  const r = run("error", "2131");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /msg_id 不属于该群/);
});

// ── P2-5 rm 批量与确认 ────────────────────────────────────

test("rm: 非交互环境缺少 --yes 时拒绝执行（退出码 1）", () => {
  const r = run("rm", "/tmp/should-not-be-deleted");
  assert.equal(r.status, 1, "应因未确认而失败");
  assert.match(r.stderr, /--yes/);
});

test("rm --dry-run: 只预览不删除，退出码 0", () => {
  const r = run("rm", "/tmp/some-path", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.match(r.stdout, /some-path/);
});

test("rm --dry-run --json: 结构化输出", () => {
  const r = run("rm", "/tmp/a", "/tmp/b", "--dry-run", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, true);
  assert.deepEqual(j.paths, ["/tmp/a", "/tmp/b"]);
});

// ── 注册表同步 ────────────────────────────────────────────

test("help --json: 新增选项与 serve 命令已登记", () => {
  const r = run("help", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);

  const search = j.commands.find((c) => c.name === "search");
  for (const f of ["limit", "page", "maxResults", "fields"]) {
    assert.ok(search.flags.includes(f), "search 应登记 --" + f);
  }
  const rm = j.commands.find((c) => c.name === "rm");
  assert.ok(rm.flags.includes("yes"), "rm 应登记 --yes");
  const config = j.commands.find((c) => c.name === "config");
  assert.ok(config.flags.includes("showSecrets"), "config 应登记 --show-secrets");
  const du = j.commands.find((c) => c.name === "du");
  assert.ok(du.flags.includes("progress"), "du 应登记 --progress");
  const serve = j.commands.find((c) => c.name === "serve");
  assert.ok(serve, "应登记 serve 命令");
  assert.ok(serve.flags.includes("mcp"));
});

test("serve --json: 报告 MCP 模式信息后退出", () => {
  const r = run("serve", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.mode, "mcp");
  assert.equal(j.transport, "stdio");
});

test("serve（缺少 --mcp）: 给出用法并退出码 1", () => {
  const r = run("serve");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bdp serve --mcp/);
});
