// lib/mcp.js — MCP (Model Context Protocol) 服务器（stdio 传输，JSON-RPC 2.0，换行分隔）
//
// 为什么要有它：CLI 的参数格式要靠 Agent 记住/猜测，而 MCP 客户端能自动发现
// 工具描述与参数 schema，参数类型由 schema 强约束。把 bdp 暴露成 MCP 之后，
// Agent 不再需要记忆"ls 的参数名是 path 还是 dir"。
//
// 协议要点（stdio 传输）：
//   - 每行一个 JSON-RPC 2.0 消息
//   - initialize           → 返回 protocolVersion / capabilities / serverInfo
//   - notifications/*      → 客户端通知，无需响应
//   - ping                 → 返回 {}
//   - tools/list           → 返回工具数组
//   - tools/call           → 执行工具，返回 { content:[{type:"text",text}], isError }

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "bdp";
const SERVER_VERSION = require("../package.json").version;

// 工具定义（tools/list 返回值）——描述写给 Agent 看，务必说清参数语义
function toolDefs() {
  return [
    {
      name: "bdp_ls",
      description: "列出百度网盘目录内容。返回结构化条目（name/path/isDir/size/mtime）。path 为网盘绝对路径，默认根目录 /。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "网盘目录绝对路径，如 /中医、/玄学" },
        },
      },
    },
    {
      name: "bdp_search",
      description: "按文件名递归搜索网盘。默认子串匹配；mode 可选 exact/regex/glob/any。返回分页结果（limit 默认 50）。",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词（必填）" },
          path: { type: "string", description: "限定搜索目录，默认 /" },
          mode: { type: "string", enum: ["substring", "exact", "regex", "glob", "any"], description: "匹配模式，默认 substring" },
          limit: { type: "number", description: "单页返回条数，默认 50" },
          page: { type: "number", description: "页码，默认 1" },
        },
        required: ["keyword"],
      },
    },
    {
      name: "bdp_read",
      description: "读取网盘文本文件的前 N 行（免下载）。自动处理 UTF-8/GBK 编码；二进制文件会报错而不是返回乱码。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "网盘文件绝对路径（必填）" },
          lines: { type: "number", description: "行数，默认 20" },
        },
        required: ["path"],
      },
    },
    {
      name: "bdp_preview",
      description: "多类型内容预览（尽量不下载整个文件）：PDF 抽取文本层（中文 CID 字体经 ToUnicode 还原）、ZIP 只读中央目录列成员、DOCX/XLSX/EPUB 抽正文、图片给尺寸。扫描件 PDF 会明确说明无文本层。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "网盘文件绝对路径（必填）" },
          maxBytes: { type: "number", description: "文本读取字节上限，默认 65536" },
          maxPages: { type: "number", description: "PDF 最多解析页数，默认 200" },
        },
        required: ["path"],
      },
    },
    {
      name: "bdp_dedup",
      description: "扫描网盘重复文件。先按 size 粗筛，再按反混淆后的真实 md5 精算（百度的 md5 经混淆，同内容在不同路径返回值不同）。返回重复簇与可释放空间；不会自动删除。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "扫描起始目录，默认 /" },
          depth: { type: "number", description: "扫描深度，默认 12" },
          top: { type: "number", description: "最多返回多少组，默认 20" },
        },
      },
    },
    {
      name: "bdp_ask",
      description: "基于本地全文索引检索网盘内容（需先运行 bdp index build）。中文用二元分词，命中返回文件路径与正文片段。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "自然语言查询（必填）" },
          limit: { type: "number", description: "返回条数，默认 20" },
          path: { type: "string", description: "只在该目录前缀下搜" },
        },
        required: ["query"],
      },
    },
    {
      name: "bdp_peek",
      description: "查看网盘文件元信息：大小、md5、修改时间、类型（text/pdf/zip/image…）、编码，以及前 10 行预览。",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "网盘文件绝对路径（必填）" } },
        required: ["path"],
      },
    },
    {
      name: "bdp_quota",
      description: "查询网盘配额：总空间/已用/剩余/使用率。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "bdp_get",
      description: "下载网盘文件到本地（分块并发 + size 校验 + 断点续传）。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "网盘文件路径（必填）" },
          outDir: { type: "string", description: "本地保存目录，默认当前目录" },
        },
        required: ["path"],
      },
    },
    {
      name: "bdp_put",
      description: "上传本地文件到网盘。",
      inputSchema: {
        type: "object",
        properties: {
          local: { type: "string", description: "本地文件路径（必填）" },
          remote: { type: "string", description: "网盘目标路径（必填）" },
        },
        required: ["local", "remote"],
      },
    },
    {
      name: "bdp_mkdir",
      description: "创建网盘目录（幂等：已存在不算失败）。",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "要创建的网盘目录路径（必填）" } },
        required: ["path"],
      },
    },
    {
      name: "bdp_groups",
      description: "列出所有百度网盘群组（gid + 群名）。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "bdp_gsearch",
      description: "在网盘群组的分享库里搜索文件名（全量遍历，带缓存）。",
      inputSchema: {
        type: "object",
        properties: {
          gid: { type: "string", description: "群组 gid（必填）" },
          keyword: { type: "string", description: "搜索关键词（必填）" },
          limit: { type: "number", description: "返回条数，默认 50" },
        },
        required: ["gid", "keyword"],
      },
    },
  ];
}

// 执行一个工具 → 返回可 JSON 序列化的结果对象
async function callTool(name, args = {}) {
  const pan = require("./pan");
  const group = require("./group");
  const pcsExtra = require("./pcs-extra");

  switch (name) {
    case "bdp_ls": {
      const info = pan.lsEntries(args.path || "/");
      return { path: info.path, total: info.entries.length, entries: info.entries };
    }
    case "bdp_search": {
      const mode = args.mode || "substring";
      let engineKeyword = args.keyword;
      if (mode === "regex" || mode === "glob") {
        const runs = String(args.keyword).split(/[.*+?^¶{}()|[\]\\*?]/).filter(Boolean);
        engineKeyword = runs.find((r) => r.length >= 2) || runs[0] || args.keyword;
      } else if (mode === "any") {
        engineKeyword = String(args.keyword).split(/\s+/)[0];
      }
      const info = pan.searchEntries(args.keyword, args.path || "/", { mode, engineKeyword });
      const limit = args.limit > 0 ? args.limit : 50;
      const page = args.page > 0 ? args.page : 1;
      const startIdx = (page - 1) * limit;
      const sliced = info.entries.slice(startIdx, startIdx + limit);
      return {
        keyword: info.keyword,
        mode: info.mode,
        total: info.matched,
        returned: sliced.length,
        page,
        pageSize: limit,
        hasMore: startIdx + sliced.length < info.matched,
        nextPage: startIdx + sliced.length < info.matched ? page + 1 : null,
        entries: sliced,
      };
    }
    case "bdp_read": {
      const lines = pan.head(args.path, args.lines > 0 ? args.lines : 20);
      return { path: args.path, lines: lines.length, content: lines.join("\n") };
    }
    case "bdp_preview": {
      const preview = require("./preview");
      const r = await preview.preview(args.path, {
        maxBytes: args.maxBytes > 0 ? args.maxBytes : undefined,
        maxPages: args.maxPages > 0 ? args.maxPages : undefined,
      });
      if (r.error) throw new Error(r.error);
      return r;
    }
    case "bdp_dedup": {
      const dedup = require("./dedup");
      const r = await dedup.scanDuplicates(args.path || "/", {
        maxDepth: args.depth > 0 ? args.depth : undefined,
      });
      const top = args.top > 0 ? args.top : 20;
      const clusters = dedup.pickKeepers(r.clusters, { keep: "shortest" });
      return {
        root: r.root,
        scannedFiles: r.scannedFiles,
        clusterCount: clusters.length,
        duplicateFiles: clusters.reduce((s, c) => s + c.files.length - 1, 0),
        wastedBytes: r.wastedBytes,
        clusters: clusters.slice(0, top).map((c) => ({
          size: c.size,
          md5: c.md5,
          wasted: c.wasted,
          keep: c.keep,
          removable: c.removable,
        })),
      };
    }
    case "bdp_ask": {
      const store = require("./index-store");
      const h = store.openIndex(args.db);
      try {
        const st = store.status(h);
        if (!st.files) throw new Error("索引为空，请先运行 bdp index build");
        const hits = store.search(h, args.query, {
          limit: args.limit > 0 ? args.limit : 20,
          dirPrefix: args.path,
        });
        return { query: args.query, indexFiles: st.files, total: hits.length, hits };
      } finally {
        h.close();
      }
    }
    case "bdp_peek": {
      return await pan.peek(args.path);
    }
    case "bdp_quota": {
      return pcsExtra.quota();
    }
    case "bdp_get": {
      return await pan.download(args.path, args.outDir, {});
    }
    case "bdp_put": {
      const raw = pan.upload(args.local, args.remote);
      return { local: args.local, remote: args.remote, ok: true, raw };
    }
    case "bdp_mkdir": {
      return pan.mkdir(args.path);
    }
    case "bdp_groups": {
      return await group.listGroups();
    }
    case "bdp_gsearch": {
      return await group.searchFiles(args.gid, args.keyword, {
        limit: args.limit > 0 ? args.limit : 50,
      });
    }
    default:
      throw new Error("未知工具: " + name);
  }
}

// JSON-RPC 响应
function reply(output, id, result) {
  output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(output, id, code, message) {
  output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleMessage(msg, output) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      reply(output, id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // 通知，无需响应
    case "ping":
      if (!isNotification) reply(output, id, {});
      return;
    case "tools/list":
      reply(output, id, { tools: toolDefs() });
      return;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await callTool(name, args);
        reply(output, id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // 工具执行失败 → isError:true（而不是 JSON-RPC error），客户端仍能读到内容
        reply(output, id, {
          content: [{ type: "text", text: "错误: " + e.message }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) {
        replyError(output, id, -32601, "Method not found: " + method);
      }
  }
}

/**
 * 启动 MCP 服务器（stdio）。
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} opts
 */
function startServer(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  let buffer = "";

  input.setEncoding("utf-8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 忽略非法行
      }
      Promise.resolve(handleMessage(msg, output)).catch((e) => {
        if (msg && msg.id !== undefined && msg.id !== null) {
          replyError(output, msg.id, -32603, e.message);
        }
      });
    }
  });
  input.on("end", () => {
    try { input.pause(); } catch {}
  });
  return { input, output };
}

module.exports = { startServer, callTool, toolDefs, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION };
