// lib/pcs-extra.js — BaiduPCS-Go 附加子命令封装: mv / cp / quota / offlinedl / share
//
// 风格对齐 lib/pan.js：
//   - child_process 惰性 require（测试可整体替换 require.cache["child_process"] 注入 mock）
//   - spawnSync 调用 config.get().pcsPath，encoding utf-8，maxBuffer 20MB
//   - 成功返回解析后的对象（含 raw 原文）；失败抛中文 Error
//
// 重要（BaiduPCS-Go v4.0.1 实测/源码确认）：
//   操作类命令（mv/cp/share/offlinedl）出错时**退出码仍为 0**，错误只体现在
//   输出文本里（"失败"/"遇到错误, ..., 代码: N"），因此每个函数都必须检查输出。

const config = require("./config");

// child_process 延迟加载：测试可整体替换 require.cache["child_process"] 注入 mock
function childProc() {
  return require("child_process");
}

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };

// 离线下载任务状态（BaiduPCS-Go baidupcs.CloudDlTaskInfo.Status 源码确认）
const OFFLINE_STATUS = {
  0: "下载成功",
  1: "下载进行中",
  2: "系统错误",
  3: "资源不存在",
  4: "下载超时",
  5: "资源存在但下载失败",
  6: "存储空间不足",
  7: "任务取消",
};
const OFFLINE_STATUS_TO_CODE = {};
for (const [code, text] of Object.entries(OFFLINE_STATUS)) OFFLINE_STATUS_TO_CODE[text] = Number(code);

// 解析 ConvertFileSize 输出（"1.234567GB" / "100MB" / "0B"）→ 字节数；无法解析返回 null
function parseSizeText(text) {
  const m = String(text || "").trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB)?$/i);
  if (!m) return null;
  const unit = (m[2] || "B").toUpperCase();
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[unit]);
}

function runPCS(args) {
  const cfg = config.get();
  const { spawnSync } = childProc();
  const result = spawnSync(cfg.pcsPath, args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`BaiduPCS-Go not found at: ${cfg.pcsPath}. Set pcsPath in config or BAIDUPCS_CMD env.`);
  }
  if (result.status != null && result.status !== 0) {
    throw new Error(`BaiduPCS-Go ${args[0] || ""} 退出码 ${result.status}: ${(result.stdout || "").trim() || "(无输出)"}`);
  }
  return result.stdout || "";
}

// ── mv / cp ─────────────────────────────────────────────

// 移动/重命名。dst 为已存在目录 → 移动；否则按重命名处理（引擎行为）。
// 成功: { src, dst, op: "mv"|"rename"|"cp", renamed, raw }
function mv(srcPath, dstPath) {
  return cpMvOp("mv", "移动", srcPath, dstPath);
}

// 拷贝。成功: { src, dst, op: "cp", renamed: false, raw }
function cp(srcPath, dstPath) {
  return cpMvOp("cp", "拷贝", srcPath, dstPath);
}

function cpMvOp(cmd, opName, srcPath, dstPath) {
  const output = runPCS([cmd, srcPath, dstPath]);
  if (!output.trim()) throw new Error(`${opName}失败: BaiduPCS-Go 无输出`);
  // 成功输出含 "重命名成功"/"操作成功"/"拷贝成功"，失败输出含
  // "操作失败"/"移动失败"/"拷贝失败"/"path error"/"不是一个目录"/"遇到错误, ..., 代码: N"
  if (/(操作失败|拷贝失败|移动失败|重命名失败|path error|不是一个目录|不存在|遇到错误)/.test(output)) {
    throw new Error(`${opName}失败: ${output.trim()}`);
  }
  const renamed = /重命名成功/.test(output);
  const op = cmd === "mv" ? (renamed ? "rename" : "move") : "cp";
  return { src: srcPath, dst: dstPath, op, renamed, raw: output };
}

// ── quota ───────────────────────────────────────────────

// 获取网盘配额。实测输出（单行）:
//   用户名: , 总空间: 10.004883TB, 已用空间: 9.982749TB, 比率: 99.778767%
// 成功: { total, used, free, ratio, username, raw }（字节数 + 百分比）
function quota() {
  const output = runPCS(["quota"]);
  const m = output.match(
    /用户名:\s*([^,]*),\s*总空间:\s*(\d+(?:\.\d+)?(?:B|KB|MB|GB|TB|PB)?),\s*已用空间:\s*(\d+(?:\.\d+)?(?:B|KB|MB|GB|TB|PB)?),\s*比率:\s*([\d.]+)%/i
  );
  if (!m) throw new Error(`获取网盘配额失败: 无法解析输出\n${output.trim()}`);
  const total = parseSizeText(m[2]);
  const used = parseSizeText(m[3]);
  if (total === null || used === null) throw new Error(`获取网盘配额失败: 无法解析大小\n${output.trim()}`);
  return { total, used, free: total - used, ratio: parseFloat(m[4]), username: m[1].trim(), raw: output };
}

// ── offlinedl ───────────────────────────────────────────

// 添加离线下载任务（单 URL）。savePath 为目标目录（不传则用引擎工作目录）。
// 成功: { taskId, url, savePath, raw }
function offlineAdd(url, savePath) {
  const args = ["offlinedl", "add"];
  if (savePath) args.push(`-path=${savePath}`);
  args.push(url);
  const output = runPCS(args);
  // 成功: "[1] 添加离线任务成功, 任务ID(task_id): 8833, 源地址: ..., 保存路径: ..."
  const ok = output.match(/添加离线任务成功, 任务ID\(task_id\):\s*(\d+)/);
  if (ok) return { taskId: Number(ok[1]), url, savePath: savePath || null, raw: output };
  // 失败（引擎仍返回 0）: "[1] 添加离线下载任务: 遇到错误, ..., 代码: 31045, 消息: ..., 地址: ..."
  const fail = output.match(/\[\d+\]\s*(.+?),\s*地址:\s*\S+/);
  throw new Error(`添加离线下载任务失败: ${fail ? fail[1].trim() : (output.trim() || "(无输出)")}`);
}

// 查询离线下载任务列表。输出为 pcstable 表格:
//   #  任务ID  任务名称  文件大小  创建日期  保存路径  资源地址  状态
// 成功: { tasks: [{ index, taskId, name, size, createTime, savePath, sourceUrl, status, statusCode }], count, raw }
function offlineList() {
  const output = runPCS(["offlinedl", "list"]);
  const rows = parseTable(output, ["#", "任务ID", "任务名称", "文件大小", "创建日期", "保存路径", "资源地址", "状态"]);
  if (rows === null) throw new Error(`查询离线下载任务列表失败: ${output.trim() || "(无输出)"}`);
  const tasks = rows.map((r) => ({
    index: parseInt(r[0], 10),
    taskId: parseInt(r[1], 10),
    name: r[2],
    size: parseSizeText(r[3]),
    createTime: r[4],
    savePath: r[5],
    sourceUrl: r[6],
    status: r[7],
    statusCode: OFFLINE_STATUS_TO_CODE[r[7]] != null ? OFFLINE_STATUS_TO_CODE[r[7]] : null,
  }));
  return { tasks, count: tasks.length, raw: output };
}

// ── share ───────────────────────────────────────────────

// 创建分享。password 可选（缺省为公开分享）；options.combined=true 时加 -f 输出
// "链接?pwd=密码" 合并格式。成功: { shareId, link, pwd, combined, raw }
function shareSet(remotePath, password, options = {}) {
  const args = ["share", "set"];
  if (password) args.push("-p", password);
  if (options.combined) args.push("-f");
  args.push(remotePath);
  const output = runPCS(args);
  // -f 合并格式: "shareID: 5, 链接: https://pan.baidu.com/s/x?pwd=abcd"
  let m = output.match(/shareID:\s*(\d+),\s*链接:\s*([^\s,]+?)\?pwd=([^\s,]*)/);
  if (m) return { shareId: Number(m[1]), link: m[2], pwd: m[3], combined: true, raw: output };
  // 普通格式: "shareID: 5, 链接: https://pan.baidu.com/s/x, 密码: abcd"（无密码时 密码 为空）
  m = output.match(/shareID:\s*(\d+),\s*链接:\s*([^\s,]+),\s*密码:\s*([^\s,]*)/);
  if (m) return { shareId: Number(m[1]), link: m[2], pwd: m[3], combined: false, raw: output };
  if (/创建分享链接失败/.test(output)) throw new Error(`创建分享失败: ${output.trim()}`);
  throw new Error(`创建分享失败: 无法解析输出\n${output.trim()}`);
}

// 取消分享。成功: { shareId, ok: true, raw }
function shareCancel(shareId) {
  const output = runPCS(["share", "cancel", String(shareId)]);
  if (/取消分享成功/.test(output)) return { shareId, ok: true, raw: output };
  const m = output.match(/取消分享失败:\s*(.*)/);
  throw new Error(`取消分享失败: ${m ? m[1].trim() : (output.trim() || "(无输出)")}`);
}

// 列出已分享文件/目录。输出为 pcstable 表格:
//   #  ShareID  分享链接  提取密码  特征目录  特征路径  过期时间  浏览次数
// 成功: { shares: [{ index, shareId, link, pwd, typicalDir, typicalPath, expireText, viewCount }], count, raw }
function shareList(page = 1) {
  const args = ["share", "list"];
  if (page && page !== 1) args.push(`--page=${page}`);
  let output;
  try {
    output = runPCS(args);
  } catch (e) {
    // BaiduPCS-Go v4.0.1 的 share list 存在引擎 bug（nil pointer panic，实测复现），
    // 无法从引擎侧修复，只列出友好的替代说明
    if (/panic|退出码/.test(e.message)) {
      throw new Error(
        `列出分享失败: BaiduPCS-Go v4.0.1 的 share list 存在引擎 bug（panic，实测复现）。\n` +
        `      处理: 用 bdp share cancel <shareId> 管理已知分享；或到 https://pan.baidu.com 网页端查看分享列表。`
      );
    }
    throw e;
  }
  const rows = parseTable(output, ["#", "ShareID", "分享链接", "提取密码", "特征目录", "特征路径", "过期时间", "浏览次数"]);
  if (rows === null) throw new Error(`列出分享失败: ${output.trim() || "(无输出)"}`);
  const shares = rows.map((r) => ({
    index: parseInt(r[0], 10),
    shareId: parseInt(r[1], 10),
    link: r[2],
    pwd: r[3] || "",
    typicalDir: r[4],
    typicalPath: r[5],
    expireText: r[6],
    viewCount: parseInt(r[7], 10) || 0,
  }));
  return { shares, count: shares.length, raw: output };
}

// ── 工具 ────────────────────────────────────────────────

// 东亚宽字符（CJK/全角等）显示宽度近似，对应 go-runewidth 的 East Asian Width W/F:
// 计 2 列，其余字符计 1 列。表头/数据行均按此规则渲染，切分即自洽。
const WIDE_CHAR_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function dispWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return w;
}

// 在 line 中取显示宽度 [startDisp, endDisp) 覆盖的码元区间
// （tablewriter 按显示宽对齐列，含 CJK 时各行列的码元偏移并不一致，
//   必须先换算成显示宽度再做切片）
function sliceByDisplay(line, startDisp, endDisp) {
  const len = line.length;
  const dispAt = new Array(len + 1);
  let d = 0;
  for (let i = 0; i < len; i++) {
    dispAt[i] = d;
    d += dispWidth(line[i]);
  }
  dispAt[len] = d;
  let s = len;
  let e = len;
  for (let i = 0; i <= len; i++) {
    if (s === len && dispAt[i] >= startDisp) s = i;
    if (dispAt[i] >= endDisp) {
      e = i;
      break;
    }
  }
  return line.slice(s, e);
}

// 解析 BaiduPCS-Go 的 pcstable 表格（tablewriter: 无边框、无列分隔符、列按显示宽对齐）。
// 原理: 表头与数据行在同一表格渲染下列起始显示偏移一致 → 用表头标题的显示位置切分每行。
// 表头找不到返回 null。
function parseTable(output, titles) {
  const lines = String(output).split(/\r?\n/).filter((l) => l.trim() !== "");
  const headerIdx = lines.findIndex((l) => titles.every((t) => l.includes(t)));
  if (headerIdx === -1) return null;
  const header = lines[headerIdx];
  const offsets = []; // 各列表头的显示宽度偏移
  let pos = 0;
  for (const t of titles) {
    const idx = header.indexOf(t, pos);
    if (idx === -1) return null;
    offsets.push(dispWidth(header.slice(0, idx)));
    pos = idx + t.length;
  }
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = [];
    for (let c = 0; c < titles.length; c++) {
      const start = offsets[c];
      const end = c + 1 < titles.length ? offsets[c + 1] : dispWidth(lines[i]);
      cells.push(sliceByDisplay(lines[i], start, end).trim());
    }
    rows.push(cells);
  }
  return rows;
}

// ── 回收站 ─────────────────────────────────────────────

// 列出回收站。成功: { items: [{ index, fsId, size(字节|null), createTime, modifyTime, remainDays, path }], count, raw }
// 注：FS ID 列（15 位数字）比表头宽，显示宽度切分会错位，改用正则解析
function recycleList(page = 1) {
  const args = ["recycle", "list"];
  if (page && page !== 1) args.push(`--page=${page}`);
  const output = runPCS(args);
  const items = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(?:([0-9a-f]{32})\s+)?(\d+|-)\s+(.+)$/);
    if (!m) continue;
    const sizeText = m[3];
    items.push({
      index: parseInt(m[1], 10),
      fsId: parseInt(m[2], 10),
      size: sizeText && sizeText !== "-" ? parseSizeText(sizeText) : null,
      createTime: m[4],
      modifyTime: m[6],
      md5: m[8] || "",
      remainDays: m[9] !== "-" ? parseInt(m[9], 10) : null,
      path: m[10].trim(),
    });
  }
  if (items.length === 0 && !/^\s*#/.test(output) && output.trim() === "") {
    throw new Error(`列出回收站失败: ${output.trim() || "(无输出)"}`);
  }
  return { items, count: items.length, raw: output };
}

// 还原回收站文件/目录。成功: { fsIds, ok: true, raw }
function recycleRestore(fsIds) {
  const output = runPCS(["recycle", "restore", ...fsIds.map(String)]);
  if (/还原成功|还原完成|成功/.test(output)) return { fsIds, ok: true, raw: output };
  throw new Error(`还原失败: ${output.trim() || "(无输出)"}`);
}

// 清空回收站（⚠️ 不可恢复）。成功: { ok: true, raw }
function recycleClean() {
  const output = runPCS(["recycle", "delete", "-all"]);
  if (/清空成功|成功|完成/.test(output)) return { ok: true, raw: output };
  throw new Error(`清空回收站失败: ${output.trim() || "(无输出)"}`);
}

module.exports = {
  mv, cp, quota,
  offlineAdd, offlineList,
  shareSet, shareCancel, shareList,
  recycleList, recycleRestore, recycleClean,
  parseSizeText, parseTable, OFFLINE_STATUS,
};
