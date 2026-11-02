// 引擎超时时限的边界守卫（边界穷举审核的发现 → v1.10.2）
//
// 三项：
//   1. setTimeout 的 32 位溢出：BDP_ENGINE_TIMEOUT_MS ≥ 2^31 会被 Node **静默截断成 1ms**
//      → 用户把超时调大，反而每一次引擎调用都在 4ms 内失败，且提示宣称「超时 2147484 秒」
//   2. 非法取值（0 / 负数 / 非数字）不得变成 1ms 的病态超时
//   3. 同步版 spawnSync 的 ENOBUFS **不含通道信息** —— 必须靠已收回的字节数反推
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

// ── 1 + 2：时限归一化 ──────────────────────────────────────────────────
test("时限: 超过 2^31-1 的取值被截到上界（Node setTimeout 溢出）", () => {
  const et = require("../lib/engine-timeout.js");
  assert.equal(et.MAX_TIMEOUT_MS, 2147483647);
  assert.equal(et.normalizeTimeout("2147483648", 120000), 2147483647);
  assert.equal(et.normalizeTimeout("9999999999", 120000), 2147483647);
  assert.equal(et.normalizeTimeout("2147483647", 120000), 2147483647);
  assert.equal(et.normalizeTimeout("999999999", 120000), 999999999);
});

test("时限: 非法/非正取值回落到默认值（不得变成 1ms 的病态超时）", () => {
  const et = require("../lib/engine-timeout.js");
  assert.equal(et.normalizeTimeout("0", 120000), 120000);
  assert.equal(et.normalizeTimeout("-1", 120000), 120000);
  assert.equal(et.normalizeTimeout("abc", 120000), 120000);
  assert.equal(et.normalizeTimeout("", 120000), 120000);
  assert.equal(et.normalizeTimeout(undefined, 120000), 120000);
  // 合法值原样保留
  assert.equal(et.normalizeTimeout("1500", 120000), 1500);
  assert.equal(et.normalizeTimeout(" 2000 ", 120000), 2000);
});

// ── 3：同步版 ENOBUFS 用例已随「同步引擎路径」一起删除（v1.11.0）──
//    异步路径本来就分别报告 stdout / stderr 通道（见 test/async-engine.test.js 的 T-03）。
// ── 「只给 --profile 不给命令」不得建号 ────────────────────────────────
test("CLI: 只给 --profile 不给命令 → 退出 1，且不建出/激活 profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-prof-only-"));
  try {
    const r = spawnSync(process.execPath, [BDP_JS, "--profile", "x"], {
      encoding: "utf-8",
      timeout: 60000,
      env: Object.assign({}, process.env, { BDP_CONFIG_DIR: dir }),
    });
    assert.equal(r.status, 1, "应报错退出");
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(out.indexOf("缺少命令") >= 0, "应报「缺少命令」: " + out.slice(0, 200));
    const f = path.join(dir, "config.json");
    if (fs.existsSync(f)) {
      const cfg = JSON.parse(fs.readFileSync(f, "utf-8"));
      assert.equal(
        Object.prototype.hasOwnProperty.call(cfg.profiles || {}, "x"),
        false,
        "不应建出名为 x 的 profile"
      );
      assert.equal(cfg.activeProfile, undefined, "不应激活任何 profile");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
