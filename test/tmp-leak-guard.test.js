// 防回归闸门：临时目录**不许再落系统 TEMP**。
//
// 背景（2026-11-25 扩族修，见 docs/tmp-leak-fix.md）：
//   2026-11-24 只堵了 test/pan.test.js 一个文件 ⇒ 实测全量跑完系统 TEMP
//   仍净增 11 个 bdp-idx-*（index-store.test.js 一个文件就有 11 处建目录）。
//   根因是**同一个错犯在了 34 个文件上**：各自 os.tmpdir() + 各自没有清理。
//
// 本文件是**自动闸门**，不靠人肉记忆：
//   ① 静态闸门：仓库里除白名单外，不许再出现 os.tmpdir()（注释除外）——
//      谁再写一行 mkdtemp(path.join(os.tmpdir(), ...)) 立即红。
//   ② 前缀闸门：仓库里出现的每一个 bdp-* 目录前缀都必须登记在 TMP_PREFIXES ——
//      新前缀漏登记 ⇒ 清扫会漏掉它 ⇒ 立即红。
//   ③ 运行时闸门：本进程跑下来，系统 TEMP 里**不许新增**任何 bdp-* 目录。
//   ④ 仓内闸门：.tmp/ 下不许留**未登记**的目录。
//
// 全量跑完的端到端数字（系统 TEMP 增量 = 0）由 scripts/tmp-leak-check.js 负责
// （它要在跑测试**之前**取基线，跑完再取一次），CI / 本地一条命令即可复现：
//     npm run test:tmp-leak
// 本文件里也留了一条同样的端到端闸门（默认关闭，避免并发跑全量时互相踩）：
//     BDP_TMP_LEAK_FULLRUN=1 node --test test/tmp-leak-guard.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const store = require("./tmp-store");
require("./tmp-helper"); // 装四道钩子 + 进程启动清扫

const ROOT = path.join(__dirname, "..");

/**
 * 允许出现 os.tmpdir() 的文件（各有正当理由，必须写清）：
 *   test/tmp-store.js           —— 清扫系统 TEMP 的**历史残留**（只读地列目录，不建目录）
 *   test/tmp-leak-guard.test.js —— 本文件自己**数**系统 TEMP 里的 bdp-* 目录
 *   scripts/tmp-leak-check.js   —— 端到端验收脚本，**跑前跑后各数一次**（只读）
 * 三者都只**读**系统 TEMP，一个都不许在里面建目录。
 */
const OS_TMPDIR_ALLOWED = new Set([
  "test/tmp-store.js",
  "test/tmp-leak-guard.test.js",
  "scripts/tmp-leak-check.js",
]);

/** 递归列出目录下所有 .js（相对仓库根，路径分隔符统一为 /）。 */
function listJs(relDir) {
  const out = [];
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = relDir + "/" + e.name;
    if (e.isDirectory()) out.push(...listJs(rel));
    else if (e.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

/**
 * 剥掉注释再扫描 —— 否则「注释里提到 os.tmpdir()」会被当成真调用。
 * 口径与 test/doc-contract.test.js 的 stripComments 一致（方向是放宽，不会误报）。
 */
function stripComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/["'`]/g) || []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join("\n");
}

/** 仓库里所有需要受检的源码（测试 + 产品 + 脚本 + 入口）。 */
function scanTargets() {
  return [...listJs("test"), ...listJs("lib"), ...listJs("scripts"), ...listJs("bin")];
}

/** 系统 TEMP 里现存的 bdp-* 目录名集合。 */
function systemTempBdpDirs() {
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("bdp-")).map((e) => e.name).sort();
}

// ── 跑之前先取基线（运行时闸门要用）──────────────────────────────
const BASELINE_SYSTEM_TEMP = systemTempBdpDirs();

test("闸门 ①：仓库里除白名单外，不许再出现 os.tmpdir()", () => {
  const offenders = [];
  for (const rel of scanTargets()) {
    if (OS_TMPDIR_ALLOWED.has(rel)) continue;
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    if (code.includes("tmpdir()")) {
      const line = code.split("\n").findIndex((l) => l.includes("tmpdir()")) + 1;
      offenders.push(rel + ":" + line);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "这些文件又在碰系统 TEMP 了 —— 临时目录一律落仓内 .tmp/（用 makeTempDir）：\n  " + offenders.join("\n  ")
  );
});

test("闸门 ②：每个 bdp-* 目录前缀都登记在 TMP_PREFIXES 里（漏登记 = 清扫会漏掉它）", () => {
  const used = new Map();
  for (const rel of scanTargets()) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const re = /["'](bdp-[a-z0-9-]*-)["']/g;
    let m;
    while ((m = re.exec(code))) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(rel);
    }
  }
  const unregistered = [...used.keys()].filter((p) => !store.TMP_PREFIXES.includes(p)).sort();
  assert.deepEqual(
    unregistered,
    [],
    "这些前缀没登记，清扫与计数都会漏掉它们（登记处：test/tmp-store.js 的 TMP_PREFIXES）：\n  " +
      unregistered.join("\n  ")
  );
  // 反向：登记在册的前缀不能有重复（重复 = 登记表自身有毛病）
  assert.equal(new Set(store.TMP_PREFIXES).size, store.TMP_PREFIXES.length, "TMP_PREFIXES 里有重复项");
  // 反向：登记的前缀不能是死条目（登记了但全仓没人用 = 登记表该清理）
  const dead = store.TMP_PREFIXES.filter((p) => !used.has(p));
  assert.deepEqual(dead, [], "TMP_PREFIXES 里有全仓没人用的死前缀：" + dead.join(", "));
});

test("闸门 ③：系统 TEMP 里没有新增任何 bdp-* 目录", () => {
  const now = systemTempBdpDirs();
  const added = now.filter((n) => !BASELINE_SYSTEM_TEMP.includes(n));
  assert.deepEqual(
    added,
    [],
    "这些 bdp-* 目录是本次跑出来的（落在系统 TEMP = C 盘）：\n  " + added.join("\n  ")
  );
});

test("闸门 ④：仓内 .tmp/ 下没有未登记的残留目录", () => {
  const root = store.TMP_ROOT;
  if (!fs.existsSync(root)) return; // 没建过临时目录 = 无残留
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const unregistered = dirs
    .map((e) => e.name)
    .filter((name) => !store.TMP_PREFIXES.some((p) => name.startsWith(p)))
    .sort();
  assert.deepEqual(
    unregistered,
    [],
    ".tmp/ 下有未登记前缀的目录（说明有代码绕过 tmp-store 自建目录）：\n  " + unregistered.join("\n  ")
  );
});

test("闸门 ⑤（端到端，默认关闭）：全量跑完后系统 TEMP 的 bdp-* 增量为 0", { skip: process.env.BDP_TMP_LEAK_FULLRUN !== "1" && "设 BDP_TMP_LEAK_FULLRUN=1 才跑（它会再跑一遍全量）" }, () => {
  const script = path.join(ROOT, "scripts", "tmp-leak-check.js");
  const r = spawnSync(process.execPath, [script], { encoding: "utf-8", timeout: 600000 });
  assert.equal(r.status, 0, "端到端闸门没过（脚本会打印实测数字）：\n" + (r.stdout || "") + (r.stderr || ""));
});
