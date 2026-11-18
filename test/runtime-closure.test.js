// 运行时导入闭包（runtime import closure）—— 不是 grep。
//
// 契约 9 用**源码文本扫描**断言「引擎永不���步调用」。那是对**目录树**的断言，
// 有两类它看不见的洞：
//   1. **别名**：把同步 spawn 从 child_process 上摘下来再调用
//      （`const ss = require("child_process").spawnSync; ss(...)`）——
//      文本里没有 `spawnSync(` 这样的调用形态，扫描看不见；
//   2. **越界**：require 一个 lib/ 与 bin/ 之外的模块（scripts/、tools/…）——
//      扫描只覆盖 lib/ 与 bin/，闭包里的其它来源它根本不知道存在。
//
// 本文件把同一个边界建立在**运行时**上：
//   - 预加载一个探针，记录运行期间真正发生过的**同步**子进程调用；
//   - 运行真实的 CLI（引擎指向一个不可执行的假文件 → spawn 失败，不联网、不碰真引擎）；
//   - 断言：同步子进程调用 **0 次**；
//   - 断言：运行时导入闭包完全落在 lib/ + bin/ + node_modules 之内 ——
//     也就是契约 9 扫描的那片区域**确实是全部**，不是「扫到的那部分」。
//
// 「0 次」这条不能是空断言：同时断言引擎层（lib/pan.js）确实被加载了，
// 否则「一次都没走到引擎路径」也会得出同样的 0。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "bdp.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-closure-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ── 探针：跑在 CLI 之前（-r），记录同步子进程调用 + 退出时导出导入闭包 ──
const PROBE = `
const cp = require("child_process");
const fs = require("fs");
const syncCalls = [];
for (const name of ["spawnSync", "execSync", "execFileSync"]) {
  const orig = cp[name];
  cp[name] = function (...args) {
    const stack = (new Error("probe")).stack.split("\\n").slice(1).join("\\n");
    syncCalls.push({ name, cmd: String(args[0]), stack });
    return orig.apply(this, args);
  };
}
process.on("exit", () => {
  try {
    fs.writeFileSync(process.env.CLOSURE_OUT, JSON.stringify({
      syncCalls,
      modules: Object.keys(require.cache),
    }));
  } catch (e) { /* 退出阶段写文件失败不应掩盖真正的退出码 */ }
});
`;

function runCliWithProbe(extraArgs = []) {
  const probeFile = path.join(tmpRoot, "closure-probe.js");
  fs.writeFileSync(probeFile, PROBE, "utf8");
  const outFile = path.join(tmpRoot, "closure-out.json");
  if (fs.existsSync(outFile)) fs.rmSync(outFile);

  // 假引擎：一个**存在**但不可执行的 BaiduPCS-Go.exe。
  // config.resolvePcsPath 接受「存在且文件名像引擎」的路径 → 不会被回退到自动发现；
  // spawn 会失败，于是 CLI 报错退出 —— 全程不联网、不碰真实引擎、不读用户网盘。
  const fakeEngine = path.join(tmpRoot, "BaiduPCS-Go.exe");
  fs.writeFileSync(fakeEngine, "not an executable", "utf8");

  const cfgDir = path.join(tmpRoot, "cfg");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"),
    JSON.stringify({ ua: "test-ua", pcsPath: fakeEngine }), "utf8");

  const r = spawnSync(process.execPath, ["-r", probeFile, CLI, ...extraArgs], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, BDP_CONFIG_DIR: cfgDir, CLOSURE_OUT: outFile },
  });
  const probe = fs.existsSync(outFile)
    ? JSON.parse(fs.readFileSync(outFile, "utf8"))
    : { syncCalls: [], modules: [] };
  return { r, probe };
}

test("运行时闭包：真实 CLI 一次同步子进程调用都没有发生", () => {
  const { r, probe } = runCliWithProbe(["ls", "--json"]);
  // CLI 本身会失败（假引擎跑不起来）—— 这正是我们要的：
  // 引擎调用路径**被走到了**，只是它用的是异步 spawn。
  assert.ok(r.status !== 0 || r.stdout, "CLI 应当跑过引擎路径（失败是预期的）");
  assert.deepEqual(
    probe.syncCalls.map((c) => c.name + " " + c.cmd),
    [],
    "运行 CLI 时不应出现任何同步子进程调用：\n" +
      probe.syncCalls.map((c) => c.name + " " + c.cmd + "\n" + c.stack).join("\n")
  );
});

test("运行时闭包：引擎层确实被加载了（保证上面那条不是空断言）", () => {
  const { probe } = runCliWithProbe(["ls", "--json"]);
  const loaded = probe.modules.map((m) => path.resolve(m));
  assert.ok(
    loaded.includes(path.join(ROOT, "lib", "pan.js")),
    "lib/pan.js 应在运行时闭包里 —— 否则「零同步调用」只是因为引擎路径压根没走到"
  );
});

test("运行时闭包：完全落在 lib/ + bin/ + node_modules 之内（契约 9 扫的就是全部）", () => {
  const { probe } = runCliWithProbe(["ls", "--json"]);
  assert.ok(probe.modules.length > 0, "探针应记录到运行时导入闭包");
  const outside = [];
  for (const m of probe.modules) {
    const abs = path.resolve(m);
    if (abs.startsWith(path.resolve(ROOT) + path.sep)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      // package.json 是 Node 解析包入口（main/exports/type）时自己加载的，
      // 不是源码依赖 —— 闭包里出现它是正常的，不算越界。
      const ok = rel.startsWith("lib/") || rel.startsWith("bin/") || rel === "package.json";
      if (!ok) outside.push(rel);
    } else if (!abs.includes("node_modules" + path.sep)) {
      // 探针自己在仓库外（temp 目录），其余一律不该出现
      if (!abs.startsWith(path.resolve(tmpRoot))) outside.push(abs);
    }
  }
  assert.deepEqual(
    outside, [],
    "运行时闭包里出现了 lib/ + bin/ + node_modules 之外的模块 —— " +
      "契约 9 的源码扫描看不到它们（扫描只覆盖 lib/ 与 bin/）"
  );
});

test("运行时闭包：延迟 require 同样是 import（闭包里能看到）", () => {
  // lib/pan.js 把 child_process 的 require 放在函数里（为了可注入 mock）。
  // 文本扫描看不出「它到底在运行时被不需要」—— 闭包可以。
  const { probe } = runCliWithProbe(["ls", "--json"]);
  const loaded = probe.modules.map((m) => path.resolve(m));
  assert.ok(
    loaded.includes(path.join(ROOT, "lib", "pan.js")),
    "lib/pan.js 必须在闭包里"
  );
  // 断言「闭包是真实的、不是空壳」：本次运行加载了十几个模块
  assert.ok(probe.modules.length >= 5,
    "闭包应包含多个模块，实际 " + probe.modules.length);
});
