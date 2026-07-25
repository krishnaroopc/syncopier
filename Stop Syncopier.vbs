' Stops the Syncopier server.
'
' Syncopier keeps running in the background after you close the browser tab, so
' that a copy in progress is not killed by closing a window. Double-click this
' when you actually want it to stop.

Option Explicit

Dim shell, wmi, procs, p, cmdLine, killed
Set shell = CreateObject("WScript.Shell")
killed = 0

On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")

For Each p In procs
  cmdLine = "" & p.CommandLine
  ' Only stop OUR server, never someone else's node process.
  If InStr(LCase(cmdLine), "syncopier") > 0 And InStr(LCase(cmdLine), "server.js") > 0 Then
    shell.Run "taskkill /PID " & p.ProcessId & " /T /F", 0, True
    killed = killed + 1
  End If
Next
On Error Goto 0

If killed > 0 Then
  MsgBox "Syncopier has stopped.", vbInformation, "Syncopier"
Else
  MsgBox "Syncopier wasn't running.", vbInformation, "Syncopier"
End If
