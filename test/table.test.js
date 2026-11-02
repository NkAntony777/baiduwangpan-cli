const test = require("node:test");
const assert = require("node:assert/strict");
const table = require("../lib/table");

// BaiduPCS-Go v4.0.1 的 ls 真实输出（2026-11 实测）：
// 表头是**居中**的，数据单元格按类型对齐（数字右对齐/字符串左对齐），
// 因此表头与数据的列偏移并不一致 —— 不能按表头偏移切列。
const LS_OUTPUT = [
  "",
  "当前目录: /中医",
  "----",
  "  #     文件大小         修改日期                           文件(目录)                     ",
  "   0             -  2026-01-07 14:15:59  2025版药典/                                       ",
  "   1       239.34MB  2025-12-12 21:24:07  2025年版中国药典                                   ",
  "     总: 239.34MB                       文件总数: 1, 目录总数: 19",
  "----",
  "",
].join("\n");

const SEARCH_OUTPUT = [
  "  #     文件大小         修改日期                                                                                                                   路径                                                                                                              ",
  "   0        2.10MB  2025-11-19 22:32:40  /med/AI课程资料合集/人工智能行业报告/2015年报告.pdf                                                                                                                          ",
  "   1      129.49MB  2025-11-19 22:32:40  /med/AI课程资料合集/53份人工智能行业报告.zip                                                                                                                                ",
  "     总: 131.59MB                       文件总数: 2, 目录总数: 0                                                                                                                                          ",
  "----",
  "",
].join("\n");

test("parseLsTable: 目录行与文件行都能正确切分（不依赖表头偏移）", () => {
  const r = table.parseLsTable(LS_OUTPUT, "/中医");
  assert.equal(r.entries.length, 2, "应解析出 2 行");
  const d = r.entries[0];
  assert.equal(d.index, 0);
  assert.equal(d.name, "2025版药典");
  assert.equal(d.path, "/中医/2025版药典/");
  assert.equal(d.isDir, true);
  assert.equal(d.sizeText, null, "目录大小列为 '-' → null");
  assert.equal(d.size, null);
  assert.equal(d.mtimeText, "2026-01-07 14:15:59");
  assert.equal(typeof d.mtime, "number");
});

test("parseLsTable: 文件行的大小换算成字节", () => {
  const r = table.parseLsTable(LS_OUTPUT, "/中医");
  const f = r.entries[1];
  assert.equal(f.name, "2025年版中国药典");
  assert.equal(f.isDir, false);
  assert.equal(f.sizeText, "239.34MB");
  assert.equal(f.size, Math.round(239.34 * 1024 * 1024));
});

test("parseLsTable: 表尾汇总行被正确解析且不混进 entries", () => {
  const r = table.parseLsTable(LS_OUTPUT, "/中医");
  assert.equal(r.totalText, "239.34MB");
  assert.equal(r.fileCount, 1);
  assert.equal(r.dirCount, 19);
});

test("parseSearchTable: 路径列为完整路径，name 取 basename", () => {
  const r = table.parseSearchTable(SEARCH_OUTPUT);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].name, "2015年报告.pdf");
  assert.equal(r.entries[0].path, "/med/AI课程资料合集/人工智能行业报告/2015年报告.pdf");
  assert.equal(r.entries[0].size, Math.round(2.10 * 1024 * 1024));
  assert.equal(r.entries[1].name, "53份人工智能行业报告.zip");
  assert.equal(r.fileCount, 2);
  assert.equal(r.dirCount, 0);
});

test("parseEngineRow: 非数据行返回 null（表头/分隔线/汇总行）", () => {
  assert.equal(table.parseEngineRow("  #     文件大小         修改日期      文件(目录)"), null);
  assert.equal(table.parseEngineRow("----"), null);
  assert.equal(table.parseEngineRow("     总: 239.34MB   文件总数: 1, 目录总数: 19"), null);
  assert.equal(table.parseEngineRow(""), null);
});

test("parseSizeText: 单位换算", () => {
  assert.equal(table.parseSizeText("129B"), 129);
  assert.equal(table.parseSizeText("1KB"), 1024);
  assert.equal(table.parseSizeText("2.5MB"), Math.round(2.5 * 1024 * 1024));
  assert.equal(table.parseSizeText("-"), null);
});
