@echo off
rem plan: 老入口保留 —— deploy.cmd 只做转发（docker / 便携 node 逻辑都在 start.cmd 里，别再抄一份）
call "%~dp0start.cmd" %*
