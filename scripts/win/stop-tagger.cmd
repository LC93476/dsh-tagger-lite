@echo off
rem plan: 按端口停掉 DSh Tagger 独立服务
setlocal EnableExtensions
set "PORT=7789"
if not "%~1"=="" set "PORT=%~1"

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo [tagger] 结束进程 PID %%p（端口 %PORT%）
  powershell -NoProfile -Command "Stop-Process -Id %%p -Force -ErrorAction SilentlyContinue"
)
if not defined FOUND echo [tagger] 端口 %PORT% 上没有服务在跑。

echo [tagger] 完成。
timeout /t 2 >nul
