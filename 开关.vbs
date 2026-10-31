Option Explicit
' morichan 开关：未运行则启动；已在运行则显示/隐藏
Dim sh, fso, root, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = "D:\dsh\mori-pet"
exe = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "找不到 Electron：" & exe, 16, "morichan"
  WScript.Quit 1
End If

sh.CurrentDirectory = root
' 0 = 隐藏窗口启动；第二个实例会自动切换显示状态后退出
sh.Run """" & exe & """ . --no-sandbox --disable-gpu", 0, False
