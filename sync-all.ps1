# ============================================================
#  sync-all.ps1 — 批量同步推送 D:\工作流 下所有 Git 项目
#  ----------------------------------------------------------
#  用法 (双击桌面快捷方式即可, 或在命令行):
#     .\sync-all.ps1                       # 扫描 D:\工作流, 提交并推送所有有变更的项目
#     .\sync-all.ps1 -Message "统一更新"    # 自定义提交信息(所有项目共用)
#     .\sync-all.ps1 -DryRun               # 只扫描报告, 不实际提交推送
#     .\sync-all.ps1 -NoProxy              # 不走 Clash 代理 (直连)
#     .\sync-all.ps1 -ScanRoot "D:\其他"   # 指定其他扫描根目录
#  ----------------------------------------------------------
#  默认扫描根: D:\工作流 (一级子目录含 .git 即视为项目)
#  默认代理  : http://127.0.0.1:7890 (Clash; -NoProxy 关闭)
#  凭据     : 复用全局 git credential (已注入 GitHub PAT)
# ============================================================

param(
    [string]$ScanRoot = "D:\工作流",
    [string]$Message  = "",
    [string]$Proxy    = "http://127.0.0.1:7890",
    [switch]$NoProxy,
    [switch]$DryRun
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
# 用 Continue: PS5.1 在 Stop 模式下会把原生 git 的 stderr warning (如 LF/CRLF) 当致命错误抛出, 中断脚本
# git 命令仍通过 $LASTEXITCODE 检查退出码; 关键终止点用 if/exit 显式处理
$ErrorActionPreference = "Continue"

function W-Info($t){ Write-Host $t -ForegroundColor Cyan }
function W-Ok($t){  Write-Host $t -ForegroundColor Green }
function W-Warn($t){Write-Host $t -ForegroundColor Yellow }
function W-Err($t){ Write-Host $t -ForegroundColor Red }

# ---------- 定位 git ----------
$git = $null
foreach ($cand in @("git","D:\Git\bin\git.exe","D:\Git\cmd\git.exe","C:\Program Files\Git\bin\git.exe")) {
    try { $null = & $cand --version 2>$null; if ($LASTEXITCODE -eq 0) { $git = $cand; break } } catch {}
}
if (-not $git) { W-Err "未找到 git, 请先安装 Git。"; exit 1 }

W-Info "================================================"
W-Info " 批量同步推送  sync-all"
W-Info "================================================"
Write-Host " 扫描根目录 : $ScanRoot"
Write-Host " 代理       : $(if($NoProxy){'关闭 (直连)'}else{$Proxy})"
Write-Host " 模式       : $(if($DryRun){'dry-run (仅报告)'}else{'实际提交 + 推送'})"
if ($Message) { Write-Host " 提交信息   : $Message (所有项目共用)" }
Write-Host ""

if (-not (Test-Path $ScanRoot)) { W-Err "扫描根目录不存在: $ScanRoot"; exit 1 }

# ---------- 扫描 git 项目 (一级子目录含 .git) ----------
$projects = @()
Get-ChildItem -Path $ScanRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-Path (Join-Path $_.FullName ".git")) { $projects += $_.FullName }
}

if ($projects.Count -eq 0) {
    W-Warn "在 $ScanRoot 下未找到任何 Git 项目。"
    exit 0
}

W-Ok "发现 $($projects.Count) 个 Git 项目:"
$projects | ForEach-Object { Write-Host "   - $_" }
Write-Host ""

# ---------- 逐个处理 ----------
$results = @()
$idx = 0
foreach ($proj in $projects) {
    $idx++
    $name = Split-Path $proj -Leaf
    W-Info "[$idx/$($projects.Count)] $name"

    Push-Location $proj
    try {
        # 本仓库基础配置
        & $git config core.quotepath false 2>$null
        & $git config i18n.commitEncoding utf-8 2>$null
        & $git config log.outputEncoding utf-8 2>$null
        if (-not (& $git config user.name))  { & $git config user.name  "Krogin0121" 2>$null }
        if (-not (& $git config user.email)) { & $git config user.email "Krogin0121@users.noreply.github.com" 2>$null }

        # 代理
        if ($NoProxy) {
            & $git config --local --unset http.proxy  2>$null
            & $git config --local --unset https.proxy 2>$null
        } elseif ($Proxy) {
            & $git config --local http.proxy  $Proxy 2>$null
            & $git config --local https.proxy $Proxy 2>$null
        }

        # 检查 origin
        $origin = $null
        try { $origin = & $git remote get-url origin 2>$null } catch {}
        if (-not $origin) {
            W-Warn "  无 origin 远程, 跳过"
            $results += [PSCustomObject]@{ Project=$name; Action="跳过"; Detail="无 origin" }
            continue
        }

        # 当前分支
        $branch = & $git rev-parse --abbrev-ref HEAD 2>$null
        if (-not $branch -or $branch -eq "HEAD") {
            W-Warn "  处于 detached HEAD, 跳过"
            $results += [PSCustomObject]@{ Project=$name; Action="跳过"; Detail="detached HEAD" }
            continue
        }

        # 检测变更 (dry-run 只读, 不修改暂存区)
        $hasStaged = $false
        if ($DryRun) {
            $porc = & $git status --porcelain 2>$null
            $hasStaged = ($porc | Where-Object { $_ -match '^[MADRC!?]' }).Count -gt 0
        } else {
            # cmd /c 包裹 add, 彻底隔离 git stderr warning (如 LF/CRLF) 进 PS 错误流
            $null = cmd /c "`"$git`" add -A 2>&1"
            & $git diff --cached --quiet --exit-code 2>$null
            $hasStaged = ($LASTEXITCODE -ne 0)
        }

        $committed = $false
        if ($hasStaged) {
            $msg = if ($Message) { $Message } else { ("更新于 " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) }
            if ($DryRun) {
                W-Warn "  [dry-run] 将提交: $msg"
            } else {
                # 用 cmd /c 包裹 commit, 规避 PS5.1 把 git stderr 包成 RemoteException
                $commitCmd = "`"$git`" commit -m `"$msg`" 2>&1"
                $null = cmd /c $commitCmd
                $committed = $true
                Write-Host "  已提交: $msg" -ForegroundColor DarkGray
            }
        }

        # 检查 upstream 与未推送 commit 数
        $hasUpstream = $true
        try { $null = & $git rev-parse --abbrev-ref '@{u}' 2>$null; if ($LASTEXITCODE -ne 0) { $hasUpstream = $false } } catch { $hasUpstream = $false }

        $ahead = 0
        if ($hasUpstream) {
            try {
                $aheadOut = & $git rev-list --count '@{u}..HEAD' 2>$null
                if ($LASTEXITCODE -eq 0) { $ahead = [int]$aheadOut }
            } catch { $ahead = 0 }
        } else {
            # 无 upstream: 看本地有没有 commit
            try { $ahead = [int](& $git rev-list --count HEAD 2>$null) } catch { $ahead = 0 }
        }

        # 决定是否需要推送: 有未推送 commit, 或本次刚提交, 或 dry-run 发现待提交变更
        $needPush = ($ahead -gt 0) -or $committed -or ($DryRun -and $hasStaged)
        if (-not $needPush) {
            Write-Host "  无变更, 无未推送 commit" -ForegroundColor DarkGray
            $results += [PSCustomObject]@{ Project=$name; Action="无操作"; Detail="已是最新" }
            continue
        }

        if ($DryRun) {
            $desc = if ($ahead -gt 0) { "$ahead 个 commit" } else { "含未提交变更" }
            W-Warn "  [dry-run] 将推送 ($desc) -> $origin ($branch)"
            $results += [PSCustomObject]@{ Project=$name; Action="dry-run"; Detail="待推送 ($desc)" }
            continue
        }

        # 推送 (cmd /c 包裹, 规避 PS5.1 stderr 假错误)
        $pushCmd = if ($hasUpstream) {
            "`"$git`" push origin $branch 2>&1"
        } else {
            "`"$git`" push -u origin $branch 2>&1"
        }
        $pushOut = cmd /c $pushCmd
        $pushExit = $LASTEXITCODE
        if ($pushExit -eq 0) {
            W-Ok "  推送成功 ($ahead commit -> $branch)"
            $results += [PSCustomObject]@{ Project=$name; Action="已推送"; Detail="$ahead commit -> $branch" }
        } else {
            W-Err "  推送失败 (exit=$pushExit)"
            Write-Host ($pushOut | Out-String) -ForegroundColor DarkRed
            $errLine = (($pushOut | Out-String).Trim() -split "`n")[0]
            $results += [PSCustomObject]@{ Project=$name; Action="失败"; Detail="push: $errLine" }
        }
    }
    catch {
        W-Err "  异常: $($_.Exception.Message)"
        $results += [PSCustomObject]@{ Project=$name; Action="异常"; Detail=$($_.Exception.Message) }
    }
    finally {
        Pop-Location
    }
    Write-Host ""
}

# ---------- 汇总报告 ----------
W-Info "================================================"
W-Info " 汇总报告"
W-Info "================================================"
$results | Format-Table -AutoSize -Wrap
$ok   = ($results | Where-Object { $_.Action -in @("已推送","已提交","dry-run") }).Count
$skip = ($results | Where-Object { $_.Action -in @("无操作","跳过") }).Count
$fail = ($results | Where-Object { $_.Action -in @("失败","异常") }).Count
Write-Host ""
if ($fail -gt 0) {
    W-Warn "完成: 成功 $ok / 无变更或跳过 $skip / 失败 $fail / 共 $($results.Count)"
} else {
    W-Ok "完成: 成功 $ok / 无变更或跳过 $skip / 失败 $fail / 共 $($results.Count)"
}
