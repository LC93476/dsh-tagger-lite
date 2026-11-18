@echo off
rem plan: 根目录入口，真正的脚本在 scripts\win\stop-tagger.cmd
call "%~dp0scripts\win\stop-tagger.cmd" %*
