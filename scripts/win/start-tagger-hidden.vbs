rem plan: 无控制台窗口地启动 start-tagger.cmd（日志写 logs/server.log）
Option Explicit
Dim sh, fso, here, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
cmd = "cmd /c """"" & here & "\start-tagger.cmd" & """""
sh.Run cmd, 0, False
