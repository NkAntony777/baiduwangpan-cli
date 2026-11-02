const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

// 隔离配置目录（config.js 在模块加载时读取 BDP_CONFIG_DIR，必须先设）
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-corr-cfg-"));
process.env.BDP_CONFIG_DIR = CFG_DIR;

const config = require("../lib/config");
const organize = require("../lib/organize");

test.after(() => {
  const resolved = path.resolve(CFG_DIR);
  assert.ok(resolved.indexOf(path.resolve(os.tmpdir())) === 0);
  fs.rmSync(resolved, { recursive: true, force: true });
});

// ── dedup.js：先替换 http 模块，才能控制 /api/list 的返回 ──
const httpPath = require.resolve("../lib/http");
const realHttp = require("../lib/http");
let listHandler = async () => ({ errno: 0, list: [] });
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: Object.assign({}, realHttp, {
    getBdstoken: async () => "fake-token",
    webJson: async (url) => listHandler(url),
  }),
};
const dedup = require("../lib/dedup");

function dirOf(url) {
  const m = url.match(/[?&]dir=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

test("dedup: 目录扫描失败 → partial=true 且报出失败目录（不能静默少扫）", async () => {
  listHandler = async (url) => {
    const dir = dirOf(url);
    if (dir === "/root/bad") throw new Error("network down");
    if (dir === "/root") {
      return {
        errno: 0,
        list: [
          { path: "/root/ok/f.txt", server_filename: "f.txt", size: 10, md5: "a".repeat(32), isdir: 0, server_mtime: 1 },
          { path: "/root/bad", server_filename: "bad", isdir: 1 },
        ],
      };
    }
    return { errno: 0, list: [] };
  };
  const r = await dedup.scanFiles("/root", { concurrency: 2, maxDepth: 12 });
  assert.equal(r.partial, true, "目录失败必须让 partial 为 true");
  assert.equal(r.failed, 1);
  assert.ok(r.failedDirs.includes("/root/bad"), "失败目录要报出来");
  assert.ok(r.files.some((f) => f.path === "/root/ok/f.txt"));
});

test("dedup: 返回的越界路径被丢弃（/medsub 不算 /med 的子目录）", async () => {
  listHandler = async (url) => {
    if (dirOf(url) === "/med") {
      return {
        errno: 0,
        list: [
          { path: "/med/ok/f.txt", server_filename: "f.txt", size: 10, md5: "b".repeat(32), isdir: 0 },
          { path: "/medsub/x/sneak.txt", server_filename: "sneak.txt", size: 10, md5: "c".repeat(32), isdir: 0 },
        ],
      };
    }
    return { errno: 0, list: [] };
  };
  const r = await dedup.scanFiles("/med", { concurrency: 2, maxDepth: 12 });
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes("/med/ok/f.txt"));
  assert.ok(!paths.includes("/medsub/x/sneak.txt"), "越界路径必须被丢弃");
  assert.equal(r.partial, true, "越界条目应计为畸形 → partial");
});

// ── organize.js ──────────────────────────────────────────

test("organize: 导出 LAYOUTS 白名单", () => {
  assert.ok(Array.isArray(organize.LAYOUTS));
  assert.ok(organize.LAYOUTS.includes("type-year"));
  assert.ok(organize.LAYOUTS.includes("source-year"));
});

test("organize: 目标在网盘上已存在 → 自动改名并计数（计划不能指向已存在的文件）", () => {
  const files = [
    { path: "/归档/文档/report.pdf", name: "report.pdf", size: 1, mtime: 0 },
    { path: "/a/report.pdf", name: "report.pdf", size: 1, mtime: 0 },
  ];
  const r = organize.buildPlan(files, {
    byType: true, targetRoot: "/归档", layout: "type-year", sourceRoot: "/",
  });
  assert.equal(r.summary.targetExists, 1);
  assert.equal(r.plan.length, 1);
  assert.ok(r.plan[0].to !== "/归档/文档/report.pdf", "计划不能指向网盘上已存在的文件");
  assert.match(r.plan[0].to, /report \(2\)\.pdf$/);
  assert.ok(r.warnings.length > 0, "应有警告");
});

test("organize: 同名去重不产生叠名，且目标互不相同", () => {
  const files = [
    { path: "/a/report.pdf", name: "report.pdf", size: 1, mtime: 0 },
    { path: "/b/report.pdf", name: "report.pdf", size: 1, mtime: 0 },
    { path: "/c/report (2).pdf", name: "report (2).pdf", size: 1, mtime: 0 },
  ];
  const r = organize.buildPlan(files, {
    byType: true, targetRoot: "/归档", layout: "type-year", sourceRoot: "/",
  });
  const targets = r.plan.map((p) => p.to);
  assert.equal(new Set(targets).size, targets.length, "目标必须互不相同");
  assert.ok(!targets.some((t) => /\(2\) \(2\)/.test(t)), "不应出现 report (2) (2).pdf 这类叠名");
});

test("organize: 扩展名去尾部空格；负数 mtime 不落到 1970", () => {
  assert.equal(organize.extOfName("报告.pdf "), "pdf");
  assert.equal(organize.extOfName("报告.PDF"), "pdf");
  assert.equal(organize.yearOf(-1), null);
  assert.equal(organize.yearOf(0), null);
});

// ── config.js ────────────────────────────────────────────

test("config: 激活 profile 时 --set 写入 profile（不再是静默空操作）", () => {
  config.save({});
  config.useProfile("work");
  config.setAuth({ bduss: "b", stoken: "s", webTransport: "curl" });
  assert.equal(config.get().webTransport, "curl");

  const r = config.setConfig("webTransport", "native");
  assert.equal(r.ok, true);
  assert.equal(r.scope, "profile:work");
  assert.equal(config.get().webTransport, "native", "生效值必须真的变");
  config.unsetProfile();
});

// ── CLI ──────────────────────────────────────────────────

test("CLI: organize --layout 非法值被拒绝（exit 1，不静默兜底）", () => {
  const r = spawnSync(process.execPath, [BDP_JS, "organize", "/x", "--by", "type", "--layout", "garbage"], {
    encoding: "utf-8",
    timeout: 60000,
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: CFG_DIR }),
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /--layout/);
});

test("CLI: organize --help 里列出了合法的 --layout 取值", () => {
  const r = spawnSync(process.execPath, [BDP_JS, "help", "organize", "--json"], {
    encoding: "utf-8",
    timeout: 60000,
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: CFG_DIR }),
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const opt = (j.options || []).find((o) => o.indexOf("--layout") === 0);
  assert.ok(opt, "帮助里应有 --layout");
  for (const l of organize.LAYOUTS) {
    assert.ok(opt.indexOf(l) >= 0, "帮助应列出 " + l);
  }
});
