# Nghiên Cứu Anti-Detect Browser & Fingerprint Spoofing

## 📋 Tổng Quan

Tài liệu này tổng hợp nghiên cứu về các công nghệ anti-detect browser, fingerprint spoofing, và quản lý multi-profile để bypass detection systems.

---

## 🎯 Phân Tích GPMLogin

### API Endpoint
```
POST /api/v3/profiles/create
```

### Tính Năng Chính

#### 1. **Tạo Profile Chrome**
```json
{
  "profile_name": "Tên profile",
  "browser_name": "Chrome",
  "browser_core": "chromium",
  "browser_version": "119.0.6045.124",
  "is_random_browser_version": false,
  "user_agent": "Custom UA string"
}
```

#### 2. **Cấu Hình Proxy**
Hỗ trợ nhiều định dạng:

- **HTTP**: `IP:Port:User:Pass`
- **SOCKS5**: `socks5://IP:Port:User:Pass`
- **TMProxy/TinProxy**: `protocol://API_KEY|True,False`

**Ví dụ với proxy của bạn:**
```json
{
  "profile_name": "Profile IPv4",
  "raw_proxy": "168.81.239.177:8000:80AyWm:9cA733"
}
```

```json
{
  "profile_name": "Profile IPv6",
  "raw_proxy": "45.153.20.234:12330:zREGKk:y6yc3v"
}
```

#### 3. **Fingerprint Protection Parameters**
```json
{
  "is_masked_font": true,
  "is_masked_webgl_data": true,
  "is_masked_media_device": true,
  "is_noise_canvas": false,
  "is_noise_webgl": false,
  "is_noise_client_rect": false,
  "is_noise_audio_context": true,
  "is_random_screen": false,
  "webrtc_mode": 2
}
```

#### 4. **Hardware Fingerprint Spoofing**
- `ScreenWidth`, `ScreenHeight`
- `ProcessorCount`
- `WebGLVendor`, `WebGLRender`
- `MaxVertexUniform`, `MaxFragmentUniform`
- `AudioNoise`

#### 5. **MAC Address**
⚠️ **Lưu ý**: Tài liệu API của GPMLogin không đề cập cụ thể đến việc tạo/spoof MAC address. Có thể họ:
- Sử dụng MAC spoofing ở OS/driver level
- Mask network fingerprint thay vì thay đổi MAC thực

---

## 🏆 Top Open Source Repositories

### 1. ⭐ **Undetectable Fingerprint Browser** (HIGHLY RECOMMENDED)

**Repository**: [itbrowser-net/undetectable-fingerprint-browser](https://github.com/itbrowser-net/undetectable-fingerprint-browser)

**Tính Năng**:
- ✅ Canvas & WebGL/WebGL2 spoofing với precision noise
- ✅ AudioContext fingerprinting
- ✅ Built-in proxy injection (SOCKS5, HTTP, TLS)
- ✅ Profile management qua JSON files
- ✅ Tích hợp Puppeteer/Playwright/Selenium
- ✅ Chromium-based
- ✅ Consistency Analysis Engine (đảm bảo logic fingerprint)
- ✅ Mobile emulation support

**Tech Stack**:
- Base: Chromium
- Integration: Puppeteer, Playwright, DevTools Protocol
- Architecture: Modular plugin system

**Usage**:
```bash
# Command line
itbrowser.exe --itbrowser=myfingerprint.json --proxy-server="socks5://168.81.239.177:8000:80AyWm:9cA733"

# Generate fingerprint
itbrowser_fingerprint.exe
```

**Puppeteer Example**:
```javascript
const puppeteer = require('puppeteer');
const browser = await puppeteer.launch({
  executablePath: './itbrowser.exe',
  args: [
    '--itbrowser=fingerprint.json',
    '--proxy-server=socks5://168.81.239.177:8000:80AyWm:9cA733'
  ]
});
```

**Ưu điểm**:
- Download về dùng ngay, không cần setup phức tạp
- Profile JSON đơn giản
- Tích hợp automation framework tốt
- Miễn phí, open source

**Nhược điểm**:
- Chromium-based nên vẫn có CDP detection vectors

---

### 2. 🦊 **Camoufox** (BEST FOR ANTI-DETECTION)

**Repository**: [daijro/camoufox](https://github.com/daijro/camoufox)

**Tính Năng**:
- ✅ Firefox-based (khác biệt với Chrome)
- ✅ Fingerprint injection ở C++ level (không phát hiện được qua JS)
- ✅ Auto fingerprint generation với BrowserForge
- ✅ Proxy support với geo matching
- ✅ WebRTC IP spoofing ở protocol level
- ✅ Isolated page agent (không detect được automation)
- ✅ No JavaScript injection detection

**Tech Stack**:
- C++ 57.9%
- Python 17.7%
- JavaScript 16.1%
- Built on Firefox 135+
- Custom Juggler protocol (pre-CDP)

**Usage**:
```python
from camoufox.sync_api import Camoufox

with Camoufox(
    proxy={
        'server': 'socks5://168.81.239.177:8000',
        'username': '80AyWm',
        'password': '9cA733'
    }
) as browser:
    page = browser.new_page()
    page.goto('https://example.com')
```

**Ưu điểm**:
- Spoof ở C++ level → không thể detect bằng JS
- Firefox-based → khác biệt hoàn toàn với Chrome detection
- Protocol-level spoofing → không có property descriptor leaks
- Tích hợp proxy providers (Thordata, ProxyEmpire, BirdProxies)

**Nhược điểm**:
- Build phức tạp (cần Linux, không WSL)
- Performance có thể chậm hơn Chrome
- Cảnh báo về maintenance gap (đang active lại)

**Khi nào dùng**:
- Cần bypass detection cao nhất
- Target có anti-bot mạnh
- Không bị giới hạn về performance

---

### 3. 🔧 **Puppeteer-with-Fingerprints**

**Repository**: [bablosoft/puppeteer-with-fingerprints](https://github.com/bablosoft/puppeteer-with-fingerprints)

**Tính Năng**:
- ✅ Real device fingerprints (collected từ thiết bị thật)
- ✅ Profile management tự động
- ✅ Proxy HTTPS/SOCKS5 với authentication
- ✅ Auto timezone/geolocation matching với IP
- ✅ PerfectCanvas technology (premium)
- ⚠️ Windows only
- ⚠️ Cần service key (có free tier)

**Usage**:
```javascript
const { plugin } = require('puppeteer-with-fingerprints');

// Set service key
plugin.setServiceKey('YOUR_KEY_HERE');

// Fetch fingerprint từ real devices
const fingerprint = await plugin.fetch({
  tags: ['Microsoft Windows', 'Chrome']
});

// Apply fingerprint
plugin.useFingerprint(fingerprint);

// Configure proxy
plugin.useProxy('168.81.239.177:8000:80AyWm:9cA733');

// Launch với profile
plugin.useProfile('/path/to/profile');

const browser = await plugin.launch();
const page = await browser.newPage();
```

**API Methods**:
```javascript
plugin.setServiceKey(key)           // Set service key
plugin.fetch(options)                // Fetch fingerprint
plugin.useFingerprint(fingerprint)   // Apply fingerprint
plugin.useProxy(proxy)               // Set proxy
plugin.useProfile(path)              // Use profile
plugin.launch(options)               // Launch browser
```

**License**: MIT (open source)

**Ưu điểm**:
- Real device fingerprints → rất realistic
- Auto timezone/geo matching
- Profile persistence tốt
- Compatible với Puppeteer scripts hiện có

**Nhược điểm**:
- Windows only
- Cần service key (có giới hạn free tier)
- Commercial model cho premium features

---

### 4. 📦 **Playwright-with-Fingerprints**

**Repository**: [bablosoft/playwright-with-fingerprints](https://github.com/bablosoft/playwright-with-fingerprints)

Tương tự Puppeteer version nhưng cho Playwright.

**Usage**:
```javascript
const { plugin } = require('playwright-with-fingerprints');

plugin.setServiceKey('YOUR_KEY');
const fingerprint = await plugin.fetch({ tags: ['Chrome'] });
plugin.useFingerprint(fingerprint);
plugin.useProxy('socks5://45.153.20.234:12330:zREGKk:y6yc3v');

const browser = await plugin.launch();
```

---

### 5. 🎭 **Fingerprint Injector** (Apify)

**Repository**: [apify/fingerprint-injector](https://github.com/apify/fingerprint-injector)

**Status**: ⚠️ Deprecated → Dùng `fingerprint-suite` thay thế

**Tính Năng**:
- ✅ Unified interface cho Puppeteer/Playwright
- ✅ Open source, MIT license
- ⚠️ Không có proxy/profile management built-in

**Usage**:
```javascript
const { FingerprintInjector } = require('fingerprint-injector');
const { FingerprintGenerator } = require('fingerprint-generator');

const generator = new FingerprintGenerator();
const fingerprint = generator.getFingerprint();

// Puppeteer
await FingerprintInjector.attachFingerprintToPuppeteer(page, fingerprint);

// Playwright
await FingerprintInjector.attachFingerprintToPlaywright(context, fingerprint);
```

**Ghi chú**: Chỉ inject fingerprint, không quản lý proxy/profile

---

### 6. 🔐 **Browser Fingerprint Spoofer**

**Repository**: [dvm-sh/browser-fingerprint-spoofer](https://github.com/dvm-sh/browser-fingerprint-spoofer)

**Loại**: Chrome Extension

**Tính Năng**:
- ✅ Multi-profile support (Windows/macOS/Linux)
- ✅ 3 privacy levels (Basic/Standard/Maximum)
- ✅ WebGL, Canvas, WebRTC protection
- ✅ Font detection blocking
- ⚠️ Không tích hợp automation tốt

**Profiles**:
- Windows Chrome
- macOS Safari
- Linux Firefox
- Custom

**Ưu điểm**:
- Dễ sử dụng (extension)
- Preset profiles tiện lợi
- Open source, MIT license

**Nhược điểm**:
- Khó tích hợp với automation tools
- Không có REST API
- Extension-based → giới hạn

---

## 🔬 Kỹ Thuật Fingerprint Spoofing

### Canvas Fingerprinting
```javascript
// Inject noise vào canvas
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function() {
  // Add random noise
  const context = this.getContext('2d');
  const imageData = context.getImageData(0, 0, this.width, this.height);
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] += Math.random() * 0.1;
  }
  context.putImageData(imageData, 0, 0);
  return originalToDataURL.apply(this, arguments);
};
```

### WebGL Fingerprinting
```javascript
// Spoof WebGL parameters
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
    return 'Intel Inc.';
  }
  if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
    return 'Intel Iris OpenGL Engine';
  }
  return getParameter.call(this, parameter);
};
```

### AudioContext Fingerprinting
```javascript
// Add noise to AudioContext
const originalGetChannelData = AudioBuffer.prototype.getChannelData;
AudioBuffer.prototype.getChannelData = function() {
  const data = originalGetChannelData.apply(this, arguments);
  for (let i = 0; i < data.length; i++) {
    data[i] += Math.random() * 0.0001;
  }
  return data;
};
```

### Navigator Properties
```javascript
// Override navigator properties
Object.defineProperty(navigator, 'hardwareConcurrency', {
  get: () => 4
});

Object.defineProperty(navigator, 'platform', {
  get: () => 'Win32'
});

Object.defineProperty(navigator, 'userAgent', {
  get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...'
});
```

---

## 💡 Khuyến Nghị Cho Dự Án

### Proxy Setup
```
IPv4: 168.81.239.177:8000:80AyWm:9cA733
IPv6: 45.153.20.234:12330:zREGKk:y6yc3v
```

### Scenario 1: Cần Nhanh & Đơn Giản
**→ Dùng: Undetectable Fingerprint Browser**

**Lý do**:
- Download về dùng ngay
- Profile JSON đơn giản
- Tích hợp automation tốt
- Open source, miễn phí

**Setup**:
```bash
# 1. Download binary
wget https://github.com/itbrowser-net/undetectable-fingerprint-browser/releases

# 2. Tạo fingerprint profile
./itbrowser_fingerprint.exe > profile1.json

# 3. Launch với proxy
./itbrowser.exe \
  --itbrowser=profile1.json \
  --proxy-server="socks5://168.81.239.177:8000:80AyWm:9cA733"
```

---

### Scenario 2: Cần Anti-Detection Cao Nhất
**→ Dùng: Camoufox**

**Lý do**:
- Firefox-based (khác Chrome)
- Spoof ở C++ level
- Không detect được bằng JS
- Protocol-level protection

**Setup**:
```python
from camoufox.sync_api import Camoufox

# IPv4 Proxy
with Camoufox(
    proxy={
        'server': 'socks5://168.81.239.177:8000',
        'username': '80AyWm',
        'password': '9cA733'
    },
    geoip=True  # Auto match timezone/locale
) as browser:
    page = browser.new_page()
    page.goto('https://target.com')

# IPv6 Proxy
with Camoufox(
    proxy={
        'server': 'socks5://45.153.20.234:12330',
        'username': 'zREGKk',
        'password': 'y6yc3v'
    }
) as browser:
    page = browser.new_page()
    page.goto('https://target.com')
```

---

### Scenario 3: Cần Real Device Fingerprints
**→ Dùng: Puppeteer-with-Fingerprints**

**Lý do**:
- Fingerprints từ real devices
- Auto timezone/geo matching
- Profile persistence tốt

**Setup**:
```javascript
const { plugin } = require('puppeteer-with-fingerprints');

async function createProfile(proxyString, profileName) {
  plugin.setServiceKey('YOUR_KEY');

  // Fetch real device fingerprint
  const fingerprint = await plugin.fetch({
    tags: ['Microsoft Windows', 'Chrome'],
    minBrowserVersion: 119
  });

  plugin.useFingerprint(fingerprint);
  plugin.useProxy(proxyString);
  plugin.useProfile(`./profiles/${profileName}`);

  const browser = await plugin.launch();
  return browser;
}

// Profile 1 với IPv4
const browser1 = await createProfile(
  '168.81.239.177:8000:80AyWm:9cA733',
  'profile_v4'
);

// Profile 2 với IPv6
const browser2 = await createProfile(
  '45.153.20.234:12330:zREGKk:y6yc3v',
  'profile_v6'
);
```

---

## 📚 Tài Liệu Tham Khảo

### Official Documentation
- [GPM Login API Documentation](https://docs.gpmloginapp.com/api-document)
- [Tạo profile API](https://docs.gpmloginapp.com/api-document/tao-profile)
- [GPM Login API Integration Guide](https://gpmlogin.com/blog/gpm-login-api-integration-complete-developer-guide)

### GitHub Repositories
- [Undetectable Fingerprint Browser](https://github.com/itbrowser-net/undetectable-fingerprint-browser)
- [Camoufox Anti-detect](https://github.com/daijro/camoufox)
- [Puppeteer with Fingerprints](https://github.com/bablosoft/puppeteer-with-fingerprints)
- [Playwright with Fingerprints](https://github.com/bablosoft/playwright-with-fingerprints)
- [Apify Fingerprint Injector](https://github.com/apify/fingerprint-injector)
- [Browser Fingerprint Spoofer](https://github.com/dvm-sh/browser-fingerprint-spoofer)
- [GPMSharedLibrary](https://github.com/tomdzpro/GPMSharedLibrary)
- [GPMLoginApiV2](https://github.com/buiducduy111/GPMLoginApiV2)

### Technical Guides
- [ScrapFly: Bypass Proxy Detection](https://scrapfly.io/blog/posts/bypass-proxy-detection-with-browser-fingerprint-impersonation)
- [Fingerprint Suite Guide](https://roundproxies.com/blog/fingerprint-suite/)
- [Browser Fingerprinting Analysis](https://github.com/niespodd/browser-fingerprinting)
- [TLS Fingerprinting Guide](https://www.browserless.io/blog/tls-fingerprinting-explanation-detection-and-bypassing-it-in-playwright-and-puppeteer)

### Detection & Testing Tools
- [CreepJS - Fingerprint Detection](https://github.com/abrahamjuliot/creepjs)
- [WebGL Fingerprinting Guide](https://roundproxies.com/blog/webgl-fingerprinting/)

---

## 🎯 Best Practices

### 1. Fingerprint Consistency
- **KHÔNG BAO GIỜ** thay đổi fingerprint giữa session
- Rotate fingerprints mỗi 30-60 phút cho long sessions
- Đảm bảo tất cả parameters align với nhau (OS, browser, screen, timezone)

### 2. Proxy Rotation
- Match timezone/locale với IP location
- Rotate proxy khi rotate fingerprint
- Dùng residential proxies cho high-security targets

### 3. Profile Management
- 1 profile = 1 identity = 1 fingerprint + 1 proxy
- Store profiles persistently
- Backup cookies/localStorage/sessionStorage

### 4. Human-like Behavior
- Random delays giữa actions
- Mouse movements tự nhiên
- Scroll behavior realistic
- Typing speed variation

### 5. Testing
- Test với CreepJS trước khi production
- Check WebGL/Canvas leaks
- Verify timezone/locale consistency
- Test với target's anti-bot system

---

## ⚠️ Lưu Ý Quan Trọng

### MAC Address Spoofing
- Hầu hết browser fingerprinting **KHÔNG ĐỌC** được MAC address trực tiếp
- MAC address chỉ visible ở network layer (không accessible từ browser JS)
- Websites dùng WebRTC để leak local IPs, KHÔNG phải MAC
- GPMLogin và các tool tương tự KHÔNG spoof MAC address

### WebRTC Leaks
```javascript
// Disable WebRTC hoặc fake local IPs
webrtc_mode: 1  // Off
webrtc_mode: 2  // Based on IP (recommended)
```

### Canvas/WebGL Detection
- Một số sites detect canvas/webGL spoofing trong 90% trường hợp
- Dùng "precision noise" thay vì random noise
- Camoufox's C++ level spoofing khó detect hơn JS injection

### Browser Automation Detection
```javascript
// Chrome DevTools Protocol (CDP) có nhiều detection vectors:
navigator.webdriver === true
window.chrome === undefined  // Missing in headless
// ... và nhiều hơn nữa

// Firefox với Juggler protocol (Camoufox) tránh được:
- Isolated page agent
- No webdriver property
- No CDP leaks
```

---

## 🚀 Quick Start Guide

### Option A: Undetectable Browser (Fastest)
```bash
# 1. Download
git clone https://github.com/itbrowser-net/undetectable-fingerprint-browser.git

# 2. Run
./itbrowser.exe --proxy-server="socks5://168.81.239.177:8000:80AyWm:9cA733"
```

### Option B: Camoufox (Best Anti-Detection)
```bash
# 1. Install
pip install camoufox

# 2. Use
python your_script.py
```

### Option C: Puppeteer with Fingerprints (Real Devices)
```bash
# 1. Install
npm install puppeteer-with-fingerprints

# 2. Get service key from bablosoft.com

# 3. Use
node your_script.js
```

---

## 📊 So Sánh Tổng Quan

| Feature | Undetectable Browser | Camoufox | Puppeteer-Fingerprints |
|---------|---------------------|----------|----------------------|
| **Base** | Chromium | Firefox | Chromium |
| **Spoofing Level** | JS + Config | C++ Native | JS + Real Data |
| **Detection Resistance** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Ease of Use** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Proxy Support** | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Profile Management** | ✅ JSON files | ⚠️ Limited | ✅ Auto persist |
| **Automation** | ✅ Excellent | ✅ Playwright | ✅ Puppeteer |
| **Cost** | Free | Free | Free + Paid |
| **Platform** | All | All | Windows only |
| **Open Source** | ✅ | ✅ | ✅ |

---

## 🎓 Kết Luận

### Cho Beginners
**→ Undetectable Fingerprint Browser**
- Dễ nhất để bắt đầu
- Documentation tốt
- Community support

### Cho Advanced Users
**→ Camoufox**
- Best anti-detection
- C++ level spoofing
- Future-proof

### Cho Production Scale
**→ Puppeteer-with-Fingerprints**
- Real device fingerprints
- Proven reliability
- Commercial support available

---

**Ngày tạo**: 2026-03-18
**Tác giả**: Claude Code Research
**Version**: 1.0
