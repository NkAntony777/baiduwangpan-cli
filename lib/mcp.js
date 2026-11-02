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

const { sanitizeControl, sanitizeUntrusted } = require("./sanitize");

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
      name: "bdp_move",
      description: "移动/重命名网盘文件或目录（等价于 bdp mv）。dst 若是已存在的目录则移入其中，否则视为新路径。整理内容时用它把文件归位。",
      inputSchema: {
        type: "object",
        properties: {
          src: { type: "string", description: "源路径（必填）" },
          dst: { type: "string", description: "目标路径（必填）" },
        },
        required: ["src", "dst"],
      },
    },
    {
      name: "bdp_copy",
      description: "拷贝网盘文件或目录（等价于 bdp cp）。用于整理前的备份。",
      inputSchema: {
        type: "object",
        properties: {
          src: { type: "string", description: "源路径（必填）" },
          dst: { type: "string", description: "目标路径（必填）" },
        },
        required: ["src", "dst"],
      },
    },
    {
      name: "bdp_remove",
      description: "删除网盘文件/目录（等价于 bdp rm）。**走百度回收站，可恢复**。高危操作，建议先用 bdp_dedup / bdp_organize 评估影响范围。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的路径（必填）" },
          confirm: { type: "boolean", description: "必须显式传 true 才会执行删除（防误删）" },
        },
        required: ["path", "confirm"],
      },
    },
    {
      name: "bdp_rename",
      description: "批量重命名网盘文件（按规则）。规则形如 \"2024_report.pdf -> 2024年报告.pdf\"，用 \"=>\" 分隔旧名与新名。files 为 [{from,to}] 数组。只改文件名，不动目录。",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "重命名清单，每项 {from: 完整路径, to: 新文件名或完整新路径}",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
              },
              required: ["from", "to"],
            },
          },
          dryRun: { type: "boolean", description: "只预览不执行，默认 true" },
        },
        required: ["files"],
      },
    },
    {
      name: "bdp_organize",
      description: "网盘内容整理：按类型/年份/来源生成归类方案。默认只返回计划（不移动任何文件）；本工具不会执行移动，需要用户确认后另行用 bdp organize --apply --yes。同名目标会自动加序号去重。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "扫描起始目录，默认 /" },
          byType: { type: "boolean", description: "按文件类型归类（文档/图片/视频/压缩包/代码/数据…）" },
          byYear: { type: "boolean", description: "按修改年份归类" },
          bySource: { type: "boolean", description: "按来源目录归类" },
          target: { type: "string", description: "目标根目录，默认 /归档" },
          layout: { type: "string", enum: ["type-year", "year-type", "type-source", "source-type", "year-source", "source-year"], description: "层级顺序，默认 type-year" },
          depth: { type: "number", description: "扫描深度，默认 12（与 CLI 一致）" },
          limit: { type: "number", description: "返回计划条数，默认 50" },
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
//
// 返回值里的字符串全部来自网盘（文件名 / 正文 / 命中片段），属于**不可信数据**：
//   - 统一剔除控制字符与 Unicode 格式字符（防终端注入、扩展名伪装）
//   - 正文类字段额外包上 <untrusted_file>…</untrusted_file> 边界标记（防间接提示注入）
async function callTool(name, args = {}) {
  const result = await executeTool(name, args);
  return sanitizeToolResult(name, result);
}

// 深层清洗：所有字符串都过一遍 sanitizeControl
function sanitizeDeep(value) {
  if (typeof value === "string") return sanitizeControl(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeDeep(value[k]);
    return out;
  }
  return value;
}

// 承载「文件正文/片段」的字段：额外加边界标记
const UNTRUSTED_TEXT_FIELDS = {
  bdp_read: ["content"],
  bdp_preview: ["text"],
  bdp_peek: ["preview"],
};

// 命中列表里的正文片段字段
const UNTRUSTED_HIT_FIELDS = {
  bdp_ask: ["snippet"],
};

function sanitizeToolResult(name, result) {
  if (result === null || result === undefined) return result;
  const out = sanitizeDeep(result);
  const fields = UNTRUSTED_TEXT_FIELDS[name];
  if (fields && out && typeof out === "object") {
    for (const f of fields) {
      if (typeof out[f] === "string") {
        out[f] = sanitizeUntrusted(out[f], "file");
      } else if (Array.isArray(out[f])) {
        out[f] = out[f].map((v) => (typeof v === "string" ? sanitizeUntrusted(v, "file") : v));
      }
    }
  }
  const hitFields = UNTRUSTED_HIT_FIELDS[name];
  if (hitFields && out && Array.isArray(out.hits)) {
    out.hits = out.hits.map((h) => {
      if (!h || typeof h !== "object") return h;
      const c = { ...h };
      for (const f of hitFields) {
        if (typeof c[f] === "string") c[f] = sanitizeUntrusted(c[f], "file");
      }
      return c;
    });
  }
  return out;
}

// 真正的工具实现（原 callTool 主体）
async function executeTool(name, args = {}) {
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
        // 扫描完整性：扫描失败/截断时必须让调用方看见，否则会以为「已经扫干净了」
        scanPartial: r.partial,
        scanPagedOut: r.pagedOut,
        scanDepthCapped: r.depthCapped,
        scanFailedDirCount: r.failedDirs,
        scanFailedDirs: (r.failedDirPaths || []).slice(0, 20),
        scanBadEntries: r.badEntries,
        scanDepthLimit: r.depthLimit,
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
    case "bdp_move": {
      return pcsExtra.mv(args.src, args.dst);
    }
    case "bdp_copy": {
      return pcsExtra.cp(args.src, args.dst);
    }
    case "bdp_remove": {
      if (args.confirm !== true) {
        throw new Error("删除需要显式确认：请传 confirm=true（删除走百度回收站，可恢复）");
      }
      const results = pan.remove([args.path]);
      const r = results[0];
      if (!r || !r.ok) {
        throw new Error("删除失败: " + ((r && r.error) || "未知错误"));
      }
      return {
        removed: args.path,
        recoverable: true,
        note: "已移入百度回收站，可用 bdp recycle list 查看 / bdp recycle restore 恢复",
      };
    }
    case "bdp_rename": {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) throw new Error("files 不能为空");
      const dryRun = args.dryRun !== false;
      const results = [];
      for (const f of files) {
        if (!f || !f.from || !f.to) {
          results.push({ from: f && f.from, ok: false, error: "缺少 from/to" });
          continue;
        }
        // 只允许改文件名：目标不得带路径分隔符，跨目录移动必须显式用 bdp_move。
        // 否则「重命名」实际等于「移动到网盘任意位置」，超出工具描述承诺的边界。
        const rawTo = String(f.to);
        if (/[\\/]/.test(rawTo)) {
          results.push({
            from: f.from,
            to: rawTo,
            ok: false,
            error: "只允许改文件名（目标不能含 / 或 \\）；跨目录移动请用 bdp_move",
          });
          continue;
        }
        const fromPath = String(f.from);
        const cut = fromPath.lastIndexOf("/");
        const dir = cut >= 0 ? fromPath.slice(0, cut) : "";
        const to = dir + "/" + rawTo;
        if (to === f.from) {
          results.push({ from: f.from, to, ok: true, skipped: true, reason: "名称未变" });
          continue;
        }
        if (dryRun) {
          results.push({ from: f.from, to, ok: true, dryRun: true });
          continue;
        }
        try {
          const rr = pcsExtra.mv(f.from, to);
          results.push({ from: f.from, to, ok: true, op: rr.op });
        } catch (e) {
          results.push({ from: f.from, to, ok: false, error: e.message });
        }
      }
      return {
        dryRun,
        total: results.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    }
    case "bdp_organize": {
      const organize = require("./organize");
      const dedup = require("./dedup");
      const root = args.path || "/";
      const rules = {
        byType: !!args.byType,
        byYear: !!args.byYear,
        bySource: !!args.bySource,
        sourceRoot: root,
        targetRoot: args.target || "/归档",
        layout: args.layout || "type-year",
      };
      if (!rules.byType && !rules.byYear && !rules.bySource) {
        throw new Error("必须至少指定一个归类维度：byType / byYear / bySource");
      }
      if (rules.layout && !organize.LAYOUTS.includes(rules.layout)) {
        throw new Error("layout 取值非法: " + rules.layout + "（可选：" + organize.LAYOUTS.join(" | ") + "）");
      }
      // 深度必须与 CLI 一致（此前硬编码 6，CLI 是 12 —— 同一目录两个通道文件数差 41%）
      const scan = await dedup.scanFiles(root, { maxDepth: args.depth > 0 ? args.depth : undefined });
      const result = organize.buildPlan(scan.files, rules);
      const limit = args.limit > 0 ? args.limit : 50;
      return {
        root,
        rules: { byType: rules.byType, byYear: rules.byYear, bySource: rules.bySource, targetRoot: rules.targetRoot, layout: rules.layout },
        scannedFiles: scan.files.length,
        // 扫描完整性：否则「计划只覆盖了一部分」这件事对调用方是不可见的
        scanPartial: scan.partial,
        scanPagedOut: scan.pagedOut,
        scanDepthCapped: scan.depthCapped,
        scanFailedDirCount: scan.failed,
        scanFailedDirs: (scan.failedDirs || []).slice(0, 20),
        scanDepthLimit: scan.depthLimit,
        summary: result.summary,
        plan: result.plan.slice(0, limit),
        planTruncated: result.plan.length > limit,
        note: scan.partial
          ? "这是计划，尚未移动任何文件。执行需用户确认后运行 bdp organize --apply --yes。注意：扫描不完整（计划只覆盖已扫到的文件）"
          : "这是计划，尚未移动任何文件。执行需用户确认后运行 bdp organize --apply --yes",
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

// MCP HTTP 服务器的并发闸门：把突发并发压到可配置上限，
// 避免把百度 API 打爆触发风控（errno=-3「请求过于频繁」）。
const MAX_CONCURRENT_TOOLS = Math.max(1, parseInt(process.env.BDP_MCP_MAX_CONCURRENCY || "4", 10) || 4);
let inflightTools = 0;
const toolWaiters = [];
async function acquireToolSlot() {
  if (inflightTools < MAX_CONCURRENT_TOOLS) { inflightTools++; return; }
  await new Promise((resolve) => toolWaiters.push(resolve));
  inflightTools++;
}
function releaseToolSlot() {
  inflightTools--;
  const next = toolWaiters.shift();
  if (next) next();
}

// opts.compact：HTTP 传输用紧凑 JSON（载荷实测小 36%）；stdio 保持 pretty 便于人读
async function handleMessage(msg, output, opts = {}) {
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
          content: [{ type: "text", text: opts.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2) }],
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

/**
 * MCP over HTTP（POST /mcp）。
 *
 * 为什么需要：stdio 传输只能由本机子进程接入；
 * 独立运行的 agent（IDE 插件、远程 agent、脚本）需要网络端点。
 *
 * 安全设计（重要）：
 *   1. **只绑定 127.0.0.1** —— 默认不对外网暴露。
 *      想对外暴露必须显式 --host 0.0.0.0，且强烈建议配合反向代理。
 *   2. **令牌认证** —— 启动时生成随机令牌，客户端必须带
 *      `Authorization: Bearer <token>` 或 `?token=`。
 *   3. 令牌只打印一次，不落盘（除非用户显式指定 --token-file）。
 *   4. 不启用 CORS（默认同源），避免被恶意网页跨源调用。
 *
 * 端点：
 *   POST /mcp    JSON-RPC 2.0 请求体（标准 MCP HTTP 传输）
 *   GET  /health  健康检查（无需令牌）
 */
const http = require("http");
const crypto = require("crypto");

/**
 * 启动 HTTP MCP 服务器。
 * @param {object} opts { port, host, token, tokenFile }
 * @returns {Promise<{ server: http.Server, port: number, token: string, close: Function }>}
 */
async function startHttpServer(opts = {}) {
  const host = opts.host || "127.0.0.1";
  const port = opts.port || 0;
  const token = opts.token || crypto.randomBytes(24).toString("hex");

  const server = http.createServer((req, res) => {
    // 健康检查：无需令牌，便于探活
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      // 不回显版本号/工具数：免令牌端点应尽量少泄露指纹
      res.end(JSON.stringify({
        ok: true,
        server: SERVER_NAME,
        transport: "http",
      }));
      return;
    }

    if (req.method !== "POST" || !req.url.startsWith("/mcp")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found（可用端点：POST /mcp, GET /health）" }));
      return;
    }

    // 令牌校验
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const urlToken = new URL(req.url, "http://localhost").searchParams.get("token") || "";
    const provided = bearer || urlToken;
    if (!provided || !timingSafeEqualStr(provided, token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权：缺少或错误的令牌" }));
      return;
    }

    // 读请求体。上限按**字节**计：字符串 length 是 UTF-16 码元数，
    // 纯中文请求体会让实际字节数放大到上限的 3 倍。
    const MAX_BODY = 8 * 1024 * 1024;
    let body = "";
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      if (tooLarge) return; // 超限后不再累积
      bytes += Buffer.byteLength(chunk, "utf-8");
      body += chunk;
      if (bytes > MAX_BODY) {
        tooLarge = true;
        body = "";
        // 继续把剩余数据读完并丢弃，等请求正常结束后再回 413 ——
        // 在客户端还在上传时直接断连，客户端只会看到 ECONNRESET 而不是 413。
        req.resume();
      }
    });
    req.on("end", async () => {
      if (tooLarge) {
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "请求体过大（上限 8MB）" }));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }));
        return;
      }
      // 复用 stdio 的协议处理：把响应收集到一个缓冲
      const out = [];
      const sink = {
        write: (chunk) => { out.push(chunk); return true; },
      };
      try {
        await acquireToolSlot();
        try {
          await handleMessage(msg, sink, { compact: true });
        } finally {
          releaseToolSlot();
        }
      } catch (e) {
        if (msg && msg.id !== undefined && msg.id !== null) {
          replyError(sink, msg.id, -32603, e.message);
        }
      }
      const payload = out.join("");
      if (!payload) {
        // 通知（无 id）→ 204
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(payload);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address();
  return {
    server,
    port: actual ? actual.port : port,
    host,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 常量时间字符串比较，避免令牌被时序攻击逐字节猜出 */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免长度泄漏
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  startServer, startHttpServer, callTool, toolDefs,
  PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION,
};
