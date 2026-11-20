rem 历史入口（保留双击习惯）：无窗口启动根目录 start.cmd（日志由服务自己写）。
Option Explicit
Dim sh, here, cmd
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\start.cmd"" " & WScript.Arguments(0)
sh.Run cmd, 0, False
