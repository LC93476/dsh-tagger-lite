@echo off
chcp 65001 >nul 2>nul
rem ↑ 切到 UTF-8：本脚本是 UTF-8 存的，默认 936 代码页会把中文 echo 成乱码；顺带让 node 的日志也正常
rem 让 Windows 自带命令优先（在 Git Bash / MSYS 里跑也不会被同名工具抢走）
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
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
"%SystemRoot%\System32\timeout.exe" /t 2 >nul 2>nul
