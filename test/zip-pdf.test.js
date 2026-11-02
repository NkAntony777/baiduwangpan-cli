const test = require("node:test");
const assert = require("node:assert/strict");
const zip = require("../lib/zip");
const pdf = require("../lib/pdf");
const zlib = require("zlib");

// ── 构造一个真实 ZIP ──────────────────────────────────────
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const data = Buffer.from(f.data, "utf-8");
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

test("zip: 解析中央目录得到全部成员", () => {
  const buf = makeZip([
    { name: "a.txt", data: "hello" },
    { name: "dir/b.txt", data: "world world" },
  ]);
  const entries = zip.readZipEntries(buf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "a.txt");
  assert.equal(entries[0].size, 5);
  assert.equal(entries[1].name, "dir/b.txt");
});

test("zip: 读取并解压单个成员", () => {
  const buf = makeZip([{ name: "a.txt", data: "hello zip" }]);
  const entries = zip.readZipEntries(buf);
  const content = zip.readZipMember(buf, entries[0]).toString("utf-8");
  assert.equal(content, "hello zip");
});

test("zip: 非 ZIP 数据不抛异常", () => {
  assert.deepEqual(zip.readZipEntries(Buffer.from("not a zip at all")), []);
  assert.equal(zip.parseCentralDirectory(Buffer.alloc(10), 0), null);
});

test("zip: ZIP64 标志（0xFFFFFFFF）走扩展字段", () => {
  const entries = zip.parseCentralDirectory(Buffer.alloc(64), 0);
  assert.equal(entries, null);
});

// ── PDF ──────────────────────────────────────────────────
test("pdf: 非 PDF 输入返回明确说明", () => {
  const r = pdf.extractText(Buffer.from("hello"));
  assert.equal(r.hasText, false);
  assert.ok(r.note);
});

test("pdf: 加密 PDF 被拒绝", () => {
  const buf = Buffer.from("%PDF-1.7\n/Encrypt 9 0 R\n%%EOF");
  const r = pdf.extractText(buf);
  assert.equal(r.hasText, false);
  assert.match(r.note, /加密/);
});

test("pdf: parseToUnicodeCMap 解析 bfchar", () => {
  const cmap = "begincmap\n2 beginbfchar\n<0102> <4E2D>\n<0103> <6587>\nendbfchar\nendcmap";
  const m = pdf.parseToUnicodeCMap(cmap);
  assert.equal(m.size, 2);
  assert.equal(m.get(0x0102), "中");
  assert.equal(m.get(0x0103), "文");
});

test("pdf: parseToUnicodeCMap 解析 bfrange 连续形式", () => {
  const cmap = "begincmap\n1 beginbfrange\n<0041> <0043> <0061>\nendbfrange\nendcmap";
  const m = pdf.parseToUnicodeCMap(cmap);
  assert.equal(m.get(0x41), "a");
  assert.equal(m.get(0x42), "b");
  assert.equal(m.get(0x43), "c");
});

test("pdf: parseToUnicodeCMap 解析 bfrange 数组形式", () => {
  const cmap = "begincmap\n1 beginbfrange\n<0041> <0043> [<0061> <0062> <0063>]\nendbfrange\nendcmap";
  const m = pdf.parseToUnicodeCMap(cmap);
  assert.equal(m.get(0x41), "a");
  assert.equal(m.get(0x43), "c");
});

test("pdf: hexToUnicode 按 UTF-16BE 解码", () => {
  assert.equal(pdf.hexToUnicode("4E2D6587"), "中文");
});
