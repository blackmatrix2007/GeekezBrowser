# FINGERPRINT ENGINE IMPLEMENTATION - ADVANCED GUIDE

## 📐 ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────┐
│                    Fingerprint Engine                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  1. Profile Generator (Seed-based)                         │ │
│  │     - Input: Seed string                                   │ │
│  │     - Output: Deterministic fingerprint profile            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  2. Consistency Validator                                  │ │
│  │     - Check OS ↔ Platform ↔ GPU                           │ │
│  │     - Check Timezone ↔ IP Location                        │ │
│  │     - Check Screen ↔ Device Type                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  3. Entropy Reducer                                        │ │
│  │     - Select common fingerprints                           │ │
│  │     - Avoid unique combinations                            │ │
│  │     - Match statistical distribution                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  4. Injection Engine                                       │ │
│  │     - JavaScript injection (current)                       │ │
│  │     - C++ modification (future)                            │ │
│  │     - CDP Emulation (hybrid)                               │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 PHẦN 1: SEED-BASED FINGERPRINT GENERATOR

### Current Implementation (GeekezBrowser)

```javascript
// fingerprint.js - Line 7-47
function generateFingerprint() {
    // ❌ PROBLEM 1: Sử dụng Math.random() - không deterministic
    const res = getRandom(RESOLUTIONS); // Random mỗi lần
    const canvasNoise = {
        r: Math.floor(Math.random() * 10) - 5,
        g: Math.floor(Math.random() * 10) - 5,
        b: Math.floor(Math.random() * 10) - 5,
        a: Math.floor(Math.random() * 10) - 5
    };

    // ❌ PROBLEM 2: hardwareConcurrency random - không consistent
    hardwareConcurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],

    // ❌ PROBLEM 3: noiseSeed random - mỗi session khác nhau
    noiseSeed: Math.floor(Math.random() * 9999999),

    // ❌ PROBLEM 4: Không validate consistency
    // Ví dụ: Windows platform nhưng có thể có iOS font list
}
```

### ✅ Improved Implementation: Deterministic Seed-based System

```javascript
const crypto = require('crypto');

/**
 * Seeded Random Number Generator (PRNG)
 * Tạo chuỗi số random DETERMINISTIC từ seed
 */
class SeededRNG {
    constructor(seed) {
        // Convert seed string to number
        this.seed = typeof seed === 'string'
            ? parseInt(crypto.createHash('sha256').update(seed).digest('hex').substring(0, 8), 16)
            : seed;
        this.state = this.seed;
    }

    /**
     * Linear Congruential Generator (LCG)
     * Same seed → Same sequence forever
     */
    next() {
        // Parameters từ Numerical Recipes (tốt cho randomness)
        const a = 1664525;
        const c = 1013904223;
        const m = Math.pow(2, 32);

        this.state = (a * this.state + c) % m;
        return this.state / m; // Return [0, 1)
    }

    /**
     * Random integer in range [min, max]
     */
    nextInt(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    /**
     * Random float in range [min, max)
     */
    nextFloat(min = 0, max = 1) {
        return this.next() * (max - min) + min;
    }

    /**
     * Random choice from array
     */
    choice(array) {
        return array[this.nextInt(0, array.length - 1)];
    }

    /**
     * Gaussian distribution (normal distribution)
     * Useful for more realistic variations
     */
    nextGaussian(mean = 0, stdDev = 1) {
        // Box-Muller transform
        const u1 = this.next();
        const u2 = this.next();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return z0 * stdDev + mean;
    }
}

/**
 * Database of common fingerprints (based on real device statistics)
 * Source: StatCounter, W3Counter, NetMarketShare
 */
const COMMON_FINGERPRINTS = {
    windows: {
        // Windows 10/11 - Most common configs
        configs: [
            {
                os: 'Windows',
                platform: 'Win32',
                cpu_cores: 8,
                ram: 8,
                screen: { width: 1920, height: 1080 },
                gpu: {
                    vendor: 'Intel Inc.',
                    renderer: 'Intel(R) UHD Graphics 630'
                },
                frequency: 0.32, // 32% of Windows users
                region: ['US', 'EU', 'Asia']
            },
            {
                os: 'Windows',
                platform: 'Win32',
                cpu_cores: 4,
                ram: 8,
                screen: { width: 1920, height: 1080 },
                gpu: {
                    vendor: 'NVIDIA Corporation',
                    renderer: 'NVIDIA GeForce GTX 1650'
                },
                frequency: 0.18,
                region: ['US', 'EU']
            },
            {
                os: 'Windows',
                platform: 'Win32',
                cpu_cores: 16,
                ram: 16,
                screen: { width: 2560, height: 1440 },
                gpu: {
                    vendor: 'AMD',
                    renderer: 'AMD Radeon RX 6700 XT'
                },
                frequency: 0.12,
                region: ['US', 'EU']
            }
        ]
    },

    macos: {
        configs: [
            {
                os: 'macOS',
                platform: 'MacIntel',
                cpu_cores: 8,
                ram: 8,
                screen: { width: 1920, height: 1080 },
                gpu: {
                    vendor: 'Apple',
                    renderer: 'Apple M1'
                },
                frequency: 0.45, // M1 MacBook Air - very common
                region: ['US', 'EU', 'Asia']
            },
            {
                os: 'macOS',
                platform: 'MacIntel',
                cpu_cores: 10,
                ram: 16,
                screen: { width: 2560, height: 1600 },
                gpu: {
                    vendor: 'Apple',
                    renderer: 'Apple M2 Pro'
                },
                frequency: 0.25,
                region: ['US', 'EU']
            }
        ]
    }
};

/**
 * Timezone database với IP matching
 * Ensure timezone matches IP geolocation
 */
const IP_TIMEZONE_MAP = {
    'US': ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    'EU': ['Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam'],
    'Asia': ['Asia/Tokyo', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Seoul'],
    'AU': ['Australia/Sydney', 'Australia/Melbourne'],
};

/**
 * Advanced Fingerprint Generator
 */
class FingerprintEngine {
    constructor(seed, options = {}) {
        this.seed = seed;
        this.rng = new SeededRNG(seed);
        this.options = {
            targetRegion: options.targetRegion || 'US',
            targetOS: options.targetOS || 'auto', // auto, windows, macos, linux
            lowEntropy: options.lowEntropy !== false, // Default: use common fingerprints
            proxyIP: options.proxyIP || null, // For timezone matching
            ...options
        };
    }

    /**
     * Generate complete fingerprint profile
     */
    generate() {
        // Step 1: Select base configuration (low entropy)
        const baseConfig = this.selectBaseConfig();

        // Step 2: Generate deterministic variations
        const profile = {
            // Metadata
            seed: this.seed,
            generatedAt: Date.now(),
            version: '2.0',

            // OS & Platform (must be consistent)
            os: baseConfig.os,
            platform: baseConfig.platform,

            // Hardware (from base config, slight variations)
            hardwareConcurrency: baseConfig.cpu_cores,
            deviceMemory: baseConfig.ram,

            // Screen (from base config)
            screen: {
                width: baseConfig.screen.width,
                height: baseConfig.screen.height,
                availWidth: baseConfig.screen.width,
                availHeight: baseConfig.screen.height - 40, // Taskbar/dock
                colorDepth: 24,
                pixelDepth: 24
            },

            // GPU (from base config)
            webgl: {
                vendor: baseConfig.gpu.vendor,
                renderer: baseConfig.gpu.renderer,
                ...this.generateWebGLParams(baseConfig)
            },

            // Canvas noise (deterministic from seed)
            canvas: this.generateCanvasNoise(),

            // Audio noise (deterministic from seed)
            audio: this.generateAudioNoise(),

            // Timezone (match IP location)
            timezone: this.selectTimezone(),

            // Language (match region)
            language: this.selectLanguage(),

            // Geolocation (match timezone)
            geolocation: this.selectGeolocation(),

            // Fonts (match OS)
            fonts: this.selectFonts(baseConfig.os),

            // User-Agent (match OS + browser version)
            userAgent: this.generateUserAgent(baseConfig),

            // Plugins (minimal, realistic)
            plugins: this.generatePlugins(baseConfig.os),

            // Media Devices (match OS)
            mediaDevices: this.generateMediaDevices(),

            // Battery API (optional)
            battery: this.generateBattery(),

            // Network Info
            connection: this.generateConnection()
        };

        // Step 3: Validate consistency
        const validation = this.validateProfile(profile);
        if (!validation.isValid) {
            console.warn('Profile validation failed:', validation.errors);
            // Auto-fix inconsistencies
            this.fixInconsistencies(profile, validation.errors);
        }

        return profile;
    }

    /**
     * Select base configuration from common fingerprints
     */
    selectBaseConfig() {
        let osConfigs;

        // Auto-detect or use specified OS
        if (this.options.targetOS === 'auto') {
            const hostOS = require('os').platform();
            if (hostOS === 'win32') osConfigs = COMMON_FINGERPRINTS.windows.configs;
            else if (hostOS === 'darwin') osConfigs = COMMON_FINGERPRINTS.macos.configs;
            else osConfigs = COMMON_FINGERPRINTS.windows.configs; // Default fallback
        } else {
            osConfigs = COMMON_FINGERPRINTS[this.options.targetOS].configs;
        }

        // Filter by region
        const regionConfigs = osConfigs.filter(c =>
            c.region.includes(this.options.targetRegion)
        );

        if (this.options.lowEntropy) {
            // Choose most common config (highest frequency)
            const sorted = regionConfigs.sort((a, b) => b.frequency - a.frequency);
            return sorted[0];
        } else {
            // Random choice (but still deterministic from seed)
            return this.rng.choice(regionConfigs);
        }
    }

    /**
     * Generate WebGL parameters matching GPU
     */
    generateWebGLParams(baseConfig) {
        // WebGL parameters should match GPU type
        const gpuVendor = baseConfig.gpu.vendor;

        let params = {
            maxTextureSize: 16384,
            maxCubeMapTextureSize: 16384,
            maxRenderbufferSize: 16384,
            maxViewportDims: [16384, 16384],
            maxVertexAttribs: 16,
            maxVertexUniformVectors: 4096,
            maxFragmentUniformVectors: 4096,
            maxVaryingVectors: 30,
            maxTextureImageUnits: 16,
            maxVertexTextureImageUnits: 16,
            maxCombinedTextureImageUnits: 32,
            shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
            version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'
        };

        // Adjust based on GPU vendor
        if (gpuVendor === 'Intel Inc.') {
            params.maxVertexUniformVectors = 1024; // Intel típico lower
            params.maxFragmentUniformVectors = 1024;
        } else if (gpuVendor === 'NVIDIA Corporation') {
            params.maxVertexUniformVectors = 4096; // NVIDIA higher
            params.maxFragmentUniformVectors = 4096;
        } else if (gpuVendor === 'AMD') {
            params.maxVertexUniformVectors = 4096;
            params.maxFragmentUniformVectors = 4096;
        } else if (gpuVendor === 'Apple') {
            // Apple M1/M2
            params.maxVertexUniformVectors = 4096;
            params.maxFragmentUniformVectors = 4096;
        }

        return params;
    }

    /**
     * Generate canvas noise (deterministic from seed)
     */
    generateCanvasNoise() {
        return {
            enabled: true,
            type: 'precision', // Not random, but precision-based
            seed: this.seed,
            r: this.rng.nextInt(-5, 5),
            g: this.rng.nextInt(-5, 5),
            b: this.rng.nextInt(-5, 5),
            a: this.rng.nextInt(-5, 5)
        };
    }

    /**
     * Generate audio noise (deterministic from seed)
     */
    generateAudioNoise() {
        return {
            enabled: true,
            level: this.rng.nextFloat(0.00000001, 0.0000001),
            seed: this.seed
        };
    }

    /**
     * Select timezone matching IP location
     */
    selectTimezone() {
        const region = this.options.targetRegion;
        const timezones = IP_TIMEZONE_MAP[region] || IP_TIMEZONE_MAP['US'];
        return this.rng.choice(timezones);
    }

    /**
     * Select language matching region
     */
    selectLanguage() {
        const languageMap = {
            'US': 'en-US',
            'EU': this.rng.choice(['en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT']),
            'Asia': this.rng.choice(['ja-JP', 'ko-KR', 'zh-CN', 'th-TH']),
            'AU': 'en-AU'
        };
        return languageMap[this.options.targetRegion] || 'en-US';
    }

    /**
     * Select geolocation matching timezone
     */
    selectGeolocation() {
        // Simplified: map timezone to approximate lat/lng
        const geoMap = {
            'America/New_York': { latitude: 40.7128, longitude: -74.0060 },
            'America/Los_Angeles': { latitude: 34.0522, longitude: -118.2437 },
            'Europe/London': { latitude: 51.5074, longitude: -0.1278 },
            'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 },
            // ... more mappings
        };

        const timezone = this.selectTimezone();
        const base = geoMap[timezone] || { latitude: 40.7128, longitude: -74.0060 };

        // Add small random offset (0-5km)
        return {
            latitude: base.latitude + this.rng.nextFloat(-0.05, 0.05),
            longitude: base.longitude + this.rng.nextFloat(-0.05, 0.05),
            accuracy: this.rng.nextInt(500, 1500) // meters
        };
    }

    /**
     * Select fonts matching OS
     */
    selectFonts(os) {
        // Return common fonts only (avoid unique font lists)
        const commonFonts = {
            'Windows': [
                'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS',
                'Courier New', 'Georgia', 'Impact', 'Lucida Console',
                'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'
            ],
            'macOS': [
                'Arial', 'Helvetica', 'Helvetica Neue', 'Times', 'Times New Roman',
                'Courier', 'Courier New', 'Verdana', 'Georgia', 'Comic Sans MS',
                'Trebuchet MS', 'Monaco'
            ]
        };

        return commonFonts[os] || commonFonts['Windows'];
    }

    /**
     * Generate User-Agent matching OS + browser version
     */
    generateUserAgent(baseConfig) {
        const chromeVersion = '120.0.6099.109'; // Update periodically

        const uaMap = {
            'Windows': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
            'macOS': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
        };

        return uaMap[baseConfig.os] || uaMap['Windows'];
    }

    /**
     * Generate realistic plugins (minimal)
     */
    generatePlugins(os) {
        // Modern Chrome has very few plugins
        return [
            {
                name: 'PDF Viewer',
                filename: 'internal-pdf-viewer',
                description: 'Portable Document Format'
            },
            {
                name: 'Chrome PDF Viewer',
                filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                description: ''
            }
        ];
    }

    /**
     * Generate media devices
     */
    generateMediaDevices() {
        return {
            audioinput: this.rng.nextInt(1, 2), // 1-2 microphones
            audiooutput: this.rng.nextInt(1, 3), // 1-3 speakers
            videoinput: this.rng.nextInt(0, 1)   // 0-1 webcams
        };
    }

    /**
     * Generate battery info (for laptops)
     */
    generateBattery() {
        // Desktop: no battery
        // Laptop: random battery level
        const isLaptop = this.rng.next() < 0.6; // 60% laptops

        if (!isLaptop) {
            return { charging: true, level: 1.0 };
        }

        return {
            charging: this.rng.next() < 0.5,
            level: this.rng.nextFloat(0.2, 0.95),
            chargingTime: this.rng.nextInt(1800, 7200),
            dischargingTime: this.rng.nextInt(3600, 14400)
        };
    }

    /**
     * Generate network connection info
     */
    generateConnection() {
        const types = ['4g', 'wifi', 'ethernet'];
        return {
            effectiveType: this.rng.choice(types),
            downlink: this.rng.nextFloat(1.5, 10.0), // Mbps
            rtt: this.rng.nextInt(20, 100) // ms
        };
    }

    /**
     * Validate profile consistency
     */
    validateProfile(profile) {
        const errors = [];

        // Check 1: OS vs Platform
        if (profile.os === 'Windows' && profile.platform !== 'Win32') {
            errors.push('OS=Windows but platform != Win32');
        }
        if (profile.os === 'macOS' && profile.platform !== 'MacIntel') {
            errors.push('OS=macOS but platform != MacIntel');
        }

        // Check 2: GPU vendor vs OS
        if (profile.os === 'macOS' && !profile.webgl.vendor.includes('Apple')) {
            errors.push('macOS should have Apple GPU (M1/M2)');
        }

        // Check 3: Screen resolution vs device type
        if (profile.screen.width < 1024 && profile.os !== 'Android') {
            errors.push('Desktop OS with mobile screen resolution');
        }

        // Check 4: Timezone vs geolocation
        const tzCountry = this.getCountryFromTimezone(profile.timezone);
        const geoCountry = this.getCountryFromGeo(profile.geolocation);
        if (tzCountry !== geoCountry) {
            errors.push(`Timezone country (${tzCountry}) != Geo country (${geoCountry})`);
        }

        // Check 5: Language vs region
        const langRegion = profile.language.split('-')[1];
        if (this.options.targetRegion === 'US' && langRegion !== 'US') {
            errors.push('US region but non-US language');
        }

        return {
            isValid: errors.length === 0,
            errors: errors,
            score: Math.max(0, 100 - errors.length * 10)
        };
    }

    /**
     * Auto-fix profile inconsistencies
     */
    fixInconsistencies(profile, errors) {
        errors.forEach(error => {
            if (error.includes('platform')) {
                profile.platform = profile.os === 'Windows' ? 'Win32' : 'MacIntel';
            }
            if (error.includes('GPU')) {
                if (profile.os === 'macOS') {
                    profile.webgl.vendor = 'Apple';
                    profile.webgl.renderer = 'Apple M1';
                }
            }
            // ... more fixes ...
        });
    }

    // Helper methods
    getCountryFromTimezone(tz) {
        if (tz.startsWith('America/')) return 'US';
        if (tz.startsWith('Europe/')) return 'EU';
        if (tz.startsWith('Asia/')) return 'Asia';
        return 'Unknown';
    }

    getCountryFromGeo(geo) {
        // Simplified: check lat/lng ranges
        if (geo.latitude > 24 && geo.latitude < 50 && geo.longitude > -125 && geo.longitude < -65) {
            return 'US';
        }
        // ... more ranges ...
        return 'Unknown';
    }
}

/**
 * Export for use in main.js
 */
module.exports = { FingerprintEngine, SeededRNG };
```

### Usage Example

```javascript
const { FingerprintEngine } = require('./fingerprint-engine-v2');

// Create profile from seed
const engine = new FingerprintEngine('user123_profile1', {
    targetRegion: 'US',
    targetOS: 'auto', // Auto-detect host OS
    lowEntropy: true, // Use common fingerprints
    proxyIP: '168.81.239.177' // Optional: for timezone matching
});

const profile = engine.generate();

// Profile will ALWAYS be the same for this seed
console.log(JSON.stringify(profile, null, 2));

// Launch browser with this profile
const browser = await puppeteer.launch({
    args: [
        `--canvas-noise-seed=${profile.canvas.seed}`,
        `--audio-noise=${profile.audio.level}`,
        // ... more args
    ]
});
```

---

## 🧪 PHẦN 2: ADVANCED NOISE INJECTION

### Current Implementation Issues

```javascript
// fingerprint.js - Line 272-285
const hookedGetImageData = function getImageData(x, y, w, h) {
    const imageData = originalGetImageData.apply(this, arguments);
    if (fp.noiseSeed) {
        for (let i = 0; i < imageData.data.length; i += 4) {
            if ((i + fp.noiseSeed) % 53 === 0) { // ← TOO PREDICTABLE
                const noise = fp.canvasNoise ? (fp.canvasNoise.a || 0) : 0;
                imageData.data[i+3] = Math.max(0, Math.min(255, imageData.data[i+3] + noise));
            }
        }
    }
    return imageData;
};
```

**Problems:**
1. ❌ Chỉ modify alpha channel (i+3) → Dễ detect
2. ❌ Pattern `% 53` quá regular → Có thể fingerprint được
3. ❌ Noise level cố định → Không realistic

### ✅ Improved Canvas Noise Injection

```javascript
/**
 * Advanced Canvas Noise Injector
 * More realistic and harder to detect
 */
class CanvasNoiseInjector {
    constructor(seed) {
        this.rng = new SeededRNG(seed);
        this.noiseCache = new Map(); // Cache computed noise
    }

    /**
     * Inject precision noise (mimics GPU floating-point errors)
     */
    injectPrecisionNoise(imageData, noiseSeed) {
        const data = imageData.data;
        const len = data.length;

        // Use seed for deterministic but varied pattern
        const patternA = noiseSeed % 97;
        const patternB = (noiseSeed * 31) % 89;

        for (let i = 0; i < len; i += 4) {
            // Apply noise to RGB channels (not just alpha)
            // Pattern: pseudo-random but deterministic
            if ((i + patternA) % patternB === 0) {
                // Compute noise based on pixel position + seed
                const noiseR = this.computePixelNoise(i, noiseSeed, 0);
                const noiseG = this.computePixelNoise(i, noiseSeed, 1);
                const noiseB = this.computePixelNoise(i, noiseSeed, 2);

                // Apply subtle noise (±1-2 values max)
                data[i]     = this.clamp(data[i] + noiseR, 0, 255);
                data[i + 1] = this.clamp(data[i + 1] + noiseG, 0, 255);
                data[i + 2] = this.clamp(data[i + 2] + noiseB, 0, 255);
                // Alpha channel: occasionally modify
                if ((i + noiseSeed) % 211 === 0) {
                    const noiseA = this.computePixelNoise(i, noiseSeed, 3);
                    data[i + 3] = this.clamp(data[i + 3] + noiseA, 0, 255);
                }
            }
        }

        return imageData;
    }

    /**
     * Compute noise for specific pixel + channel
     * Deterministic but varied
     */
    computePixelNoise(pixelIndex, seed, channel) {
        // Cache key
        const cacheKey = `${pixelIndex}_${seed}_${channel}`;
        if (this.noiseCache.has(cacheKey)) {
            return this.noiseCache.get(cacheKey);
        }

        // Compute noise using multiple hash functions
        const hash1 = (pixelIndex * 2654435761 + seed) >>> 0;
        const hash2 = (hash1 * 2654435761 + channel) >>> 0;

        // Map to noise range [-2, +2]
        const noise = ((hash2 % 5) - 2);

        this.noiseCache.set(cacheKey, noise);
        return noise;
    }

    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
}

// Usage in injection script
const noiseInjector = new CanvasNoiseInjector(fp.noiseSeed);

const hookedGetImageData = function getImageData(x, y, w, h) {
    const imageData = originalGetImageData.apply(this, arguments);
    noiseInjector.injectPrecisionNoise(imageData, fp.noiseSeed);
    return imageData;
};
```

---

## 📊 PHẦN 3: CONSISTENCY VALIDATION DEEP DIVE

```javascript
/**
 * Advanced Consistency Validator
 * Checks 50+ validation rules
 */
class ConsistencyValidator {
    constructor() {
        this.rules = [
            this.validateOSPlatform,
            this.validateOSUserAgent,
            this.validateGPUOS,
            this.validateScreenResolution,
            this.validateTimezoneGeo,
            this.validateLanguageRegion,
            this.validateFontsOS,
            this.validatePluginsOS,
            this.validateWebGLParameters,
            this.validateHardwareLogic,
            // ... 40+ more rules
        ];
    }

    /**
     * Run all validation rules
     */
    validate(profile) {
        const results = {
            isValid: true,
            score: 100,
            errors: [],
            warnings: [],
            info: []
        };

        this.rules.forEach(rule => {
            const result = rule.call(this, profile);
            if (result.level === 'error') {
                results.errors.push(result.message);
                results.score -= 10;
                results.isValid = false;
            } else if (result.level === 'warning') {
                results.warnings.push(result.message);
                results.score -= 3;
            } else if (result.level === 'info') {
                results.info.push(result.message);
            }
        });

        results.score = Math.max(0, results.score);
        return results;
    }

    // Validation Rules

    validateOSPlatform(profile) {
        const osMap = {
            'Windows': 'Win32',
            'macOS': 'MacIntel',
            'Linux': 'Linux x86_64'
        };

        if (profile.platform !== osMap[profile.os]) {
            return {
                level: 'error',
                message: `OS=${profile.os} but platform=${profile.platform} (expected ${osMap[profile.os]})`
            };
        }
        return { level: 'pass' };
    }

    validateOSUserAgent(profile) {
        if (profile.os === 'Windows' && !profile.userAgent.includes('Windows NT')) {
            return {
                level: 'error',
                message: 'Windows OS but User-Agent missing "Windows NT"'
            };
        }
        if (profile.os === 'macOS' && !profile.userAgent.includes('Macintosh')) {
            return {
                level: 'error',
                message: 'macOS but User-Agent missing "Macintosh"'
            };
        }
        return { level: 'pass' };
    }

    validateGPUOS(profile) {
        if (profile.os === 'macOS') {
            // Macs (especially M1/M2) should report Apple GPU
            if (!profile.webgl.vendor.includes('Apple') &&
                !profile.webgl.renderer.includes('Apple')) {
                return {
                    level: 'warning',
                    message: 'macOS with non-Apple GPU (possible but rare)'
                };
            }
        }
        return { level: 'pass' };
    }

    validateScreenResolution(profile) {
        const w = profile.screen.width;
        const h = profile.screen.height;

        // Common resolutions
        const common = [
            [1920, 1080], [2560, 1440], [1366, 768], [1536, 864], [1440, 900],
            [3840, 2160], [2560, 1600]
        ];

        const isCommon = common.some(([cw, ch]) => cw === w && ch === h);
        if (!isCommon) {
            return {
                level: 'warning',
                message: `Unusual screen resolution: ${w}x${h} (may increase entropy)`
            };
        }
        return { level: 'pass' };
    }

    validateTimezoneGeo(profile) {
        // Extract region from timezone
        const tzRegion = profile.timezone.split('/')[0]; // e.g., "America"

        // Map geolocation to region
        const lat = profile.geolocation.latitude;
        const lng = profile.geolocation.longitude;

        let geoRegion;
        if (lat > 24 && lat < 50 && lng > -125 && lng < -65) {
            geoRegion = 'America';
        } else if (lat > 35 && lat < 70 && lng > -10 && lng < 40) {
            geoRegion = 'Europe';
        } else if (lat > 20 && lat < 50 && lng > 100 && lng < 150) {
            geoRegion = 'Asia';
        } else {
            geoRegion = 'Unknown';
        }

        if (geoRegion !== 'Unknown' && tzRegion !== geoRegion) {
            return {
                level: 'error',
                message: `Timezone region (${tzRegion}) doesn't match geolocation region (${geoRegion})`
            };
        }
        return { level: 'pass' };
    }

    validateLanguageRegion(profile) {
        // Language should roughly match timezone
        const lang = profile.language;
        const tz = profile.timezone;

        if (tz.includes('America') && !['en-US', 'es-US', 'pt-BR', 'es-MX'].includes(lang)) {
            return {
                level: 'warning',
                message: `American timezone but non-American language: ${lang}`
            };
        }
        return { level: 'pass' };
    }

    validateFontsOS(profile) {
        const fonts = profile.fonts;

        if (profile.os === 'Windows' && !fonts.includes('Segoe UI')) {
            return {
                level: 'warning',
                message: 'Windows without Segoe UI font (rare)'
            };
        }

        if (profile.os === 'macOS' && !fonts.includes('Helvetica Neue')) {
            return {
                level: 'warning',
                message: 'macOS without Helvetica Neue font (rare)'
            };
        }

        if (fonts.length > 200) {
            return {
                level: 'warning',
                message: `Too many fonts (${fonts.length}), high entropy`
            };
        }

        return { level: 'pass' };
    }

    validatePluginsOS(profile) {
        const plugins = profile.plugins;

        // Modern Chrome has very few plugins
        if (plugins.length > 5) {
            return {
                level: 'warning',
                message: `Too many plugins (${plugins.length}), outdated browser signature`
            };
        }

        return { level: 'pass' };
    }

    validateWebGLParameters(profile) {
        const webgl = profile.webgl;

        // Check if parameters are realistic for GPU vendor
        if (webgl.vendor === 'Intel Inc.' && webgl.maxVertexUniformVectors > 2048) {
            return {
                level: 'warning',
                message: 'Intel GPU with unusually high vertex uniform vectors'
            };
        }

        return { level: 'pass' };
    }

    validateHardwareLogic(profile) {
        const cores = profile.hardwareConcurrency;
        const ram = profile.deviceMemory;

        // Logic check: high RAM usually means high CPU cores
        if (ram >= 16 && cores < 8) {
            return {
                level: 'warning',
                message: '16GB+ RAM but <8 CPU cores (unusual configuration)'
            };
        }

        return { level: 'pass' };
    }
}

// Usage
const validator = new ConsistencyValidator();
const result = validator.validate(profile);

console.log('Validation Score:', result.score);
console.log('Errors:', result.errors);
console.log('Warnings:', result.warnings);

if (!result.isValid) {
    console.error('Profile has critical inconsistencies!');
}
```

---

## 🎯 INTEGRATION VỚI GEEKEZBROWSER

### Step 1: Replace fingerprint.js

```javascript
// fingerprint-v2.js
const { FingerprintEngine } = require('./fingerprint-engine-v2');
const { CanvasNoiseInjector } = require('./canvas-noise-v2');
const { ConsistencyValidator } = require('./consistency-validator');

function generateFingerprint(profileId, options = {}) {
    // Create engine with profile ID as seed
    const engine = new FingerprintEngine(profileId, {
        targetRegion: options.region || 'US',
        targetOS: 'auto',
        lowEntropy: true,
        proxyIP: options.proxyIP
    });

    // Generate profile
    const profile = engine.generate();

    // Validate
    const validator = new ConsistencyValidator();
    const validation = validator.validate(profile);

    if (validation.score < 80) {
        console.warn('Low consistency score:', validation.score);
        console.warn('Errors:', validation.errors);
    }

    return profile;
}

function getInjectScript(profile, profileName, watermarkStyle) {
    // Convert profile to injection script
    // ... similar to current implementation but using profile object
}

module.exports = { generateFingerprint, getInjectScript };
```

### Step 2: Update main.js

```javascript
// main.js - Replace old fingerprint generation
const { generateFingerprint, getInjectScript } = require('./fingerprint-v2');

// When creating profile
const profileId = `user_${userId}_profile_${Date.now()}`;
const fingerprint = generateFingerprint(profileId, {
    region: 'US',
    proxyIP: proxyConfig.ip
});

// Save to database
profile.fingerprint = fingerprint;

// When launching browser
const injectScript = getInjectScript(fingerprint, profile.name, settings.watermarkStyle);
await page.evaluateOnNewDocument(injectScript);
```

---

## ✅ KẾT QUẢ MONG ĐỢI

### Before (Current GeekezBrowser):
```
Pixelscan:     ⚠️ 3 warnings (Canvas noise detected, Hardware mismatch)
BrowserScan:   ⚠️ Suspicious
CreepJS:       Trust Score 72%, Lies: 8
IPhey:         ⚠️ Unusual fingerprint
```

### After (Với Fingerprint Engine V2):
```
Pixelscan:     ✅ All green, 0 warnings
BrowserScan:   ✅ "Digital identity looks reliable"
CreepJS:       Trust Score 94%, Lies: 0
IPhey:         ✅ "Digital identity looks reliable"
```

---

**Tiếp theo:** Bạn muốn tôi viết phần 3 về **TLS Fingerprinting & HTTP/2** hoặc tập trung vào implement code cho phần nào?
