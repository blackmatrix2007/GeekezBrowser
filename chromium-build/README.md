# GeekezBrowser - Custom Chromium Build System

Build custom Chromium với anti-detect patches ở C++ level, host trên GitHub của bạn, deploy qua RunPod.

## Tại sao cần Custom Chromium?

GeekezBrowser hiện dùng **JavaScript injection** (fingerprint.js) để spoof fingerprint. Vấn đề:

| Issue | JavaScript Injection | C++ Patches (Custom Chromium) |
|-------|---------------------|-------------------------------|
| `configurable` flag | `true` → bị detect | `false` → native như thật |
| `toString()` check | Có thể bị detect | Native code thật |
| Stack trace leak | Lộ `apply`/`call` | Clean stack |
| Prototype pollution | Có | Không |
| Trust Score (CreepJS) | ~72% | ~94% |

---

## Có 2 Options

### Option A: Quick Repack (5 phút) ← **Recommended để bắt đầu**

Download fingerprint-chromium đã build sẵn (adryfish), repack với metadata GeekezBrowser, upload lên GitHub của bạn.

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
export GITHUB_REPO="your-username/geekez-chromium"
bash quick-repack.sh linux    # hoặc: darwin, windows
```

**Kết quả:** Binary với đầy đủ C++ patches, host trên repo của bạn.

---

### Option B: Full Build từ Source (~5 giờ trên RunPod)

Build Chromium từ đầu với custom patches của GeekezBrowser. Cho phép tùy chỉnh hoàn toàn.

---

## Option B: RunPod Build Guide

### Bước 1: Chuẩn bị RunPod Pod

Vào [runpod.io](https://runpod.io) → **Deploy** → **GPU Pods** (hoặc Community Cloud):

```
Template:   RunPod Pytorch 2.x.x (Ubuntu 22.04)
            HOẶC: bất kỳ Ubuntu 22.04 template
GPU:        Không cần GPU (nhưng pod phải có CPU mạnh)
            Khuyến nghị: CPU-only pod hoặc chọn GPU rẻ nhất
vCPU:       32+ (càng nhiều càng nhanh build)
RAM:        64GB minimum
Disk:       300GB container disk
Network:    20GB network volume (để lưu output sau khi pod tắt)
```

**Ước tính thời gian build:**
- 96 vCPU: ~2 giờ
- 32 vCPU: ~5 giờ
- 16 vCPU: ~10 giờ

**Ước tính chi phí RunPod:**
- $0.50-1.50/giờ tùy pod
- Build 1 lần: ~$3-10 total

### Bước 2: Upload scripts lên RunPod

**Cách 1:** Clone từ repo của bạn
```bash
# Trong RunPod terminal:
git clone https://github.com/YOUR_USERNAME/geekez-chromium-build.git /build
```

**Cách 2:** Copy thủ công qua SSH
```bash
# Từ máy local:
scp -r ./chromium-build/ user@runpod_ip:/build/
```

**Cách 3:** Paste script trực tiếp vào terminal RunPod

### Bước 3: Chạy Build

```bash
# Trong RunPod terminal:

# Set environment variables
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
export GITHUB_REPO="your-username/geekez-chromium"
export BUILD_ROOT="/workspace"   # Network volume để không mất data khi pod restart

# Optional: pin Chromium version
export CHROMIUM_VERSION="130.0.6723.69"

# Start build (chạy trong background nếu muốn)
nohup bash /build/runpod-build.sh > /workspace/build.log 2>&1 &
tail -f /workspace/build.log
```

### Bước 4: Monitor build

```bash
# Xem progress
tail -f /workspace/build.log

# Kiểm tra disk space
df -h

# Kiểm tra CPU usage
htop
```

### Bước 5: Sau khi build xong

Binary sẽ được upload tự động lên GitHub Releases.

Download URL: `https://github.com/YOUR_USERNAME/geekez-chromium/releases/latest`

---

## Cập nhật GeekezBrowser để dùng Custom Binary

### Cách 1: Thay đổi download URL trong main.js

Tìm dòng trong `main.js`:
```javascript
'https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest'
```

Thay bằng:
```javascript
'https://api.github.com/repos/YOUR_USERNAME/geekez-chromium/releases/latest'
```

### Cách 2: Đặt binary thủ công

1. Download zip từ GitHub releases của bạn
2. Giải nén vào:
   - **macOS:** `~/Library/Application Support/GeekEZ Browser/fingerprint-chromium/`
   - **Windows:** `%APPDATA%\GeekEZ Browser\fingerprint-chromium\`
   - **Linux:** `~/.config/GeekEZ Browser/fingerprint-chromium/`
3. Rename binary: `chrome` (Linux/Mac) hoặc `chrome.exe` (Windows)
4. Restart GeekezBrowser

### Cách 3: Custom download handler (thêm vào Electron UI)

Thêm option "Custom Build" vào Settings → Browser Engine:

```javascript
// main.js - thêm custom download handler
ipcMain.handle('download-custom-chromium', async (event) => {
    const CUSTOM_REPO = 'YOUR_USERNAME/geekez-chromium';
    // ... same code as download-fingerprint-chromium ...
    // chỉ thay adryfish/fingerprint-chromium bằng CUSTOM_REPO
});
```

---

## Custom Patches Included

| Patch | File | Effect |
|-------|------|--------|
| navigator.webdriver | `001-*.patch` | Always returns `false` (C++ native) |
| Canvas noise | `002-*.patch` | Seed-based pixel noise |
| WebGL spoofing | `003-*.patch` | Custom vendor/renderer via flags |
| Audio noise | `004-*.patch` | Seed-based AudioBuffer noise |
| Custom switches | `005-*.patch` | Registers custom `--geekez-*` flags |
| Auto traces | `006-*.patch` | Removes CDP/automation markers |
| ClientRect noise | `007-*.patch` | Sub-pixel getBoundingClientRect noise |
| performance.now() | `008-*.patch` | Timing jitter |
| Font reduction | `009-*.patch` | Whitelist-based font enumeration |

---

## Launch Flags (GeekezBrowser → Custom Chromium)

Cần truyền các flags sau khi launch Chrome từ GeekezBrowser:

```javascript
// main.js - trong launchBrowser()
const antiDetectArgs = [
    `--canvas-noise-seed=${profile.fingerprint.noiseSeed}`,
    `--audio-noise-seed=${profile.fingerprint.noiseSeed ^ 0xABCD}`,
    `--audio-noise-level=0.0000001`,
    `--webgl-vendor=${profile.fingerprint.webgl.vendor}`,
    `--webgl-renderer=${profile.fingerprint.webgl.renderer}`,
    `--perf-noise-seed=${profile.fingerprint.noiseSeed ^ 0xFFFF}`,
    // Disable standard automation flags
    '--disable-blink-features=AutomationControlled',
];
```

---

## Build Output Structure

```
geekez-chromium-{version}-linux-x64.zip
├── chrome                      # Main binary
├── chrome_sandbox              # Linux sandbox helper
├── chrome.pak                  # UI resources
├── chrome_100_percent.pak
├── chrome_200_percent.pak
├── resources.pak
├── icudtl.dat                  # ICU data
├── v8_context_snapshot.bin     # V8 snapshot
├── locales/                    # UI translations
│   ├── en-US.pak
│   └── ...
├── resources/                  # Chrome resources
└── geekez-meta.json            # Build metadata
```

---

## Troubleshooting

### Build fails: "disk space insufficient"
```bash
# Kiểm tra disk
df -h /workspace
# Xóa intermediate files
find /workspace/chromium/src/out -name "*.o" -delete
```

### Build fails: "Cannot apply patch"
```bash
# Patches có thể không compatible với version Chromium khác
# Thử dùng fingerprint-chromium version mới nhất:
export CHROMIUM_VERSION=""  # để auto-detect
```

### Binary bị detect
- Kiểm tra: https://pixelscan.net, https://browserscan.net
- Đảm bảo truyền đúng `--canvas-noise-seed` flag
- Test với creepjs: https://abrahamjuliot.github.io/creepjs/

---

## Tham khảo

- [fingerprint-chromium (adryfish)](https://github.com/adryfish/fingerprint-chromium)
- [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium)
- [Chromium Build Instructions](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md)
- [depot_tools](https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools.html)
