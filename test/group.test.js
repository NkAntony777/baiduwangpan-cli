const test = require("node:test");
const assert = require("node:assert/strict");

// Mock http 模块（替换 require.cache）
const httpPath = require.resolve("../lib/http");
const mockHttp = {
  APP_ID: "250528",
  PAN_BASE: "https://pan.baidu.com",
  webJson: async () => { throw new Error("webJson not mocked"); },
  getBdstoken: async () => "mock-bdstoken",
};
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: mockHttp };

const group = require("../lib/group");
const { ShareApiError } = group;

function makeApi(records, opts = {}) {
  return { errno: opts.errno ?? 0, records, has_more: opts.hasMore ? 1 : 0 };
}

function share(fsId, name, extra = {}) {
  return {
    fs_id: fsId,
    isdir: "0",
    path: "/" + name,
    server_filename: name,
    size: "1024",
    server_ctime: "1600000000",
    server_mtime: "1700000000",
    md5: "abc",
    category: "6",
    ...extra,
  };
}

test("listFiles matches numeric fsId from CLI string argument", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({
        msg_count: 1,
        msg_list: [{ msg_id: "m1", uk: 2642611875, file_list: [share("742474845517885", "top", { isdir: "1" })] }],
      });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      assert.match(url, /fs_id=742474845517885/);
      return makeApi([share("111", "a.txt")]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.listFiles("539478953581833690", 742474845517885, {});
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fsId, "111");
  assert.equal(result.files[0].parentFsId, "742474845517885");
  assert.equal(result.fromUk, "2642611875");
  assert.equal(result.msgId, "m1");
});

test("listFiles refuses to guess fromUk/msgId for non-top-level fsId", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("999", "top", { isdir: "1" })] }] });
    }
    throw new Error("should not reach shareinfo");
  };

  await assert.rejects(
    group.listFiles("gid", "unknown-fsid", {}),
    /Cannot determine fromUk\/msgId/
  );
});

test("searchFiles deduplicates same fsId from different msgId by default", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({
        msg_count: 2,
        msg_list: [
          { msg_id: "m1", uk: 1, file_list: [share("100", "A 倪海厦", { isdir: "1" })] },
          { msg_id: "m2", uk: 2, file_list: [share("100", "A 倪海厦", { isdir: "1" })] },
        ],
      });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      // same fsId, return a matching child in both
      return makeApi([share("500", "B 倪海厦")]);
    }
    throw new Error("unexpected url " + url);
  };

  const uniqueResult = await group.searchFiles("gid", "倪海厦", {});
  // 去重后: 顶层 fsId=100 (1个) + 子目录 fsId=500 (1个) = 2
  assert.equal(uniqueResult.results.length, 2, "unique dedups repeated fsIds");
  assert.equal(uniqueResult.unique, true);
  assert.deepEqual(uniqueResult.results.map((r) => r.fsId).sort(), ["100", "500"]);

  const allResult = await group.searchFiles("gid", "倪海厦", { unique: false });
  // 不去重: 顶层 100x2 + 子目录 500x2 = 4
  assert.equal(allResult.results.length, 4, "--no-unique keeps both sources");
});

test("searchFiles pagination returns correct slice and nextPage", async () => {
  const items = [];
  for (let i = 0; i < 30; i++) items.push(share(String(1000 + i), "X" + String(i).padStart(2, "0") + " 报告"));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items.map((f) => ({ ...f, isdir: "1" })) }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      return makeApi([]);
    }
    throw new Error("unexpected url " + url);
  };

  const page1 = await group.searchFiles("gid", "报告", { page: 1, limit: 20 });
  assert.equal(page1.results.length, 20);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextPage, 2);

  const page2 = await group.searchFiles("gid", "报告", { page: 2, limit: 20 });
  assert.equal(page2.results.length, 10);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.nextPage, null);
  assert.equal(page2.results[0].name, "/X20 报告");
});

test("listFiles retries errno=-3 with smaller page sizes 50/20/10", async () => {
  const requested = [];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("999", "top", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const num = Number(new URL(url).searchParams.get("num"));
      requested.push(num);
      if (num === 50) return { errno: -3 };
      if (num === 20) return { errno: -3 };
      return makeApi([share("777", "ok.txt")]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.listFiles("gid", "999", {});
  assert.deepEqual(requested, [50, 20, 10]);
  assert.equal(result.pageSize, 10);
  assert.equal(result.files[0].name, "ok.txt");
  assert.equal(result.fallback, null);
});

test("listFiles falls back to parent directory when errno=-3 persists", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("parent", "parent-dir", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const fsId = new URL(url).searchParams.get("fs_id");
      const num = Number(new URL(url).searchParams.get("num"));
      if (fsId === "big-dir") return { errno: -3 };
      if (fsId === "parent" && num === 50) return makeApi([share("sibling", "sibling.txt")]);
      throw new Error("unexpected fsId " + fsId);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.listFiles("gid", "big-dir", { parentFsId: "parent", fromUk: "1", msgId: "m1" });
  assert.ok(result.fallback, "fallback present");
  assert.equal(result.fallback.level, "parent");
  assert.equal(result.fallback.resolvedFsId, "parent");
  assert.equal(result.files[0].name, "sibling.txt");
});

test("searchFiles reports partial when some shares fail, without swallowing everything", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({
        msg_count: 2,
        msg_list: [
          { msg_id: "m1", uk: 1, file_list: [share("111", "good 报告", { isdir: "1" })] },
          { msg_id: "m2", uk: 2, file_list: [share("222", "bad", { isdir: "1" })] },
        ],
      });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const fsId = new URL(url).searchParams.get("fs_id");
      if (fsId === "222") return { errno: -3 };
      return makeApi([share("333", "inner 报告")]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", {});
  assert.equal(result.partial, true);
  assert.equal(result.failedShares, 1);
  assert.equal(result.results.some((r) => r.fsId === "333"), true, "good share results still returned");
});
