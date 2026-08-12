<div align="center">

# baiduwangpan-cli

**百度网盘 CLI — 全盘读写 · 免下载读取 · 群聊文件浏览/下载**

专为 AI Agent 设计的百度网盘命令行工具

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen)](https://nodejs.org)
[![npm version](https://img.shields.io/npm/v/baiduwangpan-cli)](https://www.npmjs.com/package/baiduwangpan-cli)
[![npm downloads](https://img.shields.io/npm/dm/baiduwangpan-cli)](https://www.npmjs.com/package/baiduwangpan-cli)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## ✨ 特性

- **🗂️ 全盘访问** — 不受 `/apps/` 目录限制，读写网盘任意路径
- **📄 免下载读取** — 通过 HTTP Range 直接读取文件内容到 stdout，无需下载整个文件
- **👥 群聊文件浏览 + 下载** — 逆向 mbox API，列出群组、浏览群内分享库、搜索群文件，并支持**直接下载群文件到本地**（免转存）
- **🤖 Agent 友好** — 所有命令支持 `--json` 结构化输出，零解析成本
- **🔧 双模式** — 既是 CLI 工具，也可作为 Node.js 库 `require()` 使用
- **🔐 凭证安全** — 配置存储在 `~/.bdp/config.json`，不写入代码或日志

## 📌 能力一览

| 能力 | 命令 | 说明 |
|:-----|:------|:-----|
| 列目录 | `bdp ls /` | 全盘任意目录 |
| 搜索文件名 | `bdp search "报告"` | 递归全盘搜索，支持 glob/正则 |
| **读取文件内容** | `bdp cat /文档/data.json` | 免下载，限 1MB |
| **读取前 N 行** | `bdp head -n 50 /文档/log.txt` | 免下载 |
| **读取后 N 行** | `bdp tail -n 30 /文档/log.txt` | 免下载 |
| **搜索文件内容** | `bdp grep "关键词" /文档/file.txt` | 免下载 |
| 预览文件 | `bdp peek /文档/report.pdf` | 类型检测 + 前 10 行 + md5/ctime |
| 下载 | `bdp get /文档/file.zip` | 保存到本地，**size 校验 + 断点续传** |
| 上传 | `bdp put ./file.txt /文档/` | 全盘任意位置 |
| 移动/重命名 | `bdp mv <src> <dst>` | 移动或重命名 |
| 拷贝 | `bdp cp <src> <dst>` | 网盘内复制 |
| 配额 | `bdp quota` | 总容量/已用/剩余 |
| 容量分析 | `bdp du [path]` | 递归统计目录大小，找空间大户 |
| 回收站 | `bdp recycle list/restore/clean` | 列出/还原/清空回收站 |
| 离线下载 | `bdp offline add <url>` | 百度服务器代下 |
| 分享管理 | `bdp share set/cancel` | 生成/取消分享链接 |
| **列出群组** | `bdp groups` | 所有群聊 + gid |
| **群内分享库** | `bdp gshares <gid>` | 顶层分享目录 |
| **浏览群文件** | `bdp gls <gid> <fs_id>` | 分页 + 递归 |
| **搜索群文件** | `bdp gsearch <gid> "关键词"` | 按文件名搜索（缓存命中秒回） |
| **下载群文件** | `bdp gdownload <gid> <fs_id>` | **直接下载到本地，免转存**（逆向 sharedownload API） |
| 群目录树 | `bdp gtree <gid>` | BFS 构建目录树 |
| 群缓存管理 | `bdp cache [clear]` | 查看 / 清空会话缓存 |

## 🚀 快速开始

### 1. 安装

```bash
npm install -g baiduwangpan-cli
```

安装时会**自动下载** BaiduPCS-Go 引擎（镜像优先加速，国内也能装；全部下载源失败时打印手动下载地址，不阻断安装）。
CLI 会自动发现引擎（包根固定路径或 `BaiduPCS-Go-v4.0.1-windows-x64/` 版本子目录），升级不会丢 `pcsPath` 配置。也支持手动克隆：

```bash
git clone https://github.com/NkAntony777/baiduwangpan-cli.git
cd baiduwangpan-cli
npm install        # postinstall 自动下载引擎
npm link           # 全局注册 bdp 命令
```

> **依赖**: Node.js 14+ 和 `curl`（已在 Windows 10+ / macOS / 大多数 Linux 预装）

### 2. 配置认证

**方式一：浏览器自动登录（推荐）**

```bash
bdp login
```

自动启动 Chrome/Edge → 打开百度网盘登录页 → **手机扫码** → 在页面会话内验证登录 → 自动同步引擎。无需 F12。

扫码产生的新会话可能被百度限制为只能在原浏览器上下文中使用。因此 `bdp` 会保留专用 profile，并在登录后将浏览器最小化；PCS API 继续使用 BDUSS/STOKEN，网页和群聊 API 通过该浏览器的 CDP 会话调用。浏览器被关闭后，下次网页 API 调用会使用同一 profile 自动重启。

**方式二：手动凭证**

```bash
bdp login --bduss <你的BDUSS> --stoken <你的STOKEN>
bdp whoami  # 验证
```

<details>
<summary>📋 如何获取 BDUSS 和 STOKEN（手动方式）</summary>

1. 浏览器打开 [pan.baidu.com](https://pan.baidu.com) 并登录
2. 按 `F12` → **Application** → **Cookies** → `https://pan.baidu.com`
3. 找到 **BDUSS** 和 **STOKEN** 的值，复制

> ⚠️ STOKEN 必须在百度网盘页面获取（不是百度首页），值中应包含大写字母。

> 💡 推荐直接运行 `bdp login`，全程自动化，无需手动操作。

</details>

### 3. 开始使用

```bash
# 浏览网盘
bdp ls /
bdp search "中医"

# 免下载读取文件
bdp head -n 10 /文档/data.csv
bdp cat /文档/config.json

# 浏览群聊文件
bdp groups
bdp gshares 539478953581833690
bdp gls 539478953581833690 742474845517885
# 下载群文件到本地 (免转存)
bdp gdownload 539478953581833690 954615608563687 -o ./downloads
```

## 📖 完整命令参考

### 网盘文件操作

```
bdp ls [path]                    列出目录
bdp search <keyword> [-p dir]    搜索文件名
                                  [--regex 正则] [--glob 通配符] [--any-word] [--exact]
bdp cat <path>                   读取文件内容 (免下载, 限 1MB)
bdp head [-n N] <path>           读取前 N 行 (默认 20)
bdp tail [-n N] <path>           读取后 N 行 (默认 20)
bdp grep <pattern> <path>        搜索文件内容
bdp peek <path>                  预览文件信息 + 前 10 行 (含 md5/ctime)
bdp get <path> [-o dir]          下载文件 (直链分块, size 校验, 断点续传)
                                  [--resume] [--force] [--progress] [--no-verify-size] [--dry-run]
                                  <gid>:<fs_id> 形式自动走群文件直下
bdp put <local> <remote>         上传文件 [--dry-run]
bdp mkdir <path>                 创建目录
bdp rm <path>                    删除文件/目录 [--dry-run]
bdp mv <src> <dst>               移动/重命名文件/目录
bdp cp <src> <dst>               拷贝文件/目录
bdp quota                        网盘配额 (总/已用/剩余)
bdp du [path]                   目录容量分析 (递归统计, --depth/--top/--concurrency)
bdp recycle list / restore <id>... / clean   回收站管理 (clean 不可恢复)
bdp offline add <url> [--path D] 离线下载 (百度服务器代下)
bdp offline list                 离线任务列表
bdp share set <path> [--pwd P]   创建分享链接 [--combined 输出带密码链接]
bdp share cancel <id>...         取消分享
bdp share list                   列出分享 (受 BaiduPCS-Go v4.0.1 引擎 bug 限制)
bdp profile list / use <name>    多账号 profile 管理
bdp help [command]               帮助总览 / 单命令详情 (--json 结构化输出)
```

### 群聊文件操作

```
bdp groups                       列出所有群组
bdp gshares <gid> [--no-cache]    列出群内分享库 (自动游标翻页)
bdp gls <gid> <fs_id> [--page N] [--page-size N] [--from-uk X] [--msg-id Y]
                                  [--parent-fs-id Z] [--no-cache]   浏览分享库内容
bdp gtree <gid> [--depth N] [--concurrency N] [--max-nodes N]
                                  [--max-pages N] [--max-requests N] [--no-cache]   构建群目录树
bdp gsearch <gid> <keyword>      搜索群文件名 (全量遍历目录)
                                  [--page N] [--limit N] [--depth N] [--concurrency N]
                                  [--max-pages N] [--max-requests N] [--no-unique]
                                  [--all|--all-results] [--timeout N] [--save-partial]
                                  [--any-word] [--exact] [--no-cache]
bdp gdownload <gid> <fs_id>...   直接下载群文件到本地 (逆向 /api/sharedownload, 免转存)
                                  单文件直下；多个 fs_id（同消息）自动 zip 打包下载
                                  [-o dir] [--filename NAME] [--from-uk X] [--msg-id Y] [--no-cache]
bdp cache [clear]                查看 / 清空会话缓存 (~/.bdp/cache/)
```

> **群文件下载限制说明**（实测，2026-08）：
> - 单文件 ≤ ~20MB：直接下载 ✅
> - 同消息多文件：zip 打包下载 ✅（总包 ≤ ~100MB）
> - 大文件（> ~100MB）：网页端受百度限制（单文件加密 / zip 报 `31090 package is too large`），需用官方客户端；转存接口已被百度下线（`errno=-10`）
> - 详见 `docs/group-download-final-verdict.md`

### 通用选项

```
--json                           JSON 结构化输出 (Agent 友好)
--json-file <path>               JSON 写入文件 (UTF-8, 绕开控制台编码)
--verbose                        进度/日志只写 stderr
-n <N>                           行数 (head/tail, 默认 20)
-p <path>                        搜索路径 (search, 默认 /)
-i                               忽略大小写 (grep)
-N                               显示行号 (cat/grep)
-o <dir>                         输出目录 (get)
--resume                         断点续传 (get；存在部分文件时自动续传)
--force                          覆盖重下 (get；先删除旧文件)
--progress                       显示实时进度 + 速度 (get，stderr)
--no-verify-size                 关闭下载后 size 校验 (get；默认开启)
--regex / --glob                 搜索模式: 正则 / 通配符 (search)
--any-word                       空格分隔关键词命中任意一个 (search/gsearch)
--exact                          整名精确匹配 (search/gsearch)
--pwd <P>                        分享提取码 (share set)
--combined                       输出带提取码的分享链接 (share set)
--dry-run                        模拟执行不落盘 (get/put/rm)
--profile <name>                 切换账号 profile (全局参数，命令前/后均可)
--page <N>                       页码 (gls/gsearch, 默认 1)
--page-size <N>                  每页条数 (gls, 默认 50, 最大 100)
--limit <N>                      每页条数 (gsearch, 默认 50)
--depth <N>                      递归深度 (gsearch 默认 1 / gtree 默认 2)
--concurrency <N>                并发扫描数 (gsearch/gtree, 默认 4, 1-8)
--max-nodes <N>                  树节点上限 (gtree, 默认 2000)
--max-pages <N>                  单目录最大页数 (gsearch/gtree, 默认 50, 100 条/页)
--max-requests <N>               单命令请求预算 (gsearch/gtree, 默认 400, 防限流)
--from-uk <X> / --msg-id <Y>     分享来源参数 (gls 子目录)
--parent-fs-id <Z>               父目录 fsId (gls, errno=-3 时回退用)
--no-unique                      保留不同 msgId 的重复项 (gsearch)
--all, --all-results             忽略分页获取全部结果 (gsearch; 不限时, 慢但完整)
--timeout <N>                    超时秒数，到点返回已扫到的部分结果 (gsearch; 0=不限时, 默认 0)
--save-partial                    未完整时自动把已搜到的结果存为 JSON 并打印路径 (gsearch; 配 --json-file 时写该文件)
--any-word                        空格分隔关键词命中任意一个即可 (gsearch; 默认=全部命中 AND)
--exact                           按文件名精确匹配，忽略路径前缀 (gsearch; 大小写不敏感)
--no-cache                       禁用会话缓存 (gsearch/gtree/gshares/gls)
```

### get 下载可靠性（v1.2.0）

`bdp get` 已从裸跑 BaiduPCS-Go 升级为**直链分块下载 + 三重保障**（实测，2026-08）：

```
bdp get /文档/大文件.zip                 # 下载到当前目录，自动 size 校验
bdp get /文档/大文件.zip -o ./dl         # 下载到指定目录 (自动创建)
bdp get /文档/大文件.zip --resume        # 断点续传（存在部分文件时自动续传，无需该参数）
bdp get /文档/大文件.zip --force         # 已有文件时覆盖重下
bdp get /文档/大文件.zip --progress      # 实时进度 + 速度 (stderr)
bdp get /文档/大文件.zip --json          # JSON 元信息: {path, localPath, size, md5, remoteMd5,
                                         #   md5Match, md5Obfuscated, dlinkExpiry, verified,
                                         #   skipped, resumed, avgSpeedBps}
```

- **size 校验**（默认开启，`--no-verify-size` 可关）：下载后比对远端/本地字节数，0 字节或大小不符即报错并**保留文件供排查**
- **断点续传**：curl 有界 Range 分块下载（4MB/块，实测部分 CDN 节点只接受 ≤5MB 的有界 Range，无界请求会 403），每块失败自动**换新 dlink 重试**；中断后重跑同一命令即从断点继续
- **并发分块**：大文件（>32MB）默认 3 路并发分块（`--concurrency 1` 可回串行）。实测百度对非 SVIP 是**账号级限速**，并发无法突破总量限速，但多 CDN 节点并行能提升稳定性（坏节点/单连接抖动不影响整体）
- **md5 软校验**：百度 `/api/list` 返回的 md5 是**混淆键**（含 `o`/`t` 等非 hex 字符，非内容哈希），无法作为完整性依据；CLI 计算本地 md5 供流水线比对，`md5Obfuscated:true` 标注远端不可信
- **默认保存位置**：`-o` 指定目录，否则当前目录（与 `gdownload` 一致）
- 目录下载 / 获取 dlink 失败等边界场景自动回退 BaiduPCS-Go 引擎（无校验/续传）

### 多账号 profile（v1.3.0）

多个百度账号切换，认证字段按 profile 隔离（pcsPath/ua 等配置保持全局）：

```
bdp --profile svip login --bduss X --stoken Y   # 登录到 svip profile
bdp profile list                                 # 列出所有 profile
bdp --profile svip quota                         # 用 svip 账号执行命令
bdp login --profile 备份 ...                     # --profile 也可放命令后
bdp profile unset                                # 切回全局账号
```

- 存储在 `~/.bdp/config.json` 的 `profiles` + `activeProfile` 字段；无 profile 时行为与旧版完全一致
- `bdp whoami` 会显示当前 profile

### 容量管理（v1.6.0）

网盘容量见底时的排查三件套（百度无服务端目录大小接口，`du` 走 /api/list 并发遍历）：

```
bdp quota                          # 总/已用/剩余（实测 99.78% 时优先排查下面两项）
bdp recycle list                   # 回收站：删除的文件保留 60 天仍占容量，先看这里
bdp recycle restore <fs_id>...     # 还原误删
bdp recycle clean                  # 清空回收站释放容量（不可恢复，务必确认）
bdp du /                           # 顶层目录容量分布（找空间大户）
bdp du /玄学 --depth 5 --top 20    # 深扫指定目录（深度封顶的子目录标 [深度封顶]）
bdp du / --json                    # JSON 输出（Agent 可解析）
```

> 注意：`du` 全盘扫描较慢（API 限制，深度 4 全盘约 10 分钟），建议先顶层后深扫；若 quota 已用量与全盘可见内容差距巨大，优先怀疑**百度扩容/福利空间到期**（总量缩水，历史总量需在网页端空间明细核实）。

## 🤖 Agent 集成示例

所有命令支持 `--json` 输出，适合 AI Agent 直接调用和解析。**Agent 运行时发现用法**：

```bash
bdp help --json                # 全部命令的 usage/desc/options/examples（结构化）
bdp help get --json            # 单个命令的完整定义
bdp help gsearch --json        # 群搜索的全部选项
```

```bash
# Agent 获取群组列表 (JSON)
bdp groups --json
# → [{"gid":"539478953581833690","name":"国学文化SVIP13",...}]

# Agent 读取文件内容 (JSON)
bdp head -n 5 /文档/data.csv --json
# → {"path":"/文档/data.csv","lines":5,"content":["header","row1","row2",...]}

# Agent 搜索群文件 (JSON)
bdp gsearch 539478953581833690 "倪海厦" --json
# → [{"name":"N 倪海厦","path":"/全店svip200位大师课(共16T)/N 倪海厦","isDir":true,...}]
```

### 作为 Node.js 库使用

```javascript
const { pan, group } = require('baiduwangpan-cli');

// 免下载读取文件
const content = pan.cat('/文档/data.json');

// 搜索群聊文件
const results = await group.searchFiles('539478953581833690', '倪海厦');
```

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────┐
│                    Agent / 用户                      │
├─────────────┬───────────────────────────────────────┤
│   CLI 模式  │            库模式 (require)            │
│  bdp <cmd>  │     const {pan, group} = require()    │
├─────────────┴───────────────────────────────────────┤
│                   bin/bdp.js                         │
│              (统一命令解析 + 路由)                    │
├──────────────────┬──────────────────────────────────┤
│    lib/pan.js    │         lib/group.js             │
│   全盘文件操作    │   群聊文件浏览 + 下载             │
├──────────────────┼──────────────────────────────────┤
│  BaiduPCS-Go     │  lib/http.js (curl / browser)    │
│  (BDUSS 认证)    │     mbox API (逆向)              │
│  locate → dlink  │     /mbox/group/listshare        │
│  upload/download │     /mbox/msg/shareinfo          │
│                  │     /api/sharedownload → dlink   │
├──────────────────┴──────────────────────────────────┤
│              百度网盘 CDN / API                      │
└─────────────────────────────────────────────────────┘
```

### 免下载读取原理

```
bdp cat /文档/报告.txt
    │
    ├── BaiduPCS-Go locate /文档/报告.txt
    │       → 获取 CDN 直链 dlink (有效期 8h)
    │
    ├── curl -r 0-1048575 <dlink>
    │       → HTTP Range 请求，只读取前 1MB
    │       → 百度 CDN 返回 206 Partial Content
    │
    └── stdout 输出文件内容
            → Agent 直接读取，无需下载整个文件
```

### 群聊 API 链路（逆向 `/mbox/`）

```
bdp groups                          bdp gshares <gid>
    │                                   │
    ├── /mbox/group/list                ├── /mbox/group/listshare
    │   → 获取全部群组 (gid)             │   → 获取分享库 (msg_id + from_uk + fs_id)
    │                                   │       └ has_more=1 时按 last_msg_time 游标翻页
    └───────────────────────────────────┘
                ↓
        bdp gls <gid> <fs_id>       bdp gsearch <gid> "关键词"
                │                        │
                ├── /mbox/msg/shareinfo  ├── 全量遍历: shareinfo 自动翻页 (每页上限 100)
                │   → 浏览文件/子目录     │   → 目录级并发扫描 + 磁盘缓存
                ↓                        ↓
            文件列表 (名称/大小/类型/fs_id)    匹配结果
```

**逆向实测结论（2026-08）**：

- 群聊文件**没有服务端搜索接口**（`listshare`/`shareinfo` 的 `key`/`keyword` 参数被忽略，`/api/search` 不支持群维度）——网页端搜索同样是客户端遍历，`gsearch` 走的是同一条路。
- `shareinfo` 每页**硬上限 100 条**（`num>100` 不返回更多），`page` 翻页可用 → `gsearch`/`gtree` 自动全页遍历，不再漏数据。
- 高频调用会触发限流，表现为 `errno=-3`、**self-echo**（`errno=0` 但返回目录自身）、或空列表；工具自动退避重试、连续限流停止扫描，重跑命令即续扫（`--max-requests` 可控制单命令请求预算，默认 400）。
- 群文件路径可能含**非法百分号编码**（裸 `%`），直接 `decodeURIComponent` 会抛 `URIError` 报废整个目录 → 已改为安全解码。
- `gsearch`/`gtree`/`gshares` 默认启用**磁盘会话缓存**（目录 30min / 分享 5min，`~/.bdp/cache/`，`--no-cache` 关闭、`bdp cache clear` 清理）——重复搜索秒回，深扫续扫收敛。

## 📁 项目结构

```
baiduwangpan-cli/
├── package.json              # npm 配置 (bin: bdp，唯一入口)
├── bin/
│   └── bdp.js                # CLI 入口 (统一命令解析 + 命令注册表)
├── lib/
│   ├── index.js              # 库导出
│   ├── config.js             # 配置管理 (~/.bdp/config.json，含多账号 profile)
│   ├── http.js               # 网页 API 双传输 (curl / browser)
│   ├── browser-login.js      # 浏览器登录、持久 profile 与 CDP 请求
│   ├── pan.js                # 网盘操作 (BaiduPCS-Go 桥接 + 直链分块下载)
│   ├── group.js              # 群聊操作 (逆向 mbox API)
│   ├── pcs-extra.js          # 引擎扩展命令 (mv/cp/quota/offline/share)
│   ├── name-match.js         # 文件名匹配 (glob/正则/AND/OR)
│   └── console.js            # Windows 控制台编码兜底 (chcp 65001)
├── test/                     # Node.js 回归测试
├── skills/
│   └── baiduwangpan/         # Agent Skill 源文件 (SKILL.md + reference + scripts)
└── baiduwangpan-skill.zip    # Agent Skill 打包 (Releases 附件)
```

> **唯一入口**：`bdp` 命令（`bin/bdp.js`）。历史原型 `bdp.py` / `bdp.js` / `bdp-group.js` 已删除（git 历史可查），避免多入口行为不一致。Agent 不确定命令用法时用 `bdp help <命令> --json` 查询。

## 🤖 Agent Skill 使用

本仓库附带一个标准格式的 Agent Skill，让 Claude Code / Codex / OpenClaw / Cursor 等 Agent 通过自然语言操作百度网盘。

### 安装 Skill

从 [Releases](https://github.com/NkAntony777/baiduwangpan-cli/releases) 下载 `baiduwangpan-skill.zip`，或直接复制仓库 `skills/baiduwangpan/` 文件夹：

```bash
# 各平台 skills 目录
~/.claude/skills/            # Claude Code
~/.codex/skills/             # Codex CLI
~/.config/opencode/skills/   # OpenCode
# 或对应 Agent 的 skills 目录
```

### Skill 使用

Agent 加载 skill 后，自然语言即可驱动（skill 会自动触发）：

```
用户: 看看我网盘里有什么
用户: 在群里找倪海厦的资料
用户: 读一下 /文档/data.csv 前几行
用户: 搜索网盘里所有报告文件
```

skill 会自动执行 `bdp` 命令并返回结构化结果（含 `--json` 输出）。

### Skill 内容

```
skills/baiduwangpan/
├── SKILL.md                      # 技能定义（触发规则 + 命令规范 + 安全边界）
├── reference/
│   ├── commands.md               # 完整命令参考
│   ├── authentication.md         # 凭证获取与配置
│   ├── examples.md               # Agent 使用示例 + JSON 输出格式
│   └── troubleshooting.md        # 故障排查
└── scripts/
    ├── setup.sh                  # macOS/Linux 自动安装
    └── setup.ps1                 # Windows 自动安装
```

## ⚠️ 注意事项

- **BDUSS 有效期**：Cookie 会过期，失效后重新执行 `bdp login`
- **下载限速**：非 SVIP 用户下载受百度限速策略限制
- **cat 限制**：为防止误读超大文件，`cat` 默认限制 1MB，可通过 `BDP_MAX_CAT_BYTES` 环境变量调整
- **群聊文件**：群聊 API 为逆向获取，可能随百度服务端变更而失效
- **share list**：BaiduPCS-Go v4.0.1 的 `share list` 有引擎 bug（panic），CLI 会提示替代方案；`share set/cancel` 正常
- **PowerShell 中文乱码**：CLI 启动时自动 `chcp 65001`（仅 TTY 且非 UTF-8 代码页时），中文正常显示；管道/重定向场景无副作用
- **1.1.0 升级**：若引擎丢失（postinstall 网络失败），CLI 会自动发现 `BaiduPCS-Go-v*` 版本子目录中的二进制；config 里失效的绝对 `pcsPath` 也会自动回退到自动发现，无需手改配置

## 🤝 致谢

- [BaiduPCS-Go](https://github.com/qjfoidnh/BaiduPCS-Go) — 强大的百度网盘 Go 客户端，本工具的底层引擎
- [hustuhao/bdntoy](https://github.com/hustuhao/bdntoy) — mbox API 逆向参考
- 所有百度网盘逆向工程社区的贡献者

## 📄 License

[MIT](LICENSE)
