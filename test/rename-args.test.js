// `bdp_rename` / `bdp_organize.target` 的参数闸门（MCP 侧）。
//
// 回归背景（我在审并行会话的 WIP 时实测）：
//   `bdp_rename {files:[{from:"/a.txt", to:123}]}` 此前会把 123 String() 成 "/123"，
//   `{to:{}}` 变成 "/[object Object]"，`{from:123}` 变成 "/123" ——
//   `dryRun:false` 时这是**真的在网盘上改名**。与 v1.11.2 修的
//   `bdp_mkdir {path:123}`（真的建出名为 123 的目录）属于同一类缺陷：
//   **非字符串参数被静默强转成真实写操作**。
//   另外 `bdp_organize {target:123}` 也把数字直接当目标根目录用。
// CLI 不受影响（argv 天然是字符串），缺口只在 MCP。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-rename-args-"));
process.env.BDP_CONFIG_DIR = TMP_CFG;
fs.writeFileSync(
  path.join(TMP_CFG, "config.json"),
  JSON.stringify({ ua: "test-ua", pcsPath: "BaiduPCS-Go" }),
  "utf-8"
);

// 引擎调用计数：参数错误与 dry-run 都**不允许**触发真实 mv
const panPath = require.resolve("../lib/pan");
const realPan = require(panPath);
let mvCalls = 0;
require.cache[panPath] = {
  id: panPath,
  filename: panPath,
  loaded: true,
  exports: Object.assign({}, realPan, {
    mv: async (src, dst) => {
      mvCalls++;
      return { op: "rename", src, dst };
    },
  }),
};

const mcp = require("../lib/mcp");
const { renameFiles } = require("../lib/rename");

test.after(() => {
  fs.rmSync(TMP_CFG, { recursive: true, force: true });
});

async function callExpectError(name, args, re) {
  let err = null;
  try {
    await mcp.callTool(name, args);
  } catch (e) {
    err = e;
  }
  assert.ok(err, name + " " + JSON.stringify(args) + " 应报错（不能成功）");
  assert.equal(
    err.toolArgumentError,
    true,
    name + " " + JSON.stringify(args) + " 应标记为参数错误（-32001），实际: " + err.message
  );
  assert.match(err.message, re, name + " " + JSON.stringify(args) + " 的错误消息不符");
}

test("参数校验: bdp_rename 的非字符串 from/to 一律拒绝（-32001）", async () => {
  await callExpectError("bdp_rename", { files: [{ from: "/a.txt", to: 123 }] }, /必须是字符串/);
  await callExpectError("bdp_rename", { files: [{ from: "/a.txt", to: {} }] }, /必须是字符串/);
  await callExpectError("bdp_rename", { files: [{ from: "/a.txt", to: ["b"] }] }, /必须是字符串/);
  await callExpectError("bdp_rename", { files: [{ from: 123, to: "b.txt" }] }, /必须是字符串/);
  await callExpectError("bdp_rename", { files: [{ from: "/a.txt" }] }, /不能为空/);
  await callExpectError("bdp_rename", { files: [] }, /不能为空/);
  await callExpectError("bdp_rename", { files: ["x"] }, /必须是 \{from, to\} 对象/);
  await callExpectError("bdp_rename", { files: [{ from: "/a\u0001.txt", to: "b.txt" }] }, /控制字符/);
});

test("参数校验: 目标名含路径分隔符时逐条记失败（批量接口语义，不整体抛错）", async () => {
  const r = await mcp.callTool("bdp_rename", { files: [{ from: "/a.txt", to: "/x/y.txt" }] });
  assert.equal(r.failed, 1, "含 / 的目标名应记为该条失败");
  assert.match(r.results[0].error, /只允许改文件名/, "应提示改名不能跨目录");
});

test("参数校验: bdp_organize 的 target 必须是字符串路径", async () => {
  await callExpectError("bdp_organize", { byType: true, target: 123 }, /必须是字符串/);
  await callExpectError("bdp_organize", { byType: true, target: { a: 1 } }, /必须是字符串/);
});

test("参数错误与默认 dry-run 都不得触发真实 mv", async () => {
  mvCalls = 0;
  for (const args of [
    { files: [{ from: "/a.txt", to: 123 }] },
    { files: [{ from: "/a.txt" }] },
  ]) {
    try {
      await mcp.callTool("bdp_rename", args);
    } catch (e) {
      /* 预期报错 */
    }
  }
  assert.equal(mvCalls, 0, "参数错误时不得调用引擎 mv");

  // 合法调用：默认 dry-run，只出计划，也不许 mv
  const plan = await mcp.callTool("bdp_rename", {
    files: [{ from: "/文档/a.txt", to: "b.txt" }],
  });
  assert.equal(plan.dryRun, true, "bdp_rename 默认应是 dry-run");
  assert.equal(plan.results[0].to, "/文档/b.txt", "目标应拼在**原目录**下");
  assert.equal(mvCalls, 0, "dry-run 不得调用引擎 mv");
});

test("renameFiles 兜底：非字符串直接拒绝，不再 String() 强转", async () => {
  const r = await renameFiles([{ from: 123, to: 456 }], { dryRun: true });
  assert.equal(r.failed, 1, "非字符串项应计为失败");
  assert.match(r.results[0].error, /必须是字符串/, "错误消息应说明类型问题");
});
