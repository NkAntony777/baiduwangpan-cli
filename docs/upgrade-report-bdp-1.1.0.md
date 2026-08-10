# bdp 1.1.0 升级报告（实测 + 已修复）

> 生成日期：2026-08-10 · 适用版本：`baiduwangpan-cli@1.1.0`
> 用途：升级回归实测结论 + 反馈工程师的 Issue 素材。所有"严重/中等"问题均已在仓库内修复（见文末"修复状态"）。

---

## ✅ 新功能（实测）

- **会话级缓存（`bdp cache`）**
  - `gsearch` 缓存命中秒回（70/73 目录命中），第二次同查询基本瞬间返回
- **`--max-pages` / `--max-requests` 防限流**（默认 50 页 / 400 请求预算）
- **`--no-cache`**：调试 / 强制重扫用；`bdp cache clear` 手动清缓存
- **元数据增强**：`cachedDirs: 70, throttledShares: 0, budgetUsed: 0, failedDirs: []` 等实时诊断信息

---

## ⚠️ 新发现的问题（要反馈工程师）

### 🔴 严重：1.1.0 升级会丢失 pcsPath 配置

- **复现**：`npm install -g baiduwangpan-cli@1.1.0` 后 `bdp search` 报错
  `BaiduPCS-Go not found at: BaiduPCS-Go`
- **根因**：1.0.x 的 `config.json` 里有 `pcsPath: "E:\...\BaiduPCS-Go.exe"`（绝对路径），
  但 1.1.0 的 `bdp config` 显示 `pcsPath: "BaiduPCS-Go"`（默认值，无路径），
  导致 `search/cat/get/grep` 等需要 BaiduPCS-Go 引擎的命令全部失败
- **修复方式（已采用）**：手动编辑 `C:/Users/Anthony/.bdp/config.json` 加上
  `"pcsPath": "E:\\npm-global\\node_modules\\baiduwangpan-cli\\BaiduPCS-Go-v4.0.1-windows-x64\\BaiduPCS-Go.exe"`
- **建议**：
  1. 升级时保留 `pcsPath`
  2. 或自动从旧版 fallback
  3. 或 postinstall 把 BaiduPCS-Go 放在固定路径（不带版本号的子目录）而不是版本子目录

### 🔴 严重：postinstall 在中国大陆网络下大概率失败

- **复现**：`node scripts/postinstall.js` 时 5 个镜像全失败
  - GitHub: `getaddrinfo ENOTFOUND release-assets.githubusercontent.com`（DNS 污染）
  - 其他 4 个 ghproxy/ghfast 镜像应该 fallback，但实际显示只跑了 1 行就抛出
- **根因**：postinstall 脚本的 `downloadWithMirrors` 异常处理有问题，
  第一个失败后没继续走 fallback
- **影响**：升级 1.1.0 后 `BaiduPCS-Go.exe` 直接消失，需要手动从镜像下载
- **建议**：
  1. 修 postinstall 异常处理，确保 5 个镜像顺序 fallback
  2. 检测到国内网络时优先用 ghfast/ghproxy，GitHub 放最后
  3. postinstall 失败时给出更明确的下载指引

### 🟡 中等：gsearch 大 result set + 分页 page 3+ 仍可能超时

- **复现**：`gsearch "玄空" --depth 3 --page 3` 90s 超时无返回
- **复现**：`gsearch "玄空飞星" --depth 3` 冷启 90s 超时（缓存帮不了精确文件名匹配）
- **建议**：
  1. 默认 `complete: true` 但实际未完整时改成 `complete: false, partial: true`
  2. 超时前主动写入已经拿到的部分到 `--json-file`
  3. 支持 `--all-results` 模式（不限时，但慢）

### ✅ 已知且已用缓存加速：gsearch depth 3 冷启

- 第一次跑 `gsearch "玄空" --depth 3` 在 SVIP 群 73 个 share 里全量扫描所有文件
- 第二次同查询秒回（缓存命中 257/261 dirs）
- 已验证 OK

---

## 升级前后对比

| 项目 | 1.0.x | 1.1.0 |
| --- | --- | --- |
| `gsearch "飞星"` SVIP 群 | 120s 超时 | 首次 1min，缓存后秒回 |
| `gsearch "玄空"` d3 | 120s 超时 | 首次 1.5min，缓存后秒回 |
| `gsearch` 分页 page 3+ | 没测 | 仍可能超时（partial result 没回） |
| 升级后保留 `pcsPath` | ✅ | ❌（被覆盖） |
| BaiduPCS-Go 升级保留 | ✅ | ❌（需要重下） |

---


---

## 🆕 反馈 2（v1.1.2）：gsearch 加 --save-partial

- **场景**：搜索跑着跑着超时了，结果已写到 json-file 一半，但没机会看
- **期望**：超时/未完整时自动把已搜到的 result 写入 json-file
- **现状痛点**：只能靠手动看 `partial: true` 才知道有部分结果
- **已实现**：
  1. `--save-partial` 单独用时自动生成 `bdp-gsearch-<gid>-<kw>-partial-<时间戳>.json`（当前目录），
     扫描中持续写入部分结果，未完整（超时/限流/预算/失败）时写入最终 partial 快照并打印路径
  2. `--save-partial --json-file out.json` 时写 `out.json`（兼容原 `--json-file` 行为），
     未完整时打印 `💾 部分结果已保存: out.json`
  3. 保存内容含 `saved:"partial"` + `results`（已搜到的全部匹配）+ 扫描诊断
     （scannedShares/totalShares/failedShares/stoppedReason/timedOut 等），Agent 可直接读取续扫
  4. 搜索完整时自动清理自动生成的占位文件，不留下垃圾


---

## 🆕 反馈 3（v1.1.3）：gsearch 多关键词匹配控制（--any-word / --exact）

- **场景**：`gsearch "玄空"` 命中 52 个（短关键词子串匹配太宽），`gsearch "玄空飞星"` 只命中 2 个（长关键词太窄），相差 25 倍
- **已实现**：
  1. **空格分隔多关键词**：`gsearch "玄空 飞星"` 默认**全部命中**（AND，可换序）→ 只返回同时含"玄空"与"飞星"的名字，精确收窄
  2. **`--any-word`**：任一关键词命中即可（OR，更宽）
  3. **`--exact`**：按文件名精确匹配（忽略路径前缀，大小写不敏感）
  4. 单关键词行为不变（子串包含，兼容旧行为）

## 🔧 修复状态（本仓库已实现，建议随 v1.1.1 发布）

| 问题 | 修复 | 涉及文件 |
| --- | --- | --- |
| pcsPath 丢失 | `findPCS()` 自动发现版本子目录（`BaiduPCS-Go-v*/`）；config 里失效的绝对 `pcsPath` 自动回退到自动发现；`setAuth` 只替换认证字段、保留 `pcsPath` | `lib/config.js` |
| postinstall fallback 崩溃 | `download()` 补 file stream `error` 处理（不再"只跑 1 行就抛出"）；镜像顺序改为 ghfast/ghproxy 优先、GitHub 兜底；全部失败时打印每个源的完整下载地址；发现版本子目录二进制时提升到固定路径 | `scripts/postinstall.js` |
| gsearch 超时无返回 | `complete`/`partial` 语义修正（提前截断不再误报 `complete:true`，新增 `stoppedReason`）；`--timeout N` 到点返回部分结果（`complete:false, partial:true, timedOut:true`）；`--json-file` 扫描中持续写部分结果（`onProgress`）；`--all-results` 作为 `--all` 别名 | `lib/group.js`、`bin/bdp.js` |
| 文档 | README 同步 `--all-results`/`--timeout`/`--save-partial`/升级说明；新增本报告 | `README.md`、`docs/upgrade-report-bdp-1.1.0.md` |
| gsearch 部分结果难获取 | 新增 `--save-partial`：未完整时自动落盘已搜到的结果（自动路径或 `--json-file`）并打印路径 | `lib/partial.js`、`bin/bdp.js` |
| gsearch 关键词宽窄不可控 | 空格分隔多关键词默认 AND；新增 `--any-word`（OR）、`--exact`（文件名精确匹配） | `lib/group.js`、`bin/bdp.js` |

**回归测试**：`npm test` 34/34 通过（新增 pcsPath 自动发现/回退、complete/partial 语义、timeout 部分结果、onProgress、`lib/partial.js`、多关键词 AND/OR/exact 用例）。
