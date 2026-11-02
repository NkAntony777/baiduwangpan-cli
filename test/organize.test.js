const test = require("node:test");
const assert = require("node:assert/strict");
const organize = require("../lib/organize");

test("organize: extOfName 取小写扩展名", () => {
  assert.equal(organize.extOfName("a.PDF"), "pdf");
  assert.equal(organize.extOfName("dir/b.tar.gz"), "gz");
  assert.equal(organize.extOfName("noext"), "");
  assert.equal(organize.extOfName(".hidden"), "");
});

test("organize: yearOf 从 mtime 取年份", () => {
  assert.equal(organize.yearOf(1704067200), "2024");
  assert.equal(organize.yearOf(0), null);
});

test("organize: 按类型归类到中文目录名", () => {
  const c = organize.classifyFile(
    { path: "/x/a.pdf", name: "a.pdf", mtime: 1704067200, size: 1 },
    { byType: true, byYear: true, targetRoot: "/归档", layout: "type-year" }
  );
  assert.equal(c.target, "/归档/文档/2024/a.pdf");
  // 只开 byType → 不产生年份层
  const onlyType = organize.classifyFile(
    { path: "/x/a.pdf", name: "a.pdf", mtime: 1704067200, size: 1 },
    { byType: true, targetRoot: "/归档", layout: "type-year" }
  );
  assert.equal(onlyType.target, "/归档/文档/a.pdf");
});

test("organize: layout 决定层级顺序", () => {
  const f = { path: "/src/a.pdf", name: "a.pdf", mtime: 1704067200, size: 1 };
  const ty = organize.classifyFile(f, { byType: true, byYear: true, targetRoot: "/A", layout: "type-year" });
  const yt = organize.classifyFile(f, { byType: true, byYear: true, targetRoot: "/A", layout: "year-type" });
  assert.equal(ty.target, "/A/文档/2024/a.pdf");
  assert.equal(yt.target, "/A/2024/文档/a.pdf");
});

test("organize: 按来源归类保留来源层级", () => {
  const c = organize.classifyFile(
    { path: "/来自：iPhone/IMG_1.jpg", name: "IMG_1.jpg", mtime: 1704067200, size: 1 },
    { bySource: true, byType: true, sourceRoot: "/", targetRoot: "/归档", layout: "source-type" }
  );
  assert.equal(c.target, "/归档/来自：iPhone/图片/IMG_1.jpg");
});

test("organize: 目标重名自动加序号去重", () => {
  const files = [
    { path: "/a/report.pdf", name: "report.pdf", mtime: 1704067200, size: 1 },
    { path: "/b/report.pdf", name: "report.pdf", mtime: 1704067200, size: 2 },
    { path: "/c/report.pdf", name: "report.pdf", mtime: 1704067200, size: 3 },
  ];
  const r = organize.buildPlan(files, { byType: true, targetRoot: "/归档", layout: "type-year" });
  assert.equal(r.plan.length, 3);
  assert.equal(r.plan[0].to, "/归档/文档/report.pdf");
  assert.equal(r.plan[1].to, "/归档/文档/report (2).pdf");
  assert.equal(r.plan[2].to, "/归档/文档/report (3).pdf");
  assert.equal(r.summary.conflicts, 2);
  // 目标路径必须互不相同，否则移动会因「目标已存在」失败
  const targets = new Set(r.plan.map((p) => p.to));
  assert.equal(targets.size, 3);
});

test("organize: 已在目标目录内的文件被跳过", () => {
  const r = organize.buildPlan(
    [{ path: "/归档/文档/a.pdf", name: "a.pdf", mtime: 1704067200, size: 1 }],
    { byType: true, targetRoot: "/归档", layout: "type-year" }
  );
  assert.equal(r.plan.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /已在目标目录/);
});

test("organize: 未指定任何维度时不产生计划", () => {
  const r = organize.buildPlan(
    [{ path: "/a/b.pdf", name: "b.pdf", mtime: 1704067200, size: 1 }],
    { targetRoot: "/归档" }
  );
  assert.equal(r.plan.length, 0);
});
