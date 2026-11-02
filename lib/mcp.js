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

const { sanitizeControl, sanitizeUntrusted, sanitizeErrorMessage } = require("./sanitize");
const { withMeta } = require("./console");

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
      name: "bdp_error",
      description:
        "解释百度网盘/接口错误码。返回结构化结果：code（数值）/name/description/severity/retryable/action。" +
        "severity 取值 retryable（退避重试可能成功）|fatal（必须用户介入）|user-error（请求本身有问题）|unknown。" +
        "Agent 据此决定是否重试；action 是建议的下一步动作（不要当成命令直接执行）。" +
        "默认只返回结论；需要实测记录/实现坑这类内部细节时传 verbose:true（会多占上下文，按需取）。" +
        "与 CLI 的 `bdp error <code> --json` 返回同一份结构。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "错误码，如 -3 / 31066 / 31326（不填则默认 -3）" },
          list: { type: "boolean", description: "列出全部已知错误码" },
          verbose: { type: "boolean", description: "附带 internalDetail（内部实现细节/实测记录），默认不下发" },
        },
      },
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
    // 用无原型对象：JSON 里带 __proto__ 键时，直接赋值会把它当成原型设置
    const out = Object.create(null);
    for (const k of Object.keys(value)) {
      if (k === "__proto__") continue;
      out[k] = sanitizeDeep(value[k]);
    }
    return out;
  }
  return value;
}

// 承载「来自网盘的散文」的字段：额外加边界标记。
// 引擎原文（raw）里混着网盘文件名与任意路径文本，同样必须标记。
const UNTRUSTED_TEXT_FIELDS = {
  bdp_read: ["content"],
  bdp_preview: ["text", "note"],
  bdp_peek: ["preview"],
  bdp_move: ["raw", "warning"],
  bdp_copy: ["raw", "warning"],
  bdp_quota: ["raw", "username"],
};

// 说明：`name` / `path` 这类**标识符**字段只做字符净化（sanitizeControl），不加边界标记 ——
// 加了之后 Agent 就无法把该路径原样传回下一条命令去寻址。
// 「文件名里写着祈使句」这个注入面，靠 SKILL.md 的明确约定（文件名同样是不可信数据）来约束。

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
  args = args || {};
  const pan = require("./pan");
  const group = require("./group");
  const pcsExtra = require("./pcs-extra");

  switch (name) {
    case "bdp_ls": {
      const info = await pan.lsEntries(args.path || "/");
      return { path: info.path, total: info.entries.length, entries: info.entries };
    }
    case "bdp_search": {
      assertArg(args.keyword, "keyword");
      const mode = args.mode || "substring";
      let engineKeyword = args.keyword;
      if (mode === "regex" || mode === "glob") {
        const runs = String(args.keyword).split(/[.*+?^¶{}()|[\]\\*?]/).filter(Boolean);
        engineKeyword = runs.find((r) => r.length >= 2) || runs[0] || args.keyword;
      } else if (mode === "any") {
        engineKeyword = String(args.keyword).split(/\s+/)[0];
      }
      const info = await pan.searchEntries(args.keyword, args.path || "/", { mode, engineKeyword });
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
      assertArg(args.path, "path");
      const lines = await pan.head(args.path, args.lines > 0 ? args.lines : 20);
      return { path: args.path, lines: lines.length, content: lines.join("\n") };
    }
    case "bdp_preview": {
      assertArg(args.path, "path");
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
      // depth 必须有上限：否则一次 MCP 调用就能触发近乎全树的遍历（DoS 面）
      const depth = Math.min(Math.max(1, args.depth > 0 ? args.depth : 12), 32);
      const r = await dedup.scanDuplicates(args.path || "/", { maxDepth: depth });
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
      assertArg(args.src, "src");
      assertArg(args.dst, "dst");
      return await pcsExtra.mv(assertSafePanPath(args.src, "src"), assertSafePanPath(args.dst, "dst"));
    }
    case "bdp_copy": {
      assertArg(args.src, "src");
      assertArg(args.dst, "dst");
      return await pcsExtra.cp(assertSafePanPath(args.src, "src"), assertSafePanPath(args.dst, "dst"));
    }
    case "bdp_remove": {
      assertArg(args.path, "path");
      if (args.confirm !== true) {
        throw new Error("删除需要显式确认：请传 confirm=true（删除走百度回收站，可恢复）");
      }
      const results = await pan.remove([args.path]);
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
      if (!files.length) {
        const e = new Error("files 不能为空");
        e.toolArgumentError = true;
        throw e;
      }
      const dryRun = args.dryRun !== false;
      const results = [];
      for (const f of files) {
        if (!f || !f.from || !f.to) {
          results.push({ from: f && f.from, ok: false, error: "缺少 from/to" });
          continue;
        }
        // 只允许改文件名。拒绝三种越界/不一致的情况：
        //  1) 目标含 / 或 \        → 跨目录移动，必须显式用 bdp_move
        //  2) 目标是 . 或 ..        → 引擎会归一化（实测 /med/.. = 根目录），等于跨目录移动
        //  3) 目标含控制字符/NUL    → 引擎收到的路径与回报给 Agent 的路径不一致
        const rawTo = String(f.to);
        if (/[\\/]/.test(rawTo) || rawTo === "." || rawTo === ".." || /[\u0000-\u001F\u007F]/.test(rawTo)) {
          results.push({
            from: f.from,
            to: rawTo,
            ok: false,
            error:
              "只允许改文件名（目标不能含 / 或 \\，不能是 . 或 ..，不能含控制字符）；跨目录移动请用 bdp_move",
          });
          continue;
        }
        // from 也要归一化：/a/../b.txt 同样能把目标拼到目录外
        const fromPath = posixNormalize(f.from);
        const cut = fromPath.lastIndexOf("/");
        const dir = cut >= 0 ? fromPath.slice(0, cut) : "";
        const to = dir + "/" + rawTo;
        if (to === fromPath) {
          results.push({ from: fromPath, to, ok: true, skipped: true, reason: "名称未变" });
          continue;
        }
        if (dryRun) {
          results.push({ from: fromPath, to, ok: true, dryRun: true });
          continue;
        }
        try {
          const rr = await pcsExtra.mv(fromPath, to);
          results.push({ from: fromPath, to, ok: true, op: rr.op });
        } catch (e) {
          // 逐条 error 同样会进 Agent 上下文 —— 必须走同一套脱敏
          results.push({ from: fromPath, to, ok: false, error: sanitizeErrorMessage(e.message) });
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
      const depth = Math.min(Math.max(1, args.depth > 0 ? args.depth : 12), 32);
    const scan = await dedup.scanFiles(root, { maxDepth: depth });
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
      assertArg(args.query, "query");
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
      assertArg(args.path, "path");
      return await pan.peek(args.path);
    }
    case "bdp_quota": {
      return await pcsExtra.quota();
    }
    case "bdp_error": {
      const errorCodes = require("./error-codes");
      const { parseBool } = require("./flags");
      // 布尔参数**严格**解析：无法识别的值报错，而不是静默降级
      // （此前 {"list":"1"} 会被当成「不列清单」、{"verbose":"1"} 会静默失效 —— Agent 以为参数生效了）
      const wantList = parseBool(args.list, "list");
      const verbose = parseBool(args.verbose, "verbose");
      if (wantList) {
        const list = errorCodes.listErrors({ verbose });
        return { count: list.length, errors: list };
      }
      const raw = args.code === undefined || args.code === null ? "-3" : args.code;
      return errorCodes.describeError(raw, { verbose });
    }
    case "bdp_get": {
      assertArg(args.path, "path");
      return await pan.download(args.path, args.outDir, {});
    }
    case "bdp_put": {
      assertArg(args.local, "local");
      assertArg(args.remote, "remote");
      const raw = await pan.upload(args.local, args.remote);
      return { local: args.local, remote: args.remote, ok: true, raw };
    }
    case "bdp_mkdir": {
      assertArg(args.path, "path");
      return await pan.mkdir(args.path);
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

/**
 * 归一化网盘路径里的 . 与 ..。
 * 引擎自己也会归一化，但**必须由我们先归一化** —— 否则 /a/../b.txt 这类路径
 * 能把目标拼到源目录之外，绕过「只改文件名」的边界。
 */
function posixNormalize(p) {
  const out = [];
  for (const seg of String(p || "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/** 拒绝含控制字符/NUL 的路径 —— 否则引擎收到的路径与回报给 Agent 的不一致 */
function assertSafePanPath(p, label) {
  const s = String(p === undefined || p === null ? "" : p);
  if (/[\u0000-\u001F\u007F]/.test(s)) {
    throw new Error((label || "路径") + "含控制字符，已拒绝");
  }
  return s;
}

/**
 * 构造**结构化**的工具错误。
 * Agent 要能程序化判断「能不能重试」「下一步做什么」，而不是拿到一句中文散文。
 * error.code 永远是数值：有 errno 用 errno，没有则用 -32000（JSON-RPC 服务端错误保留段）。
 */
// 工具参数错误（Agent 用错了参数）——不是百度侧的错，也不该让 Agent 去提 Issue
const TOOL_ARGUMENT_ERROR = -32001;

/**
 * 校验必填参数。缺参数时抛**参数错误**，绝不能把 undefined 递给引擎
 * （否则 bdp_mkdir {} 会在网盘根目录真的建出一个名为 "undefined" 的目录）。
 */
function assertArg(value, name) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    const e = new Error("参数 " + name + " 不能为空");
    e.toolArgumentError = true;
    throw e;
  }
  return value;
}

function buildToolError(e) {
  const errorCodes = require("./error-codes");
  const errno = e && typeof e.errno === "number" && Number.isFinite(e.errno) ? e.errno : null;
  const known = errno !== null ? errorCodes.lookup(errno) : null;
  // 消息恒为字符串；并剔除控制字符、中和边界标记、脱敏本地路径（成功路径做了净化，错误路径也必须做）。
  //
  // 统一走 lib/sanitize.js 的 sanitizeErrorMessage —— CLI 侧用**同一个实现**，
  // 否则同一错误在两侧会产出不同文本（审核实测：CLI 侧曾保留控制字符与伪闭合标记）。
  let message = e && e.message ? String(e.message) : String(e === undefined ? "" : e);
  message = sanitizeErrorMessage(message);
  // 纵深防御：错误消息会原样进 Agent 上下文 —— 任何来源都不该无界（引擎原文可能很长）
  const MESSAGE_LIMIT = 1000;
  if (message.length > MESSAGE_LIMIT) message = message.slice(0, MESSAGE_LIMIT) + "…";
  if (e && e.toolArgumentError) {
    return {
      error: {
        code: TOOL_ARGUMENT_ERROR,
        name: "TOOL_ARGUMENT_ERROR",
        message,
        severity: "user-error",
        retryable: false,
        action: "修正参数后重试（参数说明见该工具的 inputSchema）",
      },
    };
  }
  // 未登记 errno 时，错误对象自己可以声明「可重试」与「下一步建议」——
  // 引擎超时（v1.10.1 / T-02）就属于这一类：它是环境问题，不是永久失败，
  // Agent 退避后重试是有意义的（否则一次网络抖动会被当成不可恢复的结论）。
  const selfRetryable = !!(e && e.retryable === true);
  const selfAction = e && typeof e.action === "string" && e.action ? e.action : null;
  return {
    error: {
      code: errno !== null ? errno : -32000,
      name: known ? known.name : "TOOL_ERROR",
      message,
      severity: known ? known.severity : selfRetryable ? "retryable" : "unknown",
      retryable: known ? known.severity === "retryable" : selfRetryable,
      action:
        selfAction ||
        (known
          ? known.action
          : "查看 bdp error <code> 了解已知错误码；如确认是百度侧的新错误码，请提交 Issue：" +
            "https://github.com/NkAntony777/baiduwangpan-cli/issues"),
    },
  };
}

/** 当前激活的账号 profile（信封要回答「哪个账号」，不能恒为 null） */
function currentProfileName() {
  try {
    return require("./config").getProfile() || null;
  } catch {
    return null;
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
// 归一化：非法值 → 默认 4；"0" → 1（此前 parseInt("0")=0 被 || 4 吃掉，
// 设 0 的用户拿到的是 4 而不是直觉上的「最小 1」）。
const MAX_CONCURRENT_TOOLS = Math.max(1, (() => {
  const n = parseInt(process.env.BDP_MCP_MAX_CONCURRENCY, 10);
  return Number.isFinite(n) ? n : 4;
})());
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
      const startedAt = Date.now();
      // 并发闸门 —— **stdio 与 HTTP 走同一段逻辑**（v1.10.1 / T-04）。
      //
      // 为什么要放在这里而不是各自的传输层：stdio 路径此前完全没有闸门，
      // 实测 12 个并发 bdp_ls → 12 个同时存活的 BaiduPCS-Go.exe
      // （HTTP 侧被正确压到 4）。stdio 是 MCP 默认传输，也是 Agent 最常用的接法。
      //
      // 口径说明：闸门限的是**工具调用总数**，不是引擎进程数 ——
      // 走 web API 的工具（quota/dedup/organize/ask）同样占槽位。
      await acquireToolSlot();
      try {
        try {
          const result = await callTool(name, args);
          const payload = withMeta(result, {
            command: name,
            startedAt,
            profile: currentProfileName(),
          });
          // JSON-RPC：通知（无 id）**不得**回包
          if (!isNotification) {
            reply(output, id, {
              content: [{ type: "text", text: opts.compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2) }],
              isError: false,
            });
          }
        } catch (e) {
          // 工具执行失败 → isError:true（而不是 JSON-RPC error），客户端仍能读到内容
          // 错误体是**结构化**的：{ error: { code, name, message, severity, retryable, action } }
          const errPayload = withMeta(buildToolError(e), {
            command: name,
            startedAt,
            profile: currentProfileName(),
          });
          // JSON-RPC：通知（无 id）**不得**回包
          if (!isNotification) {
            reply(output, id, {
              content: [{ type: "text", text: opts.compact ? JSON.stringify(errPayload) : JSON.stringify(errPayload, null, 2) }],
              isError: true,
            });
          }
        }
      } finally {
        // 所有出口都要释放 —— 成功 / 抛错 / 超时（引擎超时由 T-02 保证会 settle）
        releaseToolSlot();
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
      // 不回显版本号/工具数：免令牌端点应尽量少泄露指纹。
      // （版本号只在**已鉴权**通道下发 —— 令牌持有者本来就从 initialize 拿到了它。）
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
        // 并发闸门在 handleMessage 内部（tools/call 分支）—— stdio 与 HTTP 共用同一段逻辑，
        // 这里不要再包一层，否则会重复占用槽位。
        await handleMessage(msg, sink, { compact: true });
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
