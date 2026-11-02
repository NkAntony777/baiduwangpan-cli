# 故障排查

## 错误 JSON 输出（所有命令通用）

命令失败时输出 `{"error":"..."}` 并返回退出码 1。常见错误消息及处理：

| 错误消息 | 原因 | 处理 |
|---------|------|------|
| `Cannot get file size for: <path>` | 无法获取文件元信息 | 确认路径存在；重新登录（Cookie 可能过期） |
| `Cannot get dlink for: <path>` | 获取下载直链失败 | 重新 `bdp login`；检查网络 |
| `Cannot get bdstoken...` | 凭证失效 | 重新获取 BDUSS/STOKEN 并 `bdp login` |
| `API error: errno=...` | 群聊接口异常 | 百度 mbox 接口可能变更（逆向接口），等待工具更新 |
| `API error: errno=2131` | 群分享 `msg_id` 不属于该群（gid 与参数来自不同群/分享库） | 运行 `bdp gshares <gid>`（或 `bdp gsearch <gid> <关键词>`）取同一行的 fsId/fromUk/msgId 重试；或去掉 `--from-uk/--msg-id` 让 CLI 自动解析。工具会自动按 fsId 纠正错配参数（结果含 `autoResolved:true`） |
| `BaiduPCS-Go not found at: ...` | 引擎缺失 | 见下方"引擎未自动下载" |
| `文件是二进制内容（<type>，<reason>）` | 对 PDF/zip/图片/音视频执行 cat/head/tail/grep | 改用 `bdp get <path>` 下载到本地处理；或用 `bdp peek` 看元信息 |
| `删除是高危操作，需要显式确认` | 非交互环境执行 rm 未带 `--yes` | 加 `--yes`（或先用 `--dry-run` 预览）；非交互环境不会弹确认 |
| `文件或目录不存在`（errno=31066） | 路径不存在或已移动 | 用 `bdp ls /` 确认路径 |
| `索引为空，请先运行: bdp index build` | `bdp ask` 前没建索引 | 先跑 `bdp index build <path>` |
| `未提取到文本层（可能是扫描件/图片型 PDF）` | PDF 是图片型，无文本层 | 用 `bdp get` 下载后本地 OCR |
| `PDF 已加密，无法提取文本` | PDF 有加密 | 下载后用本地工具解密 |
| `未找到 ZIP 中央目录` | 不是 ZIP 或已损坏 | 用 `bdp peek` 确认类型 |
| `文件已存在`（errno=31061） | mkdir 目标已存在 | 这是幂等成功，`--json` 返回 `exists:true`，无需处理 |

## bdp 命令不存在

```bash
npm install -g baiduwangpan-cli
```

安装后如果仍找不到命令，检查 npm 全局 bin 目录是否在 PATH 中：

```bash
npm config get prefix
# Windows 示例: E:\npm-global → 确认 E:\npm-global 在 PATH 中
```

## 未登录 / whoami 显示 Not logged in

```bash
bdp login --bduss <BDUSS值> --stoken <STOKEN值>
bdp whoami
```

## 运行命令报 "Cannot get bdstoken"

原因：BDUSS/STOKEN 失效或配置未生效。

处理：
1. `bdp whoami --json` 检查 `loggedIn` 和 `bduss`/`stoken` 状态
2. 重新获取 Cookie 并 `bdp login`
3. 确认系统时间正确（bdstoken 依赖时间戳）

## 搜索/读取返回空或乱码

- **乱码**：Windows PowerShell 控制台编码问题（chcp 65001 可临时解决）。功能不受影响，`--json` 输出正常
- **空结果**：确认路径存在（`bdp ls /` 先确认），或关键词包含特殊字符需要引号包裹
- **v1.7.0 起**：`cat`/`head`/`tail`/`grep` 会自动识别 UTF-8 / GBK / Big5 编码，
  中文古籍（GB2312/GBK）不再乱码，`grep` 也能正确命中。
  用 `bdp peek <path> --json` 看 `encoding` 字段确认实际编码。
  若某文件仍显示异常，可先用 `bdp get` 下载到本地用专业工具处理

## cat/head 报 "Cannot get dlink"

原因：BaiduPCS-Go 登录态失效（BDUSS 过期）或文件过大。

处理：
1. 重新登录 BaiduPCS-Go：`bdp login` 或手动执行 `BaiduPCS-Go.exe login -bduss=... -stoken=...`
2. 检查网络（dlink 获取需要访问 pan.baidu.com）
3. 超 1MB 的文件用 `head`/`tail` 分段读

## 群聊命令报错

- **"Cannot get bdstoken"**：见上，Cookie 失效
- **群文件为空**：该群可能没有分享库，或分享被群主撤回
- **`errno=2131`（msg_id 不属于该群）**：gid 与 `--from-uk/--msg-id/--parent-fs-id` 必须同源。用 `bdp error 2131` 查看详细说明；最常见原因是把别的群的参数抄到了当前 gid 上
- **"API error"**：百度 mbox 接口可能变更（逆向接口），关注项目更新

## 下载/上传失败

- 检查磁盘空间
- 非 SVIP 账号受百度限速策略影响，速度慢是正常的
- 大文件上传/下载失败可重试

## 引擎未自动下载

postinstall 会尝试多个 GitHub 镜像下载 BaiduPCS-Go，若全部失败：

1. 手动从 https://github.com/qjfoidnh/BaiduPCS-Go/releases 下载对应平台的 zip
2. 解压后将 `BaiduPCS-Go`（或 `BaiduPCS-Go.exe`）放到 npm 全局 node_modules 下的 `baiduwangpan-cli` 包目录中（用 `npm config get prefix` 查看全局目录）
3. 或者设置环境变量 `BAIDUPCS_CMD` 指向二进制路径
4. 或者确保 `BaiduPCS-Go` 在系统 PATH 中

> v1.1.1+ 会自动发现包目录内版本子目录（如 `BaiduPCS-Go-v4.0.1-windows-x64/BaiduPCS-Go.exe`）中的二进制；config 里失效的绝对 `pcsPath` 会自动回退到自动发现，无需手改 `~/.bdp/config.json`

## 命令失败但退出码是 0？（v1.7.0 已修复）

v1.6.x 及更早版本里，`ls`/`get`/`put` 在失败时**仍返回退出码 0**，
其中 `get` 会把"下载失败"伪装成"下载完成 0 字节"。v1.7.0 起统一修复：

- 引擎输出中的错误信号（"遇到错误, 远端服务器返回错误, 代码: N"）会被解析并抛错
- 失败一律以退出码 1 结束，`--json` 输出带 `{"error": "...", "errno": N}`
- `get` 额外检测"引擎返回 0 字节但远端应有大小"的情况

**Agent 请务必检查退出码，不要只看 stdout 内容。**

## du 的 size 比 quota 小很多？

`bdp du` 靠递归 `/api/list` 求和（百度没有服务端目录大小接口），
默认只扫 3 层，更深的子树不计入 → size 偏小。

- `--json` 里 `partial: true` 表示结果因深度封顶而不完整
- 深度上限 8，`depthCapped` 字段告知是否被钳制
- **实际占用以 `bdp quota` 为准**
- 加大 `--depth` 可提升精度（全盘深扫很慢，建议只对目标目录深扫）

## 其他

遇到未覆盖的问题：

- 查看 `bdp --help`
- 提交 Issue: https://github.com/NkAntony777/baiduwangpan-cli/issues
