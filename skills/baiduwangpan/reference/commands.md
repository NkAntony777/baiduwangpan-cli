# bdp 完整命令参考

`bdp` 是 `baiduwangpan-cli` 的全局命令。所有命令支持 `--json` 结构化输出。

## 网盘文件操作

### ls — 列出目录

```
bdp ls [path]
```

- `path` 默认 `/`（网盘根目录）
- 支持任意路径，全盘可访问

```bash
bdp ls /
bdp ls /中医
bdp ls /文档 --json
```

### search — 搜索文件名

```
bdp search <keyword> [-p <dir>]
```

- 递归搜索文件名（不支持搜索目录名）
- `-p` 指定搜索目录，默认 `/` 全盘

```bash
bdp search "报告"
bdp search "数据集" -p /学校
bdp search "中医" --json
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

- 显示大小、类型（文本/二进制）、dlink 可用性
- 文本文件自动预览前 10 行

```bash
bdp peek /文档/report.pdf
bdp peek /文档/data.json --json
```

### get — 下载文件

```
bdp get <path> [-o <dir>]
```

```bash
bdp get /文档/file.zip
bdp get /文档/file.zip -o ./downloads
```

### put — 上传文件

```
bdp put <local> <remote>
```

```bash
bdp put ./report.pdf /文档/
bdp put ./data.csv /学校/数据/
```

### mkdir — 创建目录

```
bdp mkdir <path>
```

```bash
bdp mkdir /新项目
bdp mkdir /文档/2026
```

### rm — 删除文件/目录

```
bdp rm <path>
```

⚠️ 高危操作，Agent 使用前必须用户确认。

```bash
bdp rm /临时文件.txt
```

## 群聊文件操作

### groups — 列出所有群组

```
bdp groups
```

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
bdp gsearch <gid> <keyword> [--page <N>] [--limit <N>] [--depth <N>] [--concurrency <N>] [--max-pages <N>] [--max-requests <N>] [--no-unique] [--all|--all-results] [--timeout <N>] [--save-partial] [--no-cache] [--verbose] [--json-file <path>]
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
