---
name: baiduwangpan
description: 百度网盘 CLI 操作技能 — 基于 baiduwangpan-cli (bdp) 命令，支持全盘文件浏览/搜索/免下载读取内容/上传下载/群聊文件浏览。当用户要求查看、搜索、读取、上传、下载百度网盘文件，或浏览百度网盘群聊文件时使用。
version: 1.0.0
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

## Recommended Entry Point

命令不确定或执行报错时，先运行 `bdp --help` 查看全部可用命令与参数（离线、无网络请求），再对照 reference/commands.md 重试。所有命令支持 `--json` 输出；失败时输出 `{"error":"..."}`（见 reference/troubleshooting.md 的错误表格）。

## 安装

```bash
npm install -g baiduwangpan-cli
```

安装时自动下载 BaiduPCS-Go 引擎（含 GitHub 镜像加速）。之后配置凭证：

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
bdp gshares <gid>                  # 列出群内分享库（拿 fs_id）
bdp gls <gid> <fs_id> [--page N]   # 浏览分享库内容
bdp gsearch <gid> <keyword>        # 搜索群文件名
```

### 通用选项

```bash
--json   # 结构化 JSON 输出（Agent 首选）
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
3. `bdp gls <gid> <fsId> --json` → 浏览子目录/文件
4. `bdp gsearch <gid> <keyword> --json` → 按名称搜索

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
