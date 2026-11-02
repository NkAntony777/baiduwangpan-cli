const test = require("node:test");
const assert = require("node:assert/strict");
const { safeDownloadName } = require("../lib/group");

test("群文件下载名只留最后一段，.. 和斜杠写不出目录", () => {
  assert.equal(safeDownloadName("报告.pdf", "fallback"), "报告.pdf");
  assert.equal(safeDownloadName("..\\..\\sensitive.exe", "fallback"), "sensitive.exe");
  assert.equal(safeDownloadName("../../etc/passwd", "fallback"), "passwd");
  assert.equal(safeDownloadName("..", "fallback"), "fallback");
  assert.equal(safeDownloadName("a\u0000b.txt", "fallback"), "fallback");
});
