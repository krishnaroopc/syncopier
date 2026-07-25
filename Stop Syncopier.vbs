' Stops the Syncopier server.
'
' Syncopier keeps running in the background after you close the browser tab, so
' that a copy in progress is not killed by closing a window. Double-click this
' when you actually want it to stop.

Option Explicit

Dim shell, wmi, procs, p, cmdLine, killed, busyState, answer
Set shell = CreateObject("WScript.Shell")
killed = 0

' Never kill a copy silently: taskkill /T destroys the robocopy child mid-file
' and the deferred-retry queue goes with it. Ask first if a job is running.
busyState = ActiveJobState()
If busyState <> "" Then
  answer = MsgBox("Syncopier is currently " & busyState & "." & vbCrLf & vbCrLf & _
                  "Stopping now will interrupt the copy. Files already copied are kept, " & _
                  "but the rest will not be transferred and the retry queue will be lost." & vbCrLf & vbCrLf & _
                  "Stop anyway?", vbYesNo + vbExclamation + vbDefaultButton2, "Syncopier - copy in progress")
  If answer <> vbYes Then WScript.Quit 0
End If

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

' Returns the job state ("copying", "retrying", ...) or "" when idle or
' unreachable. Same defensive Err handling as the launcher: reading .Status
' after a failed Send raises its own error and would yield a false negative.
Function ActiveJobState()
  Dim http, code, body, s, e
  ActiveJobState = ""
  On Error Resume Next

  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then Err.Clear : On Error Goto 0 : Exit Function

  http.SetTimeouts 500, 500, 1000, 1000
  http.Open "GET", "http://127.0.0.1:5173/api/status", False
  http.Send
  If Err.Number <> 0 Then Err.Clear : On Error Goto 0 : Exit Function

  code = http.Status
  If Err.Number <> 0 Then Err.Clear : On Error Goto 0 : Exit Function
  If code <> 200 Then On Error Goto 0 : Exit Function

  body = http.responseText
  If Err.Number <> 0 Then Err.Clear : On Error Goto 0 : Exit Function
  On Error Goto 0

  ' Minimal parse - avoids pulling in a JSON library for two fields.
  If InStr(body, """busy"":true") > 0 Then
    ActiveJobState = "running a copy"
    s = InStr(body, """state"":""")
    If s > 0 Then
      s = s + Len("""state"":""")
      e = InStr(s, body, """")
      If e > s Then ActiveJobState = Mid(body, s, e - s)
    End If
  End If
End Function
