#!/usr/bin/env node

/**
 * postinstall.js — 自动下载 BaiduPCS-Go 二进制
 *
 * 跨平台支持: Windows / macOS / Linux (x64, arm64, 386)
 * 下载加速:   GitHub → ghproxy 镜像 → ghfast 镜像 → 降级提示
 * 解压方式:   Windows (PowerShell) / Unix (unzip / python3 / tar)
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execSync } = require("child_process");

const PKG_ROOT = path.join(__dirname, "..");
const REPO = "qjfoidnh/BaiduPCS-Go";
const VERSION = "v4.0.1";

// GitHub 下载加速镜像（按优先级排列）
const MIRRORS = [
  (asset) => `https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://ghfast.top/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://mirror.ghproxy.com/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
];

// ── 平台检测 ────────────────────────────────────────────

function getAssetName() {
  const platform = os.platform();
  const arch = os.arch();

  let osName, archName;

  switch (platform) {
    case "win32": osName = "windows"; break;
    case "darwin": osName = "darwin-osx"; break;
    case "linux": osName = "linux"; break;
    case "freebsd": osName = "freebsd"; break;
    default: throw new Error(`Unsupported platform: ${platform}`);
  }

  switch (arch) {
    case "x64":
      archName = osName === "windows" ? "x64" : "amd64";
      break;
    case "arm64":
    case "aarch64":
      archName = "arm64";
      break;
    case "ia32":
    case "x32":
    case "arm":
      archName = (osName === "windows") ? "x86" : "386";
      break;
    case "mips":
      archName = osName === "linux" ? "mips" : arch;
      break;
    case "mipsel":
      archName = osName === "linux" ? "mipsle" : arch;
      break;
    default:
      throw new Error(`Unsupported arch: ${arch}`);
  }

  return { assetName: `BaiduPCS-Go-${VERSION}-${osName}-${archName}.zip`, osName, archName };
}

function getBinaryName() {
  return os.platform() === "win32" ? "BaiduPCS-Go.exe" : "BaiduPCS-Go";
}

// ── 下载 ────────────────────────────────────────────────

function download(url, dest, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error("timeout"));
      }
    }, timeout);

    const req = (url, redirects = 0) => {
      if (redirects > 5) {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("too many redirects")); }
        return;
      }

      const client = url.startsWith("https") ? https : http;
      const r = client.get(url, { timeout: 15000 }, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          req(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error(`HTTP ${res.statusCode}`));
          }
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          });
        });
      });

      r.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          file.close();
          fs.unlink(dest, () => {});
          reject(e);
        }
      });

      r.on("timeout", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          r.destroy();
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error("connection timeout"));
        }
      });
    };

    req(url);
  });
}

async function downloadWithMirrors(assetName, dest) {
  for (let i = 0; i < MIRRORS.length; i++) {
    const url = MIRRORS[i](assetName);
    const label = i === 0 ? "GitHub" : new URL(MIRRORS[i]("x")).hostname;
    process.stdout.write(`  bdp: trying ${label}...`);
    try {
      await download(url, dest, 90000);
      console.log(" OK");
      return true;
    } catch (e) {
      console.log(` failed (${e.message})`);
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  }
  return false;
}

// ── 解压 ────────────────────────────────────────────────

function extractZip(zipPath, destDir) {
  const platform = os.platform();

  // Windows: PowerShell
  if (platform === "win32") {
    try {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: "ignore", timeout: 30000 }
      );
      return true;
    } catch { /* fall through */ }
  }

  // Unix: unzip
  const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "ignore", timeout: 30000 });
  if (unzip.status === 0) return true;

  // Fallback: python3
  try {
    execSync(
      `python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "${zipPath}" "${destDir}"`,
      { stdio: "ignore", timeout: 30000 }
    );
    return true;
  } catch { /* fall through */ }

  // Fallback: python
  try {
    execSync(
      `python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "${zipPath}" "${destDir}"`,
      { stdio: "ignore", timeout: 30000 }
    );
    return true;
  } catch { /* fall through */ }

  return false;
}

// ── 主逻辑 ──────────────────────────────────────────────

async function main() {
  const binName = getBinaryName();
  const binPath = path.join(PKG_ROOT, binName);

  // 已存在则跳过
  if (fs.existsSync(binPath)) {
    console.log("  bdp: BaiduPCS-Go already exists, skipping.");
    return;
  }

  const { assetName } = getAssetName();
  const zipPath = path.join(PKG_ROOT, assetName);

  console.log("");
  console.log("  bdp: Installing BaiduPCS-Go (百度网盘 CLI 引擎)...");

  // 下载
  const ok = await downloadWithMirrors(assetName, zipPath);
  if (!ok) {
    console.warn("  bdp: ⚠️  All download mirrors failed.");
    console.warn(`  bdp: Please manually download ${assetName}`);
    console.warn(`  bdp: from https://github.com/${REPO}/releases/tag/${VERSION}`);
    console.warn(`  bdp: and extract ${binName} to: ${PKG_ROOT}`);
    console.warn("  bdp: (the package still works if BaiduPCS-Go is in your PATH)");
    console.warn("");
    process.exit(0); // 不阻断 npm install
  }

  // 解压
  console.log("  bdp: Extracting...");
  if (!extractZip(zipPath, PKG_ROOT)) {
    console.warn(`  bdp: ⚠️  Cannot extract. Please manually unzip: ${zipPath}`);
    process.exit(0);
  }

  // 查找并移动二进制
  let found = false;
  function searchDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === binName) {
        const src = path.join(dir, entry.name);
        if (!found) {
          fs.copyFileSync(src, binPath);
          found = true;
        }
      }
      if (entry.isDirectory() && entry.name.includes("BaiduPCS-Go")) {
        searchDir(path.join(dir, entry.name));
      }
    }
  }
  searchDir(PKG_ROOT);

  if (found) {
    // Unix 设置可执行权限
    if (os.platform() !== "win32") {
      try { fs.chmodSync(binPath, 0o755); } catch {}
    }
    console.log(`  bdp: ✅ BaiduPCS-Go installed.`);
  } else {
    console.warn("  bdp: ⚠️  Binary not found after extraction.");
    console.warn(`  bdp: Please manually extract and place ${binName} in: ${PKG_ROOT}`);
  }

  // 清理 zip 和解压目录
  try { fs.unlinkSync(zipPath); } catch {}
  for (const entry of fs.readdirSync(PKG_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.includes("BaiduPCS-Go-v")) {
      try { fs.rmSync(path.join(PKG_ROOT, entry.name), { recursive: true }); } catch {}
    }
  }

  console.log("");
}

main().catch((e) => {
  console.warn(`  bdp: ⚠️  Post-install error: ${e.message}`);
  console.warn("  bdp: The package will still work if BaiduPCS-Go is in your PATH.");
  process.exit(0); // 永不阻断 npm install
});
