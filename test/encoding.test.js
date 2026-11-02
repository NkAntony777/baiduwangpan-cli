const test = require("node:test");
const assert = require("node:assert/strict");
const pan = require("../lib/pan");

// GBK 字节（"中文" = D6D0 CEC4）
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);

test("decodeText: GBK 字节被正确解码（旧实现会返回乱码）", () => {
  const t = pan.decodeText(GBK_ZHONGWEN);
  assert.equal(t, "中文");
});

test("decodeText: UTF-8 文本原样返回", () => {
  const t = pan.decodeText(Buffer.from("台湾土地制度考查报告书", "utf-8"));
  assert.equal(t, "台湾土地制度考查报告书");
});

test("decodeText: 合法 GBK 长文本不应出现替换字符（旧实现 75% 是 U+FFFD）", () => {
  // 真实古籍片段的 GBK 字节（"台湾土地制度考查报告书\r\n"）
  const gbk = Buffer.from([
    0xcc, 0xa8, 0xcd, 0xe5, 0xcd, 0xc1, 0xb5, 0xd8, 0xd6, 0xc6, 0xb6, 0xc8,
    0xbf, 0xbc, 0xb2, 0xe9, 0xba, 0xaf, 0xb1, 0xa8, 0xca, 0xe9, 0x0d, 0x0a,
  ]);
  // 与参考解码器（宽松 gbk）结果一致 —— 自校验，不依赖手写字节的记忆
  const reference = new TextDecoder("gbk").decode(gbk);
  const t = pan.decodeText(gbk);
  assert.equal(t, reference);
  assert.match(t, /^台湾土地制度考查/, "应还原为可读中文");
  assert.ok(!t.includes("\uFFFD"), "不应含替换字符");
});

test("decodeTextWithEncoding: 报告实际使用的编码", () => {
  assert.equal(pan.decodeTextWithEncoding(GBK_ZHONGWEN).encoding, "gbk");
  assert.equal(pan.decodeTextWithEncoding(Buffer.from("abc", "utf-8")).encoding, "utf-8");
});

test("decodeText: 空 buffer / string 输入不崩", () => {
  assert.equal(pan.decodeText(Buffer.alloc(0)), "");
  assert.equal(pan.decodeText("abc"), "abc");
});

test("detectEngineError: 识别引擎错误码并给出 errno", () => {
  const e = pan.detectEngineError("获取目录下的文件列表: 遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件或目录不存在\n");
  assert.ok(e, "应识别为错误");
  assert.equal(e.errno, 31066);
  assert.match(e.message, /文件或目录不存在/);
});

test("detectEngineError: 正常输出不误报", () => {
  assert.equal(pan.detectEngineError("当前目录: /\n----\n  #  文件大小  文件(目录)\n"), null);
  assert.equal(pan.detectEngineError(""), null);
});

test("detectEngineError: 识别无错误码的失败信号", () => {
  assert.ok(pan.detectEngineError("警告: 遍历错误: CreateFile x: 系统找不到文件\n未检测到上传的文件.\n"));
  assert.ok(pan.detectEngineError("操作失败, 以下文件/目录删除失败:"));
});

test("编码: Range 截断在多字节字符中间时不产生替换字符", () => {
  // GBK「中文」= d6 d0 ce c4；截断到 3 字节 = 「中」+半个「文」
  const full = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const cut = full.slice(0, 3);
  const d = pan.decodeTextWithEncoding(cut);
  assert.ok(!d.text.includes("\uFFFD"), "不应含替换字符: " + JSON.stringify(d.text));
  assert.equal(d.text, "中");
});

test("编码: 完整的 GBK 双字节文本不被裁剪", () => {
  const full = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const d = pan.decodeTextWithEncoding(full);
  assert.equal(d.text, "中文");
  assert.equal(d.encoding, "gbk");
});

test("编码: UTF-8 截断在中文中间时也不产生替换字符", () => {
  const cut = Buffer.from([0xe4, 0xb8, 0xad]); // 「中」缺第三字节
  const d = pan.decodeTextWithEncoding(cut);
  assert.ok(!d.text.includes("\uFFFD"), "不应含替换字符: " + JSON.stringify(d.text));
});

test("编码: ASCII 与完整 UTF-8 原样返回", () => {
  assert.equal(pan.decodeTextWithEncoding(Buffer.from("hello", "utf-8")).text, "hello");
  assert.equal(pan.decodeTextWithEncoding(Buffer.from("中医知识", "utf-8")).text, "中医知识");
});
