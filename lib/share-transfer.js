// BaiduPCS-Go v4.0.1 transfers a whole personal share into its current
// remote working directory. Do not change that persisted directory implicitly.
const { runPCSResultAsync, detectEngineError } = require("./pan");

// 上游 BaiduPCS-Go v4.0.1（internal/pcscommand/transfer.go）的转存状态行：
//   失败 → "分享链接转存到网盘失败: <原因>"
//   成功 → "分享链接转存到网盘成功, 保存了<文件名>到当前目录"
// 逗号/冒号均为 ASCII 半角（已逐码点核对上游源码）。
// 成功行是 stdout 的**最后**一行：上游打印成功行后即结束（只有 --download
// 才会继续输出，本命令不启用该开关）。因此成功判定必须锚定到 stdout 末尾，
// 只匹配"任意一行"会把成功行前后的噪声误判为成功。
const TRANSFER_SUCCESS_RE = /分享链接转存到网盘成功, 保存了([\s\S]*)到当前目录$/;
// 失败原因可能被服务端塞进换行，只取第一行作为主因。
const TRANSFER_FAILURE_RE = /^分享链接转存到网盘失败:\s*([^\r\n]*)/m;

function planTransfer(shareUrl, password) {
  if (typeof shareUrl !== "string" || shareUrl.length > 2048 || /[\x00-\x20\x7f\\]/.test(shareUrl)) {
    throw new Error("分享链接必须是不含空白或控制字符的百度网盘 URL");
  }
  let url;
  try { url = new URL(shareUrl); } catch { throw new Error("分享链接必须是完整的百度网盘 URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "pan.baidu.com" ||
      url.port || url.username || url.password || url.hash) {
    throw new Error("仅支持 pan.baidu.com 的个人版完整分享链接，不支持企业版或文件选择片段");
  }
  let token;
  const short = url.pathname.match(/^\/s\/(1[A-Za-z0-9_-]{1,22})\/?$/);
  if (short) token = short[1];
  else if (url.pathname === "/share/init" && url.searchParams.getAll("surl").length === 1) {
    token = "1" + url.searchParams.get("surl");
  }
  if (!token || !/^1[A-Za-z0-9_-]{1,22}$/.test(token)) {
    throw new Error("分享链接格式无效：请使用 /s/1... 或 /share/init?surl=... 链接");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "pwd" && !(key === "surl" && !short)) {
      throw new Error("分享链接仅支持提取码参数，不支持子目录或文件选择参数");
    }
  }
  if (url.searchParams.getAll("pwd").length > 1) throw new Error("分享链接不能包含多个 pwd 参数");
  const pwd = password === undefined ? url.searchParams.get("pwd") : password;
  // 上游 v4.0.1 只校验提取码**长度**是否为 4（transfer.go: `len(extraCode) != 4`），
  // 并不校验字符集 —— 实测 `ab-d` 这类含符号的码同样能通过长度闸门。
  // 本命令额外收紧到 `[A-Za-z0-9]{4}`，属于 CLI 侧的**自加限制**：
  // 提取码会原样进入引擎 argv，限制字符集可避免空白/控制字符进入子进程参数。
  // 该限制比上游更严格，不等于"引擎要求字母数字"。
  if (typeof pwd !== "string" || !/^[A-Za-z0-9]{4}$/.test(pwd)) {
    throw new Error("提取码必须是四位字母数字（本 CLI 的安全限制；引擎本身只要求长度为 4）；请提供 --pwd，无提取码分享暂不支持");
  }
  return { url: `https://pan.baidu.com/s/${token}`, password: pwd };
}

async function transferShare(shareUrl, options = {}) {
  const plan = planTransfer(shareUrl, options.password);
  const info = { url: plan.url, destination: "engine-workdir", requiresLogin: true };
  if (options.dryRun === true) return { ...info, dryRun: true, requiresConfirmation: true };
  if (options.confirm !== true) throw new Error("分享转存会写入网盘，需要显式确认：请加 --yes");

  const result = await runPCSResultAsync(["transfer", plan.url, plan.password]);
  if (result.status !== 0) {
    throw new Error(`分享转存失败：BaiduPCS-Go 退出码 ${result.status === null ? "signal" : result.status}`);
  }
  const output = result.output || "";
  const verdict = classifyTransferOutput(output);
  if (!verdict.ok) {
    const error = new Error("分享转存失败：" + verdict.reason);
    if (verdict.errno !== null && verdict.errno !== undefined) error.errno = verdict.errno;
    throw error;
  }
  return { ...info, success: true, raw: output };
}

// 从引擎 stdout 判定转存结果。独立成函数以便在**所有平台**上直接测试
// （引擎调用路径需要可执行假引擎，在 Windows 上会被 skip）。
//
// 判定顺序：
//   1) 失败行（引擎失败时退出码仍为 0，只能靠正文）
//   2) 通用引擎错误
//   3) 成功行必须**锚定 stdout 末尾**
function classifyTransferOutput(output) {
  const text = String(output || "");
  // 失败行优先于成功行 —— 引擎可能在失败前打出含"成功"字样的噪声行。
  const failure = text.match(TRANSFER_FAILURE_RE);
  const engineError = detectEngineError(text);
  if (failure) return { ok: false, reason: failure[1] || "引擎未说明失败原因", errno: null };
  if (engineError) return { ok: false, reason: engineError.message, errno: engineError.errno };
  // 成功必须锚定 stdout 末尾：上游打印成功行后即结束。
  // 早期实现用 `/^…$/m` 逐行匹配，任何一行命中即算成功 ——
  // 于是"引擎在成功行之后又打印了别的内容"也会被当成成功。
  if (!TRANSFER_SUCCESS_RE.test(text.replace(/\s+$/, ""))) {
    return { ok: false, reason: "引擎未返回明确的转存成功结果，请检查引擎登录态和分享链接", errno: null };
  }
  return { ok: true, reason: "", errno: null };
}

module.exports = { planTransfer, transferShare, classifyTransferOutput };
