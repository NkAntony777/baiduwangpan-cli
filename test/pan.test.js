const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

// ── 隔离配置：写入临时 BDP_CONFIG_DIR，避免触碰真实 ~/.bdp ──
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-pan-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(path.join(TMP_CFG, "config.json"), JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }), "utf-8");

// ── Mock http 模块（替换 require.cache，同 group.test.js 风格）──
const httpPath = require.resolve("../lib/http");
let mockWebJsonImpl = null;
const mockHttp = {
  APP_ID: "250528",
  webJson: async (...a) => {
    if (!mockWebJsonImpl) throw new Error("webJson not mocked");
    return mockWebJsonImpl(...a);
  },
  getBdstoken: async () => "mock-bdstoken",
};
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: mockHttp };

// ── Mock child_process（pan.js 惰性 require，非 curl/PCS 调用委托真实实现）──
const cpPath = require.resolve("child_process");
const realCp = require("child_process");

// curl 模拟：解析 -r range / -o tmp / -w，由 curlResponder(start, end) 决定响应
let curlResponder = null; // (start, end) => { code, data, size? } 或 { exitCode }
let curlCalls = [];
function fakeSpawn(cmd, args, opts) {
  if (cmd !== "curl") return realCp.spawn(cmd, args, opts);
  curlCalls.push(args);
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  setImmediate(() => {
    try {
      const ri = args.indexOf("-r");
      const oi = args.indexOf("-o");
      const tmp = args[oi + 1];
      if (ri === -1) {
        // 无 -r（无大小回退分支）
        const resp = curlResponder ? curlResponder(0, -1) : { code: "206", data: Buffer.alloc(0) };
        if (resp.code) {
          fs.writeFileSync(tmp, resp.data || Buffer.alloc(0));
          child.stdout.write(`${resp.code} ${resp.size != null ? resp.size : (resp.data || []).length}\n`);
          child.emit("close", 0);
        } else {
          child.emit("close", resp.exitCode ?? 0);
        }
        child.stdout.end();
        return;
      }
      const [s, e] = args[ri + 1].split("-").map(Number);
      const resp = curlResponder ? curlResponder(s, e) : { code: "206", data: Buffer.alloc(e - s + 1, 7) };
      if (resp.code) {
        fs.writeFileSync(tmp, resp.data || Buffer.alloc(0));
        child.stdout.write(`${resp.code} ${resp.size != null ? resp.size : (resp.data || []).length}\n`);
        child.emit("close", 0);
      } else {
        child.emit("close", resp.exitCode ?? 0);
      }
      child.stdout.end();
    } catch {
      child.emit("close", 1);
    }
  });
  return child;
}

// BaiduPCS-Go 输出（locate/meta/d）模拟
function fakeSpawnSync(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawnSync(cmd, args, opts);
  const sub = args[0];
  if (sub === "locate") {
    return { stdout: "  0  https://d.example.com/file/abc?size=1000&expires=8h&x=1\n  1  https://d.example.com/backup?size=1000\n", error: null };
  }
  if (sub === "meta") {
    return { stdout: "  类型              文件\n  文件路径          /docs/报告.pdf\n  文件大小          1000, 0.98KB\n  md5 (可能不正确)  abcdef0123456789abcdef0123456789\n", error: null };
  }
  if (sub === "d") {
    return { stdout: "download via pcs engine\n", error: null };
  }
  throw new Error("unexpected BaiduPCS-Go args: " + args.join(" "));
}

const mockCp = {
  spawn: fakeSpawn,
  spawnSync: fakeSpawnSync,
};
require.cache[cpPath] = { id: cpPath, filename: cpPath, loaded: true, exports: mockCp };

const pan = require("../lib/pan");

// ── 工具 ──

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bdp-pan-out-"));
}

// 默认 web 元信息：/docs/报告.pdf → size 1000
function defaultWebMeta(size = 1000, md5Val = null) {
  return { errno: 0, list: [{ server_filename: "报告.pdf", size, md5: md5Val, isdir: 0, server_ctime: 100, local_ctime: 200 }] };
}

// 默认 curl 响应：206 + 返回请求范围的填充数据
function okResponder() {
  return (s, e) => ({ code: "206", data: Buffer.alloc(e - s + 1, 7) });
}

// ── Tests ──

test("download: curl 分块下载 + size/md5 校验通过", async () => {
  const content = Buffer.alloc(1000, 7);
  const remoteMd5 = md5(content);
  mockWebJsonImpl = async (url) => {
    assert.ok(url.includes("/api/list"));
    return defaultWebMeta(1000, remoteMd5);
  };
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });
  curlCalls = [];

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir);

  assert.equal(info.size, 1000);
  assert.equal(info.verified, true);
  assert.equal(info.skipped, false);
  assert.equal(info.resumed, false);
  assert.equal(info.md5Match, true);
  assert.equal(info.md5, remoteMd5);
  assert.equal(info.remoteMd5, remoteMd5);
  assert.equal(info.dlinkExpiry, "8h");
  assert.equal(info.localPath, path.join(outDir, "报告.pdf"));
  assert.equal(fs.statSync(info.localPath).size, 1000);
  assert.equal(typeof info.avgSpeedBps, "number");
  // 分块请求使用有界 Range
  assert.equal(curlCalls[0][curlCalls[0].indexOf("-r") + 1], "0-999");
});

test("download: 分块全部失败（CDN 拒绝/过期）→ 报错并保留文件", async () => {
  mockWebJsonImpl = async () => defaultWebMeta(1000, null);
  // 始终返回 403 错误页（118 字节，模拟 bjdd-ct11 反盗链）
  curlResponder = () => ({ code: "403", data: Buffer.from('{"error_code":31326,"error_msg":"user is not authorized, hitcode:104"}') });
  curlCalls = [];

  const outDir = tmpDir();
  const target = path.join(outDir, "报告.pdf");
  await assert.rejects(
    pan.download("/docs/报告.pdf", outDir),
    /下载中断于 0\/1000 字节: dlink 过期或网络中断或 CDN 拒绝/
  );
  assert.equal(fs.existsSync(target), true, "失败后文件应保留供排查");
  assert.ok(curlCalls.length >= 4, "应重试多次（每块换新 dlink）: " + curlCalls.length);
});

test("download: 分块返回长度不符 → 视为失败并重试换 dlink", async () => {
  mockWebJsonImpl = async () => defaultWebMeta(1000, null);
  let call = 0;
  curlResponder = (s, e) => {
    call++;
    if (call === 1) return { code: "206", data: Buffer.alloc(500, 1) }; // 长度不符
    return { code: "206", data: Buffer.alloc(e - s + 1, 7) };
  };
  curlCalls = [];

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir);
  assert.equal(info.size, 1000);
  assert.ok(curlCalls.length >= 2, "首次长度不符后应重试");
});

test("download: --resume 断点续传 → 从已有字节数继续分块，最终完整", async () => {
  const content = Buffer.alloc(1000, 9);
  const remoteMd5 = md5(content);
  mockWebJsonImpl = async () => defaultWebMeta(1000, remoteMd5);
  curlCalls = [];
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });

  const outDir = tmpDir();
  const target = path.join(outDir, "报告.pdf");
  fs.writeFileSync(target, content.slice(0, 400)); // 已有 400 字节部分文件

  const info = await pan.download("/docs/报告.pdf", outDir, { resume: true });
  assert.equal(info.resumed, true);
  assert.equal(info.size, 1000);
  assert.equal(info.md5Match, true);
  // 续传应从 400 开始请求
  assert.equal(curlCalls[0][curlCalls[0].indexOf("-r") + 1], "400-999");
});

test("download: 部分文件存在且未传 --resume → 自动续传", async () => {
  const content = Buffer.alloc(1000, 5);
  mockWebJsonImpl = async () => defaultWebMeta(1000, md5(content));
  curlCalls = [];
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });

  const outDir = tmpDir();
  const target = path.join(outDir, "报告.pdf");
  fs.writeFileSync(target, content.slice(0, 300));

  // 拦截 stderr 提示
  const origErr = process.stderr.write;
  let stderr = "";
  process.stderr.write = (c) => { stderr += c; return true; };
  const info = await pan.download("/docs/报告.pdf", outDir);
  process.stderr.write = origErr;

  assert.equal(info.resumed, true);
  assert.equal(info.size, 1000);
  assert.match(stderr, /\[auto-resume\]/);
  assert.equal(curlCalls[0][curlCalls[0].indexOf("-r") + 1], "300-999");
});

test("download: 已存在同大小文件 → 跳过且 md5 复核通过，不调 curl", async () => {
  const content = Buffer.alloc(1000, 3);
  const remoteMd5 = md5(content);
  mockWebJsonImpl = async () => defaultWebMeta(1000, remoteMd5);
  curlCalls = [];

  const outDir = tmpDir();
  const target = path.join(outDir, "报告.pdf");
  fs.writeFileSync(target, content);

  const info = await pan.download("/docs/报告.pdf", outDir);
  assert.equal(info.skipped, true);
  assert.equal(info.verified, true);
  assert.equal(info.md5Match, true);
  assert.equal(curlCalls.length, 0, "跳过时不应发起 curl 下载");
});

test("download: 已存在同大小但内容与远端 md5 不符 → 标注不一致但不阻断", async () => {
  const goodContent = Buffer.alloc(1000, 3);
  const remoteMd5 = md5(goodContent); // 远端是标准 hex 但内容不同 → 软校验 false
  mockWebJsonImpl = async () => defaultWebMeta(1000, remoteMd5);
  curlCalls = [];

  const outDir = tmpDir();
  fs.writeFileSync(path.join(outDir, "报告.pdf"), Buffer.alloc(1000, 8)); // 错误内容
  const info = await pan.download("/docs/报告.pdf", outDir);
  assert.equal(info.skipped, true);
  assert.equal(info.md5Match, false, "标准 hex 远端 md5 与本地不一致应标注");
  assert.equal(info.md5Obfuscated, false);
  assert.equal(curlCalls.length, 0);
});

test("download: 远端 md5 为百度混淆值（非标准 hex）→ 标注但不阻断", async () => {
  const content = Buffer.alloc(1000, 7);
  mockWebJsonImpl = async () => defaultWebMeta(1000, "ce06e0a94o8b330d0d3b3c2e73cb6d92"); // 含 o
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });
  curlCalls = [];

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir);
  assert.equal(info.size, 1000);
  assert.equal(info.verified, true);
  assert.equal(info.md5Obfuscated, true);
  assert.equal(info.md5Match, null);
  assert.equal(info.md5, md5(content));
});

test("download: web 元信息失败 → 回退 locate/meta 文本解析", async () => {
  mockWebJsonImpl = async () => { throw new Error("network down"); };
  curlResponder = okResponder();
  curlCalls = [];

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir);
  assert.equal(info.size, 1000); // 文本解析 "文件大小 1000, 0.98KB" 取首个数字
  assert.equal(info.verified, true);
  assert.equal(info.dlinkExpiry, "8h");
});

test("download: 目录走 BaiduPCS-Go 引擎回退", async () => {
  mockWebJsonImpl = async () => ({ errno: 0, list: [{ server_filename: "文档目录", size: 0, isdir: 1 }] });
  curlCalls = [];

  const outDir = tmpDir();
  const info = await pan.download("/docs/文档目录", outDir);
  assert.equal(info.engine, "pcs");
  assert.match(info.raw, /download via pcs engine/);
  assert.equal(curlCalls.length, 0);
});

test("download: --force 对已存在文件重新下载（先清旧文件）", async () => {
  const content = Buffer.alloc(1000, 2);
  mockWebJsonImpl = async () => defaultWebMeta(1000, md5(content));
  curlCalls = [];
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });

  const outDir = tmpDir();
  const target = path.join(outDir, "报告.pdf");
  fs.writeFileSync(target, Buffer.alloc(500, 9)); // 旧的部分文件

  const info = await pan.download("/docs/报告.pdf", outDir, { force: true });
  assert.equal(info.skipped, false);
  assert.equal(info.size, 1000, "force 后应完整重下而非追加");
  assert.equal(curlCalls.length, 1);
  assert.equal(curlCalls[0][curlCalls[0].indexOf("-r") + 1], "0-999");
});

test("download: --progress 时 stderr 输出进度", async () => {
  const content = Buffer.alloc(1000, 7);
  mockWebJsonImpl = async () => defaultWebMeta(1000, md5(content));
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });
  curlCalls = [];

  const origErr = process.stderr.write;
  let stderr = "";
  process.stderr.write = (c) => { stderr += c; return true; };
  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir, { progress: true });
  process.stderr.write = origErr;

  assert.equal(info.size, 1000);
  assert.match(stderr, /\[get\]/);
});

test("download: 大文件并发分块 → 按序落盘、最终完整", async () => {
  const SIZE = 40 * 1024 * 1024; // 10 块 × 4MB，超过并发阈值
  const content = Buffer.alloc(SIZE, 7);
  const remoteMd5 = md5(content);
  mockWebJsonImpl = async () => defaultWebMeta(SIZE, remoteMd5);
  curlCalls = [];
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir, { concurrency: 3 });

  assert.equal(info.size, SIZE);
  assert.equal(info.verified, true);
  assert.equal(info.md5Match, true);
  assert.ok(curlCalls.length >= 10, "应请求全部 10 块: " + curlCalls.length);
  // 并发: 前几块的 range 应重叠在途（0-4194303 与 4194304-8388607 都已发起）
  const ranges = curlCalls.map((a) => a[a.indexOf("-r") + 1]);
  assert.ok(ranges.includes("4194304-8388607"), "并发窗口应预取后续块: " + ranges.join(","));
  // 按序落盘: 最终内容与源一致
  assert.equal(fs.readFileSync(info.localPath).equals(content), true);
});

test("download: 并发块失败 → 降级串行补齐，最终完整", async () => {
  const SIZE = 40 * 1024 * 1024;
  const content = Buffer.alloc(SIZE, 5);
  const remoteMd5 = md5(content);
  mockWebJsonImpl = async () => defaultWebMeta(SIZE, remoteMd5);
  curlCalls = [];
  let failCount = 0;
  // 第 2 块 (4194304) 前 5 次请求失败（覆盖并发阶段重试），之后成功 → 验证降级后能补齐
  curlResponder = (s, e) => {
    if (s === 4194304) {
      failCount++;
      if (failCount <= 5) return { code: "403", data: Buffer.from("err") };
    }
    return { code: "206", data: content.slice(s, e + 1) };
  };

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir, { concurrency: 3 });
  assert.equal(info.size, SIZE);
  assert.equal(info.md5Match, true);
  assert.ok(failCount > 3, "第 2 块应经历多次失败: " + failCount);
});

test("download: --concurrency 1 强制串行（大文件也不并发）", async () => {
  const SIZE = 40 * 1024 * 1024;
  const content = Buffer.alloc(SIZE, 3);
  mockWebJsonImpl = async () => defaultWebMeta(SIZE, md5(content));
  curlCalls = [];
  curlResponder = (s, e) => ({ code: "206", data: content.slice(s, e + 1) });

  const outDir = tmpDir();
  const info = await pan.download("/docs/报告.pdf", outDir, { concurrency: 1 });
  assert.equal(info.size, SIZE);
  // 串行: 请求顺序严格递增（每块完成才发下一块）
  const ranges = curlCalls.map((a) => parseInt(a[a.indexOf("-r") + 1], 10));
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i] > ranges[i - 1], "串行 range 应递增");
});

test("du: 递归统计目录大小、文件数与子目录分布", async () => {
  const fixture = {
    "/": { list: [
      { server_filename: "a.txt", size: 100, isdir: 0 },
      { server_filename: "big", size: 0, isdir: 1 },
    ] },
    "/big": { list: [
      { server_filename: "x.bin", size: 500, isdir: 0 },
      { server_filename: "sub", size: 0, isdir: 1 },
    ] },
    "/big/sub": { list: [
      { server_filename: "deep.bin", size: 300, isdir: 0 },
      { server_filename: "empty", size: 0, isdir: 1 },
    ] },
    "/big/sub/empty": { list: [] },
  };
  mockWebJsonImpl = async (url) => {
    const m = url.match(/dir=([^&]+)/);
    const dir = decodeURIComponent(m[1]);
    return { errno: 0, list: fixture[dir] ? fixture[dir].list : [] };
  };

  const r = await pan.du("/", { depth: 3 });
  assert.equal(r.size, 900, "100 + 500 + 300");
  assert.equal(r.files, 3);
  assert.equal(r.dirs, 3);
  assert.equal(r.failed, 0, "空目录不应记为失败");
  const big = r.children.find((c) => c.name === "big");
  assert.ok(big, "children 应包含 big 目录");
  assert.equal(big.size, 800, "big 应聚合子目录大小");
  // 排序: 大的在前
  assert.ok(r.children[0].size >= r.children[r.children.length - 1].size);
});

test("du: 深度封顶 → 子目录标记 capped 且不递归", async () => {
  mockWebJsonImpl = async (url) => {
    const m = url.match(/dir=([^&]+)/);
    const dir = decodeURIComponent(m[1]);
    if (dir === "/") return { errno: 0, list: [{ server_filename: "a", size: 0, isdir: 1 }] };
    if (dir === "/a") return { errno: 0, list: [{ server_filename: "b", size: 0, isdir: 1 }] };
    if (dir === "/a/b") return { errno: 0, list: [{ server_filename: "hidden.bin", size: 999, isdir: 0 }] };
    return { errno: 0, list: [] };
  };
  // depth=1: 只扫 / 与 /a；/a/b (depth 2) 封顶
  const r = await pan.du("/", { depth: 1 });
  const a = r.children.find((c) => c.name === "a");
  assert.ok(a, "children 应包含 a");
  assert.equal(a.size, 0, "a 的直接文件为 0");
  assert.equal(r.size, 0, "封顶后 /a/b 的 999 字节不应计入");
  // depth=2: /a/b 可扫
  const r2 = await pan.du("/", { depth: 2 });
  assert.equal(r2.size, 999);
});

test("getFileMeta: 解析 BaiduPCS-Go v4.0.1 真实输出格式", () => {
  const meta = pan.getFileMeta("/docs/报告.pdf");
  assert.equal(meta.size, 1000); // "文件大小 1000, 0.98KB" 取精确字节
  assert.equal(meta.md5, "abcdef0123456789abcdef0123456789");
  assert.equal(meta.isDir, false);
});
