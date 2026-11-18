# 把 D:/DSh tagger-lite 推到你的 GitHub：建仓（可选）→ 加 remote → 推 main。
# 用法：scripts\push-to-github.cmd   或   powershell -ExecutionPolicy Bypass -File scripts\push-to-github.ps1
param(
  [string]$User = '',
  [string]$Repo = 'dsh-tagger',
  [switch]$Private,
  [switch]$UseSsh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $User) { $User = (Read-Host 'GitHub 用户名').Trim() }
if (-not $Repo) { $Repo = 'dsh-tagger' }

if ($UseSsh) {
  git remote remove origin 2>$null
  git remote add origin ("git@github.com:" + $User + "/" + $Repo + ".git")
  git push -u origin main
  if ($LASTEXITCODE -eq 0) { Write-Host ("完成：https://github.com/" + $User + "/" + $Repo) -ForegroundColor Green }
  else { Write-Host '推送失败：先在 https://github.com/settings/keys 添加本机公钥' -ForegroundColor Yellow }
  exit $LASTEXITCODE
}

$secure = Read-Host 'GitHub PAT（只本次使用，不写进任何文件）' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $token) { Write-Host '没输入 PAT，退出。' -ForegroundColor Yellow; exit 1 }

$headers = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json"; "User-Agent" = "dsh-tagger" }
try {
  $body = @{
    name        = $Repo
    private     = [bool]$Private
    description = 'DSh Tagger：白话 → WD + Camie 标签 → ComfyUI（含二次精修、Web 面板、MCP 工具）'
  } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
  Write-Host ("已创建仓库 " + $User + "/" + $Repo) -ForegroundColor Green
} catch {
  Write-Host ("建仓没成功（已存在就无所谓）：" + $_.Exception.Message) -ForegroundColor DarkYellow
}

git remote remove origin 2>$null
git remote add origin ("https://github.com/" + $User + "/" + $Repo + ".git")

$pushUrl = "https://" + $User + ":" + $token + "@github.com/" + $User + "/" + $Repo + ".git"
git push $pushUrl main:main
$code = $LASTEXITCODE
$token = $null

if ($code -eq 0) {
  git branch --set-upstream-to "origin/main" main 2>$null | Out-Null
  Write-Host ""
  Write-Host ("已上传：https://github.com/" + $User + "/" + $Repo) -ForegroundColor Green
} else {
  Write-Host '推送失败：PAT 需要 repo 权限（fine-grained 就是 Contents: Read and write）' -ForegroundColor Yellow
}
exit $code
