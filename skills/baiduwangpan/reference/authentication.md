# 认证配置

## 前置条件

1. 已安装 Node.js 14+
2. 已安装 `baiduwangpan-cli`（含自动下载的 BaiduPCS-Go 引擎）
3. 有百度网盘账号
4. 本机装有 Chrome 或 Edge 浏览器（用于自动登录，推荐）

## 方式一：浏览器自动登录（推荐，无需 F12）

```bash
bdp login
```

流程完全自动化：

1. 自动启动 Chrome/Edge（独立临时配置，不影响你正在使用的浏览器）
2. 自动打开百度网盘登录页
3. **你用手机百度网盘 App 扫码**（或输入账号密码）
4. Agent 自动检测到凭证 → 保存到 `~/.bdp/config.json`
5. 自动同步登录 BaiduPCS-Go 引擎
6. 浏览器自动关闭，临时文件自动清理

> 无需按 F12、无需找 cookie、无需复制粘贴。全程只需扫码一步。

验证：

```bash
bdp whoami
# Status: ✅ Logged in
```

## 方式二：手动获取凭证（无 Chrome 时）

### 获取 BDUSS 和 STOKEN

1. 浏览器打开 [pan.baidu.com](https://pan.baidu.com) 并登录
2. 按 `F12` 打开开发者工具 → **Application**（应用）标签
3. 左侧 **Cookies** → 点击 `https://pan.baidu.com`
4. 找到并复制：
   - **BDUSS** 的 Value
   - **STOKEN** 的 Value

> ⚠️ 注意：
> - STOKEN 必须在百度网盘页面获取（不是百度首页）
> - STOKEN 值中应包含大写字母，否则可能拿错
> - BDUSS 有效期有限，失效后需重新获取

### 配置凭证

```bash
bdp login --bduss <你的BDUSS> --stoken <你的STOKEN>
```

验证：

```bash
bdp whoami
# Status: ✅ Logged in
```

配置保存在 `~/.bdp/config.json`：

```json
{
  "bduss": "...",
  "stoken": "..."
}
```

## 凭证安全

- ⚠️ **Agent 禁止**：输出、打印、回显、日志记录配置文件中的 BDUSS/STOKEN 完整值
- ⚠️ **Agent 禁止**：将凭证提交到 git 仓库或粘贴到对话中
- 需要确认登录状态时，使用 `bdp whoami --json`（只输出 `***set***` 掩码）

## 凭证失效处理

Cookie 过期后（通常数月），运行任意命令会报错或返回空数据。处理方式：

```bash
bdp whoami
# 若显示异常，引导用户重新获取 BDUSS/STOKEN 并执行：
bdp login --bduss <新值> --stoken <新值>
```

## 环境变量方式（可选）

不想写配置文件时可用环境变量：

```bash
# Linux/macOS
export BDP_BDUSS="..."
export BDP_STOKEN="..."

# Windows PowerShell
$env:BDP_BDUSS = "..."
$env:BDP_STOKEN = "..."
```
