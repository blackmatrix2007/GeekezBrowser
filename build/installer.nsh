; Custom NSIS installer script for GeekEZ Browser (maintaince-1-4-1)
; Kill tất cả process có thể đang chạy trước khi cài/gỡ

!macro preInit
  ; Kill bản hiện tại (productName: GeekEZ Browser)
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  ; Kill bản cũ đóng gói dưới tên BNC (trước commit ba18183)
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
