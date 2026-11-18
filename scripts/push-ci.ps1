# 用带 workflow scope 的 PAT 把 .github/workflows/ci.yml 推到两个仓库。
# 用法：右键「使用 PowerShell 运行」，或 powershell -ExecutionPolicy Bypass -File scripts\push-ci.ps1
# 令牌只通过隐藏输入读一次，写进 Windows 凭据管理器（wincred），脚本里不落盘。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$lite = Join-Path (Split-Path -Parent $root) "DSh tagger-lite"

Write-Host "粘贴一个带 workflow scope 的 classic PAT（输入时不显示）：" -ForegroundColor Cyan
$sec = Read-Host -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

if ([string]::IsNullOrWhiteSpace($token)) { Write-Host "没有输入令牌，退出。" -ForegroundColor Red; exit 1 }

Write-Host "检查令牌权限……"
$resp = Invoke-WebRequest -Uri "https://api.github.com/user" -Headers @{ Authorization = "token " + $token; "User-Agent" = "dsh-tagger" } -UseBasicParsing
$scopes = $resp.Headers["X-OAuth-Scopes"]
$login = ($resp.Content | ConvertFrom-Json).login
Write-Host ("账号 " + $login + " · scope " + $scopes)
if ($scopes -notmatch "workflow") {
  Write-Host "这个令牌没有 workflow scope，推不了 .github/workflows/ci.yml。" -ForegroundColor Red
  Write-Host "去 https://github.com/settings/tokens 编辑该令牌，勾上 workflow 再生成。" -ForegroundColor Yellow
  exit 1
}

# 写进 wincred，后续 git push 直接复用
$line = "protocol=https`nhost=github.com`nusername=" + $login + "`npassword=" + $token + "`n"
$line | git credential approve

foreach ($repo in @($root, $lite)) {
  if (-not (Test-Path (Join-Path $repo ".git"))) { Write-Host ("跳过（不是仓库）：" + $repo) -ForegroundColor Yellow; continue }
  Write-Host ("推送 " + $repo)
  Push-Location $repo
  try {
    git push origin main
    if ($LASTEXITCODE -ne 0) { Write-Host ("失败：" + $repo) -ForegroundColor Red } else { Write-Host ("完成：" + $repo) -ForegroundColor Green }
  } finally { Pop-Location }
}