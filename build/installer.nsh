; Custom NSIS installer script for GeekEZ Browser (maintaince-1-4-1)
; Kill tất cả process có thể đang chạy trước khi cài/gỡ

!macro preInit
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  Sleep 2500
  ; Kill lần 2 cho các child process (GPU/renderer) chưa kịp chết
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  Sleep 1000
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  Sleep 500
!macroend
