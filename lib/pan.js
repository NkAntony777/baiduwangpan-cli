const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const http = require("./http");
const { sanitizeControl } = require("./sanitize");
const { parseLsTable, parseSearchTable } = require("./table");
const { detectFileType } = require("./file-type");
// 引擎超时策略与 lib/pcs-extra.js 共用同一份（单一事实来源）
const { engineTimeoutMs, SLOW_ENGINE_COMMANDS } = require("./engine-timeout");

// child_process 延迟加载：测试可整体替换 require.cache["child_process"] 注入 mock
function childProc() {
  return require("child_process");
}

// BaiduPCS-Go 操作类命令出错时**退出码仍为 0**，错误只体现在输出文本里
// （"遇到错误, 远端服务器返回错误, 代码: N"）。不解析输出就会把失败当成功
// —— 实测 bdp ls/get/put 失败时退出码为 0，Agent 会把失败误判为成功。
const ENGINE_ERROR_RE = /遇到错误,\s*远端服务器返回错误,\s*代码:\s*(-?\d+),\s*消息:\s*([^\r\n]*)/;

// 从引擎输出里识别失败信号 → { errno, message, raw }；无失败信号返回 null
function detectEngineError(output) {
  if (!output) return null;
  const text = String(output);
  const m = text.match(ENGINE_ERROR_RE);
  if (m) {
    return { errno: parseInt(m[1], 10), message: m[2].trim(), raw: text.trim() };
  }
  if (/未检测到上传的文件/.test(text)) {
    return { errno: null, message: "引擎未检测到可上传的文件", raw: text.trim() };
  }
  if (/遍历错误/.test(text)) {
    return { errno: null, message: "引擎遍历本地文件出错", raw: text.trim() };
  }
  if (/操作失败, 以下文件\/目录删除失败/.test(text)) {
    return { errno: null, message: "引擎报告删除失败", raw: text.trim() };
  }
  if (/创建分享失败/.test(text)) {
    return { errno: null, message: "引擎报告分享创建失败", raw: text.trim() };
  }
  return null;
}

// 引擎输出上限 —— stdout 与 stderr **同上限**。
// 同步版 spawnSync 的 maxBuffer 对 stdout/stderr 都生效；异步版必须保持同样的对称性，
// 否则 stderr 就是一个无界的内存增长点（实测 60MB stderr 全保留，RSS +121MB）。
const ENGINE_MAX_BUFFER = 20 * 1024 * 1024;

// ── 引擎调用超时（v1.10.1 / T-02）────────────────────────────────
//
// 为什么必须有：异步 spawn 没有 timeout 时，引擎挂死 → Promise 永不 settle
// → lib/mcp.js 的并发闸门槽位**永不释放** → 4 个挂死即整个 MCP 服务器**永久不可用**
// （实测：1 个挂死后 6 个后续请求全部 pending，再发请求直接 BLOCKED）。
//
// 同步版 spawnSync 挂死的是整个进程，不留「占着槽位」的僵尸状态 ——
// 所以这是 v1.10.0 把 spawnSync 换成 spawn 之后引入的回归。
//
// 默认值：读操作 120s、写操作 600s。读操作实测 0.4–0.6s，120s 留了 200 倍余量。
// 超时错误：severity=retryable —— 引擎挂死是**环境问题**，不是「永久失败」，
// Agent 退避后重试是有意义的（否则它会把一次网络抖动当成不可恢复的结论）。
function engineTimeoutError(timeoutMs, args) {
  const cmd = args && args[0] ? String(args[0]) : "";
  // 提示必须指向**当前生效的那个**变量 —— 写操作走的是 SLOW 档，
  // 让用户去调另一个变量对它是完全无效的。
  const envVar = SLOW_ENGINE_COMMANDS.has(cmd)
    ? "BDP_ENGINE_TIMEOUT_SLOW_MS"
    : "BDP_ENGINE_TIMEOUT_MS";
  const e = new Error(
    `引擎调用超时（${Math.round(timeoutMs / 1000)}s）：${cmd || "?"} 没有在时限内返回，已终止该进程。` +
      `请缩小操作范围后重试，或用环境变量 ${envVar} 调整时限。`
  );
  e.errno = null;
  e.timeout = true;
  e.retryable = true;
  e.action =
    "引擎超时属于可重试的暂时性失败：请缩小目录范围/分页读取后重试；若持续超时，请检查 BaiduPCS-Go 引擎与网络连通性。";
  return e;
}

// 输出超限错误（v1.10.1 / T-01）
//
// 为什么必须是**错误**而不是「空成功」：
//   超限时 stdout 被丢弃，若上层拿到空串 + isError:false，Agent 会得出
//   「这个目录是空的」这个**确定性错误结论** —— 而且无从察觉。
//   同步版 spawnSync 超 maxBuffer 会抛 ENOBUFS（会报错）；
//   异步版曾静默返回空 —— 两条路径必须一致。
function engineTruncationError(channel) {
  const what = channel === "stderr" ? "stderr" : "stdout";
  const e = new Error(
    `引擎 ${what} 输出超过 20MB 上限，已丢弃；请缩小目录范围（分页/限定子目录），或改用 --json-file 分页读取。`
  );
  e.errno = null;
  e.truncated = true;
  e.retryable = false;
  e.action = "缩小查询范围后重试（限定子目录或分页读取）；本次引擎输出已超过 20MB 被丢弃，结果不完整。";
  return e;
}

// 执行引擎并拿到退出码。
// 注意：BaiduPCS-Go 的操作类命令出错时退出码仍是 0（实测 rm 失败时退出码 = 0），
// 所以退出码只能识别「引擎根本没跑起来」，成败判定必须以输出文本为准。
function runPCSResult(args) {
  const cfg = config.get();
  const { spawnSync } = childProc();
  const timeout = engineTimeoutMs(args);
  const result = spawnSync(cfg.pcsPath, args, {
    encoding: "utf-8",
    maxBuffer: ENGINE_MAX_BUFFER,
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    // 超时：spawnSync 会 kill 子进程，error.code = ETIMEDOUT
    if (result.error.code === "ETIMEDOUT") {
      throw engineTimeoutError(timeout, args);
    }
    // 输出超过 maxBuffer：error.code = ENOBUFS —— 这是「输出过大」而不是「引擎不存在」，
    // 两者必须区分，否则会把输出超限误报成「可执行文件找不到」。
    if (result.error.code === "ENOBUFS") {
      // ⚠️ Node 的 spawnSync 对 stdout / stderr 超限**一律**返回 ENOBUFS，
      // message 里**不含通道信息**（实测两者都是 errorCode=ENOBUFS）。
      // 只能靠「已收回多少字节」反推是哪个通道超了 —— 否则同步版永远说 stdout，
      // 与异步版的结论不一致（异步版能分别报 stdout / stderr）。
      const outBytes = Buffer.byteLength(result.stdout || "");
      const errBytes = Buffer.byteLength(result.stderr || "");
      throw engineTruncationError(errBytes > outBytes ? "stderr" : "stdout");
    }
    throw new Error(`未找到 BaiduPCS-Go 可执行文件: ${cfg.pcsPath}。请在 config 中设置 pcsPath，或设置环境变量 BAIDUPCS_CMD。`);
  }
  return {
    output: result.stdout || "",
    status: result.status === undefined ? null : result.status,
    stderr: result.stderr || "",
  };
}

// 异步版引擎执行：**spawn 而不是 spawnSync** —— 不冻结事件循环。
//
// 为什么必须有：spawnSync 会把整个 Node 进程卡住。实测引擎一次 `ls /` 耗时 594ms，
// 期间 setInterval(5ms) **一次都没能触发** —— 事件循环被完整冻结。
// MCP 服务器是单进程跑所有工具调用的，一旦某次调用走了引擎路径，
// **所有并发请求全部排队**：实测 8 个并发 bdp_ls 耗时 4047ms，而串行 8 次是 3488ms
// —— 并发比串行还慢，加速比 1.0×（等于没有并发）。
//
// 改成 spawn 后引擎进程各自独立并行跑，stdout/stderr 逐字节不变，
// 因此 `bdp ls` 的人类可读输出（直接打印引擎原文）也完全不变。
function runPCSResultAsync(args, options = {}) {
  const cfg = config.get();
  const { spawn } = childProc();
  const timeoutMs = options.timeoutMs || engineTimeoutMs(args);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    // settle 只生效一次，并负责清定时器
    // （**必须清**，否则定时器挂着会拖住进程退出）
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fn(value);
    };
    try {
      child = spawn(cfg.pcsPath, args, { windowsHide: true });
    } catch (e) {
      settle(
        reject,
        new Error(
          `未找到 BaiduPCS-Go 可执行文件: ${cfg.pcsPath}。请在 config 中设置 pcsPath，或设置环境变量 BAIDUPCS_CMD。`
        )
      );
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let truncatedStdout = false;
    let truncatedStderr = false;
    // stdout 与 stderr **同上限**（同步版 spawnSync 的 maxBuffer 对两者都生效）
    child.stdout.on("data", (d) => {
      if (truncatedStdout) return;
      outLen += d.length;
      if (outLen > ENGINE_MAX_BUFFER) {
        truncatedStdout = true;
        // 已收的部分也丢掉 —— 半个输出比没有更容易误导上层
        outChunks.length = 0;
        return;
      }
      outChunks.push(d);
    });
    child.stderr.on("data", (d) => {
      if (truncatedStderr) return;
      errLen += d.length;
      if (errLen > ENGINE_MAX_BUFFER) {
        truncatedStderr = true;
        errChunks.length = 0;
        return;
      }
      errChunks.push(d);
    });
    // 超时兜底：引擎挂死时 kill 子进程并 reject。
    // 不 kill 的话子进程会一直活着，且 Promise 永不 settle（闸门槽位也就永不释放）。
    timer = setTimeout(() => {
      try {
        if (typeof child.kill === "function") child.kill("SIGKILL");
      } catch {
        // kill 失败也必须继续 reject —— 绝不能把 Promise 留成 pending
      }
      settle(reject, engineTimeoutError(timeoutMs, args));
    }, timeoutMs);
    child.on("error", () => {
      settle(reject, new Error(
        `未找到 BaiduPCS-Go 可执行文件: ${cfg.pcsPath}。请在 config 中设置 pcsPath，或设置环境变量 BAIDUPCS_CMD。`
      ));
    });
    child.on("close", (code) => {
      settle(resolve, {
        output: Buffer.concat(outChunks).toString("utf-8"),
        status: code === null ? null : code,
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        truncated: truncatedStdout || truncatedStderr,
        truncatedStdout,
        truncatedStderr,
      });
    });
  });
}

// 异步版 runPCS：失败判定语义与同步版**完全一致**（成功与否只看输出文本，不看退出码）
async function runPCSAsync(args, options = {}) {
  const r = await runPCSResultAsync(args, options);
  // 输出超限 → **明确错误**（v1.10.1 / T-01）
  //
  // 绝不能把「被丢弃的输出」当成「空结果」返回：上层会据此得出
  // 「这个目录是空的」这个**确定性错误结论**，而 isError 仍是 false —— 无从察觉。
  //
  // 这个 throw 发生在解析之前，所以不会被下面「解析不到条目」的分支吞掉。
  if (r.truncatedStdout) throw engineTruncationError("stdout");
  if (r.truncatedStderr) throw engineTruncationError("stderr");
  const output = r.output;
  if (options.check) {
    const err = detectEngineError(output);
    if (err) {
      const e = new Error(err.message);
      if (err.errno !== null) e.errno = err.errno;
      e.engineRaw = err.raw;
      throw e;
    }
  }
  if (options.checkExit && r.status !== null && r.status !== 0) {
    const e = new Error(
      `BaiduPCS-Go ${args[0] || ""} 退出码 ${r.status}: ` +
      (output.trim() || r.stderr.trim() || "(无输出)")
    );
    e.exitCode = r.status;
    e.engineRaw = output;
    throw e;
  }
  return output;
}

// options.check=true：检测到引擎失败信号就抛错（错误对象带 errno 字段）
// options.checkExit=true：引擎退出码非 0 也算失败
function runPCS(args, options = {}) {
  const r = runPCSResult(args);
  const output = r.output;
  if (options.check) {
    const err = detectEngineError(output);
    if (err) {
      const e = new Error(err.message);
      if (err.errno !== null) e.errno = err.errno;
      e.engineRaw = err.raw;
      throw e;
    }
  }
  if (options.checkExit && r.status !== null && r.status !== 0) {
    const e = new Error(
      `BaiduPCS-Go ${args[0] || ""} 退出码 ${r.status}: ` +
      (output.trim() || r.stderr.trim() || "(无输出)")
    );
    e.exitCode = r.status;
    e.engineRaw = output;
    throw e;
  }
  return output;
}

function getDlink(remotePath) {
  const output = runPCS(["locate", remotePath]);
  const urls = output.match(/https?:\/\/[^\s]+/g);
  if (urls && urls.length > 0) {
    return urls[0].replace(/[,\s]+$/, "");
  }
  return null;
}

// 通过 web 前端同款 /api/list 获取文件元信息（size/md5/isdir/ctime 一次拿全）。
// 实测 (2026-08): /api/filemetas 与 xpan filemetas 均返回 errno=2 不可用，
// 而 /api/list（父目录列表 + bdstoken）可用，md5 与 dlink URL 前缀一致，比
// BaiduPCS-Go meta 文本输出（"md5 (可能不正确)"）更可靠。
// 失败（未登录/接口异常/文件不在前 2000 条）返回 null，由调用方回退文本解析。
// /api/list 分页大小。服务端实测按 num 返回（num=500 时该目录返回 20 条、page2 为空），
// 延迟随实际返回条数走。⚠️ page 与 num 耦合（偏移 =(page−1)×num）：
// 同一处分页的「请求 num」与「翻页结束判断」必须用同一个值，否则会静默跳条目。
const API_LIST_PAGE_SIZE = (http && http.API_LIST_PAGE_SIZE) || 500;

async function getFileMetaWeb(remotePath) {
  const bdstoken = await http.getBdstoken();
  const trimmed = remotePath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const parent = idx <= 0 ? "/" : trimmed.slice(0, idx);
  const base = idx === -1 ? trimmed : trimmed.slice(idx + 1);

  for (let page = 1; page <= 20; page++) {
    const url =
      `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1` +
      `&page=${page}&num=${API_LIST_PAGE_SIZE}&dir=${encodeURIComponent(parent)}` +
      `&channel=chunlei&app_id=${http.APP_ID}&bdstoken=${encodeURIComponent(bdstoken)}`;
    const data = await http.webJson(url);
    if (!data || data.errno !== 0 || !Array.isArray(data.list)) return null;
    const item = data.list.find((f) => f.server_filename === base);
    if (item) {
      return {
        size: typeof item.size === "number" ? item.size : parseInt(item.size, 10) || null,
        md5: item.md5 || null,
        isDir: item.isdir === 1 || item.isdir === "1",
        serverCtime: item.server_ctime != null ? item.server_ctime : null,
        localCtime: item.local_ctime != null ? item.local_ctime : null,
      };
    }
    if (data.list.length < API_LIST_PAGE_SIZE) return null; // 翻页结束仍未找到
  }
  return null;
}

function getFileMeta(remotePath) {
  const output = runPCS(["meta", remotePath]);
  let size = null;

  // BaiduPCS-Go v4.0.1 实测输出: "文件大小          7297727, 6.959655MB"
  // （首个数字为精确字节数；旧正则要求 "大小:" 冒号，实际是空格，永远匹配不到）
  let m = output.match(/文件大小\s*[:：]?\s*(\d[\d,]*)/);
  if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  if (!size) {
    m = output.match(/size[":\s]+(\d+)/i);
    if (m) size = parseInt(m[1], 10);
  }
  if (!size) {
    m = output.match(/(\d[\d,]*)\s*B\b/);
    if (m) size = parseInt(m[1].replace(/,/g, ""), 10);
  }

  // md5（BaiduPCS-Go meta 输出 "md5 (可能不正确)  xxxx"，仅作文本回退参考）
  let md5 = null;
  m = output.match(/md5[^0-9a-fA-F]*([0-9a-fA-F]{32})/);
  if (m) md5 = m[1].toLowerCase();

  // 只看 "类型" 行，避免文件名含"目录"字样时误判（旧正则 /目录/ 会误伤）
  const isDir = /类型\s*[:：]?\s*目录/.test(output) || /isdir.*1|is_dir.*true/i.test(output);

  return { size, isDir, md5, raw: output };
}

function fetchRangeText(url, start, end) {
  const cfg = config.get();
  const buf = http.curlRange(url, start, end, cfg.ua);
  return decodeText(buf);
}

function fetchRangeBuf(url, start, end) {
  const cfg = config.get();
  return http.curlRange(url, start, end, cfg.ua);
}

// ── 编码检测 ──────────────────────────────────────────────
//
// 背景：用户的网盘里有大量 GB2312/GBK 编码的中文古籍 TXT。
// 旧实现用 Buffer.toString("utf-8") 逐个编码尝试 —— 但 toString("utf-8")
// 遇到非法字节**永不抛错**（替换成 U+FFFD），所以 gbk/gb2312 分支永远走不到，
// 结果是 75% 字符变乱码，且 grep 在这类文件上静默返回空（比乱码更糟）。
//
// 修正方案：
//   1) UTF-8 用 TextDecoder(fatal:true) 严格检测 —— 非法字节序列会抛错，可靠。
//   2) GBK / Big5 **不能用 fatal**：Node 的 "gbk" 实际是 gb18030，其 4 字节
//      序列规则会把合法 GBK 中文误判为非法（实测"台湾土地制度考查报告书"整篇
//      在 fatal 模式下抛错）。改用"替换字符比例"择优：分别宽松解码，取 U+FFFD
//      最少的那个。
//   3) 都没有明显更优解时，回退宽松 UTF-8。
//
// Node 13+ 官方二进制自带 full-icu，gbk/big5 标签开箱可用，无需额外依赖。

let UTF8_STRICT = null;
try {
  UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
} catch {
  UTF8_STRICT = null;
}

const CANDIDATE_ENCODINGS = ["gbk", "big5"]
  .map((label) => {
    try {
      return { label, decoder: new TextDecoder(label) };
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// U+FFFD（替换字符）占比 —— 用来评估某种编码解码结果的"无损程度"
function replacementRatio(text) {
  if (!text || !text.length) return 0;
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad / text.length;
}

// 解码为文本；返回 { text, encoding }
/**
 * 裁掉缓冲区末尾可能不完整的多字节字符。
 * Range 读取会在任意字节位置截断，GBK/Big5 的汉字占 2 字节、
 * UTF-8 的中文占 3 字节、emoji 占 4 字节 —— 截断点落在字符中间时，
 * 解码会产生一个 U+FFFD 替换字符，还可能把整个文件的编码判定带偏。
 * 策略：从末尾最多回退 3 字节，找到最后一个合法的字符边界。
 * @param {Buffer} buf
 * @returns {Buffer} 裁剪后的缓冲
 */
/**
 * 裁掉缓冲区末尾可能不完整的多字节字符。
 * Range 读取会在任意字节位置截断，GBK/Big5 的汉字占 2 字节、
 * UTF-8 的中文占 3 字节、emoji 占 4 字节 —— 截断点落在字符中间时，
 * 解码会产生 U+FFFD 替换字符，还可能把整个文件的编码判定带偏。
 *
 * 策略：看最后一个字节是否为 UTF-8 续字节(10xxxxxx)。
 *   - 是 → 该字符被截断，回退到它的起始字节之前
 *   - 否 → 末尾是完整的单字节字符，不动
 * GBK/Big5 的双字节字符：若末尾是 0x80-0xFE 的高位字节，
 * 它后面没有跟上来，同样视为被截断。
 * @param {Buffer} buf
 * @returns {Buffer} 裁剪后的缓冲
 */
/**
 * 裁掉缓冲区末尾可能不完整的多字节字符。
 * Range 读取会在任意字节位置截断，截断点落在字符中间时，
 * 解码会产生 U+FFFD 替换字符，还可能把整个文件的编码判定带偏。
 *
 * 关键：GBK/Big5 是**定长双字节**（每字节都可能是字的首/次字节），
 * 不能像 UTF-8 那样靠续字节判断边界。
 * 正确做法：先试严格 UTF-8；不是合法 UTF-8 时，
 * 若字节数为奇数 → 末尾必然是半个双字节字符，裁掉 1 字节。
 * @param {Buffer} buf
 * @returns {Buffer} 裁剪后的缓冲
 */
function trimTrailingPartialChar(buf) {
  if (!buf || buf.length < 2) return buf;

  // 1) 合法 UTF-8 → 不动（UTF-8 的字符边界由续字节规则自洽，无需裁剪）
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return buf;
  } catch {
    // 不是合法 UTF-8，继续
  }

  // 1.5) UTF-8 末尾被截断的多字节序列 → 按 UTF-8 规则裁掉不完整的尾巴。
  //      这一步**必须**在 GBK 分支之前：中文 UTF-8 文件按字节数截断时，末尾常落在
  //      3 字节字符中间，而此时总字节数**可能是偶数** —— 只按奇偶判断会直接掉进
  //      下面的 GBK 分支被误判成 GBK，结果是中文乱码、grep 中文静默返回空
  //      （正是 v1.7.0 声称已修复、v1.8.4 又复现的症状）。
  const trimmedUtf8 = trimIncompleteUtf8Tail(buf);
  if (trimmedUtf8) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(trimmedUtf8);
      return trimmedUtf8;
    } catch {
      // 裁完仍不是合法 UTF-8 → 说明本来就不是 UTF-8，继续下面的分支
    }
  }

  // 2) 非 UTF-8 → 按 GBK/Big5 定长双字节处理
  //    奇数长度 = 末尾是半个字符
  if (buf.length % 2 === 1) {
    const trimmed = buf.slice(0, buf.length - 1);
    // 裁掉后若能按 GBK 严格解码，说明确实裁对了
    try {
      new TextDecoder('gbk', { fatal: true }).decode(trimmed);
      return trimmed;
    } catch {
      // 裁掉后仍不合法 → 原样返回，交给上层编码判定
      return buf;
    }
  }

  // 3) 偶数长度：GBK 双字节是定长，长度正确；但可能是 Big5 或别的编码 → 原样返回
  return buf;
}

/**
 * 裁掉 UTF-8 末尾被截断的不完整多字节序列。
 * 不是「被截断的 UTF-8」时返回 null。
 * 调用方必须再用严格 UTF-8 解码校验一遍 —— 裁错也能被兜住。
 */
function trimIncompleteUtf8Tail(buf) {
  // 从末尾往前扫：连续的续字节（10xxxxxx）最多 3 个
  let cont = 0;
  while (cont < 3 && cont < buf.length) {
    const b = buf[buf.length - 1 - cont];
    if ((b & 0xc0) !== 0x80) break;
    cont++;
  }
  // 末尾可能只剩起始字节（cont=0），也可能是「起始字节 + 若干续字节」
  const startIdx = buf.length - 1 - cont;
  if (startIdx < 0) return null; // 整段都是续字节 → 判不了，交给上层
  const lead = buf[startIdx];
  let need = 0;
  if ((lead & 0x80) === 0x00) return null;
  else if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return null; // 非法起始字节
  const have = cont + 1; // 含起始字节
  if (have >= need) return null; // 序列本身是完整的 → 不是尾部截断
  return buf.slice(0, startIdx);
}



function decodeTextWithEncoding(buf) {
  if (typeof buf === "string") return { text: buf, encoding: "utf-8" };
  buf = trimTrailingPartialChar(buf);
  if (!buf || buf.length === 0) return { text: "", encoding: "utf-8" };

  // 1) 严格 UTF-8
  if (UTF8_STRICT) {
    try {
      return { text: UTF8_STRICT.decode(buf), encoding: "utf-8" };
    } catch {
      // 不是合法 UTF-8，继续试其他编码
    }
  }

  // 2) GBK / Big5 —— 取替换字符最少的
  let best = null;
  for (const { label, decoder } of CANDIDATE_ENCODINGS) {
    const text = decoder.decode(buf);
    const ratio = replacementRatio(text);
    if (!best || ratio < best.ratio) best = { label, text, ratio };
    if (ratio === 0) break; // 完全无损，直接采用
  }
  // 阈值 5%：超过则认为该编码也不匹配，回退宽松 UTF-8
  if (best && best.ratio < 0.05) return { text: best.text, encoding: best.label };

  // 3) 兜底
  return { text: buf.toString("utf-8"), encoding: "utf-8" };
}

// 解码为文本（只关心内容，不关心编码）
function decodeText(buf) {
  return decodeTextWithEncoding(buf).text;
}

// ── Pan Operations ─────────────────────────────────────

// 走**异步**引擎（不冻结事件循环）—— 见 runPCSResultAsync 的说明。
// 这两个是 MCP 侧最热的读路径（bdp_ls / bdp_search），同步版会让并发完全失效。
async function ls(dirPath = "/") {
  return runPCSAsync(["ls", dirPath]);
}

async function search(keyword, searchPath = "/") {
  return runPCSAsync(["search", "-path=" + searchPath, "-r", keyword]);
}

// 净化网盘返回的文件名/路径：剔除终端控制字符与方向控制符（RLO 可伪装扩展名）。
// 放在**数据源头**统一处理 —— 此前只有人读通道净化，CLI 的 --json 通道完全没做，
// 两条通道对同一份数据的处理不一致。
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return e;
  const out = Object.assign({}, e);
  if (typeof out.name === "string") out.name = sanitizeControl(out.name);
  if (typeof out.path === "string") out.path = sanitizeControl(out.path);
  return out;
}

// 列出目录（结构化）。
// 引擎输出是定宽中文表格（tablewriter，按显示宽对齐），解析成 entries[]。
// 若解析不到任何条目且检测到引擎失败信号 → 抛错；否则"目录不存在"会被当成
// "空目录"返回且退出码仍是 0（静默失败，Agent 会误判）。
// 返回: { path, entries[], totalText, fileCount, dirCount, raw, warning }
async function lsEntries(dirPath = "/") {
  const raw = await ls(dirPath);
  const parsed = parseLsTable(raw, dirPath) || { entries: [], totalText: null, fileCount: null, dirCount: null };
  const err = detectEngineError(raw);
  if (err && parsed.entries.length === 0) {
    const e = new Error(err.message);
    if (err.errno !== null) e.errno = err.errno;
    e.engineRaw = err.raw;
    throw e;
  }
  return {
    path: dirPath,
    entries: parsed.entries.map(sanitizeEntry),
    totalText: parsed.totalText,
    fileCount: parsed.fileCount,
    dirCount: parsed.dirCount,
    raw,
    warning: err ? err.message : null,
  };
}

// 全盘搜索（结构化 + 客户端模式过滤）。
// mode: "substring"(默认) | "regex" | "glob" | "any" | "exact"
// engineKeyword: 模式搜索时引擎实际使用的字面片段（见 bdp.js 的 firstLiteralRun）
async function searchEntries(keyword, searchPath = "/", options = {}) {
  const mode = options.mode || "substring";
  const engineKeyword = options.engineKeyword || keyword;
  const raw = await search(engineKeyword, searchPath);
  const parsed = parseSearchTable(raw) || { entries: [], totalText: null, fileCount: null, dirCount: null };
  const err = detectEngineError(raw);
  if (err && parsed.entries.length === 0) {
    const e = new Error(err.message);
    if (err.errno !== null) e.errno = err.errno;
    e.engineRaw = err.raw;
    throw e;
  }
  let entries = parsed.entries.map(sanitizeEntry);
  if (mode !== "substring") {
    const { matchesName } = require("./name-match");
    entries = entries.filter((en) => {
      if (mode === "glob") {
        return matchesName(keyword, en.path, { mode }) || matchesName(keyword, en.name, { mode });
      }
      return matchesName(keyword, en.path, { mode });
    });
  }
  return {
    keyword,
    engineKeyword,
    path: searchPath,
    mode,
    entries,
    total: parsed.entries.length,
    matched: entries.length,
    totalText: parsed.totalText,
    fileCount: parsed.fileCount,
    dirCount: parsed.dirCount,
    raw,
    warning: err ? err.message : null,
  };
}

// 二进制文件拒绝按文本读取/搜索：
// 否则会把乱码灌进 Agent 上下文，且 grep 在二进制上匹配到的全是噪声。
function assertTextFile(buf, remotePath) {
  const ft = detectFileType(buf, remotePath);
  if (ft.binary) {
    throw new Error(
      "文件是二进制内容（" + ft.type + "，" + ft.reason + "），无法按文本读取/搜索。\n" +
      "处理: 用 bdp get " + remotePath + " 下载到本地后处理；或用 bdp peek " + remotePath + " 查看元信息。"
    );
  }
  return ft;
}

function cat(remotePath, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const meta = getFileMeta(remotePath);

  if (meta.size && meta.size > 50 * 1024 * 1024) {
    process.stderr.write("[WARN] File is " + (meta.size / 1024 / 1024).toFixed(1) + "MB, truncating to " + (limit / 1024).toFixed(0) + "KB\n");
  }

  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error("无法获取 " + remotePath + " 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。");

  const readBytes = Math.min(meta.size || limit, limit) - 1;
  const buf = fetchRangeBuf(dlink, 0, readBytes);
  assertTextFile(buf, remotePath);
  return decodeText(buf);
}

function head(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error("无法获取 " + remotePath + " 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。");

  const chunkSize = Math.min(n * 4096 + 1024, limit);
  const buf = fetchRangeBuf(dlink, 0, chunkSize - 1);
  assertTextFile(buf, remotePath);
  return decodeText(buf).split("\n").slice(0, n);
}

function tail(remotePath, n = 20, maxBytes) {
  const cfg = config.get();
  const limit = maxBytes || cfg.maxBytes;
  const meta = getFileMeta(remotePath);
  if (!meta.size) throw new Error("无法获取 " + remotePath + " 的文件大小。");

  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error("无法获取 " + remotePath + " 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。");

  const chunkSize = Math.min(n * 4096 + 1024, limit, meta.size);
  const start = Math.max(0, meta.size - chunkSize);
  const buf = fetchRangeBuf(dlink, start, meta.size - 1);
  assertTextFile(buf, remotePath);
  return decodeText(buf).split("\n").slice(-n);
}

function grep(pattern, remotePath, options = {}) {
  const cfg = config.get();
  const dlink = getDlink(remotePath);
  if (!dlink) throw new Error("无法获取 " + remotePath + " 的下载链接（dlink）。文件可能已删除/移动，或该路径不支持直链下载。");

  const buf = fetchRangeBuf(dlink, 0, cfg.maxBytes - 1);
  assertTextFile(buf, remotePath);
  const text = decodeText(buf);

  let regex;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "gi" : "g");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.ignoreCase ? "gi" : "g");
  }

  const matches = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (regex.test(line)) {
      matches.push({ line: i + 1, content: line });
    }
    regex.lastIndex = 0;
  });
  return matches;
}

async function peek(remotePath) {
  // web 元信息优先（含权威 md5/ctime），失败回退 meta 文本解析
  let webMeta = null;
  try {
    webMeta = await getFileMetaWeb(remotePath);
  } catch {}
  const meta = webMeta || getFileMeta(remotePath);
  const dlink = getDlink(remotePath);

  const result = {
    path: remotePath,
    size: meta.size,
    isDir: meta.isDir,
    dlink: !!dlink,
  };

  if (webMeta) {
    if (webMeta.md5) result.md5 = webMeta.md5;
    if (webMeta.serverCtime) result.serverCtime = webMeta.serverCtime;
    if (webMeta.localCtime) result.localCtime = webMeta.localCtime;
  }

  if (dlink && !meta.isDir) {
    const previewBytes = Math.min(512, meta.size || 512) - 1;
    const buf = fetchRangeBuf(dlink, 0, previewBytes);

    // 用魔数 + NUL 字节判定类型（旧的"控制字符"启发式会把 PDF 误判成 text）
    const ft = detectFileType(buf, remotePath);
    result.type = ft.type;
    result.binary = ft.binary;
    result.detectReason = ft.reason;
    if (!ft.binary) {
      const dec = decodeTextWithEncoding(buf);
      result.encoding = dec.encoding;
      result.preview = dec.text.split("\n").slice(0, 10);
    }
  }

  return result;
}

// ── 下载 ────────────────────────────────────────────────
//
// v1.2.0 起 bdp get 不再裸跑 BaiduPCS-Go（其 download 无断点续传，且自动跳过
// 重名文件导致中断后无法续）。改为：
//   filemetas 元信息（/api/list）→ locate dlink → curl 直链分块下载
// 分块原因（实测 2026-08）：部分 CDN 节点（*ct11.baidupcs.com）拒绝无界请求
// （HTTP 403, error_code 31326, hitcode 104），只允许 ≤~5MB 的有界 Range。
// 4MB 分块 + 每块失败换新 dlink 重试，同时天然支持断点续传与坏主机规避。
// 目录或无 dlink 的边界场景仍回退 BaiduPCS-Go 引擎（无校验/续传，保持原行为）。
//
// options: { resume, force, progress, verifySize }
//   硬校验：size 对比 + 0 字节检测（默认全开，失败保留文件供排查）
//   软校验：md5（百度 /api/list 的 md5 是混淆值，仅本地计算+标注，不阻断）

const DOWNLOAD_CHUNK = 4 * 1024 * 1024; // 4MB/块（CT11 节点 range 上限约 5MB）
const DEFAULT_CONCURRENCY = 3; // 并发分块路数（绕开单连接限速；仅大文件启用）
const CONCURRENT_THRESHOLD = 32 * 1024 * 1024; // 剩余 >32MB 才启用并发（小文件串行开销更小）

async function download(remotePath, saveTo, options = {}) {
  const cfg = config.get();
  const opts = { resume: false, force: false, progress: false, verifySize: true, dryRun: false, concurrency: DEFAULT_CONCURRENCY, ...options };

  // 1) 元信息：web /api/list 优先（size 权威）→ 失败回退 meta 文本解析。
  //    注：API 的 md5 为混淆键（非内容哈希，实测含非 hex 字符），仅作参考不参与硬校验
  let webMeta = null;
  try {
    webMeta = await getFileMetaWeb(remotePath);
  } catch {}
  const meta = webMeta || getFileMeta(remotePath);
  const remoteMd5 = webMeta ? webMeta.md5 || null : null;

  // 2) dlink（locate 每次返回新链接；分块失败时自动换新，规避过期/坏节点）
  const dlink = getDlink(remotePath);
  let dlinkExpiry = null;
  if (dlink) {
    const sizeInDlink = dlink.match(/[?&]size=(\d+)/);
    if (sizeInDlink && !meta.size) meta.size = parseInt(sizeInDlink[1], 10);
    const exp = dlink.match(/[?&]expires=([^&]+)/);
    if (exp) dlinkExpiry = exp[1];
  }

  // 3) 本地目标路径 + --dry-run 预演
  //    ⚠️ 这一段必须在「目录/无 dlink → 回退引擎」**之前**：
  //    引擎的 `d` 命令是**真实下载**。若 dryRun 检查排在它之后，
  //    `bdp get <目录> --dry-run` 会把整个目录真的拉下来（实测 47MB）。
  const baseName = path.basename(remotePath.replace(/[\\/]+$/, ""));
  const localPath = saveTo ? path.join(saveTo, baseName) : path.join(process.cwd(), baseName);

  // 已有文件决策
  let existingSize = null;
  try {
    existingSize = fs.statSync(localPath).size;
  } catch {}

  // --dry-run：不落盘、不创建目录、不请求下载，仅报告将执行的动作
  if (opts.dryRun) {
    let action = "download";
    if (existingSize !== null && !opts.force) {
      if (meta.size != null && existingSize === meta.size) action = "skip";
      else if (meta.size != null && existingSize > meta.size) action = "overwrite";
      else action = "resume";
    }
    const out = {
      path: remotePath,
      dryRun: true,
      engine: "dry-run",
      action,
      size: meta.size,
      localPath,
      existingSize,
      dlinkExpiry,
    };
    if (meta && meta.isDir) {
      out.warning = "目录下载将走 BaiduPCS-Go 引擎（无校验/断点续传）";
    }
    return out;
  }

  // 4) 目录或无 dlink → 回退 BaiduPCS-Go 引擎
  if ((meta && meta.isDir) || !dlink) {
    const args = ["d", remotePath];
    if (saveTo) args.push("--saveto", saveTo);
    const raw = runPCS(args);
    const err = detectEngineError(raw);
    if (err) {
      const e = new Error(err.message);
      if (err.errno !== null) e.errno = err.errno;
      e.engineRaw = err.raw;
      throw e;
    }
    // 引擎"下载成功"但 0 字节：远端文件其实不存在/无权限（引擎退出码仍是 0）
    if (meta && meta.size > 0 && /数据总量:\s*0B/.test(raw)) {
      throw new Error("下载失败: 引擎返回 0 字节，但远端文件应为 " + meta.size + " 字节（" + remotePath + " 可能不存在或无访问权限）");
    }
    return {
      path: remotePath,
      engine: "pcs",
      raw,
      warning: meta && meta.isDir
        ? "目录下载走 BaiduPCS-Go 引擎（无校验/断点续传）"
        : "获取 dlink 失败，走 BaiduPCS-Go 引擎",
    };
  }

  if (saveTo) fs.mkdirSync(saveTo, { recursive: true });

  if (!opts.force && existingSize !== null) {
    if (meta.size != null && existingSize === meta.size) {
      return verifyAndBuild(remotePath, localPath, existingSize, remoteMd5, dlinkExpiry, {
        skipped: true, resumed: false,
      });
    }
    if (meta.size != null && existingSize > meta.size) {
      throw new Error(
        `本地文件大于远端: 本地 ${existingSize} 字节 > 远端 ${meta.size} 字节\n` +
        `      已保留: ${localPath}\n      处理: --force 覆盖重下`
      );
    }
    if (existingSize < (meta.size != null ? meta.size : Infinity)) {
      if (!opts.resume) {
        process.stderr.write(
          `[auto-resume] 检测到部分文件 ${existingSize}/${meta.size != null ? meta.size : "?"} 字节，自动断点续传（--force 可强制重下）\n`
        );
      }
      opts.resume = true;
    }
  }

  // --force：分块下载是追加写，必须先清掉旧文件
  if (opts.force && existingSize !== null) {
    fs.unlinkSync(localPath);
    existingSize = null;
  }

  // 6) 分块下载（有界 Range，天然续传）
  const startedAt = Date.now();
  if (meta.size != null && meta.size > 0) {
    await curlChunkedDownload(dlink, remotePath, localPath, meta.size, existingSize || 0, opts);
  } else {
    // 拿不到远端大小（罕见）：单请求无界下载（部分节点会拒绝，但无更好的办法）
    const exitCode = await spawnCurl(
      ["-s", "-L", "-C", "-", "--connect-timeout", "30", "-H", `User-Agent: ${cfg.ua}`, "-o", localPath, dlink],
      opts.progress
    );
    if (exitCode !== 0) {
      throw new Error(
        `curl 下载失败 (exit=${exitCode})，已保留部分文件: ${localPath}\n` +
        `      处理: 重跑 bdp get --resume（会重新获取 dlink）`
      );
    }
  }
  const seconds = (Date.now() - startedAt) / 1000;

  // 7) 校验（失败均保留文件供排查）
  let stat = null;
  try {
    stat = fs.statSync(localPath);
  } catch {}
  if (!stat) {
    throw new Error(
      `下载失败，目标文件缺失: ${localPath}\n      处理: 重跑 bdp get --resume`
    );
  }
  if (opts.verifySize && meta.size != null) {
    if (stat.size === 0 && meta.size > 0) {
      throw new Error(
        `下载结果 0 字节: dlink 过期或网络中断\n` +
        `      已保留: ${localPath}\n      处理: 重跑 bdp get --resume（会重新获取 dlink）`
      );
    }
    if (stat.size !== meta.size) {
      throw new Error(
        `大小校验失败: 远端 ${meta.size} 字节 vs 本地 ${stat.size} 字节\n` +
        `      已保留: ${localPath}\n      处理: --resume 续传 或 --force 重下`
      );
    }
  }

  return verifyAndBuild(remotePath, localPath, stat.size, remoteMd5, dlinkExpiry, {
    skipped: false, resumed: opts.resume && existingSize > 0, seconds, avgSpeedBps: seconds > 0 ? Math.round(stat.size / seconds) : null,
  });
}

// 分块下载主循环：从 existingSize 开始，每块 ≤4MB 有界 Range，
// 追加写入目标文件；块失败重试（每次换新 dlink，天然规避过期/坏节点）。
// 大文件（剩余 >32MB）默认 3 路并发分块（绕开单连接限速），--concurrency 1 可回串行
async function curlChunkedDownload(dlink, remotePath, localPath, metaSize, existingSize, opts) {
  // 清理同目录残留的陈旧分块临时文件（上次硬中断留下的 .bdp-chunk-*.tmp）
  cleanupStaleChunks(path.dirname(localPath));
  const fd = fs.openSync(localPath, "a");
  const state = { downloaded: existingSize, lastProgress: 0, startedAt: Date.now() };
  try {
    const concurrency = Math.min(Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY), 8);
    if (concurrency > 1 && metaSize - existingSize > CONCURRENT_THRESHOLD) {
      await concurrentChunkLoop(dlink, remotePath, localPath, fd, metaSize, state, concurrency, opts);
    } else {
      // 串行（小文件 / --concurrency 1）
      while (state.downloaded < metaSize) {
        const end = Math.min(state.downloaded + DOWNLOAD_CHUNK - 1, metaSize - 1);
        const data = await fetchRangeChunk(dlink, remotePath, localPath, state.downloaded, end, metaSize, opts);
        fs.writeSync(fd, data);
        state.downloaded += data.length;
        emitProgressIfDue(state, metaSize, opts);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (opts.progress) process.stderr.write("\n");
  return (Date.now() - state.startedAt) / 1000;
}

// 并发分块主循环：固定窗口预取（每块独立有界 Range + 独立 tmp 文件），
// 按序落盘（fd 写入保持顺序，文件永远是完整前缀）；
// 任一块重试后仍失败 → 等待在途块结束、丢弃其结果，降级串行补齐剩余
async function concurrentChunkLoop(dlink, remotePath, localPath, fd, metaSize, state, concurrency, opts) {
  let nextStart = state.downloaded;
  let nextWrite = state.downloaded;
  const active = new Map(); // start -> Promise<{start, data} | {start, error}>
  while (nextWrite < metaSize) {
    // 填充并发窗口
    while (active.size < concurrency && nextStart < metaSize) {
      const start = nextStart;
      const end = Math.min(start + DOWNLOAD_CHUNK - 1, metaSize - 1);
      active.set(
        start,
        fetchRangeChunk(dlink, remotePath, localPath, start, end, metaSize, opts)
          .then((data) => ({ start, data }))
          .catch((e) => ({ start, error: e }))
      );
      nextStart = end + 1;
    }
    const result = await active.get(nextWrite);
    active.delete(nextWrite);
    if (result.error) {
      // 并发下块失败（已内部重试换 dlink）→ 丢弃在途结果，降级串行补齐剩余
      await Promise.allSettled([...active.values()]);
      active.clear();
      while (nextWrite < metaSize) {
        const end = Math.min(nextWrite + DOWNLOAD_CHUNK - 1, metaSize - 1);
        const data = await fetchRangeChunk(dlink, remotePath, localPath, nextWrite, end, metaSize, opts);
        fs.writeSync(fd, data);
        nextWrite += data.length;
        state.downloaded = nextWrite;
        emitProgressIfDue(state, metaSize, opts);
      }
      return;
    }
    fs.writeSync(fd, result.data);
    nextWrite += result.data.length;
    state.downloaded = nextWrite;
    emitProgressIfDue(state, metaSize, opts);
  }
}

function emitProgressIfDue(state, metaSize, opts) {
  if (!opts.progress) return;
  const now = Date.now();
  if (now - state.lastProgress > 200 || state.downloaded >= metaSize) {
    state.lastProgress = now;
    emitProgress(state.downloaded, metaSize, state.startedAt);
  }
}

// 下载一个分块；失败重试 3 次，每次重新 locate 换新 dlink
async function fetchRangeChunk(dlink, remotePath, localPath, start, end, metaSize, opts, attempt = 0) {
  const cfg = config.get();
  const expected = end - start + 1;
  const tmpPath = path.join(
    path.dirname(localPath),
    `.bdp-chunk-${process.pid}-${start}.tmp`
  );
  const args = [
    "-s", "-L",
    "-r", `${start}-${end}`,
    "-o", tmpPath,
    "-w", "%{http_code} %{size_download}",
    "--connect-timeout", "30",
    "--speed-limit", "10240", "--speed-time", "30",
    "-H", `User-Agent: ${cfg.ua}`,
    dlink,
  ];
  const { exitCode, stdout } = await spawnCurlCapture(args);
  if (exitCode === 0) {
    const m = (stdout || "").trim().match(/^(\d+) (\d+)$/);
    if (m && m[1] === "206" && parseInt(m[2], 10) === expected) {
      const data = fs.readFileSync(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
      return data;
    }
  }
  try { fs.unlinkSync(tmpPath); } catch {}

  if (attempt < 3) {
    process.stderr.write(`[retry] 分块 ${start}-${end} 失败 (exit=${exitCode} resp=${(stdout || "").trim() || "?"})，换新 dlink 重试...\n`);
    const freshDlink = getDlink(remotePath);
    if (freshDlink) return fetchRangeChunk(freshDlink, remotePath, localPath, start, end, metaSize, opts, attempt + 1);
  }
  throw new Error(
    `下载中断于 ${start}/${metaSize} 字节: dlink 过期或网络中断或 CDN 拒绝（resp=${(stdout || "").trim() || "?"}）\n` +
    `      已保留部分文件: ${localPath}\n      处理: 重跑 bdp get --resume（会重新获取 dlink 续传）`
  );
}

// 清理下载目录中残留的陈旧分块临时文件（硬中断（SIGKILL/断电）留下的
// .bdp-chunk-<pid>-<start>.tmp）。判定：
//   1) 文件名 pid ≠ 当前进程 → 陈旧（并发下载的占用文件在 Windows 上删除会
//      EPERM 安全跳过；Unix 上 unlink 后 curl 继续写已打开 fd，仅浪费一块重试）
//   2) mtime 超 10 分钟 → 陈旧兜底
function cleanupStaleChunks(dir) {
  const myPid = process.pid;
  const cutoff = Date.now() - 10 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(".bdp-chunk-") || !name.endsWith(".tmp")) continue;
    const m = name.match(/^\.bdp-chunk-(\d+)-/);
    try {
      const st = fs.statSync(path.join(dir, name));
      const staleByPid = m && parseInt(m[1], 10) !== myPid;
      const staleByAge = st.mtimeMs < cutoff;
      if (staleByPid || staleByAge) fs.unlinkSync(path.join(dir, name));
    } catch {}
  }
}

function emitProgress(downloaded, total, startedAt) {  const seconds = (Date.now() - startedAt) / 1000;
  const speed = seconds > 0 ? downloaded / seconds : 0;
  const pct = Math.round((downloaded / total) * 100);
  const units = ["B", "KB", "MB", "GB"];
  const fmt = (n) => {
    if (!n) return "0B";
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(1) + units[i];
  };
  process.stderr.write(
    `\r[get] ${fmt(downloaded)}/${fmt(total)} (${pct}%)  ${fmt(speed)}/s  `
  );
}

// 最终校验并组装返回信息。
// md5 为软校验：实测百度 /api/list 返回的 md5 是混淆键（含 o/t 等非 hex 字符，
// 与真实内容不符，dlink URL 里也用它做文件键），无法作为完整性依据。
// 仅当远端 md5 是标准 32 位 hex 且与本地一致时才能确认（md5Match=true）；
// 混淆时标注 md5Obfuscated，从不硬失败。size 校验由调用方负责（精确）。
function verifyAndBuild(remotePath, localPath, size, remoteMd5, dlinkExpiry, extra) {
  const localMd5 = md5File(localPath);
  const remoteHex = typeof remoteMd5 === "string" && /^[0-9a-f]{32}$/i.test(remoteMd5);
  let md5Match = null;
  if (remoteMd5 && remoteHex) {
    md5Match = localMd5 === remoteMd5.toLowerCase();
  }
  return {
    path: remotePath,
    localPath,
    size,
    md5: localMd5,
    remoteMd5,
    md5Match,
    md5Obfuscated: !!remoteMd5 && !remoteHex,
    dlinkExpiry,
    verified: true,
    ...extra,
  };
}

function md5File(filePath) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function spawnCurl(args, forwardStderr) {
  return new Promise((resolve) => {
    const { spawn } = childProc();
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => {
      if (forwardStderr) process.stderr.write(chunk);
    });
    child.on("error", (err) => resolve("SPAWN:" + err.message));
    child.on("close", (code) => resolve(code === null ? "CLOSED" : code));
  });
}

// 捕获 curl 的 -w 输出（stdout）+ 退出码
function spawnCurlCapture(args) {
  return new Promise((resolve) => {
    const { spawn } = childProc();
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => resolve({ exitCode: "SPAWN:" + err.message, stdout: "", stderr: "" }));
    child.on("close", (code) => resolve({ exitCode: code === null ? "CLOSED" : code, stdout, stderr }));
  });
}

function upload(localPath, remotePath) {
  // check=true：引擎失败时退出码仍是 0（错误只在输出文本里），必须解析输出才能判定成败
  return runPCS(["u", localPath, remotePath], { check: true });
}

// mkdir 幂等：目录已存在（errno=31061）不算失败，返回 exists=true。
// 返回 { path, created, exists, raw }
function mkdir(remotePath) {
  const r = runPCSResult(["mkdir", remotePath]);
  const raw = r.output;
  const err = detectEngineError(raw);
  if (err) {
    if (err.errno === 31061) {
      return { path: remotePath, created: false, exists: true, raw };
    }
    const e = new Error(err.message);
    if (err.errno !== null) e.errno = err.errno;
    e.engineRaw = err.raw;
    throw e;
  }
  // 引擎成功时输出「创建目录成功: <path>」（源码 internal/pcscommand/rm_mkdir.go）。
  // 缺这句就说明引擎没真正建成 —— 绝不能谎报「已创建」。
  if (!/创建目录成功/.test(raw)) {
    const e = new Error(
      "引擎未确认目录创建成功: " + (raw.trim() || r.stderr.trim() || "(无输出)")
    );
    e.engineRaw = raw;
    throw e;
  }
  return { path: remotePath, created: true, exists: false, raw };
}

// 删除一个或多个路径。逐个执行并汇总结果（单个失败不影响其余）。
// 返回 [{ path, ok, error?, errno?, raw }]
function remove(remotePaths) {
  const paths = Array.isArray(remotePaths) ? remotePaths : [remotePaths];
  const results = [];
  for (const p of paths) {
    let r;
    try {
      r = runPCSResult(["rm", p]);
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message, raw: "" });
      continue;
    }
    const raw = r.output;
    const err = detectEngineError(raw);
    if (err) {
      results.push({ path: p, ok: false, error: err.message, errno: err.errno, raw });
      continue;
    }
    if (/操作失败/.test(raw)) {
      results.push({ path: p, ok: false, error: "引擎报告删除失败", raw });
      continue;
    }
    // 引擎成功时输出「操作成功, 以下文件/目录已删除, 可在网盘文件回收站找回:」
    // （源码 internal/pcscommand/rm_mkdir.go）。缺这句 → 引擎没真删，不能谎报成功。
    if (!/操作成功/.test(raw)) {
      results.push({
        path: p,
        ok: false,
        error:
          "引擎未确认删除成功" +
          (r.status !== null && r.status !== 0 ? "（退出码 " + r.status + "）" : "") +
          ": " + (raw.trim().slice(0, 200) || "(无输出)"),
        raw,
      });
      continue;
    }
    results.push({ path: p, ok: true, raw });
  }
  return results;
}

// ── 容量分析 (du) ──────────────────────────────────────
//
// 百度没有服务端目录大小接口，只能递归 /api/list 求和。
// 并发遍历 + 深度限制 + 失败容忍；目录过多时给出部分结果与 failed 计数。

const DU_DEFAULT_DEPTH = 3;
const DU_DEFAULT_TOP = 15;
const DU_DEFAULT_CONCURRENCY = 8;
const DU_MAX_DEPTH = 8; // 深度上限（超过会被静默钳制，这里显式声明并在返回值里告知）

// 递归统计目录大小。
// 返回 { path, size, files, dirs, failed, children[], truncated, partial,
//        depthRequested, depthLimit, depthCapped, elapsedMs }
//
// partial=true 表示"因深度封顶导致 size 不完整"——
// 此时 size 会明显小于 bdp quota 的已用空间（实测 depth=3 时 598GB vs 6.64TB）。
async function du(dirPath, options = {}) {
  const requestedDepth = options.depth || DU_DEFAULT_DEPTH;
  const depth = Math.min(Math.max(1, requestedDepth), DU_MAX_DEPTH);
  const concurrency = Math.min(Math.max(1, options.concurrency || DU_DEFAULT_CONCURRENCY), 16);
  const top = Math.max(1, options.top || DU_DEFAULT_TOP);
  const root = dirPath && dirPath !== "/" ? dirPath.replace(/\/+$/, "") : "/";

  const result = {
    path: root,
    size: 0,
    files: 0,
    dirs: 0,
    failed: 0,
    children: [], // { path, size, files, dirs, capped, partial }
    truncated: false,   // top-N 截断了 children 列表
    partial: false,     // 深度封顶导致 size 不完整
    depthRequested: requestedDepth,
    depthLimit: depth,
    depthCapped: requestedDepth > depth,
    elapsedMs: 0,
  };
  const startedAt = Date.now();

  // 目录 → { size, files, children: Map<name, child> }
  const nodeFor = (p) => {
    let node = tree.get(p);
    if (!node) {
      node = { size: 0, files: 0, dirs: 0, children: new Map(), capped: false, partial: false };
      tree.set(p, node);
    }
    return node;
  };

  const tree = new Map();
  const pending = [root];
  let completed = 0;
  const failedDirs = [];
  let seenFiles = 0;

  async function worker() {
    for (;;) {
      const dir = pending.pop();
      if (dir === undefined) return;
      const node = nodeFor(dir);
      let ok = false;
      try {
        for (let page = 1; page <= 50; page++) {
          const data = await getFileListPage(dir, page);
          if (!data || data.errno !== 0 || !Array.isArray(data.list)) break;
          ok = true;
          const list = data.list;
          for (const item of list) {
            const isDir = item.isdir === 1 || item.isdir === "1";
            const size = Number(item.size) || 0;
            node.size += size;
            if (isDir) {
              node.dirs++;
              const childPath = (dir === "/" ? "" : dir) + "/" + item.server_filename;
              const childNode = nodeFor(childPath);
              node.children.set(item.server_filename, childNode); // 登记父子关系
              if (dirDepth(childPath) <= depth) {
                pending.push(childPath);
              } else {
                // 深度封顶：不再下钻，只记录该子目录为独立叶子
                childNode.capped = true;
                childNode.partial = true;
              }
            } else {
              node.files++;
              seenFiles++;
            }
          }
          if (list.length < API_LIST_PAGE_SIZE) break;
        }
      } catch {
        // 网络异常 → 计入失败
      }
      completed++;
      if (!ok) failedDirs.push(dir);
      if (typeof options.onProgress === "function" && completed % 20 === 0) {
        options.onProgress({
          scannedDirs: completed,
          pending: pending.length,
          files: seenFiles,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
  }

  function dirDepth(p) {
    if (p === "/") return 0;
    return p.split("/").filter(Boolean).length;
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);

  // 汇总：自底向上把 children 的聚合大小并入父节点（深度降序 → 子节点 total 先算好）
  const sortedPaths = [...tree.keys()].sort((a, b) => dirDepth(b) - dirDepth(a));
  for (const p of sortedPaths) {
    const node = tree.get(p);
    let childTotal = 0;
    let anyPartial = false;
    for (const child of node.children.values()) {
      childTotal += child.total;
      node.files += child.files; // 文件/目录数同样聚合到父节点
      node.dirs += child.dirs;
      if (child.capped || child.partial) anyPartial = true;
    }
    node.total = node.size + childTotal;
    // partial 沿路径向上传播：只要有一个后代被封顶，父目录的 size 就不完整
    node.partial = node.partial || anyPartial;
    node.childList = [...node.children.entries()]
      .map(([name, c]) => ({
        name,
        path: (p === "/" ? "" : p) + "/" + name,
        size: c.total,
        files: c.files,
        dirs: c.dirs,
        capped: !!c.capped,                    // 该节点自身未被扫描（深度封顶）
        partial: !!(c.capped || c.partial),    // 其子树被封顶 → size 不完整
      }))
      .sort((a, b) => b.size - a.size);
  }

  const rootNode = tree.get(root);
  result.size = rootNode ? rootNode.total : 0;
  result.files = rootNode ? rootNode.files : 0;
  result.dirs = rootNode ? rootNode.dirs : 0;
  result.children = rootNode ? rootNode.childList.slice(0, top) : [];
  result.truncated = rootNode ? rootNode.childList.length > top : false;
  result.partial = rootNode ? !!rootNode.partial : false;
  result.failed = failedDirs.length;
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

// /api/list 单页（含 bdstoken，复用 getFileMetaWeb 的链路）
async function getFileListPage(dir, page) {
  const bdstoken = await http.getBdstoken();
  const url =
    `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1` +
    `&page=${page}&num=${API_LIST_PAGE_SIZE}&dir=${encodeURIComponent(dir)}` +
    `&channel=chunlei&app_id=${http.APP_ID}&bdstoken=${encodeURIComponent(bdstoken)}`;
  return http.webJson(url);
}

module.exports = {
  trimTrailingPartialChar,  ls, search, lsEntries, searchEntries, cat, head, tail, grep, peek,
  runPCSAsync, runPCSResultAsync,
  download, upload, mkdir, remove, du,
  getDlink, getFileMeta, getFileMetaWeb, fetchRangeText,
  detectEngineError, decodeText, decodeTextWithEncoding,
};
