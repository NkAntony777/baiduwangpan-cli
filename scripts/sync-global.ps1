#Requires -Version 5.1
<#
.SYNOPSIS
    把源仓（唯一来源）本次改动同步到 npm 全局安装副本。

.DESCRIPTION
    纪律：**源仓是唯一来源**。改完源仓 → 跑一次本脚本 → 全局副本即最新。

    硬约束：
      · **不联网**、**不 npm install / npm update** —— 只做**逐文件复制**；
      · 路径写成**字面量绝对路径**（不靠 $env: 推导，避免换机器就指错地方）；
      · 可**重复运行**（幂等）：已一致的文件照样复制，不报错；
      · 可**自检**：复制后逐文件比对 SHA256，不一致就**报告**而不是静默跳过；
      · 只同步**本次改动涉及的文件**，不覆盖全局副本里的其它差异。

    为什么必须有这个脚本：npm update / 重装会**覆盖**全局副本里的补丁。
    本仓的修复（测试临时目录不漏 + 后续任何改动）都住在源仓里，
    全局副本随时可能被重装冲掉 ⇒ 每次重装后跑一次本脚本即可恢复。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\sync-global.ps1
#>
[CmdletBinding()]
param(
    # 只自检、不复制
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

# ── 字面量绝对路径（唯一来源 = 源仓）──────────────────────────────────
$SourceRoot = 'D:\coding\my-project\baiduwangpan-cli'
$GlobalRoot = 'C:\Users\16439\AppData\Roaming\npm\node_modules\baiduwangpan-cli'

# ── 本次改动涉及的文件（源仓相对路径）────────────────────────────────
#    只同步这些；全局副本的其它差异一律不碰（先在报告里列出来）。
$Files = @(
    'test\tmp-store.js',
    'test\tmp-helper.js',
    'test\pan.test.js',
    'scripts\sync-global.ps1',
    'docs\tmp-leak-fix.md',
    '.gitignore',
    'README.md'
)

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# ── 前置检查 ────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $SourceRoot)) {
    throw "源仓不存在：$SourceRoot"
}
if (-not (Test-Path -LiteralPath $GlobalRoot)) {
    throw "全局安装副本不存在：$GlobalRoot（npm ls -g 确认路径）"
}

Write-Host "=== 同步自检 ===" -ForegroundColor Cyan
Write-Host "源仓（唯一来源）: $SourceRoot"
Write-Host "全局副本        : $GlobalRoot"

# 全局副本是否是指向源仓的链接（npm link / junction）——两种都要正确处理
$globalItem = Get-Item -LiteralPath $GlobalRoot -Force
$isLink = ($globalItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
if ($isLink) {
    Write-Host "全局副本形态    : Junction/链接 -> $($globalItem.Target)" -ForegroundColor Yellow
} else {
    Write-Host "全局副本形态    : 实体目录（逐文件复制）" -ForegroundColor Yellow
}

# ── 复制 + 自检 ─────────────────────────────────────────────────────
$results = @()
$failed = 0
$copied = 0

foreach ($rel in $Files) {
    $src = Join-Path $SourceRoot $rel
    $dst = Join-Path $GlobalRoot $rel

    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "  [跳过] 源仓缺文件: $rel" -ForegroundColor Red
        $results += [pscustomobject]@{ File = $rel; Status = '源仓缺失'; SrcHash = ''; DstHash = '' }
        $failed++
        continue
    }

    $srcHash = Get-Sha256 $src
    $dstHash = Get-Sha256 $dst

    if ($dstHash -eq $srcHash) {
        Write-Host "  [一致] $rel" -ForegroundColor DarkGray
        $results += [pscustomobject]@{ File = $rel; Status = '已一致'; SrcHash = $srcHash; DstHash = $dstHash }
        continue
    }

    if ($CheckOnly) {
        Write-Host "  [不一致] $rel（-CheckOnly，未复制）" -ForegroundColor Yellow
        $results += [pscustomobject]@{ File = $rel; Status = '不一致'; SrcHash = $srcHash; DstHash = $dstHash }
        $failed++
        continue
    }

    # 逐文件复制（不联网、不 npm install）
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $copied++

    # 复制后自检：哈希必须一致，否则**报告**（不静默跳过）
    $afterHash = Get-Sha256 $dst
    if ($afterHash -eq $srcHash) {
        Write-Host "  [已同步] $rel" -ForegroundColor Green
        $results += [pscustomobject]@{ File = $rel; Status = '已同步'; SrcHash = $srcHash; DstHash = $afterHash }
    } else {
        Write-Host "  [失败] $rel 复制后哈希不一致（src=$srcHash dst=$afterHash）" -ForegroundColor Red
        $results += [pscustomobject]@{ File = $rel; Status = '哈希不一致'; SrcHash = $srcHash; DstHash = $afterHash }
        $failed++
    }
}

# ── 汇总 ────────────────────────────────────────────────────────────
Write-Host "=== 汇总 ===" -ForegroundColor Cyan
Write-Host "共 $($Files.Count) 个文件；本次复制 $copied 个；失败/跳过 $failed 个"
foreach ($r in $results) {
    $color = switch ($r.Status) {
        '已同步' { 'Green' }
        '已一致' { 'DarkGray' }
        default { 'Red' }
    }
    Write-Host ("  {0,-28} {1}" -f $r.File, $r.Status) -ForegroundColor $color
}

if ($failed -gt 0) {
    Write-Host ""
    Write-Host '自检未全绿：见上表逐行状态（不一致的项不会被静默跳过）。' -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host '自检通过：全局副本与源仓在本次改动涉及的文件上逐字节一致。' -ForegroundColor Green
exit 0
