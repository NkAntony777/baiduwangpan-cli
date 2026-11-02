# bdp 完整命令参考

`bdp` 是 `baiduwangpan-cli` 的全局命令。所有命令支持 `--json` 结构化输出。

> **权威用法来源**：本文档是**高级用法与坑位速查**；每个命令的完整 usage/options/examples（结构化 JSON）以运行时为准：
> ```bash
> bdp help <命令> --json
> ```
> 不确定参数时先查 `bdp help <命令> --json`，不要凭记忆猜测。

## 网盘文件操作

### help — 帮助（Agent 运行时发现用法）

```
bdp help [command] [--json]
```

- `bdp help` — 总览（分组列出全部命令）
- `bdp help <command>` — 单个命令的完整定义（usage/options/examples/note）
- `bdp help --json` — 结构化输出全部命令注册项，Agent 零解析成本发现能力

```bash
bdp help
bdp help get
bdp help --json
bdp help gsearch --json
```

### ls — 列出目录

```
bdp ls [path]
```

- `path` 默认 `/`（网盘根目录）
- 支持任意路径，全盘可访问
- `--json` 返回**结构化** `entries[]`（index/name/path/isDir/size/sizeText/mtime/mtimeText），
  并含 `fileCount` / `dirCount` / `totalText` 汇总
- 目录不存在时返回 `{"error":"...","errno":31066}` 且**退出码为 1**

```bash
bdp ls /
bdp ls /中医
bdp ls /文档 --json
```

### search — 搜索文件名

```
bdp search <keyword> [-p <dir>] [--regex 正则] [--glob 通配符] [--any-word] [--exact]
```

- 递归搜索文件名（不支持搜索目录名）
- `-p` 指定搜索目录，默认 `/` 全盘
- 模式过滤（客户端二次过滤，引擎搜字面片段再精确匹配）：
  - `--glob "玄空*.pdf"` — shell 通配符（同时匹配完整路径与文件名）
  - `--regex "玄空.+pdf$"` — 正则
  - `--any-word "pdf csv"` — 空格分词，命中任意一个
  - `--exact "报告.pdf"` — 整名精确相等

**分页与限流**（v1.7.0 起，全盘搜索命中数可能上千，默认只返回 50 条）：

| 选项 | 说明 |
|------|------|
| `--limit N` | 单页条数（默认 50） |
| `--page N` | 页码（默认 1） |
| `--max-results N` | 硬上限，截断总结果数 |
| `--fields a,b,c` | 只返回指定字段（path/name/size/sizeText/mtime/mtimeText/isDir/index） |

`--json` 输出含 `total`（总命中）/ `returned`（本页条数）/ `hasMore` / `nextPage`。
看到 `hasMore: true` 用 `--page <nextPage>` 继续翻。

```bash
bdp search "报告"
bdp search "数据集" -p /学校
bdp search "中医" --json
bdp search "玄空*.pdf" --glob
bdp search "玄空.+pdf$" --regex
bdp search "中医" --limit 20 --fields path,size --json   # 压缩输出体积
bdp search "中医" --limit 20 --page 2 --json              # 翻页
```

### cat — 读取文件内容（免下载）

```
bdp cat <path>
```

- 通过 CDN 直链 + HTTP Range 只读取前 1MB，不下载整个文件
- 大文件会被截断，用 `head`/`tail` 分段读取
- 自动识别 UTF-8 / GBK 编码

```bash
bdp cat /文档/配置.json
bdp cat /文档/data.csv -N    # 带行号
```

### head — 读取前 N 行

```
bdp head [-n <N>] <path>
```

```bash
bdp head /文档/log.txt
bdp head -n 50 /文档/log.txt
bdp head -n 10 /文档/data.csv --json
```

### tail — 读取后 N 行

```
bdp tail [-n <N>] <path>
```

先获取文件大小，再 Range 读取末尾部分。

```bash
bdp tail /文档/log.txt
bdp tail -n 30 /文档/log.txt
```

### grep — 在文件内容中搜索

```
bdp grep <pattern> <path> [-i] [-N]
```

- `-i` 忽略大小写
- `-N`（或 `-n`，两者等价）显示行号
- **编码自动识别**（v1.7.0）：UTF-8 / GBK / Big5 都能正确匹配。
  中文古籍（GB2312/GBK）此前会**静默返回空**，现已修复

```bash
bdp grep "ERROR" /文档/log.txt
bdp grep "错误" /文档/日志.txt -N
bdp grep "keyword" /文档/data.txt -i --json
```

> ⚠️ Windows 控制台管道中中文可能显示乱码，但 stdout 原始字节是合法 UTF-8 JSON（用 `--json` + 程序化解析不受影响）。

### peek — 预览文件信息

```
bdp peek <path>
```

- 显示大小、类型、dlink 可用性
- 含 md5 / server_ctime / local_ctime（web API 可用时）
- 文本文件自动预览前 10 行
- `type` 字段给出文件类型（text/pdf/zip/docx/image/audio/video…），
  `binary` 标记是否二进制，`encoding` 报告实际使用的字符编码（utf-8/gbk/big5）
- 二进制文件（PDF/zip/图片/音视频）不再把源码当文本吐出

```bash
bdp peek /文档/report.pdf
bdp peek /文档/data.json --json
```

### preview — 多类型内容预览

```
bdp preview <path> [--lines N] [--max-bytes N] [--max-pages N]
```

按文件类型走不同的「最省字节」路径，尽量不下载整个文件：

| 类型 | 行为 |
|:-----|:-----|
| TXT/MD/CSV/JSON | Range 读前 N KB，自动识别 GBK/UTF-8 |
| **PDF** | 解析 xref + 字体 ToUnicode CMap，抽中文文本层（中文 CID 字体可还原） |
| ZIP | **只读文件尾部中央目录**列出成员，500MB 的包也不必下载 |
| DOCX | 抽 `word/document.xml` 正文 |
| XLSX | 抽 `xl/sharedStrings.xml` 单元格文本 |
| EPUB | 解析 OPF 元数据 |
| 图片 | 给尺寸（PNG/JPEG/GIF/BMP/WebP） |

- `--json` 返回结构化结果（`type` / `text` / `entries[]` / `metadata` / `width`）
- **扫描件 PDF 无文本层**，会返回 `note` 明确说明（不是静默返回空）；
  此时用 `bdp get` 下载后本地 OCR
- 加密 PDF 同样会明确说明

```bash
bdp preview /中医/2025版药典/内容对比/0101 片剂 对比表.pdf.pdf
bdp preview /资料.zip --json
```

### dedup — 重复文件扫描

```
bdp dedup [path] [--top N] [--depth N] [--keep shortest|oldest|newest]
bdp dedup <path> --remove-duplicates --yes
```

**关键前提**：百度 `/api/list` 返回的 md5 是**混淆值** ——
同一份内容放在两个不同路径，返回的 md5 竟然不同。不解密就做去重会**漏报**。
本命令自动反混淆（算法移植自 BaiduPCS-Go 源码 `baidupcs/util.go → DecryptMD5`）。

两阶段策略：

1. **粗筛**：递归遍历，按 size 分组（零额外请求）
2. **精算**：仅对同 size 候选，按反混淆后的真实 md5 细分

- `--json` 返回 `clusters[]`（每组含 `size`/`md5`/`wasted`/`keep`/`removable`）
  以及 `wastedBytes`（md5 精算）与 `sizeOnlyWastedBytes`（仅按大小）两个数字
  —— 两者之差即被 size 误判、实为不同内容的文件
- `--remove-duplicates` 删除重复副本，**走百度回收站（可恢复）**
- 非交互环境必须显式 `--yes`（与 `bdp rm` 一致）；先 `--dry-run` 预览更稳妥

```bash
bdp dedup /med --top 50
bdp dedup /med --remove-duplicates --dry-run
```


**`--keep` 策略的坑**（重要）：

| 取值 | 行为 | 风险 |
|:-----|:-----|:-----|
| `shortest`（默认） | 保留路径字符串最短的 | **可能删错** —— 短路径常是自动汇总的副本，用户手动归档的原件往往在深目录 |
| `oldest` / `newest` | 保留修改时间最早/最新的 | 文件时间被改过时可能不符合预期 |
| 完整路径（如 `--keep /重要/资料.pdf`） | 保留该簇里指定的那份 | 路径不在簇内时回退到 `shortest` |

> 知道要保留哪份时**务必显式给路径**，不要依赖默认策略。
> 删除前先 `--dry-run` 看完整清单。

**扫描完整性**：命令会如实报告扫描是否完整 ——
`partial=true` 表示扫描不完整（目录分页达上限 / 有畸形条目），
此时结果可能漏报重复文件。`noMd5` 表示有多少文件百度没返回 md5（无法参与精算）。

### 性能：并发模式

```
# 默认 curl 传输（每次请求 fork 一个 curl 进程，串行）
bdp dedup /med --concurrency 8

# native 传输（Node 内置 fetch，异步真并发 + keep-alive 连接复用）
bdp config --set webTransport native
bdp dedup /med --concurrency 8
```

> **为什么有 native 模式**：curl 版用 `spawnSync` 同步起进程，**会阻塞事件循环** ——
> 于是 `--concurrency` 参数实际上是假的（实测 8 worker 与 1 worker 耗时相同）。
> `native` 模式改用 Node 内置 `fetch`，并发才真正生效（实测全盘扫描提速约 1.3×）。
> 两种模式结果一致，可随时用 `bdp config --set webTransport curl` 切回。

### index / ask — 本地全文索引与检索

```
bdp index build [path] [--include a,b] [--exclude a,b] [--no-extract] [--max-files N]
bdp index status
bdp index prune [path]
bdp ask <查询> [--limit N] [-p dir] [--ext ext]
```

把网盘变成可检索的知识库 —— `bdp search` 只能搜**文件名**，
`bdp ask` 能搜**正文**（TXT/PDF/DOCX/XLSX 的实际内容）。

- **零外部依赖**：Node 24 内置 `node:sqlite`（SQLite 3.53.4，FTS5 可用）
- **中文分词**：FTS5 的 unicode61 不切分中文（"风水" 查不中"倪海厦讲的风水古籍"），
  trigram 又要求查询词 ≥3 字。本工具建索引时把中文切成**二元组**再交给 unicode61，
  实测两字查询也能命中
- **增量**：md5 + size 未变的文件跳过，重复 build 只更新变化文件
- 索引默认存 `~/.bdp/index/default.db`
- `--no-extract` 只索引文件名与路径（秒级完成，搜不到正文但能搜到文件）
- `--include` / `--exclude` 按路径关键词限定范围（建议先用它缩小范围）

```bash
bdp index build /中医 --include 中医
bdp index status
bdp ask "甘草配伍禁忌" --limit 10
bdp ask "无菌检查法" -p /中医 --json
```

### get — 下载文件

```
bdp get <path> [-o <dir>] [--resume] [--force] [--progress] [--no-verify-size] [--dry-run]
bdp get <gid>:<fs_id> [-o <dir>]   # 群文件直下（免转存，等价 gdownload 单文件）
```

```bash
bdp get /文档/file.zip
bdp get /文档/file.zip -o ./downloads
bdp get /文档/file.zip --progress   # 实时进度 + 速度
bdp get /文档/file.zip --json       # JSON 元信息 {size, md5, verified, resumed, avgSpeedBps, ...}
```

- **下载可靠性**：直链分块下载（4MB/块），下载后自动 **size 校验**（0 字节 / 大小不符即报错并保留文件供排查）；断点续传（存在部分文件时自动继续，中断后重跑同一命令即可，每块失败自动换新 dlink 重试）
- **md5**：百度 API 返回的 md5 为混淆键（非内容哈希），CLI 计算本地 md5 供比对，`md5Obfuscated:true` 表示远端不可信
- 默认保存到当前目录；`-o` 为目录（自动创建）
- 目录下载/获取 dlink 失败时回退 BaiduPCS-Go 引擎（无校验/续传）

### put — 上传文件

```
bdp put <local> <remote> [--dry-run]
```

```bash
bdp put ./report.pdf /文档/
bdp put ./data.csv /学校/数据/
bdp put ./x.pdf /文档/ --dry-run   # 模拟
```

### mkdir — 创建目录

```
bdp mkdir <path>
```

**幂等**（v1.7.0）：目录已存在不算失败，`--json` 返回 `{"created":false,"exists":true}`。

```bash
bdp mkdir /新项目
bdp mkdir /文档/2026
```

### rm — 删除文件/目录

```
bdp rm <path> [path2 ...] [--dry-run] [--yes]
```

⚠️ 高危操作，Agent 使用前必须用户确认。

- 支持批量删除（v1.7.0），`--json` 返回每个路径的 `ok`/`error`
- **非交互环境（Agent / 管道）必须显式加 `--yes`**，否则拒绝执行并返回退出码 1
- 交互式终端会弹 y/N 确认
- 删除的文件可在回收站找回

```bash
bdp rm /临时文件.txt --dry-run        # 模拟
bdp rm /临时文件.txt --yes            # Agent 执行
bdp rm /a.txt /b.txt --yes            # 批量
```

### mv — 移动/重命名

```
bdp mv <src> <dst>
```

```bash
bdp mv /文档/a.pdf /文档/b.pdf   # 重命名
bdp mv /文档/a.pdf /备份/        # 移动到目录
```

### cp — 拷贝

```
bdp cp <src> <dst>
```

```bash
bdp cp /文档/a.pdf /备份/
```


### du — 目录容量分析

```
bdp du [path] [--depth N] [--top N] [--concurrency N]
```

- 递归统计目录大小（百度无服务端目录大小接口，走 /api/list 并发遍历）
- 输出每个子目录的聚合大小，找空间大户；深度封顶的子目录标记 [深度封顶]
- 全盘扫描较慢（API 限制），建议先 `bdp du /` 看顶层，再对大户目录深扫

**深度封顶与完整性**（v1.7.0）：

- 深度上限为 8（`--depth` 超过会被钳制，`depthCapped` 字段告知）
- 超过上限的子树不会被扫描 → 该目录的 size **不完整**
  （实测 `--depth 3` 时扫出 598GB，而 `bdp quota` 显示已用 6.64TB）
- JSON 里 `partial: true` 表示本次结果因深度封顶而不完整；
  子目录的 `capped`（自身未扫描）/ `partial`（子树未扫全）分别标注
- **实际占用以 `bdp quota` 为准**；要更准就加大 `--depth`
- `--progress` 在 stderr 实时输出扫描进度（目录数/文件数/队列/耗时）

```bash
bdp du /                          # 顶层分布
bdp du /玄学 --depth 5 --top 20   # 深扫指定目录
bdp du / --json                   # JSON 输出
bdp du / --progress               # 实时进度
```

### recycle — 回收站管理

```
bdp recycle list [--page N]
bdp recycle restore <fs_id>...
bdp recycle clean
```

- 删除的文件先进回收站（保留 60 天，仍占容量）—— 容量不足时先看这里
- `clean` 清空回收站释放容量，不可恢复，使用前务必确认

```bash
bdp recycle list
bdp recycle restore 378804494923604
bdp recycle clean
```

### quota — 网盘配额


```
bdp quota
```

- 输出总空间/已用/剩余（字节 + 百分比）

### offline — 离线下载

```
bdp offline add <http_url> [--path /保存目录]
bdp offline list
```

- 百度服务器代下，不占本地带宽；`--path` 指定保存目录（缺省引擎默认位置）

### share — 分享管理

```
bdp share set <path> [--pwd 提取码] [--combined]
bdp share cancel <shareId> [shareId2 ...]
bdp share list
```

- `--combined` 直接输出带提取码的可复制链接
- `share list` 走**网页 API** `/share/record`（v1.7.0 起）。
  BaiduPCS-Go v4.0.1 引擎的 `share list` 有 panic bug，网页 API 正常，
  输出含 shareId / 链接 / 提取码 / 过期时间 / 浏览次数，`source` 字段标明来源

## 配置命令

```
bdp login --bduss <X> --stoken <Y>   # 保存凭证
bdp whoami                            # 检查登录状态
bdp config                            # 查看配置（凭证脱敏）
bdp config --show-secrets             # 显式输出原值（谨慎使用）
bdp profile list / use <name> / unset   # 多账号 profile
bdp --profile <name> <命令>            # 全局参数，命令前/后均可
bdp serve --mcp                       # 启动 MCP 服务器（stdio）
```

> `bdp config` 与 `bdp config --json` **默认脱敏** BDUSS/STOKEN
> （前 10 位 + `...` + 后 4 位，JSON 带 `"redacted": true`）。
> 仅在用户明确要求时才用 `--show-secrets`。

### serve — MCP 服务器

```
bdp serve --mcp      # 启动 MCP 服务器（stdio, JSON-RPC 2.0, 换行分隔）
bdp serve --json     # 查看 MCP 模式信息，不启动
```

暴露 10 个带 JSON Schema 的工具：`bdp_ls` / `bdp_search` / `bdp_read` / `bdp_peek` /
`bdp_quota` / `bdp_get` / `bdp_put` / `bdp_mkdir` / `bdp_groups` / `bdp_gsearch`。
工具执行失败时返回 `isError: true` 并附中文错误说明。

返回群组名 + gid。

```bash
bdp groups
bdp groups --json
```

### gshares — 列出群内分享库

```
bdp gshares <gid> [--no-cache]
```

返回群内所有分享库（顶层目录）：名称、fs_id、分享者、msg_id。has_more=1 时按 last_msg_time 游标自动翻页。
- `--no-cache` 跳过 5 分钟会话缓存，强制拉取最新

```bash
bdp gshares 539478953581833690
bdp gshares 539478953581833690 --json
```

### gls — 浏览分享库内容

```
bdp gls <gid> <fs_id> [--page <N>] [--page-size <N>] [--from-uk <X>] [--msg-id <Y>] [--parent-fs-id <Z>] [--no-cache]
```

- 浏览分享库内的文件和子目录
- `--page-size` 默认 50，最大 100
- 子目录自动携带 `parentFsId`/`fromUk`/`msgId` 来源信息
- 若目标 fsId 不是顶层分享且未提供来源，会报错并提示传入 `--from-uk --msg-id`（不再猜测）

```bash
bdp gls 539478953581833690 742474845517885
bdp gls 539478953581833690 292608024165826 --from-uk 2642611875 --msg-id 5069931974377329661 --json
bdp gls 539478953581833690 742474845517885 --page 2 --page-size 50 --json
```

**errno=-3 处理**：gls 遇到群分享 API 拒绝（errno=-3）时自动依次尝试 page-size 50→20→10；仍失败时：
- 传入 `--parent-fs-id` → 自动列出父目录，返回 `fallback: {reason:"errno=-3", resolvedFsId: <父目录>, level:"parent"}`
- 目标为顶层分享 → 退回 gshares 结果，`fallback.level: "group-shares"`
- Agent 应依据 fallback 从父目录换路径继续遍历

**errno=2131 处理**：msg_id 不属于该群（常见为 gid 与参数来自不同群/分享库）时，工具自动按 fsId 从本群 gshares 解析纠正并重试（结果含 `autoResolved:true`）；无法纠正时返回详细指引（`bdp error 2131`）

### gsearch — 搜索群文件名

```
bdp gsearch <gid> <keyword> [--page <N>] [--limit <N>] [--depth <N>] [--concurrency <N>] [--max-pages <N>] [--max-requests <N>] [--no-unique] [--all|--all-results] [--timeout <N>] [--save-partial] [--any-word] [--exact] [--no-cache] [--verbose] [--json-file <path>]
```

- 搜索顶层分享 + 子目录文件名（`--depth N` 递归深度，默认 1）
- 目录内容自动全页遍历（每页上限 100，`--max-pages` 默认 50），不再漏数据
- 默认 `--limit 50`，**只取一页**；`hasMore: true` 时用 `--page` 翻页
- `--max-requests N` 单条命令请求预算（默认 400），防止深扫触发限流
- 默认启用磁盘会话缓存（目录 30min/分享 5min），重复搜索秒回；`--no-cache` 关闭
- 默认去重（相同 fsId 不同 msgId 只返回一次）；`--no-unique` 保留全部来源
- `--concurrency 4` 并发扫描分享目录（1-8），稀疏关键词时提前停止
- `--all`/`--all-results` 忽略分页获取全部（不作为默认，慢但完整）
- `--timeout <N>`：到点停止扫描并返回已搜到的部分结果（`timedOut:true, complete:false, partial:true`），避免深扫挂死
- `--save-partial`：未完整（超时/限流/预算/失败）时自动把已搜到的结果存为 JSON 并打印 `💾 部分结果已保存: <路径>`；配 `--json-file <path>` 写该文件，否则自动生成 `bdp-gsearch-<gid>-<kw>-partial-<时间戳>.json`（当前目录）。保存内容含 `saved:"partial"` + `results`（已搜到的全部匹配）+ 扫描诊断（scannedShares/totalShares/failedShares/stoppedReason/timedOut 等），可直接读取续扫
- **多关键词**：关键词用空格分隔，默认"全部命中"（AND，可换序）→ `"玄空 飞星"` 只返回同时含"玄空"与"飞星"的名字（精确收窄，解决"玄空"命中 52 个、"玄空飞星"只命中 2 个的问题）；`--any-word` 改"任一命中"（OR）；`--exact` 按文件名精确匹配（忽略路径前缀，大小写不敏感）。单关键词默认仍是子串包含（兼容旧行为）
- `--json-file <path>` 由 Node 直接写 UTF-8 文件，绕过 PowerShell 编码问题

```bash
bdp gsearch 539478953581833690 "倪海厦"
bdp gsearch 539478953581833690 "古籍" --page 2 --limit 20 --json
bdp gsearch 539478953581833690 "紫微" --no-unique --json
bdp gsearch 539478953581833690 "资料" --limit 50 --json-file result.json
```

**JSON 返回结构**：
```json
{
  "results": [ { "name": "...", "path": "...", "isDir": true, "size": 0,
                 "fsId": "...", "parentFsId": "...", "fromUk": "...", "msgId": "...", "group": "..." } ],
  "page": 1, "pageSize": 50, "returned": 5,
  "total": null, "hasMore": true, "nextPage": 2,
  "unique": true, "complete": false, "partial": false, "throttled": false,
  "timedOut": false, "stoppedReason": null,
  "scannedShares": 7, "totalShares": 73, "failedShares": 0, "failedDirs": [],
  "throttledShares": 0, "cachedDirs": 0, "budgetUsed": 12, "maxPages": 50
}
```

- `hasMore`/`nextPage`：翻页依据
- `complete`：是否完整扫描（提前截断/失败/超时都为 false）；`partial`：结果不完整（`!complete`）；`throttled`：是否因 API 限流中断（重跑命令可续扫，磁盘缓存只补缺失目录）
- `timedOut`：是否因 `--timeout` 到点停止（返回部分结果）；`stoppedReason`：停止原因（`page-limit`/`budget`/`throttled`/`timeout`/`complete`）
- `failedDirs`：失败目录明细（fsId/name/errno，最多 50 条）
- `scannedShares`/`totalShares`/`failedShares`/`throttledShares`/`cachedDirs`/`budgetUsed`：扫描进度元数据

### gdownload — 直接下载群文件（免转存）

```
bdp gdownload <gid> <fs_id> [fs_id2 ...] [-o <dir>] [--filename <name>] [--from-uk <uk>] [--msg-id <id>] [--no-cache] [--json]
```

- **用途**：把群聊文件直接下载到本地，**无需转存**（百度已下线群文件转存，`/mbox/msg/transfer` 非空目录一律 `errno=-10`，新版 UI 也移除了"保存"按钮；本命令走逆向的 `/api/sharedownload` 接口，`sign/timestamp` 留空即可）
- **单 fs_id → 单文件直下**：返回明文 dlink 直接 curl 下载
- **多 fs_id → zip 打包下载**（`type=batch`，实测可用）：同一分享消息的多个文件打包为 zip（默认名 `bdp-group-<n>files.zip`，`--filename` 可改）
- fs_id 来源：`gls`/`gsearch` 结果的 `fsId`；子目录文件或单文件分享自动解析 fromUk/msgId（gshares 顶层匹配），解析不到时用 `--from-uk`/`--msg-id` 显式传入（与 gls/gsearch 同源）
- **只支持文件**：目录 fs_id 会报错并提示先用 gls/gsearch 定位文件
- 输出：默认当前目录，`-o` 指定目录，`--filename` 指定文件名（默认用网盘文件名）
- 成功校验：下载字节数与服务端 `size` 一致；dlink 有效期 8h，超时/失败重跑即可
- **JSON 输出**：`{path, name, size, fsId, fromUk, msgId}`（多文件含 `count`）

**限制**（实测，2026-08）：单文件 ≤ ~20MB 明文；大文件返回加密串（无解）；zip 打包总包 ≤ ~100MB（超限报 `31090 package is too large`）；大文件请用百度网盘官方客户端

```bash
bdp gdownload 539478953581833690 954615608563687 -o ./downloads --from-uk 1101635869133 --msg-id 713945176566573051
bdp gdownload 19647465335386550 643585853595305 -o ./apks   # 单文件分享自动解析来源
bdp gdownload 539478953581833690 527948256537856 986718405708023 -o ./zips   # 多文件 zip 打包
```

### cache — 会话缓存管理

```
bdp cache [clear]
```

- 无参数：显示缓存目录与 TTL（目录 30min / 分享 5min）
- `cache clear`：清空群聊会话缓存（L1 内存 + L2 磁盘，`~/.bdp/cache/`）

```bash
bdp cache
bdp cache clear
```

### error — 错误码说明

```
bdp error <code>
```

> 负数错误码直接作为参数即可（`bdp error -3`）；也支持 `bdp error -- -3`。

```bash
bdp error -3
# 群分享 API 拒绝请求。已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁(限流)都可能触发。
# 处理：减小 --page-size（自动重试 50→20→10）或 --concurrency；限流表现为 errno=0 只返回目录自身，工具自动退避重试
bdp error 2131
# msg_id 不属于该群：gid 与 fromUk/msgId 必须同源，工具会自动按 fsId 纠正（autoResolved:true）
```

## 配置命令

```
bdp login --bduss <X> --stoken <Y>   # 保存凭证
bdp whoami                            # 检查登录状态
bdp config                            # 查看配置
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `BDP_BDUSS` | BDUSS cookie | 无 |
| `BDP_STOKEN` | STOKEN cookie | 无 |
| `BAIDUPCS_CMD` | BaiduPCS-Go 路径 | 自动检测 |
| `BDP_MAX_CAT_BYTES` | cat 最大读取字节 | 1048576 |

### gtree — 构建群目录树

```
bdp gtree <gid> [--depth N] [--concurrency N] [--max-nodes N] [--max-pages N] [--max-requests N] [--no-cache]
```

- BFS 逐层构建目录树，默认 depth 2，节点上限 2000
- 返回 	ree（含 path/fsId/parentFsId/fromUk/msgId）+ ailed + 元数据

```bash
bdp gtree 539478953581833690 --depth 2 --json
```

> gsearch 的 --depth N 可递归搜索深层目录（默认 1）。深度越大请求数越多，稀疏关键词可用 gtree 建树后定位再深入。
