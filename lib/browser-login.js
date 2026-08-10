const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const PAN_HOME = "https://pan.baidu.com/disk/main";
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".bdp", "browser-profile");
const APP_ID = "250528";

let activeSession = null;
let disconnectTimer = null;

function findBrowser() {
  const candidates = [];

  if (os.platform() === "win32") {
    const programFiles = [
      process.env.PROGRAMFILES || "C:\\Program Files",
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      process.env.LOCALAPPDATA || "",
    ];
    for (const pf of programFiles) {
      candidates.push(path.join(pf, "Google\\Chrome\\Application\\chrome.exe"));
      candidates.push(path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"));
    }
  }

  if (os.platform() === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  }

  for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "chrome"]) {
    try {
      const out = execSync(`command -v ${name}`, { stdio: "pipe" }).toString().trim();
      if (out) candidates.push(out);
    } catch {}
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function httpRequest(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.setTimeout(2000, () => req.destroy(new Error("DevTools request timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function getDevToolsVersion(port) {
  const raw = await httpRequest(`http://127.0.0.1:${port}/json/version`);
  const version = JSON.parse(raw);
  if (!version.webSocketDebuggerUrl || !/Chrome|Chromium|Edg/i.test(version.Browser || "")) {
    throw new Error("The configured DevTools port is not a Chromium browser");
  }
  return version;
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await getDevToolsVersion(port);
    } catch {}
    await delay(300);
  }
  throw new Error("DevTools 启动超时");
}

async function listTabs(port) {
  return JSON.parse(await httpRequest(`http://127.0.0.1:${port}/json/list`));
}

async function openTab(port, url) {
  const encoded = encodeURIComponent(url);
  return JSON.parse(await httpRequest(`http://127.0.0.1:${port}/json/new?${encoded}`, "PUT"));
}

function getWebSocketImpl() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  try {
    return require("ws");
  } catch {
    throw new Error("Browser login requires Node.js 22+ or the optional 'ws' package");
  }
}

class CDPClient {
  constructor(wsUrl) {
    const WebSocketImpl = getWebSocketImpl();
    this.ws = new WebSocketImpl(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("WebSocket 连接失败"));
      this.ws.onclose = () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("DevTools connection closed"));
        }
        this.pending.clear();
      };
      this.ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const msg = JSON.parse(raw);
        if (msg.id && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

function randomPort() {
  return 9000 + Math.floor(Math.random() * 2000);
}

function launchBrowser(browser, profileDir, port, { minimized = false } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
  ];
  if (minimized) args.push("--start-minimized");
  args.push("about:blank");

  const proc = spawn(browser, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: minimized,
  });
  proc.unref();
  return proc;
}

async function connectPanTab(port) {
  const tabs = await listTabs(port);
  let tab = tabs.find((item) => item.type === "page" && /^https:\/\/pan\.baidu\.com\//.test(item.url));
  if (!tab) tab = await openTab(port, PAN_HOME);

  const cdp = new CDPClient(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");
  return { cdp, tab };
}

async function waitForPanPage(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: "location.hostname === 'pan.baidu.com' && document.readyState !== 'loading'",
        returnByValue: true,
      });
      if (result.result?.value === true) return;
    } catch {}
    await delay(300);
  }
  throw new Error("百度网盘页面加载超时");
}

async function evaluateFetch(cdp, url, options = {}) {
  const request = {
    method: options.method || "GET",
    credentials: "include",
    headers: options.headers || {},
  };
  if (Object.prototype.hasOwnProperty.call(options, "body")) request.body = options.body;

  const expression = `fetch(${JSON.stringify(url)}, ${JSON.stringify(request)})
    .then(async response => ({
      ok: response.ok,
      status: response.status,
      url: response.url,
      text: await response.text()
    }))`;
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (evaluated.exceptionDetails) {
    const message = evaluated.exceptionDetails.exception?.description ||
      evaluated.exceptionDetails.text || "Browser fetch failed";
    throw new Error(message);
  }
  const response = evaluated.result?.value;
  if (!response || typeof response.text !== "string") {
    throw new Error("Browser fetch returned no response");
  }
  return response;
}

async function openPersistentSession({ browser, profileDir, port, minimized }) {
  let proc = null;
  try {
    await getDevToolsVersion(port);
  } catch {
    proc = launchBrowser(browser, profileDir, port, { minimized });
    await waitForDevTools(port, 15000);
  }
  const { cdp, tab } = await connectPanTab(port);
  return { browser, profileDir, port, proc, cdp, tab };
}

async function getBrowserSession(settings = {}) {
  if (activeSession) {
    try {
      await activeSession.cdp.send("Runtime.evaluate", { expression: "1" });
      return activeSession;
    } catch {
      activeSession.cdp.close();
      activeSession = null;
    }
  }

  const browser = settings.browser || findBrowser();
  if (!browser) throw new Error("未找到 Chrome/Edge，无法使用扫码登录会话调用网页 API");
  const profileDir = settings.profileDir || DEFAULT_PROFILE_DIR;
  const configuredPort = Number(settings.port) || randomPort();

  try {
    activeSession = await openPersistentSession({
      browser,
      profileDir,
      port: configuredPort,
      minimized: true,
    });
  } catch (error) {
    if (!settings.port) throw error;
    activeSession = await openPersistentSession({
      browser,
      profileDir,
      port: randomPort(),
      minimized: true,
    });
  }
  await waitForPanPage(activeSession.cdp);
  if (settings.onPort) settings.onPort(activeSession.port);
  return activeSession;
}

async function browserJson(url, options = {}, settings = {}) {
  const session = await getBrowserSession(settings);
  let response;
  try {
    response = await evaluateFetch(session.cdp, url, options);
  } catch (error) {
    session.cdp.close();
    activeSession = null;
    throw error;
  }

  try {
    return JSON.parse(response.text.replace(/^\s+/, ""));
  } catch {
    return { _raw: response.text, _status: response.status, _url: response.url };
  } finally {
    scheduleDisconnect();
  }
}

function getTemplateVariableUrl() {
  const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]');
  return `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}&web=1&fields=${fields}`;
}

async function browserLogin({
  timeoutMs = 180000,
  onStatus,
  profileDir = DEFAULT_PROFILE_DIR,
  port = randomPort(),
} = {}) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error("未找到 Chrome/Edge。请手动获取 BDUSS/STOKEN 后使用 bdp login --bduss --stoken");
  }
  port = Number(port) || randomPort();

  if (onStatus) onStatus("启动浏览器...");
  let proc = null;

  let cdp;
  try {
    try {
      await getDevToolsVersion(port);
    } catch {
      proc = launchBrowser(browser, profileDir, port);
      await waitForDevTools(port, 15000);
    }
    const tab = await openTab(port, PAN_HOME);
    if (onStatus) onStatus("浏览器已打开，请登录百度网盘（扫码或账号密码均可）...");

    cdp = new CDPClient(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");

    const deadline = Date.now() + timeoutMs;
    let lastStatus = "";
    let authRetries = 0;

    while (Date.now() < deadline) {
      try {
        const { cookies } = await cdp.send("Network.getCookies", {
          urls: ["https://pan.baidu.com/", "https://passport.baidu.com/"],
        });
        const bduss = cookies.find((cookie) => cookie.name === "BDUSS")?.value || "";
        const stoken = cookies.find((cookie) => cookie.name === "STOKEN")?.value || "";
        const status = bduss ? (stoken ? "both" : "bduss-only") : "none";

        if (status !== lastStatus) {
          lastStatus = status;
          if (status === "both" && onStatus) onStatus("检测到登录凭证，正在浏览器会话内验证...");
          if (status === "bduss-only" && onStatus) onStatus("已检测到 BDUSS，等待 STOKEN...");
        }

        if (bduss && stoken) {
          await waitForPanPage(cdp, 5000);
          const response = await evaluateFetch(cdp, getTemplateVariableUrl());
          const data = JSON.parse(response.text.replace(/^\s+/, ""));
          const bdstoken = data?.result?.bdstoken;
          if (data?.errno === 0 && bdstoken) {
            await minimizeWindow(cdp, tab.id);
            cdp.close();
            return { bduss, stoken, bdstoken, browserProfile: profileDir, browserPort: port };
          }

          authRetries++;
          if (onStatus && authRetries % 3 === 0) {
            onStatus("登录凭证尚未通过网页 API 验证，请等待页面完成跳转...");
          }
        }
      } catch {}
      await delay(1500);
    }

    throw new Error(`等待登录超时（${Math.round(timeoutMs / 1000)}秒）`);
  } catch (error) {
    if (cdp) cdp.close();
    killBrowser(proc);
    throw error;
  }
}

function scheduleDisconnect() {
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = setTimeout(disconnectBrowserSession, 500);
  disconnectTimer.unref();
}

function disconnectBrowserSession() {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  if (activeSession) {
    activeSession.cdp.close();
    activeSession = null;
  }
}

async function minimizeWindow(cdp, targetId) {
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  } catch {}
}

function killBrowser(proc) {
  if (!proc || proc.killed) return;
  try {
    if (os.platform() === "win32") {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  browserLogin,
  browserJson,
  findBrowser,
  DEFAULT_PROFILE_DIR,
  disconnectBrowserSession,
  _internals: { CDPClient, evaluateFetch, getTemplateVariableUrl },
};
