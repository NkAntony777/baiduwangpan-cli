# 贡献指南

感谢你愿意为 `baiduwangpan-cli` 出一份力。这个项目服务于 AI Agent，因此对**输出的确定性**和**文档与实现的一致性**有比较硬的要求 —— 下面写清楚这些要求，好让你少走弯路。

- [先开 Issue 还是直接开 PR？](#先开-issue-还是直接开-pr)
- [本地开发环境](#本地开发环境)
- [跑测试](#跑测试)
- [改动必须同步哪些文档](#改动必须同步哪些文档)
- [PR 的范围与提交信息](#pr-的范围与提交信息)
- [发布产物：baiduwangpan-skill.zip](#发布产物baiduwangpan-skillzip)
- [安全底线](#安全底线)
- [Code of Conduct](#code-of-conduct)

---

## 先开 Issue 还是直接开 PR？

| 改动类型 | 建议 |
| --- | --- |
| 修错别字、改措辞、补文档 | 直接开 PR |
| 小 bug 修复（有明确的复现步骤和预期行为） | 直接开 PR，PR 里写清复现方式 |
| 新增 CLI 命令 / MCP 工具 | **先开 Issue 讨论**，避免做完才发现方向不对 |
| 改动既有命令的默认行为或输出格式 | **先开 Issue 讨论**（破坏性变更） |
| 引入新的依赖 | **先开 Issue 讨论** |

Issue 里最好写清楚：你想解决什么问题、期望的行为、以及你验证过的现象。描述里**不要贴真实账号的 Cookie、BDUSS、STOKEN 或分享链接提取码**。

---

## 本地开发环境

- **Node.js ≥ 22.5**（`package.json` 的 `engines` 要求；开发用 24.x 也可以）
- **BaiduPCS-Go 引擎**：仓库根目录的 `BaiduPCS-Go.exe`（Windows）/`BaiduPCS-Go`（macOS/Linux）
  就是实际使用的引擎。`npm install` 的 postinstall 会自动下载；
  若网络不通导致引擎缺失，可从 [BaiduPCS-Go](https://github.com/qjfoidnh/BaiduPCS-Go) Releases 手动下载放进仓库根目录。
- 依赖只有 `ws` 一个：`npm install` 即可。

```bash
git clone https://github.com/NkAntony777/baiduwangpan-cli.git
cd baiduwangpan-cli
npm install
node bin/bdp.js --help
```

> **测试不需要真实账号。** 测试用隔离的配置目录和假引擎（`BDP_CONFIG_DIR`）跑，
> 不会碰你的网盘。但引擎二进制**必须**在仓库根目录 —— 缺了会表现为大批
> `spawn ENOENT` 失败，看起来像代码坏了，其实是环境没配好。

---

## 跑测试

```bash
npm test          # node --test test/*.test.js
```

除了功能测试，`test/doc-contract.test.js` 是一组**文档契约**测试：它们会把
README、CHANGELOG、Skill 文档、`lib/` 里的实际实现互相比对，任何一处数字或
字段对不上都会失败。**改了文档或命令数量，务必先跑这一组。**

约定：

- 测试文件放在 `test/`，命名 `*.test.js`，用 `node:test` + `node:assert/strict`。
- 涉及**平台特有行为**的用例，用 `{ skip: process.platform === "win32" }` 之类
  显式标注 —— 被 skip 的用例不会计入"全部通过"。
- 断言要覆盖**边界和失败路径**，不只是 happy path。
- 新增/删除用例后，**CHANGELOG 里最新一节的「测试总数」要同步更新**（契约 4b 会核对）。
  计数口径是**用例声明数**，不是某个平台上的通过数。

---

## 改动必须同步哪些文档

本项目的文档与实现由契约测试强制保持一致。改了下面任何一处，都要在**同一个 PR** 里同步：

| 你改了什么 | 必须同步 |
| --- | --- |
| 新增/删除 CLI 命令 | `README.md` 的命令表与「共 N 条 CLI 命令」、`skills/baiduwangpan/reference/commands.md`、`bin/bdp.js` 的 `COMMANDS` 表（契约 4 会核对命令数） |
| 新增/删除 MCP 工具 | README 的「M 个 MCP 工具」、`lib/mcp.js`（契约 4 会核对工具数） |
| 新增/删除错误码 | `lib/error-codes.js`、README 的「K 个内置错误码」、`skills/baiduwangpan/reference/commands.md` 的错误码表 |
| 改动 `bdp error` 的返回字段 | `commands.md` 的字段表、`skills/baiduwangpan/SKILL.md` 的要点 10、README 的命令表与能力表 —— **四处必须一致**（契约 2 会逐字比对） |
| 改动命令参数 | `bin/bdp.js` 的 `COMMANDS` 表 + `commands.md` + README 的通用选项 |
| 改动 `package.json` 版本号 | `skills/baiduwangpan/SKILL.md` 的 frontmatter `version`、文档里的 `meta.version` 示例（契约 3 会核对） |
| 任何行为变化 | `CHANGELOG.md` 的 `## Unreleased` 段 |
| 改了 `skills/baiduwangpan/` 下任何文件 | 重新构建 `baiduwangpan-skill.zip` 并更新 CHANGELOG 里的字节数（契约 5 会逐字节比对） |

### 写 CHANGELOG 的几条要求

- 新增内容写在 `## Unreleased` 下，**不要**改动已发布版本的小节。
- 一条一件事，**说清"改了什么"和"为什么"**，尤其是行为变化（此前是什么样、现在是什么样）。
- **不要把 PR 作者的声称直接抄进去。** 数字要自己核过 —— 测试总数、命令数、字节数都是。
  契约测试会核对数字，但不会核对"某平台全部通过"这类描述。
- 平台相关的限制（如"仅 Linux 执行"）要写明，否则会被误读成全平台行为。

---

## PR 的范围与提交信息

**一个 PR 做一件事。** 混在一起的 PR 很难审，也很难回滚。

提交信息用中文或英文都可以，遵循 Conventional Commits 的前缀风格：

```
feat(transfer): 新增分享转存命令
fix(shared): http dlink 升级为 https 而非直接拒绝
docs: 补充贡献指南
refactor(http): 拆分引擎调用与输出解析
```

PR 描述请包含：

1. **问题**：什么坏了 / 缺了什么，附**复现步骤**。
2. **改法**：你做了什么，以及**为什么选这个方案**（尤其是有取舍的地方）。
3. **验证**：跑了什么命令、结果是什么。**测试通过数要自己数一遍**，
   并说明是否有被 skip 的用例、在哪些平台上 skip。
4. **影响面**：改了共享的解析器/工具函数时，说明对**其他**命令的影响
   （这是最容易被漏掉的一类问题）。

### 如果 PR 还没做完

**开 Draft PR。** 明确写清哪些部分还没验收（例如"尚未用真实账号做跨账号上传验收"）。
Draft 表示"方向认可但还没准备好合并"，不丢人 —— 藏起来反而糟糕。

---

## 发布产物：baiduwangpan-skill.zip

`skills/baiduwangpan/` 会打包成 `baiduwangpan-skill.zip` 随包分发。

```bash
python scripts/build-skill-zip.py
```

改了 `skills/baiduwangpan/` 下的文件后**必须**重新构建，并更新 CHANGELOG 里
`baiduwangpan-skill.zip` 的字节数 —— 契约 5 会把 zip 和磁盘上的目录逐字节比对，
也会核对 CHANGELOG 里的体积。

---

## 安全底线

这几条不是风格偏好，是硬性要求：

- **不要把凭证写进代码、文档、日志或提交信息。** 包括 BDUSS、STOKEN、Cookie、分享链接提取码。
- **不要把真实账号的分享链接写进测试。** 测试用隔离目录 + 假引擎。
- **引擎输出属于不可信输入。** 百度返回的文件名、目录名可能包含控制字符或
  提示注入内容。仓库已有 `lib/sanitize.js` 与 `markUntrustedRawFields` 处理这件事；
  新增解析路径时要沿用，不要直接把引擎输出原样打进 JSON。
- **写操作要有确认闸门。** 破坏性操作（`rm`、覆盖、创建公开分享）需要 `--yes`
  或交互确认 —— 见 `lib/` 里 `requireYes` 的用法。
- **不许谎报成功。** 引擎失败时退出码仍可能是 0（上游只打印错误文本后 return），
  所以成功与否必须**看输出文本**，不能只看退出码。本仓库已有多个因为
  "引擎说成功但其实没删掉"而加的断言，请照此办理。

---

## Code of Conduct

请保持友善与专业。对事不对人 —— 批评代码，不批评提交者。

- 接受不同的意见和实现方式，但请说明取舍理由。
- 讨论聚焦于技术本身，不进行人身攻击。
- 拒绝骚扰、侮辱或人身攻击。

如有问题或需要举报，请通过 GitHub 私信联系维护者。

---

## 许可证

提交即表示你同意你的贡献将以 [MIT 协议](LICENSE) 授权发布。
