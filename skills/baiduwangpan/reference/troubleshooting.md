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

## 其他

遇到未覆盖的问题：

- 查看 `bdp --help`
- 提交 Issue: https://github.com/NkAntony777/baiduwangpan-cli/issues
