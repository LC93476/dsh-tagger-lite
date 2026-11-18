# 把 D:/DSh tagger-lite 推到 GitHub：建仓（可选）→ 加 remote → 推 main →（可选）验证 CI 权限。
#
# 用法：
#   scripts\push-to-github.cmd                       普通推送（会问 PAT）
#   scripts\push-to-github.cmd -RunCi                推送前先验 workflow scope，并打印 Actions 链接
#   scripts\push-to-github.cmd -RunCi -Both          连公开版 ../DSh tagger-lite 一起推
#   scripts\push-to-github.cmd -UseSsh               改走 SSH（不读 PAT）
#
# 合并自原来的 push-ci.ps1：以前要两个脚本，因为「带 .github/workflows 的提交」
# 需要 PAT 有 workflow scope。现在用 -RunCi 一个开关表达同一件事。
param(
  [string]$User = '',
  [string]$Repo = 'dsh-tagger',
  [switch]$Private,
  [switch]$UseSsh,
  [switch]$RunCi,
  [switch]$Both,
  [string]$LiteDir = 'DSh tagger-lite'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $User) { $User = (Read-Host "GitHub 用户名").Trim() }
if (-not $Repo) { $Repo = "dsh-tagger" }

if ($UseSsh) {
  git remote remove origin 2>$null
  git remote add origin ("git@github.com:" + $User + "/" + $Repo + ".git")
  git push -u origin main
  if ($LASTEXITCODE -eq 0) { Write-Host ("完成：https://github.com/" + $User + "/" + $Repo) -ForegroundColor Green }
  else { Write-Host "推送失败：先在 https://github.com/settings/keys 添加本机公钥" -ForegroundColor Yellow }
  exit $LASTEXITCODE
}

$secure = Read-Host 'GitHub PAT（只本次使用，不写进任何文件）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if (-not $token) { Write-Host "没输入 PAT，退出。" -ForegroundColor Yellow; exit 1 }

$headers = @{ Authorization = "token " + $token; Accept = "application/vnd.github+json"; "User-Agent" = "dsh-tagger" }

# 1) 令牌能干什么：先问清楚，别等 git 报一半
$scopes = ""
try {
  $me = Invoke-WebRequest -Uri "https://api.github.com/user" -Headers $headers -UseBasicParsing
  $scopes = [string]$me.Headers["X-OAuth-Scopes"]
  $login = ($me.Content | ConvertFrom-Json).login
  Write-Host ("令牌账号 " + $login + " · scope " + $scopes)
} catch {
  Write-Host ("PAT 用不了： " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

if ($RunCi -and ($scopes -notmatch "workflow")) {
  Write-Host "这个 PAT 没有 workflow scope，推不了 .github/workflows/ci.yml。" -ForegroundColor Red
  Write-Host "去 https://github.com/settings/tokens 编辑该令牌，勾上 workflow 再来（令牌值不变）。" -ForegroundColor Yellow
  exit 1
}
if (-not $RunCi -and ($scopes -notmatch "workflow")) {
  Write-Host "提醒：PAT 没有 workflow scope，本次若含 .github/workflows 的提交会被 GitHub 拒。" -ForegroundColor DarkYellow
}

# 2) 建仓（已存在就跳过）
try {
  $body = @{
    name        = $Repo
    private     = [bool]$Private
    description = "DSh Tagger：白话 → WD + Camie 标签 → ComfyUI（含二次精修、Web 面板、MCP 工具）"
  } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "https://api.github.com/user/repos" -Headers $headers -Body $body -ContentType "application/json" | Out-Null
  Write-Host ("已创建仓库 " + $User + "/" + $Repo) -ForegroundColor Green
} catch {
  Write-Host ("建仓没成功（已存在就无所谓）：" + $_.Exception.Message) -ForegroundColor DarkYellow
}

# 3) 推送（一次性 URL，令牌不落盘）
git remote remove origin 2>$null
git remote add origin ("https://github.com/" + $User + "/" + $Repo + ".git")

$targets = @($root)
if ($Both) {
  $lite = Join-Path (Split-Path -Parent $root) $LiteDir
  if (Test-Path (Join-Path $lite ".git")) { $targets += $lite }
  else { Write-Host ("跳过（不是仓库）：" + $lite) -ForegroundColor DarkYellow }
}

$failed = 0
foreach ($dir in $targets) {
  Push-Location $dir
  try {
    $remote = (git remote get-url origin 2>$null)
    if (-not $remote) { Write-Host ("没有 origin：" + $dir) -ForegroundColor DarkYellow; $failed++; continue }
    $slug = $remote -replace "^https://github.com/", "" -replace "\.git$", ""
    $url = "https://" + $User + ":" + $token + "@github.com/" + $slug + ".git"
    Write-Host ("推送 " + $slug)
    git push $url "main:main"
    if ($LASTEXITCODE -ne 0) { $failed++; Write-Host ("失败：" + $slug) -ForegroundColor Red }
    else {
      git branch --set-upstream-to "origin/main" main 2>$null | Out-Null
      Write-Host ("完成：https://github.com/" + $slug) -ForegroundColor Green
      if ($RunCi) { Write-Host ("  CI：https://github.com/" + $slug + "/actions") }
    }
  } finally { Pop-Location }
}

$token = $null
if ($failed -gt 0) { Write-Host ("有 " + $failed + " 个仓库没推上去") -ForegroundColor Red; exit 1 }
Write-Host "全部完成。" -ForegroundColor Green