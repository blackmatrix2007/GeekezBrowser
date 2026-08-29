; Custom NSIS installer script for GeekEZ Browser
; Kill tất cả process trước khi cài/gỡ để tránh lỗi "Failed to uninstall: 2"

!macro preInit
  ; Kill app chính
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "geekez-browser.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe" /T'
  Pop $0
  ; Kill proxy engine
  nsExec::Exec 'taskkill /F /IM "xray.exe" /T'
  Pop $0
  ; Kill Chrome instances do app spawn ra
  nsExec::Exec 'taskkill /F /IM "chrome.exe" /T'
  Pop $0
  ; Chờ OS release file lock
  Sleep 3000
  ; Kill lần 2 (GPU/renderer process chưa kịp chết)
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "xray.exe" /T'
  Pop $0
  Sleep 1500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "BNC.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "geekez-browser.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "xray.exe" /T'
  Pop $0
  Sleep 1000
!macroend
