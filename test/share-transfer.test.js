const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-share-transfer-"));
const previousConfigDir = process.env.BDP_CONFIG_DIR;
process.env.BDP_CONFIG_DIR = dir;
const marker = path.join(dir, "calls.json");
const engine = path.join(dir, "BaiduPCS-Go");
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pcsPath: engine }), "utf8");
const { planTransfer, transferShare } = require("../lib/share-transfer");
const { SLOW_ENGINE_COMMANDS } = require("../lib/engine-timeout");
const CLI = path.join(__dirname, "..", "bin", "bdp.js");
const URL = "https://pan.baidu.com/s/1Example";
const SUCCESS = "分享链接转存到网盘成功, 保存了[报告.pdf 资料]到当前目录\n";
const needsExecutable = { skip: process.platform === "win32" };

function fakeEngine(output = SUCCESS, code = 0) {
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(engine, `#!${process.execPath}\n` +
    `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n` +
    `process.stdout.write(${JSON.stringify(output)});\nprocess.exit(${code});\n`, { mode: 0o755 });
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, BDP_CONFIG_DIR: dir },
  });
}

test.after(() => {
  if (previousConfigDir === undefined) delete process.env.BDP_CONFIG_DIR;
  else process.env.BDP_CONFIG_DIR = previousConfigDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("transfer: normalize personal share links and explicit password precedence", () => {
  assert.deepEqual(planTransfer(URL + "?pwd=abcd"), { url: URL, password: "abcd" });
  assert.deepEqual(planTransfer("http://pan.baidu.com/share/init?surl=Example&pwd=abcd"), { url: URL, password: "abcd" });
  assert.equal(planTransfer(URL + "?pwd=abcd", "EF12").password, "EF12");
});

test("transfer: reject foreign hosts, enterprise URLs, credentials and file selection", () => {
  for (const input of [null, 123, "", "pan.baidu.com/s/1Example", "https://pan.baidu.com.evil/s/1Example",
    "https://user:pass@pan.baidu.com/s/1Example", "https://pan.baidu.com:8443/s/1Example",
    "https://pan.baidu.com/enterprise/share?pwd=abcd", URL + "#list/path=/subdir",
    URL + "?path=/subdir", URL + "\n", "https://pan.baidu.com/s/1../bad", "file:///s/1Example"]) {
    assert.throws(() => planTransfer(input, "abcd"));
  }
});

test("transfer: require an unambiguous four-character extraction code", () => {
  for (const code of [undefined, null, 1234, "", "abc", "abcde", "ab c", "-abc", "ab\nc"]) {
    assert.throws(() => planTransfer(URL, code), /提取码/);
  }
  assert.throws(() => planTransfer(URL + "?pwd=abcd&pwd=EF12"), /多个 pwd/);
});

test("transfer: dry-run returns a plan without invoking an engine or exposing its code", async () => {
  fs.rmSync(marker, { force: true });
  const result = await transferShare(URL + "?pwd=abcd", { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.destination, "engine-workdir");
  assert.equal(result.requiresLogin, true);
  assert.equal(fs.existsSync(marker), false);
  assert.doesNotMatch(JSON.stringify(result), /abcd/);
});

test("transfer: library writes require boolean confirm true", async () => {
  fs.rmSync(marker, { force: true });
  for (const confirm of [undefined, false, "true", 1]) {
    await assert.rejects(transferShare(URL, { password: "abcd", confirm }), /显式确认/);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("transfer: invoke the async engine with separate argv and require explicit success", needsExecutable, async () => {
  fakeEngine();
  const result = await transferShare(URL + "?pwd=abcd", { confirm: true });
  assert.equal(result.success, true);
  assert.equal(result.destination, "engine-workdir");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["transfer", URL, "abcd"]);
  assert.equal(result.raw, SUCCESS);
});

test("transfer: recognize textual failure even when the engine exits zero", needsExecutable, async () => {
  fakeEngine("分享链接转存到网盘失败: 提取码错误\n");
  await assert.rejects(transferShare(URL, { password: "abcd", confirm: true }), /转存失败.*提取码错误/);
});

test("transfer: a nonzero exit remains a failure even alongside success text", needsExecutable, async () => {
  fakeEngine(SUCCESS, 2);
  await assert.rejects(transferShare(URL, { password: "abcd", confirm: true }), /退出码 2/);
});

test("transfer: empty or unrecognized output cannot be reported as success", needsExecutable, async () => {
  for (const output of ["", "未登录百度账号\n", "Usage: BaiduPCS-Go transfer\n"]) {
    fakeEngine(output);
    await assert.rejects(transferShare(URL, { password: "abcd", confirm: true }), /未返回明确的转存成功/);
  }
});

test("transfer: use the existing write-operation timeout policy", () => {
  assert.equal(SLOW_ENGINE_COMMANDS.has("transfer"), true);
});

test("CLI transfer: dry-run has a JSON envelope and performs no engine call", () => {
  fs.rmSync(marker, { force: true });
  const run = cli(["transfer", URL + "?pwd=abcd", "--dry-run", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.meta.command, "transfer");
  assert.doesNotMatch(run.stdout, /abcd/);
  assert.equal(fs.existsSync(marker), false);
});

test("CLI transfer: noninteractive writes require --yes", () => {
  fs.rmSync(marker, { force: true });
  const run = cli(["transfer", URL, "--pwd", "abcd", "--json"]);
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).requiresConfirmation, true);
  assert.equal(fs.existsSync(marker), false);
});

test("CLI transfer: success has metadata and marks engine text as untrusted", needsExecutable, () => {
  fakeEngine();
  const run = cli(["transfer", URL, "--pwd", "abcd", "--yes", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.success, true);
  assert.equal(result.meta.command, "transfer");
  assert.match(result.raw, /<untrusted_engine_output>/);
});

test("CLI transfer: --pwd cannot consume another flag or start a transfer", () => {
  fs.rmSync(marker, { force: true });
  const run = cli(["transfer", URL, "--pwd", "--json", "--yes"]);
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.stdout).error, /--pwd/);
  assert.equal(fs.existsSync(marker), false);
});

test("CLI transfer: command is discoverable through structured help", () => {
  const run = cli(["help", "transfer", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const help = JSON.parse(run.stdout);
  assert.match(help.usage, /bdp transfer/);
  assert.match(help.note, /当前网盘目录|工作目录/);
  assert.deepEqual(help.flags, ["pwd", "dryRun", "yes"]);
});
