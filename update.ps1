# ============================================================
#  update.ps1  —  一键更新并推送「全球实时热点事件」项目到 GitHub
#  ----------------------------------------------------------
#  用法 (在项目根目录右键 "使用 PowerShell 运行" 即可):
#     .\update.ps1                 # 自动提交并推送 (提交信息=时间戳)
#     .\update.ps1 -Message "新增XXX"   # 自定义提交信息
#     .\update.ps1 -Init           # 首次初始化 (git init + 关联远程 + 首次推送)
#     .\update.ps1 -NoProxy        # 本次不走 Clash 代理 (直连)
#     .\update.ps1 -Pull           # 推送前先 rebase 拉取远程
#  ----------------------------------------------------------
#  默认远程: https://github.com/Krogin0121/全球实时热点事件.git
#  默认代理: http://127.0.0.1:7890  (Clash; 用 -NoProxy 关闭)
# ============================================================

param(
    [string]$Message = "",
    [string]$Branch  = "main",
    [string]$Proxy   = "http://127.0.0.1:7890",
    [switch]$Init,
    [switch]$NoProxy,
    [switch]$Pull
)

# ---------- 仓库名 (ASCII, 避免 PowerShell5.1 + GitHub API 中文编码 bug) ----------
$repoName  = "global-hotspots"
$DefaultRemote = "https://github.com/Krogin0121/$repoName.git"

# ---------- 控制台 UTF-8, 让中文输出/提交信息正常 ----------
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

function W-Info($t){ Write-Host $t -ForegroundColor Cyan }
function W-Ok($t){  Write-Host $t -ForegroundColor Green }
function W-Warn($t){Write-Host $t -ForegroundColor Yellow }
function W-Err($t){ Write-Host $t -ForegroundColor Red }

W-Info "=============================================="
W-Info " 全球实时热点事件 · 更新推送脚本"
W-Info "=============================================="
Write-Host " 项目目录 : $root"
Write-Host " 目标分支 : $Branch"

# ---------- 1. 定位 git ----------
$git = $null
foreach ($cand in @("git", "D:\Git\bin\git.exe", "D:\Git\cmd\git.exe", "C:\Program Files\Git\bin\git.exe")) {
    try {
        $null = & $cand --version 2>$null
        if ($LASTEXITCODE -eq 0) { $git = $cand; break }
    } catch {}
}
if (-not $git) { W-Err "未找到 git, 请先安装 Git。"; exit 1 }
W-Ok "Git: $((& $git --version) -replace 'git version ','v')"

Push-Location $root
try {
    # ---------- 2. 初始化 (首次) ----------
    $isRepo = Test-Path (Join-Path $root ".git")
    if (-not $isRepo) {
        W-Info "[初始化] 尚非 Git 仓库, 执行 git init..."
        & $git init -b $Branch 2>$null
        if ($LASTEXITCODE -ne 0) { & $git init; & $git checkout -b $Branch 2>$null }
    }

    # 本仓库级配置
    & $git config core.quotepath false
    & $git config i18n.commitEncoding utf-8
    & $git config log.outputEncoding utf-8
    # 用户身份: 没有就给默认, 不动全局
    if (-not (& $git config user.name))  { & $git config user.name  "Krogin0121" }
    if (-not (& $git config user.email)) { & $git config user.email "Krogin0121@users.noreply.github.com" }

    # ---------- 3. 代理 (Clash 7890) ----------
    if ($NoProxy) {
        & $git config --local --unset http.proxy  2>$null
        & $git config --local --unset https.proxy 2>$null
        W-Warn "已关闭 Git 代理 (直连模式)。"
    } elseif ($Proxy) {
        & $git config --local http.proxy  $Proxy
        & $git config --local https.proxy $Proxy
        Write-Host " Git 代理 : $Proxy"
    }

    # ---------- 4. 关联远程 ----------
    $hasRemote = $false
    try { $null = & $git remote get-url origin 2>$null; $hasRemote = ($LASTEXITCODE -eq 0) } catch {}
    if (-not $hasRemote) {
        W-Info "[远程] 添加 origin -> $DefaultRemote"
        & $git remote add origin $DefaultRemote
    } else {
        $cur = & $git remote get-url origin
        Write-Host " 远程地址 : $cur"
    }

    # ---------- 5. 暂存变更 ----------
    & $git add -A
    $hasChanges = $true
    try { & $git diff --cached --quiet --exit-code; $hasChanges = ($LASTEXITCODE -ne 0) } catch {}

    if (-not $hasChanges -and -not $Init) {
        W-Warn "没有需要提交的变更。仍可选择推送已有提交..."
    } else {
        $msg = if ($Message) { $Message } else { ("更新于 " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) }
        W-Info "[提交] $msg"
        & $git commit -m $msg
    }

    # ---------- 6. 推送前 (可选) rebase 拉取 ----------
    if ($Pull) {
        W-Info "拉取远程并 rebase..."
        & $git pull --rebase origin $Branch 2>&1 | Out-Host
    }

    # ---------- 7. 推送 ----------
    W-Info "[推送] origin $Branch ..."
    & $git push -u origin $Branch 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) {
        W-Ok ""
        W-Ok "推送成功!"
        Write-Host ""
        Write-Host " 仓库主页 : https://github.com/Krogin0121/$repoName"
        Write-Host " 启用 Pages: 仓库 Settings -> Pages -> Branch: $Branch / root -> Save"
        Write-Host "            之后访问: https://krogin0121.github.io/$repoName/"
    } else {
        W-Err ""
        W-Err "推送失败。常见原因与处理:"
        W-Warn " * 认证失败 (403/401): 浏览器登录 GitHub -> Settings -> Developer settings"
        W-Warn "   -> Personal access tokens -> 生成带 'repo' 权限的 token, 推送时用户名填"
        W-Warn "   Krogin0121, 密码处粘贴 token (Git Credential Manager 会自动记住)。"
        W-Warn " * 连接超时: 确认 Clash 已运行且端口为 7890; 或用 .\update.ps1 -NoProxy 直连。"
        W-Warn " * 远程已有历史冲突: 用 .\update.ps1 -Pull 先 rebase 再推送。"
        exit 1
    }
}
finally {
    Pop-Location
}
