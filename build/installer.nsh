; Custom NSIS installer script for GeekEZ Browser
; Kill tất cả process trước khi cài/gỡ để tránh lỗi "Failed to uninstall: 2"
;
; IMPORTANT: no "/T" on the BNC.exe/geekez-browser.exe/GeekEZ Browser.exe kills below.
; When the app auto-updates, it spawns the installer/uninstaller itself as ITS OWN
; CHILD PROCESS (electron-updater's autoInstallOnAppQuit spawns the installer from
; inside the running app) — confirmed via Task Manager showing "BNC Setup" nested
; under the running app's process tree. "/T" kills the matched process AND its
; whole child tree, so "taskkill /F /IM BNC.exe /T" run FROM WITHIN that installer
; kills its own parent (correct) but ALSO cascades down and kills the installer
; itself (its own child) — the installer commits suicide mid-run, which is exactly
; why "cannot be closed" / Retry never succeeds no matter what's manually killed:
; the installer instance handling the dialog is gone before it can re-check.
; xray.exe/chrome.exe are separate executables the app spawns as ITS OWN children
; (not ancestors of the installer), so "/T" there is harmless and still useful for
; cleaning up their own descendants.
!macro preInit
  ; Kill app chính
  nsExec::Exec 'taskkill /F /IM "BNC.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "geekez-browser.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "GeekEZ Browser.exe"'
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
  nsExec::Exec 'taskkill /F /IM "BNC.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "xray.exe" /T'
  Pop $0
  Sleep 1500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "BNC.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "geekez-browser.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "xray.exe" /T'
  Pop $0
  Sleep 1000
!macroend

; electron-builder's default flow (installUtil.nsh: handleUninstallResult) runs the
; OLD version's bundled "Uninstall BNC.exe" in-place before copying new files, and
; hard-aborts the ENTIRE update (SetErrorLevel 2; Quit) if that old uninstaller
; returns a non-zero exit code — e.g. "Failed to uninstall old application files: 2".
;
; That old uninstaller is already frozen on every machine that installed a version
; before this fix (its own process-kill logic can't be patched retroactively), so
; it can keep failing forever for anyone updating from an old install — even though
; the app's own processes are already dead by the time preInit above runs. Aborting
; the whole update over a stale uninstaller's exit code is worse than just
; continuing: the main Section's file copy (SetOutPath + File) that runs right after
; this check overwrites whatever the old uninstaller left behind anyway.
;
; Defining these hooks makes electron-builder skip its own abort-on-failure check
; (see the `!ifmacrodef customUnInstallCheck[CurrentUser]` branch in
; installUtil.nsh's handleUninstallResult) and just proceed to install the new
; version regardless of the old uninstaller's result.
!macro customUnInstallCheck
  DetailPrint "Old version uninstall check skipped — proceeding with install regardless of old uninstaller result."
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "Old version uninstall check skipped — proceeding with install regardless of old uninstaller result."
!macroend
