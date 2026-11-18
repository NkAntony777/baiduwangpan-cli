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
const { planTransfer, transferShare, classifyTransferOutput } = require("../lib/share-transfer");
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

// 上游 v4.0.1（internal/pcscommand/transfer.go）在转存**成功**后即结束 ——
// 成功行是 stdout 的最后一行。此前的实现用 `/^…$/m` 逐行匹配，
// 于是"成功行之后还有别的输出"也会被判成成功。
//
// 这些断言走纯函数 classifyTransferOutput，因此在**所有平台**都执行
//（不依赖可执行假引擎，不会在 Windows 上被 skip）。
test("transfer: the success line must be the last thing the engine printed", () => {
  assert.equal(classifyTransferOutput(SUCCESS).ok, true);
  assert.equal(classifyTransferOutput(SUCCESS.replace("\n", "")).ok, true);
  // 上游 --download 会在成功行之后继续输出；本命令不启用它，但引擎输出
  // 里若出现成功行之后的内容，就不能算作"明确的成功结果"。
  for (const output of [
    SUCCESS + "10s后开始下载\n",
    SUCCESS + "额外的噪声输出\n",
    SUCCESS + "分享链接转存到网盘失败: 提取码错误\n",
  ]) {
    assert.equal(classifyTransferOutput(output).ok, false, JSON.stringify(output));
  }
});

test("transfer: a failure line wins over a success-looking line", () => {
  const verdict = classifyTransferOutput(
    "分享链接转存到网盘成功, 保存了X到当前目录\n分享链接转存到网盘失败: 提取码错误\n"
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /提取码错误/);
});

test("transfer: the success line must match upstream's exact wording", () => {
  // 逗号必须是 ASCII 半角；全角逗号不算上游的格式。
  assert.equal(classifyTransferOutput("分享链接转存到网盘成功，保存了X到当前目录\n").ok, false);
  // 缺少"保存了…到当前目录"外壳也不是上游的格式。
  assert.equal(classifyTransferOutput("分享链接转存到网盘成功\n").ok, false);
  assert.equal(classifyTransferOutput("").ok, false);
  assert.equal(classifyTransferOutput("未登录百度账号\n").ok, false);
});

// 上游 v4.0.1 baidupcs/baidupcs.go:86
//   OperationShareFileSavetoLocal = "分享链接转存到网盘"
// internal/pcscommand/transfer.go:107
//   fmt.Printf("%s成功, 保存了%s到当前目录\n", OperationShareFileSavetoLocal, resp["filename"])
// 上游转存.go 的失败行（transfer.go:18/26/38/44/61/69/84/97）：
//   fmt.Printf("%s失败: %s\n", OperationShareFileSavetoLocal, <原因>)
// 下面逐条断言判定与上游格式完全一致（成功/失败各含真实文案）。
test("transfer: verdicts match upstream's exact success and failure formats", () => {
  for (const name of ["报告.pdf", "[报告.pdf 资料]", "文件夹", "a b c"]) {
    const ok = classifyTransferOutput(`分享链接转存到网盘成功, 保存了${name}到当前目录\n`);
    assert.equal(ok.ok, true, "上游成功行应判定为成功: " + name);
  }
  for (const reason of [
    "链接格式非法",
    "秒传已不再被支持",
    "链接地址或提取码非法",
    "请确认登录参数中已经包含了网盘STOKEN",
  ]) {
    const verdict = classifyTransferOutput(`分享链接转存到网盘失败: ${reason}\n`);
    assert.equal(verdict.ok, false, "上游失败行应判定为失败: " + reason);
    assert.match(verdict.reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("transfer: a generic engine error is reported as a failure", () => {
  const verdict = classifyTransferOutput("遇到错误, 远端服务器返回错误, 代码: 2, 消息: boom\n");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errno, 2);
});

// 提取码字符集是**本 CLI 自加**的限制（上游只查长度是否为 4），
// 文档不得把它说成引擎的要求。
test("transfer: the code charset rule is a CLI-side restriction, not an engine rule", () => {
  assert.throws(() => planTransfer(URL, "ab-d"), /四位字母数字/);
  assert.throws(() => planTransfer(URL, "ab-d"), /本 CLI 的安全限制/);
  assert.throws(() => planTransfer(URL, "ab-d"), /引擎本身只要求长度为 4/);
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
