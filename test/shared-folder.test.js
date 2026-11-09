const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("../lib/http");
const config = require("../lib/config");
const shared = require("../lib/shared-folder");
const CLI = path.join(__dirname, "..", "bin", "bdp.js");
const ROOT = "/<share>123-456";
const original = { webJson: http.webJson, getBdstoken: http.getBdstoken, spawnCollected: http.spawnCollected,
  curlRange: http.curlRange, configGet: config.get };
let calls, responder, temp;

function fixture(url, options) {
  const body = Object.fromEntries(new URLSearchParams(options.body || ""));
  const target = url.searchParams.get("target");
  switch (url.pathname) {
    case "/api/gettemplatevariable": return { errno: 0, result: { uk: "123" } };
    case "/api/filemetas": return { errno: 0, info: [{ path: JSON.parse(target)[0], fs_id: "456", isdir: 1, share: 1 }] };
    case "/sharedir/create": case "/sharedir/invite/link": return { errno: 0, link: "https://pan.baidu.com/sharedir/invite?key=example" };
    case "/sharedir/list": return { errno: 0, has_more: 0, list: [{ fid: "456", uk: "123", path: ROOT, server_filename: "资料" }] };
    case "/sharedir/member/list": return { errno: 0, list: [{ uk: "123", show_name: "owner" }] };
    case "/sharedir/member/del": case "/sharedir/cancel": return { errno: 0 };
    case "/api/list": return { errno: 0, list: [] };
    case "/api/precreate": return { errno: 0, uploadid: "upload-id", uploadsign: "upload-sign", block_list: JSON.parse(body.block_list).map((_, i) => i) };
    case "/api/create": return { errno: 0, info: { fs_id: "789", path: body.path, size: Number(body.size) } };
    default: throw new Error("Unexpected endpoint " + url.pathname);
  }
}

test.beforeEach(async () => {
  calls = [];
  responder = fixture;
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "bdp-shared-test-"));
  http.getBdstoken = async () => "test-token";
  http.webJson = async (raw, options = {}) => {
    const url = new URL(raw);
    calls.push({ url, options, body: Object.fromEntries(new URLSearchParams(options.body || "")) });
    return responder(url, options);
  };
  config.get = () => ({ bduss: "test-bduss", stoken: "test-stoken", ua: "test-agent" });
  http.spawnCollected = async (command, args) => {
    assert.equal(command, "curl");
    const fileArg = args[args.indexOf("-F") + 1];
    const bytes = await fs.readFile(fileArg.slice(6).split(";filename=")[0]);
    calls.push({ chunk: true, url: new URL(args[args.length - 1]), bytes });
    return { status: 0, stdout: JSON.stringify({ md5: crypto.createHash("md5").update(bytes).digest("hex") }) };
  };
});

test.afterEach(async () => {
  Object.assign(http, { webJson: original.webJson, getBdstoken: original.getBdstoken,
    spawnCollected: original.spawnCollected, curlRange: original.curlRange });
  config.get = original.configGet;
  await fs.rm(temp, { recursive: true, force: true });
});

test("shared paths preserve owner UK and folder FID without converting to numbers", () => {
  const target = "/<share>90071992547409931234-90071992547409935678/资料";
  assert.equal(shared.remotePath(target, true), target);
  for (const p of ["/资料", ROOT + "/../private", ROOT + "/./file", ROOT + "//x", ROOT + "/a\nb", "/<share>0-456"]) {
    assert.throws(() => shared.remotePath(p, true));
  }
});

test("shared IDs reject imprecise numbers and own-folder writes reject shared namespaces", () => {
  assert.equal(shared.id("90071992547409931234"), "90071992547409931234");
  assert.throws(() => shared.id(9007199254740992));
  for (const p of ["/", ROOT, "/enjoytogether", "/a/../b"]) assert.throws(() => shared.remotePath(p));
});

test("shared write operations require boolean confirmation before network calls", async () => {
  for (const confirm of [undefined, false, "true", 1]) {
    await assert.rejects(shared.create("/资料", { confirm }), /显式确认/);
    await assert.rejects(shared.put("a.txt", ROOT, { confirm }), /显式确认/);
  }
  assert.equal(calls.length, 0);
});

test("all shared dry-runs avoid metadata, membership and upload requests", async () => {
  for (const run of [() => shared.create("/资料", { dryRun: true }), () => shared.invite("/资料", { dryRun: true }),
    () => shared.removeMember("/资料", "999", { dryRun: true }), () => shared.cancel("/资料", { dryRun: true }),
    () => shared.put("a.txt", ROOT, { dryRun: true })]) {
    const result = await run();
    assert.equal(result.dryRun, true);
    assert.equal(result.backend, "personal-sharedir");
  }
  assert.equal(calls.length, 0);
});

test("create uses the personal sharedir endpoint and never enables nested-share overlay", async () => {
  const result = await shared.create("/资料", { confirm: true });
  assert.equal(result.sharedPath, ROOT);
  assert.equal(result.success, true);
  const call = calls.find(c => c.url.pathname === "/sharedir/create");
  assert.equal(call.options.method, "POST");
  assert.deepEqual(call.body, { invite_link: "1", overlay: "0", fid: "456" });
  assert.equal(calls.some(c => c.url.pathname.includes("sharedspace")), false);
});

test("create reports nested sharing conflicts instead of silently cancelling child shares", async () => {
  responder = (u, o) => u.pathname === "/sharedir/create" ? { errno: 18201 } : fixture(u, o);
  await assert.rejects(shared.create("/资料", { confirm: true }), /不会自动取消子目录共享/);
  assert.equal(calls.filter(c => c.url.pathname === "/sharedir/create").length, 1);
});

test("create only accepts real folder metadata", async () => {
  responder = (u, o) => u.pathname === "/api/filemetas" ? { errno: 0, info: [{ path: "/资料", fs_id: "456", isdir: 0 }] } : fixture(u, o);
  await assert.rejects(shared.create("/资料", { confirm: true }), /只能将文件夹/);
  assert.equal(calls.some(c => c.url.pathname === "/sharedir/create"), false);
});

test("received folders retain the virtual paths returned by sharedir/list", async () => {
  const result = await shared.list();
  assert.equal(result.folders[0].path, ROOT);
  assert.equal(calls[0].url.pathname, "/sharedir/list");
  assert.equal(calls[0].url.searchParams.get("method"), "receive");
});

test("shared ls sends the complete virtual path and validates pagination", async () => {
  await shared.ls(ROOT + "/子目录", { page: 2 });
  assert.equal(calls[0].url.searchParams.get("dir"), ROOT + "/子目录");
  assert.equal(calls[0].url.searchParams.get("page"), "2");
  await assert.rejects(shared.ls(ROOT, { page: -1 }));
});

test("members use the owner and folder identity in a form POST", async () => {
  const result = await shared.members("/资料");
  assert.equal(result.members[0].uk, "123");
  const call = calls.find(c => c.url.pathname === "/sharedir/member/list");
  assert.deepEqual(call.body, { uk: "123", fid: "456", start: "0", limit: "50" });
});

test("invite returns a joining link without sending messages or inventing role parameters", async () => {
  const result = await shared.invite("/资料", { confirm: true });
  assert.match(result.link, /^https:\/\/pan.baidu.com\//);
  assert.deepEqual(calls.find(c => c.url.pathname === "/sharedir/invite/link").body, { uk: "123", fid: "456" });
  assert.equal(calls.some(c => c.url.pathname.includes("/mbox/")), false);
});

test("removing authorization always preserves the member's existing files", async () => {
  const result = await shared.removeMember("/资料", "999", { confirm: true });
  assert.equal(result.deletedFiles, false);
  const call = calls.find(c => c.url.pathname === "/sharedir/member/del");
  assert.equal(call.url.searchParams.get("delete_files"), "0");
  assert.equal(call.url.searchParams.get("delete_uk"), "999");
  await assert.rejects(shared.removeMember("/资料", "123", { confirm: true }), /不能将自己/);
});

test("cancel uses sharedir/cancel for the exact own folder", async () => {
  await shared.cancel("/资料", { confirm: true });
  assert.deepEqual(calls.find(c => c.url.pathname === "/sharedir/cancel").body, { fid: "456" });
});

test("remote permission failures propagate and never fall back to personal upload", async () => {
  responder = () => ({ errno: -6, errmsg: "未登录" });
  await assert.rejects(shared.ls(ROOT), e => e.errno === -6);
  assert.equal(calls.length, 1);
});

test("shared upload precreates, verifies chunks and commits in the same virtual directory", async () => {
  const file = path.join(temp, "note.txt");
  await fs.writeFile(file, "hello shared folder");
  const result = await shared.put(file, ROOT, { confirm: true });
  assert.equal(result.path, ROOT + "/note.txt");
  const pre = calls.find(c => c.url.pathname === "/api/precreate");
  const commit = calls.find(c => c.url.pathname === "/api/create");
  const part = calls.find(c => c.chunk);
  assert.equal(pre.body.path, result.path);
  assert.equal(pre.body.target_path, ROOT);
  assert.equal(part.url.searchParams.get("path"), result.path);
  assert.equal(part.url.searchParams.get("uploadid"), "upload-id");
  assert.equal(commit.body.path, result.path);
  assert.equal(commit.body.ondup, "newcopy");
  assert.equal(result.size, Buffer.byteLength("hello shared folder"));
});

test("shared upload refuses existing names before creating any upload", async () => {
  const file = path.join(temp, "note.txt"); await fs.writeFile(file, "x");
  responder = (u, o) => u.pathname === "/api/list" ? { errno: 0, list: [{ fs_id: "789", path: ROOT + "/note.txt", server_filename: "note.txt", size: 1 }] } : fixture(u, o);
  await assert.rejects(shared.put(file, ROOT, { confirm: true }), /不会覆盖/);
  assert.equal(calls.some(c => c.url.pathname === "/api/precreate"), false);
});

test("a denied upload precreation does not send or commit chunks", async () => {
  const file = path.join(temp, "note.txt"); await fs.writeFile(file, "x");
  responder = (u, o) => u.pathname === "/api/precreate" ? { errno: 18210, errmsg: "共享目录不存在" } : fixture(u, o);
  await assert.rejects(shared.put(file, ROOT, { confirm: true }), e => e.errno === 18210);
  assert.equal(calls.some(c => c.chunk || c.url.pathname === "/api/create"), false);
});

test("chunk integrity failure prevents committing an uploaded file", async () => {
  const file = path.join(temp, "note.txt"); await fs.writeFile(file, "x");
  http.spawnCollected = async () => ({ status: 0, stdout: '{"md5":"wrong"}' });
  await assert.rejects(shared.put(file, ROOT, { confirm: true }), /MD5 不一致/);
  assert.equal(calls.some(c => c.url.pathname === "/api/create"), false);
});

test("uploads split files into bounded chunks with contiguous part numbers", async () => {
  const file = path.join(temp, "multi.bin"); await fs.writeFile(file, Buffer.alloc(shared.CHUNK_BYTES + 3, 42));
  await shared.put(file, ROOT, { confirm: true });
  const parts = calls.filter(c => c.chunk);
  assert.deepEqual(parts.map(c => c.url.searchParams.get("partseq")), ["0", "1"]);
  assert.deepEqual(parts.map(c => c.bytes.length), [shared.CHUNK_BYTES, 3]);
});

test("shared download verifies size and does not overwrite local files", async () => {
  responder = () => ({ errno: 0, info: [{ fs_id: "789", path: ROOT + "/note.txt", isdir: 0, size: 5, dlink: "https://d.pcs.baidu.com/file/test" }] });
  http.curlRange = async () => Buffer.from("hello");
  const result = await shared.get(ROOT + "/note.txt", temp);
  assert.equal(result.size, 5);
  assert.equal(await fs.readFile(path.join(temp, "note.txt"), "utf8"), "hello");
  await assert.rejects(shared.get(ROOT + "/note.txt", temp), e => e.code === "EEXIST");
});

test("shared download does not save truncated content or follow untrusted PCS addresses", async () => {
  responder = () => ({ errno: 0, info: [{ fs_id: "789", path: ROOT + "/note.txt", isdir: 0, size: 5, dlink: "https://d.pcs.baidu.com/file/test" }] });
  http.curlRange = async () => Buffer.from("bad");
  await assert.rejects(shared.get(ROOT + "/note.txt", temp), /大小不一致/);
  await assert.rejects(fs.stat(path.join(temp, "note.txt")), e => e.code === "ENOENT");
  responder = () => ({ errno: 0, info: [{ fs_id: "789", path: ROOT + "/note.txt", isdir: 0, size: 5, dlink: "https://evil.example/file" }] });
  await assert.rejects(shared.get(ROOT + "/note.txt", temp), /非百度 PCS/);
});

test("CLI shared requires confirmation before invoking a write operation", () => {
  const run = spawnSync(process.execPath, [CLI, "shared", "create", "/资料", "--json"], { encoding: "utf8", timeout: 5000, env: { ...process.env, BDP_CONFIG_DIR: temp } });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(JSON.parse(run.stdout).requiresConfirmation, true);
});

test("CLI shared exposes the correct product and supports offline JSON plans", () => {
  const run = spawnSync(process.execPath, [CLI, "shared", "put", "note.txt", ROOT, "--dry-run", "--json"], { encoding: "utf8", timeout: 5000, env: { ...process.env, BDP_CONFIG_DIR: temp } });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.backend, "personal-sharedir");
  assert.equal(result.meta.command, "shared");
  assert.equal(result.dryRun, true);
});

test("invalid metadata and upload sessions cannot be treated as successful operations", async () => {
  responder = () => ({ errno: 0, info: [] });
  await assert.rejects(shared.create("/资料", { confirm: true }), /元信息/);
  responder = (u, o) => u.pathname === "/api/precreate" ? { errno: 0 } : fixture(u, o);
  const file = path.join(temp, "note.txt"); await fs.writeFile(file, "x");
  await assert.rejects(shared.put(file, ROOT, { confirm: true }), /uploadid/);
});

test("unsupported local files are rejected before network activity", async () => {
  const file = path.join(temp, "empty.txt"); await fs.writeFile(file, "");
  await assert.rejects(shared.put(file, ROOT, { confirm: true }), /32MiB/);
  await assert.rejects(shared.put(temp, ROOT, { confirm: true }), /32MiB/);
  assert.equal(calls.length, 0);
});

test("owners keep their real path after verifying shared-folder membership", async () => {
  await shared.ls("/资料");
  assert.equal(calls.find(c => c.url.pathname === "/api/list").url.searchParams.get("dir"), "/资料");
  assert.ok(calls.some(c => c.url.pathname === "/sharedir/member/list"));
});

test("an ordinary personal folder cannot silently be used as a shared target", async () => {
  responder = (u, o) => u.pathname === "/sharedir/member/list" ? { errno: 18210 } : fixture(u, o);
  await assert.rejects(shared.ls("/资料"), /不属于已设置共享/);
  assert.equal(calls.some(c => c.url.pathname === "/api/list"), false);
});

test("shared downloads use bounded ranges even when files exceed one chunk", async () => {
  const size = shared.CHUNK_BYTES + 3;
  responder = () => ({ errno: 0, info: [{ fs_id: "789", path: ROOT + "/multi.bin", isdir: 0, size, dlink: "https://d.pcs.baidu.com/file/test" }] });
  const ranges = [];
  http.curlRange = async (_, start, end) => { ranges.push([start, end]); return Buffer.alloc(end - start + 1, 42); };
  await shared.get(ROOT + "/multi.bin", temp);
  assert.deepEqual(ranges, [[0, shared.CHUNK_BYTES - 1], [shared.CHUNK_BYTES, size - 1]]);
  assert.equal((await fs.stat(path.join(temp, "multi.bin"))).size, size);
});

test("shared download dry-run performs no requests or local writes", async () => {
  const result = await shared.get(ROOT + "/note.txt", path.join(temp, "not-created"), { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(path.join(temp, "not-created")), e => e.code === "ENOENT");
});
