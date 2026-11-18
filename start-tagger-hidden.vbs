rem plan: 根目录入口 → scripts\win\start-tagger-hidden.vbs（静默启动，不弹黑框）
Option Explicit
Dim sh, here, cmd
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "wscript.exe """ & here & "\scripts\win\start-tagger-hidden.vbs"""
sh.Run cmd, 0, False
