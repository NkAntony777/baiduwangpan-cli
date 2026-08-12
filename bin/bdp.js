#!/usr/bin/env node

/**
 * bdp — 百度网盘统一 CLI 工具
 *
 * 网盘文件操作:
 *   bdp ls [path]                  列出目录
 *   bdp search <keyword> [-p dir]  全盘搜索 (支持 --regex/--glob/--any-word/--exact)
 *   bdp cat <path>                 读取文件内容（免下载）
 *   bdp head [-n N] <path>         读取前 N 行
 *   bdp tail [-n N] <path>         读取后 N 行
 *   bdp grep <pattern> <path>      搜索文件内容
 *   bdp peek <path>                预览文件信息
 *   bdp get <path> [-o dir]        下载文件 (size/md5 校验 + 断点续传; <gid>:<fs_id> 走群文件直下)
 *   bdp put <local> <remote>       上传文件
 *   bdp mkdir <path>               创建目录
 *   bdp rm <path>                  删除文件
 *   bdp mv <src> <dst>             移动/重命名
 *   bdp cp <src> <dst>             拷贝
 *   bdp quota                      网盘配额
 *   bdp offline add <url> / list   离线下载
 *   bdp share set/cancel/list      分享管理
 *   bdp profile list/use/unset     多账号 profile 切换
 *
 * 群聊文件操作:
 *   bdp groups                     列出所有群组
 *   bdp gshares <gid>              列出群内分享库
 *   bdp gls <gid> <fs_id>          浏览分享库内容
 *   bdp gsearch <gid> <keyword>    搜索群文件
 *   bdp gdownload <gid> <fs_id>    直接下载群文件到本地（免转存）
 *
 * 配置:
 *   bdp login --bduss X --stoken Y  设置认证
 *   bdp whoami                      查看当前状态
 *   bdp config                      查看配置
 *
 * 全局选项:
 *   --json                         JSON 输出（Agent 友好）
 */

const { config } = require("../lib");
const pan = require("../lib/pan");
const group = require("../lib/group");
const partial = require("../lib/partial");
const pcsExtra = require("../lib/pcs-extra");
const { matchesName } = require("../lib/name-match");
const { ensureUtf8Console } = require("../lib/console");

// ── Utils ──────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function formatSpeed(bps) {
  if (!bps) return "-";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bps) / Math.log(1024));
  return (bps / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function output(data, jsonFlag, formatter) {
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else if (formatter) {
    formatter(data);
  }
}

function emitJson(data, args) {
  const json = JSON.stringify(data, null, 2);
  if (args.flags.jsonFile) {
    require("fs").writeFileSync(args.flags.jsonFile, json, "utf-8");
    console.log(args.flags.jsonFile);
  } else {
    console.log(json);
  }
}

function verboseLog(args, msg) {
  if (args.flags.verbose) process.stderr.write(`[verbose] ${msg}\n`);
}

function parseArgs(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.flags.json = true;
    } else if (arg === "--legacy-json") {
      opts.flags.legacyJson = true;
    } else if (arg === "--json-file") {
      opts.flags.jsonFile = argv[++i];
    } else if (arg === "--verbose") {
      opts.flags.verbose = true;
    } else if (arg === "--unique") {
      opts.flags.unique = true;
    } else if (arg === "--no-unique") {
      opts.flags.unique = false;
    } else if (arg === "--all" || arg === "--all-results") {
      opts.flags.all = true;
    } else if (arg === "--timeout") {
      opts.flags.timeout = parseInt(argv[++i], 10) || 0;
    } else if (arg === "--timeout-ms") {
      opts.flags.timeoutMs = parseInt(argv[++i], 10) || 0;
    } else if (arg === "--save-partial") {
      opts.flags.savePartial = true;
    } else if (arg === "--any-word") {
      opts.flags.anyWord = true;
    } else if (arg === "--exact") {
      opts.flags.exact = true;
    } else if (arg === "-n" || arg === "--lines") {
      opts.flags.n = parseInt(argv[++i], 10) || 20;
    } else if (arg === "-p" || arg === "--path") {
      opts.flags.p = argv[++i];
    } else if (arg === "-k" || arg === "--keyword") {
      opts.flags.k = argv[++i];
    } else if (arg === "-i" || arg === "--ignore-case") {
      opts.flags.i = true;
    } else if (arg === "--number" || arg === "-N") {
      opts.flags.number = true;
    } else if (arg === "-o" || arg === "--output") {
      opts.flags.o = argv[++i];
    } else if (arg === "--bduss") {
      opts.flags.bduss = argv[++i];
    } else if (arg === "--stoken") {
      opts.flags.stoken = argv[++i];
    } else if (arg === "--page") {
      opts.flags.page = parseInt(argv[++i], 10) || 1;
    } else if (arg === "--page-size") {
      opts.flags.pageSize = parseInt(argv[++i], 10) || 50;
    } else if (arg === "--top") {
      opts.flags.top = parseInt(argv[++i], 10) || 15;
    } else if (arg === "--limit") {
      opts.flags.limit = parseInt(argv[++i], 10) || 50;
    } else if (arg === "--concurrency") {
      opts.flags.concurrency = parseInt(argv[++i], 10) || 4;
    } else if (arg === "--depth") {
      opts.flags.depth = parseInt(argv[++i], 10) || 2;
    } else if (arg === "--max-nodes") {
      opts.flags.maxNodes = parseInt(argv[++i], 10) || 2000;
    } else if (arg === "--max-pages") {
      opts.flags.maxPages = parseInt(argv[++i], 10) || 50;
    } else if (arg === "--max-requests") {
      opts.flags.maxRequests = parseInt(argv[++i], 10) || 400;
    } else if (arg === "--no-cache") {
      opts.flags.noCache = true;
    } else if (arg === "--resume") {
      opts.flags.resume = true;
    } else if (arg === "--force") {
      opts.flags.force = true;
    } else if (arg === "--progress") {
      opts.flags.progress = true;
    } else if (arg === "--no-verify-size") {
      opts.flags.noVerifySize = true;
    } else if (arg === "--regex") {
      opts.flags.regex = true;
    } else if (arg === "--glob") {
      opts.flags.glob = true;
    } else if (arg === "--pwd" || arg === "--password") {
      opts.flags.pwd = argv[++i];
    } else if (arg === "--combined") {
      opts.flags.combined = true;
    } else if (arg === "--dry-run") {
      opts.flags.dryRun = true;
    } else if (arg === "--profile") {
      opts.flags.profile = argv[++i];
    } else if (arg === "--from-uk") {
      opts.flags.fromUk = argv[++i];
    } else if (arg === "--msg-id") {
      opts.flags.msgId = argv[++i];
    } else if (arg === "--parent-fs-id") {
      opts.flags.parentFsId = argv[++i];
    } else if (arg.startsWith("-")) {
      opts.flags[arg.replace(/^-+/, "")] = true;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

// ── Commands ───────────────────────────────────────────

const cmds = {};

cmds.login = async (args, json) => {
  // 方式 1: 手动传入凭证
  if (args.flags.bduss || args.flags.stoken) {
    if (!args.flags.bduss || !args.flags.stoken) {
      throw new Error("Manual login requires both --bduss and --stoken");
    }
    config.setAuth({
      bduss: args.flags.bduss,
      stoken: args.flags.stoken,
      webTransport: "curl",
    });
    const cfg = config.get();
    output(
      { success: true, bduss: cfg.bduss ? "***set***" : "missing", stoken: cfg.stoken ? "***set***" : "missing" },
      json,
      () => console.log("Credentials saved to " + config.CONFIG_FILE)
    );
    return;
  }

  // 方式 2: 浏览器自动登录（扫码，Agent 代劳）
  const { browserLogin } = require("../lib/browser-login");
  const status = (msg) => {
    if (!json) console.log(msg);
  };

  status("🔐 bdp login: 未提供 --bduss/--stoken，启动浏览器扫码登录...");
  try {
    const previous = config.get();
    const creds = await browserLogin({
      onStatus: status,
      profileDir: previous.browserProfile || undefined,
      port: previous.webTransport === "browser" ? previous.browserPort : undefined,
    });
    config.setAuth({
      bduss: creds.bduss,
      stoken: creds.stoken,
      webTransport: "browser",
      browserProfile: creds.browserProfile,
      browserPort: creds.browserPort,
    });
    status("✅ 登录成功，凭证已保存到 " + config.CONFIG_FILE);

    // 同步登录 BaiduPCS-Go 引擎（全盘操作依赖）
    try {
      const { spawnSync } = require("child_process");
      const cfg = config.get();
      const loginResult = spawnSync(cfg.pcsPath, ["login", `-bduss=${creds.bduss}`, `-stoken=${creds.stoken}`], {
        encoding: "utf-8",
        timeout: 30000,
      });
      if (loginResult.stdout && loginResult.stdout.includes("登录成功")) {
        status("✅ BaiduPCS-Go 引擎已同步登录");
      } else {
        status("⚠️ BaiduPCS-Go 引擎登录失败: " + (loginResult.stdout || loginResult.stderr || "未知错误").trim().substring(0, 100));
      }
    } catch (e) {
      status("⚠️ BaiduPCS-Go 引擎登录异常: " + e.message);
    }

    if (json) {
      console.log(JSON.stringify({ success: true, method: "browser-qr", bduss: "***set***", stoken: "***set***" }));
    }
  } catch (e) {
    if (json) {
      console.log(JSON.stringify({ error: e.message }));
    } else {
      console.error(`[ERROR] ${e.message}`);
      console.error("        提示: 也可手动方式 bdp login --bduss <值> --stoken <值>");
    }
    process.exit(1);
  }
};

cmds.whoami = async (args, json) => {
  const cfg = config.get();
  output(
    {
      loggedIn: !!(cfg.bduss && cfg.stoken),
      bduss: cfg.bduss ? "***set***" : "missing",
      stoken: cfg.stoken ? "***set***" : "missing",
      webTransport: cfg.webTransport,
      pcsPath: cfg.pcsPath,
      configFile: config.CONFIG_FILE,
      profile: config.getProfile() || "default(全局)",
    },
    json,
    (d) => {
      console.log(`Status:     ${d.loggedIn ? "✅ Logged in" : "❌ Not logged in"}`);
      console.log(`Profile:    ${d.profile}`);
      console.log(`BDUSS:      ${d.bduss}`);
      console.log(`STOKEN:     ${d.stoken}`);
      console.log(`Web API:    ${d.webTransport}`);
      console.log(`PCS Path:   ${d.pcsPath}`);
      console.log(`Config:     ${d.configFile}`);
    }
  );
};

cmds.config = async (args, json) => {
  const cfg = config.get();
  output(cfg, json, (d) => {
    console.log("Configuration:");
    console.log(`  bduss:     ${d.bduss ? d.bduss.substring(0, 10) + "..." : "(not set)"}`);
    console.log(`  stoken:    ${d.stoken ? d.stoken.substring(0, 10) + "..." : "(not set)"}`);
    console.log(`  web API:   ${d.webTransport}`);
    console.log(`  pcsPath:   ${d.pcsPath}`);
    console.log(`  ua:        ${d.ua.substring(0, 40)}...`);
    console.log(`  maxBytes:  ${d.maxBytes}`);
    console.log(`  file:      ${config.CONFIG_FILE}`);
  });
};

cmds.ls = async (args, json) => {
  const dirPath = args._[0] || "/";
  const raw = pan.ls(dirPath);
  if (json) {
    console.log(JSON.stringify({ path: dirPath, raw }));
  } else {
    console.log(raw);
  }
};

// 从 BaiduPCS-Go search 输出行提取路径（格式: 序号 大小 日期 时间 路径）
function searchPathFromLine(line) {
  const m = line.trim().match(/^\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  return m ? m[1].trim() : null;
}

// 从 glob/正则模式提取第一个字面片段（≥2 字符优先），供引擎宽词搜索。
// BaiduPCS-Go 的 search 自己会做 glob 展开（"*.pdf" 直接返回 0 结果），
// 所以模式模式下必须用字面片段搜引擎，再用完整模式在客户端精确过滤。
function firstLiteralRun(pattern) {
  const runs = String(pattern).split(/[.*+?^${}()|[\]\\*?]/).filter(Boolean);
  return runs.find((r) => r.length >= 2) || runs[0] || null;
}

cmds.search = async (args, json) => {
  const keyword = args.flags.k || args._[0] || "";
  const searchPath = args.flags.p || "/";
  if (!keyword) { console.error("Usage: bdp search <keyword> [-p /path] [--regex|--glob|--any-word|--exact]"); process.exit(1); }

  // 客户端二次过滤：--regex 正则 / --glob 通配符 / --any-word OR / --exact 整名（缺省=子串，兼容旧行为）
  const mode = args.flags.exact ? "exact" : args.flags.anyWord ? "any" : args.flags.regex ? "regex" : args.flags.glob ? "glob" : null;
  let engineKw = keyword;
  if (mode === "regex" || mode === "glob") {
    engineKw = firstLiteralRun(keyword);
    if (!engineKw) {
      console.error(`[ERROR] 模式 ${keyword} 不含任何普通字符，无法搜索`);
      process.exit(1);
    }
  } else if (mode === "any") {
    engineKw = keyword.split(/\s+/)[0]; // 引擎只搜第一个词，客户端按 OR 过滤
  }

  const raw = pan.search(engineKw, searchPath);
  let out = raw;
  if (mode) {
    const kept = raw.split("\n").filter((line) => {
      const p = searchPathFromLine(line);
      if (p === null) return false;
      if (mode === "glob") {
        // glob 同时匹配完整路径与文件名（shell 惯例: "玄空*" 命中以玄空开头的文件名）
        const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
        return matchesName(keyword, p, { mode }) || matchesName(keyword, base, { mode });
      }
      return matchesName(keyword, p, { mode });
    });
    out = kept.join("\n") + (kept.length ? "\n" : "");
  }

  if (json) {
    console.log(JSON.stringify({ keyword, engineKeyword: engineKw, path: searchPath, mode: mode || "substring", raw: out }));
  } else {
    console.log(out);
  }
};

cmds.cat = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp cat <path>"); process.exit(1); }
  const text = pan.cat(filePath);
  if (json) {
    console.log(JSON.stringify({ path: filePath, content: text }));
  } else if (args.flags.number) {
    text.split("\n").forEach((line, i) => {
      console.log(`${String(i + 1).padStart(6)}  ${line}`);
    });
  } else {
    process.stdout.write(text);
  }
};

cmds.head = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp head [-n N] <path>"); process.exit(1); }
  const n = args.flags.n || 20;
  const lines = pan.head(filePath, n);
  if (json) {
    console.log(JSON.stringify({ path: filePath, lines: n, content: lines }));
  } else {
    lines.forEach((l) => console.log(l));
  }
};

cmds.tail = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp tail [-n N] <path>"); process.exit(1); }
  const n = args.flags.n || 20;
  const lines = pan.tail(filePath, n);
  if (json) {
    console.log(JSON.stringify({ path: filePath, lines: n, content: lines }));
  } else {
    lines.forEach((l) => console.log(l));
  }
};

cmds.grep = async (args, json) => {
  const pattern = args._[0];
  const filePath = args._[1];
  if (!pattern || !filePath) { console.error("Usage: bdp grep <pattern> <path>"); process.exit(1); }
  const matches = pan.grep(pattern, filePath, { ignoreCase: args.flags.i });
  if (json) {
    console.log(JSON.stringify({ path: filePath, pattern, matches }));
  } else {
    matches.forEach((m) => {
      if (args.flags.number) console.log(`${filePath}:${m.line}:${m.content}`);
      else console.log(m.content);
    });
  }
};

cmds.peek = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp peek <path>"); process.exit(1); }
  const info = await pan.peek(filePath);
  output(info, json, (d) => {
    console.log(`Path:   ${d.path}`);
    console.log(`Size:   ${d.size ? formatSize(d.size) : "unknown"}`);
    console.log(`Type:   ${d.type || (d.isDir ? "directory" : "unknown")}`);
    console.log(`Dlink:  ${d.dlink ? "✅" : "❌"}`);
    if (d.md5) console.log(`MD5:    ${d.md5}`);
    if (d.serverCtime) console.log(`Server: ${new Date(d.serverCtime * 1000).toISOString()}`);
    if (d.localCtime) console.log(`Local:  ${new Date(d.localCtime * 1000).toISOString()}`);
    if (d.preview) {
      console.log(`\n── Preview ──`);
      d.preview.forEach((l) => console.log(l));
    }
  });
};

cmds.get = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp get <path> [-o dir] [--resume] [--force] [--progress]"); process.exit(1); }

  // 群文件路由: `bdp get <gid>:<fs_id>` → gdownload 语义（免转存直下）
  const gmatch = filePath.match(/^(\d+):(\d+)$/);
  if (gmatch) {
    const opts = { outDir: args.flags.o };
    if (args.flags.fromUk) opts.fromUk = args.flags.fromUk;
    if (args.flags.msgId) opts.msgId = args.flags.msgId;
    if (args.flags.filename) opts.filename = args.flags.filename;
    if (args.flags.dryRun) {
      const info = { path: filePath, groupDownload: true, dryRun: true, note: "群文件下载（免转存，无 size 校验/断点续传）" };
      emitJson(info, args);
      return;
    }
    const info = await group.downloadFile(gmatch[1], gmatch[2], opts);
    if (json || args.flags.jsonFile) emitJson({ path: filePath, groupDownload: true, name: info.name, size: info.size, localPath: info.path, fromUk: info.fromUk, msgId: info.msgId }, args);
    else console.log(`✅ 群文件已下载 ${info.size} 字节 → ${info.path}`);
    return;
  }

  const info = await pan.download(filePath, args.flags.o, {
    resume: args.flags.resume === true,
    force: args.flags.force === true,
    progress: args.flags.progress === true,
    verifySize: args.flags.noVerifySize !== true,
    dryRun: args.flags.dryRun === true,
    concurrency: args.flags.concurrency || undefined,
  });

  if (json || args.flags.jsonFile) {
    emitJson(info, args);
    return;
  }

  if (info.dryRun) {
    const verb = info.action === "skip" ? "跳过（已存在且大小一致）" : info.action === "resume" ? "续传" : "下载";
    console.log(`[dry-run] ${verb}: ${info.path} (${info.size != null ? formatSize(info.size) : "大小未知"}) → ${info.localPath}`);
    return;
  }

  // BaiduPCS-Go 回退引擎（目录 / 无 dlink）：保持旧输出
  if (info.engine === "pcs") {
    console.log(info.raw);
    if (info.warning) console.error(`⚠️  ${info.warning}`);
    return;
  }

  const head = info.skipped ? "⏭ 已存在且大小一致，跳过" : info.resumed ? "⏸ 断点续传完成" : "✅ 已下载";
  const md5Part =
    info.md5Match === true ? `，md5 一致 (${info.md5})`
    : info.md5Match === false ? "，md5 与远端不一致!"
    : info.md5 ? `，md5 ${info.md5}${info.md5Obfuscated ? "（远端 md5 为百度混淆值，未比对）" : ""}`
    : "";
  console.log(`${head} ${info.size} 字节 → ${info.localPath}${md5Part}  ${formatSpeed(info.avgSpeedBps)}`);
};

cmds.put = async (args, json) => {
  const local = args._[0];
  const remote = args._[1];
  if (!local || !remote) { console.error("Usage: bdp put <local> <remote>"); process.exit(1); }
  if (args.flags.dryRun) {
    console.log(`[dry-run] 将上传 ${local} → ${remote}`);
    return;
  }
  const raw = pan.upload(local, remote);
  output({ local, remote, raw }, json, () => console.log(raw));
};

cmds.mkdir = async (args, json) => {
  const dirPath = args._[0];
  if (!dirPath) { console.error("Usage: bdp mkdir <path>"); process.exit(1); }
  const raw = pan.mkdir(dirPath);
  output({ path: dirPath, raw }, json, () => console.log(raw));
};

cmds.rm = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp rm <path>"); process.exit(1); }
  if (args.flags.dryRun) {
    console.log(`[dry-run] 将删除 ${filePath}`);
    return;
  }
  const raw = pan.remove(filePath);
  output({ path: filePath, raw }, json, () => console.log(raw));
};

// ── Pan 扩展命令（BaiduPCS-Go 引擎封装）───────────────

cmds.quota = async (args, json) => {
  const q = pcsExtra.quota();
  output(q, json, (d) => {
    console.log(`总空间: ${formatSize(d.total)}`);
    console.log(`已用:   ${formatSize(d.used)} (${d.ratio.toFixed(2)}%)`);
    console.log(`剩余:   ${formatSize(d.free)}`);
    if (d.username) console.log(`用户:   ${d.username}`);
  });
};

cmds.du = async (args, json) => {
  const dirPath = args._[0] || "/";
  verboseLog(args, `du ${dirPath} depth=${args.flags.depth || 3} concurrency=${args.flags.concurrency || 8} top=${args.flags.top || 15}`);
  const result = await pan.du(dirPath, {
    depth: args.flags.depth,
    concurrency: args.flags.concurrency,
    top: args.flags.top,
  });
  if (json || args.flags.jsonFile) {
    emitJson(result, args);
    return;
  }
  console.log(`${formatSize(result.size)}  ${result.path}  (${result.files} 文件 / ${result.dirs} 子目录${result.truncated ? " / 仅显示前" + (args.flags.top || 15) + "项" : ""}${result.failed ? ` / ${result.failed} 目录读取失败` : ""}  ${(result.elapsedMs / 1000).toFixed(1)}s)`);
  console.log("");
  result.children.forEach((c) => {
    console.log(`  ${formatSize(c.size).padStart(10)}  ${c.path}${c.capped ? "  [深度封顶]" : ""}`);
  });
};

cmds.recycle = async (args, json) => {
  const action = args._[0] || "list";
  if (action === "list") {
    const r = pcsExtra.recycleList(args.flags.page || 1);
    output(r, json, (d) => {
      if (d.count === 0) { console.log("回收站为空"); return; }
      console.log(`${d.count} 项回收站内容:`);
      d.items.forEach((it) => {
        console.log(`  [${it.index}] ${it.path}  ${it.size != null ? formatSize(it.size) : "-"}  ${it.remainDays != null ? "剩余" + it.remainDays + "天" : ""}  fs_id:${it.fsId}`);
      });
    });
  } else if (action === "restore") {
    const ids = args._.slice(1);
    if (ids.length === 0) { console.error("Usage: bdp recycle restore <fs_id>..."); process.exit(1); }
    const r = pcsExtra.recycleRestore(ids);
    if (json || args.flags.jsonFile) emitJson({ restored: ids, ok: true }, args);
    else console.log(`✅ 已还原 ${ids.length} 项: ${ids.join(", ")}`);
  } else if (action === "clean") {
    const r = pcsExtra.recycleClean();
    if (json || args.flags.jsonFile) emitJson({ cleaned: true }, args);
    else console.log("✅ 回收站已清空（不可恢复）");
  } else {
    console.error("Usage: bdp recycle list | restore <fs_id>... | clean");
    process.exit(1);
  }
};


cmds.mv = async (args, json) => {
  const src = args._[0];
  const dst = args._[1];
  if (!src || !dst) { console.error("Usage: bdp mv <src> <dst>"); process.exit(1); }
  const r = pcsExtra.mv(src, dst);
  output(r, json, () => console.log(`✅ ${r.op === "rename" ? "已重命名" : "已移动"}: ${src} → ${dst}`));
};

cmds.cp = async (args, json) => {
  const src = args._[0];
  const dst = args._[1];
  if (!src || !dst) { console.error("Usage: bdp cp <src> <dst>"); process.exit(1); }
  const r = pcsExtra.cp(src, dst);
  output(r, json, () => console.log(`✅ 已拷贝: ${src} → ${dst}`));
};

cmds.offline = async (args, json) => {
  const action = args._[0] || "list";
  if (action === "add") {
    const url = args._[1];
    if (!url) { console.error("Usage: bdp offline add <http_url> [--path /保存目录]"); process.exit(1); }
    const r = pcsExtra.offlineAdd(url, args.flags.path);
    output(r, json, () => console.log(`✅ 离线任务已创建: taskId=${r.taskId} (${url})${r.savePath ? ` → ${r.savePath}` : ""}`));
  } else if (action === "list") {
    const r = pcsExtra.offlineList();
    output(r, json, (d) => {
      console.log(`${d.count} 个离线任务:`);
      d.tasks.forEach((t) => {
        console.log(`  [${t.index}] ${t.name}  ${formatSize(t.size)}  ${t.status}  taskId:${t.taskId}`);
      });
    });
  } else {
    console.error("Usage: bdp offline add <http_url> [--path /保存目录] | bdp offline list");
    process.exit(1);
  }
};

cmds.share = async (args, json) => {
  const action = args._[0] || "list";
  if (action === "set") {
    const p = args._[1];
    if (!p) { console.error("Usage: bdp share set <path> [--pwd 提取码] [--combined]"); process.exit(1); }
    const r = pcsExtra.shareSet(p, args.flags.pwd, { combined: args.flags.combined });
    output(r, json, () => {
      const link = r.combined ? `${r.link}?pwd=${r.pwd}` : r.link;
      console.log(`✅ 分享创建成功: ${link}${!r.combined && r.pwd ? `  提取码: ${r.pwd}` : ""}  shareId:${r.shareId}`);
    });
  } else if (action === "cancel") {
    const ids = args._.slice(1);
    if (ids.length === 0) { console.error("Usage: bdp share cancel <shareId> [shareId2 ...]"); process.exit(1); }
    const results = ids.map((id) => {
      const r = pcsExtra.shareCancel(id);
      return { shareId: id, ok: r.ok };
    });
    if (json || args.flags.jsonFile) emitJson(results, args);
    else results.forEach((r) => console.log(`✅ 已取消分享 ${r.shareId}`));
  } else if (action === "list") {
    const r = pcsExtra.shareList(args.flags.page || 1);
    output(r, json, (d) => {
      console.log(`${d.count} 个分享:`);
      d.shares.forEach((s) => {
        console.log(`  [${s.index}] ${s.link}${s.pwd ? `  提取码: ${s.pwd}` : ""}  shareId:${s.shareId}  ${s.expireText || ""}`);
      });
    });
  } else {
    console.error("Usage: bdp share set <path> [--pwd 提取码] | bdp share cancel <shareId> | bdp share list");
    process.exit(1);
  }
};

cmds.profile = async (args, json) => {
  const action = args._[0] || "list";
  if (action === "use") {
    const name = args._[1];
    if (!name) { console.error("Usage: bdp profile use <name> | bdp profile unset | bdp profile list"); process.exit(1); }
    const n = config.useProfile(name);
    output({ profile: n }, json, () => console.log(`✅ 已切换到 profile: ${n}`));
  } else if (action === "unset") {
    config.unsetProfile();
    output({ profile: null }, json, () => console.log("✅ 已切回全局账号"));
  } else {
    const current = config.getProfile() || "default(全局)";
    const list = config.listProfiles();
    output({ current, profiles: list }, json, (d) => {
      console.log(`当前: ${d.current}`);
      console.log(`${d.profiles.length} 个 profile:`);
      d.profiles.forEach((p) => console.log(`  ${p.name}  ${p.bduss ? "bduss:***set***" : "(空)"}`));
    });
  }
};

// ── Group Commands ─────────────────────────────────────

cmds.groups = async (args, json) => {
  const groups = await group.listGroups();
  output(groups, json, (list) => {
    console.log(`${list.length} groups:\n`);
    list.forEach((g, i) => {
      console.log(`  [${i}] ${g.name}  (gid: ${g.gid})`);
    });
  });
};

cmds.gshares = async (args, json) => {
  const gid = args._[0];
  if (!gid) { console.error("Usage: bdp gshares <gid>"); process.exit(1); }
  const shares = await group.listShares(gid, { cache: args.flags.noCache !== true });
  output(shares, json, (list) => {
    console.log(`${list.length} shares in group ${gid}:\n`);
    list.forEach((s, i) => {
      console.log(`  [${i}] ${s.name} ${s.isDir ? "[DIR]" : ""}  ${formatSize(s.size)}  fs_id:${s.fsId}`);
      console.log(`      shared by: ${s.fromUser}  msg_id:${s.msgId}`);
    });
  });
};

cmds.gls = async (args, json) => {
  const gid = args._[0];
  const fsId = args._[1];
  if (!gid || !fsId) { console.error("Usage: bdp gls <gid> <fs_id> [--page N] [--page-size N]"); process.exit(1); }

  const opts = {
    page: args.flags.page || 1,
    pageSize: args.flags.pageSize || 50,
    cache: args.flags.noCache !== true,
  };
  if (args.flags.fromUk) opts.fromUk = args.flags.fromUk;
  if (args.flags.msgId) opts.msgId = args.flags.msgId;
  if (args.flags.parentFsId) opts.parentFsId = args.flags.parentFsId;

  verboseLog(args, `gls gid=${gid} fsId=${fsId} page=${opts.page} pageSize=${opts.pageSize}`);
  const result = await group.listFiles(gid, fsId, opts);

  if (args.flags.legacyJson) {
    emitJson(result.files, args);
    return;
  }

  if (result.autoResolved) {
    console.error(`[auto] 传入的 fromUk/msgId 与群 ${gid} 不匹配（API errno=2131），已自动改用 gshares 解析的参数 (fromUk=${result.fromUk}, msgId=${result.msgId})`);
  }

  if (result.fallback) {
    verboseLog(args, `fallback: ${result.fallback.reason} -> ${result.fallback.resolvedFsId} (${result.fallback.level})`);
  }

  if (args.flags.jsonFile || json) {
    emitJson(result, args);
  } else {
    if (result.fallback) {
      console.log(`⚠️  fallback: ${result.fallback.reason} — 已回退到 ${result.fallback.resolvedFsId} (${result.fallback.level})`);
    }
    console.log(`${result.files.length} items${result.hasMore ? " (has more — use --page)" : ""}:\n`);
    result.files.forEach((f) => {
      const dir = f.isDir ? "[DIR] " : "      ";
      console.log(`  ${dir}${f.name}  ${formatSize(f.size)}  fs_id:${f.fsId}`);
    });
  }
};

cmds.gtree = async (args, json) => {
  const gid = args._[0];
  if (!gid) { console.error("Usage: bdp gtree <gid> [--depth N] [--concurrency N] [--max-nodes N]"); process.exit(1); }

  const opts = {
    depth: args.flags.depth || 2,
    concurrency: args.flags.concurrency || 4,
    maxNodes: args.flags.maxNodes || 2000,
    maxPages: args.flags.maxPages || 50,
    maxRequests: args.flags.maxRequests || 400,
    cache: args.flags.noCache !== true,
  };
  verboseLog(args, `gtree gid=${gid} depth=${opts.depth} concurrency=${opts.concurrency} maxNodes=${opts.maxNodes} maxPages=${opts.maxPages} maxRequests=${opts.maxRequests} cache=${opts.cache}`);
  const result = await group.treeFiles(gid, opts);

  if (args.flags.jsonFile || json) {
    emitJson(result, args);
  } else {
    console.log(`${result.tree.length} nodes (depth ${result.depth}, ${result.failed.length} failed${result.truncated ? ", truncated" : ""}):\n`);
    result.tree.forEach((n) => {
      const dir = n.isDir ? "[DIR] " : "      ";
      console.log(`  ${dir}${n.path || n.name}  ${formatSize(n.size)}  fs_id:${n.fsId}`);
    });
  }
};

cmds.gsearch = async (args, json) => {
  const gid = args._[0];
  const keyword = args._[1];
  if (!gid || !keyword) { console.error("Usage: bdp gsearch <gid> <keyword> [--page N] [--limit N]"); process.exit(1); }

  const opts = {
    page: args.flags.page || 1,
    limit: args.flags.limit || 50,
    concurrency: args.flags.concurrency || 4,
    unique: args.flags.unique !== false,
    all: args.flags.all === true,
    exact: args.flags.exact === true,
    anyWord: args.flags.anyWord === true,
    timeoutMs: args.flags.timeoutMs || (args.flags.timeout ? args.flags.timeout * 1000 : 0),
    depth: args.flags.depth || 1,
    maxPages: args.flags.maxPages || 50,
    maxRequests: args.flags.maxRequests || 400,
    cache: args.flags.noCache !== true,
  };

  // --save-partial：未完整（超时/限流/预算/失败）时自动把已搜到的结果落盘；
  // 未指定 --json-file 时自动生成路径（bdp-gsearch-<gid>-<kw>-partial-<ts>.json）
  const savePartial = args.flags.savePartial === true;
  const jsonFile = args.flags.jsonFile;
  const partialFile = jsonFile || (savePartial ? partial.defaultPartialFile(gid, keyword) : null);
  const fsMod = require("fs");

  // 扫描过程中持续写部分结果（--json-file 或 --save-partial 自动文件），
  // 即使被外部超时/杀掉，已搜到的结果也已落盘
  let lastProgressWrite = 0;
  if (partialFile) {
    fsMod.writeFileSync(partialFile, JSON.stringify({ running: true, results: [], complete: false, partial: true }, null, 2), "utf-8");
  }
  opts.onProgress = (snap) => {
    if (!partialFile) return;
    const now = Date.now();
    if (snap.running && now - lastProgressWrite < 400) return; // 节流，避免频繁写盘
    lastProgressWrite = now;
    fsMod.writeFileSync(
      partialFile,
      JSON.stringify(
        {
          running: snap.running,
          results: snap.results,
          page: snap.page,
          pageSize: snap.pageSize,
          complete: snap.complete,
          partial: snap.partial,
          timedOut: snap.timedOut,
          stoppedReason: snap.stoppedReason,
          scannedShares: snap.scannedShares,
          totalShares: snap.totalShares,
          failedShares: snap.failedShares,
          throttledShares: snap.throttledShares,
          cachedDirs: snap.cachedDirs,
          budgetUsed: snap.budgetUsed,
          depth: snap.depth,
          maxPages: snap.maxPages,
        },
        null,
        2
      ),
      "utf-8"
    );
  };

  verboseLog(args, `gsearch gid=${gid} keyword="${keyword}" page=${opts.page} limit=${opts.limit} concurrency=${opts.concurrency} unique=${opts.unique} all=${opts.all} exact=${opts.exact} anyWord=${opts.anyWord} timeoutMs=${opts.timeoutMs} savePartial=${savePartial} depth=${opts.depth} maxPages=${opts.maxPages} maxRequests=${opts.maxRequests} cache=${opts.cache}`);
  const result = await group.searchFiles(gid, keyword, opts);

  if (result.partial) {
    verboseLog(args, `partial: ${result.failedShares}/${result.totalShares} shares failed`);
    if (result.failedDirs && result.failedDirs.length > 0) {
      verboseLog(args, `failed dirs: ${result.failedDirs.map((f) => `${f.name || f.fsId}(${f.errno})`).slice(0, 10).join(", ")}`);
    }
  }
  if (result.throttled) {
    verboseLog(args, `throttled: API 限流中断，重跑命令可续扫（磁盘缓存只补缺失目录）`);
  }

  if (args.flags.legacyJson) {
    emitJson(result.results, args);
  } else if (args.flags.jsonFile || json) {
    emitJson(result, args);
  } else {
    console.log(`${result.returned} matches for "${keyword}"${result.hasMore ? " (has more — use --page " + (result.nextPage || "?") + ")" : ""}:\n`);
    result.results.forEach((r) => {
      const dir = r.isDir ? "[DIR] " : "      ";
      console.log(`  ${dir}${r.path || r.name}  ${formatSize(r.size)}  fs_id:${r.fsId}`);
    });
    if (result.timedOut) {
      console.error(`⚠️  搜索超时（${Math.round(opts.timeoutMs / 1000)}s），已返回部分结果（complete:false, partial:true）。重跑或增大 --timeout / 用 --all-results 不限时`);
    } else if (result.throttled) {
      console.error(`⚠️  API 限流中断（已扫描 ${result.scannedShares}/${result.totalShares} 分享，失败 ${result.failedShares}）。重跑命令可续扫（磁盘缓存加速）`);
    } else if (result.partial) {
      console.error(`[verbose] ${result.failedShares} shares failed (partial result)`);
    }
  }

  // --save-partial：未完整时把已搜到的结果写盘并告知路径（stderr，不污染 JSON stdout）
  if (savePartial && partialFile && result.partial) {
    if (!jsonFile) {
      fsMod.writeFileSync(
        partialFile,
        JSON.stringify(partial.buildPartialPayload(result, { gid, keyword }), null, 2),
        "utf-8"
      );
    }
    console.error(`💾 部分结果已保存: ${partialFile}`);
  } else if (savePartial && partialFile && !result.partial && !jsonFile) {
    // 自动生成的文件且搜索完整 → 清理占位文件，避免留下垃圾
    try { fsMod.unlinkSync(partialFile); } catch {}
  }
};

cmds.gdownload = async (args, json) => {
  const gid = args._[0];
  const fsIds = args._.slice(1);
  if (!gid || fsIds.length === 0) { console.error("Usage: bdp gdownload <gid> <fs_id> [fs_id2 ...] [-o dir] [--from-uk X] [--msg-id Y] [--filename NAME]"); process.exit(1); }

  const opts = {
    cache: args.flags.noCache !== true,
  };
  if (args.flags.fromUk) opts.fromUk = args.flags.fromUk;
  if (args.flags.msgId) opts.msgId = args.flags.msgId;
  if (args.flags.o) opts.outDir = args.flags.o;
  if (args.flags.filename) opts.filename = args.flags.filename;

  verboseLog(args, `gdownload gid=${gid} fsIds=[${fsIds.join(",")}] outDir=${opts.outDir || process.cwd()} filename=${opts.filename || "auto"} fromUk=${opts.fromUk || "auto"} msgId=${opts.msgId || "auto"}`);

  // 单文件 → 直接下载；多 fs_id（同一分享消息）→ zip 打包下载（逆向 type=batch）
  const result = fsIds.length === 1
    ? await group.downloadFile(gid, fsIds[0], opts)
    : await group.downloadFiles(gid, fsIds, opts);

  output(
    { path: result.path, name: result.name, size: result.size, fsId: fsIds.length === 1 ? fsIds[0] : undefined, count: result.count, fromUk: result.fromUk, msgId: result.msgId },
    json,
    () => console.log(`✅ 已下载 ${result.size} 字节 → ${result.path}${result.count ? `（${result.count} 个文件 zip 打包）` : ""}`)
  );
};

cmds.cache = async (args, json) => {
  const action = args._[0] || "info";
  const { clearGroupCache } = group;
  if (action === "clear") {
    clearGroupCache();
    output({ cleared: true }, json, () => console.log("✅ 群聊会话缓存已清除"));
    return;
  }
  // info: 显示缓存目录位置
  const path = require("path");
  const os = require("os");
  const dir = process.env.BDP_CACHE_DIR || path.join(os.homedir(), ".bdp", "cache");
  output({ cacheDir: dir, ttl: { dir: "30min", shares: "5min" } }, json, () => {
    console.log(`Cache dir:  ${dir}`);
    console.log(`Dir TTL:    30 min (gsearch/gtree 目录列表)`);
    console.log(`Shares TTL: 5 min (gshares 分享列表)`);
    console.log(`Clear with: bdp cache clear`);
  });
};

cmds.error = async (args, json) => {
  const code = args._[0] || "-3";
  const ERRORS = {
    "-10": "群文件转存接口已被百度下线（2026-08 实测：/mbox/msg/transfer 对非空目录一律 errno=-10，\n" +
            "补 logId/channel 参数仍拒绝，新版 UI 已移除'保存'按钮）。\n" +
            "处理：群文件用 bdp gdownload 直接下载（单文件 ≤~20MB；多文件 zip 打包 ≤~100MB），\n" +
            "      更大文件用百度官方客户端。",
    "-6": "接口鉴权失败。通常为 access_token/cookie 失效，请重新执行 bdp login。",
    "2": "接口不支持或参数缺失（errno=2）。\n" +
          "实测普通文件接口（/api/download、/api/filemetas）对群文件参数返回 errno=2。\n" +
          "处理：群文件请走 bdp gdownload / bdp gsearch 的群专用接口。",
    "-3": "群分享 API 拒绝请求。已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁(限流)都可能触发。\n" +
          "处理：减小 --page-size（自动重试 50→20→10）或 --concurrency；\n" +
          "      限流表现为 errno=0 但只返回目录自身（self-echo），工具会自动退避重试(1s/2s)；\n" +
          "      大目录已支持自动全页遍历（每页上限 100，--max-pages 控制页数）；\n" +
          "      若回退到父目录（fallback level=parent），Agent 应从父目录换路径继续遍历。",
    "2131": "群分享 msg_id 不属于该群（shareinfo 以 msg_id 为查找键，from_uk 不参与校验）。\n" +
            "常见原因：gid 与 --from-uk/--msg-id/--parent-fs-id 来自不同群/分享库（参数错配）。\n" +
            "处理：用 bdp gshares <gid> 查看本群分享（或 bdp gsearch <gid> <关键词>），\n" +
            "      取其中一行的 fsId/fromUk/msgId 重试，保证 gid/fsId/fromUk/msgId 同源；\n" +
            "      fsId 为子目录时保持其父分享行的 fromUk/msgId 不变；\n" +
            "      或去掉 --from-uk/--msg-id 让 CLI 自动解析（仅顶层分享）。\n" +
            "      工具已支持：显式参数错配时自动按 fsId 纠正（结果含 autoResolved:true）。",
    "31062": "文件名非法（file name is invalid）。\n" +
              "处理：路径含非法字符或格式不符，重命名网盘文件后再试。",
    "31090": "zip 打包总大小超出上限（package is too large，实测 452MB 即报 31090，10MB 正常）。\n" +
              "处理：拆包下载，或大文件用百度官方客户端。",
    "31326": "dlink 被反盗链拦截（HTTP 403，hitcode 104）。\n" +
              "实测直链只接受 ≤~5MB 的有界 Range 请求，无界请求返回 403。\n" +
              "处理：CLI 已按 4MB 分块自动规避；如仍报错，重跑 bdp get --resume（换新 dlink）。",
  };
  const msg = ERRORS[code] || `未知错误码 ${code}，请提交 Issue: https://github.com/NkAntony777/baiduwangpan-cli/issues`;
  if (args.flags.jsonFile || json) {
    emitJson({ code, description: msg }, args);
  } else {
    console.log(msg);
  }
};

// ── Main ───────────────────────────────────────────────


// ── 命令注册表（bdp help / 未知命令提示的唯一数据源）──────────────────
// 每项: { group: "pan"|"group"|"config", usage, desc, options?, examples?, note? }
// 新增命令时必须在此登记，bdp help 才会展示（避免手写 HELP 漂移）
const COMMANDS = {
  ls: {
    group: "pan",
    usage: "bdp ls [path]",
    desc: "列出目录",
    flags: [],
    examples: ["bdp ls /", "bdp ls /文档 --json"],
  },
  search: {
    group: "pan",
    usage: "bdp search <keyword> [-p /path]",
    desc: "按文件名递归搜索，支持模式过滤",
    flags: ["k", "p", "regex", "glob", "anyWord", "exact"],
    options: [
      "-p <dir>      搜索目录 (默认 /)",
      "--regex       正则模式",
      "--glob        shell 通配符 (如 玄空*.pdf)",
      "--any-word    空格分词命中任意一个 (OR)",
      "--exact       整名精确匹配",
    ],
    examples: ['bdp search "报告"', 'bdp search "玄空*.pdf" --glob', 'bdp search "玄空.+pdf$" --regex --json'],
  },
  cat: {
    group: "pan",
    usage: "bdp cat <path>",
    desc: "读取文件内容（免下载，限 1MB）",
    flags: ["number"],
    options: ["-N 显示行号"],
    examples: ["bdp cat /文档/data.json"],
  },
  head: {
    group: "pan",
    usage: "bdp head [-n N] <path>",
    desc: "读取前 N 行（默认 20）",
    flags: ["n"],
    options: ["-n <N> 行数"],
    examples: ["bdp head -n 50 /文档/日志.txt"],
  },
  tail: {
    group: "pan",
    usage: "bdp tail [-n N] <path>",
    desc: "读取后 N 行（默认 20）",
    flags: ["n"],
    options: ["-n <N> 行数"],
    examples: ["bdp tail -n 30 /文档/log.txt"],
  },
  grep: {
    group: "pan",
    usage: "bdp grep <pattern> <path>",
    desc: "在文件内容中搜索",
    flags: ["i", "number"],
    options: ["-i 忽略大小写", "-N 显示行号"],
    examples: ["bdp grep 关键词 /文档/file.txt"],
  },
  peek: {
    group: "pan",
    usage: "bdp peek <path>",
    desc: "预览文件信息 + 前 10 行（含 md5/ctime）",
    flags: [],
    examples: ["bdp peek /文档/report.pdf --json"],
  },
  get: {
    group: "pan",
    usage: "bdp get <path> [-o dir]",
    desc: "下载文件（直链分块、size 校验、断点续传）",
    flags: ["o", "resume", "force", "progress", "noVerifySize", "dryRun", "concurrency", "fromUk", "msgId", "filename"],
    note: "路径为 <gid>:<fs_id> 时自动走群文件直下（免转存）",
    options: [
      "-o <dir>         输出目录（默认当前目录）",
      "--resume         断点续传（存在部分文件时自动）",
      "--force          覆盖重下",
      "--progress       实时进度 + 速度",
      "--no-verify-size 关闭下载后 size 校验",
      "--dry-run        模拟，不落盘",
      "--concurrency <N> 并发分块数 (默认3, 仅大文件; 1=串行)",
    ],
    examples: [
      "bdp get /文档/报告.pdf -o ./pdfs --progress",
      "bdp get /文档/大文件.zip --resume --json",
      "bdp get 539478953581833690:954615608563687 -o ./g",
    ],
  },
  put: {
    group: "pan",
    usage: "bdp put <local> <remote>",
    desc: "上传文件",
    flags: ["dryRun"],
    options: ["--dry-run 模拟"],
    examples: ["bdp put ./report.pdf /文档/"],
  },
  mkdir: {
    group: "pan",
    usage: "bdp mkdir <path>",
    desc: "创建目录",
    flags: [],
    examples: ["bdp mkdir /新项目"],
  },
  rm: {
    group: "pan",
    usage: "bdp rm <path>",
    desc: "删除文件/目录",
    flags: ["dryRun"],
    note: "⚠️ 高危操作，Agent 使用前必须用户确认",
    options: ["--dry-run 模拟"],
    examples: ["bdp rm /临时文件.txt"],
  },
  mv: {
    group: "pan",
    usage: "bdp mv <src> <dst>",
    desc: "移动/重命名文件/目录",
    flags: [],
    examples: ["bdp mv /文档/a.pdf /文档/b.pdf", "bdp mv /文档/a.pdf /备份/"],
  },
  cp: {
    group: "pan",
    usage: "bdp cp <src> <dst>",
    desc: "拷贝文件/目录",
    flags: [],
    examples: ["bdp cp /文档/a.pdf /备份/"],
  },
  quota: {
    group: "pan",
    usage: "bdp quota",
    desc: "网盘配额（总/已用/剩余）",
    flags: [],
    examples: ["bdp quota --json"],
  },
  du: {
    group: "pan",
    usage: "bdp du [path]",
    desc: "目录容量分析（递归统计，找空间大户）",
    flags: ["depth", "top", "concurrency"],
    options: [
      "--depth <N>        递归深度 (默认3)",
      "--top <N>          显示最大的 N 个子目录 (默认15)",
      "--concurrency <N>  并发扫描数 (默认8)",
    ],
    examples: ["bdp du /", "bdp du /玄学 --depth 4 --top 20", "bdp du / --json"],
  },
  offline: {
    group: "pan",
    usage: "bdp offline add <http_url> [--path /目录] | bdp offline list",
    desc: "离线下载（百度服务器代下）",
    flags: ["p"],
    options: ["--path <dir> 保存目录"],
    examples: ["bdp offline add http://example.com/big.iso --path /下载", "bdp offline list"],
  },
  recycle: {
    group: "pan",
    usage: "bdp recycle list | restore <fs_id>... | clean",
    desc: "回收站管理（列出/还原/清空）",
    flags: ["page"],
    note: "clean 清空不可恢复，使用前务必确认；BaiduPCS-Go 不二次确认",
    options: ["--page <N> 回收站列表页码 (默认1)"],
    examples: ["bdp recycle list", "bdp recycle restore 378804494923604", "bdp recycle clean"],
  },
  share: {
    group: "pan",
    usage: "bdp share set <path> [--pwd P] | bdp share cancel <id>... | bdp share list",
    desc: "分享管理（创建/取消/列出）",
    flags: ["pwd", "combined", "page"],
    note: "share list 受 BaiduPCS-Go v4.0.1 引擎 bug 限制（panic），用 share cancel 管理已知分享",
    options: ["--pwd <P>    提取码", "--combined  输出带提取码的链接"],
    examples: ["bdp share set /文档/报告.pdf --pwd 1234 --combined", "bdp share cancel 23220383577"],
  },
  groups: {
    group: "group",
    usage: "bdp groups",
    desc: "列出所有群组",
    flags: [],
    examples: ["bdp groups --json"],
  },
  gshares: {
    group: "group",
    usage: "bdp gshares <gid>",
    desc: "列出群内分享库",
    flags: ["noCache"],
    options: ["--no-cache 禁用缓存"],
    examples: ["bdp gshares 539478953581833690"],
  },
  gls: {
    group: "group",
    usage: "bdp gls <gid> <fs_id>",
    desc: "浏览分享库内容（分页）",
    flags: ["page", "pageSize", "fromUk", "msgId", "parentFsId", "noCache"],
    options: [
      "--page <N>         页码 (默认1)",
      "--page-size <N>    每页条数 (默认50, 最大100)",
      "--from-uk <X>      分享者 uk",
      "--msg-id <Y>       消息 id",
      "--parent-fs-id <Z> 父目录 fsId",
      "--no-cache         禁用缓存",
    ],
    examples: ["bdp gls 539478953581833690 742474845517885 --json"],
  },
  gtree: {
    group: "group",
    usage: "bdp gtree <gid>",
    desc: "构建群目录树（BFS）",
    flags: ["depth", "concurrency", "maxNodes", "maxPages", "maxRequests", "noCache"],
    options: ["--depth <N> 深度 (默认2)", "--concurrency <N> 并发 (默认4)", "--max-nodes <N> 节点上限 (默认2000)"],
    examples: ["bdp gtree 539478953581833690 --depth 3"],
  },
  gsearch: {
    group: "group",
    usage: "bdp gsearch <gid> <keyword>",
    desc: "搜索群文件名（全量遍历，缓存命中秒回）",
    flags: ["page", "limit", "concurrency", "unique", "noUnique", "all", "timeout", "timeoutMs", "savePartial", "anyWord", "exact", "depth", "maxPages", "maxRequests", "noCache"],
    note: "默认多关键词 AND（空格分词每词都需出现）；--any-word 切 OR",
    options: [
      "--page <N>          页码 (默认1)",
      "--limit <N>         每页条数 (默认50)",
      "--depth <N>         递归深度 (默认1)",
      "--concurrency <N>   并发扫描数 (默认4)",
      "--max-pages <N>     单目录最大页数 (默认50)",
      "--max-requests <N>  请求预算 (默认400)",
      "--all|--all-results 忽略分页取全部",
      "--timeout <N>       超时返回部分结果",
      "--save-partial      部分结果落盘",
      "--any-word          OR 模式",
      "--exact             整名匹配",
      "--no-unique         保留不同 msgId 重复项",
      "--no-cache          禁用缓存",
    ],
    examples: [
      'bdp gsearch 539478953581833690 "倪海厦" --limit 20 --json',
      'bdp gsearch 539478953581833690 "玄空 飞星" --json',
    ],
  },
  gdownload: {
    group: "group",
    usage: "bdp gdownload <gid> <fs_id>...",
    desc: "直接下载群文件（免转存）",
    flags: ["o", "filename", "fromUk", "msgId", "noCache"],
    note: "单 fs_id 直下；多个 fs_id（同一分享消息）自动 zip 打包",
    options: ["-o <dir> 输出目录", "--filename <NAME> zip 包名", "--from-uk <X>", "--msg-id <Y>", "--no-cache"],
    examples: [
      "bdp gdownload 539478953581833690 954615608563687 -o ./downloads --from-uk 1101635869133 --msg-id 713945176566573051",
      "bdp gdownload 539478953581833690 527948256537856 986718405708023 -o ./zips",
    ],
  },
  cache: {
    group: "group",
    usage: "bdp cache [clear]",
    desc: "查看/清空群会话缓存",
    flags: [],
    examples: ["bdp cache", "bdp cache clear"],
  },
  error: {
    group: "group",
    usage: "bdp error <code>",
    desc: "解释错误码",
    flags: [],
    examples: ["bdp error -3", "bdp error 31326"],
  },
  login: {
    group: "config",
    usage: "bdp login [--bduss X --stoken Y]",
    desc: "登录（浏览器扫码或手动凭证）",
    flags: ["bduss", "stoken"],
    options: ["--bduss <X> 手动凭证", "--stoken <Y> 手动凭证"],
    examples: ["bdp login", "bdp login --bduss abc123 --stoken def456"],
  },
  whoami: {
    group: "config",
    usage: "bdp whoami",
    desc: "查看登录状态与当前 profile",
    flags: [],
    examples: ["bdp whoami --json"],
  },
  config: {
    group: "config",
    usage: "bdp config",
    desc: "查看配置",
    flags: [],
    examples: ["bdp config"],
  },
  profile: {
    group: "config",
    usage: "bdp profile list | use <name> | unset",
    desc: "多账号 profile 管理",
    flags: [],
    note: "也可用全局参数 --profile <name> 切换（命令前/后均可）",
    examples: ["bdp --profile svip login", "bdp profile list"],
  },
  help: {
    group: "config",
    usage: "bdp help [command]",
    desc: "查看帮助（[command] 查看单命令详情；--json 结构化输出）",
    flags: [],
    examples: ["bdp help", "bdp help get", "bdp help --json"],
  },
};

const GROUP_LABELS = {
  pan: "PAN FILE OPERATIONS (全盘)",
  group: "GROUP CHAT OPERATIONS (群聊)",
  config: "CONFIGURATION",
};

// 全局选项（跨命令通用）；命令专属选项见各命令注册项
const GLOBAL_OPTIONS = [
  "--profile <name>    切换账号 profile（命令前/后均可）",
  "--json              JSON 结构化输出 (Agent 友好)",
  "--json-file <path>  JSON 写入文件 (UTF-8, 绕开控制台编码)",
  "--legacy-json       输出裸数组 (gls/gsearch legacy)",
  "--verbose           进度/日志只写 stderr",
];

// CJK 等宽字符按 2 列计（与 pcs-extra 的显示宽度规则一致）
function padWidth(str, width) {
  let w = 0;
  for (const ch of String(str)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return String(str) + " ".repeat(Math.max(0, width - w));
}

function buildHelp() {
  const lines = ["bdp — 百度网盘 CLI", "", "USAGE", "  bdp <command> [options] [arguments]", "  bdp help [command] — 单命令详情 (--json 结构化)", ""];
  for (const [gkey, label] of Object.entries(GROUP_LABELS)) {
    lines.push(label);
    for (const [name, c] of Object.entries(COMMANDS)) {
      if (c.group !== gkey) continue;
      // 总览只显示主用法（复合用法取 " | " 前段，完整版见 bdp help <command>）
      const usageLine = c.usage.includes(" | ") ? c.usage.split(" | ")[0] : c.usage;
      lines.push(`  ${padWidth(usageLine, 42)}${c.desc}`);
    }
    lines.push("");
  }
  lines.push("OPTIONS (全局)");
  for (const o of GLOBAL_OPTIONS) lines.push(`  ${o}`);
  lines.push("");
  lines.push("EXAMPLES（每个命令的典型用法，bdp help <command> 查看更多）");
  for (const [name, c] of Object.entries(COMMANDS)) {
    if (c.examples && c.examples[0]) lines.push(`  ${c.examples[0]}`);
  }
  return lines.join("\n") + "\n";
}

function buildCommandHelp(name) {
  const c = COMMANDS[name];
  if (!c) return null;
  const lines = [`bdp ${name} — ${c.desc}`, ""];
  if (c.note) {
    lines.push("NOTE");
    lines.push(`  ${c.note}`);
    lines.push("");
  }
  lines.push("USAGE");
  lines.push(`  ${c.usage}`);
  lines.push("");
  if (c.options && c.options.length) {
    lines.push("OPTIONS");
    for (const o of c.options) lines.push(`  ${o}`);
    lines.push("");
  }
  if (c.examples && c.examples.length) {
    lines.push("EXAMPLES");
    for (const ex of c.examples) lines.push(`  ${ex}`);
  }
  return lines.join("\n") + "\n";
}


// 全局通用选项（所有命令都接受）；命令专属选项见 COMMANDS[name].flags
const GLOBAL_FLAGS = ['json', 'jsonFile', 'legacyJson', 'verbose', 'profile'];

// 防呆：未知选项直接报错（agent 拼错参数立刻发现，而不是静默忽略）
function validateFlags(command, flags, cmdMeta) {
  if (!cmdMeta) return [];
  const allowed = new Set(GLOBAL_FLAGS.concat(cmdMeta.flags || []));
  return Object.keys(flags).filter((f) => !allowed.has(f));
}

const HELP = buildHelp();

cmds.help = async (args, json) => {
  const target = args._[0];
  if (target) {
    if (!COMMANDS[target]) {
      if (json || args.flags.jsonFile) {
        emitJson({ error: `未知命令: ${target}`, available: Object.keys(COMMANDS) }, args);
      } else {
        console.error(`[ERROR] 未知命令: ${target}。用 bdp help 查看全部命令。`);
      }
      process.exit(1);
    }
    const c = COMMANDS[target];
    if (json || args.flags.jsonFile) {
      emitJson({ name: target, ...c }, args);
    } else {
      console.log(buildCommandHelp(target));
    }
    return;
  }
  if (json || args.flags.jsonFile) {
    emitJson(
      {
        tool: "bdp",
        version: require("../package.json").version,
        usage: "bdp <command> [options] [arguments]",
        globalOptions: GLOBAL_OPTIONS,
        commands: Object.entries(COMMANDS).map(([name, c]) => ({ name, ...c })),
      },
      args
    );
  } else {
    console.log(HELP);
  }
};


async function main() {
  // Windows 控制台编码兜底：TTY 且非 UTF-8 代码页时切换 chcp 65001（幂等、静默失败）
  ensureUtf8Console();

  const argv = process.argv.slice(2);
  // 全局 --profile：支持 `bdp --profile <name> <cmd>`（命令前）或 `bdp <cmd> --profile <name>`（命令后）
  let rest = argv;
  let profileName;
  if (argv[0] === "--profile") {
    profileName = argv[1];
    rest = argv.slice(2);
  } else if (argv[0] && argv[0].startsWith("--profile=")) {
    profileName = argv[0].slice("--profile=".length);
    rest = argv.slice(1);
  }
  const command = rest[0];
  const args = parseArgs(rest.slice(1));
  const json = args.flags.json || false;

  // 切换账号 profile（须在命令 handler 之前，get()/isLoggedIn() 自动生效）
  const profile = profileName !== undefined ? profileName : args.flags.profile;
  if (profile !== undefined) {
    try {
      config.useProfile(profile);
    } catch (e) {
      console.error(`[ERROR] ${e.message}`);
      process.exit(1);
    }
  }

  const handler = cmds[command];
  if (!handler) {
    if (command) console.error(`[ERROR] 未知命令: ${command}（用 bdp help 查看全部命令，bdp help <命令> 查看用法）`);
    console.log(HELP);
    process.exit(command ? 1 : 0);
  }

  // 防呆：未知选项立即报错（避免 agent 拼错参数被静默忽略）
  const unknownFlags = validateFlags(command, args.flags, COMMANDS[command]);
  if (unknownFlags.length > 0) {
    console.error(`[ERROR] 命令 ${command} 不支持选项: --${unknownFlags.join(", --")}（bdp help ${command} 查看合法选项）`);
    process.exit(1);
  }

  let exitCode = 0;
  try {
    await handler(args, json);
  } catch (e) {
    if (json) {
      console.log(JSON.stringify({ error: e.message, ...(e.errno !== undefined ? { errno: e.errno } : {}) }));
    } else {
      console.error(`[ERROR] ${e.message}`);
    }
    exitCode = 1;
  } finally {
    try {
      require("../lib/browser-login").disconnectBrowserSession();
    } catch {}
  }
  process.exit(exitCode);
}

main();
