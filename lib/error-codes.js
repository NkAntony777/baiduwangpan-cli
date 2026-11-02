// lib/error-codes.js — 结构化错误码表（CLI 与 MCP 共用）
//
// 为什么独立成模块：
//   此前错误码表内联在 bin/bdp.js 的 cmds.error 里，MCP 侧完全用不上 ——
//   Agent 拿到的是一句中文散文，没法程序化判断「能不能重试」「下一步该做什么」。
//   抽出来之后，CLI 的 `bdp error <code> --json` 与 MCP 的 `bdp_error`
//   返回**同一份结构**，Agent 用同一套判断逻辑即可。
//
// severity 四态：
//   "retryable"  瞬时故障，退避重试可能成功（限流、链接过期…）
//   "fatal"      重试无意义，必须用户介入（鉴权失效、接口下线…）
//   "user-error" 请求本身有问题（路径不存在、参数非法…）
//   "unknown"    未登记的错误码（见 describeError 的兜底分支）
//
// action：一句话的下一步动作。Agent 应该把它当作「建议」而不是「命令」执行。
//
// ── 分层：description（结论） vs internalDetail（内部细节）────────────────
//   description  —— 一句话说清「这是什么错」，默认下发。
//   internalDetail —— 实测记录 / 实现坑 / 排查线索。**默认不下发**，
//                   只有显式要「深挖」时才给（CLI: --verbose；MCP: {"verbose": true}）。
//
//   为什么要分层：Agent 的上下文是最稀缺的资源。一条错误码的结论通常 1~2 句就够，
//   但内部细节往往有 2~4 句（实测记录、已知坑）。13 条错误码全展开约 1.5KB，
//   而 Agent 一次通常只碰 1 条 —— 默认全量下发等于每次都白付这份上下文。
//   分层后：默认只付「结论」，需要深挖时按需取那一条。

const { sanitizeControl } = require("./sanitize");
const { toBool } = require("./flags");

const ERRORS = {
  "-10": {
    name: "GROUP_TRANSFER_REMOVED",
    severity: "fatal",
    description: "群文件转存接口已被百度下线（errno=-10）。",
    internalDetail:
      "2026-08 实测：/mbox/msg/transfer 对非空目录一律 errno=-10；补 logId/channel 参数仍拒绝；" +
      "新版 Web UI 已移除「保存」按钮。",
    action:
      "群文件用 bdp gdownload 直接下载（单文件 ≤~20MB；多文件 zip 打包 ≤~100MB），更大文件用百度官方客户端。",
  },
  "-32001": {
    name: "TOOL_ARGUMENT_ERROR",
    severity: "user-error",
    description: "工具参数缺失或不合法（如 bdp_mkdir 没给 path）。这是**调用方**的问题，不是百度侧的错。",
    internalDetail:
      "由 lib/mcp.js 的 assertArg() 在**进入引擎之前**拦截 —— 否则会把 undefined 当成路径传给引擎，" +
      "那会在网盘根目录真的建出一个名为 undefined 的目录。",
    action: "按该工具的 inputSchema 修正参数后重试；不要重试同样的调用。",
  },
  "-32000": {
    name: "TOOL_ERROR",
    severity: "unknown",
    description: "工具执行失败且没有对应的 errno（JSON-RPC 服务端错误区间 -32000..-32099）。",
    internalDetail: "MCP 侧在没有 errno 时统一用这个码；拿得到 errno 时优先走下方的登记码。",
    action:
      "查看错误信息里的 message 判断原因；若是百度侧的新错误码，请提交 Issue：" +
      "https://github.com/NkAntony777/baiduwangpan-cli/issues",
  },
  "-6": {
    name: "AUTH_FAILED",
    severity: "fatal",
    description: "接口鉴权失败。通常是 access_token/cookie 失效，或 BDUSS/STOKEN 已过期。",
    internalDetail:
      "凭证存放在 ~/.bdp/config.json（BDUSS/STOKEN），用 bdp login 更新；CLI 与 MCP 共用同一份配置。",
    action: "重新执行 bdp login（扫码或 bdp login --bduss <BDUSS> --stoken <STOKEN>）后重试。",
  },
  "-3": {
    name: "SHARE_API_REJECTED",
    severity: "retryable",
    description: "群分享 API 拒绝请求。",
    internalDetail:
      "已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁（限流）都可能触发。" +
      "限流表现为 errno=0 但只返回目录自身（self-echo），工具会自动退避重试（1s/2s）。",
    action:
      "减小 --page-size（自动重试 50→20→10）或 --concurrency；若回退到父目录（fallback level=parent），" +
      "从父目录换路径继续遍历。",
  },
  "2": {
    name: "UNSUPPORTED_OR_BAD_PARAM",
    severity: "user-error",
    description: "接口不支持或参数缺失（errno=2）。",
    internalDetail: "实测普通文件接口（/api/download、/api/filemetas）对群文件参数返回 errno=2。",
    action: "群文件请走 bdp gdownload / bdp gsearch 的群专用接口。",
  },
  "2131": {
    name: "MSG_NOT_IN_GROUP",
    severity: "user-error",
    description: "群分享 msg_id 不属于该群（gid 与 msg_id 来自不同群/分享库时最常见）。",
    internalDetail: "shareinfo 以 msg_id 为查找键，from_uk 不参与校验 —— 所以 from_uk 填错不会触发本错误。",
    action:
      "用 bdp gshares <gid> 查看本群分享（或 bdp gsearch <gid> <关键词>），取其中一行的 fsId/fromUk/msgId 重试，" +
      "保证 gid/fsId/fromUk/msgId 同源；或去掉 --from-uk/--msg-id 让 CLI 自动解析（仅顶层分享）。",
  },
  "31045": {
    name: "OFFLINE_DOWNLOAD_FAILED",
    severity: "retryable",
    description: "离线下载任务创建失败（errno=31045）。通常是目标 URL 不可达、不支持直链或被防盗链拦截。",
    internalDetail: "本 CLI 的 offline add 面向可直连的 URL；目标站点不可直连或被防盗链拦截时即报此码。",
    action: "换一个可直连的 URL 重试；或改用 bdp get 从本地文件上传。",
  },
  "31061": {
    name: "DIR_ALREADY_EXISTS",
    severity: "unknown",
    description: "目录已存在（errno=31061）。",
    internalDetail:
      "bdp mkdir 是**幂等**的 —— 已存在时算成功，通常不会作为错误冒出来；" +
      "只有直接从百度接口拿到这个 errno 时才会看到。",
    action: "无需处理；如需确认内容，用 bdp ls <dir> 查看。",
  },
  "31062": {
    name: "INVALID_FILENAME",
    severity: "user-error",
    description: "文件名非法（file name is invalid）。",
    internalDetail: "百度侧未公开具体的非法字符集；遇到时换个名字重试即可。",
    action: "路径含非法字符或格式不符，改名后重试。",
  },
  "31066": {
    name: "FILE_NOT_FOUND",
    severity: "user-error",
    description: "文件或目录不存在（errno=31066）。",
    internalDetail: "网盘路径区分大小写。",
    action: "用 bdp ls <父目录> 确认路径拼写与大小写。",
  },
  "31090": {
    name: "PACKAGE_TOO_LARGE",
    severity: "user-error",
    description: "zip 打包总大小超出上限（package is too large）。",
    internalDetail: "实测 452MB 即报 31090，10MB 正常。",
    action: "拆包下载（一次少于 2 个文件），或大文件用百度官方客户端。",
  },
  "31326": {
    name: "DLINK_BLOCKED",
    severity: "retryable",
    description: "dlink 被反盗链拦截（HTTP 403，hitcode 104）。",
    internalDetail:
      "实测直链只接受 ≤~5MB 的有界 Range 请求，无界请求返回 403。" +
      "CLI 下载已按 4MB 分块自动规避。",
    action: "CLI 已按 4MB 分块自动规避；如仍报错，重跑 bdp get --resume（换新 dlink）。",
  },
};

// 未登记错误码的内部细节（只有 verbose 时才给）
const UNKNOWN_INTERNAL_DETAIL =
  "该错误码不在 lib/error-codes.js 的登记表中（当前 13 条）。" +
  "该表由实测整理而非百度官方文档，所以未登记通常意味着百度侧新增了 errno。";

/**
 * 查一个错误码。
 * 返回值额外带 `key`（**实际命中的表键**）—— describeError 用它算数值 code，
 * 否则 "errno=31066" 这种写法会命中条目却拿到 code:null。
 *
 * 注意：lookup 返回的是**表内原始条目**（含 internalDetail），属于进程内 API；
 *      面向 Agent 的出口是 describeError / listErrors —— 它们按 verbose 决定是否下发内部细节。
 *
 * @param {number|string} code
 * @returns {object|null} 命中的条目；未登记返回 null
 */
function lookup(code) {
  const key = String(code).trim();
  if (Object.prototype.hasOwnProperty.call(ERRORS, key)) {
    return Object.assign({ key: key }, ERRORS[key]);
  }
  // 只兼容一种明确形态："errno=31066" / "errno = -3"（大小写不敏感）
  //
  // 为什么不能用宽松的 /-?\d+/ 抽数字：那会把 "abc31066" / "31066abc" / "pid=2" / "v2"
  // 这类**明显无关**的输入命中已知错误码，给 Agent 一个错误的确定性结论
  // （"errno=2 → 群文件请走 gdownload"）—— 这比返回 UNKNOWN 更危险。
  const m = key.match(/^errno\s*=\s*(-?\d+)$/i);
  if (m && Object.prototype.hasOwnProperty.call(ERRORS, m[1])) {
    return Object.assign({ key: m[1] }, ERRORS[m[1]]);
  }
  return null;
}

/**
 * 把一个错误码解释成结构化对象（CLI 与 MCP 共用）。
 * 未登记的码也会返回一个可用对象 —— Agent 至少能拿到 code 与「去查一下」的指引。
 *
 * @param {number|string} code
 * @param {{verbose?: boolean}} [opts] verbose=true 时附带 internalDetail（默认**不带**）
 * @returns {{code: number|null, codeText: string, name: string, description: string,
 *            severity: string, retryable: boolean, action: string, internalDetail?: string}}
 */
function describeError(code, opts) {
  // 与 MCP 侧共用同一套布尔判定（lib/flags.js）—— 避免 "\"false\" 被当成 true"
  const verbose = !!(opts && toBool(opts.verbose));
  // 无法转成字符串的入参（Object.create(null) / 含 Symbol 的数组）不应抛异常
  let rawText;
  try {
    rawText = String(code === undefined || code === null ? "" : code).trim();
  } catch {
    rawText = "";
  }
  // 未登记码的原样回显要**限长 + 净化**：
  //  - 限长：否则 10 万字符的输入会把整段灌进 Agent 上下文
  //  - 净化：控制字符会让 CLI 的非 JSON 输出打到终端；
  //    `</untrusted_file>` 伪标记能闭合 MCP 的边界标记 → 反射注入
  const cleanText = sanitizeControl(rawText).replace(/<\/?untrusted_/gi, "[untrusted_");
  const codeText = cleanText.length > 200 ? cleanText.slice(0, 200) + "…" : cleanText;
  // 查表用**净化后**的文本：否则 ESC[2J ESC[H31066 里的 "2" 会被当成 errno=2
  const hit = lookup(cleanText);
  const numeric = /^-?\d+$/.test(rawText) ? Number(rawText) : null;
  if (!hit) {
    const info = {
      code: numeric,
      codeText,
      name: "UNKNOWN_ERROR",
      description: "未登记的错误码 " + codeText + "。",
      severity: "unknown",
      retryable: false,
      action:
        "运行 bdp error 列出已知错误码；若确认是百度侧的新错误码，请提交 Issue：" +
        "https://github.com/NkAntony777/baiduwangpan-cli/issues",
    };
    if (verbose) info.internalDetail = UNKNOWN_INTERNAL_DETAIL;
    return info;
  }
  const info = {
    // 命中时用**表键**算数值（"errno=31066" 也应拿到 31066），未命中才用原始文本
    code: hit ? Number(hit.key) : numeric,
    codeText,
    name: hit.name,
    description: hit.description,
    severity: hit.severity,
    retryable: hit.severity === "retryable",
    action: hit.action,
  };
  // 内部细节**只在显式要深挖时**才下发（默认不下发 → 省上下文）
  if (verbose && hit.internalDetail) info.internalDetail = hit.internalDetail;
  return info;
}

/**
 * 人类可读的解释（bdp error 的非 JSON 输出）。
 * @param {number|string} code
 * @param {{verbose?: boolean}} [opts]
 * @returns {string}
 */
function explainError(code, opts) {
  const info = describeError(code, opts);
  const lines = [
    "错误码 " + info.codeText + (info.name !== "UNKNOWN_ERROR" ? "（" + info.name + "）" : ""),
    "",
    info.description,
    "",
    "严重级别: " + info.severity + (info.retryable ? "（可重试）" : ""),
    "处理: " + info.action,
  ];
  if (info.internalDetail) {
    lines.push("", "内部细节: " + info.internalDetail);
  }
  return lines.join("\n");
}

/**
 * 全部已登记的错误码（供 bdp error --list / bdp_error --list 用）
 * @param {{verbose?: boolean}} [opts] verbose=true 时每条附带 internalDetail
 */
function listErrors(opts) {
  const verbose = !!(opts && toBool(opts.verbose));
  return Object.keys(ERRORS).map((code) => {
    const info = ERRORS[code];
    const item = {
      code: Number(code),
      codeText: code,
      name: info.name,
      severity: info.severity,
      retryable: info.severity === "retryable",
      description: info.description,
      action: info.action,
    };
    if (verbose && info.internalDetail) item.internalDetail = info.internalDetail;
    return item;
  });
}

module.exports = { ERRORS, lookup, describeError, explainError, listErrors };
