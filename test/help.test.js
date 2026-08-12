const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");

// bdp.js 是 CLI 脚本（加载即执行 main），测试用子进程方式调用
const BDP = process.execPath;
const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

function run(...args) {
  return spawnSync(BDP, [BDP_JS, ...args], { encoding: "utf-8", timeout: 30000 });
}

test("bdp help --json: 结构化输出包含全部命令注册项", () => {
  const r = run("help", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.tool, "bdp");
  assert.equal(typeof j.version, "string");
  assert.ok(Array.isArray(j.commands) && j.commands.length >= 20, "命令数应 ≥20: " + j.commands.length);
  assert.ok(Array.isArray(j.globalOptions));
  // 关键命令都在注册表里
  for (const name of ["ls", "search", "get", "put", "rm", "mv", "cp", "quota", "offline", "share",
    "groups", "gshares", "gls", "gtree", "gsearch", "gdownload", "cache", "error",
    "login", "whoami", "config", "profile", "help"]) {
    const c = j.commands.find((x) => x.name === name);
    assert.ok(c, `注册表缺少命令: ${name}`);
    assert.ok(c.usage && c.desc && c.group, `${name} 缺 usage/desc/group`);
  }
});

test("bdp help get --json: 单命令详情", () => {
  const r = run("help", "get", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "get");
  assert.match(j.usage, /bdp get <path>/);
  assert.ok(Array.isArray(j.options) && j.options.length >= 3, "get 选项应 ≥3");
  assert.ok(Array.isArray(j.examples) && j.examples.length >= 1);
});

test("bdp help get: 人类可读单命令帮助", () => {
  const r = run("help", "get");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bdp get — 下载文件/);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /bdp get <path> \[-o dir\]/);
  assert.match(r.stdout, /--resume/);
  assert.match(r.stdout, /EXAMPLES/);
});

test("bdp help: 总览包含全部分组与命令", () => {
  const r = run("help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PAN FILE OPERATIONS/);
  assert.match(r.stdout, /GROUP CHAT OPERATIONS/);
  assert.match(r.stdout, /CONFIGURATION/);
  for (const name of ["get", "gsearch", "gdownload", "profile", "quota", "share", "offline"]) {
    assert.ok(r.stdout.includes(name), `总览缺命令: ${name}`);
  }
  assert.match(r.stdout, /bdp help \[command\]/);
});

test("bdp 无参数: 打印帮助且退出码 0", () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /bdp <command>/);
});

test("bdp help <未知命令>: 报错退出码 1，--json 给出可用命令", () => {
  const r = run("help", "nosuchcmd", "--json");
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.match(j.error, /未知命令/);
  assert.ok(Array.isArray(j.available) && j.available.includes("get"));
});

test("bdp <未知命令>: 提示 help 且退出码 1", () => {
  const r = run("nosuchcmd");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知命令/);
  assert.match(r.stderr, /bdp help/);
  assert.match(r.stdout, /USAGE/); // 仍打印总览
});

test("bdp <命令> <未知选项>: 防呆报错且提示 help", () => {
  const r = run("quota", "--resuem"); // 拼错的 --resume
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不支持选项: --resuem/);
  assert.match(r.stderr, /bdp help quota/);
});

test("bdp <命令> <合法选项>: 正常通过校验", () => {
  const r = run("help", "get", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.name, "get");
});
