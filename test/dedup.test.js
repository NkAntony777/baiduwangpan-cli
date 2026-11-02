const test = require("node:test");
const assert = require("node:assert/strict");
const dedup = require("../lib/dedup");

const FILE = (path, size, md5, obfuscated) => ({
  path,
  name: path.split("/").pop(),
  size,
  md5,
  rawMd5: md5,
  obfuscated: !!obfuscated,
  mtime: 0,
  fsId: 1,
});

test("groupBySize: 只有同尺寸文件才进候选组", () => {
  const files = [
    FILE("/a.txt", 100, "aa"),
    FILE("/b.txt", 100, "bb"),
    FILE("/c.txt", 200, "cc"),
  ];
  const groups = dedup.groupBySize(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 100);
  assert.equal(groups[0].files.length, 2);
});

test("groupBySize: 0 字节文件不参与（避免大量空文件误报）", () => {
  const groups = dedup.groupBySize([FILE("/a", 0, "x"), FILE("/b", 0, "y")]);
  assert.equal(groups.length, 0);
});

test("refineByMd5: 同尺寸但 md5 不同 → 不算重复", () => {
  const groups = dedup.groupBySize([
    FILE("/a", 100, "md5-a"),
    FILE("/b", 100, "md5-b"),
  ]);
  const clusters = dedup.refineByMd5(groups);
  assert.equal(clusters.length, 0);
});

test("refineByMd5: 同尺寸同 md5 → 判为重复并计算可回收空间", () => {
  const groups = dedup.groupBySize([
    FILE("/a", 100, "same"),
    FILE("/b", 100, "same"),
    FILE("/c", 100, "same"),
  ]);
  const clusters = dedup.refineByMd5(groups);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].files.length, 3);
  assert.equal(clusters[0].wasted, 200);
});

test("refineByMd5: 结果按可回收空间降序", () => {
  const groups = dedup.groupBySize([
    FILE("/small1", 10, "s"), FILE("/small2", 10, "s"),
    FILE("/big1", 1000, "b"), FILE("/big2", 1000, "b"),
  ]);
  const clusters = dedup.refineByMd5(groups);
  assert.equal(clusters[0].size, 1000);
});

test("pickKeepers: 默认保留路径最短的副本", () => {
  const clusters = dedup.refineByMd5(
    dedup.groupBySize([
      FILE("/very/long/path/deep/file.zip", 100, "m"),
      FILE("/f.zip", 100, "m"),
    ])
  );
  const kept = dedup.pickKeepers(clusters);
  assert.equal(kept[0].keep, "/f.zip");
  assert.deepEqual(kept[0].removable, ["/very/long/path/deep/file.zip"]);
});

test("pickKeepers: oldest 策略保留修改时间最早的", () => {
  const a = { ...FILE("/a", 100, "m"), mtime: 500 };
  const b = { ...FILE("/b", 100, "m"), mtime: 100 };
  const clusters = dedup.refineByMd5(dedup.groupBySize([a, b]));
  const kept = dedup.pickKeepers(clusters, { keep: "oldest" });
  assert.equal(kept[0].keep, "/b");
});

test("pickKeepers: removable 永远不含 keep 本身", () => {
  const clusters = dedup.refineByMd5(
    dedup.groupBySize([FILE("/a", 1, "m"), FILE("/b", 1, "m"), FILE("/c", 1, "m")])
  );
  const kept = dedup.pickKeepers(clusters);
  assert.equal(kept[0].removable.length, 2);
  assert.ok(!kept[0].removable.includes(kept[0].keep));
});
