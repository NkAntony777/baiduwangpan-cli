# RFC：多人协作文件夹与受授权共享目录上传

状态：Draft / 接口发现阶段。关联 [Issue #3](https://github.com/NkAntony777/baiduwangpan-cli/issues/3)。

本文提出能力边界和实现步骤，**不是已实现的功能说明**。当前不新增可执行的创建、邀请或共享目录上传命令；下文命令和数据结构均为待讨论的接口草案。

## 需求

账号 A 创建一个可协作的目录，向账号 B 授予读写权限。B 在自己的登录态下，向 A 的该目录上传文件；双方能看到相同的目录内容。只读成员不能写入，撤销成员授权后不能继续写入。

这与以下现有行为不同：

- `mkdir + share set`：创建自己的普通目录，再生成访问链接；不授予目录协作写权限。
- `put`：调用 BaiduPCS-Go `u`，目标路径属于引擎当前账号，不能用他人的目录路径代表跨账号写入。
- 群分享消息：可以浏览、搜索和下载消息中的文件；“向群里发送自己的新文件分享”与“修改他人的既有目录”是不同能力。
- `transfer`：把分享内容保存到自己的网盘，不对原共享目录执行写入。

## 现有证据及其边界

| 能力 | 代码或资料 | 当前可推出的结论 |
| --- | --- | --- |
| 普通目录创建、个人上传 | `lib/pan.js` 的 `mkdir` / `upload` | 仅证实个人网盘路径操作 |
| 普通链接分享管理 | `lib/pcs-extra.js` 的 `shareSet` | 没有成员邀请或共享目录写权限参数 |
| 群列表和分享浏览 | `lib/group.js` 的 `listGroups` / `listShares` / `listFiles` | 可复用已有的读取逻辑；ID 需保留为字符串 |
| 群文件下载 | `lib/group.js` 的 `getShareDlink`，`product=mbox` | 依赖登录态、消息及群上下文；不能据此推导上传接口 |
| 群文件转存 | [历史逆向笔记](../group-transfer-reverse-engineering.md)、[下载结论](../group-download-final-verdict.md) | 仓库记录了 2026-08 的拒绝结果，不能当作新协作写入的实现依据；也不代表所有协作功能均不可用 |
| 官方 MCP 上传和分享能力 | [baidu-netdisk/mcp](https://github.com/baidu-netdisk/mcp) 的 `file_upload_stdio` / `file_sharelink_set` | 证实个人网盘上传和分享，未提供本文所需的成员授权与跨账号目录写入契约 |

尚缺少经验证的：协作目录创建接口、成员邀请/撤销接口、权限查询接口、跨账号目录上传接口，以及相应响应和错误码。本文不猜测这些接口的路径或请求参数。

## 产品及后端范围

先由维护者确认首个后端：个人版协作目录、个人版群共享，或企业版团队空间。每种后端分别声明能力；不能通过账号类型或 URL 猜测它们可以互换。

建议的能力集合：`listSpaces`、`listEntries`、`download`、`createFolder`、`listMembers`、`inviteMember`、`revokeMember`、`upload`。某个能力只有在相应接口及权限校验被验证后才开放。没有协作写接口时，不回退为向自己的网盘上传再分享。

## 目标寻址草案

个人路径 `/文档/资料` 不足以表示共享目录。共享目标必须绑定其所属空间和目录标识；后端所需字段以真实接口为准。可讨论的描述方式：

```json
{
  "backend": "personal-collaboration",
  "spaceId": "opaque-string-id",
  "directoryId": "opaque-string-id",
  "ownerUk": "opaque-string-id"
}
```

- 所有远端 ID 保留字符串，避免超过 JavaScript 安全整数范围后错选对象。
- 路径若作为输入，必须相对于已明确选定的共享空间解析，不能落入当前账号的个人根目录。
- 不使用本地缓存的“可写”标记代替服务端鉴权；撤销权限后必须识别服务端拒绝。
- 不通过普通公开分享链接推断邀请、上传或删除权限。

## CLI / MCP 草案

以下为讨论语法，当前不可执行：

```text
bdp collab list
bdp collab create <name> --dry-run
bdp collab create <name> --yes
bdp collab members <space-id>
bdp collab invite <space-id> <member-id> --role editor --yes
bdp collab revoke <space-id> <member-id> --yes
bdp collab ls <space-id> <directory-id>
bdp collab put <local> <space-id> <directory-id> --dry-run
bdp collab put <local> <space-id> <directory-id> --yes
bdp collab get <space-id> <file-id> -o <local-dir>
```

MCP 再根据已实现的能力注册工具，不先发布只会报未实现的工具 schema。写操作的库入口要求布尔 `confirm: true`；CLI 使用现有确认交互与 `--yes`。CLI 与 MCP 共享同一套参数、权限及错误处理逻辑。

dry-run 只说明将执行的动作、目标空间和成员，不创建目录、邀请成员或上传文件。若未查询服务端权限，输出明确标记为未核验，不承诺写入一定成功。

## 实现步骤

1. **取得现行接口证据**：在可用于测试的账号中分别观察创建、邀请、撤销、只读访问、上传的正常前端请求，保存去除凭证的请求结构与最小响应。确认是否确为同一目录协作，而非群消息快照。
2. **独立后端模块**：在 `lib/` 中实现已经确认的接口，复用现有异步 HTTP 传输和超时策略。上传若分阶段，记录创建、分块、提交各阶段的失败和重试边界。
3. **隔离测试**：使用来自真实请求结构的脱敏 fixture，覆盖鉴权、目标身份、成员权限、错误响应、超时和中断；不依赖开发者的个人网盘配置。
4. **CLI 入口**：只注册已可用的命令，提供 JSON 信封和结构化目标标识；同步命令帮助、README、Skill 文档及 ZIP。
5. **双账号验收**：完成下面的条件后，才把 PR 标记为可供合并；MCP 入口可按维护者意见同批或后续接入。

## 双账号验收条件

- A 创建协作目录，响应可再次读取到稳定的空间/目录标识。
- B 加入后能在自己的登录态下读取同一目录。
- A 授予 B 写权限，B 上传小文件；A 能读取到该文件，内容与本地一致。
- 只读成员的上传被服务端拒绝，CLI 非零退出，JSON 不出现成功标记。
- A 撤销 B 后，B 的后续写入失败；旧缓存不能继续授权。
- 同名文件不被默认覆盖；目录不存在、文件过大、权限不足均有可区分的错误。
- dry-run、参数错误和未确认操作不产生目录、邀请、上传或个人网盘的回退文件。
- 会话续接、超时及失败输出不泄漏 Cookie、BDUSS、STOKEN、OAuth token 或调试会话地址。

## 需要维护者确认

- 本项目优先覆盖哪一种协作后端？是否已有可复用的请求记录或实现分支？
- 是否先交付创建/成员权限，再另一个 PR 交付上传下载？
- CLI 命令组、目标 ID 表达和默认同名策略是否合适？

当前阻塞是缺少已验证的写入接口及双账号验收证据，不能用现有个人上传或群下载接口替代。取得这些证据后，可按上述步骤在本 Draft 上继续实现。
