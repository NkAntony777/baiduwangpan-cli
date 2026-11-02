// lib/flags.js — 布尔参数的统一判定（CLI 与 MCP 必须同口径）
//
// 为什么单独成文件：v1.9.2 的审核发现同一件事在两层有两种判定 ——
//   lib/error-codes.js 用真值判断（`!!opts.verbose`），
//   lib/mcp.js 用窄化三元组（`v === true || v === "true" || v === 1`）。
// 结果 `"false"` 在库层被判成 **true**（反而开启了 internalDetail），在 MCP 层却是 false。
// 同一份语义散在两处必然漂移 —— 收敛到一个模块。
//
// 判定口径：
//   true  ← true / 1 / "true" / "1" / "yes" / "on"（大小写不敏感、忽略首尾空白）
//   false ← false / 0 / "false" / "0" / "no" / "off" / "" / undefined / null
//   其它   → parseBool 抛错（不静默降级）；toBool 视为 false

const TRUE_SET = new Set(["true", "1", "yes", "on"]);
const FALSE_SET = new Set(["false", "0", "no", "off", ""]);

/**
 * 宽松的布尔判定：无法识别时返回 false，**不抛错**。
 * @param {*} v
 * @returns {boolean}
 */
function toBool(v) {
  if (v === true) return true;
  if (v === false || v === undefined || v === null) return false;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return TRUE_SET.has(v.trim().toLowerCase());
  return false;
}

// 回显上限：错误消息会原样进 Agent 上下文，不能把 10 万字符的输入整段灌进去
const ECHO_LIMIT = 80;

/**
 * 把任意值安全地转成字符串（用于错误消息；不抛异常、**限长**）。
 * @param {*} v
 * @returns {string}
 */
function safeString(v) {
  let s;
  try {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") s = String(v);
    else s = Object.prototype.toString.call(v);
  } catch {
    return "<无法显示的值>";
  }
  // 控制字符会让终端输出错乱；超长会把上下文挤爆
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  return s.length > ECHO_LIMIT ? s.slice(0, ECHO_LIMIT) + "…" : s;
}

/**
 * 严格的布尔解析：无法识别时抛错（带 toolArgumentError 标记 → MCP 侧转 -32001）。
 * 静默降级比报错危险 —— Agent 会以为参数生效了（例：`{"list":"1"}` 曾被当成「不列清单」）。
 * @param {*} v
 * @param {string} name 参数名（用于错误消息）
 * @returns {boolean}
 */
function parseBool(v, name) {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  } else if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE_SET.has(s)) return true;
    if (FALSE_SET.has(s)) return false;
  }
  const e = new Error("参数 " + name + " 只能是布尔值（true/false），收到: " + safeString(v));
  e.toolArgumentError = true;
  throw e;
}

module.exports = { toBool, parseBool, safeString, TRUE_SET, FALSE_SET };
