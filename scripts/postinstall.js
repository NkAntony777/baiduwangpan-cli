#!/usr/bin/env node

/**
 * postinstall.js — 自动下载 BaiduPCS-Go 二进制
 *
 * 跨平台支持: Windows / macOS / Linux (x64, arm64, 386)
 * 下载加速:   镜像(ghfast/ghproxy...) 优先 → GitHub 兜底（大陆网络 GitHub 常 DNS 污染）
 * 解压方式:   Windows (PowerShell) / Unix (unzip / python3 / tar)
 *
 * 1.1.0 已知问题修复:
 *  - 镜像顺序: 国内网络优先用 ghfast/ghproxy，GitHub 放最后
 *  - download() 补 file stream error 处理：第一个镜像部分下载失败时不再直接崩溃，
 *    确保 5 个源按顺序 fallback（此前"只跑 1 行就抛出"）
 *  - 全部失败时打印每个源的完整下载地址，便于手动下载
 *  - 发现版本子目录(BaiduPCS-Go-vX/)里的二进制时提升到固定路径（修复后无需手改 config）
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

// GitHub 下载加速镜像（按优先级排列）：大陆网络优先镜像，GitHub 放最后兜底
const MIRRORS = [
  (asset) => `https://ghfast.top/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://mirror.ghproxy.com/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
  (asset) => `https://github.com/${REPO}/releases/download/${VERSION}/${asset}`,
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
        try { file.close(); } catch {}
        fs.unlink(dest, () => {});
        reject(new Error("timeout"));
      }
    }, timeout);

    // 统一失败路径：清定时器 + 关流 + 删残留文件。file stream 的 error 也走这里，
    // 防止第一个镜像部分下载失败后 file 抛 EPIPE/ENOSPC 未捕获导致整个 postinstall 崩溃
    // （1.1.0 实测"只跑 1 行就抛出"，fallback 没机会执行）。
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { file.close(); } catch {}
      fs.unlink(dest, () => {});
      reject(err);
    };

    file.on("error", (e) => fail(e));

    const req = (url, redirects = 0) => {
      if (redirects > 5) {
        fail(new Error("too many redirects"));
        return;
      }

      const client = url.startsWith("https") ? https : http;
      let r;
      try {
        r = client.get(url, { timeout: 15000 }, (res) => {
          // 处理重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            req(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`HTTP ${res.statusCode}`));
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
      } catch (e) {
        fail(e);
        return;
      }

      r.on("error", (e) => fail(e));

      r.on("timeout", () => {
        if (!settled) {
          r.destroy();
          fail(new Error("connection timeout"));
        }
      });
    };

    req(url);
  });
}

async function downloadWithMirrors(assetName, dest) {
  const errors = [];
  for (let i = 0; i < MIRRORS.length; i++) {
    const url = MIRRORS[i](assetName);
    const label = i === MIRRORS.length - 1 ? "GitHub" : new URL(MIRRORS[i]("x")).hostname;
    process.stdout.write(`  bdp: trying ${label}...`);
    try {
      await download(url, dest, 90000);
      console.log(" OK");
      return { ok: true, url, label };
    } catch (e) {
      const msg = e.message || String(e);
      errors.push(`${label}: ${msg}`);
      console.log(` failed (${msg})`);
      if (fs.existsSync(dest)) {
        try { fs.unlinkSync(dest); } catch {}
      }
      // GitHub DNS 污染提示
      if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg) && label === "GitHub") {
        console.log("  bdp:   （GitHub 解析失败——大陆网络常见 DNS 污染，前面的镜像通常可用）");
      }
    }
  }
  return { ok: false, errors };
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

function findExistingBinary(binName) {
  const binPath = path.join(PKG_ROOT, binName);
  if (fs.existsSync(binPath)) return { path: binPath, versioned: false };
  // 版本子目录（上次 postinstall 失败后手动解压的常见位置）
  try {
    for (const entry of fs.readdirSync(PKG_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.includes("BaiduPCS-Go")) {
        const p = path.join(PKG_ROOT, entry.name, binName);
        if (fs.existsSync(p)) return { path: p, versioned: true };
      }
    }
  } catch {}
  return null;
}

async function main() {
  const binName = getBinaryName();
  const binPath = path.join(PKG_ROOT, binName);

  // 已存在则跳过；版本子目录里的二进制提升到固定路径（CLI 固定路径优先，且不依赖版本号）
  const existing = findExistingBinary(binName);
  if (existing) {
    if (existing.versioned) {
      try {
        fs.copyFileSync(existing.path, binPath);
        if (os.platform() !== "win32") { try { fs.chmodSync(binPath, 0o755); } catch {} }
        console.log(`  bdp: ✅ BaiduPCS-Go promoted from ${path.basename(path.dirname(existing.path))} to fixed path.`);
      } catch (e) {
        console.log(`  bdp: ⚠️  版本子目录已发现但提升失败: ${e.message}`);
      }
    } else {
      console.log("  bdp: BaiduPCS-Go already exists, skipping.");
    }
    return;
  }

  const { assetName } = getAssetName();
  const zipPath = path.join(PKG_ROOT, assetName);

  console.log("");
  console.log("  bdp: Installing BaiduPCS-Go (百度网盘 CLI 引擎)...");

  // 下载（镜像优先 → GitHub 兜底）
  const result = await downloadWithMirrors(assetName, zipPath);
  if (!result.ok) {
    console.warn("  bdp: ⚠️  所有下载源失败（大陆网络常见：GitHub DNS 污染 / 镜像暂时抽风）。");
    console.warn(`  bdp: 请手动下载 ${assetName}（任一地址均可）:`);
    for (const m of MIRRORS) console.warn(`  bdp:   ${m(assetName)}`);
    console.warn(`  bdp: 解压后把 ${binName} 放到: ${PKG_ROOT}`);
    console.warn("  bdp:   （或版本子目录，如 BaiduPCS-Go-v4.0.1-windows-x64/，CLI 会自动发现）");
    console.warn("  bdp: 也可直接确保 BaiduPCS-Go 在 PATH 中（包仍可正常使用）。");
    console.warn("");
    process.exit(0); // 不阻断 npm install
  }

  // 解压
  console.log("  bdp: Extracting...");
  if (!extractZip(zipPath, PKG_ROOT)) {
    console.warn(`  bdp: ⚠️  解压失败。请手动解压: ${zipPath}`);
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
    console.warn("  bdp: ⚠️  解压后未找到二进制。");
    console.warn(`  bdp: 请手动解压并把 ${binName} 放到: ${PKG_ROOT}`);
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
