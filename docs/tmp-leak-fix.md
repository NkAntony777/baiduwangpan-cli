# 测试临时目录泄漏修复（2026-11-24 首修 / 2026-11-25 扩族修）

> 触发：C 盘系统 TEMP 里 `bdp-pan-out-*` 曾累计 **887 个目录 / 7.383 GB**。
> 审计查明根因是**本仓自己的测试**留下的 —— 不是别人的垃圾。

> **2026-11-25 更新**：首修只堵了 `test/pan.test.js` **一个文件、2 个前缀**；
> 实际上全仓有 **34 个文件、46 个前缀**在往系统 TEMP 写且**一个都没清理**
> （原代码全量跑完一轮净增 **+16 个目录**）。扩族修的完整登记表、机制与实测数字见 **§8**。

## 1. 根因（实测，不重新排查）

| 项 | 事实 |
| --- | --- |
| 泄漏源 | `test/pan.test.js` → `tmpDir()`（16 个调用点）+ `TMP_CFG`（L11 配置目录） |
| 落点 | `%TEMP%\bdp-pan-out-*` / `bdp-pan-cfg-*`（**系统 TEMP = C 盘**） |
| 为什么一个都没清掉 | **压根没写清理逻辑** —— 不是「异常路径没走 finally」，是**没有 finally、没有 teardown、没有 rm** |
| 每个目录装了什么 | 一份 `报告.pdf` 下载夹具（部分用例是 40 MB 大文件夹具） |
| 每次全量泄漏多少 | **实测 16 个目录 / 125.8 MB**（15 个 `bdp-pan-out-*` + 1 个 `bdp-pan-cfg-*`） |
| 历史累计 | **887 个目录 / 7.383 GB** |

**为什么之前判成「第三方、不动」是错的**：

此前（玄学起盘 CLI `docs/034`、slatesync 的泄漏修复文档）都把 `bdp-pan-out-*` 记成
「npm 全局安装的第三方包留下的，不是本仓产物」—— 因为当时只看到
`%APPDATA%\npm\node_modules\baiduwangpan-cli\test\pan.test.js`。

**但那个路径其实是指向本仓的 Junction**（`npm ls -g` 输出
`baiduwangpan-cli@1.14.0 -> <源仓路径>`，
`fsutil reparsepoint query` 返回 Mount Point，两侧文件集 576=576、哈希差异 0）。
**源头就在本仓**，所以本轮把它堵掉了。

## 2. 修法（三条底线，缺一不可）

| # | 底线 | 落点 |
| --- | --- | --- |
| ① | **测试结束必删**（正常结束 / 断言失败 / 异常抛出 / 进程提前退出都要删） | `test/tmp-helper.js` 四道钩子 |
| ② | **临时工作目录不落系统盘 TEMP** | 项目内 `<repo>/.tmp/`（D 盘） |
| ③ | **进程启动时清扫超 N 小时旧残留 + append-only 对账台账** | `test/tmp-store.js::sweepStaleTempDirs()` |

### 2.1 ① 四道清理钩子（缺一条就漏一条路径）

| 钩子 | 覆盖的退出路径 | 实测退出码 |
| --- | --- | --- |
| `afterEach`（node:test 用例级） | 正常结束、**断言失败**、**异常抛出** | 探针 exit=1，残留 0 |
| `after`（文件级） | 整个测试文件跑完（含文件级共享夹具 `TMP_CFG`） | 全量跑完残留 0 |
| `process.on("exit")` | 未捕获异常、`process.exit()`、正常退出 | 探针 exit=3，残留 0 |
| `SIGINT` / `SIGTERM` / `SIGHUP` | Ctrl+C、任务被 kill、窗口关闭 | 探针 exit=**130 / 143 / 129**，残留 0 |

- **登记在册**：每个临时目录进 `live` 集合；删除失败（Windows EPERM/EBUSY）**不吞**，
  留在册上下一轮重试（`fs.rmSync` 带 `maxRetries:5`、`retryDelay:100`）。
- **作用域**：`scope:"test"`（用例级，由 `afterEach` 删）/ `scope:"file"`（文件级共享，由 `after` 删）。
  `TMP_CFG` 是 `scope:"file"` —— 它整个测试文件共用，被 `afterEach` 删会让后续用例拿不到配置。

### 2.2 ② 落到项目内 `.tmp/`（D 盘）——**根本修法**

即使清理失败也不会撑爆系统盘。目录前缀保持 `bdp-pan-out-` / `bdp-pan-cfg-` 不变
⇒ 计数、清扫、判废口径与历史一致，同一把尺子量「跑前 / 跑后 / 差值」。

### 2.3 ③ 启动清扫 + 台账

- `sweepStaleTempDirs()` 在**进程启动时**（`tmp-helper.js` 被 require 即执行）删掉超过
  **N 小时（默认 6h，`BDP_TMP_SWEEP_HOURS` 可调）** 的同类旧目录。
- 每删一个目录记一行进 `.tmp/sweep-ledger.jsonl`（**append-only**），最近一次摘要写
  `.tmp/sweep-last.json` ⇒ **可与并行清理任务对账**。
- **历史 C 盘那批默认不扫**：需显式开 `BDP_SWEEP_LEGACY_TEMP=1`。

## 3. Windows 上的一个实情（必须说清）

`process.kill(pid, "SIGINT")` 在 Windows 上是**无条件终止**（TerminateProcess，等价 SIGKILL），
JS 侧信号处理器根本不会被调用 —— 这不是本仓代码的问题，是平台行为。
真实 Ctrl+C 走 console control event，Node 会把它派发成 `process.on("SIGINT")`。
**不可捕获的强杀（kill -9 / TerminateProcess / 断电）留下的残留由启动清扫（6h）兜底**
—— 这正是底线③存在的理由；再加上不落系统 TEMP，最坏情况只是项目盘里留几个目录。

## 4. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `test/tmp-store.js` | **新增**：纯逻辑的临时目录存取层（登记在册、清理、清扫、台账），无 `node:test` 依赖 |
| `test/tmp-helper.js` | **新增**：四道钩子装配 + 进程启动清扫（被 require 即生效） |
| `test/pan.test.js` | `tmpDir()` 收口点改走 `makeTempDir("bdp-pan-out-")`（16 个调用点一次全覆盖）；`TMP_CFG` 改走 `makeTempDir("bdp-pan-cfg-", {scope:"file"})` |
| `.gitignore` | 加 `.tmp/`（临时工作目录根不入库） |
| `scripts/sync-global.ps1` | **新增**：源仓 → 全局副本的逐文件同步 + SHA256 自检 |
| `docs/tmp-leak-fix.md` | 本文件 |
| `README.md` | 加「源仓是唯一来源」段落 |

**未改动**：`lib/**`、`bin/**`、`scripts/postinstall.js`、`scripts/bench-concurrency.js`、任何产品逻辑；
**未删任何测试用例**；**未删任何文件**。

## 5. 源仓是唯一来源 → 全局副本即最新

本仓同时存在于两处：

| 位置 | 角色 |
| --- | --- |
| `<源仓路径>` | **源仓（唯一来源）** —— 所有改动落这里 |
| `%APPDATA%\npm\node_modules\baiduwangpan-cli` | npm 全局安装副本 |

**流程**：改源仓 → 跑一次同步脚本 → 全局副本即最新。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-global.ps1
```

- 脚本**字面量绝对路径**、可**重复运行**（幂等）、可**自检**（逐文件 SHA256 比对，
  不一致就**报告**而不是静默跳过）。加 `-CheckOnly` 只自检不复制。
- **不联网、不 `npm install` / `npm update`** —— 只做逐文件复制。
- **为什么需要它**：`npm update` / 重装会**覆盖**全局副本里的补丁；本轮以后
  任何修在源仓的改动都要靠这个脚本落到全局副本。
- 脚本同时兼容两种形态：全局副本是 **Junction/链接**（当前如此 ⇒ 同一份物理文件，
  逐文件哈希天然一致）时照常自检；是**实体目录**时走逐文件复制分支。

## 6. 验收数字（2026-11-24 现场实跑）

### 6.0 修前基线（泄漏被实测复现）

| 项 | 值 |
| --- | --- |
| 全量测试 | tests **520** · pass **514** · fail **0** · skipped **6** |
| C 盘系统 TEMP `bdp-pan-out-*` | **0 → 15（差值 +15）** |
| C 盘系统 TEMP `bdp-pan-cfg-*` | **0 → 1（差值 +1）** |
| 单次泄漏体积 | **125,839,120 字节（≈120 MB）** |

### 6.1 修后连跑 3 次全量测试（源仓）

| 轮次 | exit | tests | pass | fail | skipped | 用时 | C 盘 TEMP `out`/`cfg`（跑前→跑后） | 仓内 `.tmp/` `out`/`cfg`（跑前→跑后） | 差值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RUN 1 | 0 | 520 | 514 | 0 | 6 | 18.1 s | **0 → 0** | **0 → 0** | **0** |
| RUN 2 | 0 | 520 | 514 | 0 | 6 | 12.8 s | **0 → 0** | **0 → 0** | **0** |
| RUN 3 | 0 | 520 | 514 | 0 | 6 | 13.3 s | **0 → 0** | **0 → 0** | **0** |

- **差值 = 0**，两处落点（C 盘系统 TEMP、仓内 `.tmp/`）三轮都是 0 → 0。
- **用例数与修前基线逐项一致**：520 / 514 / 0 / 6 —— 没少用例、没少断言。
- **未靠「调小临时目录体积」糊弄**：下载夹具内容与改前完全一致，修的是「落点 + 清理」。
- 跑完 `.tmp/` 只剩 `sweep-last.json`（清扫摘要）+ `sweep-ledger.jsonl`（台账），均在 `.gitignore` 内。

### 6.2 四道钩子逐条实测

| 退出路径 | 探针 | 结果 |
| --- | --- | --- |
| 断言失败 | `assert.equal(1,2)` | ✅ 残留 0 |
| 异常抛出 | `throw new Error()` | ✅ 残留 0 |
| `process.exit(3)` | 显式退出 | ✅ exit=3，残留 0 |
| `SIGINT` / `SIGTERM` / `SIGHUP` | `process.emit(sig)` | ✅ exit=**130 / 143 / 129**（处理器真的跑了），残留 0 |

### 6.3 清扫 + 台账实测

造一个 mtime 为 8 小时前的 `bdp-pan-out-*` 与一个新鲜的同前缀目录，跑 `sweepStaleTempDirs()`：
`{"removed":1,"failed":0,"scanned":2,"fresh":1,"hours":6}` —— 超期的被删、新鲜的保留。
台账 `.tmp/sweep-ledger.jsonl` 追加一行：
`{"ts":"2026-11-24T13:57:16.743Z","path":"…\.tmp\bdp-pan-out-stale-probe","root":"…\.tmp","ageHours":8}`。

### 6.4 全局安装副本

| 项 | 结果 |
| --- | --- |
| 形态 | **Junction** → 指向源仓（`npm ls -g` 显示 `-> <源仓路径>`） |
| 文件集差异 | src 576 / dst 576，onlySrc **0** / onlyDst **0** |
| 哈希差异 | **0** 个文件不一致 |
| 副本内跑测 | `node --test <global>\test\pan.test.js` → tests 18 / pass 18 / fail 0，C 盘 TEMP 差值 **0** |


## 7. 残留与边界

- 本轮**没有改产品逻辑**，没有删文件，没有改写历史，没有 push。
- `.tmp/` 在 `.gitignore` 内，不入库、不占系统盘。
- **强杀兜底**：Windows 上 `process.kill` 走 TerminateProcess 时 JS 钩子不会跑（见 §3），
  这类残留由「启动清扫 6h」+「落仓内 `.tmp/`」两条兜住，不落系统盘。

## 8. 2026-11-25 扩族修：2 个前缀 → 46 个前缀

### 8.1 首修到底漏了什么（实测，不重新排查）

| 项 | 首修（2026-11-24）之后 | 实测证据 |
| --- | --- | --- |
| 收口文件 | **1 个**（`test/pan.test.js`） | 34 个建临时目录的文件里，只有它 `require("./tmp-helper")` |
| 收口前缀 | **2 个**（`bdp-pan-out-` / `bdp-pan-cfg-`） | 其余 **43 个前缀**仍在 `os.tmpdir()` 建目录 |
| 清理逻辑 | 只有那 1 个文件有 | 其余 33 个文件**压根没有删除逻辑** |
| 全量跑完的系统 TEMP 增量 | **+16 个目录 / 轮** | 原代码在主仓连跑两轮：27 → 43 → 59 |
| 单文件即可复现 | — | `node --test test/index-store.test.js` 21/21 通过，系统 TEMP **净增 11 个** `bdp-idx-*` |

⇒ 首修是对的，但**只堵了漏口的 1/34**。本节把它扩到整个前缀族。

### 8.2 前缀全族登记表（46 条，代码为准）

登记在册：`test/tmp-store.js` 的 `TMP_PREFIXES`（**唯一事实来源**）。
新增前缀必须同时改这里与本表，否则 `test/tmp-leak-guard.test.js` 闸门 ② 会红。

| 前缀 | 原落点文件 | 收口方式 |
| --- | --- | --- |
| `bdp-pan-out-` | `test/pan.test.js` | 首修已收（`makeTempDir`） |
| `bdp-pan-cfg-` | `test/pan.test.js` | 首修已收（`makeTempDir` · scope:file） |
| `bdp-ask-cfg-` | `test/index-health.test.js` | `makeTempDir` |
| `bdp-async-cfg-` | `test/async-engine.test.js` | `makeTempDir` · scope:file |
| `bdp-audit-bad-cfg-` | `test/audit-fixes.test.js` | `makeTempDir` |
| `bdp-audit-cfg-` | `test/audit-fixes.test.js` | `makeTempDir` · scope:file |
| `bdp-audit-cli-cfg-` | `test/audit-fixes.test.js` | `makeTempDir` |
| `bdp-audit-engine-` | `test/audit-fixes.test.js` | `makeTempDir` |
| `bdp-audit1113-` | `test/audit-v1113.test.js` | `makeTempDir` · scope:file |
| `bdp-audit1113-cfg-` | `test/audit-v1113.test.js` | `makeTempDir` |
| `bdp-bench-` | `scripts/bench-concurrency.js` | **产品/脚本侧** → `lib/scratch.js` |
| `bdp-browser-path-` | `test/browser-login.test.js` | `makeTempDir` |
| `bdp-cache-test-` | `test/group.test.js` | `makeTempDir` · scope:file |
| `bdp-closure-` | `test/runtime-closure.test.js` | `makeTempDir` · scope:file |
| `bdp-conc-cfg-` | `test/mcp-concurrency.test.js` | `makeTempDir` · scope:file |
| `bdp-concenv-cfg-` | `test/mcp-concurrency-env.test.js` | `makeTempDir` · scope:file |
| `bdp-config-test-` | `test/config.test.js` | `makeTempDir` · scope:file |
| `bdp-contract-` | `test/doc-contract.test.js` | `makeTempDir` · scope:file |
| `bdp-corr-cfg-` | `test/correctness-fixes.test.js` | `makeTempDir` · scope:file |
| `bdp-doctor-` | `test/rename-doctor.test.js` | `makeTempDir` |
| `bdp-dryrun-` | `test/pan-dryrun.test.js` | `makeTempDir` |
| `bdp-dryrun-cfg-` | `test/pan-dryrun.test.js` | `makeTempDir` · scope:file |
| `bdp-engine-ver-` | `test/share-transfer-engine-version.test.js` | `makeTempDir` · scope:file |
| `bdp-env-cfg-` | `test/envelope-errors.test.js` | `makeTempDir` · scope:file |
| `bdp-env-detail-` | `test/internal-detail.test.js` | `makeTempDir` · scope:file |
| `bdp-env-read-` | `test/envelope-read.test.js` | `makeTempDir` |
| `bdp-env-v192-` | `test/audit-v192.test.js` | `makeTempDir` · scope:file |
| `bdp-envfix-cfg-` | `test/envelope-fixes.test.js` | `makeTempDir` · scope:file |
| `bdp-fixes-cfg-` | `test/fixes.test.js` | `makeTempDir` · scope:file |
| `bdp-flag-guard-` | `test/cli-flag-guards.test.js` | `makeTempDir` |
| `bdp-idx-` | `test/index-store.test.js` | `makeTempDir`（3 个调用点） |
| `bdp-index-health-` | `test/index-health.test.js` | `makeTempDir` · scope:file |
| `bdp-mcp-args-` | `test/mcp-args.test.js` | `makeTempDir` · scope:file |
| `bdp-native-cfg-` | `test/native-transport.test.js` | `makeTempDir` · scope:file |
| `bdp-noprof-cfg-` | `test/envelope-fixes.test.js` | `makeTempDir` |
| `bdp-pcs-dir-` | `test/config.test.js` | `makeTempDir` |
| `bdp-pcsx-cfg-` | `test/pcs-extra.test.js` | `makeTempDir` · scope:file |
| `bdp-prof-guard-` | `test/audit-v192.test.js` | `makeTempDir` |
| `bdp-prof-only-` | `test/engine-timeout-guards.test.js` | `makeTempDir` |
| `bdp-redact-` | `test/redact-paths.test.js` | `makeTempDir` · scope:file |
| `bdp-rename-args-` | `test/rename-args.test.js` | `makeTempDir` · scope:file |
| `bdp-sec-cfg-` | `test/sec-fixes.test.js` | `makeTempDir` · scope:file |
| `bdp-share-transfer-` | `test/share-transfer.test.js` | `makeTempDir` · scope:file |
| `bdp-shared-test-` | `test/shared-folder.test.js` | `makeTempDir` |
| `bdp-shared-upload-` | `lib/shared-folder.js` | **产品侧** → `lib/scratch.js` |
| `bdp-tmp-` | `test/tmp-store.js` | `makeTempFile` 的默认前缀（已收） |

### 8.3 机制（四条，缺一不可）

| # | 机制 | 落点 |
| --- | --- | --- |
| ① | **落点统一**：仓内 `<repo>/.tmp/`（D 盘），产品代码与测试共用一个原语 | `lib/scratch.js`（产品/脚本侧）+ `test/tmp-store.js`（测试侧） |
| ② | **四道钩子全装配**：**51 个测试文件全部** `require("./tmp-helper")`（require 即装钩子） | `test/tmp-helper.js` |
| ③ | **前缀全族登记**：46 条前缀进 `TMP_PREFIXES`，清扫/计数/判废同一把尺子 | `test/tmp-store.js` |
| ④ | **启动清扫默认扫两处**：仓内 `.tmp/` + **系统 TEMP**（同前缀族、超 6h 的旧目录） | `sweepStaleTempDirs()` |

**为什么要有 `lib/scratch.js`**：`test/` **不进 npm 包**（`package.json` 的 `files`
只含 `bin/`、`lib/` 与两个脚本）⇒ 产品代码 `lib/shared-folder.js` 与开发脚本
`scripts/bench-concurrency.js` 不能 `require("../test/tmp-store")`。
落点解析只有一份：`BDP_SCRATCH_DIR` → `<包根>/.tmp/` → `~/.bdp/scratch/`（兜底），
**任何情况下都不落系统 TEMP**。

**清扫默认开关变了**：首修时「历史 C 盘那批默认不扫」（需显式 `BDP_SWEEP_LEGACY_TEMP=1`）；
现在**默认就扫**（`BDP_SWEEP_LEGACY_TEMP=0` 可关）——
只扫就等于「欠账不还」：老目录永远躺在 C 盘上。

### 8.4 防回归（不靠人肉记忆）

| 闸门 | 断言 | 位置 |
| --- | --- | --- |
| ① 静态 | 仓库里除白名单外**不许再出现 `os.tmpdir()`**（注释除外） | `test/tmp-leak-guard.test.js` |
| ② 前缀登记 | 每个 `bdp-*` 前缀都必须在 `TMP_PREFIXES` 里，且没有死条目 | 同上 |
| ③ 运行时 | 本进程跑下来，系统 TEMP 里**没有新增**任何 `bdp-*` 目录 | 同上 |
| ④ 仓内 | `.tmp/` 下没有**未登记前缀**的残留目录 | 同上 |
| ⑤ 端到端 | **全量跑完，系统 TEMP 的 `bdp-*` 计数增量 = 0**（跑前跑后各数一次） | `npm run test:tmp-leak`（`scripts/tmp-leak-check.js`） |

白名单只有 3 个文件，且都**只读**系统 TEMP：`test/tmp-store.js`（扫残留）、
`test/tmp-leak-guard.test.js`（数目录）、`scripts/tmp-leak-check.js`（跑前跑后各数一次）。

### 8.5 实测数字（2026-11-25）

| 口径 | 改前（原代码，主仓） | 改后（本工作树） |
| --- | --- | --- |
| 全量跑完，系统 TEMP `bdp-*` 增量 | **+16 / 轮**（27 → 43 → 59） | **0**（59 → 59，两轮 + 脚本端到端一轮） |
| 全量跑完，仓内 `.tmp/` 未登记残留 | — | **0** |
| 用例数 | 520 | **525**（+5 闸门） |
| pass / fail / skipped | 514 / 0 / 6 | **518 / 0 / 7** |
| 全量耗时 | — | 15.3 s |

端到端脚本的输出（`npm run test:tmp-leak`）：

```
[1/5] 启动清扫：扫 59 个同族目录，删掉超期残留 0 个（失败 0，新鲜保留 59），阈值 6h
[2/5] 跑前：系统 TEMP 的 bdp-* 目录 59 个
[3/5] 全量测试跑完：exit 0，用时 15.3s
[4/5] 跑后：系统 TEMP 的 bdp-* 目录 59 个
[5/5] 仓内 .tmp/ 未登记残留：0 个
系统 TEMP bdp-* 计数：跑前 59 → 跑后 59，增量 0（新增 0 / 消失 0）
✅ 通过：全量跑完系统 TEMP 没有新增任何 bdp-* 目录
```

> 那 59 个是**改前**的原代码跑出来的历史残留（都在 6h 内 ⇒ 清扫按规矩不碰「新鲜」的）。
> 本轮已把它们连同基线对比跑产生的残留一并清掉 ⇒ **当前系统 TEMP 的 `bdp-*` 计数 = 0**；
> 再跑一次全量仍是 **0 → 0，增量 0**。

### 8.6 残留与边界（如实记录）

- **`test/bench-concurrency.test.js` 的「曲线下降」断言在满载并行下会偶发翻转** ——
  这是**既有**的不稳定，**不是本轮引入的**：原代码在主仓（装了 `node_modules`、负载更重）
  连跑两轮都是 fail 1，失败项就是它；本工作树（无 `node_modules`）两轮都是 fail 0。
  该测试自己的注释也记着「并发跑测试文件时的调度抖动会让加速比偶发翻转」。
- **本工作树没有 `BaiduPCS-Go.exe`**（postinstall 产物、被 `.gitignore` 排除），
  导致 `test/audit-v1113.test.js` 的「静默回退必须进 warnings」在**改前改后同样失败**
  —— 已用 `git show HEAD:test/audit-v1113.test.js` 复跑确认是环境缺口，不是回归。
- **强杀兜底不变**：Windows 上 `process.kill` 走 TerminateProcess 时 JS 钩子不会跑，
  兜底靠「落仓内 `.tmp/`」+「启动清扫 6h」两条。
- **产品行为未变**：命令输出、退出码、API 行为一律未改；
  改的只有临时目录的**落点**与**清理**，以及两处**断言基址**（`os.tmpdir()` → `.tmp/`）。
