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

```bash
bdp login --bduss <你的BDUSS> --stoken <你的STOKEN>
bdp whoami  # 验证
```

<details>
<summary>📋 如何获取 BDUSS 和 STOKEN</summary>

1. 浏览器打开 [pan.baidu.com](https://pan.baidu.com) 并登录
2. 按 `F12` → **Application** → **Cookies** → `https://pan.baidu.com`
3. 找到 **BDUSS** 和 **STOKEN** 的值，复制

> ⚠️ STOKEN 必须在百度网盘页面获取（不是百度首页），值中应包含大写字母。

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
│  BaiduPCS-Go     │     lib/http.js (curl)           │
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
    │                                   │
    └───────────────────────────────────┘
                ↓
        bdp gls <gid> <fs_id>
                │
                ├── /mbox/msg/shareinfo
                │   → 浏览文件/子目录 (分页)
                │   → 递归遍历目录树
                ↓
            文件列表 (名称/大小/类型/fs_id)
```

## 📁 项目结构

```
baiduwangpan-cli/
├── package.json              # npm 配置 (bin: bdp)
├── bin/
│   └── bdp.js                # CLI 入口 (统一命令解析)
├── lib/
│   ├── index.js              # 库导出
│   ├── config.js             # 配置管理 (~/.bdp/config.json)
│   ├── http.js               # HTTP 客户端 (curl 封装)
│   ├── pan.js                # 网盘操作 (BaiduPCS-Go 桥接)
│   └── group.js              # 群聊操作 (逆向 mbox API)
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
