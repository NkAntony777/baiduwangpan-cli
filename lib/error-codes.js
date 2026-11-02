// lib/error-codes.js — 结构化错误码表（CLI 与 MCP 共用）
//
// 为什么独立成模块：
//   此前错误码表内联在 bin/bdp.js 的 cmds.error 里，MCP 侧完全用不上 ——
//   Agent 拿到的是一句中文散文，没法程序化判断「能不能重试」「下一步该做什么」。
//   抽出来之后，CLI 的 \`bdp error <code> --json\` 与 MCP 的 \`bdp_error\` 工具
//   返回**同一份结构**，Agent 用同一套判断逻辑即可。
//
// severity 四态：
//   "retryable"  瞬时故障，退避重试可能成功（限流、链接过期…）
//   "fatal"      重试无意义，必须用户介入（鉴权失效、接口下线…）
//   "user-error" 请求本身有问题（路径不存在、参数非法…）
//   "unknown"    未登记的错误码（见 describeError 的兜底分支）
//
// action：一句话的下一步动作。Agent 应该把它当作「建议」而不是「命令」执行。

const { sanitizeControl } = require("./sanitize");

const ERRORS = {
  "-10": {
    name: "GROUP_TRANSFER_REMOVED",
    severity: "fatal",
    description:
      "群文件转存接口已被百度下线（2026-08 实测：/mbox/msg/transfer 对非空目录一律 errno=-10，" +
      "补 logId/channel 参数仍拒绝，新版 UI 已移除「保存」按钮）。",
    action:
      "群文件用 bdp gdownload 直接下载（单文件 ≤~20MB；多文件 zip 打包 ≤~100MB），更大文件用百度官方客户端。",
  },
  "-32001": {
    name: "TOOL_ARGUMENT_ERROR",
    severity: "user-error",
    description:
      "工具参数缺失或不合法（例如 bdp_mkdir 没给 path）。这是**调用方**的问题，不是百度侧的错。",
    action:
      "按该工具的 inputSchema 修正参数后重试；不要重试同样的调用。",
  },
  "-32000": {
    name: "TOOL_ERROR",
    severity: "unknown",
    description:
      "工具执行失败且没有对应的 errno（JSON-RPC 服务端错误区间的保留码 -32000..-32099）。" +
      "MCP 侧的工具错误在没有 errno 时统一用这个码。",
    action:
      "查看错误信息里的 message 判断原因；若是百度侧的新错误码，请提交 Issue：" +
      "https://github.com/NkAntony777/baiduwangpan-cli/issues",
  },
  "-6": {
    name: "AUTH_FAILED",
    severity: "fatal",
    description:
      "接口鉴权失败。通常为 access_token/cookie 失效，或 BDUSS/STOKEN 已过期。",
    action: "重新执行 bdp login（扫码或 bdp login --bduss <BDUSS> --stoken <STOKEN>）后重试。",
  },
  "-3": {
    name: "SHARE_API_REJECTED",
    severity: "retryable",
    description:
      "群分享 API 拒绝请求。已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁(限流)都可能触发。" +
      "限流表现为 errno=0 但只返回目录自身（self-echo），工具会自动退避重试(1s/2s)。",
    action:
      "减小 --page-size（自动重试 50→20→10）或 --concurrency；若回退到父目录（fallback level=parent），" +
      "从父目录换路径继续遍历。",
  },
  "2": {
    name: "UNSUPPORTED_OR_BAD_PARAM",
    severity: "user-error",
    description:
      "接口不支持或参数缺失（errno=2）。实测普通文件接口（/api/download、/api/filemetas）对群文件参数返回 errno=2。",
    action: "群文件请走 bdp gdownload / bdp gsearch 的群专用接口。",
  },
  "2131": {
    name: "MSG_NOT_IN_GROUP",
    severity: "user-error",
    description:
      "群分享 msg_id 不属于该群（shareinfo 以 msg_id 为查找键，from_uk 不参与校验）。" +
      "常见原因：gid 与 --from-uk/--msg-id/--parent-fs-id 来自不同群/分享库（参数错配）。",
    action:
      "用 bdp gshares <gid> 查看本群分享（或 bdp gsearch <gid> <关键词>），取其中一行的 fsId/fromUk/msgId 重试，" +
      "保证 gid/fsId/fromUk/msgId 同源；或去掉 --from-uk/--msg-id 让 CLI 自动解析（仅顶层分享）。",
  },
  "31045": {
    name: "OFFLINE_DOWNLOAD_FAILED",
    severity: "retryable",
    description: "离线下载任务创建失败（errno=31045）。通常是目标 URL 不可达、不支持直链或被防盗链拦截。",
    action: "换一个可直连的 URL 重试；或改用 bdp get 从本地文件上传。",
  },
  "31061": {
    name: "DIR_ALREADY_EXISTS",
    severity: "unknown",
    description:
      "目录已存在（errno=31061）。bdp mkdir 是**幂等**的 —— 已存在时算成功，通常不会作为错误冒出来；" +
      "只有直接从百度接口拿到这个 errno 时才会看到。",
    action: "无需处理；如需确认内容，用 bdp ls <dir> 查看。",
  },
  "31062": {
    name: "INVALID_FILENAME",
    severity: "user-error",
    description: "文件名非法（file name is invalid）。",
    action: "路径含非法字符或格式不符，改名后重试。",
  },
  "31066": {
    name: "FILE_NOT_FOUND",
    severity: "user-error",
    description: "文件或目录不存在（errno=31066）。",
    action: "用 bdp ls <父目录> 确认路径拼写与大小写；网盘路径区分大小写且不含前导斜杠以外的写法差异。",
  },
  "31090": {
    name: "PACKAGE_TOO_LARGE",
    severity: "user-error",
    description: "zip 打包总大小超出上限（package is too large，实测 452MB 即报 31090，10MB 正常）。",
    action: "拆包下载（一次少于 2 个文件），或大文件用百度官方客户端。",
  },
  "31326": {
    name: "DLINK_BLOCKED",
    severity: "retryable",
    description:
      "dlink 被反盗链拦截（HTTP 403，hitcode 104）。实测直链只接受 ≤~5MB 的有界 Range 请求，无界请求返回 403。",
    action: "CLI 已按 4MB 分块自动规避；如仍报错，重跑 bdp get --resume（换新 dlink）。",
  },
};

/**
 * 查一个错误码。
 * 返回值额外带 `key`（**实际命中的表键**）—— describeError 用它算数值 code，
 * 否则 "errno=31066" 这种写法会命中条目却拿到 code:null。
 * @param {number|string} code
 * @returns {object|null} 命中的条目；未登记返回 null
 */
function lookup(code) {
  const key = String(code).trim();
  if (Object.prototype.hasOwnProperty.call(ERRORS, key)) {
    return Object.assign({ key: key }, ERRORS[key]);
  }
  // 兼容 "errno=31066" / "errno = -3" / " 31066 " 这类写法
  const m = key.match(/-?\d+/);
  if (m && Object.prototype.hasOwnProperty.call(ERRORS, m[0])) {
    return Object.assign({ key: m[0] }, ERRORS[m[0]]);
  }
  return null;
}

/**
 * 把一个错误码解释成结构化对象（CLI 与 MCP 共用）。
 * 未登记的码也会返回一个可用对象 —— Agent 至少能拿到 code 与「去查一下」的指引。
 *
 * @param {number|string} code
 * @returns {{code: number|null, codeText: string, name: string, description: string,
 *            severity: string, retryable: boolean, action: string}}
 */
function describeError(code) {
  const rawText = String(code === undefined || code === null ? "" : code).trim();
  // 未登记码的原样回显要**限长 + 净化**：
  //  - 限长：否则 10 万字符的输入会把整段灌进 Agent 上下文
  //  - 净化：控制字符会让 CLI 的非 JSON 输出打到终端；
  //    `</untrusted_file>` 伪标记能闭合 MCP 的边界标记 → 反射注入
  const cleanText = sanitizeControl(rawText).replace(/<\/?untrusted_/gi, "[untrusted_");
  const codeText = cleanText.length > 200 ? cleanText.slice(0, 200) + "…" : cleanText;
  const hit = lookup(rawText);
  const numeric = /^-?\d+$/.test(rawText) ? Number(rawText) : null;
  if (!hit) {
    return {
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
  }
  return {
    // 命中时用**表键**算数值（"errno=31066" 也应拿到 31066），未命中才用原始文本
    code: hit ? Number(hit.key) : numeric,
    codeText,
    name: hit.name,
    description: hit.description,
    severity: hit.severity,
    retryable: hit.severity === "retryable",
    action: hit.action,
  };
}

/**
 * 人类可读的解释（bdp error 的非 JSON 输出）。
 * @param {number|string} code
 * @returns {string}
 */
function explainError(code) {
  const info = describeError(code);
  const lines = [
    "错误码 " + info.codeText + (info.name !== "UNKNOWN_ERROR" ? "（" + info.name + "）" : ""),
    "",
    info.description,
    "",
    "严重级别: " + info.severity + (info.retryable ? "（可重试）" : ""),
    "处理: " + info.action,
  ];
  return lines.join("\n");
}

/** 全部已登记的错误码（供 bdp error --list / bdp_error --list 用） */
function listErrors() {
  return Object.keys(ERRORS).map((code) => {
    const info = ERRORS[code];
    return {
      code: Number(code),
      codeText: code,
      name: info.name,
      severity: info.severity,
      retryable: info.severity === "retryable",
      description: info.description,
      action: info.action,
    };
  });
}

module.exports = { ERRORS, lookup, describeError, explainError, listErrors };
