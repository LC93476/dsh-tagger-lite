@echo off
rem plan: 双击启动 D:\DSh tagger 的独立服务（不经过 DSH），并自动打开浏览器面板
setlocal EnableExtensions EnableDelayedExpansion
rem 脚本在 scripts\win\ 下，工作目录一律回到仓库根
cd /d "%~dp0..\.."
set "PORT=7789"
set "URL=http://127.0.0.1:%PORT%/"
title DSh Tagger @ %PORT%

rem 可选的本地配置（放同目录 tagger.env.cmd，内容见 tagger.env.cmd.example）
if exist "tagger.env.cmd" call "tagger.env.cmd"

rem ── 1) 端口已经在监听：不重复起，直接开面板 ──
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%PORT%);exit 0}catch{exit 1}finally{$c.Dispose()}" >nul 2>nul
if not errorlevel 1 (
  echo [tagger] 端口 %PORT% 已经在跑，直接打开面板。
  start "" "%URL%"
  exit /b 0
)

rem ── 2) 找运行时：真 node 优先，其次用 DeepSeek Harness 自带的 Electron 当 node ──
set "RUNNER="
set "MODE=node"
where node >nul 2>nul && set "RUNNER=node"
if not defined RUNNER if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" (
  set "RUNNER=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
  set "MODE=electron"
)
if not defined RUNNER if exist "%ProgramFiles%\nodejs\node.exe" set "RUNNER=%ProgramFiles%\nodejs\node.exe"
if not defined RUNNER (
  echo [tagger] 没找到 node，也没找到 DeepSeek Harness。
  echo [tagger] 装个 node ^(https://nodejs.org^)，或把本文件里的 RUNNER 改成你的 node.exe 路径。
  echo.
  pause
  exit /b 1
)

rem ── 3) 后台等服务起来再开浏览器（最多等 30 秒）──
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Dispose();Start-Process '%URL%';break}catch{Start-Sleep -Milliseconds 500}}"

echo [tagger] 运行时：%RUNNER%  [%MODE%]
echo [tagger] 面板：%URL%
echo [tagger] 接口：%URL%tagger/api    MCP：%URL%tagger/api/mcp
echo [tagger] 关掉这个窗口 = 停服务（或双击 stop-tagger.cmd）。
echo.

rem ── 4) 前台跑：日志就在这个窗口里 ──
if /i "%MODE%"=="electron" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RUNNER%" "server\standalone.mjs" --port %PORT% %*
) else (
  "%RUNNER%" "server\standalone.mjs" --port %PORT% %*
)
set "CODE=%ERRORLEVEL%"
echo.
echo [tagger] 服务已退出（code=%CODE%）。
if not "%CODE%"=="0" pause
exit /b %CODE%
