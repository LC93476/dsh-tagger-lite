@echo off
rem 历史入口（保留双击习惯）：真正的实现只有一份，在根目录 start.cmd。
rem 想在这个窗口里看服务日志就用 start.cmd；要静默后台跑就用 start-tagger-hidden.vbs。
call "%~dp0start.cmd" %*
