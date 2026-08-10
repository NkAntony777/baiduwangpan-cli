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
bdp gshares <gid>
```

返回群内所有分享库（顶层目录）：名称、fs_id、分享者、msg_id。

```bash
bdp gshares 539478953581833690
bdp gshares 539478953581833690 --json
```

### gls — 浏览分享库内容

```
bdp gls <gid> <fs_id> [--page <N>]
```

- 浏览分享库内的文件和子目录
- 超过 100 项用 `--page` 翻页

```bash
bdp gls 539478953581833690 742474845517885
bdp gls 539478953581833690 742474845517885 --page 2 --json
```

### gsearch — 搜索群文件名

```
bdp gsearch <gid> <keyword>
```

- 搜索顶层分享库 + 第一层子目录的文件名

```bash
bdp gsearch 539478953581833690 "倪海厦"
bdp gsearch 539478953581833690 "古籍" --json
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
