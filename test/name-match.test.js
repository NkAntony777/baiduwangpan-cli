const test = require("node:test");
const assert = require("node:assert/strict");
const { globToRegExp, matchesName, escapeRegExp } = require("../lib/name-match");

// ── globToRegExp ────────────────────────────────────────

test("globToRegExp: * matches any sequence, ? matches single char", () => {
  const re = globToRegExp("玄空*飞星");
  assert.equal(re.test("玄空飞星"), true);          // * 可为空
  assert.equal(re.test("玄空大卦飞星"), true);      // * 匹配任意串
  assert.equal(re.test("玄空 高阶 飞星"), true);
  assert.equal(re.test("玄空大卦"), false);         // 缺少 飞星
  assert.equal(re.test("飞星玄空"), false);         // 顺序不能反（glob 不是分词）

  const re2 = globToRegExp("?.txt");
  assert.equal(re2.test("a.txt"), true);
  assert.equal(re2.test("ab.txt"), false);          // ? 只匹配一个字符
});

test("globToRegExp: regex metacharacters are literal", () => {
  const re = globToRegExp("1.5版");
  assert.equal(re.test("1.5版"), true);
  assert.equal(re.test("1x5版"), false);            // "." 是字面句点，不是通配符

  const re2 = globToRegExp("report[1].pdf");
  assert.equal(re2.test("report[1].pdf"), true);
  assert.equal(re2.test("report1.pdf"), false);     // [ ] 不构成字符类
});

test("globToRegExp: anchored to whole string (shell semantics)", () => {
  const re = globToRegExp("*飞星*");
  assert.equal(re.test("飞星"), true);
  assert.equal(re.test("玄空飞星资料"), true);
  assert.equal(re.test("玄空大卦"), false);          // 不含 飞星
});

test("globToRegExp: empty pattern matches only empty string", () => {
  const re = globToRegExp("");
  assert.equal(re.test(""), true);
  assert.equal(re.test("a.txt"), false);
});

// ── matchesName: all（默认 AND）─────────────────────────

test("all mode: single keyword is substring match (backward compat)", () => {
  assert.equal(matchesName("玄空", "玄空飞星资料"), true);
  assert.equal(matchesName("玄空", "飞星盘"), false);
  assert.equal(matchesName("报告", "/X20 报告"), true); // 完整路径也做子串
});

test("all mode: multi-keyword requires ALL words (AND, order-independent)", () => {
  assert.equal(matchesName("玄空 飞星", "玄空飞星资料"), true);
  assert.equal(matchesName("飞星 玄空", "玄空飞星资料"), true); // 顺序无关
  assert.equal(matchesName("玄空 飞星", "玄空大卦"), false);     // 缺 飞星
  assert.equal(matchesName("玄空 飞星", "飞星盘"), false);       // 缺 玄空
  assert.equal(matchesName("玄空 飞星", "其它资料"), false);     // 全缺
});

test("all mode: whitespace variations (leading/trailing/multiple spaces)", () => {
  assert.equal(matchesName(" 玄空  飞星 ", "玄空飞星资料"), true);
});

test("all mode: regex metacharacters in plain words are literal", () => {
  // "1.5版" 中的 "." 是普通字符（子串包含，不经过正则）
  assert.equal(matchesName("1.5版", "第1.5版教程"), true);
  assert.equal(matchesName("1.5版", "第1x5版教程"), false);
});

test("all mode: empty keyword matches everything (existing behavior)", () => {
  assert.equal(matchesName("", "任意文件.txt"), true);
  assert.equal(matchesName("   ", "任意文件.txt"), true);
});

// ── matchesName: any（OR）──────────────────────────────

test("any mode: any single word is enough (OR)", () => {
  assert.equal(matchesName("玄空 飞星", "玄空大卦", { mode: "any" }), true);
  assert.equal(matchesName("玄空 飞星", "飞星盘", { mode: "any" }), true);
  assert.equal(matchesName("玄空 飞星", "玄空飞星资料", { mode: "any" }), true);
  assert.equal(matchesName("玄空 飞星", "其它资料", { mode: "any" }), false);
});

// ── matchesName: exact ─────────────────────────────────

test("exact mode: full name equality, basename extracted from path", () => {
  assert.equal(matchesName("report.pdf", "/docs/report.pdf", { mode: "exact" }), true);
  assert.equal(matchesName("report.pdf", "/docs/report-final.pdf", { mode: "exact" }), false);
  assert.equal(matchesName("report", "/docs/report.pdf", { mode: "exact" }), false); // 扩展名也算一部分
  assert.equal(matchesName("报告", "/报告", { mode: "exact" }), true);               // 顶层分享 "/xxx"
  assert.equal(matchesName("报告", "/目录/子目录/报告", { mode: "exact" }), true);    // 深层路径取 basename
});

test("exact mode: case-insensitive by default, ignoreCase:false opts out", () => {
  assert.equal(matchesName("REPORT.PDF", "Report.pdf", { mode: "exact" }), true);
  assert.equal(matchesName("REPORT.PDF", "Report.pdf", { mode: "exact", ignoreCase: false }), false);
});

// ── matchesName: regex ─────────────────────────────────

test("regex mode: pattern used directly as regular expression", () => {
  assert.equal(matchesName("^玄空.*飞星$", "玄空大卦飞星", { mode: "regex" }), true);
  assert.equal(matchesName("飞星\\d+版", "飞星2024版", { mode: "regex" }), true);
  assert.equal(matchesName("飞星\\d+版", "飞星资料", { mode: "regex" }), false);
  assert.equal(matchesName("[0-9]{2}\\.5", "第12.5版", { mode: "regex" }), true);
});

test("regex mode: invalid pattern throws SyntaxError", () => {
  assert.throws(() => matchesName("(未闭合", "任意", { mode: "regex" }), SyntaxError);
});

// ── matchesName: glob ──────────────────────────────────

test("glob mode: shell-style wildcards", () => {
  assert.equal(matchesName("*飞星*", "玄空飞星资料", { mode: "glob" }), true);
  assert.equal(matchesName("*飞星*", "玄空大卦", { mode: "glob" }), false);
  assert.equal(matchesName("玄空?资料", "玄空一资料", { mode: "glob" }), true); // ? 恰好一字符
  assert.equal(matchesName("玄空?资料", "玄空飞星资料", { mode: "glob" }), false); // 多一字符不命中
  assert.equal(matchesName("*.pdf", "/docs/年度报告.pdf", { mode: "glob" }), true);
  assert.equal(matchesName("*.pdf", "/docs/年度报告.docx", { mode: "glob" }), false);
});

// ── matchesName: ignoreCase 通用开关 ───────────────────

test("all/any modes respect ignoreCase (default true)", () => {
  assert.equal(matchesName("BAIDU netdisk", "Baidu Netdisk Guide"), true);
  assert.equal(matchesName("BAIDU netdisk", "Baidu Netdisk Guide", { ignoreCase: false }), false);
  assert.equal(matchesName("BAIDU", "baidu", { mode: "any" }), true);
  assert.equal(matchesName("BAIDU", "baidu", { mode: "any", ignoreCase: false }), false);
});

// ── escapeRegExp（辅助导出）─────────────────────────────

test("escapeRegExp: produces literal-matching regex source", () => {
  const src = escapeRegExp("1.5版[a].txt");
  const re = new RegExp(src);
  assert.equal(re.test("1.5版[a].txt"), true);
  assert.equal(re.test("1x5版{a}.txt"), false);
});
