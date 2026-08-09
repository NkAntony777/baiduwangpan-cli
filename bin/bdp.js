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

function parseArgs(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.flags.json = true;
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
  if (args.flags.bduss) config.set("bduss", args.flags.bduss);
  if (args.flags.stoken) config.set("stoken", args.flags.stoken);
  const cfg = config.get();
  output(
    { success: true, bduss: cfg.bduss ? "***set***" : "missing", stoken: cfg.stoken ? "***set***" : "missing" },
    json,
    () => console.log("Credentials saved to " + config.CONFIG_FILE)
  );
};

cmds.whoami = async (args, json) => {
  const cfg = config.get();
  output(
    {
      loggedIn: !!(cfg.bduss && cfg.stoken),
      bduss: cfg.bduss ? "***set***" : "missing",
      stoken: cfg.stoken ? "***set***" : "missing",
      pcsPath: cfg.pcsPath,
      configFile: config.CONFIG_FILE,
    },
    json,
    (d) => {
      console.log(`Status:     ${d.loggedIn ? "✅ Logged in" : "❌ Not logged in"}`);
      console.log(`BDUSS:      ${d.bduss}`);
      console.log(`STOKEN:     ${d.stoken}`);
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
  const shares = await group.listShares(gid);
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
  if (!gid || !fsId) { console.error("Usage: bdp gls <gid> <fs_id>"); process.exit(1); }
  const result = await group.listFiles(gid, fsId, { page: args.flags.page || 1 });
  output(result, json, (d) => {
    console.log(`${d.files.length} items${d.hasMore ? " (has more — use --page)" : ""}:\n`);
    d.files.forEach((f) => {
      const dir = f.isDir ? "[DIR] " : "      ";
      console.log(`  ${dir}${f.name}  ${formatSize(f.size)}  fs_id:${f.fsId}`);
    });
  });
};

cmds.gsearch = async (args, json) => {
  const gid = args._[0];
  const keyword = args._[1];
  if (!gid || !keyword) { console.error("Usage: bdp gsearch <gid> <keyword>"); process.exit(1); }
  const results = await group.searchFiles(gid, keyword);
  output(results, json, (list) => {
    console.log(`${list.length} matches for "${keyword}":\n`);
    list.forEach((r) => {
      const dir = r.isDir ? "[DIR] " : "      ";
      console.log(`  ${dir}${r.path || r.name}  ${formatSize(r.size)}  fs_id:${r.fsId}`);
    });
  });
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
  gls <gid> <fs_id>          Browse files in a share
  gsearch <gid> <keyword>    Search group file names

CONFIGURATION
  login --bduss X --stoken Y  Save credentials
  whoami                       Check login status
  config                       Show configuration

OPTIONS
  --json                      Output JSON (for Agent consumption)
  -n <N>                      Number of lines (head/tail)
  -p <path>                   Search path (search)
  -i                          Ignore case (grep)
  -N                          Show line numbers (cat/grep)
  -o <dir>                    Output directory (get)
  --page <N>                  Page number (gls)

EXAMPLES
  bdp login --bduss abc123 --stoken def456
  bdp ls /
  bdp search "报告"
  bdp head -n 50 /文档/日志.txt
  bdp groups --json
  bdp gshares 539478953581833690
  bdp gls 539478953581833690 742474845517885 --json
  bdp gsearch 539478953581833690 "倪海厦"`;

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

  try {
    await handler(args, json);
  } catch (e) {
    if (json) {
      console.log(JSON.stringify({ error: e.message }));
    } else {
      console.error(`[ERROR] ${e.message}`);
    }
    process.exit(1);
  }
}

main();
