// 输出净化：引擎原文（raw）、人读版、错误消息长度
//
// 回归背景（四路审核实测）：
//   - CLI `--json` 的 `raw` 字段**不标记**：引擎原文是远端可控内容（回显远端文件名/错误文本），
//     直接交给 Agent 等于让它把「数据」当「指令」。MCP 侧一直标记，CLI 侧漏了 ——
//     而 SKILL.md 恰恰要求 Agent 优先用 --json。
//   - 人读版 `bdp ls` / `bdp get` 直出 `console.log(info.raw)`：远端文件名里的 ESC/OSC
//     能劫持终端（清屏、改标题、写剪贴板）。
//   - CLI 错误消息**无长度上限**：实测 50KB 进 Agent 上下文；MCP 侧早有 1000 上限，
//     两侧文案因此不一致。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { markUntrustedRawFields, capErrorMessage, ERROR_MESSAGE_LIMIT, sanitizeErrorMessage } = require("../lib/sanitize");

test("输出净化: raw 字段（含嵌套 / 数组内）都被包上 <untrusted_engine_output>", () => {
  const out = markUntrustedRawFields({
    raw: "engine text",
    nested: { raw: "nested text" },
    list: [{ raw: "array text" }],
    keep: "untouched",
  });
  assert.match(out.raw, /^<untrusted_engine_output>engine text<\/untrusted_engine_output>$/);
  assert.match(out.nested.raw, /^<untrusted_engine_output>nested text<\/untrusted_engine_output>$/);
  assert.match(out.list[0].raw, /^<untrusted_engine_output>array text<\/untrusted_engine_output>$/);
  assert.equal(out.keep, "untouched", "非 raw 字段不应被改动");
});

test("输出净化: 名字含 raw 但不是字符串的字段不被误伤", () => {
  const out = markUntrustedRawFields({ raw: 123, rawLines: "x" });
  assert.equal(out.raw, 123, "raw 不是字符串时原样返回");
  assert.equal(out.rawLines, "x", "rawLines 不是 raw 字段");
});

test("输出净化: __proto__ 不会被带进结果（防原型污染）", () => {
  const evil = JSON.parse('{"__proto__":{"polluted":"YES"},"raw":"x"}');
  const out = markUntrustedRawFields(evil);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), false);
  assert.equal({}.polluted, undefined, "全局原型不得被污染");
});

test("输出净化: 错误消息限长 1000（CLI 与 MCP 共用同一常量）", () => {
  assert.equal(ERROR_MESSAGE_LIMIT, 1000);
  const long = "x".repeat(5000);
  const capped = capErrorMessage(long);
  assert.equal(capped.length, 1001, "应为 1000 字符 + 省略号");
  assert.ok(capped.endsWith("…"));
  assert.equal(capErrorMessage("short"), "short", "短消息原样返回");
  assert.equal(capErrorMessage(null), "");
});

test("输出净化: 超长引擎错误先净化再限长（顺序正确、不泄漏路径）", () => {
  const raw = "C:\\Users\\victim\\a.txt " + "x".repeat(5000);
  const out = capErrorMessage(sanitizeErrorMessage(raw));
  assert.ok(out.length <= 1001, "长度应被限制");
  assert.equal(out.indexOf("victim"), -1, "限长之前必须先脱敏");
});

test("输出净化: 人读版不再直出引擎原文（源码级守门）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "bdp.js"), "utf-8");
  assert.equal(src.indexOf("console.log(info.raw)"), -1, "不得再有 console.log(info.raw) 直出");
  const hits = (src.match(/console\.log\(sanitizeControl\(info\.raw\)\)/g) || []).length;
  assert.ok(hits >= 2, "两处引擎原文输出都应走 sanitizeControl，实际 " + hits);
});
