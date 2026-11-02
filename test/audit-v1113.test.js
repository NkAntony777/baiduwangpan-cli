// v1.11.3 四路审核发现的回归测试（逐条对着审核报告的实际用例）。
//
// 每个 test 名字里都写清「挡的是哪一类缺陷」，因为它们全都是**踩过的坑**：
//   · 根目录改名       —— rename /  --yes 会真的下发 mv / /x
//   · .. 穿越          —— /a/../../etc/passwd 归一后指向另一个文件（预览 ≠ 执行）
//   · 不可见格式符     —— 回显被 sanitize 剥掉、文件却带着它落盘 → Agent 按预览名寻址会错
//   · target 穿越      —— organize --apply 会拿 target 直接 mkdir + mv
//   · 失败原因丢失     —— 超时/输出超限/退出码非 0 的处理动作完全不同
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-audit1113-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// 引擎调用必须可观测：审核里每一个「不得触发写操作」的断言都靠这个计数
const panPath = require.resolve("../lib/pan");
const realPan = require(panPath);
let mvCalls = [];
require.cache[panPath] = {
  id: panPath,
  filename: panPath,
  loaded: true,
  exports: Object.assign({}, realPan, {
    mv: async (src, dst) => {
      mvCalls.push([src, dst]);
      return { op: "rename", src, dst };
    },
  }),
};

const mcp = require("../lib/mcp");
const rename = require("../lib/rename");
const http = require("../lib/http");

// doctor 相关用例要自带配置：每个用例写一份，避免互相污染
function withConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-audit1113-cfg-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj), "utf-8");
  process.env.BDP_CONFIG_DIR = dir;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/doctor")];
  return dir;
}

test.after(() => {
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

test("审核4-M1: from='/' 不允许（否则 --yes 会把 mv / /x 下发给引擎）", async () => {
  mvCalls = [];
  const r = await mcp.callTool("bdp_rename", { files: [{ from: "/", to: "root-new" }], dryRun: false });
  assert.equal(r.failed, 1, "根目录改名必须被逐条拒绝");
  assert.match(r.results[0].error, /根目录|不能重命名/, "错误消息应说明不能改根目录");
  assert.equal(mvCalls.length, 0, "不得下发任何 mv");

  // 归一化后才变成根的也要挡
  const r2 = await mcp.callTool("bdp_rename", { files: [{ from: "/a/..", to: "x" }], dryRun: false });
  assert.equal(r2.failed, 1, "/a/.. 归一后是根，必须拒绝");
  assert.equal(mvCalls.length, 0);
});

test("审核4-M2: from 含 .. 段一律拒绝（归一化会指向另一个文件）", async () => {
  mvCalls = [];
  for (const bad of ["/a/../../etc/passwd", "/../../", "/docs/../secret.txt", "a/../../b"]) {
    const r = await mcp.callTool("bdp_rename", { files: [{ from: bad, to: "x.txt" }], dryRun: false });
    assert.equal(r.failed, 1, "from=" + bad + " 应被拒绝");
    assert.match(r.results[0].error, /\.\./, "错误消息应说明 .. 的问题");
  }
  assert.equal(mvCalls.length, 0, "不得下发任何 mv");
});

test("审核4-M3: 目标名里的不可见格式符（U+202A-202E / U+2066-206F / U+FEFF）拒绝而非剥离", async () => {
  mvCalls = [];
  for (const ch of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\uFEFF"]) {
    const r = await mcp.callTool("bdp_rename", {
      files: [{ from: "/docs/a.txt", to: "a" + ch + "b.txt" }],
      dryRun: false,
    });
    assert.equal(r.failed, 1, "格式符 U+" + ch.charCodeAt(1).toString(16).toUpperCase() + " 应被拒绝");
  }
  assert.equal(mvCalls.length, 0, "不得下发任何 mv");
  // from 同样要挡：它会被回传给下一条命令用来寻址
  const rf = await mcp.callTool("bdp_rename", { files: [{ from: "/\u202Ea.txt", to: "b.txt" }] });
  assert.equal(rf.failed, 1, "from 里含格式符应被拒绝（否则回传后寻址的是另一个文件）");
});

test("审核1-L2/审核4-L1/L7: 纯空白与超长目标名拒绝（CLI 与 MCP 同口径）", async () => {
  mvCalls = [];
  // 纯空白在 MCP 边界就判「不能为空」（-32001）；超长在边界判 512；两者都不得下发 mv。
  // renameFiles 层另有 trim()/255 的上限 —— 覆盖 CLI 通道（argv 不经过 MCP 校验）。
  for (const bad of ["   ", "\t", "z".repeat(256), "z".repeat(600)]) {
    let rejected = false;
    try {
      const r = await mcp.callTool("bdp_rename", { files: [{ from: "/docs/a.txt", to: bad }], dryRun: false });
      rejected = r.failed === 1;
    } catch (e) {
      rejected = e.toolArgumentError === true;
    }
    assert.ok(rejected, JSON.stringify(bad.slice(0, 8)) + "…（长度 " + bad.length + "）应被拒绝");
  }
  assert.equal(mvCalls.length, 0, "不得下发任何 mv");
  // 库层（CLI 走的就是这一层）也必须拒绝纯空白与超长，不能只靠 MCP 边界
  for (const bad of ["   ", "z".repeat(256)]) {
    const rr = await rename.renameFiles([{ from: "/docs/a.txt", to: bad }], { dryRun: false });
    assert.equal(rr.failed, 1, "库层应拒绝 " + JSON.stringify(bad.slice(0, 4)));
  }
  assert.equal(mvCalls.length, 0);
  // 255 是边界内，应放行
  const okName = "z".repeat(255);
  const rok = await mcp.callTool("bdp_rename", { files: [{ from: "/docs/a.txt", to: okName }] });
  assert.equal(rok.succeeded, 1, "255 字符（上限内）应放行");
});

test("审核4-M4: organize 的 target 不接受 .. 段（--apply 会拿它 mkdir + mv）", async () => {
  for (const bad of ["../../x", "/归档/../..", "a/../../b"]) {
    let err = null;
    try {
      await mcp.callTool("bdp_organize", { byType: true, target: bad });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "target=" + bad + " 应被拒绝（不能正常出计划）");
    assert.equal(err.toolArgumentError, true, "应标记为参数错误（-32001）");
    assert.match(err.message, /\.\./, "错误消息应说明 .. 的问题");
  }
  // 合法的 target 不受影响，且会被归一成绝对路径
  const ok = await mcp.callTool("bdp_organize", { byType: true, target: "归档/2026" });
  const root = ok.rules && ok.rules.targetRoot;
  assert.equal(typeof root, "string", "rules.targetRoot 应存在");
  assert.equal(root, "/归档/2026", "相对写法应被归一成绝对路径，实际 " + root);
});

test("审核1-M1: doctor 对「PATH 上的引擎」不再报假阴性（existsSync 判不了裸名）", async () => {
  const dir = withConfig({ ua: "x", pcsPath: "BaiduPCS-Go" });
  try {
    const doctor = require("../lib/doctor");
    // 裸名一律交 spawn 判定：本机有没有真引擎都不该得出「引擎文件不存在」这种**判据性**结论
    const engine = await doctor.checkEngine("BaiduPCS-Go").catch((e) => ({ ok: false, detail: e.code || "ERR" }));
    assert.notEqual(engine.detail, "引擎文件不存在", "裸名不能用 existsSync 判存在（会给出假阴性）");
    if (engine.ok) assert.match(engine.detail, /PATH/, "走 PATH 成功时应说明来源");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("审核2-M3: doctor 暴露引擎来源；配置路径失效时的静默回退必须进 warnings", async () => {
  const dir = withConfig({
    ua: "x",
    pcsPath: path.join(os.tmpdir(), "vfy-nope-" + Date.now(), "BaiduPCS-Go.exe"),
  });
  try {
    const doctor = require("../lib/doctor");
    const r = await doctor.doctor();
    assert.equal(r.engine.source, "auto-fallback", "配置失效时应标记为自动回退，实际 " + r.engine.source);
    assert.ok(
      (r.warnings || []).some((w) => /回退|配置的引擎/.test(w)),
      "静默引擎替换必须对调用方可见，warnings=" + JSON.stringify(r.warnings)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("审核4-L6: spawnCollected 的非法 timeoutMs/maxBuffer 不再静默变成 1ms", async () => {
  // "abc" 以前会 Math.max(1,"abc") → NaN → setTimeout(NaN) 变 1ms：每次调用都立刻超时
  const r1 = await http.spawnCollected(process.execPath, ["-e", "setTimeout(()=>{},120)"], {
    timeoutMs: "abc",
  });
  assert.ok(!r1.error, "非法 timeoutMs 应回落默认值，不该立刻超时（实际 " + (r1.error && r1.error.code) + "）");
  assert.equal(r1.status, 0, "应正常跑完，实际 status=" + r1.status);

  // 0 / 负数 / NaN 都回落默认，而不是被 || 吞掉或变成 1ms
  for (const bad of [0, -5, NaN, null, undefined]) {
    const r = await http.spawnCollected(process.execPath, ["-e", "0"], { timeoutMs: bad });
    assert.equal(r.status, 0, "timeoutMs=" + String(bad) + " 应正常完成");
  }
});

test("审核2-L3: 群下载失败消息带原因（超时/输出超限不再只说「失败」）", async () => {
  const group = require("../lib/group");
  const cases = [
    [{ error: { code: "ETIMEDOUT" }, status: null }, /超时/],
    [{ error: { code: "ENOBUFS" }, status: null }, /上限/],
    [{ error: null, status: 7 }, /退出码 7/],
  ];
  for (const [result, re] of cases) {
    let msg = "";
    try {
      group.assertCollectedOk(result, "下载");
    } catch (e) {
      msg = e.message;
    }
    assert.match(msg, re, "失败原因应写进消息，实际: " + msg);
  }
});

test("审核2-L1: 群下载的落盘名挡掉 Windows 保留设备名与 ADS 流", () => {
  const group = require("../lib/group");
  const fb = "fallback.bin";
  for (const bad of ["CON", "NUL.txt", "COM1", "LPT9.log", "aux", "x.txt:hidden"]) {
    assert.equal(group.safeDownloadName(bad, fb), fb, JSON.stringify(bad) + " 应回落到 fallback");
  }
  // 正常名字（含中文/空格）不受影响
  assert.equal(group.safeDownloadName("报告 2024.pdf", fb), "报告 2024.pdf");
});
