# bdp — 百度网盘 CLI

全盘读写 + 免下载读取文件内容 + 群聊文件浏览，专为 Agent 调用设计。

## 安装

```bash
# 在项目目录下全局安装
npm link

# 验证
bdp --help
```

## 认证配置

```bash
# 保存凭证到 ~/.bdp/config.json
bdp login --bduss <你的BDUSS> --stoken <你的STOKEN>

# 检查状态
bdp whoami
```

获取 BDUSS/STOKEN：浏览器登录 `pan.baidu.com` → F12 → Application → Cookies。

## 命令一览

### 网盘文件操作（全盘）

| 命令 | 说明 | 示例 |
|------|------|------|
| `ls [path]` | 列出目录 | `bdp ls /` |
| `search <keyword>` | 搜索文件名 | `bdp search "报告"` |
| `cat <path>` | **免下载读取内容** | `bdp cat /文档/data.json` |
| `head [-n N] <path>` | 读取前 N 行 | `bdp head -n 50 /文档/log.txt` |
| `tail [-n N] <path>` | 读取后 N 行 | `bdp tail -n 30 /文档/log.txt` |
| `grep <pattern> <path>` | 搜索文件内容 | `bdp grep "错误" /文档/log.txt` |
| `peek <path>` | 预览文件信息 | `bdp peek /文档/report.pdf` |
| `get <path> [-o dir]` | 下载文件 | `bdp get /文档/file.zip` |
| `put <local> <remote>` | 上传文件 | `bdp put ./file.txt /文档/` |
| `mkdir <path>` | 创建目录 | `bdp mkdir /新目录` |
| `rm <path>` | 删除文件 | `bdp rm /临时文件.txt` |

### 群聊文件操作

| 命令 | 说明 | 示例 |
|------|------|------|
| `groups` | 列出所有群组 | `bdp groups` |
| `gshares <gid>` | 群内分享库 | `bdp gshares 539478953581833690` |
| `gls <gid> <fs_id>` | 浏览分享库 | `bdp gls 539478953581833690 742474845517885` |
| `gsearch <gid> <keyword>` | 搜索群文件 | `bdp gsearch 539478953581833690 "倪海厦"` |

### Agent 友好选项

所有命令支持 `--json` 输出：

```bash
bdp groups --json
bdp gls 539478953581833690 742474845517885 --json
bdp head -n 10 /文档/data.csv --json
```

## 项目结构

```
bdp/
├── package.json              npm 包配置（bin: bdp）
├── bin/
│   └── bdp.js                CLI 入口（统一命令解析）
├── lib/
│   ├── index.js              库导出（可 require/import）
│   ├── config.js             配置管理（~/.bdp/config.json）
│   ├── http.js               HTTP 客户端（curl 封装 + bdstoken）
│   ├── pan.js                网盘操作（BaiduPCS-Go 桥接 + 免下载读取）
│   └── group.js              群聊操作（逆向 mbox API）
├── BaiduPCS-Go.exe           底层引擎
└── README.md
```

## 技术原理

### 免下载读取
```
BaiduPCS-Go locate <path> → CDN 直链 (dlink)
curl -r 0-N <dlink>       → HTTP Range 只读 N 字节
stdout                    → Agent 直接读取
```

### 群聊 API 链路（逆向 `/mbox/`）
```
/mbox/group/list     → 群组列表 (gid)
/mbox/group/listshare → 分享库 (msg_id + from_uk + fs_id)
/mbox/msg/shareinfo   → 文件/目录详情（分页 + 递归）
```

## 作为库使用

```javascript
const { pan, group, config } = require('bdp');

// 读取文件
const content = pan.cat('/文档/data.json');

// 搜索群文件
const results = await group.searchFiles('539478953581833690', '倪海厦');
```
