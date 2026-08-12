const http = require("./http");
const { getBdstoken } = http;
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { matchesName: matchName } = require("./name-match");

// ── 常量（逆向实测结论）────────────────────────────────
const MAX_PAGE_SIZE = 100;         // shareinfo 服务端每页硬上限（num>100 不返回更多）
const MAX_LIST_SHARE_PAGES = 10;   // listshare 分页上限（10 页 × 50 条消息）
const DIR_CACHE_TTL = 1800000;     // 目录列表缓存 30 分钟（群文件树很少变动）
const EMPTY_DIR_CACHE_TTL = 60000; // 空目录缓存 1 分钟（限流时 API 可能返回空列表，短 TTL 防缓存投毒）
const SHARE_CACHE_TTL = 300000;    // 群分享列表缓存 5 分钟（新分享消息较频繁）
const DEFAULT_MAX_REQUESTS = 400;  // 单条命令 shareinfo 请求预算（防深扫失控触发限流）

// ── 会话级缓存（内存 L1 + 磁盘 L2，跨命令复用）──────────
const cacheStore = new Map();

function cacheDir() {
  return process.env.BDP_CACHE_DIR || path.join(os.homedir(), ".bdp", "cache");
}

function cachePath(key) {
  return path.join(cacheDir(), crypto.createHash("sha1").update(key).digest("hex") + ".json");
}

function cacheGet(key) {
  const entry = cacheStore.get(key); // L1
  if (entry) {
    if (Date.now() - entry.at <= entry.ttl) return entry.value;
    cacheStore.delete(key);
  }
  try {
    // L2: 磁盘缓存（跨 CLI 进程复用，避免重复扫描触发限流）
    const disk = JSON.parse(fs.readFileSync(cachePath(key), "utf-8"));
    if (Date.now() - disk.at <= disk.ttl) {
      cacheStore.set(key, { at: disk.at, ttl: disk.ttl, value: disk.value });
      return disk.value;
    }
    fs.unlinkSync(cachePath(key));
  } catch {}
  return null;
}

function cacheSet(key, value, ttl) {
  cacheStore.set(key, { at: Date.now(), ttl, value });
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), ttl, value }), "utf-8");
  } catch {}
}

function clearGroupCache() {
  cacheStore.clear();
  try {
    fs.rmSync(cacheDir(), { recursive: true, force: true });
  } catch {}
}

// ── 工具 ──────────────────────────────────────────────

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

// 安全解码：部分群文件路径含非法百分号编码（裸 % 等），decodeURIComponent 会抛 URIError
// 导致整个目录扫描失败（实测 30/349 目录因此报废）。失败时回退原始字符串。
function safeDecode(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class ShareApiError extends Error {
  constructor(errno, message) {
    super(message);
    this.errno = errno;
    this.name = "ShareApiError";
  }
}

// errno=2131 的详细说明（bdp error 2131 与 gls 报错共用）
function describeErrno2131(gidS, msgIdS) {
  return (
    `shareinfo 请求被拒: msg_id ${msgIdS} 不属于群 ${gidS} 的任何分享（errno=2131）。` +
    `群分享参数必须同源：gid 与 --from-uk/--msg-id/--parent-fs-id 应来自同一次 gshares/gsearch 结果。` +
    `处理：运行 bdp gshares ${gidS} 查看本群分享（或 bdp gsearch ${gidS} <关键词>），` +
    `取其中一行的 fsId/fromUk/msgId 重试；fsId 为子目录时保持同一行的 fromUk/msgId。`
  );
}

// 限流退化检测：shareinfo 被限流时 errno=0 但返回"目录自身"而非子项。
// 目录不可能包含自身，故返回列表里出现请求 fs_id 即可判定为退化响应。
function isSelfEcho(data, fsIdS) {
  const records = data.records;
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.some((r) => toStr(r.fs_id) === toStr(fsIdS));
}

// ── 群组列表 ──────────────────────────────────────────

async function listGroups() {
  const bdstoken = await getBdstoken();
  if (!bdstoken) throw new Error("无法获取 bdstoken — 请检查 BDUSS/STOKEN 配置（或重新执行 bdp login）");

  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/group/list?clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`
  );

  if (data.errno !== 0) throw new Error(`API 返回错误: errno=${data.errno}（可运行 bdp error ${data.errno} 查看含义）`);

  return (data.records || []).map((g) => ({
    gid: toStr(g.gid),
    name: g.name,
    gnum: toStr(g.gnum),
    description: g.gdesc || "",
    type: toStr(g.type),
    created: g.ctime,
  }));
}

// ── 群内分享库 ────────────────────────────────────────

async function listShares(gid, options = {}) {
  const gidS = toStr(gid);
  const cache = options.cache === true;
  const ttlMs = options.ttlMs || SHARE_CACHE_TTL;
  const key = `shares:${gidS}`;

  if (cache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const bdstoken = await getBdstoken();
  const shares = [];
  const seenMsg = new Set();
  let cursor = "";
  let stop = false;

  // has_more=1 时用 last_msg_time 游标翻页（desc 序）；无新消息/无游标则停止
  for (let page = 0; page < MAX_LIST_SHARE_PAGES && !stop; page++) {
    const url =
      `${http.PAN_BASE}/mbox/group/listshare?clienttype=0&app_id=${http.APP_ID}&web=1&type=2&gid=${gidS}` +
      `&limit=50&desc=1${cursor ? `&last_msg_time=${cursor}` : ""}&bdstoken=${bdstoken}`;
    const data = await http.webJson(url, { method: "POST", body: "" });

    if (data.errno !== 0) throw new Error(`API 返回错误: errno=${data.errno}（可运行 bdp error ${data.errno} 查看含义）`);

    let added = 0;
    for (const msg of data.records?.msg_list || []) {
      const mid = toStr(msg.msg_id);
      if (seenMsg.has(mid)) continue; // 防重复页
      seenMsg.add(mid);
      added++;
      for (const f of msg.file_list || []) {
        shares.push({
          msgId: mid,
          fromUk: toStr(msg.uk),
          fromUser: msg.uname,
          name: safeDecode(f.path || f.server_filename || ""),
          fsId: toStr(f.fs_id),
          isDir: f.isdir === "1",
          size: parseInt(f.size || "0", 10),
        });
      }
    }

    if (data.has_more !== 1 || added === 0) stop = true;
    else cursor = toStr(data.last_msg_time || "");
    if (!cursor) stop = true;
  }

  if (cache) cacheSet(key, shares, ttlMs);
  return shares;
}

// ── 底层 shareinfo 请求 ───────────────────────────────

function mapShareInfoFile(f, parentFsId, fromUkS, msgIdS) {
  return {
    name: f.server_filename || "",
    path: safeDecode(f.path || ""),
    isDir: f.isdir === 1 || f.isdir === "1",
    size: parseInt(f.size || "0", 10),
    fsId: toStr(f.fs_id),
    md5: f.md5 || "",
    category: parseInt(f.category || "0", 10),
    ctime: toStr(f.server_ctime || ""),
    mtime: toStr(f.server_mtime || ""),
    parentFsId,
    fromUk: fromUkS,
    msgId: msgIdS,
  };
}

// 单页 shareinfo；errno!=0 抛 ShareApiError；限流退化（self-echo）标记 throttled
async function shareInfoRaw(gidS, fsIdS, fromUkS, msgIdS, page, pageSize) {
  const bdstoken = await getBdstoken();
  const url =
    `${http.PAN_BASE}/mbox/msg/shareinfo?type=2&from_uk=${fromUkS}&msg_id=${msgIdS}` +
    `&to_uk=0&num=${pageSize}&page=${page}&fs_id=${fsIdS}&gid=${gidS}` +
    `&clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`;

  const data = await http.webJson(url, { method: "POST", body: "" });

  if (data.errno !== 0) {
    throw new ShareApiError(data.errno, `API 返回错误: errno=${data.errno}（可运行 bdp error ${data.errno} 查看含义）`);
  }
  if (isSelfEcho(data, fsIdS)) {
    const e = new ShareApiError(-3, `shareinfo 被限流（self-echo）: fs_id ${fsIdS}`);
    e.throttled = true;
    throw e;
  }
  return data;
}

// 限流/瞬时错误退避重试：2s → 4s → 2 次后放弃。
//  - 网络/连接错误（非 ShareApiError）：本地瞬时故障，重试（实测并发扫描中 API 会随机断连）
//  - self-echo 限流：重试，但受 throttleState 上限约束（consecutive≥3 停止扫描 / total≥5 不再重试）
//  - 硬 errno（-3/2131 等）：不重试（listFiles 有 page-size 降级链处理 -3）
// budget 为整条命令的请求预算，耗尽后拒绝新请求（防深扫失控）。
async function shareInfoRawWithRetry(gidS, fsIdS, fromUkS, msgIdS, page, pageSize, budget, throttleState) {
  if (budget) {
    if (budget.remaining <= 0) throw new ShareApiError(-3, "shareinfo 请求预算已耗尽，请增大 --max-requests 或稍后重跑");
    budget.remaining--;
  }
  let attempts = 0;
  for (;;) {
    try {
      const data = await shareInfoRaw(gidS, fsIdS, fromUkS, msgIdS, page, pageSize);
      if (throttleState) throttleState.consecutive = 0;
      return data;
    } catch (e) {
      const isThrottled = e instanceof ShareApiError && e.throttled;
      const isNetwork = !(e instanceof ShareApiError);
      if (!isThrottled && !isNetwork) throw e;
      if (isThrottled && throttleState) {
        throttleState.consecutive = (throttleState.consecutive || 0) + 1;
        throttleState.total = (throttleState.total || 0) + 1;
      }
      const maxRetries = isThrottled && throttleState && (throttleState.consecutive >= 3 || throttleState.total >= 5) ? 0 : 2;
      if (attempts >= maxRetries) throw e;
      attempts++;
      await delay(2000 * attempts);
    }
  }
}

// 单页 shareinfo（gls 用），带限流退避
async function shareInfoRequest(gidS, fsIdS, fromUkS, msgIdS, page, pageSize) {
  const data = await shareInfoRawWithRetry(gidS, fsIdS, fromUkS, msgIdS, page, pageSize);
  const files = (Array.isArray(data.records) ? data.records : []).map((f) =>
    mapShareInfoFile(f, fsIdS, fromUkS, msgIdS)
  );
  return { files, hasMore: data.has_more === 1, page, pageSize };
}

// 全量拉取目录内容（gsearch/gtree 用）：自动翻页 + 去重 + 缓存。
// 逆向实测：shareinfo 每页硬上限 100，has_more=1 时 page=N 可继续翻页；
// 旧实现只取 page=1，超过 100 子项的目录会漏数据。
async function fetchShareDir({ gidS, fsIdS, fromUkS, msgIdS, maxPages = 50, cache = false, ttlMs = DIR_CACHE_TTL, budget, throttleState }) {
  const key = `dir:${gidS}:${fsIdS}:${fromUkS}:${msgIdS}`;
  if (cache) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  const files = [];
  const seenFs = new Set();
  let hasMore = false;
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const data = await shareInfoRawWithRetry(gidS, fsIdS, fromUkS, msgIdS, page, MAX_PAGE_SIZE, budget, throttleState);
    const records = Array.isArray(data.records) ? data.records : [];
    for (const f of records) {
      const fsId = toStr(f.fs_id);
      if (seenFs.has(fsId)) continue;
      seenFs.add(fsId);
      files.push(mapShareInfoFile(f, fsIdS, fromUkS, msgIdS));
    }
    hasMore = data.has_more === 1;
    pages = page;
    if (!hasMore || records.length === 0) break;
  }

  const result = { files, hasMore, pages, truncated: pages >= maxPages };
  // 空目录用短 TTL 缓存：限流时 API 可能返回空列表（缓存投毒会导致静默丢数据）
  if (cache) cacheSet(key, result, files.length === 0 ? EMPTY_DIR_CACHE_TTL : ttlMs);
  return { ...result, cached: false };
}

// ── 列出分享库内容 (gls) ──────────────────────────────

async function listFiles(gid, fsId, options = {}) {
  const gidS = toStr(gid);
  const fsIdS = toStr(fsId);
  const parentFsId = toStr(options.parentFsId || "");
  const page = options.page || 1;
  let pageSize = options.pageSize || 50;
  pageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const cache = options.cache === true;

  // 来源解析：显式传入优先；否则仅在顶层分享中精确匹配（禁止"用第一个分享"兜底）
  let fromUkS = toStr(options.fromUk || "");
  let msgIdS = toStr(options.msgId || "");

  if (!fromUkS || !msgIdS) {
    const shares = await listShares(gidS, { cache });
    const match = shares.find((s) => s.fsId === fsIdS);
    if (!match) {
      throw new Error(
        `无法确定 fsId ${fsIdS}（不是顶层分享）。` +
        `请显式传入 --from-uk 与 --msg-id。`
      );
    }
    fromUkS = match.fromUk;
    msgIdS = match.msgId;
  }

  // errno=-3 时依次降 page-size: 50 → 20 → 10
  const attempts = [...new Set([pageSize, 50, 20, 10].filter((n) => n <= pageSize))];
  let lastErrno = null;

  for (const size of attempts) {
    try {
      const result = await shareInfoRequest(gidS, fsIdS, fromUkS, msgIdS, page, size);
      return {
        files: result.files,
        hasMore: result.hasMore,
        page,
        pageSize: size,
        fromUk: fromUkS,
        msgId: msgIdS,
        fallback: null,
      };
    } catch (e) {
      if (e instanceof ShareApiError && e.errno === -3) {
        lastErrno = -3;
        continue; // 尝试更小的 page-size
      }
      if (e instanceof ShareApiError && e.errno === 2131) {
        // msg_id 不属于该群（常见：gid 与参数来自不同群/分享库）。
        // 尝试按 fsId 从本群 gshares 自动解析纠正一次；失败则给出明确指引。
        try {
          const shares = await listShares(gidS, { cache });
          const match = shares.find((s) => s.fsId === fsIdS);
          if (match) {
            const result = await shareInfoRequest(gidS, fsIdS, match.fromUk, match.msgId, page, size);
            return {
              files: result.files,
              hasMore: result.hasMore,
              page,
              pageSize: size,
              fromUk: match.fromUk,
              msgId: match.msgId,
              fallback: null,
              autoResolved: true,
            };
          }
        } catch {}
        throw new ShareApiError(2131, describeErrno2131(gidS, msgIdS));
      }
      throw e;
    }
  }

  // 全部 page-size 都失败（errno=-3）→ 回退
  if (parentFsId) {
    // 回退到父目录，展示兄弟内容帮助 Agent 换路径
    try {
      const parent = await shareInfoRequest(gidS, toStr(parentFsId), fromUkS, msgIdS, 1, 50);
      return {
        files: parent.files,
        hasMore: parent.hasMore,
        page: 1,
        pageSize: 50,
        fromUk: fromUkS,
        msgId: msgIdS,
        fallback: {
          reason: "errno=-3",
          requestedFsId: fsIdS,
          resolvedFsId: toStr(parentFsId),
          level: "parent",
        },
      };
    } catch (e) {
      throw new ShareApiError(
        -3,
        `shareinfo 请求被拒: fsId ${fsIdS}（errno=-3），且回退父目录也失败。` +
        `分享可能已过期，或目录过大超出接口限制。`
      );
    }
  }

  // 目标本身是顶层分享 → 退回 gshares 结果
  try {
    const shares = await listShares(gidS, { cache });
    const match = shares.find((s) => s.fsId === fsIdS);
    if (match) {
      return {
        files: [{
          name: match.name,
          path: match.name,
          isDir: match.isDir,
          size: match.size,
          fsId: match.fsId,
          md5: "",
          category: 0,
          ctime: "",
          mtime: "",
          parentFsId: "",
          fromUk: match.fromUk,
          msgId: match.msgId,
        }],
        hasMore: false,
        page: 1,
        pageSize: 50,
        fromUk: fromUkS,
        msgId: msgIdS,
        fallback: {
          reason: "errno=-3",
          requestedFsId: fsIdS,
          resolvedFsId: fsIdS,
          level: "group-shares",
        },
      };
    }
  } catch {}

  throw new ShareApiError(
    -3,
    `shareinfo 请求被拒: fsId ${fsIdS}（errno=-3）。` +
    `群分享 API 拒绝请求：已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁都可能触发。` +
    `请减小 --page-size，稍后重试，或携带 gsearch 返回的 fromUk/msgId/parentFsId 信息重试。`
  );
}

// ── 群文件下载 (gdownload) ─────────────────────────────
//
// 逆向结论（2026-08-12）：
//   - /mbox/msg/transfer 转存已被百度拒绝（非空目录一律 errno=-10，UI 已移除保存按钮）
//   - 新版 IM 前端的下载链路是 POST /api/sharedownload?sign=&timestamp=
//     （sign/timestamp 留空即可），product=mbox 参数族，登录态直接返回可下载的 dlink
//   - dlink 有 8 小时有效期；只支持单文件（目录 fs_id 返回的 dlink 为空）

// 解析 fs_id 的来源（fromUk/msgId）：显式优先；顶层分享自动解析；否则报错提示
// 复用逻辑与 listFiles 一致，保证 gdownload 与 gls/gsearch 参数同源
async function resolveShareSource(gidS, fsIdS, options = {}, { cache }) {
  let fromUkS = toStr(options.fromUk || "");
  let msgIdS = toStr(options.msgId || "");
  if (!fromUkS || !msgIdS) {
    const shares = await listShares(gidS, { cache });
    const match = shares.find((s) => s.fsId === fsIdS);
    if (!match) {
      throw new Error(
        `无法确定 fsId ${fsIdS}（不是顶层分享）。` +
        `请显式传入 --from-uk 与 --msg-id（可用 bdp gsearch <gid> <关键词> --json 获取）。`
      );
    }
    fromUkS = match.fromUk;
    msgIdS = match.msgId;
  }
  return { fromUk: fromUkS, msgId: msgIdS };
}

// 获取群文件直链。返回 { dlink, name, size, isDir, md5, path, fsId, fromUk, msgId }
async function getShareDlink(gid, fsId, options = {}) {
  const gidS = toStr(gid);
  const fsIdS = toStr(fsId);
  const cache = options.cache === true;

  const { fromUk, msgId } = await resolveShareSource(gidS, fsIdS, options, { cache });
  const bdstoken = await getBdstoken();
  const url = `${http.PAN_BASE}/api/sharedownload?sign=&timestamp=&clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`;
  const body = new URLSearchParams({
    uk: fromUk,
    product: "mbox",
    encrypt: "0",
    primaryid: msgId,
    fid_list: JSON.stringify([fsIdS]),
    extra: JSON.stringify({ type: "group", gid: gidS }),
  }).toString();

  const data = await http.webJson(url, { method: "POST", body });
  if (data.errno !== 0) {
    throw new Error(`API 返回错误: errno=${data.errno}（msg_id ${msgId} 不属于群 ${gidS}，或分享已失效）`);
  }
  const item = (data.list || [])[0];
  if (!item) throw new Error(`未能获取 fsId ${fsIdS} 的文件信息`);

  const result = {
    dlink: item.dlink || "",
    name: item.server_filename || "",
    size: parseInt(item.size || "0", 10),
    isDir: item.isdir === 1 || item.isdir === "1",
    md5: item.md5 || "",
    path: safeDecode(item.path || ""),
    fsId: toStr(item.fs_id),
    fromUk,
    msgId,
  };
  // 目录的 dlink 为无效串（实测 "&clienttype=0"），先于 dlink 判空检查
  if (result.isDir) {
    throw new Error(
      `fsId ${fsIdS} 是目录（${result.name}）。sharedownload 只支持单文件下载。` +
      `请用 bdp gls <gid> <fs_id> 或 bdp gsearch <gid> <关键词> 找到具体文件后下载。`
    );
  }
  if (!result.dlink) {
    throw new Error(`未能获取 fsId ${fsIdS} 的下载链接（分享可能已失效，或分享者禁止下载）`);
  }
  return result;
}

// 下载群文件到本地。options: { outDir, filename, fromUk, msgId, ua }
// 返回 { path, name, size, dlink, fromUk, msgId }
async function downloadFile(gid, fsId, options = {}) {
  const info = await getShareDlink(gid, fsId, options);
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");

  const outDir = options.outDir || process.cwd();
  const filename = options.filename || info.name || `fs_${info.fsId}`;
  const outPath = path.join(outDir, filename);

  fs.mkdirSync(outDir, { recursive: true });
  // dlink 校验 UA：netdisk 客户端 UA 会返回 118 字节错误页，浏览器 UA 正常（实测）
  const args = [
    "-s", "-L",
    "-H", `User-Agent: ${options.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}`,
    "-o", outPath,
    "--max-time", String(options.timeoutSec || 3600),
    info.dlink,
  ];
  const result = spawnSync("curl", args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: (options.timeoutSec || 3600) * 1000 });
  if (result.error) throw new Error(`下载失败: ${result.error.message}`);

  let size = 0;
  try { size = fs.statSync(outPath).size; } catch {}
  if (info.size && size !== info.size) {
    throw new Error(
      `下载大小不匹配: 实际 ${size} 字节，预期 ${info.size} 字节。` +
      `dlink 可能已过期（有效期 8 小时），请重试。`
    );
  }
  return { path: outPath, name: filename, size, dlink: info.dlink, fromUk: info.fromUk, msgId: info.msgId };
}

// ── 群文件批量打包下载 (gdownload 多 fs_id → zip) ───────
//
// 逆向结论（2026-08-12 实测）：
//   - sharedownload 单文件 >~20MB 时返回加密 list（无法解密，key 未破解）
//   - type=batch 时返回明文 zip 打包链接（method=batchdownload&zipcontent=...），
//     小文件打包实测可用（10MB zip 完整下载）；超大文件报 error_code=31090 "package is too large"
//   - zip 打包按 msg_id 归组：所有 fs_id 必须属于同一条分享消息

// 获取多文件 zip 打包直链。options: { fromUk, msgId, cache }
async function getShareZipDlink(gid, fsIds, options = {}) {
  const gidS = toStr(gid);
  const fsIdList = fsIds.map(toStr);
  if (fsIdList.length < 2) throw new Error(`zip 打包下载需要至少 2 个 fs_id（当前传入 ${fsIdList.length} 个）`);

  // 来源以第一个 fs_id 为准（其余视为同一分享消息内的文件）
  const { fromUk, msgId } = await resolveShareSource(gidS, fsIdList[0], options, { cache: options.cache === true });
  const bdstoken = await getBdstoken();
  const url = `${http.PAN_BASE}/api/sharedownload?sign=&timestamp=&clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`;
  const body = new URLSearchParams({
    uk: fromUk,
    product: "mbox",
    encrypt: "0",
    type: "batch",
    primaryid: msgId,
    fid_list: JSON.stringify(fsIdList),
    extra: JSON.stringify({ type: "group", gid: gidS }),
  }).toString();

  const data = await http.webJson(url, { method: "POST", body });
  if (data.errno !== 0) {
    throw new Error(`API 返回错误: errno=${data.errno}（zip 批量打包）`);
  }
  if (!data.dlink) {
    throw new Error(`未能为 ${fsIdList.length} 个文件获取 zip 打包链接（分享可能已失效）`);
  }
  return { dlink: data.dlink, fromUk, msgId, count: fsIdList.length };
}

// 批量打包下载。options: { outDir, filename, fromUk, msgId, ua }
async function downloadFiles(gid, fsIds, options = {}) {
  const { dlink, fromUk, msgId, count } = await getShareZipDlink(gid, fsIds, options);
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");

  const outDir = options.outDir || process.cwd();
  const filename = options.filename || `bdp-group-${count}files.zip`;
  const outPath = path.join(outDir, filename);

  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    "-s", "-L",
    "-H", `User-Agent: ${options.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}`,
    "-o", outPath,
    "--max-time", String(options.timeoutSec || 7200),
    dlink,
  ];
  const result = spawnSync("curl", args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: (options.timeoutSec || 7200) * 1000 });
  if (result.error) throw new Error(`下载失败: ${result.error.message}`);

  let size = 0;
  try { size = fs.statSync(outPath).size; } catch {}
  if (size === 0) {
    throw new Error(`zip 下载失败（0 字节）。dlink 可能已过期，或打包总大小超过上限（error_code 31090，可用 bdp error 31090 查询）`);
  }
  return { path: outPath, name: filename, size, dlink, fromUk, msgId, count };
}

// ── 目录树 (gtree) ────────────────────────────────────

async function treeFiles(gid, options = {}) {
  const gidS = toStr(gid);
  const maxDepth = Math.min(Math.max(1, options.depth || 2), 5);
  const concurrency = Math.min(Math.max(1, options.concurrency || 4), 8);
  const maxNodes = options.maxNodes || 2000;
  const maxPages = Math.min(Math.max(1, options.maxPages || 50), 200);
  const cache = options.cache === true;
  const budget = { remaining: Math.min(Math.max(1, options.maxRequests || DEFAULT_MAX_REQUESTS), 2000) };
  const throttleState = { consecutive: 0 };

  const shares = await listShares(gidS, { cache });
  const tree = [];
  const failed = [];

  // BFS: queue 元素 { node, depth, share }
  const queue = shares.map((s) => ({ node: { ...s, parentFsId: "" }, depth: 1, share: s }));
  let scanned = 0;

  // 逐层 BFS，层内并发
  for (let depth = 1; depth <= maxDepth; depth++) {
    const level = queue.filter((q) => q.depth === depth);
    if (level.length === 0) break;

    const results = await Promise.all(
      level.map(async (entry) => {
        const { node, share } = entry;
        if (!node.isDir || node.size > 0) return null; // 非目录不进队列
        scanned++;
        try {
          const { files } = await fetchShareDir({
            gidS, fsIdS: node.fsId, fromUkS: share.fromUk, msgIdS: share.msgId,
            maxPages, cache, budget, throttleState,
          });
          return files.map((f) => ({
            node: { ...f, fromUser: share.fromUser },
            depth: depth + 1,
            share,
          }));
        } catch {
          failed.push({ fsId: node.fsId, name: node.name });
          return null;
        }
      })
    );

    for (const list of results) {
      if (!list) continue;
      for (const item of list) {
        tree.push(item.node);
        if (tree.length >= maxNodes) break;
        if (item.depth <= maxDepth && item.node.isDir) queue.push({ node: item.node, depth: item.depth, share: item.share });
      }
      if (tree.length >= maxNodes) break;
    }
    if (tree.length >= maxNodes) break;

    // 检测到限流后自动放慢下一层
    if (throttleState.consecutive > 0) await delay(300);
    // 连续限流 ≥3 次：停止扫描，结果可续扫（磁盘缓存加速重跑）
    if (throttleState.consecutive >= 3) break;
  }

  return { tree, failed, scanned, maxDepth, truncated: tree.length >= maxNodes, throttled: throttleState.consecutive >= 3 };
}

// ── 群文件搜索 (gsearch) ──────────────────────────────

async function searchFiles(gid, keyword, options = {}) {
  const gidS = toStr(gid);

  // 关键词解析：空格分隔多关键词（委托 lib/name-match.js 实现，语义与旧内联逻辑一致）：
  //  - 默认（all）：每个词都要出现（AND，可换序）→ "玄空 飞星" 只命中同时含两者的名字（精确收窄）
  //  - --any-word：任一词出现即可（OR，更宽）→ "玄空 飞星" 命中含"玄空"或"飞星"的名字
  //  - --exact：整名精确相等（最严格）；单关键词默认仍是子串包含（兼容旧行为）
  const matchMode = options.exact ? "exact" : (options.anyWord ? "any" : "all");
  const matchesName = (name) => matchName(keyword, name, { mode: matchMode });

  const limit = options.limit || 50;
  const page = options.page || 1;
  const concurrency = Math.min(Math.max(1, options.concurrency || 4), 8);
  const unique = options.unique !== false;
  const fetchAll = options.all === true;
  const depth = Math.min(Math.max(1, options.depth || 1), 5); // 默认 1 层（兼容旧行为）
  const maxPages = Math.min(Math.max(1, options.maxPages || 50), 200); // 单目录最多拉取页数（100/页）
  const cache = options.cache === true;
  const maxRequests = Math.min(Math.max(1, options.maxRequests || DEFAULT_MAX_REQUESTS), 2000);
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 0; // 0 = 不限时
  const budget = { remaining: maxRequests };
  const throttleState = { consecutive: 0 };
  const startIdx = (page - 1) * limit;
  const stopAt = fetchAll ? Infinity : startIdx + limit + 1; // +1 判断 hasMore

  const shares = await listShares(gidS, { cache });
  const totalShares = shares.length;

  const seen = new Set();
  const results = [];
  const failedDirs = [];
  let scannedShares = 0;
  let failedShares = 0;
  let throttledShares = 0;
  let cachedDirs = 0;
  let finished = false;
  let timedOut = false;
  let stoppedReason = null;

  // 超时控制：不中断当前批，批结束后停下并返回已拿到的部分结果
  // （complete:false, partial:true）。配合 CLI --json-file 的 onProgress 持续写盘，
  // 即使被外部超时/杀掉，部分结果也已提前落盘。
  let timeoutTimer = null;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => { timedOut = true; }, timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
  }

  const pushIfMatch = (item) => {
    if (finished) return;
    const key = unique ? toStr(item.fsId) : `${toStr(item.fsId)}|${toStr(item.msgId)}`;
    if (unique && seen.has(key)) return;
    seen.add(key);
    results.push(item);
    if (results.length >= stopAt) {
      finished = true;
      if (!stoppedReason) stoppedReason = "page-limit";
    }
  };

  // 阶段 1：顶层分享名称匹配（非目录分享在此完成扫描）
  for (const share of shares) {
    if (finished) break;
    if (!share.isDir) scannedShares++;
    if (matchesName(share.name)) {
      pushIfMatch({
        name: share.name,
        path: share.name,
        isDir: share.isDir,
        size: share.size,
        fsId: share.fsId,
        md5: "",
        category: 0,
        ctime: "",
        mtime: "",
        parentFsId: "",
        fromUk: share.fromUk,
        msgId: share.msgId,
        fromUser: share.fromUser,
        group: gidS,
      });
    }
  }

  // 阶段 2：BFS 递归扫描目录（每层并发，默认 depth=1 保持旧行为）
  const dirShares = shares.filter((s) => s.isDir);
  let queue = dirShares.map((s) => ({ fsId: s.fsId, fromUk: s.fromUk, msgId: s.msgId, depth: 1 }));

  for (let level = 1; level <= depth && queue.length > 0 && !finished; level++) {
    if (timedOut) { finished = true; stoppedReason = stoppedReason || "timeout"; break; }
    const current = queue;
    queue = [];

    for (let i = 0; i < current.length && !finished; i += concurrency) {
      if (timedOut) { finished = true; stoppedReason = stoppedReason || "timeout"; break; }
      const batch = current.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (share) => {
          scannedShares++;
          if (budget.remaining <= 0) {
            // 请求预算耗尽：剩余目录快速失败，避免失控触发限流
            failedShares++;
            if (!stoppedReason) stoppedReason = "budget";
            return { matches: [], subDirs: [] };
          }
          try {
            const { files, cached } = await fetchShareDir({
              gidS, fsIdS: share.fsId, fromUkS: share.fromUk, msgIdS: share.msgId,
              maxPages, cache, budget, throttleState,
            });
            if (cached) cachedDirs++;
            const matches = files.filter((f) => matchesName(f.name));
            const subDirs = files.filter((f) => f.isDir);
            return { matches, subDirs };
          } catch (e) {
            failedShares++;
            const errno = e instanceof ShareApiError ? e.errno : "?";
            if (e instanceof ShareApiError && e.throttled) throttledShares++;
            failedDirs.push({ fsId: share.fsId, name: share.name || "", errno, message: e.message });
            return { matches: [], subDirs: [] };
          }
        })
      );

      for (const { matches, subDirs } of batchResults) {
        if (finished) break;
        for (const f of matches) {
          pushIfMatch({ ...f, group: gidS });
          if (finished) break;
        }
        // 收集下一层待扫描目录
        if (level < depth && !finished) {
          for (const d of subDirs) {
            queue.push({ fsId: d.fsId, name: d.name, fromUk: d.fromUk, msgId: d.msgId, depth: level + 1 });
          }
        }
      }

      // 检测到限流后自动放慢（批间降速），缓解服务端压力
      if (throttleState.consecutive > 0) await delay(300);
      if (timedOut) { finished = true; stoppedReason = stoppedReason || "timeout"; break; }
      // 连续限流 ≥3 次：服务端已饱和，停止扫描快速失败。
      // 已成功扫描的目录已写入磁盘缓存，重跑命令只补扫缺失部分（续扫收敛）。
      if (throttleState.consecutive >= 3) {
        if (throttledShares < 3) throttledShares = 3;
        finished = true;
        stoppedReason = stoppedReason || "throttled";
        break;
      }

      // 每批扫描完主动上报部分结果（CLI 用于持续写 --json-file）
      if (typeof options.onProgress === "function") {
        options.onProgress({
          results,
          page,
          pageSize: limit,
          total: null,
          complete: false,
          partial: true,
          running: true,
          timedOut: false,
          stoppedReason,
          scannedShares,
          totalShares,
          failedShares,
          throttledShares,
          cachedDirs,
          budgetUsed: maxRequests - budget.remaining,
          depth,
          maxPages,
        });
      }
    }
  }

  if (timeoutTimer) clearTimeout(timeoutTimer);

  if (timedOut) {
    finished = true;
    stoppedReason = stoppedReason || "timeout";
  }

  // 完整度判定：BFS 自然结束（队列清空 / 达到 depth 上限）且未被分页/限流/超时/预算中断，
  // 且没有任何失败，才算 complete。之前"scannedShares >= totalShares"在 depth>1 或
  // 提前截断时会误报 complete:true。
  const scanDone = !finished && !timedOut;
  const complete = scanDone && failedShares === 0;
  const hasMore = !fetchAll && results.length > startIdx + limit;
  const pageSlice = fetchAll ? results : results.slice(startIdx, startIdx + limit);

  if (!stoppedReason) stoppedReason = complete ? "complete" : "stopped";

  const out = {
    results: pageSlice,
    page,
    pageSize: limit,
    returned: pageSlice.length,
    total: null,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    unique,
    complete,
    partial: !complete,
    timedOut,
    stoppedReason,
    throttled: throttleState.consecutive >= 3,
    failedDirs: failedShares > 0 ? failedDirs.slice(0, 50) : [],
    scannedShares,
    totalShares,
    failedShares,
    throttledShares,
    cachedDirs,
    budgetUsed: maxRequests - budget.remaining,
    depth,
    maxPages,
  };

  // 结束态上报（running:false），CLI 据此写最终 JSON
  if (typeof options.onProgress === "function") {
    options.onProgress({ ...out, results, running: false });
  }

  return out;
}

module.exports = {
  listGroups, listShares, listFiles, treeFiles, searchFiles,
  getShareDlink, downloadFile, getShareZipDlink, downloadFiles,
  ShareApiError, describeErrno2131, clearGroupCache,
};
