const test = require("node:test");
const assert = require("node:assert/strict");
const { decryptMD5, isObfuscatedMD5 } = require("../lib/md5");

// 全部样本取自真实网盘（2026-11 实测），并用引擎 meta 的真实 md5 交叉验证：
//   /med/1.py                          → a44978fbdbb3cc266c89dc5f3477a3c1
//   /med/.env                          → 4fe04a02127f218fdc76c3a14f10f712
//   实战项目合集/计算机视觉/智能车数据集.zip → d0cd30317ba1ec47fa46e98f9ff20c53
const OBSERVED = [
  ["da9089412te2b5143554e6a6e52211b0", "a44978fbdbb3cc266c89dc5f3477a3c1"],
  ["135c64e8cm4b87ed4e33b27555dd0e4e", "4fe04a02127f218fdc76c3a14f10f712"],
  ["4dc99d750g43b9d12b1eaa18824be69b", "89e8743e4cead8120be02b742a3def7f"],
  ["89bb3bf45ufabcd6e362cca9b833ce8c", "d751713988987e9331980363e24189ce"],
  ["7a82a9205p66fdde9ed1493473ed2460", "d0cd30317ba1ec47fa46e98f9ff20c53"],
  ["1f59302f4s97da3c9b761aac165b2bb1", "c53c17d31e7a75489ff0e65e9a555fcb"],
  ["22105f06ch0040f44411495c17cf0422", "48ab8d1b23331a619e64c9cd45320c3b"],
  ["49d26a0e6i4c775805a5fb9d57de708b", "ebe7bab748f12f69de75bd640486befa"],
  ["05d7fb376n0986a3f5f0d8d0e4b498cd", "eea24b4c04f4be506d1f5522f4d39db7"],
];

test("decryptMD5: 真实网盘混淆值全部正确还原", () => {
  for (const [obf, real] of OBSERVED) {
    assert.equal(decryptMD5(obf), real, "obf=" + obf);
  }
});

test("decryptMD5: 未混淆的 md5 原样返回（幂等）", () => {
  const real = "a44978fbdbb3cc266c89dc5f3477a3c1";
  assert.equal(decryptMD5(real), real);
  assert.equal(decryptMD5(decryptMD5(real)), real);
});

test("decryptMD5: 同一内容在不同路径的混淆值还原到同一个 md5", () => {
  // 这是去重成立的前提：实测这两个路径是同一份 12.3GB 的 zip
  const a = "7a82a9205p66fdde9ed1493473ed2460";
  const b = "7a82a9205p66fdde9ed1493473ed2460";
  assert.equal(decryptMD5(a), decryptMD5(b));
  // 反例：不同路径的混淆值不同，解密后必须相同
  const c = "49d26a0e6i4c775805a5fb9d57de708b";
  const d = "ebe7bab748f12f69de75bd640486befa";
  assert.equal(decryptMD5(c), d);
});

test("decryptMD5: 非法输入不抛异常", () => {
  assert.equal(decryptMD5(""), "");
  assert.equal(decryptMD5("short"), "short");
  assert.equal(decryptMD5(null), "");
  assert.equal(decryptMD5(undefined), "");
  assert.equal(decryptMD5("z".repeat(32)), "z".repeat(32));
});

test("isObfuscatedMD5: 混淆值第 10 位是非十六进制字符", () => {
  assert.equal(isObfuscatedMD5("da9089412te2b5143554e6a6e52211b0"), true);
  assert.equal(isObfuscatedMD5("a44978fbdbb3cc266c89dc5f3477a3c1"), false);
  assert.equal(isObfuscatedMD5("short"), false);
});
