@echo off
rem plan: Windows 一键部署——有 node 用 node，有 docker 用 docker，都没有就临时下一份便携 node
rem
rem   deploy.cmd            -> http://127.0.0.1:7789/
rem   deploy.cmd 8090       -> 换端口
rem
rem 环境变量（可选）：DSH_TAGGER_DATA / DSH_TAGGER_BASE_URL / DSH_TAGGER_API_KEY / DSH_TAGGER_MODEL / DSH_TAGGER_WORKFLOW_DIR
setlocal
cd /d "%~dp0"

set "PORT=7789"
if not "%~1"=="" set "PORT=%~1"
set "HOST=127.0.0.1"
set "DATADIR=%~dp0.data"
set "URL=http://%HOST%:%PORT%/"
set "ENTRY=%~dp0server\standalone.mjs"
set "NODEVER=22.14.0"
set "RTDIR=%~dp0.runtime"
set "NODEEXE=%RTDIR%\node-v%NODEVER%-win-x64\node.exe"

where node >nul 2>nul
if not errorlevel 1 goto :useNode
where docker >nul 2>nul
if not errorlevel 1 goto :useDocker
goto :usePortable

:useNode
echo 用本机 node 启动 DSh Tagger：%URL%
call :openLater
node "%ENTRY%" --host %HOST% --port %PORT% --data-dir "%DATADIR%"
goto :done

:useDocker
echo 本机没有 node，改用 Docker 起（端口 %PORT%）
set "DSH_TAGGER_PORT=%PORT%"
docker compose up --build
goto :done

:usePortable
if exist "%NODEEXE%" goto :runPortable
echo 本机没有 node 也没有 docker：下载便携版 Node v%NODEVER%（约 30MB，只需要一次）
if not exist "%RTDIR%" mkdir "%RTDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $zip=Join-Path $env:TEMP 'node-portable.zip'; Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v%NODEVER%/node-v%NODEVER%-win-x64.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath '%RTDIR%' -Force; Remove-Item $zip -Force"
if not exist "%NODEEXE%" goto :noRuntime

:runPortable
echo 用便携版 node 启动 DSh Tagger：%URL%
call :openLater
"%NODEEXE%" "%ENTRY%" --host %HOST% --port %PORT% --data-dir "%DATADIR%"
goto :done

:openLater
rem 后台等几秒再开浏览器，别抢在服务就绪之前
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"
exit /b 0

:noRuntime
echo.
echo 便携版 Node 没下载成功（多半是没网或被代理拦了）。三条路任选：
echo   1. 装 Node：https://nodejs.org/  （^>= 18.18）
echo   2. 装 Docker Desktop：https://docs.docker.com/desktop/
echo   3. 手工把 https://nodejs.org/dist/v%NODEVER%/node-v%NODEVER%-win-x64.zip 解到 %RTDIR%
goto :done

:done
echo.
echo 服务已退出。面板地址：%URL%
pause
