const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = process.env.BDP_CONFIG_DIR || path.join(os.homedir(), ".bdp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const PCS_BINARY_NAMES = ["BaiduPCS-Go.exe", "BaiduPCS-Go"];

// 认证相关字段：profile 只覆盖这些字段，pcsPath/ua/maxBytes 保持全局
const AUTH_KEYS = ["bduss", "stoken", "cookie", "webTransport", "browserProfile", "browserPort"];

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
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
    webTransport: src.webTransport || "curl",
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
function resolvePcsPath(fileCfg) {
  const stored = fileCfg.pcsPath || process.env.BAIDUPCS_CMD || "";
  const auto = findPCS();
  if (stored && path.isAbsolute(stored)) {
    try {
      if (fs.existsSync(stored)) return stored;
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
    save(cfg);
    return;
  }
  // 无激活 profile：保持原语义，认证字段写在全局
  for (const key of AUTH_KEYS) {
    delete cfg[key];
  }
  // setAuth 只替换认证相关字段，保留 pcsPath/ua/maxBytes 等自定义配置（升级不丢 pcsPath）
  save({ ...cfg, ...values });
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

module.exports = { get, set, update, setAuth, load, save, isLoggedIn, useProfile, unsetProfile, getProfile, listProfiles, findPCS, findPCSInDir, resolvePcsPath, CONFIG_DIR, CONFIG_FILE };
