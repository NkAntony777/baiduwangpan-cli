// 一次报出：登录态、引擎能否启动、配置是否可读、索引是否还新鲜。
// 不打印本地绝对路径。索引缺失只是警告，不把整次诊断打成失败。
const fs = require("fs");
const config = require("./config");
const http = require("./http");
const { redactLocalPaths } = require("./sanitize");

const INDEX_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

async function checkEngine(pcsPath) {
  if (!pcsPath) return { ok: false, detail: "未配置引擎路径" };
  if (!fs.existsSync(pcsPath)) return { ok: false, detail: "引擎文件不存在" };
  const r = await http.spawnCollected(pcsPath, ["help"], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeoutMs: 8000,
  });
  if (r.error || r.status !== 0) return { ok: false, detail: "引擎无法启动" };
  return { ok: true, detail: "引擎可启动" };
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

module.exports = { doctor, INDEX_FRESH_MS };
