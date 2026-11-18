# 个人版共享文件夹：实现及接口记录

关联 [Issue #3](https://github.com/NkAntony777/baiduwangpan-cli/issues/3)。本 Draft 已包含 `lib/shared-folder.js`、`bdp shared` 及隔离测试，不再只是接口设计。

## 产品范围

实现普通文件夹右键菜单的 **“共享”**，以及 **“共享给我的文件夹”**。它使用个人版 `/sharedir` 接口。

`/ostp/sharedspace` 团队空间、普通 `pan.baidu.com/s/...` 分享链接、群消息文件是不同产品，本实现不混用它们的接口。

成员通过邀请链接加入共享目录，拥有者可以查看成员和移除成员。本轮发现的个人版界面没有独立只读/编辑角色设置，因此没有虚构角色参数。生成邀请链接不等于对方已经加入，CLI 不主动向好友发送消息。

## 当前前端证据（2026-11-09）

- [个人版主页面 home.bf6b3fad.js](https://nd-static.bdstatic.com/m-static/v20-main/home/js/home.bf6b3fad.js)：右键“共享”对应 `enjoyTogether-plugin`；`/enjoytogether` 是接收目录入口。
- [共享设置组件 chunk-300cc7c4.af10f74a.js](https://nd-static.bdstatic.com/m-static/v20-main/home/js/chunk-300cc7c4.af10f74a.js)：模块 `8c84` 定义创建、邀请、成员和取消共享 API，调用点给出字段。
- [上传 SDK chunk-vendors.3b5ab759.js](https://nd-static.bdstatic.com/m-static/v20-main/home/js/chunk-vendors.3b5ab759.js)：普通网盘预创建、分块上传、提交，以及虚拟共享路径的处理。

这些是当前前端实现证据，非承诺稳定的官方开放 API；后续前端版本可能调整。

## 接口

通用查询参数：`channel=chunlei`、`clienttype=0`、`web=1`、`app_id=250528`、当前登录态的 `bdstoken`。POST 使用表单编码，认证复用已有 `http.webJson` / 浏览器会话。

| 操作 | 方法及路径 | 关键参数 |
| --- | --- | --- |
| 获取目录身份 | GET `/api/filemetas` | `target=[完整路径]` |
| 设置共享 | POST `/sharedir/create` | `fid`、`invite_link=1`、`overlay=0` |
| 接收的共享目录 | GET `/sharedir/list` | `method=receive`、`start`、`limit=100` |
| 查看共享内容 | GET `/api/list` | `dir` 保留完整共享路径，`page`、`num=100` |
| 成员列表 | POST `/sharedir/member/list` | `uk`、`fid`、`start`、`limit=50` |
| 获取邀请链接 | POST `/sharedir/invite/link` | `uk`、`fid` |
| 移除成员 | GET `/sharedir/member/del` | `fid`、`delete_uk`、`delete_files=0` |
| 取消共享 | POST `/sharedir/cancel` | `fid` |
| 上传预创建 | POST `/api/precreate` | `path`、`target_path`、`autoinit=1`、`block_list` |
| 上传分块 | POST 百度 PCS `/rest/2.0/pcs/superfile2` | `path`、`uploadid`、`uploadsign`、`partseq`，表单文件字段 `file` |
| 提交文件 | POST `/api/create?isdir=0` | `path`、`target_path`、`size`、`uploadid`、`block_list`、`ondup=newcopy` |
| 获取下载直链 | GET `/api/filemetas` | `target=[完整路径]`、`dlink=1` |

创建共享遇到 `18201`（目录下已有子共享）时返回错误，不自动使用 `overlay=1` 取消子共享。

## 路径和权限

- 接收方路径的根形式是 `/<share>拥有者UK-根目录FID`，两个部分都保留字符串。
- 拥有者必须使用自己的真实路径。真实验收中，拥有者用自己的接收方虚拟路径读取目录得到 `errno=141`。
- 普通真实路径必须先用成员接口证明其属于已共享目录；接收方虚拟路径原样发送，不改写到个人根目录。
- 子目录处理保持共享身份，拒绝 `..`、控制字符和模糊 ID。服务端权限错误直接上报。
- 移除成员保留文件，不能通过 `remove` 删除自己；取消整份共享使用独立的 `cancel`。

## 首版边界

- CLI：`shared create/list/ls/members/invite/remove/cancel/put/get`。普通目录由已有 `bdp mkdir` 创建。
- 共享状态、成员操作及上传都需显式确认；dry-run 不联网，下载 dry-run 也不落盘。
- 上传/下载只支持单文件且最大 32MiB，这是当前实现的内存边界，不是百度产品额度声明。4MiB 分块，失败或 MD5 不符不提交文件；下载字节数不符不保存文件。
- 不默认覆盖同名远端或本地文件；没有目录递归、断点续传、自动接受邀请、IM 邀请或 MCP 工具。

## 验证状态

- 隔离测试覆盖请求字段、共享路径身份、确认与 dry-run、成员移除保留文件、失败传播、分块校验和本地覆盖保护。
- 实际 CLI 已使用登录会话读到接收的共享目录，并能读取其内容列表。
- 专用自有临时目录已完成：普通目录创建 → 设置共享 → 成员列表 → 邀请链接 → 上传文本 → 下载并逐字节比对 → 取消共享 → 删除测试目录。
- 不把自有共享目录的上传验收记作跨账号上传。接收方上传和移除实际成员仍需独立验证；在此之前 PR 保持 Draft。

真实账号的 Cookie、BDUSS、STOKEN、邀请链接和个人目录身份不存入仓库或测试 fixture。
