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

function badTargetName(rawTo) {
  return /[\\/]/.test(rawTo) || rawTo === "." || rawTo === ".." || /[\u0000-\u001F\u007F]/.test(rawTo);
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
    if (badTargetName(rawTo)) {
      results.push({
        from: f.from,
        to: rawTo,
        ok: false,
        error: "只允许改文件名（目标不能含 / 或 \\，不能是 . 或 ..，不能含控制字符）；跨目录移动请用 bdp mv",
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

module.exports = { renameFiles, posixNormalize, badTargetName };
