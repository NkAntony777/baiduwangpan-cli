# Agent 使用示例

以下示例展示 AI Agent 如何用自然语言任务映射到 `bdp` 命令。

## 场景 1：查看网盘里有什么

用户：**"看看我网盘里都有什么"**

```bash
bdp ls / --json
```

输出包含目录和文件列表，Agent 将其整理为自然语言回复。

## 场景 2：全盘搜索文件

用户：**"帮我找一下网盘里所有和中医有关的文件"**

```bash
bdp search "中医" --json
```

## 场景 3：读取文件内容（免下载）

用户：**"读一下网盘里 /文档/data.csv 的前几行"**

```bash
bdp head -n 10 /文档/data.csv --json
```

用户：**"看看 /文档/配置.json 里写了什么"**

```bash
bdp cat /文档/配置.json
```

## 场景 4：在文件内容中搜索关键词

用户：**"在 /文档/日志.txt 里找一下 ERROR"**

```bash
bdp grep "ERROR" /文档/日志.txt -n --json
```

## 场景 5：预览文件信息

用户：**"网盘里这个 /学校/毕业设计/xxx.pdf 是什么文件"**

```bash
bdp peek /学校/毕业设计/xxx.pdf --json
```

## 场景 6：下载文件

用户：**"帮我把网盘里的 /文档/file.zip 下载到 ./downloads"**

```bash
bdp get /文档/file.zip -o ./downloads
```

## 场景 7：群聊文件浏览（完整流程）

用户：**"看看我在百度网盘群聊里有没有倪海厦的资料"**

```bash
# 第一步：列出群组，找到目标群
bdp groups --json
# → [{"gid":"539478953581833690","name":"国学文化SVIP13",...}]

# 第二步：在该群内搜索
bdp gsearch 539478953581833690 "倪海厦" --json
# → [{"name":"N 倪海厦","path":"/全店svip200位大师课(共16T)/N 倪海厦",...}]

# 第三步（可选）：浏览该目录的内容
bdp gls 539478953581833690 292608024165826 --json
```

## 场景 8：群聊文件深度搜索

用户：**"在'国学文化SVIP13'群里找紫微斗数的资料"**

```bash
bdp groups --json                                   # 找 gid
bdp gshares 539478953581833690 --json               # 看分享库
bdp gls 539478953581833690 742474845517885 --json   # 浏览目录
bdp gsearch 539478953581833690 "紫微" --json        # 关键词搜索
```

## 场景 9：群聊深度搜索防超时丢结果

用户：**"在群里深搜玄空飞星，超时了也要把已找到的留给我"**

```bash
bdp gsearch <gid> "玄空飞星" --depth 3 --timeout 85 --save-partial --json-file result.json
# 超时后：控制台提示 "💾 部分结果已保存: result.json"，文件内含已搜到的 results
# （结果对象: saved:"partial", partial:true, timedOut:true, stoppedReason:"timeout", scannedShares/totalShares...）
```

## 场景 10：多关键词收窄 / 放宽搜索

用户：**"搜"玄空"命中太多了，只要同时含"飞星"的"**

```bash
bdp gsearch <gid> "玄空 飞星" --json            # 默认 AND：同时含"玄空"+"飞星"（可换序）
bdp gsearch <gid> "玄空 飞星" --any-word --json # OR：含"玄空"或"飞星"（更宽）
bdp gsearch <gid> "玄空飞星资料" --exact --json # 文件名精确匹配（忽略路径前缀）
```

## 输出解析约定

`--json` 输出结构：

**ls / search**（经 BaiduPCS-Go）：
```json
{ "keyword": "...", "path": "...", "raw": "表格文本" }
```

**head / tail**：
```json
{ "path": "...", "lines": 10, "content": ["行1", "行2", ...] }
```

**groups**：
```json
[ { "gid": "539478953581833690", "name": "国学文化SVIP13", "gnum": "...", "description": "..." } ]
```

**gshares**：
```json
[ { "msgId": "...", "fromUk": 2642611875, "fromUser": "道**智者", "name": "/全店svip200位大师课(共16T)", "fsId": "742474845517885", "isDir": true } ]
```

**gls**：
```json
{ "files": [ { "name": "N 倪海厦", "path": "/.../N 倪海厦", "isDir": true, "size": 0, "fsId": "292608024165826", "category": 6 } ], "hasMore": false, "page": 1 }
```

**gsearch**：
```json
[ { "name": "N 倪海厦", "path": "/.../N 倪海厦", "isDir": true, "size": 0, "fsId": "292608024165826", "group": "539478953581833690" } ]
```

**peek**：
```json
{ "path": "...", "size": 12345, "isDir": false, "type": "text", "dlink": true, "preview": ["行1", ...] }
```
> 注意：`size` 可能为 `null`（未获取到），目录文件的 `type` 可能缺省。

**grep**：
```json
[ { "line": 12, "content": "匹配到的行内容" } ]
```
> 行号参数 `-n` 与 `-N` 等价（都显示行号）。

**cat**：
```json
{ "path": "...", "content": "文件内容文本" }
```

**whoami**：
```json
{ "loggedIn": true, "bduss": "***set***", "stoken": "***set***", "pcsPath": "...", "configFile": "..." }
```

**错误输出**（所有命令）：
```json
{ "error": "错误消息文本" }
```
> 出现 `{"error":...}` 时退出码为 1，参考 reference/troubleshooting.md 处理。
