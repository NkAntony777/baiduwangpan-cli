# 群聊文件下载 — 盖棺定论（2026-08-12 最终核实版）

> 本文档对全部可行路径做了**实测交叉验证**（4 个子代理调查 + 真实账号逐项实测），
> 给出群文件下载路线的最终结论。所有"✅/❌"均为 2026-08-12 实测结果（SVIP 账号，10TB 空间）。

## 一、最终路线图

| 路径 | 状态 | 实测证据 |
|:--|:--|:--|
| **单文件直接下载**（≤ ~20MB） | ✅ **可用** | `POST /api/sharedownload?sign=&timestamp=`（product=mbox，sign 留空）→ 明文 dlink → curl 下载；13.7MB PDF / 10.6MB APK 字节精确匹配 |
| **多文件 zip 打包下载**（同消息，总包 ≤ 上限） | ✅ **可用** | 同接口加 `type=batch` → 明文 zip 链接（`method=batchdownload&zipcontent={...}`）；3 个小 pdf 打包 10.4MB 完整下载 |
| 单文件 > ~20MB | ❌ 加密 | 返回动态加密 list（base64，每次不同），**前端无解密代码**，已知 key/算法全部失败 |
| zip 打包大文件（> ~100MB） | ❌ 包太大 | `error_code 31090 "package is too large"`（452MB 单文件即报错；10MB 包正常） |
| 转存 `/mbox/msg/transfer` | ❌ 已下线 | 非空目录一律 `errno=-10`（target_file_nums=N 但拒绝）；补 `logId=base64(BAIDUID)`+`channel=chunlei` 仍 -10；页面上下文 fetch 同样 -10；用户 2025-03 曾成功，2026-08 全部拒绝 |
| `/mbox/msg/download`（旧下载接口） | ❌ 需页面签名 | 依赖 `yunData.PAGESIGN`（旧 mbox 页面服务端注入，页面已下线重定向），无法获取 |
| `/mbox/mpage/download`（更旧） | ❌ 同上 | 依赖 FileUtils.sign/timestamp（旧页面注入全局） |
| shareinfo 加密 dlink 字段解密 | ❌ 不可行 | 密文 base64 解码后 408/387 字节**非 AES-CBC 块对齐**（非标准 AES 密文）；子代理恢复的 key/iv（`01hltm9JcnEfqy5t`/`Fsadviz5BSekw310`）实测解密失败 |
| 普通文件接口 `/api/download` | ❌ 不支持 | 群文件参数返回 `errno=2` |

**一句话结论**：群文件下载的**唯一可行路线** = `/api/sharedownload`（免转存）。
- 小文件（≤ ~20MB）→ 单文件直下（`bdp gdownload`）
- 同消息多文件 → zip 打包直下（`bdp gdownload <gid> <fs1> <fs2> ...`）
- **大文件（> ~100MB）网页端无解**——只能转存后下载（转存已下线）或使用官方 App/客户端

## 二、核实过程记录

### 2.1 子代理结论（4 路并行调查）

| 子代理 | 结论 | 核实结果 |
|:--|:--|:--|
| PAGESIGN 调查 | 新版 IM 前端实际用 `/api/sharedownload`（sign 留空）；PAGESIGN 无 API 获取途径 | ✅ 确认（小文件实测通过） |
| BaiduPCS-Go 调查 | 引擎无 dlink 解密（走 locatedownload 明文接口），无群文件支持（作者拒绝 issue #353）；网页 dlink 是明文直链 | ✅ 确认（与 sharedownload 结论互相印证） |
| 开源项目调查 | 转存参数需 `logId=base64(BAIDUID)`+`channel=chunlei`（DuPanSync 等）；dlink 解密 key/iv=`01hltm9JcnEfqy5t`/`Fsadviz5BSekw310`；sharedownload 小文件才有效（PeterDing issue #73） | ⚠️ 部分确认：logId 实测无效（-10 依旧）；key/iv 实测解密失败（见 2.3）；**"小文件才有效"→ 实为大文件返回加密串**（重大补充） |
| 网络搜索 | 失败（网络故障） | 无结论 |

### 2.2 关键交叉验证（子代理间矛盾点）

- **"dlink 需要 AES 解密" vs "dlink 是明文"**：两个子代理看不同 bundle。实测：`/api/sharedownload` 小文件返回明文 ✓、大文件返回加密串；`/mbox/msg/shareinfo` 的 dlink 字段始终是加密串（非 AES-CBC，解密失败）。**结论：下载链路（sharedownload）无需解密；加密 dlink 字段用途不明（可能仅供特定客户端），无法利用。**
- **"转存可用（加 logId）" vs "转存被禁"**：DuPanSync 等开源项目（2025 年前）成功过；**2026-08 实测加 logId 后依然 errno=-10** → 百度已下线群文件转存，旧资料不再适用。

### 2.3 大文件加密串解密尝试（全部失败）

- 加密 list：base64 解码 1616/1578/1641 字节（**非 16 块对齐** → 排除 AES-CBC/ECB）
- 尝试算法：AES-128-CBC/ECB/CTR/CFB/OFB（key/iv 多种组合）、AES-256、RC4 → 全部乱码/失败
- 前端（新版 IM chunk）：`dlinkService.ajaxGetDlinkShare` 直接使用响应，**无解密代码**（chunk 中无 decrypt/AES/CryptoJS）
- 结论：加密 key 属于服务端下发 + 前端特定模块（可能仅 App 端可解），网页端无法复现

### 2.4 zip 打包（type=batch）细节

- 请求：`/api/sharedownload` + `type=batch` + `fid_list=[...]`（同消息 fs_id）
- 响应：顶层 `dlink` = `https://www.baidupcs.com/rest/2.0/pcs/file?method=batchdownload&app_id=250528&zipcontent={"fs_id":[...]}&sign=...`（**明文**）
- 下载：需带 BDUSS/STOKEN cookie（curl 实测 200 + PK zip 头）
- 限制：单文件 452MB 报 `31090 package is too large`；13.7MB / 10.4MB 总包正常
- **注意**：zip 按 `primaryid`（msg_id）归组 → 一次只能打包同一条分享消息的文件

## 三、产品结论（对应 CLI 能力）

| CLI 命令 | 能力 | 限制 |
|:--|:--|:--|
| `bdp gdownload <gid> <fs_id>` | 单文件直下 | ≤ ~20MB（超限报加密响应 → 提示换 zip/App） |
| `bdp gdownload <gid> <fs1> <fs2> ...` | 同消息多文件 zip 打包 | 总包 ≤ ~100MB；fs_id 需同消息 |
| `bdp gls/gsearch/gtree` | 浏览/搜索（不受影响） | — |

**给用户的建议**：
1. 电子书/文档/小压缩包（绝大多数场景）→ `bdp gdownload` 直接下载 ✅
2. 视频课程等大文件（>100MB）→ 网页端无解：转存已下线、zip 超限、加密未破 → 用百度网盘官方客户端（App/PC）下载，或请分享者拆包后重新分享
3. 若未来百度开放转存或密钥泄露，`/mbox/msg/transfer` 参数与 `docs/group-transfer-reverse-engineering.md` 中的完整链路可立即复用

## 四、相关文件

- 实现：`lib/group.js`（getShareDlink / downloadFile / getShareZipDlink / downloadFiles）
- 命令：`bin/bdp.js`（gdownload，支持多 fs_id）
- 完整接口逆向笔记：`docs/group-transfer-reverse-engineering.md`
