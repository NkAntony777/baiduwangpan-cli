# baiduwangpan — 百度网盘 Agent Skill

基于 [baiduwangpan-cli](https://www.npmjs.com/package/baiduwangpan-cli) 的 AI Agent 技能包，让 Agent 通过自然语言操作百度网盘：浏览、搜索、免下载读取文件内容、上传下载、群聊文件浏览。

## 兼容平台

- Claude Code / Claude Desktop
- Codex CLI
- Cursor / Windsurf
- OpenClaw / DuClaw / KimiClaw
- Gemini CLI
- 任何支持 SKILL.md 格式的 Agent

## 安装

### 方式一：手动

1. 解压本 zip
2. 将 `baiduwangpan` 文件夹放入 Agent 的 skills 目录（如 `~/.claude/skills/`、`~/.codex/skills/` 或 `~/.config/opencode/skills/`）
3. 首次使用前运行安装脚本：

```bash
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

# macOS / Linux
bash scripts/setup.sh
```

### 方式二：自动安装

脚本会检测并自动完成：
- 安装 `baiduwangpan-cli`（npm 全局，含自动下载引擎）
- 检查登录状态

## 配置凭证

```bash
bdp login --bduss <BDUSS值> --stoken <STOKEN值>
bdp whoami
```

> BDUSS/STOKEN 获取方法见 `reference/authentication.md`

## 技能内容

```
baiduwangpan/
├── SKILL.md                      # 技能定义（触发规则 + 命令规范 + 安全边界）
├── scripts/
│   ├── setup.sh                  # macOS/Linux 安装脚本
│   └── setup.ps1                 # Windows 安装脚本
└── reference/
    ├── commands.md               # 完整命令参考
    ├── authentication.md         # 凭证获取与配置
    ├── examples.md               # Agent 使用示例 + JSON 输出格式
    └── troubleshooting.md        # 故障排查
```

## 功能一览

| 能力 | 命令 |
|------|------|
| 全盘浏览/搜索 | `bdp ls` / `bdp search` |
| 免下载读取内容 | `bdp cat` / `bdp head` / `bdp tail` / `bdp grep` |
| 上传/下载 | `bdp put` / `bdp get` |
| 群聊文件浏览 | `bdp groups` / `bdp gshares` / `bdp gls` / `bdp gsearch` |
| 结构化输出 | 所有命令支持 `--json` |

## 安全说明

- 凭证仅存于 `~/.bdp/config.json`，Agent 不得输出完整凭证
- 删除/覆盖等写操作需用户确认
- 项目主页: https://github.com/NkAntony777/baiduwangpan-cli
