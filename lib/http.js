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
  if (cfg.webTransport === "native") return webJsonAsync(url, options);
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

// bdstoken 短缓存：getFileMetaWeb 每次下载/peek 都要取一次 bdstoken（1 个 HTTP 往返），
// 而 token 实际有效期很长，缓存 10 分钟显著减少重复请求
let bdstokenCache = { token: null, expiresAt: 0 };

async function getBdstoken({ forceRefresh = false } = {}) {
  if (!forceRefresh && bdstokenCache.token && Date.now() < bdstokenCache.expiresAt) {
    return bdstokenCache.token;
  }
  const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]');
  const data = await webJson(
    `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=${fields}`
  );
  const token = data?.result?.bdstoken || null;
  if (!token) {
    const cfg = require("./config").get();
    throw new Error(
      `无法获取 bdstoken: Web 会话未认证。\n` +
      `  BDUSS: ${cfg.bduss ? "set" : "MISSING"}  STOKEN: ${cfg.stoken ? "set" : "MISSING"}\n` +
      `  Web API transport: ${cfg.webTransport}\n` +
      `  Run: bdp login, or bdp login --bduss <value> --stoken <value>`
    );
  }
  bdstokenCache = { token, expiresAt: Date.now() + 10 * 60 * 1000 };
  return token;
}

const APP_ID = "250528";
const PAN_BASE = "https://pan.baidu.com";

/**
 * 原生 fetch 实现（webTransport = "native"）。
 *
 * 为什么要它：curl 版用 spawnSync 同步起进程，**阻塞事件循环** ——
 * 于是所有 --concurrency 参数都是假的（实测 8 worker 与 1 worker 耗时相同）。
 * fetch 是异步的，真正并行；且 Node 内置 keep-alive，连接可复用，
 * 不必每次都新建 TCP+TLS 连接。
 *
 * 保留 curl 版作为默认，是为了不改变既有行为（百度的 UA/风控策略未验证过）。
 */
async function fetchText(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  return await res.text();
}

async function fetchBuffer(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 异步 Range 读取。返回 Buffer（与 curlRange 同语义）。
 */
async function fetchRange(url, start, end, ua) {
  const headers = { "User-Agent": ua };
  if (end != null) headers.Range = `bytes=${start}-${end}`;
  else headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Range 请求失败: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 异步 web JSON 请求。
 */
async function webJsonAsync(url, options = {}) {
  const cfg = config.get();
  const headers = {
    Cookie: buildCookieHeader(cfg),
    "User-Agent": cfg.ua || DEFAULT_UA,
    Referer: "https://pan.baidu.com/disk/main",
    ...(options.headers || {}),
  };
  const init = { method: options.method || "GET", headers, redirect: "follow" };
  if (options.method === "POST") {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = options.body || "";
  }
  let text;
  try {
    text = await fetchText(url, headers);
  } catch (e) {
    throw new Error(`网络请求失败: ${e.message}`);
  }
  const cleaned = text.replace(/^\s+/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return { _raw: cleaned };
  }
}

module.exports = {
  curlGet, curlPost, curlRange, curlJson, webJson, getBdstoken, APP_ID, PAN_BASE,
  fetchRange, webJsonAsync, fetchText, fetchBuffer,
};
