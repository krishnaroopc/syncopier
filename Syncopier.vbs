' Syncopier launcher - double-click this file to start.
'
' Runs the local server with no console window and opens the browser once the
' server is actually listening. Robocopy cannot be driven from a web page on its
' own, so a small local server has to be running behind the UI; this hides that
' entirely.

Option Explicit

Dim shell, fso, here, nodeExe, url, i, ready
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:5173/"

' --- locate node ---------------------------------------------------------
nodeExe = ""
Dim candidates, c
candidates = Array( _
  shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
  shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
  shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
  shell.ExpandEnvironmentStrings("%APPDATA%\nvm\node.exe") _
)
For Each c In candidates
  If nodeExe = "" And fso.FileExists(c) Then nodeExe = c
Next

' Fall back to PATH.
If nodeExe = "" Then
  On Error Resume Next
  Dim probe
  probe = shell.Run("cmd /c where node > """ & fso.GetSpecialFolder(2) & "\syncopier-node.txt"" 2>&1", 0, True)
  If probe = 0 Then
    Dim tf, line
    Set tf = fso.OpenTextFile(fso.GetSpecialFolder(2) & "\syncopier-node.txt", 1)
    If Not tf.AtEndOfStream Then
      line = Trim(tf.ReadLine())
      If fso.FileExists(line) Then nodeExe = line
    End If
    tf.Close
    fso.DeleteFile fso.GetSpecialFolder(2) & "\syncopier-node.txt", True
  End If
  On Error Goto 0
End If

If nodeExe = "" Then
  MsgBox "Syncopier needs Node.js, which doesn't appear to be installed." & vbCrLf & vbCrLf & _
         "Install it from https://nodejs.org (the default options are fine), " & _
         "then double-click Syncopier again.", vbExclamation, "Syncopier"
  WScript.Quit 1
End If

' --- dependencies --------------------------------------------------------
If Not fso.FolderExists(fso.BuildPath(here, "node_modules")) Then
  Dim answer
  answer = MsgBox("Syncopier needs to download one small component the first time it runs." & vbCrLf & vbCrLf & _
                  "This takes a few seconds. Continue?", vbOKCancel + vbInformation, "Syncopier - first run")
  If answer <> vbOK Then WScript.Quit 0
  shell.CurrentDirectory = here
  shell.Run "cmd /c npm install --no-audit --no-fund", 0, True
End If

' --- already running? ----------------------------------------------------
If ServerIsUp(url) Then
  shell.Run url, 1, False
  WScript.Quit 0
End If

' --- start the server, hidden -------------------------------------------
shell.CurrentDirectory = here
shell.Run """" & nodeExe & """ """ & fso.BuildPath(here, "server.js") & """", 0, False

' Wait for it to listen rather than guessing with a fixed sleep.
ready = False
For i = 1 To 40
  WScript.Sleep 250
  If ServerIsUp(url) Then
    ready = True
    Exit For
  End If
Next

If ready Then
  shell.Run url, 1, False
Else
  MsgBox "Syncopier couldn't start." & vbCrLf & vbCrLf & _
         "Something may already be using port 5173, or the files may be incomplete. " & _
         "Try restarting, or run 'npm start' in the Syncopier folder to see the error.", _
         vbCritical, "Syncopier"
End If

Function ServerIsUp(target)
  ' VBScript trap: after a failed Send, reading http.Status raises its own
  ' error. Checking "Err.Number = 0 And http.Status = 200" in a single
  ' expression evaluates both sides and yields a FALSE POSITIVE, which made the
  ' launcher believe a dead port was live. Status is only read once Send has
  ' definitely succeeded.
  Dim http, code
  ServerIsUp = False
  On Error Resume Next

  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    On Error Goto 0
    Exit Function
  End If

  http.SetTimeouts 500, 500, 1000, 1000
  http.Open "GET", target, False
  http.Send

  If Err.Number <> 0 Then
    Err.Clear
    On Error Goto 0
    Exit Function
  End If

  code = http.Status
  If Err.Number <> 0 Then
    Err.Clear
    On Error Goto 0
    Exit Function
  End If

  On Error Goto 0
  If code = 200 Then ServerIsUp = True
End Function
