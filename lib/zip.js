// lib/zip.js — ZIP 中央目录解析（支持远程 Range 读取，只拉目录不下载全文件）
//
// 目标：预览压缩包/EPUB/Office 文档时，只需要「文件名 + 大小 + 压缩方式」，
// 不必下载整个包（用户的包里动辄 500 MB）。
// 做法：ZIP 的中央目录（Central Directory）在文件末尾，
// 通过 Range 请求读尾部 ~64KB 就能拿到目录表，再按需读取单个成员。
//
// 解析纯手写，不引入依赖；支持 ZIP64（超大包 >4GB 或 >65535 成员）。

const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * 解析 ZIP 尾部缓冲区，返回中央目录条目。
 * @param {Buffer} tailBuf 至少包含 EOCD 的尾部字节
 * @param {number} tailOffset tailBuf 在整个文件中的起始偏移
 * @returns {Array} 条目数组
 */
function parseCentralDirectory(tailBuf, tailOffset) {
  // 从后往前找 EOCD 签名
  let eocd = -1;
  const minPos = Math.max(0, tailBuf.length - 65557);
  for (let i = tailBuf.length - 22; i >= minPos; i--) {
    if (tailBuf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  let entryCount = tailBuf.readUInt16LE(eocd + 10);
  let cdSize = tailBuf.readUInt32LE(eocd + 12);
  let cdOffset = tailBuf.readUInt32LE(eocd + 16);

  // ZIP64：EOCD 里的字段是 0xFFFF/0xFFFFFFFF 时需从 ZIP64 EOCD 取真实值
  const needsZip64 =
    entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (needsZip64) {
    // 在 EOCD 之前找 ZIP64 EOCD locator
    for (let i = eocd - 20; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === EOCD64_LOCATOR_SIG) {
        const eocd64Offset = Number(tailBuf.readBigUInt64LE(i + 8));
        // ZIP64 EOCD 必须在 EOCD 之前；本函数只处理尾部缓冲，
        // 若 ZIP64 记录不在缓冲内则由调用方用额外 Range 补取。
        const rel = eocd64Offset - tailOffset;
        if (rel >= 0 && rel + 56 <= tailBuf.length && tailBuf.readUInt32LE(rel) === EOCD64_SIG) {
          entryCount = Number(tailBuf.readBigUInt64LE(rel + 32));
          cdSize = Number(tailBuf.readBigUInt64LE(rel + 40));
          cdOffset = Number(tailBuf.readBigUInt64LE(rel + 48));
        }
        break;
      }
    }
  }

  const entries = [];
  let p = cdOffset - tailOffset;
  if (p < 0) {
    // 中央目录起点不在尾部缓冲内（罕见），交由调用方补取
    return { entries: [], needCentralDirectory: true, cdOffset, cdSize, entryCount };
  }
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > tailBuf.length || tailBuf.readUInt32LE(p) !== CD_SIG) break;
    const flags = tailBuf.readUInt16LE(p + 8);
    const method = tailBuf.readUInt16LE(p + 10);
    const modTime = tailBuf.readUInt16LE(p + 12);
    const modDate = tailBuf.readUInt16LE(p + 14);
    const crc32 = tailBuf.readUInt32LE(p + 16);
    let compSize = tailBuf.readUInt32LE(p + 20);
    let uncompSize = tailBuf.readUInt32LE(p + 24);
    const nameLen = tailBuf.readUInt16LE(p + 28);
    const extraLen = tailBuf.readUInt16LE(p + 30);
    const commentLen = tailBuf.readUInt16LE(p + 32);
    let localOffset = tailBuf.readUInt32LE(p + 42);
    const nameBuf = tailBuf.slice(p + 46, p + 46 + nameLen);

    // UTF-8 标志位（bit 11）才按 UTF-8 解码，否则用 GBK（中文 zip 常见）
    const isUtf8 = (flags & 0x800) !== 0;
    const name = decodeName(nameBuf, isUtf8);

    // ZIP64 扩展字段
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = p + 46 + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const headerId = tailBuf.readUInt16LE(ex);
        const dataSize = tailBuf.readUInt16LE(ex + 2);
        if (headerId === 0x0001) {
          let q = ex + 4;
          if (uncompSize === 0xffffffff && q + 8 <= exEnd) {
            uncompSize = Number(tailBuf.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= exEnd) {
            compSize = Number(tailBuf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff && q + 8 <= exEnd) {
            localOffset = Number(tailBuf.readBigUInt64LE(q));
            q += 8;
          }
          break;
        }
        ex += 4 + dataSize;
      }
    }

    entries.push({
      name,
      method,
      compSize,
      size: uncompSize,
      localOffset,
      crc32,
      modTime,
      modDate,
      isUtf8,
      isDir: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, needCentralDirectory: false, cdOffset, cdSize, entryCount };
}

function decodeName(buf, isUtf8) {
  if (isUtf8) return buf.toString("utf-8");
  // 非 UTF-8 标志：先试 UTF-8（严格），失败再按 GBK
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("latin1");
    }
  }
}

/**
 * 解析「已知起始偏移与条目数」的中央目录。
 *
 * 用途：中央目录本身可能超过尾部窗口（DEFAULT_ZIP_TAIL = 128KB），
 * 此时 parseCentralDirectory 在尾部缓冲里找不到 EOCD 会返回 null。
 * 调用方可以按 EOCD 里记录的 cdOffset/cdSize/entryCount 精确拉取中央目录，
 * 再用本函数解析 —— 该缓冲区内没有 EOCD，但也不需要。
 *
 * @param {Buffer} buf  中央目录字节（起点即 cdOffset）
 * @param {number} entryCount 条目数
 * @returns {Array} 条目数组
 */
function parseCentralDirectoryEntries(buf, entryCount) {
  const entries = [];
  let p = 0;
  const total = entryCount || Number.MAX_SAFE_INTEGER;
  while (entries.length < total) {
    if (p + 46 > buf.length) break;
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc32 = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.slice(p + 46, p + 46 + nameLen);
    const isUtf8 = (flags & 0x800) !== 0;
    const name = decodeName(nameBuf, isUtf8);

    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = p + 46 + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const headerId = buf.readUInt16LE(ex);
        const dataSize = buf.readUInt16LE(ex + 2);
        if (headerId === 0x0001) {
          let q = ex + 4;
          if (uncompSize === 0xffffffff && q + 8 <= exEnd) {
            uncompSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= exEnd) {
            compSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff && q + 8 <= exEnd) {
            localOffset = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          break;
        }
        ex += 4 + dataSize;
      }
    }

    entries.push({
      name,
      method,
      compSize,
      size: uncompSize,
      localOffset,
      crc32,
      modTime,
      modDate,
      isUtf8,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
/**
 * 从本地文件头解析出成员数据的起始偏移与压缩方式。
 * @param {Buffer} lfhBuf 本地文件头 + 文件名 + 扩展字段
 */
function parseLocalFileHeader(lfhBuf) {
  if (lfhBuf.length < 30 || lfhBuf.readUInt32LE(0) !== LFH_SIG) return null;
  const nameLen = lfhBuf.readUInt16LE(26);
  const extraLen = lfhBuf.readUInt16LE(28);
  return {
    dataOffset: 30 + nameLen + extraLen,
    nameLen,
    extraLen,
  };
}

/**
 * 解压单个成员的数据块。
 * @param {Buffer} compData 压缩后的数据
 * @param {number} method 压缩方式（0=store, 8=deflate）
 */
const MAX_INFLATE_BYTES = 64 * 1024 * 1024; // 单成员解压上限 64MB（防 zip bomb）

/**
 * 解压单个成员的数据块。
 * @param {Buffer} compData 压缩后的数据
 * @param {number} method 压缩方式（0=store, 8=deflate）
 * @param {object} options { maxBytes } 解压上限，默认 64MB
 * @throws {Error} 超出上限时抛出，消息含明确上限
 */
function inflateMember(compData, method, options = {}) {
  const maxBytes = options.maxBytes || MAX_INFLATE_BYTES;
  if (method === METHOD_STORE) {
    if (compData.length > maxBytes) {
      throw new Error(
        'ZIP 成员解压后超过上限 ' + maxBytes + ' 字节（疑似 zip bomb）: ' +
        compData.length + ' 字节'
      );
    }
    return compData;
  }
  if (method === METHOD_DEFLATE) {
    // maxOutputLength 让 zlib 在超过上限时立即停止并报错，而不是先分配超大缓冲
    try {
      return zlib.inflateRawSync(compData, { maxOutputLength: maxBytes });
    } catch (e) {
      const msg = String((e && e.message) || e);
      // zlib 的 maxOutputLength 报错信息各版本措辞不同
      // （"Cannot create a Buffer larger than N bytes" / "output length exceeded"），
      // 这里宽松匹配，避免漏判导致 zip bomb 绕过。
      if (/maxOutputLength|output length|larger than|Cannot create a Buffer/i.test(msg)) {
        throw new Error(
          'ZIP 成员解压后超过上限 ' + maxBytes + ' 字节（疑似 zip bomb）: ' + msg
        );
      }
      throw e;
    }
  }
  throw new Error('不支持的压缩方式: ' + method + '（仅支持 store/deflate）');
}


/**
 * 解析 ZIP 中央目录（纯本地 Buffer，整包已在内存时用）。
 */
function readZipEntries(buf) {
  const tailLen = Math.min(buf.length, 66560);
  const tail = buf.slice(buf.length - tailLen);
  const parsed = parseCentralDirectory(tail, buf.length - tailLen);
  if (!parsed || parsed.needCentralDirectory) return [];
  return parsed.entries;
}

/**
 * 读取 ZIP 中某个成员的内容（整包已在内存时用）。
 */
function readZipMember(buf, entry) {
  const lfh = parseLocalFileHeader(buf.slice(entry.localOffset, entry.localOffset + 30 + 512));
  if (!lfh) throw new Error("ZIP 本地文件头损坏: " + entry.name);
  const start = entry.localOffset + lfh.dataOffset;
  const end = start + entry.compSize;
  return inflateMember(buf.slice(start, end), entry.method);
}

module.exports = {
  parseCentralDirectoryEntries,
  MAX_INFLATE_BYTES,
  parseCentralDirectory,
  parseLocalFileHeader,
  inflateMember,
  readZipEntries,
  readZipMember,
  METHOD_STORE,
  METHOD_DEFLATE,
};
