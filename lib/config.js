const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".bdp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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

function get() {
  const fileCfg = load();
  return {
    bduss: fileCfg.bduss || process.env.BDP_BDUSS || "",
    stoken: fileCfg.stoken || process.env.BDP_STOKEN || "",
    pcsPath: fileCfg.pcsPath || process.env.BAIDUPCS_CMD || findPCS(),
    ua: fileCfg.ua || process.env.NETDISK_UA ||
      "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;",
    maxBytes: parseInt(fileCfg.maxBytes || process.env.BDP_MAX_CAT_BYTES || "1048576", 10),
  };
}

function set(key, value) {
  const cfg = load();
  cfg[key] = value;
  save(cfg);
}

function findPCS() {
  const local = path.join(__dirname, "..", "..", "BaiduPCS-Go.exe");
  if (fs.existsSync(local)) return local;
  return "BaiduPCS-Go";
}

function isLoggedIn() {
  const cfg = get();
  return !!(cfg.bduss && cfg.stoken);
}

module.exports = { get, set, load, save, isLoggedIn, CONFIG_DIR, CONFIG_FILE };
