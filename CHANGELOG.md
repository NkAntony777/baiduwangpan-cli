# Changelog

本文件记录 baiduwangpan-cli 的显著变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## v1.8.0 — 2026-11-02

> 主题：**把网盘变成可检索、可清理、可读的知识库** ——
> 新增去重、全类型预览、本地全文索引三个能力。
>
> 附带一个关键突破：**破解了百度的 md5 混淆**，让"重复文件"第一次能被可靠识别。

### 🔴 关键突破：md5 反混淆

- **百度返回的 md5 是混淆值，不是文件真实 md5**
  - 实测：同一份内容放在两个不同路径，`/api/list` 返回的 md5 **竟不相同**
    （`d8df7aa4do8092bb…` vs `512b5f54d9fc3fc3…`）。
  - 不解密就做去重，会把同一份文件误判成两份不同文件 —— **漏报**。
- **算法来源**：BaiduPCS-Go 源码 `baidupcs/util.go → DecryptMD5()`
  （仓库已从 `qjf2016/BaiduPCS-Go` 迁移至 `qjfoidnh/BaiduPCS-Go`）。
  原理：第 10 位若是非十六进制字符则作密钥，`num ^ (15 & i)` 逐位还原，
  最后按 `[8:16]+[0:8]+[24:32]+[16:24]` 重排四段。
- **已移植到 `lib/md5.js` 并用真实网盘数据验证 15/15 通过**
  （混淆值与真值双向、跨路径同一内容还原一致、非法输入不抛异常）。
- **性能意义**：解密后可直接用 `/api/list` 一次返回的全目录 md5 做比对，
  **零额外请求**；相比逐文件调引擎 `meta` 快两个数量级。

### 🟢 新增：`bdp dedup` — 重复文件清理

- 两阶段策略：先按 **size 粗筛**（零成本），再对候选组按**反混淆后的真实 md5 精算**。
- 实测（`/med/AI课程资料合集/实战项目合集`）：312 个文件 → 31 组重复、32 个冗余文件、
  **可释放 16.5 GB**；全盘样本中单个重复簇达 12.3 GB。
- 报告同时给出"按 size 粗筛"与"md5 精算"两个数字 —— 差值即被 size 误判、
  实为不同内容的文件（md5 精算正确排除了它们）。
- 删除走百度**回收站**（可恢复），与 `bdp rm` 保持一致的确认哲学：
  非交互环境必须显式 `--yes`。

### 🟢 新增：`bdp preview` — 多类型内容预览

- **PDF 文本提取（纯 JS 零依赖实现，`lib/pdf.js`）**
  - 解析 xref → 对象表 → 字体对象 → **ToUnicode CMap** → 内容流文本算子。
  - 中文 PDF 用 Type0/Identity-H + CID 十六进制串（如 `<0797>`），
    必须经 CMap 才能还原汉字 —— 实测《道医祝由讲义》15 页中文完整抽出。
  - 诚实报告局限：加密 PDF、扫描件（无文本层）会明确说明而不是静默返回空。
- **ZIP 家族只拉中央目录**（`lib/zip.js`）：读文件尾部即得成员清单，
  500 MB 的包不必下载；EPUB/DOCX/XLSX 进一步按需拉单个成员解出正文。
  实测 DOCX 表格与 XLSX 共享字符串均正确抽取。
- 图片给出尺寸（PNG/JPEG/GIF/BMP/WebP）。

### 🟢 新增：`bdp index` + `bdp ask` — 本地全文索引

- **零外部依赖**：Node 24 内置 `node:sqlite`（SQLite 3.53.4，FTS5 可用）。
- **自研 CJK 二元分词**（`lib/index-store.js`）：
  FTS5 的 unicode61 不切分中文（"风水" 查不中"倪海厦讲的风水古籍"），
  trigram 又要求查询词 ≥3 字。折中方案是建索引时把中文切成二元组、
  用空格连接后交给 unicode61 —— 实测两字查询也能命中。
- 增量索引：md5 + size 未变则跳过，重复 build 只更新变化文件。
- 正文抽取复用 `bdp preview` 的能力（TXT 自动识别 GBK/UTF-8、PDF、DOCX/XLSX）。
- 索引存 `~/.bdp/index/default.db`，默认只索引文件名（轻量），
  `--extract` 模式才抽取正文。

### 🟠 已知限制（明确写出，不静默失败）

- 百度 md5 反混淆仅在"第 10 位为非十六进制字符"时生效；
  超出合法密钥范围的输入保守返回原值（不猜）。
- PDF 抽取不做完整 CID 字体 fallback，只用 ToUnicode；
  对象流（ObjStm）内的对象可能取不到，此时降级为全文件流扫描。
- 扫描件 PDF 无法提取文本，需 `bdp get` 下载后本地 OCR。
- `bdp index` 首次全量构建较慢（需逐文件抽取正文），
  建议先用 `--include` 限定目录。

### 🔧 评审后修复（自查 + 后续评审）

- **`sizeOnlyWastedBytes` 字段名拼错** — `bin/bdp.js` 里写成 `sizeOnlyWastedBytesBytes`，
  导致 JSON 输出该字段恒为 `undefined`（数字明细缺失）。
- **flag 默认值互相污染** — `parseArgs` 给 `--top`/`--depth`/`--concurrency`/`--limit`/`-n`
  硬编码了默认值（15/2/4/50/20），导致 `bdp dedup` 的 `--top` 实际永远是 15
  （文档写 20）、`bdp preview` 的 `--lines` 实际永远是 20（期望 40）。
  改为 `parseArgs` 只记录「用户是否显式给了」，默认值交由各命令自己决定。
- **zip bomb 无防护** — `inflateMember` 用 `zlib.inflateRawSync` 无解压上限，
  实测 1MB 压缩包可解压出 1GB（1.4 秒）。现在用 `maxOutputLength` 限制为 64MB，
  超限抛明确错误。
- **超大 PDF 直接 OOM** — `previewPdf` 把整个文件读进内存（用户网盘有 12GB 的 PDF），
  现限制为 64MB，超限提示改用 `bdp get` 本地处理。
- **索引库 schema 升级不兼容** — v1.8.0 早期版本把 FTS 从「外部内容表」改成
  「独立表 + body 列」（因为外部内容表下 `snippet()` 报 SQL logic error），
  但 `CREATE VIRTUAL TABLE IF NOT EXISTS` 不会改写已存在的表结构 ——
  旧库上 `snippet(fts, 1)` 会报 column index out of range。
  现在启动时检测 schema 并自动重建 FTS 表（files 表保留正文，可无损回填）。
- **增量索引漏更新** — `needsReindex` 在 md5 缺失（百度未返回）且 size 未变时
  永远返回 false，文件内容变了索引也不更新。现退化为比较 mtime。
- **`bdp dedup` 的 keep 策略增强** — `--keep` 现在也接受**显式路径**
  （`--keep /canonical/path`），该簇保留这份；路径不在簇内则回退 shortest。
- **md5 缺失透明化** — 新增 `noMd5` 计数，百度未返回 md5 的文件会被明确提示
  （这些文件只能按 size 粗筛，无法参与精算）。

### 🔧 MCP

- 新增 3 个工具（共 13 个）：`bdp_preview` / `bdp_dedup` / `bdp_ask`。

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
