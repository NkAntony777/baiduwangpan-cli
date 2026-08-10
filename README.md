<div align="center">

# baiduwangpan-cli

**百度网盘 CLI — 全盘读写 · 免下载读取 · 群聊文件浏览**

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
- **👥 群聊文件浏览** — 逆向 mbox API，列出群组、浏览群内分享库、搜索群文件
- **🤖 Agent 友好** — 所有命令支持 `--json` 结构化输出，零解析成本
- **🔧 双模式** — 既是 CLI 工具，也可作为 Node.js 库 `require()` 使用
- **🔐 凭证安全** — 配置存储在 `~/.bdp/config.json`，不写入代码或日志

## 📌 能力一览

| 能力 | 命令 | 说明 |
|:-----|:------|:-----|
| 列目录 | `bdp ls /` | 全盘任意目录 |
| 搜索文件名 | `bdp search "报告"` | 递归全盘搜索 |
| **读取文件内容** | `bdp cat /文档/data.json` | 免下载，限 1MB |
| **读取前 N 行** | `bdp head -n 50 /文档/log.txt` | 免下载 |
| **读取后 N 行** | `bdp tail -n 30 /文档/log.txt` | 免下载 |
| **搜索文件内容** | `bdp grep "关键词" /文档/file.txt` | 免下载 |
| 预览文件 | `bdp peek /文档/report.pdf` | 类型检测 + 前 10 行 |
| 下载 | `bdp get /文档/file.zip` | 保存到本地 |
| 上传 | `bdp put ./file.txt /文档/` | 全盘任意位置 |
| **列出群组** | `bdp groups` | 所有群聊 + gid |
| **群内分享库** | `bdp gshares <gid>` | 顶层分享目录 |
| **浏览群文件** | `bdp gls <gid> <fs_id>` | 分页 + 递归 |
| **搜索群文件** | `bdp gsearch <gid> "关键词"` | 按文件名搜索 |

## 🚀 快速开始

### 1. 安装

```bash
npm install -g baiduwangpan-cli
```

安装时会**自动下载** BaiduPCS-Go 引擎（支持 GitHub 镜像加速，国内也能装）。也支持手动克隆：

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
bdp gsearch 539478953581833690 "倪海厦"
```

## 📖 完整命令参考

### 网盘文件操作

```
bdp ls [path]                    列出目录
bdp search <keyword> [-p dir]    搜索文件名
bdp cat <path>                   读取文件内容 (免下载, 限 1MB)
bdp head [-n N] <path>           读取前 N 行 (默认 20)
bdp tail [-n N] <path>           读取后 N 行 (默认 20)
bdp grep <pattern> <path>        搜索文件内容
bdp peek <path>                  预览文件信息 + 前 10 行
bdp get <path> [-o dir]          下载文件
bdp put <local> <remote>         上传文件
bdp mkdir <path>                 创建目录
bdp rm <path>                    删除文件/目录
```

### 群聊文件操作

```
bdp groups                       列出所有群组
bdp gshares <gid>                列出群内分享库
bdp gls <gid> <fs_id> [--page N] 浏览分享库内容
bdp gsearch <gid> <keyword>      搜索群文件名
```

### 通用选项

```
--json                           JSON 结构化输出 (Agent 友好)
-n <N>                           行数 (head/tail, 默认 20)
-p <path>                        搜索路径 (search, 默认 /)
-i                               忽略大小写 (grep)
-N                               显示行号 (cat/grep)
-o <dir>                         输出目录 (get)
--page <N>                       页码 (gls)
```

## 🤖 Agent 集成示例

所有命令支持 `--json` 输出，适合 AI Agent 直接调用和解析：

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
│   全盘文件操作    │        群聊文件浏览               │
├──────────────────┼──────────────────────────────────┤
│  BaiduPCS-Go     │  lib/http.js (curl / browser)    │
│  (BDUSS 认证)    │     mbox API (逆向)              │
│  locate → dlink  │     /mbox/group/listshare        │
│  upload/download │     /mbox/msg/shareinfo          │
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
- 高频调用会触发限流，表现为 `errno=-3`、**self-echo**（`errno=0` 但返回目录自身）、或空列表；工具自动退避重试、连续限流停止扫描，重跑命令即续扫。
- 群文件路径可能含**非法百分号编码**（裸 `%`），直接 `decodeURIComponent` 会抛 `URIError` 报废整个目录 → 已改为安全解码。
- `gsearch`/`gtree`/`gshares` 默认启用**磁盘会话缓存**（目录 30min / 分享 5min，`~/.bdp/cache/`，`--no-cache` 关闭、`bdp cache clear` 清理）——重复搜索秒回，深扫续扫收敛。

## 📁 项目结构

```
baiduwangpan-cli/
├── package.json              # npm 配置 (bin: bdp)
├── bin/
│   └── bdp.js                # CLI 入口 (统一命令解析)
├── lib/
│   ├── index.js              # 库导出
│   ├── config.js             # 配置管理 (~/.bdp/config.json)
│   ├── http.js               # 网页 API 双传输 (curl / browser)
│   ├── browser-login.js      # 浏览器登录、持久 profile 与 CDP 请求
│   ├── pan.js                # 网盘操作 (BaiduPCS-Go 桥接)
│   └── group.js              # 群聊操作 (逆向 mbox API)
├── test/                     # Node.js 回归测试
├── skills/
│   └── baiduwangpan/         # Agent Skill 源文件 (SKILL.md + reference + scripts)
├── baiduwangpan-skill.zip    # Agent Skill 打包 (Releases 附件)
├── bdp.js                    # 早期独立版 (保留参考)
├── bdp-group.js              # 早期独立版 (保留参考)
└── bdp.py                    # Python 版 (备用)
```

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

## 🤝 致谢

- [BaiduPCS-Go](https://github.com/qjfoidnh/BaiduPCS-Go) — 强大的百度网盘 Go 客户端，本工具的底层引擎
- [hustuhao/bdntoy](https://github.com/hustuhao/bdntoy) — mbox API 逆向参考
- 所有百度网盘逆向工程社区的贡献者

## 📄 License

[MIT](LICENSE)
