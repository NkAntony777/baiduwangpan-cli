// lib/organize.js — 网盘内容整理（计划与执行分离）
//
// 设计原则（与 bdp dedup / bdp rm 一致）：
//   1. 默认只出**计划**，不动任何文件；
//   2. 执行必须显式确认（--apply + --yes）；
//   3. 归类规则由用户显式给出，工具不擅自决定「什么该扔」。
//
// 支持三个维度（可组合）：
//   --by type    按文件类型（PDF/文档/图片/视频/压缩包…）
//   --by year    按修改年份
//   --by source  按来源目录（把散落文件收到一起）
//
// 目标目录形如 /归档/文档/2024/report.pdf —— 层级顺序由 --layout 决定。

// --layout 的合法取值（CLI 与 MCP 都要校验，非法值必须报错而不是静默兜底）
const LAYOUTS = ['type-year', 'year-type', 'type-source', 'source-type', 'year-source', 'source-year'];

const TYPE_RULES = [
  { dir: '文档', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt'] },
  { dir: '图片', exts: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'heic'] },
  { dir: '视频', exts: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'webm'] },
  { dir: '音频', exts: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'] },
  { dir: '压缩包', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'] },
  { dir: '代码', exts: ['js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'vue', 'ipynb'] },
  { dir: '数据', exts: ['json', 'jsonl', 'xml', 'yaml', 'yml', 'parquet', 'db', 'sqlite'] },
  { dir: '安装包', exts: ['exe', 'msi', 'dmg', 'pkg', 'apk', 'deb', 'rpm', 'iso'] },
];

const TYPE_MAP = new Map();
for (const rule of TYPE_RULES) {
  for (const ext of rule.exts) TYPE_MAP.set(ext, rule.dir);
}

/**
 * 取扩展名（小写，不含点）。
 */
function extOfName(name) {
  // 网盘文件名允许尾部空格（"报告.pdf "）—— 不 trim 会把它归到「其他」而不是「文档」
  const base = (String(name || '').split('/').pop() || '').trim();
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase().trim();
}

/**
 * 从文件修改时间取年份。
 * @param {number} mtime unix 秒
 */
function yearOf(mtime) {
  const ts = (Number(mtime) || 0) * 1000;
  // 负数时间戳不是有效年份（否则会落进 1970 目录）
  if (!ts || ts < 0) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getFullYear());
}

/**
 * 为单个文件计算目标路径。
 *
 * @param {object} file { path, name, mtime, size }
 * @param {object} rules { byType, byYear, bySource, sourceRoot, targetRoot, layout }
 * @returns {{ target: string, categories: string[] } | null} 无法归类时返回 null
 */
/**
 * 为单个文件计算目标路径。
 *
 * @param {object} file { path, name, mtime, size }
 * @param {object} rules { byType, byYear, bySource, sourceRoot, targetRoot, layout }
 * @returns {{ target: string, categories: string[] } | null} 无法归类时返回 null
 */
function classifyFile(file, rules) {
  // 三个维度各自算出「这一层叫什么」，互不干扰
  const typeVal = rules.byType
    ? TYPE_MAP.get(extOfName(file.name)) || '其他'
    : null;

  const yearVal = rules.byYear ? yearOf(file.mtime) : null;

  let srcVal = null;
  if (rules.bySource) {
    const root = (rules.sourceRoot || '/').replace(/\/+$/, '');
    const dir = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
    let rel = dir;
    if (root && root !== '/' && dir.startsWith(root + '/')) rel = dir.slice(root.length);
    else if (root && root !== '/' && dir === root) rel = '';
    rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel) srcVal = rel;
  }

  const layout = rules.layout || 'type-year';
  // layout 决定各维度的先后顺序
  const ORDER = {
    'type-year': ['type', 'year'],
    'year-type': ['year', 'type'],
    'type-source': ['type', 'source'],
    'source-type': ['source', 'type'],
    'year-source': ['year', 'source'],
    'source-year': ['source', 'year'],
  };
  const order = ORDER[layout] || ORDER['type-year'];

  const VALS = { type: typeVal, year: yearVal, source: srcVal };
  const parts = [];
  for (const key of order) {
    const v = VALS[key];
    if (v) parts.push(v);
  }

  // layout 没覆盖到的维度兜底追加（避免维度被静默丢弃）
  for (const key of ['type', 'year', 'source']) {
    const v = VALS[key];
    if (v && !parts.includes(v)) parts.push(v);
  }

  if (!parts.length) return null;

  const targetRoot = (rules.targetRoot || '/归档').replace(/\/+$/, '');
  const target = targetRoot + '/' + parts.join('/') + '/' + file.name;
  return { target, categories: parts };
}


/**
 * 生成整理计划。
 *
 * @param {Array} files 扫描到的文件
 * @param {object} rules 见 classifyFile
 * @returns {{ plan: Array, skipped: Array, summary: object }}
 */
/**
 * 为冲突的目标路径生成唯一名。
 * 整理时不同目录的同名文件（如 /a/report.pdf 与 /b/report.pdf）
 * 会归到同一目标路径 —— 必须自动去重，否则后一个移动会失败。
 * 策略：加 " (2)" " (3)" 后缀。
 * @param {string} target 目标完整路径
 * @param {Set<string>} used 已占用的目标路径
 */
function uniqueTarget(target, used, reserved) {
  if (!used.has(target)) {
    used.add(target);
    return target;
  }
  const slash = target.lastIndexOf('/');
  const dir = target.substring(0, slash);
  const base = target.substring(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.substring(0, dot) : base;
  const ext = dot > 0 ? base.substring(dot) : '';
  for (let n = 2; n < 10000; n++) {
    const candidate = dir + '/' + stem + ' (' + n + ')' + ext;
    // reserved：网盘上已存在的同名目标、以及别的文件的自然目标名 ——
    // 生成序号名时必须避开，否则会产出 "report (2) (2).pdf" 这类叠名
    if (!used.has(candidate) && !(reserved && reserved.has(candidate))) {
      used.add(candidate);
      return candidate;
    }
  }
  return target;
}

/**
 * 生成整理计划。
 *
 * @param {Array} files 扫描到的文件
 * @param {object} rules 见 classifyFile
 * @returns {{ plan: Array, skipped: Array, summary: object }}
 */
function buildPlan(files, rules) {
  const plan = [];
  const skipped = [];
  const usedTargets = new Set();
  const targetRoot = (rules.targetRoot || '/归档').replace(/\/+$/, '');
  let conflicts = 0;

  // ── 第一遍：算自然目标，并收集「网盘上已存在的目标」 ──
  const entries = [];            // { file, c }
  const skipReason = new Map();  // path → 跳过原因
  const existingTargets = new Set();
  for (const file of files) {
    // 已在目标目录内的文件不动；它的**原路径**就是网盘上已存在的目标，别的文件不能占用
    if (file.path.startsWith(targetRoot + '/')) {
      existingTargets.add(file.path);
      skipReason.set(file.path, '已在目标目录内');
      continue;
    }
    const c = classifyFile(file, rules);
    if (!c) { skipReason.set(file.path, '无法归类'); continue; }
    if (c.target === file.path) { skipReason.set(file.path, '目标与原路径相同'); continue; }
    entries.push({ file, c });
  }

  // 已存在的目标先占位：计划不能指向网盘上已经有的文件
  for (const p of existingTargets) usedTargets.add(p);

  // 所有自然目标都保留给它的主人 —— 生成的变体名不得占用别人的自然名
  //（否则会出现 "report (2) (2).pdf" 这种叠名）
  const reserved = new Set(existingTargets);
  for (const e of entries) reserved.add(e.c.target);

  // ── 第二遍：分配目标名（按自然目标排序 → 结果与输入顺序无关） ──
  const ordered = entries.slice().sort((a, b) => {
    if (a.c.target < b.c.target) return -1;
    if (a.c.target > b.c.target) return 1;
    return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
  });
  const assigned = new Map();
  let targetExistsCount = 0;
  for (const e of ordered) {
    const natural = e.c.target;
    const targetExists = existingTargets.has(natural);
    let target = natural;
    if (usedTargets.has(target)) {
      conflicts++;
      target = uniqueTarget(target, usedTargets, reserved);
    } else {
      usedTargets.add(target);
    }
    if (targetExists) targetExistsCount++;
    assigned.set(e.file.path, { target, renamed: target !== natural, targetExists, categories: e.c.categories });
  }

  // ── 第三遍：按输入顺序组装输出 ──
  for (const file of files) {
    const a = assigned.get(file.path);
    if (!a) {
      skipped.push({ path: file.path, reason: skipReason.get(file.path) || '无法归类' });
      continue;
    }
    plan.push({
      from: file.path,
      to: a.target,
      name: file.name,
      size: file.size,
      categories: a.categories,
      renamed: a.renamed,
      // 目标在网盘上已存在 → 已自动改名，调用方应能看见
      targetExists: a.targetExists,
    });
  }

  const byCategory = {};
  for (const p of plan) {
    const key = p.categories.join('/');
    byCategory[key] = byCategory[key] || { count: 0, bytes: 0 };
    byCategory[key].count++;
    byCategory[key].bytes += p.size || 0;
  }

  const warnings = [];
  if (targetExistsCount) {
    warnings.push(targetExistsCount + ' 个目标在网盘上已存在，已自动加序号改名');
  }

  return {
    plan,
    skipped,
    warnings,
    summary: {
      total: files.length,
      toMove: plan.length,
      skipped: skipped.length,
      conflicts,
      targetExists: targetExistsCount,
      byCategory,
    },
  };
}


module.exports = {
  uniqueTarget,  TYPE_RULES,
  TYPE_MAP,
  LAYOUTS,
  extOfName,
  yearOf,
  classifyFile,
  buildPlan,
};