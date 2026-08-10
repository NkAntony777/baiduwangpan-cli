const http = require("./http");
const { getBdstoken } = http;

async function listGroups() {
  const bdstoken = await getBdstoken();
  if (!bdstoken) throw new Error("Cannot get bdstoken — check BDUSS/STOKEN config");

  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/group/list?clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`
  );

  if (data.errno !== 0) throw new Error(`API error: errno=${data.errno}`);

  return (data.records || []).map((g) => ({
    gid: g.gid,
    name: g.name,
    gnum: g.gnum,
    description: g.gdesc || "",
    type: g.type,
    created: g.ctime,
  }));
}

async function listShares(gid) {
  const bdstoken = await getBdstoken();
  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/group/listshare?clienttype=0&app_id=${http.APP_ID}&web=1&type=2&gid=${gid}&limit=50&desc=1&bdstoken=${bdstoken}`,
    { method: "POST", body: "" }
  );

  if (data.errno !== 0) throw new Error(`API error: errno=${data.errno}`);

  const shares = [];
  for (const msg of data.records?.msg_list || []) {
    for (const f of msg.file_list || []) {
      shares.push({
        msgId: msg.msg_id,
        fromUk: msg.uk,
        fromUser: msg.uname,
        name: decodeURIComponent(f.path || f.server_filename || ""),
        fsId: f.fs_id,
        isDir: f.isdir === "1",
        size: parseInt(f.size || "0"),
      });
    }
  }
  return shares;
}

async function listFiles(gid, fsId, options = {}) {
  const page = options.page || 1;
  const num = options.num || 100;

  // First get the fromUk and msgId for this fsId
  let { fromUk, msgId } = options;
  if (!fromUk || !msgId) {
    const shares = await listShares(gid);
    const match = shares.find((s) => s.fsId === fsId);
    if (match) {
      fromUk = match.fromUk;
      msgId = match.msgId;
    } else if (shares.length > 0) {
      fromUk = shares[0].fromUk;
      msgId = shares[0].msgId;
    } else {
      throw new Error("Cannot find share info for this fsId");
    }
  }

  const bdstoken = await getBdstoken();
  const data = await http.webJson(
    `${http.PAN_BASE}/mbox/msg/shareinfo?type=2&from_uk=${fromUk}&msg_id=${msgId}&to_uk=0&num=${num}&page=${page}&fs_id=${fsId}&gid=${gid}&clienttype=0&app_id=${http.APP_ID}&web=1&bdstoken=${bdstoken}`,
    { method: "POST", body: "" }
  );

  if (data.errno !== 0) throw new Error(`API error: errno=${data.errno}`);

  const files = (Array.isArray(data.records) ? data.records : []).map((f) => ({
    name: f.server_filename || "",
    path: decodeURIComponent(f.path || ""),
    isDir: f.isdir === 1 || f.isdir === "1",
    size: parseInt(f.size || "0"),
    fsId: f.fs_id,
    md5: f.md5 || "",
    category: parseInt(f.category || "0"),
    ctime: f.server_ctime || "",
    mtime: f.server_mtime || "",
  }));

  return { files, hasMore: data.has_more === 1, page };
}

async function searchFiles(gid, keyword, options = {}) {
  const maxDepth = options.maxDepth || 1;
  const results = [];
  const kw = keyword.toLowerCase();

  const shares = await listShares(gid);

  for (const share of shares) {
    if (share.name.toLowerCase().includes(kw)) {
      results.push({ ...share, group: gid });
    }

    if (share.isDir && maxDepth > 0) {
      try {
        const { files } = await listFiles(gid, share.fsId, {
          fromUk: share.fromUk,
          msgId: share.msgId,
        });
        for (const f of files) {
          if (f.name.toLowerCase().includes(kw)) {
            results.push({ ...f, group: gid });
          }
        }
      } catch {}
    }
  }

  return results;
}

module.exports = { listGroups, listShares, listFiles, searchFiles };
