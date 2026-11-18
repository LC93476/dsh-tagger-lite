@echo off
rem plan: 根目录入口，真正的脚本在 scripts\win\start-tagger.cmd（历史习惯：双击根目录这个就行）
call "%~dp0scripts\win\start-tagger.cmd" %*
