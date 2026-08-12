const test = require("node:test");
const assert = require("node:assert/strict");

const { parseChcp } = require("../lib/console");

test("parseChcp: 英文格式 Active code page: 936", () => {
  assert.equal(parseChcp("Active code page: 936"), 936);
});

test("parseChcp: 英文格式 Active code page: 65001", () => {
  assert.equal(parseChcp("Active code page: 65001"), 65001);
});

test("parseChcp: 中文格式 活动代码页: 936", () => {
  assert.equal(parseChcp("活动代码页: 936"), 936);
});

test("parseChcp: 带回车换行/末尾空白的输出", () => {
  assert.equal(parseChcp("Active code page: 936\r\n"), 936);
  assert.equal(parseChcp("  活动代码页: 65001  "), 65001);
});

test("parseChcp: 空串/空白返回 null", () => {
  assert.equal(parseChcp(""), null);
  assert.equal(parseChcp("   "), null);
  assert.equal(parseChcp(null), null);
  assert.equal(parseChcp(undefined), null);
});

test("parseChcp: 乱格式返回 null", () => {
  assert.equal(parseChcp("hello world"), null);
  assert.equal(parseChcp("Active code page: abc"), null);
  assert.equal(parseChcp("code page: "), null);
  assert.equal(parseChcp("936"), null); // 缺少标签不是合法输出
});
