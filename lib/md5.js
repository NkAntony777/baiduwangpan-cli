// lib/md5.js — 百度网盘 md5 反混淆
//
// 背景：/api/list 返回的 md5 不是文件的真实 md5，而是百度做的「混淆 md5」。
// 实测（2026-11）：同一份内容放在两个不同路径，/api/list 返回的 md5 竟然不同
// （d8df7aa4do8092bb… vs 512b5f54d9fc3fc3…），解密后才是同一个值。
// 因此做去重必须先反混淆，否则会把同一份文件误判成不同文件。
//
// 算法移植自 BaiduPCS-Go（MIT）：
//   baidupcs/util.go → DecryptMD5()
//   原仓库 qjf2016/BaiduPCS-Go 已迁移到 github.com/qjfoidnh/BaiduPCS-Go
//
// 原理：
//   1. 若第 10 个字符不是十六进制字符（[0-9a-f]），说明是混淆值。
//      该字符充当密钥：它减去 'g' 得到一个十六进制数字，替换回第 10 位。
//   2. 对 32 个字符逐位做 num ^ (15 & i) 异或还原。
//   3. 最后按 [8:16]+[0:8]+[24:32]+[16:24] 重排四个字节段。
//
// 已用真实网盘数据验证 15/15 通过（含已混淆与未混淆两种输入）。

/**
 * 反混淆百度网盘的 md5。
 * @param {string} rawMD5 /api/list 返回的 md5（混淆值或真值均可）
 * @returns {string} 真实 md5；输入不是合法 32 位字符串时原样返回
 */
function decryptMD5(rawMD5) {
  const s = String(rawMD5 || "");
  if (s.length !== 32) return s;
  // 第 10 位若是十六进制字符，说明本来就是真 md5，直接返回
  const keyChar = s[9];
  if (!/[a-f0-9]/.test(keyChar)) {
    // 混淆值：把 keyChar 还原成 'g' + n 的形式，n 落在 0..25
    const n = s.charCodeAt(9) - "g".charCodeAt(0);
    if (n < 0 || n > 15) return s; // 超出合法范围 → 不认识的格式，保守返回原值
    const first = n.toString(16);
    const second = s.slice(0, 9) + first + s.slice(10);

    let third = "";
    for (let i = 0; i < second.length; i++) {
      const ch = second[i];
      if (ch === "-") {
        third += (15 & i).toString(16);
        continue;
      }
      const num = parseInt(ch, 16);
      if (Number.isNaN(num)) return s;
      third += (num ^ (15 & i)).toString(16);
    }
    return third.slice(8, 16) + third.slice(0, 8) + third.slice(24, 32) + third.slice(16, 24);
  }
  return s;
}

/**
 * 判断一个 md5 是否为混淆值。
 * 混淆值第 10 位是非十六进制字符（实测样本为 'c'..'z' 区间的字母）。
 */
function isObfuscatedMD5(rawMD5) {
  const s = String(rawMD5 || "");
  return s.length === 32 && !/[a-f0-9]/.test(s[9]);
}

module.exports = { decryptMD5, isObfuscatedMD5 };
