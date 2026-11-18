# Changelog

本文件记录 baiduwangpan-cli 的显著变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

-----

## v1.12.0 — 2026-11-18

> 主题：**个人版分享转存命令（`bdp transfer`）+ 三份 PR 的严格审核修复**，以及 README / CHANGELOG 的精简归档。

### ✨ 功能

- **新增 `bdp transfer <url> [--pwd CODE] [--dry-run] [--yes]`**：异步封装 BaiduPCS-Go v4.0.1 的
  个人版分享链接转存。实际写入需确认，`--dry-run` 不调用引擎。失败正文或异常退出**不能伪装成成功**。
- 新增 `CONTRIBUTING.md`：README 顶部的 **PRs Welcome** 徽章此前指向缺失的文件（404）。
  内容涵盖改动前是否需要先开 Issue、本地环境与测试方式、CLI/MCP/Skill 文档同步要求、
  PR 的范围与提交信息、`baiduwangpan-skill.zip` 的重建流程，以及本项目的安全底线
  （不提交凭证、不谎报成功、引擎输出视为不可信输入）。

### 🔧 修复

- **转存成功判定锚定 stdout 末尾**：上游 v4.0.1 打印成功行后即结束，此前逐行匹配成功字样
  会把「成功行之后还有输出」也当成成功。失败行优先于成功行。判定抽成纯函数
  `classifyTransferOutput`，使这些断言在**所有平台**都执行。
- **提取码字符集是本 CLI 自加的限制**（`[A-Za-z0-9]{4}`）：上游 v4.0.1 只校验提取码**长度**
  是否为 4，并不校验字符集。文档不再把它说成引擎的要求。
- **披露 `--pwd` 全局解析变化的影响面**：`--pwd` 走顶层参数校验，这**影响所有使用 `--pwd` 的命令**
  （含既有的 `bdp share set`）—— 此前 `--pwd` 会静默吞掉下一个参数（如 `--json`），现在取值缺失 /
  为空 / 以 `-` 开头都直接报「选项取值非法」。属行为变化，既有脚本需留意。
- **修复 Linux 扫码登录无法发现只提供 `microsoft-edge-stable` 的 Edge 安装**；同时识别 beta/dev 通道。
  浏览器检测回归测试使用隔离的 PATH，不依赖本机浏览器或手动软链接。

### 🧪 测试

- 新增参数、确认、CLI JSON 和假引擎端到端测试；新增逐条断言**判定与上游状态行格式完全一致**的用例
  （对照 `baidupcs.go:86` 的 `OperationShareFileSavetoLocal` 与 `transfer.go:107` 的输出格式），
  上游若改文案，测试会立刻指出。
- 测试总数 444 → **466**。
  计数口径为**用例声明数**（与 `test/doc-contract.test.js` 的核对方式一致）；
  其中 5 项依赖可执行假引擎，**仅在 Linux/macOS 执行**，Windows 上被 skip。
- 变异测试确认新用例对旧实现**会变红**（非空测试）。

### 📚 文档

- **README 精简**：原先按版本堆了 8 段「🆕 vX.Y.Z 新增」（v1.7.0 ~ v1.9.1），内容与 CHANGELOG
  高度重复且**并非按时间顺序排列**，读者很难判断某项能力是哪版引入的。现合并为一段「📜 版本沿革」，
  只保留**至今仍影响使用方式**的十项（响应信封、结构化错误码、提示注入防线、凭证脱敏、
  失败不伪装成功、md5 反混淆等），并保留并发基准表。
- **CHANGELOG 归档**：v1.9.2 及更早的版本记录移到 `docs/CHANGELOG-archive.md`，主文件自 v1.10.0 起。
  内容**逐字保留**，仅拆分成两个文件，归档文件开头有回链。
- 契约 10 要求 README 与 CHANGELOG 的并发性能表逐格一致，两边的表都留在主文件里，未受影响。

### 📦 分发

- 重建 `baiduwangpan-skill.zip`（42,597 字节 / 8 个文件）。

## v1.11.3 — 2026-11-02

> 主题：**把剩下的同步 curl 和缺的命令补上**。群文件下载、curl 传输、预览 HEAD 不再冻住事件循环。MCP 补齐群工具。CLI 补上 `rename` 与 `doctor`。

### 🔧 修复

- **curl 传输与群文件下载改为异步 spawn**（`lib/http.js` 的 `spawnCollected`）。`webTransport=curl`、`gdownload`、预览 HEAD 兜底都不再 `spawnSync`。下载时限不变（单文件约 3600s、打包约 7200s），但只占这一次调用。
- **`bdp_search` 的 keyword、`bdp_ask` 的 query 必须是字符串**。数字不会再被悄悄当成搜索词。
- **`bdp_rename` 的非字符串 `from`/`to` 会真的改名**（`-32001`）：此前 `{to: 123}` 被
  `String()` 成 `"123"`、`{to: {}}` 成 `"[object Object]"`、`{from: 123}` 成 `"/123"`，
  `dryRun:false` 时**真的在网盘上改名** —— 与 v1.11.2 修的 `bdp_mkdir {path:123}` 同一类
  （非字符串被静默强转成真实写操作）。现在 `files[]` 逐项校验类型/长度；`renameFiles` 也加了
  兜底不再是 `String()` 照改。目标名的语义（含 `/`、`.`、`..`、控制字符）仍是**逐条**记失败
  —— 批量接口不该因为一条坏名字整批中止。
- **`bdp_organize` 的 `target` 未校验类型**：`{target: 123}` 会把数字当成目标根目录。现在必须是字符串路径。
- **`bdp config --set --json` 的 `file` 脱敏**，与 whoami 一样不再回显本地绝对路径。

### ✨ 功能

- **MCP 群工具**：`bdp_gshares` / `bdp_gls` / `bdp_gtree` / `bdp_gdownload`。下载必须传布尔 `confirm: true`。
- **`bdp rename <path> <newName>`**：与 `bdp_rename` 同一套规则，默认 dry-run，`--yes` 才改名。目标不能含 `/`、`\`，不能是 `.` 或 `..`。
- **`bdp doctor`**：一次报出登录态、配置是否可读、引擎能否启动、索引是否在 7 天内。索引过期只警告。输出不含本地路径。
- **`npm run bench:concurrency`**：不连真实网盘的 1/2/4/8 并发曲线，可进 CI。

### 🧪 测试

- `test/envelope-read.test.js`：cat/head/tail/grep 的 `--json` 用假引擎和本机 HTTP 验证信封，不再因没有网盘账号而跳过。
- `test/async-curl.test.js`、`test/rename-doctor.test.js`，以及 MCP 参数矩阵补上群工具和 search/ask。
- `test/rename-args.test.js`：`bdp_rename` / `bdp_organize.target` 的参数闸门（含「参数错误与
  dry-run 都**不得**触发真实 mv」这条，直接对着上面那个写操作缺陷）。
- `test/bench-concurrency.test.js`：基准脚本同时守**库式入口**（`runLevel` 的 4 路墙钟）与
  **CLI 入口**（曲线真的输出两档 / 闸门被抬到 16 / **只有一档必须 FAIL**）。
  后者是写测试时立刻抓到的脚本自身 bug：`--levels` 用 `parseInt("1,4")` 解析 → 恒等于 1，
  曲线只剩一档而判定条件写的是 `results.length > 1 && …` → **静默通过**。
- **契约 9 从「扫固定 4 个文件」改成「全目录扫 `lib/`+`bin/` + 白名单」**：此前新增的
  `lib/doctor.js`、`lib/rename.js` 根本不在扫描范围，「只要新开一个文件就能绕过全部保证」。
  白名单每条都写明理由（chcp / command -v / taskkill），且白名单文件里用 `spawnSync` 起**引擎**
  仍然算违规。已用探针文件实测：新文件里的 `spawnSync(cfg.pcsPath)` 现在会被抓出来。
- 测试总数 414 → **444**（`414` 是上一发布版 v1.11.2 的实际值；此前误写成中途提交的 420）。

### 🔒 输出净化（`raw` 字段 / 人读版 / 错误长度）

- **CLI `--json` 的 `raw` 字段未标记**：引擎原文是**远端可控**的内容（会回显远端文件名 / 错误文本），
  此前直接交给 Agent，等于让它把「数据」当「指令」。现在与 MCP 侧一致，包上
  `<untrusted_engine_output>…</untrusted_engine_output>`（深度遍历，只处理名为 `raw` 的字符串字段）。
- **人读版 `bdp ls` / `bdp get` 直出引擎原文**：远端文件名里的 ESC / OSC 能劫持终端
  （清屏、改标题、写剪贴板）。现在同样过 `sanitizeControl`（保留 `\t` / `\n` / `\r`）。
- **CLI 错误消息无长度上限**：实测引擎一大段输出能让 `--json` 的 `error` 达 50KB，
  一次失败就把 Agent 上下文挤爆；MCP 侧早就有 1000 字符上限，两侧文案因此不一致。
  新增共享的 `capErrorMessage()`（`lib/sanitize.js`，上限 1000），CLI 与 MCP 用**同一个常量**。

### 🛡️ 四路审核修复（v1.11.3 轮）

> 审核基线 `c0cb1c5`。下面每一条都有实测复现，且多数被**两路以上独立命中**。

- **`bdp rename` 可以重命名网盘根目录**：`from:"/"` 归一化后就是根，`--yes` 时把
  `mv / /root-new` 直接投给引擎。现在根路径与「归一化后变成根」的写法（`/a/..`）都拒绝。
- **`from` 含 `..` 会被静默改写成另一个文件**：`/a/../../etc/passwd` 归一成 `/etc/passwd`，
  用户以为改的是 A、实际改的是 B。现在含 `..` 段一律拒绝（请传规范化后的绝对路径）。
- **目标名含不可见格式符时「预览 ≠ 执行」**：U+202A-202E / U+2066-206F / U+FEFF 会被
  `sanitize` 从**回显**里剥掉，但文件真的带着它们落盘 —— Agent 按预览名寻址会指向另一个文件
  （扩展名伪装）。现在这类字符**拒绝**而不是剥离，`from` 里同样拒绝。
- **目标名纯空白 / 超长未挡**：`rename /a.txt "   " --yes` 会造出「看不见名字」的文件；
  超长名（>255）也不拦。现在两侧同口径（`renameFiles` 层挡，CLI 与 MCP 都覆盖）。
- **`bdp organize --target ../../x` 零校验**：`--apply` 会拿 target 直接 `mkdir` + `mv`，
  计划项 `to` 就是 `../../x/文档/x.pdf`。现在 MCP 与 CLI 共用同一套归一校验（拒绝 `..`、归一成绝对路径）。
- **`bdp doctor` 对「PATH 上的引擎」给假阴性**：`checkEngine` 用 `fs.existsSync` 判存在，
  而 `findPCS()` 的兜底正是一个**裸名** `BaiduPCS-Go` —— 引擎明明能跑却被报「引擎文件不存在」且退出码 1。
  现在裸名交 `spawn` 判定。
- **`bdp doctor` 对「配置的引擎已失效」给假阳性且不可见**：`resolvePcsPath` 会静默回退到自动发现，
  于是「我配的那个引擎坏了」（安全上是**静默引擎替换**）对调用方完全不可见。现在输出
  `engine.source`（`configured`/`path`/`auto-fallback`），回退时进 `warnings`。
- **群下载失败只说「下载失败」**：超时（可重试）/ 输出超限（改参数）/ 0 字节（换链接）的处理动作不同，
  此前一律同一句话。现在消息带原因，口径与 `http.assertCurlOk` 一致。
- **群下载落盘名未挡 Windows 保留设备名与 ADS 流**：`CON` 会让 `curl -o` 写到控制台、
  `x.txt:hidden` 是 NTFS 数据流。现在回落到兜底名。
- **群文件列表页 `page` 未钳制**（`page=-3`/`1e9` 原样拼进 URL），现在与 `pageSize` 同口径。
- **`spawnCollected` 静默吞掉非法数值**：`timeoutMs:"abc"` → `NaN` → `setTimeout(NaN)` 变成 **1ms**
  （每次调用都立刻超时，还往 stderr 吐 NaN 警告）；`0` 被 `||` 吞成默认值。现在显式 `Number.isFinite` 归一。
- **人读通道泄漏本地绝对路径**：`bdp gdownload` / `bdp get <gid>:<fsid>` 的人读输出、
  `bdp cache info` 的 `cacheDir`、`gdownload --verbose` 的 cwd 此前都直出（`--json` 已脱敏，人读没跟上）。
  现在统一过 `redactLocalPaths`。
- **`bdp rename` 人读输出直出远端文件名**（含 ESC 会打到终端），现在过 `sanitizeControl`。
- **`bdp_rename` 的工具描述与实现矛盾**：schema 写「`to`：新文件名**或完整新路径**」，
  实现却拒绝含 `/` 的目标 —— 这是 Agent 唯一能读到的权威说明，照着传必然失败，
  还暗示「可以借改名移动文件」。已改为「仅新文件名」并指向 `bdp_move`；同时删掉不存在的
  「`->` / `=>` 规则串」描述。

### 📚 文档

- `commands.md` 补 `### rename` 与 `### doctor` 两节（含退出码语义：`doctor` 的 `ok=false` 退 1 不代表崩了）。
- README 的完整命令参考补 `bdp rename` / `bdp doctor` 两行（此前主入口完全看不到这两个新命令）。
- SKILL.md「MCP 工具从 14 → 23」改为 **19 → 23**（基线错：v1.11.2 实测就是 19）。
- v1.11.2 段落的测试数与 zip 体积还原成**该 tag 的真实值**（414 / 38,346）——
  此前被改写成后面提交的水位（420 / 40,748），使已发布的发布说明与自己的 tag 不自洽。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（40,873 字节 / 8 个文件）。
- **已发布到 npm：`baiduwangpan-cli@1.11.3`**（2026-11-03）。
  `npm view baiduwangpan-cli version --prefer-online` → `1.11.3`；并已从 registry 装到干净目录实跑验证。
- v1.11.0 / v1.11.1 / v1.11.2 是**未发布**的开发 tag，首次对外发布即本版。

---

## v1.11.2 — 2026-11-02

> 主题：**MCP 参数校验统一到 -32001** —— 四路审核的 P2-4 发现。
> 其中一条是**会真的写数据**的：`bdp_mkdir {path: 123}` 会在网盘根目录建出一个名为 `123` 的目录。

### 🔧 修复

- **参数错误被误报成服务端错误（-32000 → -32001）**：此前 `bdp_remove` 缺 `confirm`、
  `bdp_organize` 缺归类维度、`bdp_gsearch` 缺 gid/keyword 都抛普通 `Error` →
  MCP 侧映射成 `-32000 / severity=unknown / retryable=false`，Agent 会以为「百度侧出问题了」，
  甚至去提 Issue。现在统一打 `toolArgumentError` → **`-32001 / user-error / 不重试`**。
- **`bdp_mkdir {path: 123}` 会真的建出名为 `123` 的目录**：数字被 `String()` 之后直接拼进引擎参数。
  现在路径参数做**类型校验**（必须是字符串）+ 长度上限（4096）+ 控制字符拒绝 —— 引擎根本不会被调用。
- **`bdp_gsearch` 缺参时先打网络请求**：报的是「无法获取 bdstoken: Web 会话未认证」。
  现在先校验 `gid`/`keyword`，参数错就直接 `-32001`，不发任何请求。
- **`bdp_remove` 的 `confirm` 必须是布尔 `true`**：字符串 `"true"` 也拒绝
  （布尔与字符串混用会让这道确认闸门形同虚设）。
- **`bdp_read {lines:"abc"}` 静默回落 20**：现在 `lines` 必须是整数且在 `1–10000`，
  否则 `-32001`（此前调用方以为参数生效了）。
- **超长路径报「引擎找不到」**：`path` 40000 字符会真的 spawn 并返回 `ENAMETOOLONG`，
  被映射成「未找到 BaiduPCS-Go 可执行文件」。现在长度上限 4096，直接 `-32001`。
- 校验覆盖面：`bdp_ls` / `bdp_read` / `bdp_preview` / `bdp_peek` / `bdp_get` / `bdp_put` /
  `bdp_move` / `bdp_copy` / `bdp_remove` / `bdp_mkdir` / `bdp_organize` / `bdp_gsearch`。
  `bdp_put` 的 `local` 是**本地**路径，只做字符串/长度校验，不套网盘路径规则。

### 🧪 测试

- 新增 `test/mcp-args.test.js`（4 条 / 15 个非法参数用例）：
  参数错误矩阵、`bdp_mkdir {path:123}` **不得触发引擎**、端到端 `error.code === -32001`、
  合法参数（含空格路径）不被误伤。
- 测试总数 410 → **414**。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（38,346 字节 / 8 个文件）。
- **npm 上仍为 1.10.2**：`v1.11.0` / `v1.11.1` 是未发布的开发 tag，首次发布将是本版。

---

## v1.11.1 — 2026-11-02

> 主题：**四路审核的修正版** —— v1.11.0 的两条对外声明被审核**实测证伪**，本版修正实现与措辞。
> v1.11.0 的 tag 保留为历史记录；npm 上尚未发过 v1.11.0，本版是首个发布版本。

### 🔧 修复

**P1 —— 两条声明被实测证伪**

- **「全库没有任何同步引擎调用点」不成立**：`bin/bdp.js` 的引擎登录此前是 `spawnSync`（30s 上限），
  一次调用把整个 Node 进程冻住。现在改走 `lib/pan.js` 的异步 runner。
  **契约测试的扫描范围也补上了 `bin/`** —— 此前只扫 lib/ 三个文件，正是它没抓到这里的原因
  （审核用「在 bin/bdp.js 注入一个 spawnSync(cfg.pcsPath, …)」做突变测试验证过这个盲区）。
- **「唯一还走同步子进程的是 curl 传输模式」不成立**：`lib/pan.js` 的 Range 读取**无条件**走
  `http.curlRange`（内部 spawnSync），**没有传输门控** —— 于是**默认的 native 传输**下，
  `cat`/`head`/`tail`/`grep` 每次都同步 fork curl，事件循环照样被冻住
  （审核运行时实测：默认配置下 cat/head/grep 仍产生 `spawnSync("curl")`）。
  现在按传输模式分流（与 `lib/preview.js` 的 readRange 同一套写法）：
  native → `http.fetchRange`（异步 fetch），curl → `http.curlRange`。

**P2**

- **截断诊断在写操作上丢失**：`mkdir`/`rm`/`mv`/`cp`/`quota`/`share`/`offline`/`recycle`
  直接调 `runPCSResultAsync` 却**不看截断标志**，25MB 的引擎输出会被当成「无输出」，
  报出「无法解析输出」这种误导性结论。现在截断在**唯一出口**就抛错 —— 两条路径的诊断一致。
- **`bdp share cancel` 中途失败会中断后续并丢掉已完成结果**：现在与 `bdp rm` 口径一致
  —— 逐条汇总、单条失败不影响其余，部分失败退出码 1。
- **`bdp organize --apply` / `bdp dedup --remove-duplicates` 部分失败时退出码仍是 0**：
  Agent 只看退出码会把「部分没删掉」当成「全部成功」。现在部分失败退出码 1。
- **MCP 成功响应里的逐条 error 未脱敏**：`bdp_rename` 的 `results[].error` 里的本地绝对路径
  会原样进 Agent 上下文，现在走同一套 `sanitizeErrorMessage()`。
- **`bdp config --json` 泄漏本地绝对路径**：`pcsPath`/`browserProfile` 现在与 `bdp whoami --json`
  口径一致，脱敏后再输出。
- 并发闸门归一化：`BDP_MCP_MAX_CONCURRENCY=0` 现在是 **1**（此前被 `|| 4` 吃掉，实际得到 4）。
- 超时消息：小于 1s 时显示毫秒（此前显示「超时（0s）」这种自相矛盾的文案）。

### 🧪 测试

- 新增 `test/native-transport.test.js`（2 条）：native 传输下 `cat`/`head`/`tail`/`grep`
  **不得**产生任何 `spawnSync` 调用（这条直接守住上面那个 P1）。
- `test/async-engine.test.js` +1 条：写操作超限也要报「20MB」（截断诊断不能丢）。
- 契约测试的「同步引擎调用点 = 0」断言**扩展到 `bin/`**。
- 测试总数 407 → **410**。

### 📚 文档

- README / SKILL.md / commands.md 的同步路径说明改为**准确清单**：
  明确区分「引擎调用点（已清零）」与「仍存在的同步子进程（curl 传输模式 / 群文件下载 / 预览 HEAD 兜底）」。
- CHANGELOG v1.11.0 段的两条不实声明，由本段明确纠正（历史段保留原文，不改写历史）。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（38,343 字节 / 8 个文件）。

---

## v1.11.0 — 2026-11-02

> 主题：**全异步化** —— 消灭「同步引擎路径」这个类别。
> 此前 15 条命令走同步 `spawnSync` 调 BaiduPCS-Go：一次调用就把整个 Node 进程冻住，
> 引擎挂死 = MCP 服务器整体不可用、且没有自愈。现在**一条同步引擎路径都不剩**。

### ⚡ 性能与稳定性

- **写操作不再冻结事件循环**：`mkdir` / `rm` / `put` / `mv` / `cp` / `quota` / `offline` /
  `share` / `recycle` / `cat` / `head` / `tail` / `grep` / `peek` / `get` 全部改为**异步 spawn**。
  此前它们走 `spawnSync` —— 一次调用就把整个 Node 进程卡住，MCP 单进程下**所有**并发请求排队，
  且引擎挂死时**整个服务器**永久不可用。
- **同步包装器整体删除**：`lib/pan.js` 的 `runPCSResult`（spawnSync）与 `runPCS`（同步包装）
  已删除，`lib/pcs-extra.js` 自带的 `spawnSync` 版引擎调用也删除 ——
  现在**全库没有任何同步引擎调用点**（契约测试会持续守住这条线）。
- **统一到一条引擎通道**：`lib/pcs-extra.js` 与 `lib/preview.js` 的引擎调用改为复用
  `lib/pan.js` 的异步 runner（超时 / 输出上限 / 截断通道判定都在那一处）。

### 🧪 测试

- 新增 `test/async-engine.test.js` 的 2 条：写操作并发期间**定时器仍能触发**（不再冻结事件循环）、
  写操作的结果与失败语义不变（mkdir 幂等 / rm 逐条汇总）。
- 契约测试的「同步遗留清单」断言改为**结构性不变量**：
  源码里同步引擎调用点必须为 **0**，且三处文档必须声明「已清零」、不得再列出任何命令。
- 既有测试改为 `await` / `assert.rejects`；引擎 mock 从 `spawnSync` 形态改为**真进程形态**
  （EventEmitter + stdout/stderr 流 + close/error 事件）。
- 测试总数 406 → **407**。

### 📚 文档

- README / SKILL.md / commands.md 的「已知遗留（同步引擎路径）」清单**归零**：
  此前写着「15 条仍是同步的」，现在改为「已清零」并说明为什么。
- **仍然存在**的一处同步子进程：`webTransport=curl` 的**传输模式**（HTTP 层，不是引擎调用）。
  默认的 `native` 传输用 fetch，无此问题；curl 模式会让 `--concurrency` 失效（v1.8.1 起已记录）。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（38,080 字节 / 8 个文件）。

---

## v1.10.2 — 2026-11-02

> 主题：**边界穷举审核的补丁** —— v1.10.1 发布到 npm 之后，第四路审核（边界穷举）又查出 3 项缺陷。
> 本版修掉这 3 项。

### 🔧 修复

- **引擎时限超过 2³¹ 会被 Node 静默截断成 1ms**：
  `BDP_ENGINE_TIMEOUT_MS=2147483648` 时 Node 只打一条 `TimeoutOverflowWarning` 就把时长截成 1ms ——
  用户「把超时调大」反而让**每一次**引擎调用都在 4ms 内失败，而错误消息宣称「超时 2147484 秒」，
  与实际行为完全矛盾。现在时限归一化：超过 2³¹−1 截到上界；非法/非正取值
  （`0` / `-1` / `abc` / 空）回落到默认值（此前 `-1` 会变成 1ms 的病态超时）。
- **同步版的 ENOBUFS 不含通道信息 —— stderr 超限被误报成 stdout**：
  Node 的 `spawnSync` 对 stdout / stderr 超限**一律**返回 `error.code=ENOBUFS`，
  所以同步版此前**永远**说 stdout（异步版能分别报），同一份引擎行为在两条路径上结论不同。
  现在按「已收回多少字节」反推通道，两条路径一致。
- **`bdp --profile x`（只给 profile 不给命令）静默建号**：
  `--profile` 被前置换到 `profileName`（**不进** `preCommandFlags`），所以「缺少命令」守卫漏掉了它 ——
  结果是**建出并激活**一个垃圾 profile（名字还可能是打错的），打印帮助后**退出 0**，
  Agent 会把它当成成功。现在「缺少命令」的检查**前移到切换 profile 之前**，与其它全局开关口径一致。

### 🧪 测试

- 新增 `test/engine-timeout-guards.test.js`（4 条）：时限归一化（溢出 / 非法值）、
  同步版 ENOBUFS 通道判定、`bdp --profile x` 不建号。
- 测试总数 402 → **406**。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（38,273 字节 / 8 个文件）。
- 已发布到 npm（`npm latest` = 1.10.2）。

---

## v1.10.1 — 2026-11-02

> 主题：**止血与对齐** —— 修掉 v1.10.0 异步化引入的 2 个 P0 回归，
> 一次清干净 9 项文档漂移，并给「文档漂移」装上**自动守门**。

### 🔧 修复

- **引擎输出超限 → 明确错误，不再返回「空成功」**（P0-1，v1.10.0 引入的回归）：
  引擎 stdout 超过 20MB 时，此前输出被丢弃而 `truncated` 标志**无人读取** ——
  MCP 返回 `{"path":"/","total":0,"entries":[]}` 且 `isError:false`，
  Agent 会据此得出「目录是空的」这个**确定性错误结论**。
  现在超限抛明确错误（`error.message` 含「20MB」，`error.code` = `-32000`），
  **不再出现 `total:0` 的静默成功**。同步版的 `ENOBUFS` 也从「误报成引擎不存在」
  改成「输出超限」。
- **引擎挂死 → timeout 内明确失败**（P0-2，v1.10.0 引入的回归）：
  异步 spawn 此前**没有 timeout** → 引擎挂死 → Promise 永不 settle →
  MCP 闸门槽位**永不释放** → **4 个挂死即整个 MCP 服务器永久不可用**。
  现在引擎调用带超时（读操作 120s、写操作 600s，可用 `BDP_ENGINE_TIMEOUT_MS` /
  `BDP_ENGINE_TIMEOUT_SLOW_MS` 覆盖），超时 kill 子进程并抛明确错误
  （`severity: retryable` —— 引擎挂死是环境问题，Agent 退避重试是有意义的）。
- **stderr 与 stdout 同为 20MB 上限**（P1-4）：
  `child.stderr` 此前**完全无上限**（实测 60MB stderr 全保留，RSS +121MB）。
  现在两者同上限，超限一律转成明确错误。
- **stdio 传输补上并发闸门**（P1-3）：
  闸门此前**只覆盖 HTTP 路径** —— 实测 12 个并发 `bdp_ls` 起到 **12 个同时存活的引擎进程**
  （stdio 是 MCP 默认传输，也是 Agent 最常用的接法）。
  现在 stdio 与 HTTP 走**同一段闸门逻辑**，并发上限统一由 `BDP_MCP_MAX_CONCURRENCY` 控制
  （默认 4）。口径说明：限的是**工具调用总数**，不是引擎进程数。
- **路径脱敏抽公共函数，CLI 与 MCP 共用**（P1-5）：
  MCP 侧的正则以**空白**为终止符 → 含空格的路径（`C:\Program Files\...`）
  只遮蔽第一段，残留目录结构与文件名；CLI 侧顶层 catch **完全不做脱敏**。
  现在统一走 `lib/sanitize.js` 的 `redactLocalPaths()`，两侧对同一输入产出一致结果。
- **后置 `--profile` 取值校验**（P2-6）：
  `bdp error -3 --profile --json` 此前会把 `--json` 建成一个垃圾 profile 并**激活**它
  （正是 v1.9.2 声称修复的同一个 bug —— 只修了前置位）。
  现在前置/后置**共用**同一个校验函数，缺值也报错退出 1。
- **`--json-file` 取值校验**（P2-7）：
  `bdp --json-file --json error -3` 此前会把 `--json` 当成输出文件名，
  在当前目录**真的建出**一个名为 `--json` 的文件。现在同样报错退出 1。

### 📚 文档

- `bdp error` 字段清单**四处逐字段一致**（`bdp help error` / SKILL.md / commands.md / README）：
  此前 README / SKILL.md / commands.md / `bdp help error` 各漏了 `codeText` 或 `description`。
- `meta.version` 示例统一到 1.10.1（`commands.md` / `examples.md` 两处此前仍是 1.9.0）。
- 布尔取值集合补全（`yes`/`no`/`on`/`off`/`""`），并写明**大小写不敏感、忽略首尾空白**。
- 补三段此前**任何用户可见文档都没写**的语义：
  ①「只给开关不给命令 → 退出码 1」（裸跑 `bdp` 仍打印帮助并退出 0）；
  ②全局选项的前置能力（含此前漏掉的 `--profile` / `--json-file`）；
  ③`bdp error` 的 code 取值规则（只接受 纯数字 / `errno=NNN` / `errno = -3`）。
- **同步遗留清单补全**（README / SKILL.md / commands.md 三处一致）：
  `cat`/`head`/`tail`/`grep`/`peek`/`get`/`put`/`mkdir`/`rm`/`mv`/`cp`/`quota`/`offline`/`share`/`recycle`
  共 **15** 条（+ `preview` 的回退说明）—— 原清单只写了 10 条，漏了 5 条读命令。
- v1.10.0 性能摘要补齐 1/2/4 并发档、52 次定时器与**测量环境口径**；
  `commands.md` 补上此前缺失的 `gdownload` / `cache` 两节。

### 🧪 测试

- 新增 `test/doc-contract.test.js`（12 条）—— **文档契约测试**（F22）：
  自动断言「字段清单四处一致 / 运行时键集 == 文档字段表 / 数量口径 / 版本号 / zip 逐字节一致」，
  以及本轮新写的**语义**（D5 布尔取值集合 / D6 退出码 / D8 code 取值规则 / D9 遗留清单 / D10 性能表互校）。
  **判据**：把 `commands.md` 里的 `codeText` 删掉 → 测试**必须失败**（已实测）。
- 新增 `test/mcp-concurrency.test.js`（2 条）+ `test/mcp-concurrency-env.test.js`（1 条）：
  stdio 并发闸门（≤4）与 `BDP_MCP_MAX_CONCURRENCY` 生效。
- 新增 `test/redact-paths.test.js`（11 条）：路径脱敏（CLI / MCP 两侧一致 + 全部路径形态）。
- 新增 `test/cli-flag-guards.test.js`（6 条）：`--profile` / `--json-file` 的取值守卫与等号形式。
- 扩展 `test/async-engine.test.js`（7 → 14 条）：输出超限、stderr 上限、超时 + kill，
  以及 MCP 层的 `isError` / `error.code === -32000` / `severity: retryable` 验收。
- 测试总数 363 → **402**。

### 🔍 四路审核（2026-11-02）→ 已全部修复

v1.10.1 发布前按任务书 §5 派了四路审核（正确性/回归、信息泄漏与安全、文档对拍、边界穷举）。
**三路 FAIL**（边界穷举在修复开始时仍在跑），共查出 **15 项**问题 —— 全部已修，并补了回归测试：

| 级别 | 问题 | 修法 |
|:--|:--|:--|
| **P1** | `lib/pcs-extra.js` 与 `lib/preview.js` 的**同步**引擎调用**完全没有 timeout** —— 引擎挂死时 `spawnSync` 冻结**整个** Node 进程（不只是占一个闸门槽位），MCP 服务器整体不可用 | 新增 `lib/engine-timeout.js` 作**单一事实来源**（读 120s / 写 600s），三处引擎调用点全部带上 `timeout` + `killSignal`；写档按**引擎真实子命令**分档（`offlinedl` 而非死条目 `offline`，并补 `d`） |
| **P1** | 「已知遗留（同步引擎路径）」清单**仍漏 6 条命令** —— 任务书与上轮审核都写错了（把 16 个「调用点」当成了 10 个「命令」）。`cat`/`head`/`tail`/`grep`/`peek` 也走同步引擎（`locate`/`meta`），`preview` 回退时也是 | 清单改为 **15** 条 + `preview` 回退说明，README / SKILL.md / commands.md 三处一致；契约测试新增「清单 == 实现」断言（命令→引擎子命令映射 + 调用点总数） |
| **P1** | 路径脱敏可被多种常规写法绕过：正斜杠 Windows 路径、UNC、无扩展名路径（**用户名反而泄漏**）、长/非字母数字扩展名、POSIX 含空格路径 | `redactLocalPaths` 重写：覆盖上述全部形态；路径末尾按「末段扩展名 / 末段首个空格」回退 —— **不误吞正文**、**幂等** |
| **P2** | CLI 错误通道只脱敏路径，**没做**控制字符剔除与伪标记中和 —— 与 MCP 口径不一致 | 新增共享的 `sanitizeErrorMessage()`（控制字符 + 标记中和 + 路径脱敏），CLI 与 MCP 走**同一个实现** |
| **P2** | CLI 的内层 catch（login / config --set / offline / profile 切换）绕过脱敏；`whoami` 的 `pcsPath` / `configFile` 直接回显绝对路径 | 内层 catch 与这两个字段全部走脱敏 |
| **P2** | `--profile -x`（单个连字符）仍会**建出并激活**垃圾 profile；`--profile " "`（纯空白）静默忽略 | 取值一律以 `-` 开头即拒绝；纯空白按空值拒绝 |
| **P2** | 后置位 `--profile=x` 等号形式不被支持（前置位支持 → 前后不对称） | parseArgs 支持 `--flag=value` 形式（`--profile` / `--json-file`） |
| **P2** | 前置位取值错误不走 JSON 通道（同一意图因参数顺序得到不同通道） | 两条路径统一按 `argv` 判定 `--json` |
| **P2** | README / SKILL.md 没写 MCP 并发闸门（上限、env、口径） | 补：stdio 与 HTTP 上限都是 4、`BDP_MCP_MAX_CONCURRENCY` 可调、口径是**工具调用总数** |
| **P2** | 契约测试对**本轮新写的语义零断言**（只守字段/数量/版本/zip 四类） | 契约测试 7 → 12 条，补 D5 布尔集合 / D6 退出码 / D8 code 规则 / D9 遗留清单 / D10 性能表互校 |
| **P3** | 无 id 的 `tools/call` 通知仍会收到响应（违反 JSON-RPC） | 通知不再回包 |
| **P3** | 超时提示始终指向 `BDP_ENGINE_TIMEOUT_MS`（写档实际用另一个变量） | 两个变量都写进提示 |
| **P3** | 契约测试的 zip 体积断言写在 `if(zm)` 里 —— 措辞一改就静默失效 | 改成无条件断言 |

> **契约测试的有效性判据已复测**：删掉 commands.md 里的 `codeText` 行 → **3 条断言同时失败**。
> 该测试还抓出一处**两轮审核都漏掉**的漂移：`commands.md` 里第二份 `meta.version` 示例。

### 📦 分发

- 重新构建 `baiduwangpan-skill.zip`（随 `skills/` 变更同步，38,272 字节 / 8 个文件）。

> **本版本已发布到 npm**（`npm latest` = 1.10.1；随后又查出 3 项边界缺陷，见 **v1.10.2**）。

## v1.10.0 — 2026-11-02

> 主题：**MCP 并发恢复** —— 把「Agent 调用效率」的真问题解决掉：引擎调用不再冻结事件循环。

### 🔧 修复

- **引擎调用冻结事件循环，MCP 并发等于串行**：
  实测引擎一次 `ls /` 耗时 594ms，期间 `setInterval(5ms)` **一次都触发不了** ——
  `spawnSync` 把整个 Node 进程卡死。而 MCP 服务器是**单进程**跑所有工具调用的，
  于是任何一次走引擎路径的调用都会让**所有并发请求排队**：
  实测 8 个并发 `bdp_ls` 耗时 4047ms，串行 8 次是 3488ms —— 并发比串行还慢，加速比 **1.0×**。
  现在 `ls` / `search` 走**异步 spawn**（`runPCSAsync`）：引擎进程各自独立并行跑，
  stdout/stderr **逐字节不变**，因此 `bdp ls` 的人类可读输出（直接打印引擎原文）
  与 `--json` 的字段结构完全不变。

  实测（同一台机器、同一网盘账号）：

  | 并发数 | 改前 | 改后 |
  |:---|:---|:---|
  | 1 | 436ms | ~470ms |
  | 2 | 869ms | 460ms |
  | 4 | 1733ms | 441ms |
  | 8 | **4047ms** | **554ms（7.3×）** |

  事件循环也不再被冻结：8 并发期间定时器触发 52 次（改前**单次**调用就是 0 次）。

### 📚 文档

- 纯内部改动 —— CLI 与 MCP 的输出契约、字段结构、人类可读输出均未变。

### 🧪 测试

- 新增 `test/async-engine.test.js`（7 条）：异步契约、并发重叠（4 并发耗时应接近 1 次而非 4 次）、
  并发期间事件循环仍能转动、解析结果与同步版逐字段一致、引擎错误文本仍按 errno 判定。
  测试总数 356 → **363**。

> **已知遗留**：`quota` / `get` / `put` / `mkdir` / `rm` / `mv` / `cp` / `offline` / `share` / `recycle`
> 的引擎路径仍是同步的（`lib/pcs-extra.js` 与 `lib/pan.js` 里其余的 `runPCS` 调用点）。
> 它们要么低频、要么是写操作（本就不该并发），故本版未动。

> **本版本尚未发布到 npm**（npm latest 仍为 1.8.5）。
> 需要 1.9.x/1.10.x 的功能请从 GitHub tag 安装：
> `npm install -g NkAntony777/baiduwangpan-cli#v1.10.0` 或等 npm 发布后再升级。

---

> **v1.9.2 及更早版本**的完整变更记录已移至 [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md)，
> 以免主文件过长而难以检索。本文件自 v1.10.0 起。
