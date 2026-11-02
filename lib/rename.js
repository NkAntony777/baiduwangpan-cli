// 批量改名。CLI `bdp rename` 与 MCP `bdp_rename` 共用这一份规则：
// 默认只预览；目标只能是文件名，不能借改名把文件挪出目录。
const pcsExtra = require("./pcs-extra");
const { sanitizeErrorMessage } = require("./sanitize");

function posixNormalize(p) {
  const out = [];
  for (const seg of String(p || "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

// 目标名闸门。为什么这些都要挡：
//   · 分隔符 / \  → 改名不能跨目录（否则就是 mv，且能绕开目录权限直觉）
//   · . / ..      → 同上，且能指向目录本身
//   · 纯空白      → 会造出「看不见名字」的文件，之后无法寻址
//   · 控制字符    → 终端劫持（ESC/OSC）
//   · 格式符/bidi → 预览与执行**不一致**的根源：lib/sanitize.js 的 CONTROL_RE 会把这些
//                   从**回显**里剥掉，但文件真的带它们落盘 → Agent 按预览名去寻址会指向
//                   另一个文件（扩展名伪装）。所以这里**拒绝**，而不是剥掉。
const FORMAT_CHARS_RE = /[\u202A-\u202E\u2066-\u206F\uFEFF]/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const MAX_NAME_LEN = 255; // 网盘单段文件名上限（与常见文件系统一致）

function badTargetName(rawTo) {
  const s = String(rawTo === undefined || rawTo === null ? "" : rawTo);
  if (s.trim() === "") return true;
  if (s.length > MAX_NAME_LEN) return true;
  if (/[\\/]/.test(s)) return true;
  if (s === "." || s === "..") return true;
  if (CONTROL_CHARS_RE.test(s)) return true;
  if (FORMAT_CHARS_RE.test(s)) return true;
  return false;
}

// from 的闸门：必须是**可寻址的具体文件路径**。
// 关键：不能既归一化又接受 —— `/a/../../etc/passwd` 归一成 `/etc/passwd` 就是
// 「用户以为改的是 A、实际改的是 B」。含 `..` 段一律拒绝。
// 目录型参数（organize 的 target / path）的闸门：
// 接受 `/归档`、`归档`（会被归一成 `/归档`），拒绝任何含 `..` 段的写法。
// 为什么必须挡：organize --apply 会拿 target 直接 mkdir + mv，
// `--target ../../x` 就把文件搬到了目录树之外（实测计划项 to 就是 `../../x/文档/x.pdf`）。
function normalizeDirArg(rawDir, label) {
  const s = String(rawDir === undefined || rawDir === null ? "" : rawDir).trim();
  const name = label || "target";
  if (!s) return { ok: false, error: name + " 不能为空" };
  if (s.length > 4096) return { ok: false, error: name + " 过长" };
  if (CONTROL_CHARS_RE.test(s)) return { ok: false, error: name + " 含控制字符" };
  if (FORMAT_CHARS_RE.test(s)) return { ok: false, error: name + " 含不可见格式字符" };
  if (s.split(/[\\/]/).some((seg) => seg === "..")) {
    return { ok: false, error: name + " 不能含 .. 段（会指到目录树之外）" };
  }
  return { ok: true, value: posixNormalize(s) };
}

function badSourcePath(rawFrom) {
  const s = String(rawFrom === undefined || rawFrom === null ? "" : rawFrom).trim();
  if (!s) return "缺少 from";
  if (s.length > 4096) return "路径过长";
  if (CONTROL_CHARS_RE.test(s)) return "from 含控制字符";
  if (FORMAT_CHARS_RE.test(s)) return "from 含不可见格式字符（会导致预览与执行不一致）";
  if (s.split(/[\\/]/).some((seg) => seg === "..")) {
    return "from 不能含 .. 段（请传规范化后的绝对路径；含 .. 的路径归一化后指向的是另一个文件）";
  }
  const normalized = posixNormalize(s);
  if (normalized === "/") return "不能重命名网盘根目录";
  return null;
}

/**
 * @param {Array<{from?: string, to?: string}>} files
 * @param {{dryRun?: boolean}} [options] dryRun 默认 true
 */
async function renameFiles(files, options = {}) {
  const list = Array.isArray(files) ? files : [];
  const dryRun = options.dryRun !== false;
  const results = [];
  for (const f of list) {
    if (!f || !f.from || !f.to) {
      results.push({ from: f && f.from, ok: false, error: "缺少 from/to" });
      continue;
    }
    // 兜底（MCP 边界已有类型校验）：非字符串一律拒绝，绝不 String() 之后照改 ——
    // {to: 123} 会变成名为 "123" 的文件、{to: {}} 会变成 "[object Object]"。
    if (typeof f.from !== "string" || typeof f.to !== "string") {
      results.push({
        from: typeof f.from === "string" ? f.from : JSON.stringify(f.from),
        ok: false,
        error: "from/to 必须是字符串（收到 " + typeof f.from + "/" + typeof f.to + "）",
      });
      continue;
    }
    const rawTo = f.to;
    // from 先挡：含 .. 的路径归一化后会指向**另一个文件**（预览与执行不一致）
    const srcErr = badSourcePath(f.from);
    if (srcErr) {
      results.push({ from: f.from, to: rawTo, ok: false, error: srcErr });
      continue;
    }
    if (badTargetName(rawTo)) {
      results.push({
        from: f.from,
        to: rawTo,
        ok: false,
        error:
          "只允许改文件名（目标不能含 / 或 \\，不能是 . 或 ..，不能含控制字符或不可见格式字符，" +
          "不能是纯空白，且不超过 " + MAX_NAME_LEN + " 字符）；跨目录移动请用 bdp mv",
      });
      continue;
    }
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

module.exports = {
  renameFiles,
  posixNormalize,
  badTargetName,
  badSourcePath,
  normalizeDirArg,
  MAX_NAME_LEN,
  FORMAT_CHARS_RE,
};
