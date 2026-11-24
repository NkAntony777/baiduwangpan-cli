# 测试临时目录泄漏修复（2026-11-24）

> 触发：C 盘系统 TEMP 里 `bdp-pan-out-*` 曾累计 **887 个目录 / 7.383 GB**。
> 审计查明根因是**本仓自己的测试**留下的 —— 不是别人的垃圾。

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
