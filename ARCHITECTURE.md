╔══════════════════════════════════════════════════════════════════════╗
║                   GEEKEZBROSER — LUỒNG HIỆN TẠI                     ║
║                   Updated: 2026-04-27                                ║
╚══════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────┐
│                        ELECTRON MAIN PROCESS                         │
│                                                                      │
│  ┌──────────────────┐     ┌──────────────────┐                      │
│  │  License Check   │     │  Profile Manager │                      │
│  │ tool.erp-x.com   │     │  profiles.json   │                      │
│  │ 5min heartbeat   │     │  groups.json     │                      │
│  └──────────────────┘     └──────────────────┘                      │
│                                                                      │
│                    ipcMain.handle('launch-profile')                  │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   LAUNCH FLOW     │
                    │                   │
                    │  effectiveProxy = │
                    │  profile.proxyStr │
                    │  || settings.     │
                    │  defaultProxy     │
                    │  || ''            │
                    └─────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
  ┌───────────────┐  ┌────────────────┐  ┌───────────────┐
  │  GEO DETECT   │  │ EXT GENERATE   │  │  PROXY SETUP  │
  │               │  │                │  │               │
  │ http://ip-api │  │ generateExten- │  │ if isDirect:  │
  │ .com/json/IP  │  │ sion()         │  │  --no-proxy-  │
  │               │  │                │  │  server       │
  │ → timezone    │  │ GeekEZ Guard   │  │               │
  │ → language    │  │ manifest.json  │  │ else:         │
  │ → lat/lon     │  │ content.js     │  │  Xray spawn   │
  │ → countryCode │  │ content_pw.js  │  │  SOCKS5→proxy │
  │               │  │ background.js  │  │               │
  │ ⚠ HTTP clear  │  │                │  │ Google bypass │
  │ ⚠ only if     │  │ content.js:    │  │ --proxy-      │
  │   Auto tz     │  │  MAIN world    │  │ bypass-list=  │
  │               │  │  all_frames    │  │ *.google.com  │
  │               │  │  exclude:      │  │ *.googleapis  │
  │               │  │  -accounts.g  │  │ *.gstatic.com │
  │               │  │  -mail.google │  │ accounts.yt   │
  │               │  │  -myaccount   │  │ *.youtube.com │
  │               │  │  -recaptcha   │  │               │
  │               │  │  -gstatic     │  │               │
  │               │  │  -doubleclick │  │               │
  │               │  │               │  │               │
  │               │  │ content_pw.js:│  │               │
  │               │  │  ISOLATED     │  │               │
  │               │  │  no all_frames│  │               │
  │               │  │  exclude:     │  │               │
  │               │  │  -accounts.g  │  │               │
  │               │  │  -accounts.yt │  │               │
  │               │  │  -mail.google │  │               │
  │               │  │  -myaccount   │  │               │
  └───────────────┘  └────────────────┘  └───────────────┘
          │                   │                   │
          └───────────────────▼───────────────────┘
                              │
                    ┌─────────▼─────────────────────────┐
                    │        CHROME LAUNCH ARGS          │
                    │                                    │
                    │  [direct mode]                     │
                    │  --no-proxy-server                 │
                    │                                    │
                    │  [proxy mode]                      │
                    │  --proxy-server=socks5://          │
                    │    127.0.0.1:localPort             │
                    │  --proxy-bypass-list=              │
                    │    accounts.google.com,            │
                    │    *.google.com,*.googleapis.com,  │
                    │    *.gstatic.com,*.youtube.com     │
                    │                                    │
                    │  [all modes]                       │
                    │  --user-data-dir=<profile-dir>     │
                    │  --user-agent=<UA string>          │
                    │  --timezone=<tz>  ← Chrome 92+,   │
                    │    works Windows/Mac/Linux         │
                    │  --lang=<language>                 │
                    │  --accept-lang=<language>          │
                    │  --load-extension=<ext-path>       │
                    │  --no-sandbox                      │
                    │  --disable-blink-features=         │
                    │    AutomationControlled            │
                    │  --disable-features=               │
                    │    IsolateOrigins,...              │
                    │  --restore-last-session            │
                    │  --force-webrtc-ip-handling-policy │
                    │    =disable_non_proxied_udp        │
                    │                                    │
                    │  [FP-Chromium only]                │
                    │  --fingerprint-platform=windows    │
                    │  --fingerprint-brand=Chrome        │
                    │  --fingerprint-hardware-           │
                    │    concurrency=N                   │
                    │  --canvas-noise-seed=<seed>        │
                    │  --audio-noise-seed=<seed>         │
                    │  --perf-noise-seed=<seed>          │
                    │  --webgl-vendor=<vendor>           │
                    │  --webgl-renderer=<renderer>       │
                    └─────────┬──────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  spawn(chromePath,│   ← KHÔNG phải Puppeteer
                    │    launchArgs)    │   ← Không có CDP
                    │  + env.TZ=<tz>   │   ← macOS/Linux fallback
                    └─────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
  ┌───────────────┐  ┌────────────────┐  ┌───────────────┐
  │  USER DATA    │  │   EXTENSION    │  │   NETWORK     │
  │  (persistent) │  │  (injected)    │  │               │
  │               │  │                │  │  Chrome       │
  │  Cookies ✅   │  │ content.js     │  │  ──SOCKS5──►  │
  │  LocalStorage │  │ MAIN world     │  │  Xray         │
  │  IndexedDB    │  │ all_frames     │  │  ──proxy──►   │
  │  Passwords    │  │ exclude Google │  │  Server       │
  │               │  │ /mail/recaptcha│  │               │
  │               │  │                │  │  Google ──►   │
  │               │  │ content_pw.js  │  │  DIRECT       │
  │               │  │ ISOLATED world │  │  (bypass)     │
  │               │  │ no all_frames  │  │               │
  │               │  │ exclude Google │  │  Sec-CH-UA    │
  │               │  │ /mail/accounts │  │  từ binary    │
  │               │  │                │  │  (CfT: real   │
  │               │  │                │  │  Google Chrome│
  │               │  │                │  │  → tự đúng ✅)│
  └───────────────┘  └────────────────┘  └───────────────┘

═══════════════════════════════════════════════════════════════
                   CHROME BINARY STRATEGY
═══════════════════════════════════════════════════════════════

  Priority (getChromiumPath):
  1. Custom path (user browse thủ công)
  2. userData/chrome-for-testing/   ← Download từ Settings UI
  3. userData/fingerprint-chromium/ ← Manual only (no UI download)
  4. resources/puppeteer/           ← Bundled trong app ← DEFAULT
  5. Chrome installed trên máy

  CfT Download (Settings → Chrome tab):
  ✅ mac-arm64 (Apple Silicon), mac-x64 (Intel), win64, linux64
  → Cho phép update Chrome mà không rebuild app

  FP-Chromium: download UI đã xoá (adryfish không có Mac build)
  → Vẫn detect nếu user tự đặt vào userData/fingerprint-chromium/

═══════════════════════════════════════════════════════════════
                   FINGERPRINT LAYERS
═══════════════════════════════════════════════════════════════

  Layer 1: PROFILE CREATION (fingerprint.js)
  ┌──────────────────────────────────────────────────────────┐
  │  generateFingerprint() — chạy 1 lần khi tạo profile     │
  │  noiseSeed (random) → lưu trong profile.json            │
  │  platform + userAgent match host OS (Mac/Win/Linux)     │
  │  GPU preset pool theo OS                                │
  │  Resolution, hardwareConcurrency, deviceMemory          │
  │  mediaDevices (deterministic từ seed)                   │
  │  timezone: "Auto" → geo-detect từ proxy IP khi launch   │
  │                                                         │
  │  Cross-platform export/import:                          │
  │  cleanFingerprint() strip OS-specific fields on export  │
  │  normalizeFingerprintForPlatform() regen on import      │
  └──────────────────────────────────────────────────────────┘

  Layer 2: JS INJECTION (content.js — MAIN world)
  ┌──────────────────────────────────────────────────────────┐
  │  getInjectScript() — chạy mỗi lần browser mở trang     │
  │  ✅ navigator.webdriver = false (prototype override)    │
  │  ✅ $cdc_* cleanup (regex + list)                       │
  │  ✅ makeNative + WeakMap (toString bypass)              │
  │  ✅ navigator.plugins (5 PDF plugins)                   │
  │  ✅ chrome.runtime patches (app/csi/loadTimes)          │
  │  ✅ Geolocation spoof (lat/lon noise)                   │
  │  ✅ chrome.runtime.id hidden                            │
  │  ✅ navigator.userAgentData override (brands + platform)│
  │  ✅ Canvas/Audio/WebGL = mode "real" (no JS hooks)      │
  │     → Worker-safe: không hook → không bị detect mismatch│
  │  MAIN world: cần thiết để override prototype globals    │
  │  Exclude Google/mail/recaptcha → không inject vào auth  │
  └──────────────────────────────────────────────────────────┘

  Layer 3: CHROME FLAGS
  ┌──────────────────────────────────────────────────────────┐
  │  --timezone=<tz>  (Chrome 92+, ALL modes)               │
  │    → hoạt động Windows/Mac/Linux ✅                     │
  │    env.TZ = fallback macOS/Linux, no-op Windows         │
  │                                                         │
  │  [FP-Chromium only]                                     │
  │  --fingerprint-platform=windows (navigator.platform)    │
  │  --fingerprint-brand=Chrome (Sec-CH-UA brand?)          │
  │    ⚠ Sec-CH-UA HTTP header — chưa verify               │
  │  --canvas-noise-seed (C++ level noise, Worker-safe)     │
  │  --audio-noise-seed (C++ level noise)                   │
  │  --webgl-vendor/renderer (C++ override)                 │
  │                                                         │
  │  [CfT — real Google Chrome]                             │
  │  Sec-CH-UA: "Google Chrome" → tự đúng, không cần patch │
  └──────────────────────────────────────────────────────────┘

  Layer 4: CHROME PREFERENCES (Preferences file)
  ┌──────────────────────────────────────────────────────────┐
  │  webrtc.ip_handling_policy = disable_non_proxied_udp    │
  │  profile.name = <profile name>                          │
  │  bookmark_bar.show_on_all_tabs = true                   │
  └──────────────────────────────────────────────────────────┘
