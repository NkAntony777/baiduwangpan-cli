const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = process.env.BDP_CONFIG_DIR || path.join(os.homedir(), ".bdp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const PCS_BINARY_NAMES = ["BaiduPCS-Go.exe", "BaiduPCS-Go"];

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
  return {
    bduss: fileCfg.bduss || process.env.BDP_BDUSS || "",
    stoken: fileCfg.stoken || process.env.BDP_STOKEN || "",
    cookie: fileCfg.cookie || process.env.BDP_COOKIE || "",
    webTransport: fileCfg.webTransport || "curl",
    browserProfile: fileCfg.browserProfile || "",
    browserPort: parseInt(fileCfg.browserPort || "0", 10) || 0,
    pcsPath: resolvePcsPath(fileCfg),
    ua: fileCfg.ua || process.env.NETDISK_UA ||
      "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;",
    maxBytes: parseInt(fileCfg.maxBytes || process.env.BDP_MAX_CAT_BYTES || "1048576", 10),
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
  for (const key of ["bduss", "stoken", "cookie", "webTransport", "browserProfile", "browserPort"]) {
    delete cfg[key];
  }
  // setAuth 只替换认证相关字段，保留 pcsPath/ua/maxBytes 等自定义配置（升级不丢 pcsPath）
  save({ ...cfg, ...values });
}

function isLoggedIn() {
  const cfg = get();
  return !!(cfg.bduss && cfg.stoken);
}

module.exports = { get, set, update, setAuth, load, save, isLoggedIn, findPCS, findPCSInDir, resolvePcsPath, CONFIG_DIR, CONFIG_FILE };
