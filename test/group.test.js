const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 缓存写入隔离到临时目录，避免污染真实 ~/.bdp/cache
const TMP_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-cache-test-"));
process.env.BDP_CACHE_DIR = TMP_CACHE;

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

test("listFiles auto-resolves mismatched fromUk/msgId when shareinfo returns errno=2131", async () => {
  const seenMsgIds = [];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("999", "top", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const msgId = new URL(url).searchParams.get("msg_id");
      seenMsgIds.push(msgId);
      if (msgId === "wrong-msg") return { errno: 2131 };
      return makeApi([share("777", "ok.txt")]);
    }
    throw new Error("unexpected url " + url);
  };

  // 用户显式传入与 gshares 不一致的 fromUk/msgId → API 2131 → 自动按 fsId 纠正重试
  const result = await group.listFiles("gid", "999", { fromUk: "2", msgId: "wrong-msg" });
  assert.equal(result.autoResolved, true, "autoResolved flag set");
  assert.equal(result.msgId, "m1", "corrected to gshares msgId");
  assert.equal(result.fromUk, "1", "corrected to gshares fromUk");
  assert.equal(result.files[0].name, "ok.txt");
  assert.deepEqual(seenMsgIds, ["wrong-msg", "m1"], "retried once with resolved params");
});

test("listFiles reports detailed errno=2131 error when msgId not in group and fsId unresolvable", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("999", "top", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      return { errno: 2131 };
    }
    throw new Error("unexpected url " + url);
  };

  await assert.rejects(
    group.listFiles("gid", "subdir-of-another-group", { fromUk: "2", msgId: "foreign-msg" }),
    (e) => e instanceof ShareApiError && e.errno === 2131 && /不属于群/.test(e.message),
    "detailed 2131 error with guidance"
  );
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

// ── 新逆向能力：全页遍历 / 限流自愈 / 缓存 / 游标分页 ──

test("searchFiles fetches ALL pages of a directory when has_more=1 (no data loss beyond 100)", async () => {
  const pages = [];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      if (page === 1) {
        return makeApi(Array.from({ length: 100 }, (_, i) => share(String(1000 + i), "f" + String(i).padStart(3, "0") + " 报告")), { hasMore: true });
      }
      if (page === 2) {
        return makeApi(Array.from({ length: 50 }, (_, i) => share(String(2000 + i), "g" + String(i).padStart(3, "0") + " 报告")));
      }
      throw new Error("unexpected page " + page);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", { limit: 200 });
  assert.deepEqual(pages, [1, 2], "walked page 1 and page 2");
  assert.equal(result.results.length, 150, "no records lost beyond the 100/page cap");
  assert.equal(result.hasMore, false);
});

test("fetchShareDir retries throttled self-echo responses then succeeds", async () => {
  let shareinfoCalls = 0;
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      shareinfoCalls++;
      if (shareinfoCalls <= 2) {
        // 限流退化：errno=0 但返回"目录自身"
        return makeApi([share("dir1", "TOP", { isdir: "1" })]);
      }
      return makeApi([share("500", "ok 报告")]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", {});
  assert.equal(shareinfoCalls, 3, "two self-echo retries then success");
  assert.equal(result.results.some((r) => r.fsId === "500"), true);
  assert.equal(result.partial, false);
});

test("searchFiles session cache prevents re-fetching the same directory", async () => {
  let shareinfoCalls = 0;
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      shareinfoCalls++;
      return makeApi([share("500", "B 报告")]);
    }
    throw new Error("unexpected url " + url);
  };

  const first = await group.searchFiles("gid", "报告", { cache: true });
  const second = await group.searchFiles("gid", "报告", { cache: true });
  assert.equal(first.results.length, 1);
  assert.equal(second.results.length, 1);
  assert.equal(shareinfoCalls, 1, "second search reused cached directory listing");
  assert.equal(second.cachedDirs, 1);
});

test("disk cache persists across fresh module state (L2)", async () => {
  // 直接验证缓存落盘：listShares 结果可从磁盘读回
  mockHttp.webJson = async (url) => {
    if (!url.includes("/mbox/group/listshare")) throw new Error("unexpected url " + url);
    return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("1", "a.txt")] }] });
  };
  await group.listShares("disk-gid", { cache: true });

  // 清空内存 L1（保留磁盘），模拟新进程
  const cacheDir = process.env.BDP_CACHE_DIR;
  const files = fs.readdirSync(cacheDir);
  assert.ok(files.length > 0, "cache files written to disk");
  // 磁盘文件可 JSON 解析且含值
  const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), "utf-8"));
  assert.ok(Array.isArray(raw.value) && raw.value[0].fsId === "1");
});

test("searchFiles stops when request budget exhausted and reports partial", async () => {
  const pagesFetched = [];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const page = Number(new URL(url).searchParams.get("page"));
      pagesFetched.push(page);
      return makeApi(Array.from({ length: 100 }, (_, i) => share(String(page * 1000 + i), "x" + page + "_" + i + " 报告")), { hasMore: true });
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", { maxRequests: 2, limit: 500 });
  assert.deepEqual(pagesFetched, [1, 2], "budget of 2 allows exactly 2 pages");
  assert.equal(result.partial, true, "budget exhaustion marks partial");
  assert.equal(result.failedShares, 1);
  assert.equal(result.budgetUsed, 2);
});

test("searchFiles stops early on sustained throttle (3 consecutive self-echo)", async () => {
  const shareinfoCalls = [];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({
        msg_count: 2,
        msg_list: [
          { msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP1", { isdir: "1" })] },
          { msg_id: "m2", uk: 2, file_list: [share("dir2", "TOP2", { isdir: "1" })] },
          { msg_id: "m3", uk: 3, file_list: [share("dir3", "TOP3", { isdir: "1" })] },
          { msg_id: "m4", uk: 4, file_list: [share("dir4", "TOP4", { isdir: "1" })] },
          { msg_id: "m5", uk: 5, file_list: [share("dir5", "TOP5", { isdir: "1" })] },
          { msg_id: "m6", uk: 6, file_list: [share("dir6", "TOP6", { isdir: "1" })] },
        ],
      });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      const fsId = new URL(url).searchParams.get("fs_id");
      shareinfoCalls.push(fsId);
      // 所有目录都返回 self-echo（限流中）
      return makeApi([share(fsId, fsId, { isdir: "1" })]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", {});
  assert.equal(result.throttled, true, "throttled flag set");
  assert.equal(result.partial, true);
  // 第一批(dir1-4)全部失败后 consecutive>=3 → 停止扫描，第二批(dir5/dir6)不再请求
  assert.ok(!shareinfoCalls.includes("dir5"), "scan stopped before second batch dir5");
  assert.ok(!shareinfoCalls.includes("dir6"), "scan stopped before second batch dir6");
});

test("searchFiles handles malformed percent-encoded paths (URI malformed bug)", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("dir1", "TOP", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      // 路径含裸 %（非法百分号编码）——旧实现 decodeURIComponent 会抛 URIError 报废整个目录
      return makeApi([
        share("1", "normal 报告"),
        { ...share("2", "bad%name 报告"), path: "/bad%name%2", server_filename: "bad%name 报告" },
        { ...share("3", "ok%20encoded 报告"), path: "/ok%20encoded", server_filename: "ok%20encoded 报告" },
      ]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", {});
  assert.equal(result.partial, false, "directory with malformed path no longer fails");
  assert.equal(result.failedShares, 0);
  const byName = Object.fromEntries(result.results.map((r) => [r.name, r.path]));
  assert.equal(byName["bad%name 报告"], "/bad%name%2", "malformed path kept raw instead of throwing");
  assert.equal(byName["ok%20encoded 报告"], "/ok encoded", "valid percent-encoding still decoded");
  assert.equal(byName["normal 报告"], "/normal 报告");
});

test("listShares paginates with last_msg_time cursor when has_more=1", async () => {
  const cursors = [];
  mockHttp.webJson = async (url) => {
    if (!url.includes("/mbox/group/listshare")) throw new Error("unexpected url " + url);
    const lm = new URL(url).searchParams.get("last_msg_time") || "";
    cursors.push(lm);
    if (!lm) {
      // last_msg_time 为响应顶层字段（真实 API 结构）
      return { errno: 0, has_more: 1, last_msg_time: "111", records: { msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("1", "a.txt")] }] } };
    }
    return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m2", uk: 1, file_list: [share("2", "b.txt")] }] });
  };

  const shares = await group.listShares("gid", {});
  assert.deepEqual(cursors, ["", "111"], "second request carries last_msg_time cursor");
  assert.equal(shares.length, 2);
  assert.deepEqual(shares.map((s) => s.fsId).sort(), ["1", "2"]);
});

test("searchFiles reports complete:false/partial:true when page fills before full scan", async () => {
  // 30 个匹配的顶层分享，limit=5 → 第 1 页填满即停，未扫完全部
  const items = [];
  for (let i = 0; i < 30; i++) items.push(share(String(2000 + i), "F" + String(i).padStart(2, "0") + " 报告"));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      return makeApi([]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", { page: 1, limit: 5 });
  assert.equal(result.results.length, 5);
  assert.equal(result.hasMore, true);
  assert.equal(result.complete, false, "page 填满即停，不应 complete:true");
  assert.equal(result.partial, true);
  assert.equal(result.stoppedReason, "page-limit");
  assert.ok(result.scannedShares < result.totalShares);
});

test("searchFiles complete:true only when whole share set scanned without failures", async () => {
  const items = [];
  for (let i = 0; i < 3; i++) items.push(share(String(2100 + i), "G" + String(i) + " 报告"));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      return makeApi([]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", { page: 1, limit: 50 });
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.stoppedReason, "complete");
  assert.equal(result.hasMore, false);
});

test("searchFiles returns partial results on timeout (complete:false, partial:true, timedOut:true)", async () => {
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: [share("3000", "T1", { isdir: "1" })] }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      await new Promise((r) => setTimeout(r, 60));
      return makeApi([share("3001", "T 报告")]);
    }
    throw new Error("unexpected url " + url);
  };

  const result = await group.searchFiles("gid", "报告", { timeoutMs: 1, limit: 50 });
  assert.equal(result.timedOut, true);
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.stoppedReason, "timeout");
});

test("searchFiles onProgress reports running snapshots and final state", async () => {
  const items = [];
  for (let i = 0; i < 3; i++) items.push(share(String(2200 + i), "H" + String(i) + " 报告", { isdir: "1" }));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) {
      return makeApi([]);
    }
    throw new Error("unexpected url " + url);
  };

  const snapshots = [];
  const result = await group.searchFiles("gid", "报告", {
    limit: 50,
    onProgress: (snap) => snapshots.push(snap),
  });
  assert.ok(snapshots.length >= 2, "至少一次 running + 一次 final");
  assert.ok(snapshots.some((s) => s.running === true), "有 running 快照");
  const finalSnap = snapshots[snapshots.length - 1];
  assert.equal(finalSnap.running, false);
  assert.equal(finalSnap.complete, true);
  assert.equal(finalSnap.partial, false);
  assert.equal(result.complete, true);
});

test("gsearch single keyword still substring-matches (backward compat)", async () => {
  const names = ["玄空飞星资料", "玄空大卦", "飞星盘"];
  const items = names.map((n, i) => share(String(4300 + i), n));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) return makeApi([]);
    throw new Error("unexpected url " + url);
  };
  const result = await group.searchFiles("gid", "玄空", {});
  assert.deepEqual(result.results.map((r) => r.name).sort(), ["/玄空大卦", "/玄空飞星资料"]);
});

test("gsearch multi-keyword default matches ALL words (AND, order-independent)", async () => {
  const names = ["玄空飞星资料", "玄空大卦", "飞星盘", "其它资料"];
  const items = names.map((n, i) => share(String(4400 + i), n));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) return makeApi([]);
    throw new Error("unexpected url " + url);
  };
  const result = await group.searchFiles("gid", "玄空 飞星", {});
  assert.deepEqual(result.results.map((r) => r.name), ["/玄空飞星资料"]);
});

test("gsearch --any-word matches ANY keyword (OR)", async () => {
  const names = ["玄空飞星资料", "玄空大卦", "飞星盘", "其它资料"];
  const items = names.map((n, i) => share(String(4500 + i), n));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) return makeApi([]);
    throw new Error("unexpected url " + url);
  };
  const result = await group.searchFiles("gid", "玄空 飞星", { anyWord: true });
  assert.deepEqual(result.results.map((r) => r.name).sort(), ["/玄空大卦", "/玄空飞星资料", "/飞星盘"]);
});

test("gsearch --exact matches exact file name (case-insensitive)", async () => {
  const names = ["玄空飞星资料", "玄空飞星资料集"];
  const items = names.map((n, i) => share(String(4600 + i), n));
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) return makeApi([]);
    throw new Error("unexpected url " + url);
  };
  const result = await group.searchFiles("gid", "玄空飞星资料", { exact: true });
  assert.deepEqual(result.results.map((r) => r.name), ["/玄空飞星资料"]);
  // exact 对大小写不敏感（英文字母场景）
  const items2 = [share("4700", "Report.pdf"), share("4701", "report.PDF"), share("4702", "report-final.pdf")];
  mockHttp.webJson = async (url) => {
    if (url.includes("/mbox/group/listshare")) {
      return makeApi({ msg_count: 1, msg_list: [{ msg_id: "m1", uk: 1, file_list: items2 }] });
    }
    if (url.includes("/mbox/msg/shareinfo")) return makeApi([]);
    throw new Error("unexpected url " + url);
  };
  const exactCase = await group.searchFiles("gid", "report.pdf", { exact: true });
  assert.deepEqual(exactCase.results.map((r) => r.name).sort(), ["/Report.pdf", "/report.PDF"]);
});
