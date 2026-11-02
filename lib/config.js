const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = process.env.BDP_CONFIG_DIR || path.join(os.homedir(), ".bdp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const PCS_BINARY_NAMES = ["BaiduPCS-Go.exe", "BaiduPCS-Go"];

// 认证相关字段：profile 只覆盖这些字段，pcsPath/ua/maxBytes 保持全局
const AUTH_KEYS = ["bduss", "stoken", "cookie", "webTransport", "browserProfile", "browserPort"];

let lastLoadError = null;

// 读取配置。文件不存在 → 空配置（正常）。
// 文件存在但 JSON 解析失败 → 记录错误并返回空配置（不抛异常，否则用户连 bdp login 都跑不了），
// 但 save() 会拒绝写入 —— 防止一次无关的 --set 把用户的 BDUSS/STOKEN 覆盖抹掉且毫无告警。
function load() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("根节点必须是 JSON 对象");
    }
    lastLoadError = null;
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      lastLoadError = null;
      return {};
    }
    lastLoadError = err;
    return {};
  }
}

// 配置健康状态（供 bdp config 展示损坏告警）
function configHealth() {
  load();
  if (!lastLoadError) return { ok: true, file: CONFIG_FILE };
  return {
    ok: false,
    file: CONFIG_FILE,
    error: lastLoadError && lastLoadError.message ? lastLoadError.message : String(lastLoadError),
  };
}

function save(cfg, opts = {}) {
  // 损坏的配置不能被静默覆盖：否则用户的凭证会被一次无关的 --set 抹掉。
  // opts.force 只给 bdp login 用（那是「我明确要重新登录」的场景）。
  if (!opts.force && fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    try {
      JSON.parse(raw);
    } catch (e) {
      const err = new Error(
        "配置文件已损坏（JSON 解析失败：" +
        (e && e.message ? e.message : String(e)) +
        "），为避免覆盖你的凭证已拒绝写入：" + CONFIG_FILE +
        "。请先手动备份并修复该文件；若要强制重置，请先删除该文件再重试。"
      );
      err.code = "EBDP_CONFIG_CORRUPT";
      throw err;
    }
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 原子写：先写同目录临时文件再 rename，避免写到一半掉电把配置写坏
  const tmp = CONFIG_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// 在目录内查找 BaiduPCS-Go 二进制：
//  1) 固定路径（postinstall 目标，如 node_modules/baiduwangpan-cli/BaiduPCS-Go.exe）
//  2) 版本子目录（如 BaiduPCS-Go-v4.0.1-windows-x64/BaiduPCS-Go.exe，
//     postinstall 失败后手动解压的常见位置）
function findPCSInDir(dir) {
  if (!dir) return null;
  for (const name of PCS_BINARY_NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes("BaiduPCS-Go")) continue;
    for (const name of PCS_BINARY_NAMES) {
      const p = path.join(dir, entry.name, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

function findPCS() {
  // 1. 包根目录（postinstall 目标）：固定路径 + 版本子目录
  const pkgRoot = path.join(__dirname, "..");
  const found = findPCSInDir(pkgRoot);
  if (found) return found;
  // 2. 全局 node_modules 目录（含版本子目录）
  const nmGlobal = path.join(__dirname, "..", "..");
  const foundGlobal = findPCSInDir(nmGlobal);
  if (foundGlobal) return foundGlobal;
  // 3. Fallback to PATH
  return "BaiduPCS-Go";
}

function get() {
  const fileCfg = load();
  const profile = profileOf(fileCfg);
  const src = { ...fileCfg };
  if (profile) {
    // profile 只覆盖认证相关字段；pcsPath/ua/maxBytes 保持全局
    for (const key of AUTH_KEYS) {
      if (key in profile) src[key] = profile[key];
    }
  }
  return {
    bduss: src.bduss || process.env.BDP_BDUSS || "",
    stoken: src.stoken || process.env.BDP_STOKEN || "",
    cookie: src.cookie || process.env.BDP_COOKIE || "",
    // 默认 native：Node 内置 fetch（异步真并发 + keep-alive）。
// curl 版用 spawnSync 同步阻塞事件循环，会让所有 --concurrency 失效
// （实测 8 worker 与 1 worker 耗时相同）。
// 两者业务语义经 7 个目录逐一比对确认 100% 一致。
webTransport: src.webTransport || "native",
    browserProfile: src.browserProfile || "",
    browserPort: parseInt(src.browserPort || "0", 10) || 0,
    pcsPath: resolvePcsPath(src),
    ua: src.ua || process.env.NETDISK_UA ||
      "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;",
    maxBytes: parseInt(src.maxBytes || process.env.BDP_MAX_CAT_BYTES || "1048576", 10),
  };
}

// pcsPath 解析顺序：config 文件 → 环境变量 BAIDUPCS_CMD → 自动发现。
// 兼容 1.1.0 升级丢路径问题：若 config 里存的绝对路径已失效（升级后旧包被替换），
// 自动回退到自动发现（findPCS 会搜版本子目录），避免 search/cat/get/grep 全部报
// "BaiduPCS-Go not found at: BaiduPCS-Go"。
// 引擎文件名校验：pcsPath 只允许指向 BaiduPCS-Go 引擎。
// 否则 `bdp config --set pcsPath <任意 exe>` 就成了任意可执行文件启动器。
function looksLikeEngine(p) {
  try {
    const base = path.basename(String(p || ""));
    // 必须**精确匹配**引擎文件名（允许版本/平台后缀，如 BaiduPCS-Go-v4.0.1-windows-x64.exe）。
    // 不能用前缀匹配 —— `BaiduPCS-GoX.exe` / `BaiduPCS-Gonevil.exe` 会被前缀放行，
    // 等于重新打开「任意 exe 启动器」这条路。
    return /^BaiduPCS-Go(-v[\d.]+)?(-[a-z0-9]+)*(\.exe)?$/i.test(base);
  } catch {
    return false;
  }
}

// 控制字符检测（含 CR/LF）：既防 HTTP 头注入，也让配置投毒无法瘫痪传输层。
function hasControlChars(s) {
  return /[\u0000-\u001F\u007F]/.test(String(s === null || s === undefined ? "" : s));
}

function resolvePcsPath(fileCfg) {
  const stored = fileCfg.pcsPath || process.env.BAIDUPCS_CMD || "";
  const auto = findPCS();
  if (stored && path.isAbsolute(stored)) {
    try {
      // 存在还不够：还得确实是 BaiduPCS-Go 引擎，否则回退到自动发现
      if (fs.existsSync(stored) && looksLikeEngine(stored)) return stored;
    } catch {}
    return auto; // 绝对路径已失效 → 自动发现
  }
  return stored || auto;
}

function set(key, value) {
  const cfg = load();
  cfg[key] = value;
  save(cfg);
}

function update(values) {
  save({ ...load(), ...values });
}

function setAuth(values) {
  const cfg = load();
  const name = activeProfileName(cfg);
  const prof = profileOf(cfg);
  if (name && prof) {
    // 激活 profile：只重写该 profile 的认证字段，全局字段与其他 profile 不受影响
    const merged = { ...prof };
    for (const key of AUTH_KEYS) delete merged[key];
    cfg.profiles[name] = { ...merged, ...values };
    save(cfg, { force: true });
    return;
  }
  // 无激活 profile：保持原语义，认证字段写在全局
  for (const key of AUTH_KEYS) {
    delete cfg[key];
  }
  // setAuth 只替换认证相关字段，保留 pcsPath/ua/maxBytes 等自定义配置（升级不丢 pcsPath）
  save({ ...cfg, ...values }, { force: true });
}

function isLoggedIn() {
  const cfg = get();
  return !!(cfg.bduss && cfg.stoken);
}

// ---------- profile（多账号）----------
// 存储：config.json 内 "profiles": { "<name>": { 认证字段覆盖 } } + "activeProfile": "<name>"。
// 无 activeProfile 时一切行为与单账号完全一致（向后兼容）。

function activeProfileName(fileCfg = null) {
  const cfg = fileCfg || load();
  const name = cfg.activeProfile;
  return typeof name === "string" && name !== "" ? name : null;
}

// 返回激活 profile 的对象；activeProfile 未设置或对应条目缺失/畸形时返回 null
function profileOf(fileCfg) {
  const name = activeProfileName(fileCfg);
  if (!name) return null;
  const profiles = fileCfg.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return null;
  const p = profiles[name];
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  return p;
}

// 切换当前 profile 并持久化；name 为空串/null/undefined 表示切回全局（等价 unsetProfile()）
function useProfile(name) {
  if (name === undefined || name === null) return unsetProfile();
  const n = String(name).trim();
  if (n === "") return unsetProfile();
  const cfg = load();
  if (!cfg.profiles || typeof cfg.profiles !== "object" || Array.isArray(cfg.profiles)) {
    cfg.profiles = {};
  }
  const existing = cfg.profiles[n];
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    cfg.profiles[n] = {}; // name 不存在时建空 profile
  }
  cfg.activeProfile = n;
  save(cfg);
  return n;
}

// 切回全局：删除 activeProfile；未激活时不做任何写操作
function unsetProfile() {
  const cfg = load();
  if (!("activeProfile" in cfg)) return null;
  delete cfg.activeProfile;
  save(cfg);
  return null;
}

// 当前 profile 名（无 → null）
function getProfile() {
  return activeProfileName();
}

// [{ name, bduss? }]，按配置文件中的存储顺序
function listProfiles() {
  const cfg = load();
  const profiles = cfg.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  const out = [];
  for (const [name, p] of Object.entries(profiles)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const entry = { name };
    if (p.bduss) entry.bduss = p.bduss;
    out.push(entry);
  }
  return out;
}

// ── config --set 可写入的键（白名单）────────────────────────────
// 凭证类（bduss/stoken/cookie）**不在此列**：它们必须走 bdp login，
// 以保证同时更新引擎登录态与配置；用 --set 写会绕过这套同步。
// browserProfile/browserPort 同理（与登录态绑定）。
const CONFIG_SETTABLE = {
  webTransport: {
    values: ["curl", "native", "browser"],
    describe: "Web API 传输模式：curl(同步,每次 fork curl) | native(异步 fetch,真并发) | browser(调试用)",
  },
  maxBytes: {
    type: "integer",
    min: 1024,
    max: 64 * 1024 * 1024,
    describe: "单次读取的最大字节数",
  },
  ua: {
    type: "string",
    describe: "User-Agent（百度 dlink 对 UA 敏感）",
  },
  pcsPath: {
    type: "path",
    describe: "BaiduPCS-Go 引擎路径（失效时自动回退到自动发现）",
  },
};

const CONFIG_SECRET_KEYS = ["bduss", "stoken", "cookie", "browserProfile", "browserPort"];

/**
 * 校验并转换 --set 的值。
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
function validateConfigValue(key, raw) {
  // 用 Object.hasOwn 判定：直接 CONFIG_SETTABLE[key] 会命中 Object.prototype 的继承键
  // （如 __proto__ / toString / constructor），让白名单形同虚设。
  const spec = Object.hasOwn(CONFIG_SETTABLE, key) ? CONFIG_SETTABLE[key] : null;
  if (!spec) {
    return {
      ok: false,
      error:
        "未知配置项: " + key +
        "（可设置：" + Object.keys(CONFIG_SETTABLE).join(", ") + "）",
    };
  }
  if (spec.values) {
    if (!spec.values.includes(raw)) {
      return {
        ok: false,
        error:
          "取值非法: " + key + " = " + raw +
          "（可选：" + spec.values.join(" | ") + "）",
      };
    }
    return { ok: true, value: raw };
  }
  if (spec.type === "integer") {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
      return { ok: false, error: "取值必须是整数: " + key + " = " + raw };
    }
    if (spec.min && n < spec.min) {
      return { ok: false, error: "取值过小（最小 " + spec.min + "）: " + key + " = " + raw };
    }
    if (spec.max && n > spec.max) {
      return { ok: false, error: "取值过大（最大 " + spec.max + "）: " + key + " = " + raw };
    }
    return { ok: true, value: n };
  }
  if (spec.type === "path") {
    if (!raw || !raw.trim()) {
      return { ok: false, error: "路径不能为空: " + key };
    }
    // pcsPath 只能指向 BaiduPCS-Go 引擎：否则 --set pcsPath 就成了任意可执行文件启动器。
    if (!looksLikeEngine(raw)) {
      return {
        ok: false,
        error:
          "引擎文件名必须以 BaiduPCS-Go 开头（拒绝指向任意可执行文件）: " + raw,
      };
    }
    return { ok: true, value: raw };
  }
  if (!raw || !raw.trim()) {
    return { ok: false, error: "取值不能为空: " + key };
  }
  // 拒绝控制字符：含 CR/LF 的 ua 会让 HTTP 头非法，导致整个传输层静默瘫痪。
  if (hasControlChars(raw)) {
    return { ok: false, error: "取值不能包含控制字符（如换行、回车）: " + key };
  }
  return { ok: true, value: raw };
}

/**
 * 设置一个配置项（带白名单与值校验）。
 * @param {string} key
 * @param {string} raw
 * @returns {{ ok: true, value: any, previous: any } | { ok: false, error: string }}
 */
function setConfig(key, raw) {
  const v = validateConfigValue(key, raw);
  if (!v.ok) return v;
  const cfg = load();
  // profile 激活时，认证类字段（webTransport 等）由 profile 覆盖 ——
  // 只写全局是**静默空操作**（命令报成功，但实际值纹丝不动）。
  // 因此这类键必须写进当前 profile。
  const name = activeProfileName(cfg);
  const prof = profileOf(cfg);
  if (name && prof && AUTH_KEYS.includes(key)) {
    cfg.profiles[name] = { ...prof, [key]: v.value };
    save(cfg);
    return { ok: true, value: v.value, previous: prof[key], scope: "profile:" + name };
  }
  const previous = cfg[key];
  cfg[key] = v.value;
  save(cfg);
  return { ok: true, value: v.value, previous, scope: "global" };
}

module.exports = { get, set, update, setConfig, validateConfigValue, CONFIG_SETTABLE, CONFIG_SECRET_KEYS, setAuth, load, save, isLoggedIn, useProfile, unsetProfile, getProfile, listProfiles, findPCS, findPCSInDir, resolvePcsPath, configHealth, hasControlChars, looksLikeEngine, CONFIG_DIR, CONFIG_FILE };
