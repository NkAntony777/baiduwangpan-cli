---
name: baiduwangpan
description: 百度网盘 CLI 操作技能 — 基于 baiduwangpan-cli (bdp) 命令，支持全盘文件浏览/搜索/免下载读取内容/上传下载/群聊文件浏览。当用户要求查看、搜索、读取、上传、下载百度网盘文件，或浏览百度网盘群聊文件时使用。
version: 1.1.2
authors:
  - NkAntony777
credentials:
  - name: BDP_BDUSS
    required: false
    description: "百度网盘 BDUSS cookie。也可通过 `bdp login` 配置保存到 ~/.bdp/config.json"
    storage: "~/.bdp/config.json 或环境变量"
  - name: BDP_STOKEN
    required: false
    description: "百度网盘 STOKEN cookie。也可通过 `bdp login` 配置保存到 ~/.bdp/config.json"
    storage: "~/.bdp/config.json 或环境变量"
---

## Overview

本技能封装了 `baiduwangpan-cli`（全局命令 `bdp`）——一个专为 AI Agent 设计的百度网盘命令行工具。通过统一的 `bdp` 命令，Agent 可以：

- **全盘浏览**：列出任意目录、按文件名递归搜索
- **免下载读取**：直接读取文件内容（cat/head/tail/grep），无需下载整个文件
- **上传下载**：网盘与本地之间传输文件
- **群聊文件**：列出群组、浏览群内分享库、搜索群文件
- **结构化输出**：所有命令支持 `--json` 输出，便于程序化解析

## Trigger

当用户请求涉及以下内容时激活本技能：

1. **查看网盘文件** — "看看我网盘里有什么"、"列出 /中医 目录"、"帮我找一下报告文件"
2. **读取文件内容** — "读一下 xxx.txt 的内容"、"看看这个日志前几行"、"搜索这个 CSV 里的数据"
3. **上传/下载** — "把本地文件传到网盘"、"下载网盘里的 xxx"
4. **群聊文件** — "看看我有哪些群"、"在群里找 xxx 文件"、"浏览群分享的文件"
5. **文件管理** — 创建目录、删除文件、预览文件信息

## 前置检查（每次使用前）

```bash
bdp whoami --json
```

- `loggedIn: true` → 继续
- 未登录 → 提示用户运行 `bdp login --bduss <值> --stoken <值>`（见 reference/authentication.md）

如果 `bdp` 命令不存在 → 运行安装脚本（见下）。

## 登录（两种方式）

**推荐：浏览器自动登录（扫码）**
```bash
bdp login
```
自动启动 Chrome/Edge → 打开登录页 → 用户手机扫码 → Agent 自动检测并保存凭证 → 同步引擎。全程无需 F12。

**备用：手动凭证**
```bash
bdp login --bduss <BDUSS值> --stoken <STOKEN值>
```
（获取方法见 reference/authentication.md）

## Recommended Entry Point

命令不确定或执行报错时，先运行 `bdp --help` 查看全部可用命令与参数（离线、无网络请求），再对照 reference/commands.md 重试。所有命令支持 `--json` 输出；失败时输出 `{"error":"..."}`（见 reference/troubleshooting.md 的错误表格）。

## 安装

```bash
npm install -g baiduwangpan-cli
```

安装时自动下载 BaiduPCS-Go 引擎（镜像优先加速，国内也能装）。引擎丢失时 CLI 会自动发现包目录内版本子目录（如 `BaiduPCS-Go-v4.0.1-windows-x64/`）中的二进制，config 里失效的绝对 `pcsPath` 自动回退，无需手改配置。之后配置凭证：

```bash
bdp login --bduss <BDUSS值> --stoken <STOKEN值>
bdp whoami   # 验证
```

> **安全**：BDUSS/STOKEN 是敏感凭证。配置后存放在 `~/.bdp/config.json`。Agent 不得打印、输出或回显配置文件中凭证的完整内容。

## 命令速查

### 网盘文件操作

```bash
bdp ls [path]                      # 列出目录
bdp search <keyword> [-p dir]      # 搜索文件名（默认全盘 /）
bdp cat <path>                     # 读取文件内容（免下载，限1MB）
bdp head [-n N] <path>             # 读取前N行（默认20）
bdp tail [-n N] <path>             # 读取后N行
bdp grep <pattern> <path>          # 在文件内容中搜索
bdp peek <path>                    # 预览文件信息
bdp get <path> [-o dir]            # 下载到本地
bdp put <local> <remote>           # 上传
bdp mkdir <path>                   # 创建目录
bdp rm <path>                      # 删除
```

### 群聊文件操作

```bash
bdp groups                         # 列出所有群组（拿 gid）
bdp gshares <gid> [--no-cache]     # 列出群内分享库（拿 fs_id，自动游标翻页）
bdp gls <gid> <fs_id> [--page N] [--page-size N] [--from-uk X] [--msg-id Y] [--parent-fs-id Z]
                                   # 浏览分享库内容（默认 page-size 50，最大 100）
bdp gsearch <gid> <keyword>        # 搜索群文件名（全量遍历目录，缓存命中秒回）
    [--page N] [--limit N] [--depth N] [--concurrency N] [--max-pages N] [--max-requests N]
    [--no-unique] [--all|--all-results] [--timeout N] [--save-partial]
    [--any-word] [--exact] [--no-cache] [--verbose] [--json-file <path>]
bdp gdownload <gid> <fs_id>        # 直接下载群文件到本地（免转存）
    [-o dir] [--filename NAME] [--from-uk X] [--msg-id Y] [--no-cache]
bdp cache [clear]                  # 查看/清空会话缓存（~/.bdp/cache/，目录30min/分享5min）
bdp error <code>                   # 查看错误码说明（如 -3 / 2131）
```

### 通用选项

```bash
--json            # 结构化 JSON 输出（Agent 首选）
--json-file <p>   # JSON 写入文件（UTF-8，绕过控制台编码）
--legacy-json     # 输出裸数组（旧版兼容）
--verbose         # 进度/日志只写 stderr，不污染 stdout
```

## 推荐执行模式

**Agent 应优先使用 `--json` 输出**，例如：

```bash
# 找文件（全盘）
bdp search "报告" --json

# 读文件内容
bdp head -n 50 /文档/日志.txt --json

# 群聊文件
bdp groups --json
bdp gsearch 539478953581833690 "倪海厦" --json
```

**群聊文件浏览工作流**：
1. `bdp groups --json` → 获取 `gid`
2. `bdp gshares <gid> --json` → 获取顶层分享目录 `fsId`
3. `bdp gls <gid> <fsId> --json` → 浏览子目录/文件（默认取 50 条）
4. `bdp gsearch <gid> <keyword> --json` → 按名称搜索
5. `bdp gdownload <gid> <fsId> -o ./下载目录` → 直接下载群文件到本地（免转存；fs_id 来自 gls/gsearch 结果，子文件自动解析来源）

**分页与遍历规则（Agent 必须遵守）**：
- gsearch/gls 默认只取 20-50 条；看到 `hasMore: true` 时用 `--page <nextPage>` 继续翻页
- 每个结果携带 `parentFsId`/`fromUk`/`msgId`，爬取子目录时通过 `gls --from-uk --msg-id --parent-fs-id` 传入
- 若响应含 `fallback`（level=parent），说明目标目录 API 拒绝（errno=-3），应从 `resolvedFsId`（父目录）换路径继续遍历
- `partial: true` 表示部分分享扫描失败，结果不完整，可重试或换关键词；`throttled: true` 表示 API 限流中断，重跑命令可续扫（磁盘缓存只补缺失目录）
- 目录内容自动全页遍历（每页上限 100，`--max-pages` 默认 50）；`--max-requests` 控制单命令请求预算（默认 400）
- gsearch/gtree/gshares 默认启用磁盘会话缓存，重复搜索秒回；`--no-cache` 关闭，`bdp cache clear` 清理
- 大目录搜索可用 `--concurrency 4`（默认）并发扫描；`--all`/`--all-results` 会忽略分页获取全部，不要作为默认行为
- 深扫建议 `--timeout <秒>`：到点返回已搜到的部分结果（`timedOut:true`，不挂死）；`--save-partial` 在未完整时自动把已搜到的结果存为 JSON 并打印路径（配 `--json-file` 写指定文件，否则自动生成 `bdp-gsearch-<gid>-<kw>-partial-<时间戳>.json`），Agent 超时后直接读该文件续扫
- gsearch JSON 含 `stoppedReason`（page-limit/budget/throttled/timeout/complete）与 `timedOut`，判断结果是否完整以 `complete`/`partial` 为准
- **多关键词匹配**：关键词用空格分隔，默认"全部命中"（AND，可换序）→ `gsearch "玄空 飞星"` 只返回同时含"玄空"与"飞星"的名字（精确收窄）；`--any-word` 改为"任一命中"（OR，更宽）；`--exact` 按文件名精确匹配（忽略路径前缀）。单关键词默认仍是子串包含（兼容旧行为）

## 安全边界

1. **凭证保护**：绝不输出/记录 `~/.bdp/config.json` 中的 BDUSS、STOKEN 值。`bdp config` 输出含前 10 位掩码，同样禁止回显
2. **删除操作**：`bdp rm` 为高风险操作，执行前需用户明确确认
3. **写入操作**（put/mkdir/rm）：先向用户列出执行计划，确认后再执行
4. **下载目录**：默认保存到用户指定目录或当前工作目录，不写入系统目录
5. **cat 限制**：`cat` 默认限 1MB（防误读大文件），大文件用 `head/tail` 分段读取

## 详细文档

- [完整命令参考](reference/commands.md)
- [认证配置](reference/authentication.md)
- [Agent 使用示例](reference/examples.md)
- [故障排查](reference/troubleshooting.md)
