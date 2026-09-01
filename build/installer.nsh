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
; xray.exe is a separate executable the app spawns as ITS OWN child (not an
; ancestor of the installer), so "/T" there is harmless and still useful for
; cleaning up its own descendants.
;
; chrome.exe is deliberately NOT killed here anymore: "/IM chrome.exe" matches by
; image name only, with no way to tell BNC's own profile-spawned Chrome apart from
; the user's completely unrelated, already-open personal Chrome windows — it kills
; every chrome.exe process on the whole machine. Confirmed via a real customer
; report: they had 2 unrelated Chrome windows open, clicked "install update" in
; BNC, and both their Chrome windows died along with BNC at the same moment.
; BNC's own profile Chrome processes are already killed by PID (not by name) in
; main.js's update-downloaded handler, via forceKill(chromeProcess.pid), before
; app.quit() is even called — so this blanket kill was redundant for BNC's own
; processes and only served to destroy the user's unrelated browser sessions.
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
