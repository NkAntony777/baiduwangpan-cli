// CLI 选项取值守卫的边界用例（v1.10.1 四路审核后补）
//
// 覆盖三组审核发现：
//   - `--profile -x`（单个连字符）此前会**建出并激活**一个名为 "-x" 的垃圾 profile
//   - `--profile " "`（纯空白）此前**静默忽略**并切到「无 profile」
//   - 后置位 `--profile=x` 等号形式此前不被支持（前置位支持 → 前后不对称）
//   - 前置位取值错误此前不走 JSON 通道（同一意图两种通道）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");

function withCfg(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-flag-guard-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args) {
  return spawnSync(process.execPath, [BDP_JS].concat(args), {
    encoding: "utf-8",
    timeout: 60000,
    env: Object.assign({}, process.env, { BDP_CONFIG_DIR: dir }),
  });
}

function readCfg(dir) {
  const f = path.join(dir, "config.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

test("守卫: --profile 取值以单个连字符开头时拒绝，且不建出垃圾 profile", () => {
  withCfg((dir) => {
    const r = run(dir, ["error", "-3", "--profile", "-x"]);
    assert.equal(r.status, 1, "应报错退出");
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(out.indexOf("--profile") >= 0, "错误消息应提到 --profile: " + out.slice(0, 200));
    const cfg = readCfg(dir);
    if (cfg) {
      assert.equal(cfg.activeProfile, undefined, "不应激活任何 profile");
      assert.equal(
        Object.prototype.hasOwnProperty.call(cfg.profiles || {}, "-x"),
        false,
        "不应建出名为 -x 的 profile"
      );
    }
  });
});

test("守卫: --profile 取值是纯空白时拒绝（不再静默忽略）", () => {
  withCfg((dir) => {
    const r = run(dir, ["error", "-3", "--profile", " "]);
    assert.equal(r.status, 1, "应报错退出");
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(out.indexOf("--profile") >= 0, "错误消息应提到 --profile: " + out.slice(0, 200));
  });
});

test("守卫: --json-file 取值是纯空白时拒绝", () => {
  withCfg((dir) => {
    const r = run(dir, ["error", "-3", "--json-file", " "]);
    assert.equal(r.status, 1, "应报错退出");
  });
});

test("等号形式: 后置位 --profile=x 与前置位行为一致", () => {
  withCfg((dir) => {
    const r = run(dir, ["error", "-3", "--profile=work", "--json"]);
    assert.equal(r.status, 0, "后置位 --profile=x 应被接受，实际 " + r.status + "\n" + r.stderr);
    const cfg = readCfg(dir);
    if (cfg) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(cfg.profiles || {}, "work"),
        true,
        "应建出名为 work 的 profile"
      );
    }
  });
});

test("等号形式: 后置位 --json-file=path 生效", () => {
  withCfg((dir) => {
    const outFile = path.join(dir, "out.json");
    const r = run(dir, ["error", "-3", "--json-file=" + outFile]);
    assert.equal(r.status, 0, "应成功: " + r.stderr);
    assert.ok(fs.existsSync(outFile), "应生成 JSON 文件");
    const j = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    assert.equal(j.code, -3, "文件内容应是结构化错误码");
  });
});

test("通道一致: 前置位取值错误也走 JSON 通道（与后置位一致）", () => {
  withCfg((dir) => {
    const pre = run(dir, ["--profile", "--json", "error", "-3"]);
    const post = run(dir, ["error", "-3", "--profile", "--json"]);
    assert.equal(pre.status, 1);
    assert.equal(post.status, 1);
    // 两个都应能在 stdout 里拿到 JSON 错误体
    for (const [label, r] of [["前置位", pre], ["后置位", post]]) {
      let parsed = null;
      try {
        parsed = JSON.parse((r.stdout || "").trim());
      } catch {
        parsed = null;
      }
      assert.ok(parsed && parsed.error, label + " 应返回 JSON 错误体，实际 stdout=" + JSON.stringify(r.stdout));
    }
  });
});
