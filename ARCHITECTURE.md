╔══════════════════════════════════════════════════════════════════════╗
║                     GEEKEZBROSER — LUỒNG HIỆN TẠI                   ║
╚══════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────┐
│                        ELECTRON MAIN PROCESS                        │
│                                                                     │
│  ┌──────────────────┐     ┌──────────────────┐                     │
│  │  License Check   │     │  Profile Manager │                     │
│  │ tool.erp-x.com   │     │  profiles.json   │                     │
│  │ 5min heartbeat   │     │  groups.json     │                     │
│  └──────────────────┘     └──────────────────┘                     │
│                                                                     │
│                    ipcMain.handle('launch-profile')                 │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   LAUNCH FLOW     │
                    └─────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
  ┌───────────────┐  ┌────────────────┐  ┌───────────────┐
  │  GEO DETECT   │  │ EXT GENERATE   │  │  PROXY SETUP  │
  │               │  │                │  │               │
  │ http://ip-api │  │ generateExten- │  │ Xray spawn    │
  │ .com/json/IP  │  │ sion()         │  │ SOCKS5→proxy  │
  │               │  │                │  │               │
  │ → timezone    │  │ GeekEZ Guard   │  │ ALL traffic   │
  │ → language    │  │ manifest.json  │  │ including     │
  │ → lat/lon     │  │ content.js     │  │ Gmail/YT      │
  │ → countryCode │  │ content_pw.js  │  │ NO bypass     │
  │               │  │ background.js  │  │               │
  │ ⚠ HTTP clear  │  │                │  │ socks5://     │
  │ ⚠ only if     │  │ ⚠ MAIN world  │  │ 127.0.0.1:   │
  │   Auto tz     │  │ ⚠ all_frames  │  │ localPort     │
  └───────────────┘  └────────────────┘  └───────────────┘
          │                   │                   │
          └───────────────────▼───────────────────┘
                              │
                    ┌─────────▼─────────────────────────┐
                    │        CHROME LAUNCH ARGS          │
                    │                                    │
                    │  --proxy-server=socks5://...       │
                    │  --user-data-dir=<profile-dir>     │
                    │  --user-agent=<UA string>          │
                    │  --lang=<language>                 │
                    │  --accept-lang=<language>          │
                    │  --load-extension=<ext-path>       │
                    │  --no-sandbox                      │
                    │  --disable-blink-features=         │
                    │    AutomationControlled            │
                    │  --disable-features=               │
                    │    IsolateOrigins,                 │
                    │    site-per-process  ⚠             │
                    │  --disk-cache-size=50MB  ⚠         │
                    │  --restore-last-session            │
                    │  --force-webrtc-ip-handling-policy │
                    │    =disable_non_proxied_udp        │
                    │                                    │
                    │  [FP-Chromium only]                │
                    │  --fingerprint-platform=windows    │
                    │  --fingerprint-brand=Chrome        │
                    │  --canvas-noise-seed=<seed>        │
                    │  --audio-noise-seed=<seed>         │
                    │  --perf-noise-seed=<seed>          │
                    │  --timezone=<tz>                   │
                    │  --webgl-vendor=<vendor>           │
                    │  --webgl-renderer=<renderer>       │
                    └─────────┬──────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  spawn(chromePath,│   ← KHÔNG phải Puppeteer
                    │    launchArgs)    │   ← Không có CDP
                    │  + env.TZ=<tz>   │   ← Không có page control
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
  │  LocalStorage │  │ document_start │  │  Xray         │
  │  IndexedDB    │  │ MAIN world     │  │  ──proxy──►   │
  │  Passwords    │  │ <all_urls>     │  │  Server       │
  │               │  │ -Google auth   │  │               │
  │  Cache ⚠      │  │ -mail.google  │  │  Sec-CH-UA    │
  │  CLEARED on   │  │                │  │  từ binary    │
  │  exit         │  │ content_pw.js  │  │  không qua    │
  │  Code Cache   │  │ ISOLATED world │  │  CDP ⚠        │
  │  CLEARED ⚠    │  │ -mail missing  │  │               │
  └───────────────┘  └────────────────┘  └───────────────┘

═══════════════════════════════════════════════════════════════
                   FINGERPRINT LAYERS
═══════════════════════════════════════════════════════════════

  Layer 1: PROFILE CREATION (fingerprint.js)
  ┌──────────────────────────────────────────────────────────┐
  │  generateFingerprint() — chạy 1 lần khi tạo profile      │
  │  noiseSeed (random) → lưu trong profile.json             │
  │  GPU preset (Win/Mac/Linux pool)                         │
  │  Resolution, hardwareConcurrency, deviceMemory           │
  │  mediaDevices (deterministic từ seed)                    │
  │  timezone: "America/Los_Angeles" ⚠ default không Auto   │
  └──────────────────────────────────────────────────────────┘

  Layer 2: JS INJECTION (content.js — MAIN world)
  ┌──────────────────────────────────────────────────────────┐
  │  getInjectScript() — chạy mỗi lần browser mở trang      │
  │  ✅ navigator.webdriver = false (prototype override)     │
  │  ✅ $cdc_* cleanup (regex + list)                        │
  │  ✅ makeNative + WeakMap (toString bypass)               │
  │  ✅ navigator.plugins (5 PDF plugins)                    │
  │  ✅ chrome.runtime patches (app/csi/loadTimes)           │
  │  ✅ Geolocation spoof (lat/lon noise)                    │
  │  ✅ chrome.runtime.id hidden                             │
  │  ✅ Canvas/Audio/WebGL = mode "real" (no JS hooks)       │
  │  ⚠ MAIN world (vẫn chưa đổi ISOLATED)                  │
  │  ⚠ all_frames:true → inject vào reCAPTCHA iframes       │
  │  ⚠ Watermark inject vào tất cả pages                    │
  └──────────────────────────────────────────────────────────┘

  Layer 3: CHROME FLAGS (FP-Chromium C++ level)
  ┌──────────────────────────────────────────────────────────┐
  │  --fingerprint-platform=windows (navigator.platform)    │
  │  --fingerprint-brand=Chrome (Sec-CH-UA brand?)          │
  │  --canvas-noise-seed (C++ level noise)                  │
  │  --audio-noise-seed (C++ level noise)                   │
  │  --webgl-vendor/renderer (C++ override)                 │
  │  env.TZ (V8 timezone — macOS/Linux only)                │
  │  ⚠ Sec-CH-UA HTTP header — uncertain                   │
  │  ⚠ Windows TZ = chỉ env.TZ, không có CDP              │
  └──────────────────────────────────────────────────────────┘

  Layer 4: CHROME PREFERENCES (Preferences file)
  ┌──────────────────────────────────────────────────────────┐
  │  webrtc.ip_handling_policy = disable_non_proxied_udp    │
  │  profile.name = <profile name>                          │
  │  bookmark_bar.show_on_all_tabs = true                   │
  └──────────────────────────────────────────────────────────┘
