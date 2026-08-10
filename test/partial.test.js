const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { defaultPartialFile, buildPartialPayload } = require("../lib/partial");

test("defaultPartialFile generates a safe filename in cwd", () => {
  const f = defaultPartialFile("539478953581833690", "玄空飞星", {
    cwd: "C:/tmp",
    date: new Date("2026-08-10T12:34:56.789Z"),
  });
  assert.equal(
    f,
    path.join("C:/tmp", "bdp-gsearch-539478953581833690-玄空飞星-partial-2026-08-10T12-34-56-789Z.json")
  );
});

test("defaultPartialFile sanitizes illegal filename characters", () => {
  const f = defaultPartialFile("gid", "a/b\\c:d*e?f\"g<h>i|j", { cwd: "C:/tmp", date: new Date(0) });
  const base = path.basename(f);
  assert.ok(!/[\\/:*?"<>|]/.test(base), "no illegal chars in: " + base);
  assert.ok(base.startsWith("bdp-gsearch-gid-a_b_c_d_e_f_g_h_i_j-partial-"));
});

test("buildPartialPayload marks saved:partial with diagnostics", () => {
  const result = {
    results: [{ name: "x" }, { name: "y" }],
    page: 1,
    pageSize: 50,
    timedOut: true,
    stoppedReason: "timeout",
    scannedShares: 12,
    totalShares: 73,
    failedShares: 1,
    throttledShares: 0,
    cachedDirs: 5,
    budgetUsed: 20,
    depth: 3,
    maxPages: 50,
  };
  const p = buildPartialPayload(result, { gid: "g", keyword: "kw" });
  assert.equal(p.saved, "partial");
  assert.equal(p.partial, true);
  assert.equal(p.complete, false);
  assert.equal(p.timedOut, true);
  assert.equal(p.stoppedReason, "timeout");
  assert.equal(p.total, 2);
  assert.deepEqual(p.results, [{ name: "x" }, { name: "y" }]);
  assert.equal(p.gid, "g");
  assert.equal(p.keyword, "kw");
  assert.equal(p.scannedShares, 12);
  assert.equal(p.budgetUsed, 20);
});
