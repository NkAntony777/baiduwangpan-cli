#!/usr/bin/env node

/**
 * bdp — 百度网盘统一 CLI 工具
 *
 * 网盘文件操作:
 *   bdp ls [path]                  列出目录
 *   bdp search <keyword> [-p dir]  全盘搜索
 *   bdp cat <path>                 读取文件内容（免下载）
 *   bdp head [-n N] <path>         读取前 N 行
 *   bdp tail [-n N] <path>         读取后 N 行
 *   bdp grep <pattern> <path>      搜索文件内容
 *   bdp peek <path>                预览文件信息
 *   bdp get <path> [-o dir]        下载文件
 *   bdp put <local> <remote>       上传文件
 *   bdp mkdir <path>               创建目录
 *   bdp rm <path>                  删除文件
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

// ── Utils ──────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
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
    },
    json,
    (d) => {
      console.log(`Status:     ${d.loggedIn ? "✅ Logged in" : "❌ Not logged in"}`);
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

cmds.search = async (args, json) => {
  const keyword = args.flags.k || args._[0] || "";
  const searchPath = args.flags.p || "/";
  if (!keyword) { console.error("Usage: bdp search <keyword> [-p /path]"); process.exit(1); }
  const raw = pan.search(keyword, searchPath);
  if (json) {
    console.log(JSON.stringify({ keyword, path: searchPath, raw }));
  } else {
    console.log(raw);
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
  const info = pan.peek(filePath);
  output(info, json, (d) => {
    console.log(`Path:   ${d.path}`);
    console.log(`Size:   ${d.size ? formatSize(d.size) : "unknown"}`);
    console.log(`Type:   ${d.type || (d.isDir ? "directory" : "unknown")}`);
    console.log(`Dlink:  ${d.dlink ? "✅" : "❌"}`);
    if (d.preview) {
      console.log(`\n── Preview ──`);
      d.preview.forEach((l) => console.log(l));
    }
  });
};

cmds.get = async (args, json) => {
  const filePath = args._[0];
  if (!filePath) { console.error("Usage: bdp get <path> [-o dir]"); process.exit(1); }
  const saveTo = args.flags.o;
  const raw = pan.download(filePath, saveTo);
  output({ path: filePath, savedTo: saveTo || "default", raw }, json, () => console.log(raw));
};

cmds.put = async (args, json) => {
  const local = args._[0];
  const remote = args._[1];
  if (!local || !remote) { console.error("Usage: bdp put <local> <remote>"); process.exit(1); }
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
  const raw = pan.remove(filePath);
  output({ path: filePath, raw }, json, () => console.log(raw));
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
    "-3": "群分享 API 拒绝请求。已观察到大目录、错误的 msgId/fromUk、过期分享、请求过于频繁(限流)都可能触发。\n" +
          "处理：减小 --page-size（自动重试 50→20→10）或 --concurrency；\n" +
          "      限流表现为 errno=0 但只返回目录自身（self-echo），工具会自动退避重试(1s/2s)；\n" +
          "      大目录已支持自动全页遍历（每页上限 100，--max-pages 控制页数）；\n" +
          "      若回退到父目录（fallback level=parent），Agent 应从父目录换路径继续遍历。",
    "-6": "接口鉴权失败。通常为 access_token/cookie 失效，请重新执行 bdp login。",
    "2131": "群分享 msg_id 不属于该群（shareinfo 以 msg_id 为查找键，from_uk 不参与校验）。\n" +
            "常见原因：gid 与 --from-uk/--msg-id/--parent-fs-id 来自不同群/分享库（参数错配）。\n" +
            "处理：用 bdp gshares <gid> 查看本群分享（或 bdp gsearch <gid> <关键词>），\n" +
            "      取其中一行的 fsId/fromUk/msgId 重试，保证 gid/fsId/fromUk/msgId 同源；\n" +
            "      fsId 为子目录时保持其父分享行的 fromUk/msgId 不变；\n" +
            "      或去掉 --from-uk/--msg-id 让 CLI 自动解析（仅顶层分享）。\n" +
            "      工具已支持：显式参数错配时自动按 fsId 纠正（结果含 autoResolved:true）。",
  };
  const msg = ERRORS[code] || `未知错误码 ${code}，请提交 Issue: https://github.com/NkAntony777/baiduwangpan-cli/issues`;
  if (args.flags.jsonFile || json) {
    emitJson({ code, description: msg }, args);
  } else {
    console.log(msg);
  }
};

// ── Main ───────────────────────────────────────────────

const HELP = `bdp — 百度网盘 CLI

USAGE
  bdp <command> [options] [arguments]

PAN FILE OPERATIONS (全盘)
  ls [path]                  List directory
  search <keyword> [-p dir]  Search files by name
  cat <path>                 Read file content (no download, max 1MB)
  head [-n N] <path>         Read first N lines (default 20)
  tail [-n N] <path>         Read last N lines (default 20)
  grep <pattern> <path>      Search inside file content
  peek <path>                Preview file info + first lines
  get <path> [-o dir]        Download file
  put <local> <remote>       Upload file
  mkdir <path>               Create directory
  rm <path>                  Delete file/dir

GROUP CHAT OPERATIONS (群聊)
  groups                     List all groups
  gshares <gid>              List share libraries in group
  gtree <gid>                Build directory tree (BFS)
                             [--depth N] [--concurrency N] [--max-nodes N]
  gls <gid> <fs_id>          Browse files in a share
                             [--page N] [--page-size N] [--from-uk X] [--msg-id Y] [--parent-fs-id Z]
  gsearch <gid> <keyword>    Search group file names (全量遍历目录, 缓存命中秒回)
                             [--page N] [--limit N] [--depth N] [--concurrency N]
                             [--max-pages N] [--max-requests N] [--no-unique]
                             [--all|--all-results] [--timeout N] [--save-partial]
                             [--any-word] [--exact] [--no-cache]
  gdownload <gid> <fs_id>...  Direct download group files (免转存, 逆向 sharedownload API)
                             single fs_id → direct file; multiple fs_ids → zip 打包 (type=batch)
                             [--from-uk X] [--msg-id Y] [-o dir] [--filename NAME]
  cache [clear]              Show cache info or clear session cache
  error <code>               Explain an error code (e.g. -3)

CONFIGURATION
  login                        Browser QR login (auto-detect cookies)
  login --bduss X --stoken Y   Save credentials manually
  whoami                       Check login status
  config                       Show configuration

OPTIONS
  --json                      Output JSON (for Agent consumption)
  --json-file <path>          Write JSON to file (UTF-8, bypasses console encoding)
  --legacy-json               Output bare array (gls/gsearch legacy format)
  --verbose                   Write progress/log to stderr only
  -n <N>                      Number of lines (head/tail)
  -p <path>                   Search path (search)
  -i                          Ignore case (grep)
  -N                          Show line numbers (cat/grep)
  -o <dir>                    Output directory (get)
  --page <N>                  Page number (gls/gsearch)
  --page-size <N>             Page size for gls (default 50, max 100)
  --limit <N>                 Page size for gsearch (default 50)
  --depth <N>                 Recursive search/tree depth (gsearch default 1, gtree default 2)
  --max-nodes <N>             Tree node cap (gtree default 2000)
  --max-pages <N>             Max pages per directory scan (gsearch/gtree default 50, 100 items/page)
  --max-requests <N>          Request budget per command (gsearch/gtree default 400, prevents throttle)
  --concurrency <N>           Parallel share scans for gsearch/gtree (default 4)
  --no-cache                  Disable in-process session cache (gsearch/gtree/gshares/gls)
  --no-unique                 Keep duplicates from different msgId (gsearch)
  --all, --all-results        Fetch all results, no paging (gsearch; slow but never truncates)
  --timeout <N>               Abort after N seconds and return partial results (gsearch; 0=unlimited)
  --save-partial              Auto-save partial results to JSON when scan is incomplete (gsearch)
  --any-word                  Match ANY of the space-separated keywords (OR) (gsearch; default=ALL)
  --exact                     Match exact file name (case-insensitive) instead of substring (gsearch)

EXAMPLES
  bdp login --bduss abc123 --stoken def456
  bdp ls /
  bdp search "报告"
  bdp head -n 50 /文档/日志.txt
  bdp groups --json
  bdp gshares 539478953581833690
  bdp gls 539478953581833690 742474845517885 --json
  bdp gls 539478953581833690 292608024165826 --from-uk 2642611875 --msg-id 5069931974377329661 --json
  bdp gsearch 539478953581833690 "倪海厦" --limit 20 --json
  bdp gsearch 539478953581833690 "古籍" --page 2 --limit 20 --json-file result.json
  bdp gdownload 539478953581833690 954615608563687 -o ./downloads --from-uk 1101635869133 --msg-id 713945176566573051
  bdp gdownload 539478953581833690 527948256537856 986718405708023 -o ./zips   # 多文件 zip 打包下载
  bdp error -3`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  const args = parseArgs(rest);
  const json = args.flags.json || false;

  const handler = cmds[command];
  if (!handler) {
    console.log(HELP);
    process.exit(0);
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
