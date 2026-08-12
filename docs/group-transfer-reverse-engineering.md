# 群聊文件转存/下载 — 逆向工程笔记（2026-08-12）

> 目标：解决 bdp 1.1.3 无法下载群聊文件的问题（群文件 → 转存到自己的网盘 → bdp get）。
> **最终结论（2026-08-12 晚）：转存已被百度拒绝，但发现 `/api/sharedownload` 可直接下载群文件（免转存），已实现为 `bdp gdownload`。**
> 本文档记录接口逆向的完整结论，含已验证与未验证部分。

## 一、已验证可用的 API（浏览类）

| 功能 | 方法 | URL | 参数 |
|---|---|---|---|
| 群列表 | GET | `/mbox/group/list` | `clienttype=0&app_id=250528&web=1&bdstoken` |
| 群分享库 | POST | `/mbox/group/listshare` | body: `type=2&gid=G&limit=50&desc=1`；翻页 `last_msg_time=<msg_ctime>` |
| 浏览目录 | POST | `/mbox/msg/shareinfo` | query: `type=2&from_uk=X&msg_id=Y&to_uk=0&num=100&page=N&fs_id=Z&gid=G`；num 上限 100 |
| 批量转存(按消息) | POST | `/mbox/batchtransfer/commit` | body: `msg_ids=["msgid"]&type=2&gid=G&path=/x` → `task_id` |
| 批量转存状态 | GET | `/mbox/batchtransfer/status` | `task_id=X&type=1` → `{success,failed,total,records:[{msg_id,status}]}` |
| 转存任务查询 | GET | `/share/taskquery` | `taskid=X` → `{status:pending/running/success, progress, task_errno}` |

**关键数据结构（listshare 响应 msg_list[]）**：
```
msg_id    string  消息 ID（转存/下载的核心键）
uk        number  分享者 uk（from_uk 的来源）
file_list[] 顶层分享文件（fs_id 为字符串）
  fs_id         string  分享快照文件 ID
  isdir         "1"/"0"
  privacy       "0"|"1"|"2"|"3"  （分享可见性/保存权限相关）
  extent_int3   number  群文件归属 uk（=分享者 uk 时通常可浏览）
  owner_id      number  文件实际所有者
```

## 二、转存接口 `/mbox/msg/transfer`（已逆向，但实测被拒）

```
POST https://pan.baidu.com/mbox/msg/transfer?clienttype=0&app_id=250528&web=1&bdstoken=xxx
body: from_uk=X&msg_id=Y&path=/目标路径&ondup=newcopy&async=1&type=2&gid=G&fs_ids=["fsid1"]
```

- `fs_ids` 是 JSON 数组字符串（分享快照 fs_id，**必须来自 listshare**；shareinfo 返回的子文件 fs_id 单独传不识别，跟在目录 fs_id 后面可识别但无意义）
- 语义：**转存整个分享库**（传顶层目录 fs_id → 服务端统计该目录全部文件数）
- 响应 `target_file_nums=N`：服务端匹配到的文件数
- **实测结论（2026-08-12，SVIP 账号）**：
  - 所有非空目录分享（几百 ~ 几十万文件）→ `{"errno":-10,"target_file_nums":N}`（**被拒绝**）
  - 空目录 → `{"errno":0,"task_id":...}` 但 taskquery 返回 `errno=114`（任务无效）
  - 单文件分享 → `target_file_nums:0`（不识别）
  - 与文件数（900/2300/44103）、目录大小（130GB）、网盘空间（剩 3.7TB）、会员（SVIP）均无关
  - 页面上下文 fetch（浏览器真实 cookie/referer）同样 -10
  - **用户 2025-03-09 曾成功转存过**（网盘 /我的资源/紫微斗数更新等多个文件），现在同类分享全部 -10 → **判定百度已下线/限制群文件转存**

## 三、✅ 直接下载方案（已实现为 `bdp gdownload`）— `/api/sharedownload`

```
POST https://pan.baidu.com/api/sharedownload?sign=&timestamp=&clienttype=0&app_id=250528&web=1&bdstoken=xxx
body: uk=<分享者uk>&product=mbox&encrypt=0&primaryid=<msg_id>&fid_list=["<fs_id>"]&extra={"type":"group","gid":"<gid>"}
```
- **sign/timestamp 留空即可**（新版 IM 前端实际使用的下载链路，`getDlinkMbox → ajaxGetDlinkShare`）
- 响应 `list[0].dlink` = **明文直链**（https://d.pcs.baidu.com/file/...，8h 有效），可直接 curl 下载
- 实测：shareinfo 子文件 fs_id ✓、单文件分享 fs_id ✓（自动解析来源，无需显式参数）
- **目录 fs_id ✗**（返回的 dlink 是无效串 `&clienttype=0`）→ 需先用 gls/gsearch 找到具体文件
- **下载时 UA 必须用浏览器 UA**（netdisk 客户端 UA 返回 118 字节错误页）
- 校验：下载字节数与 `size` 字段一致才算成功

## 四、直接下载接口（需要页面签名，已废弃/不可用）

### `/mbox/msg/download`（新版旧链路）
```
POST /mbox/msg/download?clienttype=0&app_id=250528&web=1&bdstoken=xxx
body: from_uk=X&msg_id=Y&fs_ids=[...]&type=2&gid=G&sign=SIGN&timestamp=TS[&zip=1]
```
- `sign` 取 `yunData.PAGESIGN`、`timestamp` 取 `yunData.PAGETIMESTAMP`（页面级签名）
- 新版页面（disk/main）已不注入 yunData；旧版 mbox 页面已下线重定向 → **无法获得 PAGESIGN**
- 无 sign/错误 sign → `errno=112/113`

### `/mbox/mpage/download`（旧版预览页）
```
GET /mbox/mpage/download?from_uk=X&msg_id=Y&fs_ids=["fsid"]&sign=SIGN&timestamp=TS
```
- sign/timestamp 来自 FileUtils（旧版 mbox 文件预览上下文），同样无法获得

## 五、shareinfo 返回的 dlink（加密，无需解密）

```
"dlink":"U2tyufKRM4ZbmoxP/ygY3HKUVdIIOb+ShnqZKjX5GQg4UMKoI3yOgxInPMWshNQSQBeq68W98GKnPODn1zYxaySne74DTbiJzbsysrl3RW0kxgR+wHki3CLGjCNxQ0NDPfM7f7uyerHszHEdaOJUuI9zqIlDya4ekq5ksW6W3L6qmR9s26QbEjWcHW5L6YXoo9ki+FgJbDD+u8qOnqcJK/nQRj7pPIS8a5deRZoe6TeiEbXZ3xqsgdwBIpPfhSfHCeva68awa7KcXVTH2dZUhL2/h1yr8b6DMjfcqEWhPOd6MY0TFU+Min/NPXcKawadFZUUyTTV5Ynq3DSot2Jn0D4YHEzAheCIODYIewgvOyIL5dptx0zBQte0vnqUeKxphEBmf+riu7EEDqw1WgA8H6TU+Ss278f5u+WwiDFspptGilBhXml2Cks02F29kWYI5Xn3sAgcRZypg/9+bK93ogKpXHgAtFp9JI8wJdJrNFNOBm90L/6LP6FZ+ShWG03mPOYU9YOCX5PUJa8k0dlWtY4Lg3qg"
```
- AES 类密文（base64）——**无需解密**：`/api/sharedownload`（第三节）返回的是明文 dlink；该字段仅供旧版预览/特定客户端使用。BaiduPCS-Go 源码确认其**从不解密 dlink**（走 Android locatedownload 明文接口，作者在 issue #353 明确拒绝群文件支持）

## 六、其它发现

- 新版群聊页面（`pan.baidu.com/disk/main#/im/session?from=mbox`）文件库抽屉**没有"保存/转存"按钮**（hover/选中均无）——UI 层面已移除入口
- 消息拉取：`POST /imbox/msg/pull`，body `pulltype=1&sids=["04_<gid>"]&needprofile=1&identity=0&new_share_notice=1&showlink=true&showtransfer=0`（分享文件消息不出现在响应中）
- 文件库抽屉数据源就是 `/mbox/group/listshare`
- 旧版 `GET /mbox/mpage/shareinfo`、`GET /mbox/mpage/transfer`（参数 object_array/fsid_array/session_id/founder_uk）→ 实测 `errno=2131`（参数未完全逆向）
- 群信息：`POST /mbox/group/getinfo`，body `gid=G` → records[0].uk = **群主 uk**、gnum = 群号
- BaiduPCS-Go `transfer` 命令只支持分享链接（`https://pan.baidu.com/s/...`），不支持 mbox 群文件转存

## 七、结论

1. **群文件转存（/mbox/msg/transfer）已被百度拒绝**（errno=-10 全局生效，UI 入口移除）——不可作为下载路径
2. **群文件直接下载可行**：`/api/sharedownload`（sign 留空）→ 明文 dlink → curl 下载（已实现 `bdp gdownload`）
3. dlink 加密字段无需解密；BaiduPCS-Go 无解密能力且不支持群文件
