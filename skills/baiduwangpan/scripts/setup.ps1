# baiduwangpan skill 安装脚本 (Windows PowerShell)
# 用法: powershell -ExecutionPolicy Bypass -File setup.ps1

Write-Host "=== baiduwangpan-cli 安装 ===" -ForegroundColor Cyan

# 1. 检查 node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 未找到 Node.js。请先安装 Node.js 14+: https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Node.js: $(node --version)" -ForegroundColor Green

# 2. 安装 bdp
if (Get-Command bdp -ErrorAction SilentlyContinue) {
    Write-Host "✅ bdp 已安装" -ForegroundColor Green
} else {
    Write-Host "→ 安装 baiduwangpan-cli (全局)..." -ForegroundColor Yellow
    npm install -g baiduwangpan-cli
    Write-Host "✅ bdp 安装完成" -ForegroundColor Green
}

# 3. 检查 BaiduPCS-Go 引擎
try {
    $cfg = bdp config --json 2>$null | Out-String | ConvertFrom-Json
    if ($cfg.pcsPath -and (Test-Path $cfg.pcsPath)) {
        Write-Host "✅ 引擎就绪: $($cfg.pcsPath)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  未检测到 BaiduPCS-Go 引擎，见 reference/troubleshooting.md" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  无法检测引擎状态，见 reference/troubleshooting.md" -ForegroundColor Yellow
}

# 4. 检查登录状态
Write-Host ""
$status = bdp whoami --json 2>$null | Out-String | ConvertFrom-Json
if ($status.loggedIn) {
    Write-Host "✅ 已登录百度网盘" -ForegroundColor Green
} else {
    Write-Host "⚠️  尚未配置凭证。" -ForegroundColor Yellow
    Write-Host "   请运行: bdp login --bduss <BDUSS值> --stoken <STOKEN值>" -ForegroundColor Yellow
    Write-Host "   获取方法见 reference/authentication.md" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 安装完成 ===" -ForegroundColor Green
Write-Host "快速测试: bdp ls /"
