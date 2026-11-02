const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// ── 隔离配置：写临时 BDP_CONFIG_DIR，pcsPath 指向 mock 认得的名字 ──
// （与 test/pan.test.js 同一手法：pcsPath 必须是 "BaiduPCS-Go"，
//   mock 才会拦截；写绝对路径会被 mock 放行给真实引擎）
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-async-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// 引擎超时档（v1.10.1 / T-02）：pan.js 在**模块加载时**读这个环境变量，
// 所以必须在下面对 lib/pan 的 require 之前设置。
// 取 2s —— 真实默认值是 120s，测试里等 120s 没有意义。
process.env.BDP_ENGINE_TIMEOUT_MS = "2000";

// ── Mock child_process（pan.js 惰性 require）──────────────────────
// 目的：验证**异步引擎执行**真的重叠，而不是排队串行。
// mock 的 spawn 延迟 DELAY_MS 后才 emit('close') ——
// 若实现退回同步，4 次并发会耗时 ≈ 4×DELAY；重叠时应接近 1×DELAY。
const cpPath = require.resolve("child_process");
const realCp = require("child_process");
const DELAY_MS = 120;

const ENGINE_TABLE = [
  "  0                     2025-11-26 20:49:09  med/",
  "  1      1.50KB         2025-11-26 20:49:10  med/报告.pdf",
  "",
].join("\n");

// 引擎错误输出（模拟百度侧返回错误）：失败判定只看文本，不看退出码
const ENGINE_ERROR = "遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件不存在\n";

let spawnCalls = 0;
let mockOutput = ENGINE_TABLE;
// mock 模式：normal | bigStdout | bigStderr | hang
let mockMode = "normal";
let killCalls = 0;

// 超过 20MB 上限的输出量：5 块 × 5MB = 25MB
const BIG_CHUNK = 5 * 1024 * 1024;
const BIG_CHUNKS = 5;

// 写操作的引擎输出（v1.11.0：写操作也走异步引擎了）
const CMD_OUTPUT = {
  mkdir: "创建目录成功: /probe\n",
  rm: "操作成功, 以下文件/目录已删除, 可在网盘文件回收站找回: /probe\n",
  u: "上传成功: /probe\n",
};

function fakeSpawn(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawn(cmd, args, opts);
  spawnCalls++;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // kill 只记录调用：真实进程的 'close' 是**异步**到来的，
  // 这里若同步 emit('close') 会抢先 resolve 掉超时用例。
  child.kill = () => {
    killCalls++;
    return true;
  };
  if (mockMode === "hang") {
    // 引擎挂死：永不 emit('close')
    return child;
  }
  setTimeout(() => {
    if (mockMode === "bigStdout" || mockMode === "bigStderr") {
      const target = mockMode === "bigStdout" ? child.stdout : child.stderr;
      // 同步写完所有块 —— PassThrough 在 flowing 模式下 'data' 是同步派发的，
      // 所以 close 之前 outLen 已经累加到位。
      for (let i = 0; i < BIG_CHUNKS; i++) target.write(Buffer.alloc(BIG_CHUNK, 0x41));
      target.end();
      child.emit("close", 0);
      return;
    }
    child.stdout.write(
      CMD_OUTPUT[args[0]] !== undefined ? CMD_OUTPUT[args[0]] : mockOutput
    );
    child.stdout.end();
    child.emit("close", 0); // 引擎出错时退出码仍是 0 —— 必须靠文本判定
  }, DELAY_MS);
  return child;
}
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: Object.assign({}, realCp, { spawn: fakeSpawn }),
};

const pan = require("../lib/pan");

test.after(() => {
  delete require.cache[cpPath];
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

// ── 异步契约 ──────────────────────────────────────────────────────
test("pan.lsEntries / searchEntries 返回 Promise（不再是同步阻塞）", async () => {
  assert.equal(typeof pan.lsEntries, "function");
  const p = pan.lsEntries("/");
  assert.ok(p && typeof p.then === "function", "lsEntries 必须返回 Promise");
  await p;
});

test("pan.ls / pan.search 返回 Promise", async () => {
  const a = pan.ls("/");
  const b = pan.search("x", "/");
  assert.ok(a && typeof a.then === "function");
  assert.ok(b && typeof b.then === "function");
  await Promise.all([a, b]);
});

// ── 并发必须真的重叠 ─────────────────────────────────────────────
test("4 个并发 lsEntries 的耗时应接近 1 次，而不是 4 次", async () => {
  spawnCalls = 0;
  const t0 = Date.now();
  const rs = await Promise.all([
    pan.lsEntries("/"),
    pan.lsEntries("/"),
    pan.lsEntries("/"),
    pan.lsEntries("/"),
  ]);
  const wall = Date.now() - t0;
  assert.equal(spawnCalls, 4, "应起了 4 个引擎进程");
  assert.equal(rs.length, 4);
  // 串行下界是 4×DELAY_MS；重叠时应明显小于 3×DELAY
  assert.ok(
    wall < DELAY_MS * 3,
    "并发未重叠：耗时 " + wall + "ms，期望 < " + DELAY_MS * 3 + "ms（串行会是 " + DELAY_MS * 4 + "ms）"
  );
});

test("并发调用期间事件循环仍能转动（不再被冻结）", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  await Promise.all([pan.lsEntries("/"), pan.lsEntries("/"), pan.lsEntries("/")]);
  clearInterval(timer);
  assert.ok(ticks > 0, "并发期间定时器应至少触发一次（同步引擎会一次都触发不了）");
});

// ── 输出契约不变 ──────────────────────────────────────────────────
test("异步版 lsEntries 的解析结果与同步版一致", async () => {
  mockOutput = ENGINE_TABLE;
  const info = await pan.lsEntries("/");
  assert.equal(info.path, "/");
  assert.equal(info.entries.length, 2);
  const e = info.entries[0];
  for (const k of ["index", "name", "path", "isDir", "sizeText", "size", "mtimeText", "mtime"]) {
    assert.ok(k in e, "entries 缺字段: " + k);
  }
  assert.equal(e.name, "med");
  assert.equal(e.isDir, true);
  assert.equal(e.path, "/med/");
  assert.equal(e.mtimeText, "2025-11-26 20:49:09");
  const f = info.entries[1];
  assert.equal(f.isDir, false);
  // name 保留引擎给出的相对路径（既有语义：ls 的 name 是目录内相对路径，不是纯文件名）
  assert.equal(f.name, "med/报告.pdf");
  assert.equal(f.path, "/med/报告.pdf");
  assert.equal(f.sizeText, "1.50KB");
  assert.equal(f.size, 1536);
});

test("异步版 searchEntries 解析结果正确", async () => {
  mockOutput = ENGINE_TABLE;
  const info = await pan.searchEntries("报告", "/", { mode: "substring" });
  assert.equal(info.keyword, "报告");
  assert.equal(info.mode, "substring");
  assert.equal(info.entries.length, 2);
  // search 的 name 取路径末段；末段为空（目录以 / 结尾）时回退为整串（既有语义）
  assert.equal(info.entries[0].name, "med/");
  assert.equal(info.entries[1].name, "报告.pdf");
});

// ── 失败语义不变：引擎出错仍按文本判定（退出码是 0）────────────────
test("异步版：引擎错误文本仍被识别为失败（errno 正确）", async () => {
  mockOutput = ENGINE_ERROR;
  await assert.rejects(
    () => pan.lsEntries("/"),
    (err) => {
      assert.equal(err.errno, 31066, "errno 应从引擎文本解析出来");
      assert.ok(/31066|文件不存在/.test(err.message));
      return true;
    }
  );
  mockOutput = ENGINE_TABLE;
});

// ── v1.11.0：写操作也不再冻结事件循环 ──────────────────────────────────
//
// 此前写操作（mkdir/rm/put/mv/cp/…）走同步 spawnSync —— 一次调用就把整个 Node 进程
// 冻住，MCP 服务器整体不可用。v1.11.0 把它们全迁到异步 spawn。
test("v1.11.0: 写操作走异步引擎 —— 并发期间定时器仍能触发（不再冻结事件循环）", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  try {
    await Promise.all([
      pan.mkdir("/a"),
      pan.mkdir("/b"),
      pan.mkdir("/c"),
      pan.mkdir("/d"),
    ]);
  } finally {
    clearInterval(timer);
  }
  assert.ok(
    ticks > 0,
    "并发写操作期间定时器应至少触发一次（同步引擎会一次都触发不了）"
  );
});

test("v1.11.1: 写操作超限也要报「20MB」（截断诊断不能丢）", async () => {
  mockMode = "bigStdout";
  try {
    // mkdir 走 runPCSResultAsync —— 截断必须在**唯一出口**抛错，
    // 否则会报成「引擎未确认目录创建成功: (无输出)」这种误导性结论。
    await assert.rejects(
      () => pan.mkdir("/probe"),
      (err) => {
        assert.ok(/20MB/.test(err.message), "应含「20MB」: " + err.message);
        return true;
      }
    );
    // rm 逐条汇总：截断也应落进该条的 error
    const removed = await pan.remove(["/probe"]);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].ok, false);
    assert.ok(/20MB/.test(removed[0].error), "应含「20MB」: " + removed[0].error);
  } finally {
    mockMode = "normal";
  }
});

test("v1.11.0: 写操作的结果与失败语义不变（mkdir 幂等 / rm 逐条汇总）", async () => {
  const created = await pan.mkdir("/probe");
  assert.equal(created.created, true);
  assert.equal(created.exists, false);
  const removed = await pan.remove(["/probe", "/probe2"]);
  assert.equal(removed.length, 2);
  assert.equal(removed[0].ok, true, "删除成功应被确认（引擎输出含「操作成功」）");
});

// ── T-01：输出超限必须转成**明确错误**，不能返回「空成功」────────────────
//
// 回归背景（v1.10.0）：超限时 stdout 被清空、truncated 标志无人读取，
// MCP 返回 {"path":"/","total":0,"entries":[]} 且 isError:false ——
// Agent 会据此得出「这个目录是空的」这个**确定性错误结论**，且无从察觉。
test("T-01: stdout 超过 20MB → 明确错误（不是空成功）", async () => {
  mockMode = "bigStdout";
  try {
    await assert.rejects(
      () => pan.lsEntries("/"),
      (err) => {
        assert.ok(/20MB/.test(err.message), "message 应含「20MB」: " + err.message);
        assert.equal(err.truncated, true, "错误对象应带 truncated 标记");
        assert.equal(err.errno, null, "errno 应为 null（MCP 侧映射成 -32000）");
        return true;
      }
    );
  } finally {
    mockMode = "normal";
  }
});

test("T-01: 超限后**不得** resolve 出 total:0 的「空目录」结果", async () => {
  mockMode = "bigStdout";
  try {
    let resolved = null;
    await pan.lsEntries("/").then(
      (v) => {
        resolved = v;
      },
      () => {}
    );
    assert.equal(resolved, null, "超限时不得 resolve 出「空目录」结果");
  } finally {
    mockMode = "normal";
  }
});

// ── T-03：stderr 与 stdout 同为 20MB 上限 ────────────────────────────────
// 回归背景：stderr 曾**完全无上限**（实测 60MB stderr 全保留，RSS +121MB）——
// stdout 有上限而 stderr 没有，攻击面不对称。
test("T-03: stderr 超过 20MB → 同样转成明确错误（stdout/stderr 同上限）", async () => {
  mockMode = "bigStderr";
  try {
    await assert.rejects(
      () => pan.lsEntries("/"),
      (err) => {
        assert.ok(/stderr/.test(err.message), "message 应说明是 stderr: " + err.message);
        assert.ok(/20MB/.test(err.message), "message 应含「20MB」: " + err.message);
        assert.equal(err.truncated, true);
        return true;
      }
    );
  } finally {
    mockMode = "normal";
  }
});

// ── T-02：引擎挂死必须在 timeout 内明确失败 ──────────────────────────────
// 回归背景（v1.10.0）：异步 spawn 无 timeout → 引擎挂死 → Promise 永不 settle
// → MCP 闸门槽位**永不释放** → 4 个挂死即整个服务器永久不可用。
test("T-02: 引擎挂死 → timeout 内 reject（message 含「超时」）", async () => {
  mockMode = "hang";
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => pan.lsEntries("/"),
      (err) => {
        assert.ok(/超时/.test(err.message), "message 应含「超时」: " + err.message);
        assert.equal(err.timeout, true, "应带 timeout 标记");
        assert.equal(err.retryable, true, "超时是可重试的暂时性失败");
        return true;
      }
    );
    const wall = Date.now() - t0;
    assert.ok(wall < 8000, "应在 timeout 附近失败，实际 " + wall + "ms");
  } finally {
    mockMode = "normal";
  }
});

test("T-02: 超时后子进程被 kill（不留僵尸进程）", async () => {
  mockMode = "hang";
  const before = killCalls;
  try {
    await pan.lsEntries("/").catch(() => {});
  } finally {
    mockMode = "normal";
  }
  assert.ok(killCalls > before, "超时应调用 child.kill()");
});

// ── T-01 / T-02 的 MCP 层验收 ──────────────────────────────────────────
// 验收口径：MCP 响应 isError:true，error.code === -32000，message 含「20MB」。
test("T-01(MCP): 输出超限 → isError:true 且 error.code === -32000", async () => {
  mockMode = "bigStdout";
  const mcp = require("../lib/mcp");
  const srv = await mcp.startHttpServer({ port: 0, token: "vfy-token-1101a" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer vfy-token-1101a" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_ls", arguments: { path: "/" } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true, "MCP 响应必须是 isError:true");
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error.code, -32000, "无 errno 时错误码应为 -32000");
    assert.ok(/20MB/.test(payload.error.message), "message 应含「20MB」: " + payload.error.message);
  } finally {
    await srv.close();
    mockMode = "normal";
  }
});

test("T-02(MCP): 超时 → severity=retryable（Agent 应退避重试，而非判定永久失败）", async () => {
  mockMode = "hang";
  const mcp = require("../lib/mcp");
  const srv = await mcp.startHttpServer({ port: 0, token: "vfy-token-1101b" });
  try {
    const res = await fetch("http://127.0.0.1:" + srv.port + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer vfy-token-1101b" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bdp_ls", arguments: { path: "/" } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error.code, -32000);
    assert.equal(payload.error.severity, "retryable", "超时应归类为可重试");
    assert.equal(payload.error.retryable, true);
    assert.ok(/超时/.test(payload.error.message));
  } finally {
    await srv.close();
    mockMode = "normal";
  }
});
