// BaiduPCS-Go v4.0.1 transfers a whole personal share into its current
// remote working directory. Do not change that persisted directory implicitly.
const { runPCSResultAsync, detectEngineError } = require("./pan");

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
  // Despite the engine's help text, v4.0.1 unconditionally requires len(code)=4.
  if (typeof pwd !== "string" || !/^[A-Za-z0-9]{4}$/.test(pwd)) {
    throw new Error("BaiduPCS-Go v4.0.1 转存需要四位字母数字提取码；请提供 --pwd，无提取码分享暂不支持");
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
  const failure = output.match(/^分享链接转存到网盘失败:\s*([^\r\n]*)/m);
  const engineError = detectEngineError(output);
  if (failure || engineError) {
    const error = new Error("分享转存失败：" + (failure ? failure[1] : engineError.message));
    if (engineError && engineError.errno !== null) error.errno = engineError.errno;
    throw error;
  }
  if (!/^分享链接转存到网盘成功, 保存了[^\r\n]+到当前目录\s*$/m.test(output)) {
    throw new Error("分享转存失败：引擎未返回明确的转存成功结果，请检查引擎登录态和分享链接");
  }
  return { ...info, success: true, raw: output };
}

module.exports = { planTransfer, transferShare };
