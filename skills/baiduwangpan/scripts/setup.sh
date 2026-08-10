#!/usr/bin/env bash
# baiduwangpan skill 安装脚本 (macOS / Linux)
# 用法: bash setup.sh

set -e

echo "=== baiduwangpan-cli 安装 ==="

# 1. 检查 node
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js。请先安装 Node.js 14+: https://nodejs.org"
  exit 1
fi
echo "✅ Node.js: $(node --version)"

# 2. 检查 curl
if ! command -v curl &>/dev/null; then
  echo "❌ 未找到 curl。请安装 curl。"
  exit 1
fi
echo "✅ curl 已安装"

# 3. 安装或升级 bdp
echo "→ 安装/升级 baiduwangpan-cli (全局)..."
npm install -g baiduwangpan-cli@latest
echo "✅ bdp 已更新到最新版本"

# 3.1 检查 BaiduPCS-Go 引擎
ENGINE=$(bdp config --json 2>/dev/null | grep -o '"pcsPath": *"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$ENGINE" ] && [ -x "$ENGINE" ]; then
  echo "✅ 引擎就绪: $ENGINE"
else
  echo "⚠️  未检测到 BaiduPCS-Go 引擎，见 reference/troubleshooting.md"
fi

# 4. 检查登录状态
echo ""
if bdp whoami --json 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "✅ 已登录百度网盘"
else
  echo "⚠️  尚未配置凭证。"
  echo "   请运行: bdp login"
  echo "   无 Chrome/Edge 时见 reference/authentication.md 使用手动凭证"
fi

echo ""
echo "=== 安装完成 ==="
echo "快速测试: bdp ls /"
