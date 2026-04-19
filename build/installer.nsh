; Custom NSIS installer script for BNC Browser
; Tự động đóng app trước khi cài đặt (kể cả khi đang chạy ở system tray)

!macro preInit
  ; Kill process nếu đang chạy (bao gồm cả tray mode)
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  ; Đợi 1 giây để process dọn dẹp
  Sleep 1000
!macroend

!macro customUnInit
  ; Kill process trước khi uninstall
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  Sleep 500
!macroend
