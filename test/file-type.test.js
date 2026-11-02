const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFileType, magicType, hasNul, extOf } = require("../lib/file-type");

test("detectFileType: PDF 魔数 → pdf + binary", () => {
  const r = detectFileType(Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n1 0 obj"), "报告.pdf");
  assert.equal(r.type, "pdf");
  assert.equal(r.binary, true);
  assert.equal(r.reason, "magic:pdf");
});

test("detectFileType: ZIP 容器按扩展名细分（docx/xlsx/pptx/epub）", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.equal(detectFileType(zip, "a.docx").type, "docx");
  assert.equal(detectFileType(zip, "a.xlsx").type, "xlsx");
  assert.equal(detectFileType(zip, "a.epub").type, "epub");
  assert.equal(detectFileType(zip, "a.zip").type, "zip");
  assert.equal(detectFileType(zip, "a.zip").binary, true);
});

test("detectFileType: 图片/音视频按扩展名判为 binary", () => {
  assert.equal(detectFileType(Buffer.from("plain"), "a.png").binary, true);
  assert.equal(detectFileType(Buffer.from("plain"), "a.mp4").binary, true);
  assert.equal(detectFileType(Buffer.from("plain"), "a.mp3").binary, true);
});

test("detectFileType: 含 NUL 字节 → binary（纯文本几乎不会出现 NUL）", () => {
  const r = detectFileType(Buffer.from([0x68, 0x65, 0x00, 0x6c]), "a.bin");
  assert.equal(r.binary, true);
  assert.equal(r.reason, "nul-byte");
});

test("detectFileType: 普通文本 → text + 非 binary", () => {
  const r = detectFileType(Buffer.from("台湾土地制度考查报告书", "utf-8"), "a.txt");
  assert.equal(r.type, "text");
  assert.equal(r.binary, false);
});

test("detectFileType: GBK 编码的中文文本不是二进制", () => {
  const gbk = Buffer.from([0xcc, 0xe8, 0xcd, 0xf5, 0xcd, 0xf9, 0xb5, 0xd8]);
  const r = detectFileType(gbk, "古籍.txt");
  assert.equal(r.binary, false, "GBK 中文不应被判为二进制");
});

test("magicType / hasNul / extOf 基础行为", () => {
  assert.equal(magicType(Buffer.from("%PDF")), "pdf");
  assert.equal(magicType(Buffer.from("hello")), null);
  assert.equal(hasNul(Buffer.from("ab")), false);
  assert.equal(hasNul(Buffer.from([0x00])), true);
  assert.equal(extOf("/a/b/c.TXT"), "txt");
  assert.equal(extOf("/a/b/noext"), "");
});
