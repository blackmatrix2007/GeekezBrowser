# 🔧 CRITIQUE FIXES - Sửa các vấn đề từ CRITIQUE.md

> **Ngày:** 2026-03-20
> **Mục đích:** Sửa các vấn đề Critical/High trong ANALYSIS_REPORT.md dựa trên phản biện

---

## 🔴 CRITICAL FIXES

### **Fix #5: "Dùng real hardware values" phá vỡ multi-identity**

**Vấn đề:**
```javascript
// ❌ SAI - Tất cả profiles trên cùng máy có cùng hardware
hardwareConcurrency: os.cpus().length,  // 32 cores trên server
deviceMemory: Math.ceil(os.totalmem() / (1024**3)),  // 128GB trên server
```

**Giải pháp ĐÚNG:**

```javascript
// ✅ ĐÚNG - Dùng giá trị preset nhất quán giữa main thread và Worker

// 1. Worker Fingerprint Injection
// Tạo shared worker script với fingerprint injected

function generateWorkerScript(fingerprint) {
  return `
// Worker Global Scope Fingerprint Override
(function() {
  'use strict';

  const fp = ${JSON.stringify(fingerprint)};

  // Override hardwareConcurrency trong Worker context
  Object.defineProperty(self.navigator, 'hardwareConcurrency', {
    get: function() { return fp.hardwareConcurrency; },
    configurable: false,
    enumerable: true
  });

  // Override deviceMemory trong Worker context
  Object.defineProperty(self.navigator, 'deviceMemory', {
    get: function() { return fp.deviceMemory; },
    configurable: false,
    enumerable: true
  });

  // Override platform
  Object.defineProperty(self.navigator, 'platform', {
    get: function() { return fp.platform; },
    configurable: false,
    enumerable: true
  });
})();
`;
}

// 2. Inject vào ServiceWorker registration
async function generateExtension(profilePath, fingerprint, profileName, watermarkStyle, profileId) {
  const extDir = path.join(profilePath, 'extension');
  await fs.ensureDir(extDir);

  // Tạo worker-fingerprint.js
  const workerScript = generateWorkerScript(fingerprint);
  await fs.writeFile(path.join(extDir, 'worker-fingerprint.js'), workerScript);

  // Update manifest.json
  const manifest = {
    manifest_version: 3,
    name: "GeekEZ Guard",
    version: "1.1.0",
    permissions: ["storage", "activeTab"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    background: { service_worker: "background.js" },
    content_scripts: [
      { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, world: "MAIN" },
      { matches: ["<all_urls>"], js: ["content_pw.js"], run_at: "document_idle", all_frames: false, world: "ISOLATED" },
      // ⭐ NEW: Inject vào tất cả Workers
      { matches: ["<all_urls>"], js: ["worker-interceptor.js"], run_at: "document_start", all_frames: true, world: "MAIN" }
    ],
    action: { default_popup: "popup.html" }
  };

  await fs.writeJson(path.join(extDir, 'manifest.json'), manifest);

  // worker-interceptor.js - Intercept Worker creation
  const workerInterceptor = `
(function() {
  'use strict';

  const fp = ${JSON.stringify(fingerprint)};
  const workerScript = ${JSON.stringify(workerScript)};

  // Intercept Worker constructor
  const OriginalWorker = Worker;
  Worker = function(scriptURL, options) {
    // Tạo blob với fingerprint injected
    const blob = new Blob([workerScript, '\\n\\n', 'importScripts("' + scriptURL + '");'],
      { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    return new OriginalWorker(blobURL, options);
  };
  Worker.prototype = OriginalWorker.prototype;

  // Intercept SharedWorker
  const OriginalSharedWorker = SharedWorker;
  SharedWorker = function(scriptURL, options) {
    const blob = new Blob([workerScript, '\\n\\n', 'importScripts("' + scriptURL + '");'],
      { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    return new OriginalSharedWorker(blobURL, options);
  };
  SharedWorker.prototype = OriginalSharedWorker.prototype;
})();
`;

  await fs.writeFile(path.join(extDir, 'worker-interceptor.js'), workerInterceptor);
}

// 3. Fingerprint Generation - Dùng realistic values
function generateFingerprint() {
  const platform = os.platform();

  // Preset realistic values
  const presets = {
    'darwin': [
      { hardwareConcurrency: 8, deviceMemory: 8 },   // M1/M2 MacBook
      { hardwareConcurrency: 10, deviceMemory: 16 },  // M1 Pro
      { hardwareConcurrency: 12, deviceMemory: 32 }   // M1 Max
    ],
    'win32': [
      { hardwareConcurrency: 4, deviceMemory: 8 },
      { hardwareConcurrency: 8, deviceMemory: 16 },
      { hardwareConcurrency: 12, deviceMemory: 16 },
      { hardwareConcurrency: 16, deviceMemory: 32 }
    ],
    'linux': [
      { hardwareConcurrency: 4, deviceMemory: 4 },
      { hardwareConcurrency: 8, deviceMemory: 8 },
      { hardwareConcurrency: 16, deviceMemory: 16 }
    ]
  };

  // Random select from preset
  const configs = presets[platform] || presets['linux'];
  const hardware = configs[Math.floor(Math.random() * configs.length)];

  return {
    platform: getPlatformString(platform),
    hardwareConcurrency: hardware.hardwareConcurrency,
    deviceMemory: hardware.deviceMemory,
    // ... other fields
  };
}
```

**Kết quả:**
- ✅ Main thread và Worker có cùng hardwareConcurrency/deviceMemory
- ✅ Mỗi profile có hardware khác nhau (realistic diversity)
- ✅ Không lộ spec thực của host machine
- ✅ Nhất quán across all execution contexts

---

### **Fix #6: rebrowser-patches bị reset mỗi `npm install`**

**Vấn đề:**
```bash
# Patch bị xóa mỗi khi npm install
npx rebrowser-patches patch --packageName=puppeteer-core
```

**Giải pháp:**

**Option A: Thêm postinstall script (RECOMMENDED)**

```json
// package.json
{
  "scripts": {
    "start": "electron .",
    "postinstall": "node scripts/patch-puppeteer.js",
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac"
  }
}
```

```javascript
// scripts/patch-puppeteer.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PATCH_MARKER = path.join(__dirname, '../node_modules/.puppeteer-patched');

// Check if already patched
if (fs.existsSync(PATCH_MARKER)) {
  console.log('✅ Puppeteer already patched, skipping...');
  process.exit(0);
}

try {
  console.log('🔧 Patching puppeteer-core with rebrowser-patches...');

  execSync('npx rebrowser-patches patch --packageName=puppeteer-core', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });

  // Create marker file
  fs.writeFileSync(PATCH_MARKER, new Date().toISOString());

  console.log('✅ Puppeteer patched successfully!');
} catch (error) {
  console.error('❌ Failed to patch puppeteer:', error.message);
  process.exit(1);
}
```

**Option B: Dùng patch-package (Alternative)**

```bash
# Step 1: Patch manually
npx rebrowser-patches patch --packageName=puppeteer-core

# Step 2: Generate patch file
npx patch-package puppeteer-core

# Step 3: Add to package.json
{
  "scripts": {
    "postinstall": "patch-package"
  }
}
```

**Option C: Fork puppeteer-core (Long-term)**

```bash
# Fork và maintain custom build
git clone https://github.com/your-org/puppeteer-core-patched.git
npm install ./path/to/puppeteer-core-patched
```

**Khuyến nghị:** Option A cho development, Option C cho production.

---

### **Fix #7: CORS Allow-All + local API = DNS rebinding attack**

**Vấn đề:**
```javascript
// ❌ VULNERABLE
res.setHeader('Access-Control-Allow-Origin', '*');
```

**Giải pháp:**

**Option A: CSRF Token (RECOMMENDED)**

```javascript
// main.js - Generate secret token on startup
const crypto = require('crypto');
const API_SECRET = crypto.randomBytes(32).toString('hex');

// Save to file for client access
fs.writeFileSync(
  path.join(app.getPath('userData'), '.api-secret'),
  API_SECRET
);

function createApiServer(port) {
  const server = http.createServer(async (req, res) => {
    // Validate secret header
    const clientSecret = req.headers['x-geekez-secret'];

    if (clientSecret !== API_SECRET) {
      res.writeHead(403);
      return res.end(JSON.stringify({
        success: false,
        error: 'Invalid API secret. Check ~/.geekez-browser/.api-secret'
      }));
    }

    // CORS with restricted origin
    const origin = req.headers.origin;
    if (origin && (origin === 'http://localhost:3000' || origin.startsWith('http://127.0.0.1'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Geekez-Secret');
    res.setHeader('Content-Type', 'application/json');

    // ... rest of handler
  });

  return server;
}

// Client usage:
const secret = fs.readFileSync('~/.geekez-browser/.api-secret', 'utf8');
fetch('http://127.0.0.1:12138/api/profiles', {
  headers: {
    'X-Geekez-Secret': secret
  }
});
```

**Option B: Origin Whitelist**

```javascript
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',  // Vite dev server
  'vscode-webview://',      // VS Code extensions
  'electron://app'          // Electron renderer
];

function createApiServer(port) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;

    if (origin && ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      // Không set CORS header = block request
      res.writeHead(403);
      return res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
    }

    // ... rest
  });
}
```

**Option C: Disable CORS, dùng IPC thay REST API**

```javascript
// main.js - Remove REST API, dùng IPC
ipcMain.handle('api:profiles:list', async () => {
  const profiles = await fs.readJson(PROFILES_FILE);
  return { success: true, profiles };
});

ipcMain.handle('api:profiles:create', async (e, data) => {
  const newProfile = { id: uuidv4(), ...data };
  profiles.push(newProfile);
  await fs.writeJson(PROFILES_FILE, profiles);
  return { success: true, profile: newProfile };
});

// renderer.js - Call via IPC
const profiles = await window.api.invoke('api:profiles:list');
```

**Khuyến nghị:** Option C (IPC) cho internal app, Option A (CSRF token) nếu cần external automation.

---

## 🟠 HIGH PRIORITY FIXES

### **Fix #15: `wasFetchedViaSpdy: true` — SPDY deprecated từ 2016**

**Vấn đề:**
```javascript
// ❌ SAI
window.chrome.loadTimes = function() {
  return {
    wasFetchedViaSpdy: true,  // ← SPDY không tồn tại từ 2016
    npnNegotiatedProtocol: 'h2'
  };
};
```

**Giải pháp:**

```javascript
// ✅ ĐÚNG
window.chrome.loadTimes = makeNative(function() {
  // Dùng performance.getEntriesByType thay performance.timing (deprecated)
  const navEntry = performance.getEntriesByType('navigation')[0];

  if (!navEntry) {
    // Fallback nếu không có navigation entry
    return null;
  }

  // Detect protocol thực từ performance entry
  const protocol = navEntry.nextHopProtocol || 'http/1.1';

  return {
    requestTime: navEntry.fetchStart / 1000,
    startLoadTime: navEntry.fetchStart / 1000,
    commitLoadTime: navEntry.responseStart / 1000,
    finishDocumentLoadTime: navEntry.domContentLoadedEventEnd / 1000,
    finishLoadTime: navEntry.loadEventEnd / 1000,
    firstPaintTime: navEntry.responseStart / 1000,
    firstPaintAfterLoadTime: 0,
    navigationType: getNavigationType(navEntry.type),

    // ⭐ FIX: SPDY = false, detect real protocol
    wasFetchedViaSpdy: false,
    wasNpnNegotiated: protocol.startsWith('h2') || protocol.startsWith('h3'),
    npnNegotiatedProtocol: protocol.startsWith('h2') ? 'h2' :
                            protocol.startsWith('h3') ? 'h3' :
                            '',
    wasAlternateProtocolAvailable: false,
    connectionInfo: protocol
  };

  function getNavigationType(type) {
    const map = {
      'navigate': 'Other',
      'reload': 'Reload',
      'back_forward': 'BackForward',
      'prerender': 'Other'
    };
    return map[type] || 'Other';
  }
}, 'loadTimes');

// Make toString native
Object.defineProperty(window.chrome.loadTimes, 'toString', {
  value: () => 'function loadTimes() { [native code] }'
});
Object.defineProperty(window.chrome.loadTimes, 'name', {
  value: 'loadTimes'
});
```

**Tại sao SPDY phải là false:**
- SPDY protocol deprecated và removed từ Chrome 51 (May 2016)
- Không có website nào năm 2026 dùng SPDY
- `wasFetchedViaSpdy: true` là impossible value → instant detection
- HTTP/2 (h2) và HTTP/3 (h3) thay thế SPDY

---

### **Fix #16: Canvas noise v2.0 vẫn dùng `Math.random()` non-deterministic**

**Vấn đề:**
```javascript
// ❌ SAI - Canvas fingerprint thay đổi mỗi session
generateCanvasNoise() {
  return {
    r: Math.floor(Math.random() * 10) - 5,
    g: Math.floor(Math.random() * 10) - 5,
    b: Math.floor(Math.random() * 10) - 5,
    a: Math.floor(Math.random() * 10) - 5
  };
}
```

**Giải pháp:**

```javascript
// ✅ ĐÚNG - Deterministic noise per profile

class FingerprintGenerator {
  constructor(options = {}) {
    this.os = options.os || 'auto';
    this.seed = options.seed || Date.now(); // Seed từ profileId
  }

  // Seeded random (LCG)
  seededRandom(seed) {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  }

  generateCanvasNoise() {
    // Generate deterministic noise from seed
    const r = Math.floor(this.seededRandom(this.seed + 1) * 10) - 5;
    const g = Math.floor(this.seededRandom(this.seed + 2) * 10) - 5;
    const b = Math.floor(this.seededRandom(this.seed + 3) * 10) - 5;
    const a = Math.floor(this.seededRandom(this.seed + 4) * 10) - 5;

    return { r, g, b, a };
  }

  generate() {
    const preset = this.selectPreset();

    return {
      platform: preset.platform,
      screen: preset.screen,
      // ...

      // Canvas noise - deterministic
      canvasNoise: this.generateCanvasNoise(),

      // Audio noise - deterministic
      audioNoise: this.seededRandom(this.seed + 5) * 0.000001,

      // Seed lưu trong fingerprint để regenerate consistent
      noiseSeed: this.seed,

      // ...
    };
  }
}

// Usage:
function generateFingerprint(profileId) {
  // Seed từ profileId hash để đảm bảo consistency
  const seed = hashCode(profileId);

  const generator = new FingerprintGenerator({ seed });
  return generator.generate();
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}
```

**Canvas noise injection with deterministic values:**

```javascript
// content.js - Apply canvas noise
(function() {
  const fp = ${fpJson};

  // Canvas toDataURL override
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = makeNative(function(type, quality) {
    // Chỉ apply noise cho canvas có pixel data
    if (this.width === 0 || this.height === 0) {
      return originalToDataURL.apply(this, arguments);
    }

    const ctx = this.getContext('2d');
    if (!ctx) {
      return originalToDataURL.apply(this, arguments);
    }

    // Get image data
    try {
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      const data = imageData.data;

      // Apply deterministic noise
      const noise = fp.canvasNoise;
      const seed = fp.noiseSeed;

      for (let i = 0; i < data.length; i += 4) {
        // Seeded noise per pixel
        const pixelSeed = seed + i;
        const rnd = (Math.sin(pixelSeed) * 10000) % 1;

        // Apply noise (integer values only)
        data[i]     = Math.max(0, Math.min(255, data[i]     + Math.round(noise.r * rnd))); // R
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + Math.round(noise.g * rnd))); // G
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + Math.round(noise.b * rnd))); // B
        data[i + 3] = Math.max(0, Math.min(255, data[i + 3] + Math.round(noise.a * rnd))); // A
      }

      ctx.putImageData(imageData, 0, 0);
    } catch (e) {
      // SecurityError hoặc canvas tainted - skip noise
    }

    return originalToDataURL.apply(this, arguments);
  }, 'toDataURL');
})();
```

**Kết quả:**
- ✅ Canvas fingerprint consistent giữa các sessions
- ✅ Noise deterministic dựa trên profileId
- ✅ CreepJS không detect inconsistency
- ✅ Mỗi profile có unique canvas fingerprint

---

## 🟡 MEDIUM PRIORITY FIXES

### **Fix #23: Font shuffle dùng `sort(random)` có statistical bias**

**Vấn đề:**
```javascript
// ❌ SAI - Biased shuffle
const shuffled = nonEssential.sort(() => Math.random() - 0.5);
```

**Giải pháp:**

```javascript
// ✅ ĐÚNG - Fisher-Yates shuffle (unbiased)
function fisherYatesShuffle(array, seed) {
  const arr = [...array];
  let currentIndex = arr.length;

  // Seeded random function
  function seededRandom() {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  }

  while (currentIndex !== 0) {
    const randomIndex = Math.floor(seededRandom() * currentIndex);
    currentIndex--;

    [arr[currentIndex], arr[randomIndex]] = [arr[randomIndex], arr[currentIndex]];
  }

  return arr;
}

// fonts.js
function generateFontList(platform, seed) {
  const essential = FONT_DATA.essential;
  const markers = FONT_DATA.markers[platform] || [];
  const nonEssential = FONT_DATA.nonEssential[platform] || [];

  // Shuffle with Fisher-Yates
  const shuffled = fisherYatesShuffle(nonEssential, seed);

  // Random subset 30-78%
  const percentage = 0.30 + (Math.sin(seed) * 10000 % 1) * 0.48;
  const subsetSize = Math.floor(shuffled.length * percentage);
  const subset = shuffled.slice(0, subsetSize);

  return [...essential, ...markers, ...subset];
}
```

---

### **Fix #24: `Error.prepareStackTrace` override có thể bị detect**

**Vấn đề:**
```javascript
// ❌ Có thể bị detect
Error.prepareStackTrace = function(error, stackTraces) { ... };
```

**Giải pháp: Không override global Error.prepareStackTrace**

```javascript
// ✅ ĐÚNG - Sanitize per-function thay vì global override

function makeNativeSafe(func, name) {
  const wrapped = function(...args) {
    try {
      return func.apply(this, args);
    } catch (err) {
      // Sanitize stack trace trước khi throw
      if (err.stack) {
        err.stack = sanitizeStack(err.stack);
      }
      throw err;
    }
  };

  // Make native toString
  Object.defineProperty(wrapped, 'toString', {
    value: () => `function ${name}() { [native code] }`
  });
  Object.defineProperty(wrapped, 'name', {
    value: name
  });

  return wrapped;
}

function sanitizeStack(stack) {
  return stack
    .split('\n')
    .filter(line => {
      // Remove suspicious lines
      if (line.includes('at Proxy.')) return false;
      if (line.includes('at Reflect.')) return false;
      if (line.includes('pptr:')) return false;
      if (line.includes('__puppeteer')) return false;
      if (line.includes('geekez_')) return false;
      return true;
    })
    .join('\n');
}

// Không override Error.prepareStackTrace globally
// Chỉ sanitize trong error handlers của hooks
```

---

### **Fix: Add rebrowser-patches version pinning**

```json
// package.json
{
  "dependencies": {
    "puppeteer": "24.34.0",  // Pin exact version
    "rebrowser-patches": "^1.0.0"  // Pin compatible version
  },
  "resolutions": {
    "puppeteer-core": "24.34.0"  // Force exact version
  }
}
```

```javascript
// scripts/patch-puppeteer.js
const SUPPORTED_VERSIONS = ['24.34.0'];
const puppeteerVersion = require('puppeteer/package.json').version;

if (!SUPPORTED_VERSIONS.includes(puppeteerVersion)) {
  console.warn(`⚠️ Puppeteer ${puppeteerVersion} may not be compatible with current patches.`);
  console.warn(`   Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`);
  console.warn(`   Proceed with caution or downgrade Puppeteer.`);
}
```

---

## 📋 SUMMARY - Action Items

### **Must Fix (Blocking):**
1. ✅ Worker fingerprint consistency (#5)
2. ✅ rebrowser-patches postinstall (#6)
3. ✅ CORS security với CSRF token (#7)

### **Should Fix (High Priority):**
4. ✅ wasFetchedViaSpdy → false (#15)
5. ✅ Canvas noise deterministic (#16)
6. ✅ Font shuffle Fisher-Yates (#23)

### **Nice to Fix (Medium Priority):**
7. ✅ Error.prepareStackTrace approach (#24)
8. ✅ rebrowser-patches version pinning

---

## 🧪 Testing Checklist

Sau khi apply fixes, test với:

```bash
# 1. Worker consistency
node test-worker-consistency.js
# Expected: Main thread hardwareConcurrency === Worker hardwareConcurrency

# 2. Canvas fingerprint consistency
node test-canvas-deterministic.js
# Expected: Same canvas fingerprint across sessions

# 3. Font list randomness
node test-font-shuffle-distribution.js
# Expected: Uniform distribution, no bias

# 4. API security
curl -X GET http://127.0.0.1:12138/api/profiles
# Expected: 403 Forbidden without secret header

curl -X GET http://127.0.0.1:12138/api/profiles \
  -H "X-Geekez-Secret: $(cat ~/.geekez-browser/.api-secret)"
# Expected: 200 OK with profiles list

# 5. Detection tests
npm run test:creepjs   # Expected: Trust score > 90%
npm run test:pixelscan # Expected: No bot detected
npm run test:sannysoft # Expected: All checks green
```

---

**File updated:** 2026-03-20
**Next step:** Apply fixes to [ANALYSIS_REPORT.md](./ANALYSIS_REPORT.md) và update roadmap
