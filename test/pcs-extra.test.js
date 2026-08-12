const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 隔离配置：写入临时 BDP_CONFIG_DIR，避免触碰真实 ~/.bdp ──
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-pcsx-cfg-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(path.join(TMP_CFG, "config.json"), JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }), "utf-8");

// ── Mock child_process（pcs-extra.js 惰性 require，非 BaiduPCS-Go 命令委托真实实现）──
const cpPath = require.resolve("child_process");
const realCp = require("child_process");

// 各子命令输出 fixture，按 "quota" / "mv" / "cp" / "offlinedl add" / "offlinedl list" /
// "share set" / "share cancel" / "share list" 分键，未设置则视为意外调用
let outputs = {};
let calls = []; // 记录 BaiduPCS-Go 实参（仅 args[0] 至末尾，不含二进制路径）
let spawnError = null; // 模拟二进制缺失（spawnSync error）
let forcedExit = null; // 模拟非零退出码

function fakeSpawnSync(cmd, args, opts) {
  if (cmd !== "BaiduPCS-Go") return realCp.spawnSync(cmd, args, opts);
  calls.push(args.slice());
  if (spawnError) return { stdout: "", status: null, error: new Error(spawnError) };
  const key = args[0] + (["offlinedl", "share", "recycle"].includes(args[0]) && args[1] ? " " + args[1] : "");
  if (outputs[key] === undefined) throw new Error("unexpected BaiduPCS-Go args: " + args.join(" "));
  return { stdout: outputs[key], status: forcedExit !== null ? forcedExit : 0, error: null };
}

const mockCp = {
  spawn: realCp.spawn,
  spawnSync: fakeSpawnSync,
};
require.cache[cpPath] = { id: cpPath, filename: cpPath, loaded: true, exports: mockCp };

const pcsExtra = require("../lib/pcs-extra");

// ── 工具 ──

// 模拟 BaiduPCS-Go 的 pcstable 表格（tablewriter: 无边框、无列分隔符、列左对齐），
// 用于构造 offlinedl list / share list 的结构化输出 fixture。
// CJK 按显示宽 2 计，每列填充到固定宽度 —— 表头与数据行列起始偏移一致。
function dispWidth(s) {
  return s.split("").reduce((w, ch) => w + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0);
}
function cell(s, w) {
  return s + " ".repeat(Math.max(0, w - dispWidth(s)));
}
function renderTable(header, rows, widths) {
  const lines = [header.map((h, i) => cell(h, widths[i])).join("")];
  for (const r of rows) lines.push(r.map((c, i) => cell(c, widths[i])).join(""));
  return lines.join("\n");
}

// ── Fixtures ──

// quota：2026-08-12 真实运行 BaiduPCS-Go v4.0.1 quota 的原文（未做任何修改）
const QUOTA_REAL = "用户名: , 总空间: 10.004883TB, 已用空间: 9.982749TB, 比率: 99.778767%\n";

const OFFLINE_LIST_FIXTURE =
  renderTable(
    ["#", "任务ID", "任务名称", "文件大小", "创建日期", "保存路径", "资源地址", "状态"],
    [
      ["0", "12345", "movie.mp4", "1.234567GB", "2026-08-10 12:00:00", "/我的资源", "http://example.com/movie.mp4", "下载成功"],
      ["1", "12346", "setup.exe", "100MB", "2026-08-11 09:30:00", "/软件", "magnet:?xt=urn:btih:abcdef", "下载进行中"],
    ],
    [2, 8, 12, 12, 22, 12, 28, 12]
  ) + "\n";

const SHARE_LIST_FIXTURE =
  renderTable(
    ["#", "ShareID", "分享链接", "提取密码", "特征目录", "特征路径", "过期时间", "浏览次数"],
    [
      ["0", "44335566", "https://pan.baidu.com/s/1abcDEFgh", "8x4f", "/", "/我的资源/报告.pdf", "永久", "12"],
      ["1", "44335567", "https://pan.baidu.com/s/1xyzABCdf", "", "/视频", "/视频/课程", "2026/09/01 12:00:00", "0"],
    ],
    [2, 10, 34, 10, 10, 22, 22, 8]
  ) + "\n";

// ── mv / cp ──

test("mv: 目标不存在 → 重命名语义，参数原样拼接", () => {
  outputs = { mv: "重命名成功: \n/我的资源/1.mp4 -> /我的资源/3.mp4\n" };
  calls = [];
  const r = pcsExtra.mv("/我的资源/1.mp4", "/我的资源/3.mp4");
  assert.deepEqual(calls, [["mv", "/我的资源/1.mp4", "/我的资源/3.mp4"]]);
  assert.equal(r.op, "rename");
  assert.equal(r.renamed, true);
  assert.equal(r.src, "/我的资源/1.mp4");
  assert.equal(r.dst, "/我的资源/3.mp4");
  assert.match(r.raw, /重命名成功/);
});

test("mv: 目标是已存在目录 → 移动语义", () => {
  outputs = { mv: "操作成功, 以下文件/目录移动成功: \n&[{From:/我的资源/1.mp4 To:/1.mp4}]\n" };
  calls = [];
  const r = pcsExtra.mv("/我的资源/1.mp4", "/");
  assert.equal(r.op, "move");
  assert.equal(r.renamed, false);
});

test("mv: 输出含错误码 → 抛中文错误", async () => {
  outputs = { mv: "移动文件/目录: 遇到错误, 远端服务器返回错误, 代码: 31061, 消息: 文件不存在\n" };
  assert.throws(() => pcsExtra.mv("/不存在/1.mp4", "/"), /移动失败: .*代码: 31061/);
});

test("cp: 参数拼接 + 成功解析", () => {
  outputs = { cp: "操作成功, 以下文件/目录拷贝成功: \n&[{From:/我的资源/1.mp4 To:/1.mp4}]\n" };
  calls = [];
  const r = pcsExtra.cp("/我的资源/1.mp4", "/");
  assert.deepEqual(calls, [["cp", "/我的资源/1.mp4", "/"]]);
  assert.equal(r.op, "cp");
  assert.equal(r.renamed, false);
});

test("cp: 目标非目录 → 抛错", async () => {
  outputs = { cp: "目标 /x 不是一个目录, 操作失败\n" };
  assert.throws(() => pcsExtra.cp("/a", "/x"), /拷贝失败: .*不是一个目录/);
});

// ── quota ──

test("quota: 解析真实输出（TB 单位）", () => {
  outputs = { quota: QUOTA_REAL };
  calls = [];
  const q = pcsExtra.quota();
  assert.deepEqual(calls, [["quota"]]);
  // 10.004883TB / 9.982749TB → 字节（同 ConvertFileSize 换算）
  assert.equal(q.total, 11000485193038);
  assert.equal(q.used, 10976148602669);
  assert.equal(q.free, 24336590369);
  assert.equal(q.ratio, 99.778767);
  assert.equal(q.username, "");
  assert.match(q.raw, /总空间: 10.004883TB/);
});

test("quota: GB 单位 + 非空用户名", () => {
  outputs = { quota: "用户名: 测试账号, 总空间: 1024.000000GB, 已用空间: 512.5GB, 比率: 50.048828%\n" };
  const q = pcsExtra.quota();
  assert.equal(q.total, 1099511627776);
  assert.equal(q.used, 550292684800);
  assert.equal(q.free, 1099511627776 - 550292684800);
  assert.ok(Math.abs(q.ratio - 50.048828) < 1e-6);
  assert.equal(q.username, "测试账号");
});

test("quota: 输出无法解析（如未登录报错）→ 抛错", async () => {
  outputs = { quota: "获取网盘配额: 遇到错误, 远端服务器返回错误, 代码: 1, 消息: 未登录\n" };
  assert.throws(() => pcsExtra.quota(), /获取网盘配额失败: 无法解析输出/);
});

// ── offlinedl ──

test("offlineAdd: 带保存路径 → -path 参数拼接 + taskId 解析", () => {
  outputs = {
    "offlinedl add": "[1] 添加离线任务成功, 任务ID(task_id): 8833, 源地址: http://example.com/a.iso, 保存路径: /我的资源\n",
  };
  calls = [];
  const r = pcsExtra.offlineAdd("http://example.com/a.iso", "/我的资源");
  assert.deepEqual(calls, [["offlinedl", "add", "-path=/我的资源", "http://example.com/a.iso"]]);
  assert.equal(r.taskId, 8833);
  assert.equal(r.url, "http://example.com/a.iso");
  assert.equal(r.savePath, "/我的资源");
});

test("offlineAdd: 不带保存路径 → 不加 -path（磁力链）", () => {
  outputs = { "offlinedl add": "[1] 添加离线任务成功, 任务ID(task_id): 8844, 源地址: magnet:?xt=urn:btih:abc, 保存路径: /我的资源\n" };
  calls = [];
  const r = pcsExtra.offlineAdd("magnet:?xt=urn:btih:abc");
  assert.deepEqual(calls, [["offlinedl", "add", "magnet:?xt=urn:btih:abc"]]);
  assert.equal(r.taskId, 8844);
  assert.equal(r.savePath, null);
});

test("offlineAdd: 引擎输出错误码（退出码仍为 0）→ 抛错", async () => {
  outputs = {
    "offlinedl add": "[1] 添加离线下载任务: 遇到错误, 远端服务器返回错误, 代码: 31045, 消息: 任务列表已满, 地址: http://example.com/a.iso\n",
  };
  assert.throws(() => pcsExtra.offlineAdd("http://example.com/a.iso"), /添加离线下载任务失败: .*代码: 31045/);
});

test("offlineList: 解析表格 → 结构化任务列表", () => {
  outputs = { "offlinedl list": OFFLINE_LIST_FIXTURE };
  const r = pcsExtra.offlineList();
  assert.equal(r.count, 2);
  const t0 = r.tasks[0];
  assert.equal(t0.taskId, 12345);
  assert.equal(t0.index, 0);
  assert.equal(t0.name, "movie.mp4");
  assert.equal(t0.size, 1325606222); // 1.234567GB
  assert.equal(t0.createTime, "2026-08-10 12:00:00");
  assert.equal(t0.savePath, "/我的资源");
  assert.equal(t0.sourceUrl, "http://example.com/movie.mp4");
  assert.equal(t0.status, "下载成功");
  assert.equal(t0.statusCode, 0);
  const t1 = r.tasks[1];
  assert.equal(t1.taskId, 12346);
  assert.equal(t1.name, "setup.exe");
  assert.equal(t1.size, 104857600); // 100MB
  assert.equal(t1.sourceUrl, "magnet:?xt=urn:btih:abcdef");
  assert.equal(t1.status, "下载进行中");
  assert.equal(t1.statusCode, 1);
});

test("offlineList: 空列表（仅有表头）→ 返回空数组", () => {
  outputs = {
    "offlinedl list": renderTable(["#", "任务ID", "任务名称", "文件大小", "创建日期", "保存路径", "资源地址", "状态"], [], [2, 8, 12, 12, 22, 12, 28, 12]),
  };
  const r = pcsExtra.offlineList();
  assert.equal(r.count, 0);
  assert.deepEqual(r.tasks, []);
});

test("offlineList: 无表头的错误输出 → 抛错", async () => {
  outputs = { "offlinedl list": "查询离线下载任务列表: 遇到错误, 远端服务器返回错误, 代码: 31045, 消息: 任务列表已满\n" };
  assert.throws(() => pcsExtra.offlineList(), /查询离线下载任务列表失败: .*代码: 31045/);
});

// ── share ──

test("shareSet: 不带密码（公开分享）", () => {
  outputs = { "share set": "shareID: 44335566, 链接: https://pan.baidu.com/s/1abcDEFgh, 密码: \n" };
  calls = [];
  const r = pcsExtra.shareSet("/我的资源/报告.pdf");
  assert.deepEqual(calls, [["share", "set", "/我的资源/报告.pdf"]]);
  assert.equal(r.shareId, 44335566);
  assert.equal(r.link, "https://pan.baidu.com/s/1abcDEFgh");
  assert.equal(r.pwd, "");
  assert.equal(r.combined, false);
});

test("shareSet: 带密码 → -p 参数", () => {
  outputs = { "share set": "shareID: 44335567, 链接: https://pan.baidu.com/s/1xyzABCdf, 密码: 8x4f\n" };
  calls = [];
  const r = pcsExtra.shareSet("/我的资源/报告.pdf", "8x4f");
  assert.deepEqual(calls, [["share", "set", "-p", "8x4f", "/我的资源/报告.pdf"]]);
  assert.equal(r.shareId, 44335567);
  assert.equal(r.pwd, "8x4f");
  assert.equal(r.combined, false);
});

test("shareSet: -f 合并格式（链接?pwd=密码）", () => {
  outputs = { "share set": "shareID: 44335568, 链接: https://pan.baidu.com/s/1qweRTYu?pwd=8x4f\n" };
  calls = [];
  const r = pcsExtra.shareSet("/我的资源/报告.pdf", "8x4f", { combined: true });
  assert.deepEqual(calls, [["share", "set", "-p", "8x4f", "-f", "/我的资源/报告.pdf"]]);
  assert.equal(r.combined, true);
  assert.equal(r.pwd, "8x4f");
  assert.equal(r.link, "https://pan.baidu.com/s/1qweRTYu");
});

test("shareSet: 创建失败 → 抛错", async () => {
  outputs = { "share set": "创建分享链接失败: 创建分享链接: 遇到错误, 远端服务器返回错误, 代码: 31007, 消息: 分享失败\n" };
  assert.throws(() => pcsExtra.shareSet("/x"), /创建分享失败: .*代码: 31007/);
});

test("shareCancel: 成功", () => {
  outputs = { "share cancel": "取消分享成功\n" };
  calls = [];
  const r = pcsExtra.shareCancel(44335566);
  assert.deepEqual(calls, [["share", "cancel", "44335566"]]);
  assert.equal(r.ok, true);
  assert.equal(r.shareId, 44335566);
});

test("shareCancel: 失败 → 抛错", async () => {
  outputs = { "share cancel": "取消分享失败: 取消分享: 遇到错误, 远端服务器返回错误, 代码: 31007, 消息: 分享不存在\n" };
  assert.throws(() => pcsExtra.shareCancel(999), /取消分享失败: .*代码: 31007/);
});

test("shareList: 解析表格（含空密码列）", () => {
  outputs = { "share list": SHARE_LIST_FIXTURE };
  const r = pcsExtra.shareList();
  assert.equal(r.count, 2);
  const s0 = r.shares[0];
  assert.equal(s0.shareId, 44335566);
  assert.equal(s0.link, "https://pan.baidu.com/s/1abcDEFgh");
  assert.equal(s0.pwd, "8x4f");
  assert.equal(s0.typicalDir, "/");
  assert.equal(s0.typicalPath, "/我的资源/报告.pdf");
  assert.equal(s0.expireText, "永久");
  assert.equal(s0.viewCount, 12);
  const s1 = r.shares[1];
  assert.equal(s1.shareId, 44335567);
  assert.equal(s1.pwd, "");
  assert.equal(s1.expireText, "2026/09/01 12:00:00");
  assert.equal(s1.viewCount, 0);
});

test("shareList: 第二页 → --page 参数", () => {
  outputs = { "share list": renderTable(["#", "ShareID", "分享链接", "提取密码", "特征目录", "特征路径", "过期时间", "浏览次数"], [], [2, 10, 34, 10, 10, 22, 22, 8]) };
  calls = [];
  pcsExtra.shareList(2);
  assert.deepEqual(calls, [["share", "list", "--page=2"]]);
});

// ── 失败路径（进程层）──

test("runPCS: spawnSync error（二进制缺失）→ 抛错", async () => {
  outputs = { quota: QUOTA_REAL };
  spawnError = "spawn BaiduPCS-Go ENOENT";
  assert.throws(() => pcsExtra.quota(), /BaiduPCS-Go not found at: BaiduPCS-Go/);
  spawnError = null;
});

test("runPCS: 非零退出码 → 抛错", async () => {
  outputs = { quota: QUOTA_REAL };
  forcedExit = 7;
  assert.throws(() => pcsExtra.quota(), /退出码 7/);
  forcedExit = null;
});

// ── 工具函数 ──

test("parseSizeText: 单位换算", () => {
  assert.equal(pcsExtra.parseSizeText("1.234567GB"), 1325606222);
  assert.equal(pcsExtra.parseSizeText("100MB"), 104857600);
  assert.equal(pcsExtra.parseSizeText("0B"), 0);
  assert.equal(pcsExtra.parseSizeText("1KB"), 1024);
  assert.equal(pcsExtra.parseSizeText("10.004883TB"), 11000485193038);
  assert.equal(pcsExtra.parseSizeText("abc"), null);
  assert.equal(pcsExtra.parseSizeText(""), null);
});

// ── recycle 回收站 ──

const RECYCLE_ROW = `  #       FS ID       文件大小       创建日期             修改日期        MD5(截图请打码)  剩余时间                 路径                 
  0  378804494923604         -  2026-08-12 18:56:01  2026-08-12 18:56:15                         60  /bdp-transfer-probe/bdp-130-smoke/                 
  1  123456789012345   2.5MB  2026-08-01 10:00:00  2026-08-02 11:00:00  abcdef0123456789abcdef0123456789  30  /文档/旧报告.pdf`;

test("recycleList: 解析回收站表格（含/不含 MD5 行）", () => {
  outputs = { "recycle list": RECYCLE_ROW };
  const r = pcsExtra.recycleList();
  assert.equal(r.count, 2);
  assert.equal(r.items[0].fsId, 378804494923604);
  assert.equal(r.items[0].size, null, "无大小的行 size 为 null");
  assert.equal(r.items[0].remainDays, 60);
  assert.equal(r.items[0].path, "/bdp-transfer-probe/bdp-130-smoke/");
  assert.equal(r.items[1].fsId, 123456789012345);
  assert.equal(r.items[1].size, 2.5 * 1024 * 1024, "带大小行解析为字节");
  assert.equal(r.items[1].md5, "abcdef0123456789abcdef0123456789");
  assert.equal(r.items[1].remainDays, 30);
});

test("recycleList: 空回收站", () => {
  outputs = { "recycle list": `  #       FS ID       文件大小       创建日期             修改日期        MD5(截图请打码)  剩余时间                 路径                 
` };
  const r = pcsExtra.recycleList();
  assert.equal(r.count, 0);
});

test("recycleList: --page 透传", () => {
  outputs = { "recycle list": RECYCLE_ROW };
  pcsExtra.recycleList(2);
  assert.ok(calls.some((c) => c[0] === "recycle" && c[1] === "list" && c[2] === "--page=2"), "page=2 应透传: " + JSON.stringify(calls));
});

test("recycleRestore: 成功/失败", () => {
  outputs = { "recycle restore": "还原成功: 1 个文件/目录" };
  const r = pcsExtra.recycleRestore([378804494923604]);
  assert.equal(r.ok, true);
  assert.equal(r.fsIds[0], 378804494923604);
  outputs = { "recycle restore": "还原失败: 未找到文件" };
  assert.throws(() => pcsExtra.recycleRestore([1]), /还原失败/);
});

test("recycleClean: 清空成功", () => {
  outputs = { "recycle delete": "清空回收站成功" };
  const r = pcsExtra.recycleClean();
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c[1] === "delete" && c[2] === "-all"), "delete -all 应透传");
});
