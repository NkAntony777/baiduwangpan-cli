// ── 文件名匹配（纯函数，无 IO）──────────────────────────
//
// 供群文件搜索（lib/group.js 的 gsearch）与网盘搜索（bdp search 集成建议）共用。
// 所有函数都是同步纯函数：同样的输入永远得到同样的输出，不做任何网络/文件操作。
//
// 匹配模式（options.mode）：
//   - "all"   （默认）空格分词，每个词都必须出现（AND，顺序无关）
//   - "any"   空格分词，任一词出现即可（OR）
//   - "exact" 整名精确相等（大小写不敏感，按 basename 比较，忽略目录前缀）
//   - "regex" pattern 直接作为正则表达式
//   - "glob"  pattern 按 shell glob（* 任意串、? 单字符）匹配
// 单关键词时 all/any 都退化为子串包含（与 group.js 旧行为兼容）。

// 正则元字符转义：普通字符串 → 可安全嵌入正则的等价字面量
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// shell glob 转正则：* → .*（任意串，含空）、? → .（任意单字符）、
// 其余字符全部按字面量转义（如 "1.5版" 的 "." 在 glob 中就是普通句点）。
// 结果整体锚定（^...$），即 glob 必须匹配整个文件名（shell 语义）。
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const src = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^(?:${src})$`);
}

// 核心匹配函数。
//   pattern: 用户输入的关键词/模式
//   name:    待匹配的文件名（可为完整路径，exact 模式会自动取 basename）
//   options: { mode, ignoreCase }，ignoreCase 默认 true（与 group.js 旧行为一致）
// 返回布尔值。
function matchesName(pattern, name, options = {}) {
  const mode = options.mode || "all";
  const ignoreCase = options.ignoreCase !== false;
  const raw = String(pattern);
  const k = ignoreCase ? raw.toLowerCase() : raw;
  const n = String(name || "");
  const nn = ignoreCase ? n.toLowerCase() : n;

  // regex：pattern 直接编译为正则（非法正则向上抛 SyntaxError，由调用方决定处理）
  if (mode === "regex") {
    return new RegExp(raw, ignoreCase ? "i" : "").test(n);
  }

  // glob：经 globToRegExp 转换后整体匹配
  if (mode === "glob") {
    return globToRegExp(raw).test(n);
  }

  // exact：整名精确相等。按 basename 比较（忽略 "/dir/" 前缀），
  // 顶层分享 name 形如 "/xxx"，子目录文件 name 无前缀，两者统一处理。
  if (mode === "exact") {
    const base = nn.includes("/") ? nn.slice(nn.lastIndexOf("/") + 1) : nn;
    return base === k;
  }

  // all / any：空格分词。空关键词（含纯空白）不过滤（匹配一切，兼容旧行为）；
  // 单关键词退化为子串包含（兼容旧行为）。
  const words = k.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length === 1) return nn.includes(words[0]);
  if (mode === "any") return words.some((w) => nn.includes(w));
  return words.every((w) => nn.includes(w)); // 默认 all：每词都需出现（AND）
}

module.exports = { globToRegExp, matchesName, escapeRegExp };
