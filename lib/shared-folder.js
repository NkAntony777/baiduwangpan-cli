// Personal netdisk's right-click "共享" / "共享给我的文件夹" feature.
// This is the /sharedir API, NOT /ostp/sharedspace (team spaces).
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("./http");
const config = require("./config");

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const BASE = "https://pan.baidu.com";

function id(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("远端 ID 超过安全整数范围，不能继续操作");
  const result = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^[1-9]\d{0,29}$/.test(result)) throw new Error("共享文件夹 ID 必须是正整数字符串");
  return result;
}

function remotePath(value, sharedOnly = false) {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") ||
      /[\x00-\x1f\x7f\\]/.test(value) || value.split("/").some(p => p === "." || p === "..") || value.includes("//")) {
    throw new Error("请提供不含 ..、控制字符或反斜杠的绝对网盘路径");
  }
  const result = value.replace(/\/+$/, "") || "/";
  const match = result.match(/^\/<share>([1-9]\d{0,29})-([1-9]\d{0,29})(?:\/.*)?$/);
  if (sharedOnly && !match) throw new Error("共享目录路径必须使用 shared list/create 返回的 /<share>拥有者UK-目录FID 路径");
  if (!sharedOnly && (result === "/" || result.startsWith("/enjoytogether") || result.includes("<share>"))) {
    throw new Error("设置共享必须指定自己的普通文件夹，不能是根目录或他人的共享路径");
  }
  return result;
}

function plan(action, target, options) {
  const result = { action, target, backend: "personal-sharedir" };
  if (options.dryRun === true) return { ...result, dryRun: true, requiresConfirmation: true };
  if (options.confirm !== true) throw new Error("共享文件夹写操作需要显式确认：请加 --yes");
  return null;
}

function sharedTarget(value) {
  return remotePath(value, typeof value === "string" && value.startsWith("/<share>"));
}

function checked(data, action) {
  if (!data || data.errno !== 0) {
    const code = data && Number.isInteger(data.errno) ? data.errno : null;
    const detail = code === 18201 ? "目录内已有共享文件夹；不会自动取消子目录共享，请先手动处理" :
      (data && (data.errmsg || data.show_msg || data.error)) || "响应不是有效的成功结果";
    const error = new Error(`共享文件夹${action}失败${code === null ? "" : `（errno=${code}）`}：${detail}`);
    if (code !== null) error.errno = code;
    throw error;
  }
  return data;
}

async function request(endpoint, params = {}, body) {
  const token = await http.getBdstoken();
  const url = new URL(endpoint, BASE);
  for (const [key, value] of Object.entries({ channel: "chunlei", clienttype: 0, web: 1, app_id: 250528, bdstoken: token, ...params })) {
    url.searchParams.set(key, String(value));
  }
  return checked(await http.webJson(url.toString(), body === undefined ? {} : {
    method: "POST", body: new URLSearchParams(body).toString(),
  }), endpoint);
}

async function actorUk() {
  const data = await request("/api/gettemplatevariable", { fields: JSON.stringify(["uk"]) });
  return id(data.result && data.result.uk);
}

async function meta(target, dlink = false) {
  const data = await request("/api/filemetas", { target: JSON.stringify([target]), dlink: dlink ? 1 : 0 });
  const info = (data.info || [])[0];
  if (!info || info.path !== target) throw new Error("未找到指定的共享文件/目录元信息");
  id(info.fs_id);
  return info;
}

function inviteLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("共享接口未返回有效邀请链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "pan.baidu.com" || url.username || url.password || url.port) {
    throw new Error("共享接口返回了非百度网盘邀请链接");
  }
  url.protocol = "https:";
  return url.toString();
}

async function ownFolder(target) {
  const item = await meta(target);
  if (Number(item.isdir) !== 1) throw new Error("只能将文件夹设置为共享");
  return { item, fid: id(item.fs_id), uk: await actorUk() };
}

async function requireSharedDirectory(target) {
  // Recipients address /<share>ownerUK-rootFID. Owners must keep their own
  // real path: the server rejects an owner's virtual recipient path (errno 141).
  if (target.startsWith("/<share>")) return;
  let directory = target;
  const uk = await actorUk();
  for (let depth = 0; directory !== "/" && depth < 64; depth++) {
    const item = await meta(directory);
    if (Number(item.isdir) !== 1) throw new Error("共享目标不是文件夹");
    try {
      const data = await request("/sharedir/member/list", {}, { uk, fid: id(item.fs_id), start: 0, limit: 1 });
      if (!Array.isArray(data.list)) throw new Error("共享成员响应缺少 list");
      return;
    } catch (error) {
      if (error.errno !== 18210) throw error;
    }
    directory = path.posix.dirname(directory);
  }
  throw new Error("该路径不属于已设置共享的文件夹，请先使用 shared create");
}

async function create(target, options = {}) {
  target = remotePath(target);
  const preview = plan("create", target, options);
  if (preview) return preview;
  const { fid, uk } = await ownFolder(target);
  const data = await request("/sharedir/create", {}, { invite_link: 1, overlay: 0, fid });
  return { success: true, path: target, fid, ownerUk: uk, sharedPath: `/<share>${uk}-${fid}`, link: inviteLink(data.link) };
}

async function list(options = {}) {
  const start = options.start === undefined ? 0 : options.start;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("start 必须是非负整数");
  const data = await request("/sharedir/list", { method: "receive", start, limit: 100, order: "time", desc: 1 });
  if (!Array.isArray(data.list)) throw new Error("共享文件夹列表响应缺少 list");
  return { folders: data.list.map(f => ({
    fid: id(f.fid || f.fs_id), ownerUk: id(f.uk), path: remotePath(f.path, true), name: f.server_filename,
    owner: f.show_name || f.nick_name || "", frozen: Boolean(f.is_frozen),
  })), hasMore: data.has_more === 1 || data.has_more === "1", nextStart: start + data.list.length };
}

async function ls(target, options = {}) {
  target = sharedTarget(target);
  const page = options.page === undefined ? 1 : options.page;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page 必须是正整数");
  await requireSharedDirectory(target);
  const data = await request("/api/list", { dir: target, order: "name", desc: 0, showempty: 1, page, num: 100 });
  if (!Array.isArray(data.list)) throw new Error("共享目录响应缺少 list");
  return { path: target, page, hasMore: data.list.length === 100, entries: data.list.map(f => ({
    fsId: id(f.fs_id), path: sharedTarget(f.path), name: f.server_filename, isDir: Number(f.isdir) === 1, size: f.size,
  })) };
}

async function members(target, options = {}) {
  target = remotePath(target);
  const { fid, uk } = await ownFolder(target);
  const start = options.start === undefined ? 0 : options.start;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("start 必须是非负整数");
  const data = await request("/sharedir/member/list", {}, { uk, fid, start, limit: 50 });
  if (!Array.isArray(data.list)) throw new Error("共享成员响应缺少 list");
  return { path: target, members: data.list.map(m => ({ uk: id(m.uk), name: m.show_name || m.uname || "" })),
    hasMore: data.has_more === 1 || data.has_more === "1", nextStart: start + data.list.length };
}

async function invite(target, options = {}) {
  target = remotePath(target);
  const preview = plan("invite", target, options);
  if (preview) return preview;
  const { fid, uk } = await ownFolder(target);
  const data = await request("/sharedir/invite/link", {}, { uk, fid });
  return { success: true, path: target, link: inviteLink(data.link) };
}

async function removeMember(target, memberUk, options = {}) {
  target = remotePath(target);
  memberUk = id(memberUk);
  const preview = plan("remove-member", { path: target, memberUk }, options);
  if (preview) return preview;
  const { fid, uk } = await ownFolder(target);
  if (memberUk === uk) throw new Error("不能将自己作为共享成员移除；请使用取消共享");
  await request("/sharedir/member/del", { fid, delete_uk: memberUk, delete_files: 0 });
  return { success: true, path: target, memberUk, deletedFiles: false };
}

async function cancel(target, options = {}) {
  target = remotePath(target);
  const preview = plan("cancel", target, options);
  if (preview) return preview;
  const { fid } = await ownFolder(target);
  await request("/sharedir/cancel", {}, { fid });
  return { success: true, path: target };
}

function pcsUrl(value) {
  let url;
  try { url = new URL(value.startsWith("http") ? value : "https://" + value); } catch { throw new Error("无效的百度 PCS 地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname.endsWith(".pcs.baidu.com") || url.hostname.endsWith(".baidupcs.com") || url.hostname === "pcs.baidu.com")) {
    throw new Error("拒绝向非百度 PCS HTTPS 地址传输文件或凭证");
  }
  return url;
}

async function put(localPath, directory, options = {}) {
  directory = sharedTarget(directory);
  if (typeof localPath !== "string" || !localPath || /[\x00\r\n]/.test(localPath)) throw new Error("请提供本地文件路径");
  const name = path.basename(localPath);
  if (!name || name === "." || name === ".." || /[\x00-\x1f\x7f\\/:*?"<>|]/.test(name)) throw new Error("本地文件名不符合网盘文件名规则");
  const target = sharedTarget(directory + "/" + name);
  const preview = plan("put", { directory, path: target }, options);
  if (preview) return preview;
  const stat = await fs.stat(localPath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) throw new Error("首版仅支持上传 1 字节至 32MiB 的单个普通文件");
  const existing = await ls(directory);
  if (existing.entries.some(e => e.name === name)) throw new Error("共享目录已有同名文件；不会覆盖，请修改本地文件名后重试");
  const bytes = await fs.readFile(localPath);
  if (bytes.length !== stat.size) throw new Error("读取期间本地文件发生变化，请重试");
  const chunks = [];
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) chunks.push(bytes.subarray(start, start + CHUNK_BYTES));
  const blockList = chunks.map(c => crypto.createHash("md5").update(c).digest("hex"));
  const prepared = await request("/api/precreate", {}, { path: target, target_path: directory, size: bytes.length,
    autoinit: 1, block_list: JSON.stringify(blockList) });
  if (typeof prepared.uploadid !== "string" || !prepared.uploadid) throw new Error("共享上传预创建未返回 uploadid");
  const missing = prepared.block_list === undefined ? chunks.map((_, i) => i) : prepared.block_list;
  if (!Array.isArray(missing) || missing.some(i => !Number.isInteger(i) || i < 0 || i >= chunks.length)) {
    throw new Error("共享上传预创建返回了无效分块列表");
  }
  const token = await http.getBdstoken();
  const cfg = config.get();
  const cookie = cfg.cookie || `BDUSS=${cfg.bduss}; STOKEN=${cfg.stoken}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bdp-shared-upload-"));
  try {
    for (const index of [...new Set(missing)]) {
      const file = path.join(temp, "chunk");
      await fs.writeFile(file, chunks[index], { mode: 0o600 });
      const url = pcsUrl("https://c2.pcs.baidu.com/rest/2.0/pcs/superfile2");
      for (const [key, value] of Object.entries({ method: "upload", type: "tmpfile", app_id: 250528, channel: "chunlei",
        clienttype: 0, web: 1, path: target, uploadid: prepared.uploadid, uploadsign: prepared.uploadsign || "", partseq: index, bdstoken: token })) {
        url.searchParams.set(key, String(value));
      }
      const uploaded = await http.spawnCollected("curl", ["-sS", "--fail", "--max-time", "120",
        "-H", `Cookie: ${cookie}`, "-H", "Referer: https://pan.baidu.com/disk/main", "-F", `file=@${file};filename=blob`, url.toString()],
      { encoding: "utf-8", timeoutMs: 125000, maxBuffer: 1024 * 1024 });
      if (uploaded.error || uploaded.status !== 0) {
        throw new Error("共享文件分块上传失败（" + (uploaded.error && uploaded.error.code || "curl " + uploaded.status) + "），未提交文件");
      }
      let response;
      try { response = JSON.parse(uploaded.stdout); } catch { throw new Error("分块上传返回了无效 JSON"); }
      if (response.error_code || response.errno) checked({ ...response, errno: response.errno || response.error_code }, "分块上传");
      if (response.md5 !== blockList[index]) throw new Error("共享上传的分块 MD5 不一致，未提交文件");
    }
    const committed = await request("/api/create", { isdir: 0 }, { path: target, target_path: directory, size: bytes.length,
      uploadid: prepared.uploadid, ...(prepared.uploadsign ? { uploadsign: prepared.uploadsign } : {}),
      block_list: JSON.stringify(blockList), ondup: "newcopy" });
    const item = committed.info || committed;
    if (!item.path || !item.fs_id) throw new Error("共享上传提交未返回文件信息");
    const actualPath = sharedTarget(item.path);
    if (path.posix.dirname(actualPath) !== directory) throw new Error("上传结果不属于请求的共享目录");
    return { success: true, path: actualPath, fsId: id(item.fs_id), size: bytes.length, md5: crypto.createHash("md5").update(bytes).digest("hex") };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

async function get(target, outDir = ".", options = {}) {
  target = sharedTarget(target);
  if (options.dryRun === true) return { action: "get", target, backend: "personal-sharedir", dryRun: true };
  await requireSharedDirectory(path.posix.dirname(target));
  const info = await meta(target, true);
  if (Number(info.isdir) === 1) throw new Error("首版共享下载只支持单个文件，请先使用 shared ls");
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("首版共享下载上限为 32MiB");
  const name = path.posix.basename(target);
  if (/[<>:"\\|?*]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || /[. ]$/.test(name)) throw new Error("文件名不适合安全保存到本地，请使用网页端下载");
  const chunks = [];
  const url = size === 0 ? null : pcsUrl(info.dlink).toString();
  for (let start = 0; start < size; start += CHUNK_BYTES) {
    const end = Math.min(size, start + CHUNK_BYTES) - 1;
    const bytes = await http.curlRange(url, start, end, config.get().ua);
    if (!Buffer.isBuffer(bytes) || bytes.length !== end - start + 1) throw new Error("共享下载大小不一致，未保存文件");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, size);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, name), bytes, { flag: "wx", mode: 0o600 });
  return { success: true, path: target, name, size, md5: crypto.createHash("md5").update(bytes).digest("hex") };
}

module.exports = { create, list, ls, members, invite, removeMember, cancel, put, get, remotePath, id, MAX_FILE_BYTES, CHUNK_BYTES };
