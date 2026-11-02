// T-16：文档契约测试 —— 「文档漂移」的自动守门
//
// 为什么必须有：
//   「文档漂移」在这个项目里是**复发型**问题 —— CHANGELOG 9→12、SKILL 14→18、
//   字段清单漏 `codeText`、`meta.version` 示例过期、遗留清单漏 offline/share/recycle……
//   两轮审核各查出 9 项与 4 项 —— **靠人肉对拍已经证明不够**。
//   本测试把「字段清单 / 数量口径 / 版本号 / zip 一致性」变成**可执行断言**。
//
// **判据（怎么算它有用）**：把 commands.md 里的 `codeText` 删掉 → 本文件**必须失败**。
// （已实测：删掉后下面「字段清单四处一致」与「运行时键集 == 文档字段表」两条断言同时失败。）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "skills", "baiduwangpan");
const README_MD = path.join(ROOT, "README.md");
const CHANGELOG_MD = path.join(ROOT, "CHANGELOG.md");
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");
const COMMANDS_MD = path.join(SKILL_DIR, "reference", "commands.md");
const EXAMPLES_MD = path.join(SKILL_DIR, "reference", "examples.md");
const ZIP_PATH = path.join(ROOT, "baiduwangpan-skill.zip");
const BDP_JS = path.join(ROOT, "bin", "bdp.js");

const pkg = require("../package.json");
const errorCodes = require("../lib/error-codes");
const zip = require("../lib/zip");

function read(p) {
  return fs.readFileSync(p, "utf-8");
}

// ── 隔离配置：本测试绝不能碰用户的 ~/.bdp/config.json ──────────────────
const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-contract-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

test.after(() => {
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

function runCli(args) {
  const r = spawnSync(process.execPath, [BDP_JS].concat(args), {
    encoding: "utf-8",
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: TMP_CFG }),
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function runCliJson(args) {
  const r = runCli(args);
  assert.equal(r.code, 0, "命令 " + args.join(" ") + " 应成功退出，实际 " + r.code + "\n" + r.stderr);
  return JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
}

// ── 文档解析小工具 ─────────────────────────────────────────────────────

/** 取第一行包含 needle 的行 */
function findLine(text, needle, label) {
  const line = text.split("\n").find((l) => l.indexOf(needle) >= 0);
  assert.ok(line, (label || "文档") + " 里未找到包含「" + needle + "」的行");
  return line;
}

/** 解析「结构化: a/b/c」这类行内字段清单 */
function parseInlineFieldList(text, marker, label) {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, (label || "文档") + " 里未找到标记「" + marker + "」：" + text.slice(0, 160));
  const rest = text.slice(i + marker.length);
  const stop = rest.search(/[；;）)\n]/);
  const seg = stop >= 0 ? rest.slice(0, stop) : rest;
  return seg
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析「`code` / `name` / ...」这类反引号字段清单 */
function parseBacktickFieldList(line) {
  const out = [];
  const re = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1]);
  return out;
}

/** 解析 commands.md 的 error 章节字段表 */
function parseErrorFieldTable(md) {
  const start = md.indexOf("### error — 解释错误码");
  assert.ok(start > 0, "commands.md 应有「### error — 解释错误码（结构化）」章节");
  const rest = md.slice(start);
  const nextIdx = rest.indexOf("\n### ", 10);
  const section = nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
  const fields = [];
  const re = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm;
  let m;
  while ((m = re.exec(section))) fields.push(m[1]);
  assert.ok(fields.length > 0, "commands.md 的 error 字段表没解析出字段");
  return fields;
}

/** 统计仓库里的测试数（与 node --test 的计数口径一致：顶层 test(...) 声明 + 子测试） */
function countTests() {
  const dir = path.join(ROOT, "test");
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".test.js"))) {
    const s = fs.readFileSync(path.join(dir, f), "utf-8");
    n += (s.match(/^\s*test\(/gm) || []).length;
    n += (s.match(/\bt\.test\(/g) || []).length;
  }
  return n;
}

/**
 * 解析「并发数 | 改前 | 改后」这类性能表 → { 并发数: "改前 -> 改后" }
 */
function parsePerfTable(md) {
  const lines = md.split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    if (!/\|\s*并发数\s*\|/.test(lines[i])) continue;
    for (let j = i + 2; j < lines.length; j++) {
      // 允许行首缩进 —— CHANGELOG 的表格在列表里，是缩进的
      const m = lines[j].match(/^\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (!m) break;
      out[m[1]] = m[2].replace(/\*/g, "").trim() + " -> " + m[3].replace(/\*/g, "").trim();
    }
    break;
  }
  return out;
}

/** 文档里用反引号包起来的代码片段（避免在源码里直接写反引号） */
function codeSpans(text) {
  const BT = String.fromCharCode(96);
  const parts = text.split(BT);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) out.push(parts[i]);
  return out;
}

/**
 * 解析文档里的「已知遗留（同步引擎路径）」清单 → 命令名数组
 */
function parseSyncEngineList(md) {
  // 三处的措辞不同（README/commands.md 用「已知遗留（同步引擎路径）」，
  // SKILL.md 用「已知遗留：部分命令仍是同步引擎路径」）—— 所以按行扫描而不是按固定正则。
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.indexOf("同步引擎路径") >= 0);
  assert.ok(start >= 0, "文档里应能找到「同步引擎路径」清单");
  const spans = [];
  for (let i = start; i < lines.length && i < start + 8; i++) {
    for (const s of codeSpans(lines[i])) spans.push(s);
    if (lines[i].indexOf("迁移列入 v1.11.0") >= 0) break;
  }
  const names = spans.filter(
    (x) =>
      /^[a-z]{2,12}$/.test(x) &&
      x !== "ls" &&
      x !== "search" &&
      x !== "preview" &&
      x !== "api" &&
      x !== "web"
  );
  return Array.from(new Set(names)).sort();
}

/**
 * 源码里走**同步**引擎的调用点总数 —— **v1.11.0 起必须为 0**。
 *
 * 判定两件事：
 *   1. 没有任何地方用 spawnSync 启动 BaiduPCS-Go 引擎进程（它会冻结整个事件循环）
 *   2. 不存在**同步**的 runPCS / runPCSResult 包装器（async 的不算）
 */
function countSyncEngineCallSites() {
  const files = ["lib/pan.js", "lib/pcs-extra.js", "lib/preview.js"];
  let n = 0;
  for (const f of files) {
    const src = read(path.join(ROOT, f));
    // 同步 spawn 引擎
    n += (src.match(/spawnSync\(\s*(?:cfg\.)?pcsPath/g) || []).length;
    // 同步的引擎包装器（async function runPCS( 不算）
    n += (src.match(/^(?!async )function runPCS(?:Result)?\(/gm) || []).length;
  }
  return n;
}

/**
 * 取文档里的「同步引擎路径」说明段（用于断言「已清零」）。
 */
function extractSyncSection(md) {
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => l.indexOf("同步引擎路径") >= 0);
  if (idx < 0) return null;
  const out = [];
  for (let i = idx; i < lines.length && i < idx + 8; i++) {
    out.push(lines[i]);
    if (lines[i].trim() === "") break;
  }
  return out.join("\n");
}

/**
 * 「仍走同步引擎路径」的命令 → 它们用到的引擎子命令。
 * 每个子命令都必须在源码里真实出现（防止文档与实现各说各话）。
 */
const SYNC_COMMAND_SUBCOMMANDS = {
  cat: ["locate", "meta"],
  head: ["locate"],
  tail: ["locate", "meta"],
  grep: ["locate"],
  peek: ["locate", "meta"],
  get: ["locate", "meta", "d"],
  put: ["u"],
  mkdir: ["mkdir"],
  rm: ["rm"],
  mv: ["mv"],
  cp: ["cp"],
  quota: ["quota"],
  offline: ["offlinedl"],
  share: ["share"],
  recycle: ["recycle"],
};

/** 取 CHANGELOG 的最新版本段（第一个 ## 小节） */
function latestChangelogSection() {
  const md = read(CHANGELOG_MD);
  const start = md.indexOf("\n## ");
  assert.ok(start > 0, "CHANGELOG.md 应有版本小节");
  const rest = md.slice(start + 1);
  const nextIdx = rest.indexOf("\n## ", 3);
  return nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
}

// ── 契约 1：运行时键集 == 文档字段表 ───────────────────────────────────

test("契约 1: bdp error --json / --verbose / bdp_error 的键集与文档字段表一致", () => {
  const docFields = parseErrorFieldTable(read(COMMANDS_MD));
  const defaultKeys = Object.keys(runCliJson(["error", "-3", "--json"]))
    .filter((k) => k !== "meta")
    .sort();
  const verboseKeys = Object.keys(runCliJson(["error", "-3", "--json", "--verbose"]))
    .filter((k) => k !== "meta")
    .sort();

  assert.deepEqual(
    verboseKeys,
    docFields.slice().sort(),
    "verbose 输出的键集应等于 commands.md 的字段表（internalDetail 在 verbose 下才出现）"
  );
  assert.deepEqual(
    defaultKeys,
    docFields.filter((f) => f !== "internalDetail").sort(),
    "默认输出的键集应等于字段表去掉 internalDetail"
  );
  assert.equal(
    defaultKeys.includes("internalDetail"),
    false,
    "默认输出**不得**下发 internalDetail（默认只给结论）"
  );
});

test("契约 1b: MCP bdp_error 与 CLI bdp error 的键集一致", async () => {
  const mcp = require("../lib/mcp");
  const cliKeys = Object.keys(runCliJson(["error", "-3", "--json"]))
    .filter((k) => k !== "meta")
    .sort();
  const mcpKeys = Object.keys(await mcp.callTool("bdp_error", { code: "-3" })).sort();
  assert.deepEqual(mcpKeys, cliKeys, "MCP bdp_error 与 CLI bdp error 的键集应逐字段一致");
});

// ── 契约 2：四处字段清单逐字段一致 ─────────────────────────────────────

test("契约 2: 字段清单四处一致（bdp help / SKILL.md / commands.md / README）", () => {
  const expected = parseErrorFieldTable(read(COMMANDS_MD))
    .filter((f) => f !== "internalDetail")
    .slice()
    .sort();

  const helpDesc = runCliJson(["help", "error", "--json"]).desc;
  const helpFields = parseInlineFieldList(helpDesc, "返回 ", "bdp help error");
  assert.deepEqual(helpFields.slice().sort(), expected, "bdp help error 的字段清单与文档不一致");

  const skillLine = findLine(read(SKILL_MD), "（数值）", "SKILL.md");
  const skillFields = parseBacktickFieldList(skillLine);
  assert.deepEqual(skillFields.slice().sort(), expected, "SKILL.md 要点 10 的字段清单与文档不一致");

  const readmeLine = findLine(read(README_MD), "bdp error <code> [--json]", "README.md");
  const readmeFields = parseInlineFieldList(readmeLine, "结构化: ", "README.md 命令表");
  assert.deepEqual(readmeFields.slice().sort(), expected, "README 命令表的字段清单与文档不一致");

  const readmeFeature = findLine(read(README_MD), "内置错误码字典", "README.md");
  const readmeFeatureFields = parseInlineFieldList(readmeFeature, "返回结构化：", "README.md 能力表");
  assert.deepEqual(
    readmeFeatureFields.slice().sort(),
    expected,
    "README 能力表的字段清单与文档不一致"
  );
});

// ── 契约 3：版本号口径 ─────────────────────────────────────────────────

test("契约 3: package.json 版本 == SKILL.md frontmatter == 文档里的 meta.version 示例", () => {
  const skill = read(SKILL_MD);
  const m = skill.match(/^version:\s*(\S+)\s*$/m);
  assert.ok(m, "SKILL.md frontmatter 应有 version 字段");
  assert.equal(m[1], pkg.version, "SKILL.md frontmatter 的 version 应等于 package.json 的 version");

  // 运行时 meta.version
  const runtimeVersion = runCliJson(["error", "-3", "--json"]).meta.version;
  assert.equal(runtimeVersion, pkg.version, "运行时 meta.version 应等于 package.json 的 version");

  // 文档里的 meta.version 示例（CHANGELOG 是**历史记录**，允许保留旧版本号）
  for (const p of [COMMANDS_MD, EXAMPLES_MD, README_MD]) {
    const doc = read(p);
    const versions = Array.from(doc.matchAll(/"version":\s*"([^"]+)"/g)).map((x) => x[1]);
    for (const v of versions) {
      assert.equal(v, pkg.version, p.split(path.sep).pop() + " 里的 meta.version 示例 " + v + " 与 package.json 不一致");
    }
  }
});

// ── 契约 4：数量口径 ───────────────────────────────────────────────────

test("契约 4: 数量口径（CLI 命令 / MCP 工具 / 错误码）与实际一致", () => {
  const help = runCliJson(["help", "--json"]);
  const tools = require("../lib/mcp").toolDefs().length;
  const errCount = errorCodes.listErrors().length;

  // MCP 工具数：README / SKILL.md / commands.md 里写的「N 个工具」
  const toolClaims = [
    ["README.md", read(README_MD), /(\d+)\s*个工具/g],
    ["README.md", read(README_MD), /(\d+)\s*个带\s*schema\s*的工具/g],
    ["SKILL.md", read(SKILL_MD), /MCP 工具从\s*\d+\s*→\s*\*\*(\d+)\*\*/g],
    ["SKILL.md", read(SKILL_MD), /暴露\s*(\d+)\s*个工具/g],
    ["commands.md", read(COMMANDS_MD), /\*\*(\d+)\s*个工具\*\*/g],
  ];
  for (const [label, doc, re] of toolClaims) {
    for (const m of doc.matchAll(re)) {
      assert.equal(Number(m[1]), tools, label + " 写的 MCP 工具数「" + m[1] + "」与实际 " + tools + " 不一致");
    }
  }

  // 数量口径总表（README 里那一句「共 N 条 CLI 命令、M 个 MCP 工具、K 个错误码」）
  const readme = read(README_MD);
  const summary = readme.match(/共\s*\*\*(\d+)\*\*\s*条\s*CLI\s*命令[\s\S]{0,40}?\*\*(\d+)\*\*\s*个\s*MCP\s*工具[\s\S]{0,40}?\*\*(\d+)\*\*\s*个内置错误码/);
  assert.ok(summary, "README 应有一句数量口径总表（用于自动核对）");
  assert.equal(Number(summary[1]), help.commands.length, "README 写的 CLI 命令数与实际不一致");
  assert.equal(Number(summary[2]), tools, "README 写的 MCP 工具数与实际不一致");
  assert.equal(Number(summary[3]), errCount, "README 写的错误码数与实际不一致");
});

test("契约 4b: CHANGELOG 最新版本的「测试总数」与实际测试数一致", () => {
  const section = latestChangelogSection();
  const m = section.match(/测试总数\s*\d+\s*→\s*\*\*(\d+)\*\*/);
  assert.ok(m, "CHANGELOG 最新版本段应写明「测试总数 N → **M**」");
  assert.equal(Number(m[1]), countTests(), "CHANGELOG 写的测试数与实际测试数不一致");
});

// ── 契约 5：skill zip 与 skills/ 逐字节一致 ───────────────────────────

test("契约 5: baiduwangpan-skill.zip 与 skills/baiduwangpan/ 逐字节一致", () => {
  const buf = fs.readFileSync(ZIP_PATH);
  const entries = zip.readZipEntries(buf);
  assert.ok(entries.length > 0, "skill zip 应能解析出条目");

  const fileEntries = entries.filter((e) => !e.name.endsWith("/"));
  assert.equal(fileEntries.length, 8, "skill zip 应有 8 个文件条目，实际 " + fileEntries.length);

  for (const e of fileEntries) {
    const rel = e.name.replace(/^baiduwangpan\//, "");
    const diskPath = path.join(SKILL_DIR, rel.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(diskPath), "zip 里的 " + rel + " 在 skills/ 下不存在");
    const inZip = zip.readZipMember(buf, e);
    const onDisk = fs.readFileSync(diskPath);
    assert.ok(
      inZip.equals(onDisk),
      "zip 里的 " + rel + " 与磁盘不一致（zip 需重建）"
    );
  }

  // CHANGELOG 里写的 zip 体积应与实际一致
  // （D13 这类漂移正是从「文档写的数字与产物对不上」漏出来的）
  const zm = latestChangelogSection().match(/baiduwangpan-skill\.zip[^\n]*?([\d,]+)\s*字节/);
  assert.ok(zm, "CHANGELOG 最新版本段应写明 baiduwangpan-skill.zip 的字节数");
  assert.equal(
    Number(zm[1].replace(/,/g, "")),
    fs.statSync(ZIP_PATH).size,
    "CHANGELOG 写的 zip 体积与实际不一致"
  );
});

// ── 契约 6：D6 退出码语义 ────────────────────────────────────────────────
test("契约 6: 退出码语义（只给开关不给命令 → 1；裸跑 bdp → 0）", () => {
  const missing = runCli(["--json"]);
  assert.equal(missing.code, 1, "只给全局开关不给命令应退出 1");
  const parsed = JSON.parse(missing.stdout.replace(/^\uFEFF/, ""));
  assert.ok(
    parsed.error && parsed.error.indexOf("缺少命令") >= 0,
    "应给出「缺少命令」: " + missing.stdout.slice(0, 200)
  );
  const bare = runCli([]);
  assert.equal(bare.code, 0, "裸跑 bdp 应退出 0");
  assert.ok(bare.stdout.length > 100, "裸跑应打印帮助");
});

// ── 契约 7：D5 布尔取值集合 == lib/flags.js ───────────────────────────────
test("契约 7: 文档的布尔取值集合 == lib/flags.js 的 TRUE_SET/FALSE_SET", () => {
  const flags = require("../lib/flags");
  const md = read(COMMANDS_MD);
  const m = md.match(/是布尔参数：接受 ([^。]*)。/);
  assert.ok(m, "commands.md 应写明布尔参数的取值集合");
  const docVals = codeSpans(m[1]).map((x) => x.replace(/^"|"$/g, ""));
  const expected = new Set(
    Array.from(flags.TRUE_SET).concat(Array.from(flags.FALSE_SET))
  );
  assert.deepEqual(
    new Set(docVals),
    expected,
    "文档写的布尔取值集合应与 lib/flags.js 完全一致（不多不少）"
  );
});

// ── 契约 8：D8 bdp error 的 code 取值规则 ────────────────────────────────
test("契约 8: bdp error 的 code 取值规则（三种写法命中 + 非登记判定）", () => {
  const cases = [
    ["31066", 31066],
    ["errno=31066", 31066],
    ["errno = -3", -3],
  ];
  for (const [input, expectedCode] of cases) {
    const j = runCliJson(["error", input, "--json"]);
    assert.equal(j.code, expectedCode, input + " 应命中错误码 " + expectedCode);
    assert.equal(typeof j.code, "number", "code 恒为数值");
  }
  const unknown = runCliJson(["error", "abc31066", "--json"]);
  assert.equal(unknown.code, null, "abc31066 应判为未登记（code 为 null）");
  assert.equal(unknown.codeText, "abc31066", "未登记码应原样回显 codeText");
});

// ── 契约 9：D9 同步遗留清单（三处一致 + 与实现对得上）────────────────────
test("契约 9: 同步引擎路径已清零（源码无同步引擎调用 + 文档声明归零）", () => {
  // 1) 结构性保证：源码里**没有任何**同步引擎调用点
  assert.equal(
    countSyncEngineCallSites(),
    0,
    "仍有同步引擎调用点 —— 同步路径没有清干净（spawnSync 会冻结整个事件循环）"
  );

  // 2) 文档：三处都必须声明「已清零」，且不得再把任何命令列成同步遗留
  for (const [label, md] of [
    ["README.md", read(README_MD)],
    ["SKILL.md", read(SKILL_MD)],
    ["commands.md", read(COMMANDS_MD)],
  ]) {
    const section = extractSyncSection(md);
    assert.ok(section, label + " 应有「同步引擎路径」说明段");
    assert.ok(
      /已清零|0 条|没有遗留/.test(section),
      label + " 的同步引擎路径说明应声明已清零，实际:\n" + section
    );
    const still = codeSpans(section).filter((x) => Object.prototype.hasOwnProperty.call(SYNC_COMMAND_SUBCOMMANDS, x));
    assert.deepEqual(
      still,
      [],
      label + " 不应再把任何命令列成「仍走同步引擎路径」: " + still.join(", ")
    );
  }
});

// ── 契约 10：D10 README 与 CHANGELOG 的性能表互校 ───────────────────────
test("契约 10: README 与 CHANGELOG 的并发性能表逐格一致", () => {
  const readme = parsePerfTable(read(README_MD));
  const chg = parsePerfTable(read(CHANGELOG_MD));
  assert.ok(
    Object.keys(readme).length >= 4,
    "README 应有 1/2/4/8 四档并发表，实际 " + Object.keys(readme).length
  );
  assert.deepEqual(readme, chg, "README 与 CHANGELOG 的并发性能表必须逐格一致");

  const timers = (md) => {
    const m = md.match(/定时器[^\n]*?(\d+)\s*次/);
    return m ? Number(m[1]) : null;
  };
  const rt = timers(read(README_MD));
  const ct = timers(read(CHANGELOG_MD));
  assert.ok(rt !== null && ct !== null, "两处都应写明定时器触发次数");
  assert.equal(rt, ct, "README 与 CHANGELOG 的定时器触发次数应一致");
});
