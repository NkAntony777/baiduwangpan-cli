#!/usr/bin/env node
/**
 * bdp.js — 百度网盘 Agent 友好工具
 * 依赖: BaiduPCS-Go (需已登录) + curl
 *
 * 原理:
 *   BaiduPCS-Go locate <path> → 获取 CDN 直链 (dlink)
 *   curl + Range header → 只读取需要的字节到 stdout
 *   百度 CDN 支持 HTTP 206 Partial Content
 *
 * 用法:
 *   node bdp.js search -k "报告"
 *   node bdp.js ls /
 *   node bdp.js cat /文档/报告.txt
 *   node bdp.js head -n 50 /文档/日志.log
 *   node bdp.js tail -n 30 /文档/日志.log
 *   node bdp.js grep "错误" /文档/日志.log
 *   node bdp.js peek /文档/report.pdf
 *   node bdp.js get /文档/data.json
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

// ── 配置 ──────────────────────────────────────────────
const BAIDU_PCS_CMD = process.env.BAIDUPCS_CMD || path.join(__dirname, "BaiduPCS-Go.exe");
const NETDISK_UA =
  process.env.NETDISK_UA ||
  "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;";
const MAX_CAT_BYTES = parseInt(process.env.BDP_MAX_CAT_BYTES || "1048576", 10); // 1MB
const DEFAULT_LINES = 20;
// ──────────────────────────────────────────────────────

function runPCS(args) {
  const result = spawnSync(BAIDU_PCS_CMD, args, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`[ERROR] Failed to run ${BAIDU_PCS_CMD}: ${result.error.message}`);
    console.error(`        Is BaiduPCS-Go installed and in PATH?`);
    process.exit(1);
  }
  if (result.stderr) {
    console.error(`[STDERR] ${result.stderr.trim()}`);
  }
  return result.stdout || "";
}

function getDlink(remotePath) {
  const output = runPCS(["locate", remotePath]);
  // 尝试匹配 URL
  const urlMatch = output.match(/https?:\/\/[^\s]+/g);
  if (urlMatch && urlMatch.length > 0) {
    // 返回第一个有效 URL
    return urlMatch[0].replace(/[,\s]+$/, "");
  }
  return null;
}

function getFileSize(remotePath) {
  const output = runPCS(["meta", remotePath]);
  // 匹配 "大小: xxx 字节" 或 "size: xxx"
  let match = output.match(/大小[::]\s*([\d,]+)/);
  if (match) return parseInt(match[1].replace(/,/g, ""), 10);
  match = output.match(/size[":\s]+(\d+)/i);
  if (match) return parseInt(match[1], 10);
  match = output.match(/(\d[\d,]*)\s*B\b/);
  if (match) return parseInt(match[1].replace(/,/g, ""), 10);
  return null;
}

function fetchRange(url, start, end) {
  // 使用 curl 获取部分内容
  const rangeArg = end !== null && end !== undefined ? `${start}-${end}` : `${start}-`;
  const result = spawnSync("curl", [
    "-s", "-L",
    "-r", rangeArg,
    "-H", `User-Agent: ${NETDISK_UA}`,
    "-H", `Range: bytes=${rangeArg}`,
    "--max-time", "30",
    url,
  ], {
    maxBuffer: MAX_CAT_BYTES + 1024,
  });

  if (result.error) {
    console.error(`[ERROR] curl failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && result.status !== 22) {
    // curl 退出码 22 = HTTP error (可能是正常的 206)
    const stderr = result.stderr.toString("utf-8").trim();
    if (stderr) console.error(`[ERROR] curl: ${stderr}`);
  }
  return result.stdout;
}

function decodeText(buf) {
  for (const enc of ["utf-8", "gbk", "gb2312", "latin-1"]) {
    try {
      return buf.toString(enc);
    } catch {
      continue;
    }
  }
  return buf.toString("utf-8");
}

// ── 命令实现 ───────────────────────────────────────────

function cmdCat(args) {
  const size = getFileSize(args.path);
  if (size && size > 50 * 1024 * 1024) {
    console.error(`[WARN] File is ${(size / 1024 / 1024).toFixed(1)}MB, truncating to ${(MAX_CAT_BYTES / 1024).toFixed(0)}KB`);
  }

  const dlink = getDlink(args.path);
  if (!dlink) {
    console.error(`[ERROR] Cannot get dlink for: ${args.path}`);
    process.exit(1);
  }

  const readBytes = Math.min(size || MAX_CAT_BYTES, MAX_CAT_BYTES) - 1;
  const data = fetchRange(dlink, 0, readBytes);
  const text = decodeText(data);

  if (args.number) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      console.log(`${String(i + 1).padStart(6)}  ${line}`);
    });
  } else {
    process.stdout.write(text);
  }
}

function cmdHead(args) {
  const n = args.lines;
  const dlink = getDlink(args.path);
  if (!dlink) {
    console.error(`[ERROR] Cannot get dlink for: ${args.path}`);
    process.exit(1);
  }

  const chunkSize = Math.min(n * 4096 + 1024, MAX_CAT_BYTES);
  const data = fetchRange(dlink, 0, chunkSize - 1);
  const text = decodeText(data);
  const lines = text.split("\n");

  lines.slice(0, n).forEach((line) => console.log(line));
}

function cmdTail(args) {
  const n = args.lines;
  const size = getFileSize(args.path);
  if (!size) {
    console.error(`[ERROR] Cannot get file size for: ${args.path}`);
    process.exit(1);
  }

  const dlink = getDlink(args.path);
  if (!dlink) {
    console.error(`[ERROR] Cannot get dlink for: ${args.path}`);
    process.exit(1);
  }

  const chunkSize = Math.min(n * 4096 + 1024, MAX_CAT_BYTES, size);
  const start = Math.max(0, size - chunkSize);
  const data = fetchRange(dlink, start, size - 1);
  const text = decodeText(data);
  const lines = text.split("\n");

  lines.slice(-n).forEach((line) => console.log(line));
}

function cmdGrep(args) {
  const dlink = getDlink(args.path);
  if (!dlink) {
    console.error(`[ERROR] Cannot get dlink for: ${args.path}`);
    process.exit(1);
  }

  const data = fetchRange(dlink, 0, MAX_CAT_BYTES - 1);
  const text = decodeText(data);

  let pattern;
  try {
    const flags = args.ignore_case ? "gi" : "g";
    pattern = new RegExp(args.pattern, flags);
  } catch (e) {
    pattern = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  }

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (pattern.test(line)) {
      if (args.line_number) {
        console.log(`${args.path}:${i + 1}:${line}`);
      } else {
        console.log(line);
      }
    }
    pattern.lastIndex = 0;
  });
}

function cmdPeek(args) {
  const size = getFileSize(args.path);
  const dlink = getDlink(args.path);

  console.log(`Path:   ${args.path}`);
  console.log(`Size:   ${size ? size.toLocaleString() + " bytes (" + (size / 1024).toFixed(1) + " KB)" : "unknown"}`);
  console.log(`Dlink:  ${dlink ? "✅ available" : "❌ not available"}`);

  if (dlink) {
    const previewBytes = Math.min(512, size || 512) - 1;
    const data = fetchRange(dlink, 0, previewBytes);
    const text = decodeText(data);

    // 检测二进制
    const sample = data.slice(0, 200);
    let isBinary = false;
    for (const b of sample) {
      if (b < 9 || (b > 13 && b < 32)) {
        isBinary = true;
        break;
      }
    }

    if (isBinary) {
      console.log("Type:   Binary file (preview skipped)");
    } else {
      const previewLines = text.split("\n").slice(0, 10);
      console.log(`\n── Preview (first ${previewLines.length} lines) ──`);
      previewLines.forEach((line) => console.log(line));
    }
  }
}

function cmdSearch(args) {
  const output = runPCS(["search", `-path=${args.path}`, "-r", args.keyword]);
  console.log(output);
}

function cmdLs(args) {
  const output = runPCS(["ls", args.path]);
  console.log(output);
}

function cmdGet(args) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp_"));
  const output = runPCS(["d", args.path, "--saveto", tmpDir]);
  const files = fs.readdirSync(tmpDir);
  if (files.length > 0) {
    const localPath = path.join(tmpDir, files[0]);
    console.log(localPath);
  } else {
    console.error("[ERROR] Download failed");
    process.exit(1);
  }
}

// ── CLI ────────────────────────────────────────────────

function printHelp() {
  console.log(`
bdp.js — 百度网盘 Agent 友好工具
依赖: BaiduPCS-Go (需已登录) + curl

用法:
  node bdp.js search -k "报告"              全盘搜索文件名
  node bdp.js ls /                          列出目录
  node bdp.js cat <path>                    读取文件内容 (不下载, 限1MB)
  node bdp.js head -n 50 <path>             读取前 N 行
  node bdp.js tail -n 30 <path>             读取后 N 行
  node bdp.js grep "关键词" <path>          在文件中搜索
  node bdp.js peek <path>                   预览文件信息
  node bdp.js get <path>                    下载文件，输出本地路径

选项:
  cat -n                   显示行号
  head -n <N>              行数 (默认 20)
  tail -n <N>              行数 (默认 20)
  grep -i                  忽略大小写
  grep -n                  显示行号

环境变量:
  BAIDUPCS_CMD             BaiduPCS-Go 路径 (默认: BaiduPCS-Go)
  NETDISK_UA               User-Agent 字符串
  BDP_MAX_CAT_BYTES        cat 最大读取字节 (默认: 1048576)
`);
}

const command = process.argv[2];
const rest = process.argv.slice(3);

function parseSimpleArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-")) {
      const key = arg.replace(/^-+/, "");
      if (key === "n" || key === "lines") {
        opts.lines = parseInt(argv[++i], 10) || DEFAULT_LINES;
      } else if (key === "k" || key === "keyword") {
        opts.keyword = argv[++i];
      } else if (key === "p" || key === "path") {
        opts.path = argv[++i];
      } else if (key === "i" || key === "ignore-case") {
        opts.ignore_case = true;
      } else if (key === "number" || key === "line-number") {
        opts.number = true;
        opts.line_number = true;
      } else {
        opts[key.replace(/-/g, "_")] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

switch (command) {
  case "search": {
    const opts = parseSimpleArgs(rest);
    cmdSearch({ keyword: opts.keyword, path: opts.path || "/" });
    break;
  }
  case "ls": {
    const opts = parseSimpleArgs(rest);
    cmdLs({ path: opts._[0] || "/" });
    break;
  }
  case "cat": {
    const opts = parseSimpleArgs(rest);
    if (!opts._[0]) { console.error("Usage: cat <path>"); process.exit(1); }
    cmdCat({ path: opts._[0], number: opts.number || false });
    break;
  }
  case "head": {
    const opts = parseSimpleArgs(rest);
    if (!opts._[0]) { console.error("Usage: head <path>"); process.exit(1); }
    cmdHead({ path: opts._[0], lines: opts.lines || DEFAULT_LINES });
    break;
  }
  case "tail": {
    const opts = parseSimpleArgs(rest);
    if (!opts._[0]) { console.error("Usage: tail <path>"); process.exit(1); }
    cmdTail({ path: opts._[0], lines: opts.lines || DEFAULT_LINES });
    break;
  }
  case "grep": {
    const opts = parseSimpleArgs(rest);
    if (opts._.length < 2) { console.error("Usage: grep <pattern> <path>"); process.exit(1); }
    cmdGrep({ pattern: opts._[0], path: opts._[1], ignore_case: opts.ignore_case || false, line_number: opts.line_number || false });
    break;
  }
  case "peek": {
    const opts = parseSimpleArgs(rest);
    if (!opts._[0]) { console.error("Usage: peek <path>"); process.exit(1); }
    cmdPeek({ path: opts._[0] });
    break;
  }
  case "get": {
    const opts = parseSimpleArgs(rest);
    if (!opts._[0]) { console.error("Usage: get <path>"); process.exit(1); }
    cmdGet({ path: opts._[0] });
    break;
  }
  default:
    printHelp();
    break;
}
