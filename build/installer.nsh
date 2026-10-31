; 卸载时询问是否删除个人设置（C 方案）
; 交互模式弹窗；静默卸载 (/S) 时按 /SD 的默认值 = 删除
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除个人设置？$\r$\n$\r$\n包括：窗口位置、大小、透明度、引导记录、节能设置、日志与缓存。$\r$\n选择「否」会保留这些设置（重装后沿用）。" /SD IDYES IDNO unKeepPersonalData

  RMDir /r "$APPDATA\mori-pet"
  RMDir /r "$LOCALAPPDATA\mori-pet"
  RMDir /r "$TEMP\mori-pet"
  RMDir /r "$INSTDIR\.userdata"
  Goto unPersonalDataDone

  unKeepPersonalData:
  ; 什么都不删

  unPersonalDataDone:
!macroend

; 安装完成后把「使用提示.txt」从 resources 复制到安装目录根，让用户一眼能看到
!macro customInstall
  CopyFiles /SILENT "$INSTDIR\resources\使用提示.txt" "$INSTDIR\使用提示.txt"
!macroend
