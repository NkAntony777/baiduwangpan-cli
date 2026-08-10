const http = require("./http");
const { getBdstoken } = http;

// ── 工具 ──────────────────────────────────────────────

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

class ShareApiError extends Error {
  constructor(errno, message) {
    super(message);
    this.errno = errno;
    this.name = "ShareApiError";
  }
}

// ── 群组列表 ──────────────────────────────────────────

async function listGroups() {
  const bdstoken = await getBdstoken();
  if (!bdstoken) throw new Error("Cannot get bdstoken — check BDUSS/STOKEN config");

  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/group/list?clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`
  );

  if (data.errno !== 0) throw new Error(`API error: errno=${data.errno}`);

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

async function listShares(gid) {
  const bdstoken = await getBdstoken();
  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/group/listshare?clienttype=0&app_id=${http.APP_ID}&web=1&type=2&gid=${toStr(gid)}&limit=50&desc=1&bdstoken=${bdstoken}`,
    { method: "POST", body: "" }
  );

  if (data.errno !== 0) throw new Error(`API error: errno=${data.errno}`);

  const shares = [];
  for (const msg of data.records?.msg_list || []) {
    for (const f of msg.file_list || []) {
      shares.push({
        msgId: toStr(msg.msg_id),
        fromUk: toStr(msg.uk),
        fromUser: msg.uname,
        name: decodeURIComponent(f.path || f.server_filename || ""),
        fsId: toStr(f.fs_id),
        isDir: f.isdir === "1",
        size: parseInt(f.size || "0", 10),
      });
    }
  }
  return shares;
}

// ── 底层 shareinfo 请求 ───────────────────────────────

async function shareInfoRequest(gidS, fsIdS, fromUkS, msgIdS, page, pageSize) {
  const bdstoken = await getBdstoken();
  const url =
    `${http.PAN_BASE}/mbox/msg/shareinfo?type=2&from_uk=${fromUkS}&msg_id=${msgIdS}` +
    `&to_uk=0&num=${pageSize}&page=${page}&fs_id=${fsIdS}&gid=${gidS}` +
    `&clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`;

  const data = await http.webJson(url, { method: "POST", body: "" });

  if (data.errno !== 0) {
    throw new ShareApiError(data.errno, `API error: errno=${data.errno}`);
  }

  const files = (Array.isArray(data.records) ? data.records : []).map((f) => ({
    name: f.server_filename || "",
    path: decodeURIComponent(f.path || ""),
    isDir: f.isdir === 1 || f.isdir === "1",
    size: parseInt(f.size || "0", 10),
    fsId: toStr(f.fs_id),
    md5: f.md5 || "",
    category: parseInt(f.category || "0", 10),
    ctime: toStr(f.server_ctime || ""),
    mtime: toStr(f.server_mtime || ""),
    parentFsId: fsIdS,
    fromUk: fromUkS,
    msgId: msgIdS,
  }));

  return { files, hasMore: data.has_more === 1, page, pageSize };
}

// ── 列出分享库内容 (gls) ──────────────────────────────

async function listFiles(gid, fsId, options = {}) {
  const gidS = toStr(gid);
  const fsIdS = toStr(fsId);
  const parentFsId = toStr(options.parentFsId || "");
  const page = options.page || 1;
  let pageSize = options.pageSize || 50;
  pageSize = Math.min(Math.max(1, pageSize), 100);

  // 来源解析：显式传入优先；否则仅在顶层分享中精确匹配（禁止"用第一个分享"兜底）
  let fromUkS = toStr(options.fromUk || "");
  let msgIdS = toStr(options.msgId || "");

  if (!fromUkS || !msgIdS) {
    const shares = await listShares(gidS);
    const match = shares.find((s) => s.fsId === fsIdS);
    if (!match) {
      throw new Error(
        `Cannot determine fromUk/msgId for fsId ${fsIdS} (not a top-level share). ` +
        `Pass --from-uk and --msg-id explicitly.`
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
        `shareinfo rejected for fsId ${fsIdS} (errno=-3), and parent fallback also failed. ` +
        `The share may be expired or the directory may be too large for the API.`
      );
    }
  }

  // 目标本身是顶层分享 → 退回 gshares 结果
  try {
    const shares = await listShares(gidS);
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
    `shareinfo rejected for fsId ${fsIdS} (errno=-3). ` +
    `群分享 API 拒绝请求：已观察到大目录、错误的 msgId/fromUk、过期分享都可能触发。` +
    `请减小 --page-size，或携带 gsearch 返回的 fromUk/msgId/parentFsId 信息重试。`
  );
}

// ── 群文件搜索 (gsearch) ──────────────────────────────

async function searchFiles(gid, keyword, options = {}) {
  const gidS = toStr(gid);
  const kw = keyword.toLowerCase();

  const limit = options.limit || 50;
  const page = options.page || 1;
  const concurrency = Math.min(Math.max(1, options.concurrency || 4), 8);
  const unique = options.unique !== false;
  const fetchAll = options.all === true;
  const startIdx = (page - 1) * limit;
  const stopAt = fetchAll ? Infinity : startIdx + limit + 1; // +1 判断 hasMore

  const shares = await listShares(gidS);
  const totalShares = shares.length;

  const seen = new Set();
  const results = [];
  let scannedShares = 0;
  let failedShares = 0;
  let finished = false;

  const pushIfMatch = (item) => {
    if (finished) return;
    const key = unique ? toStr(item.fsId) : `${toStr(item.fsId)}|${toStr(item.msgId)}`;
    if (unique && seen.has(key)) return;
    seen.add(key);
    results.push(item);
    if (results.length >= stopAt) finished = true;
  };

  // 阶段 1：顶层分享名称匹配（非目录分享在此完成扫描）
  for (const share of shares) {
    if (finished) break;
    if (!share.isDir) scannedShares++;
    if (share.name.toLowerCase().includes(kw)) {
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

  // 阶段 2：对分享目录并发扫描第一层（4 个一批，批次间稳定顺序）
  const dirShares = shares.filter((s) => s.isDir);
  for (let i = 0; i < dirShares.length && !finished; i += concurrency) {
    const batch = dirShares.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (share) => {
        scannedShares++;
        try {
          const { files } = await shareInfoRequest(gidS, share.fsId, share.fromUk, share.msgId, 1, 100);
          return files.filter((f) => f.name.toLowerCase().includes(kw));
        } catch {
          failedShares++;
          return [];
        }
      })
    );

    for (const list of batchResults) {
      if (finished) break;
      for (const f of list) {
        pushIfMatch({ ...f, group: gidS });
        if (finished) break;
      }
    }
  }

  const complete = !finished || (fetchAll && finished === false) || scannedShares >= totalShares;
  const hasMore = !fetchAll && results.length > startIdx + limit;
  const pageSlice = fetchAll ? results : results.slice(startIdx, startIdx + limit);

  return {
    results: pageSlice,
    page,
    pageSize: limit,
    returned: pageSlice.length,
    total: null,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    unique,
    complete: scannedShares >= totalShares,
    partial: failedShares > 0,
    scannedShares,
    totalShares,
    failedShares,
  };
}

module.exports = { listGroups, listShares, listFiles, searchFiles, ShareApiError };
