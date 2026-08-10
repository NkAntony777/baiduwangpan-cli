const { spawnSync } = require("child_process");
const config = require("./config");

function buildCookieHeader(cfg) {
  if (cfg.cookie) return cfg.cookie;
  return `BDUSS=${cfg.bduss}; STOKEN=${cfg.stoken}`;
}

function curlGet(url, extraHeaders = {}) {
  const cfg = config.get();
  const headers = {
    Cookie: buildCookieHeader(cfg),
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://pan.baidu.com/disk/main",
    ...extraHeaders,
  };

  const args = ["-s", "-L", "--max-time", "30", "--compressed"];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  return result.stdout || "";
}

function curlPost(url, body = "", extraHeaders = {}) {
  const cfg = config.get();
  const headers = {
    Cookie: buildCookieHeader(cfg),
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://pan.baidu.com/disk/main",
    "Content-Type": "application/x-www-form-urlencoded",
    ...extraHeaders,
  };

  const args = ["-s", "-L", "-X", "POST", "--max-time", "30", "--compressed"];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (body) args.push("-d", body);
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  return result.stdout || "";
}

function curlRange(url, start, end, ua) {
  const rangeArg = end != null ? `${start}-${end}` : `${start}-`;
  const args = [
    "-s", "-L",
    "-r", rangeArg,
    "-H", `User-Agent: ${ua}`,
    "-H", `Range: bytes=${rangeArg}`,
    "--max-time", "30",
    url,
  ];
  const result = spawnSync("curl", args, { maxBuffer: 60 * 1024 * 1024 });
  return result.stdout || Buffer.alloc(0);
}

function curlJson(url, options = {}) {
  const text = options.method === "POST"
    ? curlPost(url, options.body || "", options.headers || {})
    : curlGet(url, options.headers || {});
  const cleaned = text.replace(/^\s+/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return { _raw: cleaned };
  }
}

async function webJson(url, options = {}) {
  const cfg = config.get();
  if (cfg.webTransport !== "browser") return curlJson(url, options);

  const { browserJson } = require("./browser-login");
  const headers = { ...(options.headers || {}) };
  if (options.method === "POST" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return browserJson(
    url,
    {
      method: options.method || "GET",
      ...(Object.prototype.hasOwnProperty.call(options, "body") ? { body: options.body } : {}),
      headers,
    },
    {
      profileDir: cfg.browserProfile,
      port: cfg.browserPort,
      onPort: (browserPort) => {
        if (browserPort !== cfg.browserPort) config.update({ browserPort });
      },
    }
  );
}

async function getBdstoken() {
  const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]');
  const data = await webJson(
    `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=${fields}`
  );
  const token = data?.result?.bdstoken || null;
  if (!token) {
    const cfg = require("./config").get();
    throw new Error(
      `Cannot get bdstoken. The web session is not authenticated.\n` +
      `  BDUSS: ${cfg.bduss ? "set" : "MISSING"}  STOKEN: ${cfg.stoken ? "set" : "MISSING"}\n` +
      `  Web API transport: ${cfg.webTransport}\n` +
      `  Run: bdp login, or bdp login --bduss <value> --stoken <value>`
    );
  }
  return token;
}

const APP_ID = "250528";
const PAN_BASE = "https://pan.baidu.com";

module.exports = { curlGet, curlPost, curlRange, curlJson, webJson, getBdstoken, APP_ID, PAN_BASE };
