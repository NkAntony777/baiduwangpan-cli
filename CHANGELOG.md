# Changelog

本文件记录 baiduwangpan-cli 的显著变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## v1.7.0 — 2026-11-02

> 主题：**把"Agent 友好"真正做实** —— 可信的退出码、真正的结构化输出、正确的编码识别，
> 并新增 MCP 接入方式。

### 🔴 安全

- **`bdp config --json` 不再明文泄漏凭证**
  - 此前 JSON 输出会完整吐出 BDUSS/STOKEN，而 SKILL.md 恰恰要求 Agent "优先使用 `--json`"，
    两条规则直接冲突 —— Agent 越听话泄漏越多。
  - 现在默认脱敏（保留前 10 位 + `...` + 后 4 位），JSON 带 `"redacted": true`。
  - 确需原值时显式 `--show-secrets`。

### 🔴 正确性

- **失败不再伪装成功（退出码契约）**
  - `ls` / `get` / `put` / `du` 失败时退出码曾为 **0**；其中 `get` 会把失败包装成
    "下载完成, 0 字节"，Agent 看到 exit=0 + 有 localPath 会误判为下载成功。
  - 现在引擎输出中的错误信号（"遇到错误, 远端服务器返回错误, 代码: N"）会被解析并抛错，
    失败一律以退出码 1 结束，`--json` 输出带 `{"error": "...", "errno": N}`。
  - `get` 额外检测"引擎返回 0 字节但远端应有大小"的情况。
- **GBK / Big5 编码识别修复**
  - 编码检测的 GBK 回退分支曾是死代码：`Buffer.toString("utf-8")` 遇到非法字节**永不抛错**
    （替换成 U+FFFD），所以永远走不到 GBK 分支 —— 实测 75% 字符变乱码，
    且 `grep` 在这类文件上**静默返回空**（比乱码更糟，看起来像"确实没有"）。
  - 现在 UTF-8 用 `TextDecoder(fatal:true)` 严格检测；GBK/Big5 因 gb18030 的 4 字节序列规则
    会误判合法 GBK，改用"替换字符比例"择优。
  - 影响面：用户的 `/传统文化`、`/中医`、`/玄学` 三个目录（357 GB / 5781 个文件）以古籍 TXT 为主。
- **表格解析不再错位**
  - `ls` / `search` 的表格来自 go-olekukonko/tablewriter，**表头居中、数据按类型对齐**，
    列偏移与表头不一致，按偏移切列会整体错位。
  - 改用无歧义的日期列（`YYYY-MM-DD HH:MM:SS`）作为切分锚点。

### 🟠 输出契约

- **`ls` / `search` 的 `--json` 返回真正的结构化数据**
  - 此前只是把引擎的定宽中文文本表格原样塞进 `raw`，Agent 必须自己写正则解析。
  - 现在返回 `entries[]`：`index` / `name` / `path` / `isDir` / `size` / `sizeText` /
    `mtime` / `mtimeText`，并含 `fileCount` / `dirCount` / `totalText` 汇总。
- **`search` 新增分页与限流**
  - 新增 `--limit`（默认 50）/ `--page` / `--max-results` / `--fields`。
  - 输出含 `total` / `returned` / `hasMore` / `nextPage`。
  - 动机：实测 `search "中医"` 单次输出 **515 KB / 1842 条 ≈ 13 万 tokens**，一次搜索就能吃光上下文窗口。
- **`gls` 补上 `nextPage`**
  - SKILL.md 一直让 Agent 用 `--page <nextPage>` 翻页，但 `gls` 的输出里从来没有这个字段。
- **二进制守卫**
  - `cat` / `head` / `tail` / `grep` 遇到 PDF / zip / 图片 / 音视频时**拒绝按文本读取**，
    直接报错并提示改用 `bdp get`，避免把二进制乱码灌进 Agent 上下文。
  - `peek` 的 `type` 字段改用魔数识别（此前 PDF 被误判为 `text` 并吐出 PDF 源码），
    并新增 `binary` / `detectReason` / `encoding` 字段。
- **`du` 的完整性标注**
  - `capped` / `partial` 沿路径向上传播，不再出现"capped:false 但 size 实际不完整"。
  - 新增 `depthLimit` / `depthRequested` / `depthCapped` / `--progress`。
  - 实测 `--depth 3` 扫出 598 GB，而 `bdp quota` 显示已用 6.64 TB —— 深度封顶导致少算 11 倍，
    现在这一差距会通过 `partial: true` 明确暴露。

### 🟢 功能

- **MCP 服务器（`bdp serve --mcp`）**
  - stdio 传输、JSON-RPC 2.0、换行分隔。
  - 暴露 10 个带强类型 JSON Schema 的工具：`bdp_ls` / `bdp_search` / `bdp_read` / `bdp_peek` /
    `bdp_quota` / `bdp_get` / `bdp_put` / `bdp_mkdir` / `bdp_groups` / `bdp_gsearch`。
  - 兑现了 `package.json` 里一直挂着却无实现的 `mcp` keyword。
- **`share list` 恢复可用**
  - BaiduPCS-Go v4.0.1 的 `share list` 有 nil pointer panic（引擎 bug），此前整个功能不可用。
  - 改走网页 API `/share/record`，输出含 shareId / 链接 / 提取码 / 过期时间 / 浏览次数。
- **`rm` 支持批量与确认**
  - 支持多路径删除、`--yes`、结构化输出。
  - 非交互环境（Agent / 管道）**必须显式 `--yes`**，否则拒绝执行并返回退出码 1；
    交互终端弹 y/N 确认。
- **`mkdir` 幂等**
  - 目录已存在（errno=31061）不再算失败，JSON 返回 `{"created":false,"exists":true}`。
- **`bdp error -3` 可执行**
  - 负数错误码此前被当成未知选项而报错（帮助文档里的范例本身就是失效的）；
    现在负数按位置参数处理，`bdp error -- -3` 也支持。

### 📚 文档

- SKILL.md 全面重写：新增编码/二进制说明、结果规模控制、MCP 接入、`rm --yes` 约定、退出码可信约定。
- reference/commands.md：逐条更新受影响命令。
- reference/troubleshooting.md：新增"命令失败但退出码是 0"、"`du` 的 size 比 quota 小很多"等排查条目。
- 新增 `scripts/build-skill-zip.py`：可复现的 skill 打包脚本。
- 新增 CHANGELOG.md。

### 🧪 测试

- 127 → **163** 个测试（新增 `table` / `file-type` / `encoding` / `mcp` / `fixes` 五个测试文件）。

---

## v1.6.0 — 2026-10-25

- 下载可靠性（分块并发 + md5/size 校验 + 断点续传）
- 扩展命令（`du` 容量分析 / `recycle` 回收站 / `offline` 离线下载）
- 命令注册表单一数据源（`bdp help --json`）
- 架构统一（`lib/` 模块化）

## v1.3.0 — 2026-08

- 多账号 profile 管理（`--profile` / `bdp profile`）

## v1.2.0 — 2026-08

- `bdp get` 改为直链分块下载（绕过引擎的不支持断点续传问题）

## v1.1.5 — 2026-08

- `gdownload` 支持多 fs_id zip 打包下载

## v1.1.3 — 2026-07

- 群聊分享浏览工作流（`gshares` / `gls` / `gsearch` / `gdownload`）

## v1.1.0 — 2026-07

- 引擎自动发现：postinstall 失败后可从版本子目录找到 BaiduPCS-Go 二进制

## v1.0.0 — 2026-06

- 首个正式版：全盘浏览 / 免下载读取 / 上传下载 / 群聊文件浏览
