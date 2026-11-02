// 一次报出：登录态、引擎能否启动、配置是否可读、索引是否还新鲜。
// 不打印本地绝对路径。索引缺失只是警告，不把整次诊断打成失败。
const fs = require("fs");
const path = require("path");
const config = require("./config");
const http = require("./http");
const { redactLocalPaths } = require("./sanitize");

const INDEX_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

// 引擎为什么是这个路径：configured（配置文件/环境变量给的）还是 auto-fallback（自动发现兜底）。
// 这个标志必须露出来 —— 否则「配置的引擎坏了、静默换成包里那个」对调用方完全不可见。
function engineSource() {
  const stored = String(
    (config.load && config.load().pcsPath) || process.env.BAIDUPCS_CMD || ""
  ).trim();
  if (!stored) return { source: "auto", storedMissing: false };
  // 裸名 = 交给 PATH 解析，是否可用由 spawn 结果决定（不能用 existsSync 判）
  if (!path.isAbsolute(stored)) return { source: "path", storedMissing: false };
  try {
    if (fs.existsSync(stored)) return { source: "configured", storedMissing: false };
  } catch {}
  // 配置了绝对路径但文件已不在 —— resolvePcsPath 会**静默回退**到自动发现，
  // 于是「我配的那个引擎坏了」这件事对调用方不可见（安全上是静默引擎替换）。
  return { source: "auto-fallback", storedMissing: true };
}

async function checkEngine(pcsPath) {
  const meta = engineSource();
  if (!pcsPath) {
    return { ok: false, detail: "未配置引擎路径", source: meta.source };
  }
  // 裸名（PATH 可达）不能用 existsSync 判 —— 否则「引擎其实能跑」会被报成「引擎文件不存在」。
  const isBare = !path.isAbsolute(pcsPath);
  if (!isBare && !fs.existsSync(pcsPath)) {
    return { ok: false, detail: "引擎文件不存在", source: meta.source };
  }
  const r = await http.spawnCollected(pcsPath, ["help"], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeoutMs: 8000,
  });
  if (r.error || r.status !== 0) {
    const why =
      r && r.error && r.error.code === "ENOENT"
        ? "引擎在 PATH 上找不到"
        : r && r.error && r.error.code === "ETIMEDOUT"
          ? "引擎在 8 秒内没有响应"
          : "引擎无法启动";
    return { ok: false, detail: why, source: meta.source };
  }
  return { ok: true, detail: isBare ? "引擎可启动（来自 PATH）" : "引擎可启动", source: meta.source };
}

function checkIndex() {
  let handle;
  try {
    const store = require("./index-store");
    handle = store.openIndex();
    const st = store.status(handle);
    const last = typeof st.lastIndexedAt === "number" ? st.lastIndexedAt : null;
    const ageMs = last ? Date.now() - last : null;
    const fresh = ageMs !== null && ageMs >= 0 && ageMs <= INDEX_FRESH_MS;
    return {
      present: st.files > 0,
      files: st.files,
      lastIndexedAt: last,
      ageHours: ageMs === null ? null : Math.round(ageMs / 3600000),
      fresh,
      detail: st.files > 0 ? (fresh ? "索引在 7 天内" : "索引已超过 7 天") : "索引是空的",
    };
  } catch (e) {
    return { present: false, files: 0, fresh: false, detail: "无法打开索引" };
  } finally {
    try { if (handle) handle.close(); } catch {}
  }
}

async function doctor() {
  const health = config.configHealth();
  let cfg = null;
  try { cfg = config.get(); } catch {}
  const loggedIn = !!(cfg && cfg.bduss && cfg.stoken);
  const engine = await checkEngine(cfg && cfg.pcsPath);
  const index = checkIndex();
  const configOk = !!(health && health.ok);
  const warnings = [];
  if (!loggedIn) warnings.push("未登录");
  if (!configOk) warnings.push("配置文件不可读");
  // 配置的引擎没了、静默换成了自动发现的：这本身就是需要人知道的诊断结论
  // （安全上它是「静默引擎替换」，运维上它是「我配的那个不生效」）。
  if (engine.source === "auto-fallback" && engine.ok) {
    warnings.push("配置的引擎路径不存在，已回退为自动发现的引擎");
  }
  if (!engine.ok) warnings.push(engine.detail);
  if (!index.fresh) warnings.push(index.detail);
  return {
    ok: loggedIn && configOk && engine.ok,
    login: { ok: loggedIn },
    config: {
      ok: configOk,
      detail: configOk ? "配置可读" : redactLocalPaths(health && health.error ? health.error : "配置不可读"),
    },
    engine,
    index,
    warnings,
  };
}

// checkEngine 单独导出：它有一条「裸名 vs 绝对路径」的判据，必须能被测试直接钉住
module.exports = { doctor, checkEngine, INDEX_FRESH_MS };
