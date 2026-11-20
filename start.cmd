@echo off
chcp 65001 >nul 2>nul
rem ↑ 切到 UTF-8：本脚本是 UTF-8 存的，默认 936 代码页会把中文 echo 成乱码；顺带让 node 的日志也正常
rem 让 Windows 自带命令优先（在 Git Bash / MSYS 里跑也不会被同名工具抢走）
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
rem plan: Windows 一键启动 —— 找 node（本机 → 便携 → 下载便携）→ 首次进向导 → 起服务并开浏览器
rem
rem   start.cmd            -> http://127.0.0.1:7789/
rem   start.cmd 8090       -> 换端口
rem
rem 环境变量（可选）：DSH_TAGGER_DATA / DSH_TAGGER_BASE_URL / DSH_TAGGER_API_KEY / DSH_TAGGER_MODEL / DSH_TAGGER_WORKFLOW_DIR
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=%DSH_TAGGER_PORT%"
if "%PORT%"=="" set "PORT=7789"
set "HOST=127.0.0.1"
set "DATADIR=%DSH_TAGGER_DATA%"
if "%DATADIR%"=="" set "DATADIR=%~dp0.data"
set "URL=http://%HOST%:%PORT%/"
rem 便携版 node 的下载地址与落点（下载逻辑只在 :ensureNode 里一份）
set "NODEVER=22.14.0"
set "RTDIR=%~dp0.runtime"
set "NODEEXE=%RTDIR%\node-v%NODEVER%-win-x64\node.exe"
set "RUNNER="

call :ensureNode

if not defined RUNNER (
  where docker >nul 2>nul
  if not errorlevel 1 (
    echo [tagger] 本机没有 node，改用 Docker 起（端口 %PORT%）
    set "DSH_TAGGER_PORT=%PORT%"
    docker compose up --build
    goto :done
  )
  goto :noRuntime
)

rem 首次运行：还没有 settings.json 就先走一遍向导（直接回车 = 默认值）
if not exist "%DATADIR%\settings.json" (
  echo [tagger] 首次运行：先花半分钟配一下模型接口与 ComfyUI（直接回车 = 方括号里的默认值）
  "%RUNNER%" "scripts\setup.mjs" --data-dir "%DATADIR%"
  echo.
)

rem 端口已经在听：不重复起第二个实例，直接开面板
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('%HOST%',%PORT%);exit 0}catch{exit 1}finally{$c.Dispose()}" >nul 2>nul
if not errorlevel 1 (
  echo [tagger] 端口 %PORT% 已经在跑，直接打开面板。
  start "" "%URL%"
  goto :done
)

echo [tagger] 运行时：%RUNNER%
echo [tagger] 数据目录：%DATADIR%
echo [tagger] 面板：%URL%
echo [tagger] 接口：%URL%tagger/api    MCP：%URL%tagger/api/mcp
echo [tagger] 关掉这个窗口 = 停服务。
echo.

"%RUNNER%" "bin\tagger.mjs" --port %PORT% --host %HOST% --data-dir "%DATADIR%" --open
set "CODE=%ERRORLEVEL%"
echo.
echo [tagger] 服务已退出（code=%CODE%）。面板地址：%URL%
goto :done

rem ── 找运行时：本机 node → 前次下载的便携版 → 现在下载 → 都没有就交给调用方 ──
:ensureNode
where node >nul 2>nul
if not errorlevel 1 (
  set "RUNNER=node"
  exit /b 0
)
if exist "%NODEEXE%" (
  set "RUNNER=%NODEEXE%"
  exit /b 0
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "RUNNER=%ProgramFiles%\nodejs\node.exe"
  exit /b 0
)
echo [tagger] 本机没有 node：下载便携版 Node v%NODEVER%（约 30MB，只需要一次）
if not exist "%RTDIR%" mkdir "%RTDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $zip=Join-Path $env:TEMP 'node-portable.zip'; Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v%NODEVER%/node-v%NODEVER%-win-x64.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath '%RTDIR%' -Force; Remove-Item $zip -Force"
if exist "%NODEEXE%" (
  set "RUNNER=%NODEEXE%"
  exit /b 0
)
exit /b 0

:noRuntime
echo.
echo [tagger] 没能准备好运行时。三条路任选：
echo   1. 装 Node：https://nodejs.org/  ^(^>= 18.18^)
echo   2. 装 Docker Desktop：https://docs.docker.com/desktop/
echo   3. 手工把 https://nodejs.org/dist/v%NODEVER%/node-v%NODEVER%-win-x64.zip 解到 %RTDIR%
goto :done

:done
echo.
pause
