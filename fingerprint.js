const os = require('os');

// dpr = devicePixelRatio — must be consistent with resolution to avoid Pixelscan "2049x1152" bug
// (Pixelscan computes physical pixels = screen.width * devicePixelRatio)
const RESOLUTIONS = [
    { w: 1920, h: 1080, dpr: 1   },
    { w: 2560, h: 1440, dpr: 1.25 },
    { w: 1366, h: 768,  dpr: 1   },
    { w: 1536, h: 864,  dpr: 1.25 },
    { w: 1440, h: 900,  dpr: 1   }
];

// Simple seeded PRNG for Node.js side (mulberry32)
function makePRNG(seed) {
    let s = seed >>> 0;
    return function() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Generate deterministic hex string (64 chars) from seed + index
function seedToHex64(seed, index) {
    const prng = makePRNG((seed ^ (index * 0x9e3779b9)) >>> 0);
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += ('00000000' + Math.floor(prng() * 0xffffffff).toString(16)).slice(-8);
    }
    return result;
}

// Common WebGL params (same across GPU tiers) — WebGL constant numbers as keys
// Values verified against real GPM profile data (AMD Radeon / Chrome 144 on Windows)
const COMMON_GL_PARAMS = {
    34921: 16,          // MAX_VERTEX_ATTRIBS
    36347: 4096,        // MAX_VERTEX_UNIFORM_VECTORS (WebGL2 — was wrong: 256)
    36348: 30,          // MAX_VARYING_VECTORS (WebGL2 — was wrong: 15)
    35661: 32,          // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    35660: 16,          // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    34930: 16,          // MAX_TEXTURE_IMAGE_UNITS
    36349: 1024,        // MAX_FRAGMENT_UNIFORM_VECTORS (WebGL2 — was wrong: 224)
    33001: 16777215,    // MAX_ELEMENTS_INDICES
    33000: 1048575,     // MAX_ELEMENTS_VERTICES
    33902: [1, 1],      // ALIASED_LINE_WIDTH_RANGE
    33901: [1, 1024],   // ALIASED_POINT_SIZE_RANGE (was wrong: 255.875)
    3386:  [32767, 32767], // MAX_VIEWPORT_DIMS (was missing)
    // WebGL2
    35375: 24,          // MAX_UNIFORM_BUFFER_BINDINGS
    35374: 24,          // MAX_COMBINED_UNIFORM_BLOCKS
    35978: 120,         // MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS (was wrong: 64)
    35979: 4,           // MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS
    // Additional WebGL2 params from real GPM data
    34848: 4096,        // MAX_VERTEX_UNIFORM_COMPONENTS
    35657: 4096,        // MAX_FRAGMENT_UNIFORM_COMPONENTS
    36318: 120,         // MAX_VARYING_COMPONENTS
    36204: 120,         // MAX_FRAGMENT_INPUT_COMPONENTS
    36203: 120,         // MAX_VERTEX_OUTPUT_COMPONENTS
    35071: 2048,        // MAX_ARRAY_TEXTURE_LAYERS
    34076: 16384,       // MAX_CUBE_MAP_TEXTURE_SIZE (common for most GPUs)
    35659: 12,          // MAX_FRAGMENT_UNIFORM_BLOCKS
    35371: 12,          // MAX_VERTEX_UNIFORM_BLOCKS
    35658: 65536,       // MAX_UNIFORM_BLOCK_SIZE
    35659: 12,          // MAX_FRAGMENT_UNIFORM_BLOCKS
    35660: 16,          // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    33984: 0,           // ACTIVE_TEXTURE
    36185: 256,         // UNIFORM_BUFFER_OFFSET_ALIGNMENT
    34016: 8,           // ALPHA_BITS
    34017: 8,           // BLUE_BITS
    34055: 24,          // DEPTH_BITS
    34018: 8,           // GREEN_BITS
    34019: 8,           // RED_BITS
    34020: 8            // STENCIL_BITS
};

// GPU presets by platform — vendor/renderer match real Chrome ANGLE output
const GPU_PRESETS = {
    win32: [
        {
            webgl: {
                vendor: 'Google Inc. (Intel)',
                renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
            },
            webgpu: {
                info: { vendor: 'intel', architecture: 'gen-9.5', device: '0x5917', description: '', vendorID: '0x8086', deviceID: '0x5917' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable']
            },
            glParams: { 3379: 16384, 34076: 16384, 34024: 16384, 36638: 4, 36063: 4, 36183: 8, 32883: 2048, 35071: 2048 }
        },
        {
            webgl: {
                vendor: 'Google Inc. (Intel)',
                renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'
            },
            webgpu: {
                info: { vendor: 'intel', architecture: 'gen-12lp', device: '0x9a49', description: '', vendorID: '0x8086', deviceID: '0x9a49' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'clip-distances', 'dual-source-blending']
            },
            glParams: { 3379: 32768, 34076: 32768, 34024: 32768, 36638: 8, 36063: 8, 36183: 16, 32883: 2048, 35071: 2048 }
        },
        {
            webgl: {
                vendor: 'Google Inc. (NVIDIA Corporation)',
                renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'
            },
            webgpu: {
                info: { vendor: 'nvidia', architecture: 'turing', device: '0x1f82', description: '', vendorID: '0x10de', deviceID: '0x1f82' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'clip-distances', 'dual-source-blending']
            },
            glParams: { 3379: 32768, 34076: 32768, 34024: 32768, 36638: 8, 36063: 8, 36183: 32, 32883: 16384, 35071: 2048 }
        },
        {
            webgl: {
                vendor: 'Google Inc. (NVIDIA Corporation)',
                renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
            },
            webgpu: {
                info: { vendor: 'nvidia', architecture: 'ampere', device: '0x2503', description: '', vendorID: '0x10de', deviceID: '0x2503' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'clip-distances', 'dual-source-blending']
            },
            glParams: { 3379: 32768, 34076: 32768, 34024: 32768, 36638: 8, 36063: 8, 36183: 32, 32883: 16384, 35071: 2048 }
        },
        {
            webgl: {
                vendor: 'Google Inc. (AMD)',
                renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
                // Extensions verified from real GPM profile (Chrome 144, Windows 11, AMD)
                extensions: ['EXT_clip_control','EXT_color_buffer_float','EXT_color_buffer_half_float','EXT_conservative_depth','EXT_depth_clamp','EXT_disjoint_timer_query_webgl2','EXT_float_blend','EXT_polygon_offset_clamp','EXT_render_snorm','EXT_texture_compression_bptc','EXT_texture_compression_rgtc','EXT_texture_filter_anisotropic','EXT_texture_mirror_clamp_to_edge','EXT_texture_norm16','KHR_parallel_shader_compile','NV_shader_noperspective_interpolation','OES_draw_buffers_indexed','OES_sample_variables','OES_shader_multisample_interpolation','OES_texture_float_linear','OVR_multiview2','WEBGL_blend_func_extended','WEBGL_clip_cull_distance','WEBGL_compressed_texture_s3tc','WEBGL_compressed_texture_s3tc_srgb','WEBGL_debug_renderer_info','WEBGL_debug_shaders','WEBGL_lose_context','WEBGL_multi_draw','WEBGL_polygon_mode','WEBGL_provoking_vertex','WEBGL_stencil_texturing']
            },
            webgpu: {
                info: { vendor: 'amd', architecture: 'rdna-2', device: '0x1681', description: '', vendorID: '0x1002', deviceID: '0x1681' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'clip-distances', 'dual-source-blending']
            },
            glParams: { 3379: 16384, 34076: 16384, 34024: 16384, 36638: 8, 36063: 8, 36183: 8, 32883: 2048, 35071: 2048 }
        }
    ],
    darwin: [
        {
            webgl: { vendor: 'Apple Inc.', renderer: 'Apple M1' },
            webgpu: {
                info: { vendor: 'apple', architecture: 'common-3', device: '', description: '', vendorID: '0x106b', deviceID: '0xa140' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'dual-source-blending']
            },
            glParams: { 3379: 16384, 34076: 16384, 34024: 16384, 36638: 8, 36063: 8, 36183: 8, 32883: 2048, 35071: 2048 }
        },
        {
            webgl: { vendor: 'Apple Inc.', renderer: 'Apple M2' },
            webgpu: {
                info: { vendor: 'apple', architecture: 'common-3', device: '', description: '', vendorID: '0x106b', deviceID: '0xa132' },
                features: ['depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'dual-source-blending']
            },
            glParams: { 3379: 16384, 34076: 16384, 34024: 16384, 36638: 8, 36063: 8, 36183: 8, 32883: 2048, 35071: 2048 }
        }
    ],
    linux: [
        {
            webgl: {
                vendor: 'Google Inc. (Intel Open Source Technology Center)',
                renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'
            },
            webgpu: {
                info: { vendor: 'intel', architecture: 'gen-9.5', device: '0x5917', description: '', vendorID: '0x8086', deviceID: '0x5917' },
                features: ['depth-clip-control', 'texture-compression-bc', 'indirect-first-instance', 'bgra8unorm-storage']
            },
            glParams: { 3379: 16384, 34076: 16384, 34024: 16384, 36638: 4, 36063: 4, 36183: 8, 32883: 2048, 35071: 2048 }
        }
    ]
};

// WebGPU limits by GPU tier (integrated vs discrete)
const WEBGPU_LIMITS_INTEGRATED = {
    maxTextureDimension1D: 16384, maxTextureDimension2D: 16384, maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 2048, maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4, maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesPerShaderStage: 4, maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536, maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 32,
    maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 16,
    maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 512,
    maxComputeWorkgroupSizeX: 512, maxComputeWorkgroupSizeY: 512, maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535
};

const WEBGPU_LIMITS_DISCRETE = {
    maxTextureDimension1D: 32768, maxTextureDimension2D: 32768, maxTextureDimension3D: 16384,
    maxTextureArrayLayers: 2048, maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4, maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesPerShaderStage: 4, maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536, maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 32,
    maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 16,
    maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 49152, maxComputeInvocationsPerWorkgroup: 1024,
    maxComputeWorkgroupSizeX: 1024, maxComputeWorkgroupSizeY: 1024, maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535
};

function generateFingerprint() {
    const platform = os.platform();
    const arch = os.arch();

    let osData = {};
    if (platform === 'win32') {
        osData = { platform: 'Win32' };
    } else if (platform === 'darwin') {
        osData = { platform: 'MacIntel', isArm: arch === 'arm64' };
    } else {
        osData = { platform: 'Linux x86_64' };
    }

    const res = RESOLUTIONS[Math.floor(Math.random() * RESOLUTIONS.length)];
    const noiseSeed = Math.floor(Math.random() * 99999999) + 1;
    const prng = makePRNG(noiseSeed);

    // Pick GPU preset based on host OS
    const gpuPool = GPU_PRESETS[platform] || GPU_PRESETS.linux;
    const gpuPreset = gpuPool[Math.floor(prng() * gpuPool.length)];

    // Determine WebGPU limits tier
    const isDiscrete = gpuPreset.webgpu.info.vendor === 'nvidia' || gpuPreset.webgpu.info.vendor === 'amd';
    const webgpuLimits = isDiscrete ? WEBGPU_LIMITS_DISCRETE : WEBGPU_LIMITS_INTEGRATED;

    // Merge GPU-specific params with common params
    const mergedGlParams = Object.assign({}, COMMON_GL_PARAMS, gpuPreset.glParams);

    // Build mediaDevices list deterministically from noiseSeed
    const mediaDevices = buildMediaDevices(platform, noiseSeed);

    return {
        platform: osData.platform,
        screen: { width: res.w, height: res.h },
        window: { width: res.w, height: res.h },
        languages: ['en-US', 'en'],
        hardwareConcurrency: [4, 8, 12, 16][Math.floor(prng() * 4)],
        deviceMemory: [4, 8][Math.floor(prng() * 2)],
        canvasNoise: { r: Math.floor(prng() * 5) - 2, g: Math.floor(prng() * 5) - 2, b: Math.floor(prng() * 5) - 2 },
        audioNoise: (prng() * 0.000001 + 0.0000001),
        noiseSeed,
        devicePixelRatio: res.dpr,
        timezone: 'America/Los_Angeles',
        webgl: {
            vendor: gpuPreset.webgl.vendor,
            renderer: gpuPreset.webgl.renderer,
            params: mergedGlParams
        },
        webgpu: {
            info: gpuPreset.webgpu.info,
            features: gpuPreset.webgpu.features,
            limits: webgpuLimits
        },
        mediaDevices
    };
}

function buildMediaDevices(platform, seed) {
    const grp1 = seedToHex64(seed, 100); // audio group
    const grp2 = seedToHex64(seed, 101); // video group

    const audioLabels = platform === 'darwin'
        ? { input: 'MacBook Pro Microphone', output: 'MacBook Pro Speakers' }
        : { input: 'Microphone (Realtek High Definition Audio)', output: 'Speakers (Realtek High Definition Audio)' };
    const videoLabel = platform === 'darwin' ? 'FaceTime HD Camera' : 'Integrated Camera';

    return [
        { deviceId: seedToHex64(seed, 1), groupId: grp1, kind: 'audioinput',  label: audioLabels.input },
        { deviceId: seedToHex64(seed, 2), groupId: grp1, kind: 'audiooutput', label: audioLabels.output },
        { deviceId: seedToHex64(seed, 3), groupId: grp2, kind: 'videoinput',  label: videoLabel }
    ];
}

function getInjectScript(fp, profileName, watermarkStyle) {
    const fpJson = JSON.stringify(fp);
    const safeProfileName = (profileName || 'Profile').replace(/[<>"'&]/g, '');
    const style = watermarkStyle || 'enhanced';
    return `
    (function() {
        try {
            const fp = ${fpJson};
            const targetTimezone = fp.timezone || "America/Los_Angeles";

            // --- Global Helper: makeNative ---
            // Correct approach: override Function.prototype.toString globally with WeakMap registry.
            // This defeats Function.prototype.toString.call(fn) checks used by Pixelscan and
            // other fingerprint detectors — simply setting fn.toString does NOT defeat those checks.
            const _nativeRegistry = new WeakMap();
            const _origFPToString = Function.prototype.toString;

            Object.defineProperty(Function.prototype, 'toString', {
                value: function toString() {
                    if (_nativeRegistry.has(this)) {
                        return _nativeRegistry.get(this);
                    }
                    return _origFPToString.call(this);
                },
                writable: true,
                enumerable: false,
                configurable: true
            });
            // Register our patched toString itself as native so toString.call(toString) passes
            _nativeRegistry.set(Function.prototype.toString, 'function toString() { [native code] }');

            const makeNative = (func, name) => {
                _nativeRegistry.set(func, 'function ' + name + '() { [native code] }');
                // Native prototype methods have no .prototype — delete it to match
                try { delete func.prototype; } catch(e) {}
                return func;
            };

            // --- Seeded PRNG (xoshiro128** variant) for deterministic noise ---
            // Ensures same profile always produces identical fingerprint
            (function() {
                let s = (fp.noiseSeed || 12345) >>> 0;
                fp._prngNext = function() {
                    s = (s + 0x6D2B79F5) >>> 0;
                    let t = Math.imul(s ^ (s >>> 15), 1 | s);
                    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                };
            })();

            // Deterministic pixel noise: hash seed + pixel index -> noise value in [-1, 0, 1]
            const pixelNoise = (seed, idx, channel) => {
                let h = ((seed >>> 0) ^ (Math.imul(idx + 1, 2654435761 + channel * 1234567) >>> 0)) >>> 0;
                h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
                h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
                return (h % 3) - 1; // -1, 0, or 1
            };

            // --- Timezone ---
            // Handled via CDP Emulation / TZ env var — no JS hooks needed

            // --- 1. Remove WebDriver / Puppeteer artifacts ---
            if (navigator.webdriver) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            }
            const cdcRegex = /cdc_[a-zA-Z0-9]+/;
            for (const key in window) {
                if (cdcRegex.test(key)) { try { delete window[key]; } catch(e) {} }
            }
            ['$cdc_asdjflasutopfhvcZLmcfl_', '$chrome_asyncScriptInfo', 'callPhantom', 'webdriver'].forEach(k => {
                if (window[k]) { try { delete window[k]; } catch(e) {} }
            });
            Object.defineProperty(window, 'chrome', {
                writable: true, enumerable: true, configurable: false,
                value: { app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }, runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } } }
            });

            // --- 2. Screen Resolution ---
            if (fp.screen && fp.screen.width) {
                const sw = fp.screen.width, sh = fp.screen.height;
                Object.defineProperty(screen, 'width',       { get: makeNative(function width()       { return sw; }, 'width'), configurable: true });
                Object.defineProperty(screen, 'height',      { get: makeNative(function height()      { return sh; }, 'height'), configurable: true });
                Object.defineProperty(screen, 'availWidth',  { get: makeNative(function availWidth()  { return sw; }, 'availWidth'), configurable: true });
                Object.defineProperty(screen, 'availHeight', { get: makeNative(function availHeight() { return sh - 40; }, 'availHeight'), configurable: true });
                Object.defineProperty(window, 'outerWidth',  { get: makeNative(function outerWidth()  { return sw; }, 'outerWidth'), configurable: true });
                Object.defineProperty(window, 'outerHeight', { get: makeNative(function outerHeight() { return sh; }, 'outerHeight'), configurable: true });
                // devicePixelRatio must match resolution — otherwise Pixelscan shows "2049x1152"
                // (it computes: physical = screen.width * devicePixelRatio)
                if (fp.devicePixelRatio) {
                    const dpr = fp.devicePixelRatio;
                    Object.defineProperty(window, 'devicePixelRatio', { get: makeNative(function devicePixelRatio() { return dpr; }, 'devicePixelRatio'), configurable: true });
                }
            }

            // --- 3. Hardware Concurrency + Device Memory — mode "real" (no hooks) ---
            // Navigator.prototype hooks don't apply to WorkerNavigator — Workers expose
            // the real CPU thread count and real deviceMemory (capped at 8 by Chrome spec).
            // A fake value (e.g. deviceMemory=16, impossible in Chrome) or wrong thread count
            // would cause a mismatch between main frame and Worker → "Masking detected".
            // Solution: let real hardware values show in all contexts (consistent).

            // --- 4. Geolocation ---
            if (fp.geolocation) {
                const { latitude, longitude } = fp.geolocation;
                const accuracy = 500 + Math.floor(fp._prngNext() * 1000);
                const fakeGCP = function getCurrentPosition(success, error, options) {
                    const pos = { coords: { latitude: latitude + (fp._prngNext() - 0.5) * 0.005, longitude: longitude + (fp._prngNext() - 0.5) * 0.005, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };
                    setTimeout(() => success(pos), 10);
                };
                const fakeWP = function watchPosition(success, error, options) { fakeGCP(success, error, options); return Math.floor(fp._prngNext() * 10000) + 1; };
                Object.defineProperty(Geolocation.prototype, 'getCurrentPosition', { value: makeNative(fakeGCP, 'getCurrentPosition'), configurable: true, writable: true });
                Object.defineProperty(Geolocation.prototype, 'watchPosition',      { value: makeNative(fakeWP, 'watchPosition'), configurable: true, writable: true });
            }

            // --- 5. Intl API — no JS hooks needed ---
            // Language: handled by --lang / --accept-lang Chrome flags (system-wide, all contexts)
            // Timezone: handled by CDP Emulation.setTimezoneOverride (V8-level, all contexts)
            // Hooking Intl.DateTimeFormat/NumberFormat/Collator via JS creates detectable
            // function.length mismatches: native Intl.DateTimeFormat.length === 0, but
            // function DateTimeFormat(l, o){}.length === 2 → detected by Pixelscan.

            // --- 6. Canvas — mode "real" (no JS hooks) ---
            // GPM/GoLogin analysis: professional anti-detect browsers use patched Chromium
            // binary for canvas spoofing, NOT JavaScript API hooks. JS hooks on fillText/
            // globalAlpha/shadowBlur are detected by Pixelscan via Web Worker comparison:
            // worker produces real GPU hash, main frame produces modified hash → mismatch
            // → "Masking detected". Solution: let canvas return real GPU output everywhere.

            // --- 7. Audio — mode "real" (no JS hooks) ---
            // Same reason as canvas: AudioWorklet runs in a separate JS realm where our
            // content script doesn't inject. If AudioBuffer.getChannelData is hooked in
            // the main frame but not in the AudioWorklet, Pixelscan detects the hash
            // mismatch between contexts → "Masking detected".
            // Solution: let audio return real hardware values everywhere (mode "real").

            // --- 8. WebRTC Protection ---
            const origPC = window.RTCPeerConnection;
            if (origPC) {
                const hookedPC = function RTCPeerConnection(config) {
                    if (!config) config = {};
                    config.iceTransportPolicy = 'relay';
                    return new origPC(config);
                };
                hookedPC.prototype = origPC.prototype;
                window.RTCPeerConnection = makeNative(hookedPC, 'RTCPeerConnection');
            }

            // --- 9. navigator.plugins + navigator.mimeTypes ---
            // Real Chrome 90+ always has 5 PDF plugins. Headless has 0 — instant detection.
            (function() {
                const pluginDefs = [
                    { name: 'PDF Viewer',                description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                    { name: 'Chrome PDF Viewer',         description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                    { name: 'Chromium PDF Viewer',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                    { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                    { name: 'WebKit built-in PDF',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' }
                ];
                const mimeTypeDefs = [
                    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                    { type: 'text/pdf',        suffixes: 'pdf', description: 'Portable Document Format' }
                ];

                // Build Plugin-like objects with circular enabledPlugin reference
                const plugins = pluginDefs.map(function(def) {
                    const plugin = Object.create(null);
                    const mimes = mimeTypeDefs.map(function(mt) {
                        const mimeObj = Object.create(null);
                        Object.defineProperties(mimeObj, {
                            type:          { value: mt.type,        enumerable: true, configurable: true },
                            suffixes:      { value: mt.suffixes,    enumerable: true, configurable: true },
                            description:   { value: mt.description, enumerable: true, configurable: true },
                            enabledPlugin: { get: function() { return plugin; }, enumerable: true, configurable: true }
                        });
                        return mimeObj;
                    });
                    mimes.forEach(function(mt, i) { plugin[i] = mt; });
                    Object.defineProperties(plugin, {
                        name:              { value: def.name,        enumerable: true,  configurable: true },
                        description:       { value: def.description, enumerable: true,  configurable: true },
                        filename:          { value: def.filename,    enumerable: true,  configurable: true },
                        length:            { value: mimes.length,    enumerable: true,  configurable: true },
                        item:              { value: function(n) { return plugin[n] || null; }, enumerable: false, configurable: true },
                        namedItem:         { value: function(n) { return mimes.find(function(m) { return m.type === n; }) || null; }, enumerable: false, configurable: true },
                        [Symbol.iterator]: { value: function*() { for (let i = 0; i < mimes.length; i++) yield mimes[i]; }, enumerable: false, configurable: true }
                    });
                    return plugin;
                });

                // Build PluginArray-like object
                const pluginArray = Object.create(null);
                plugins.forEach(function(p, i) { pluginArray[i] = p; pluginArray[p.name] = p; });
                Object.defineProperties(pluginArray, {
                    length:            { value: plugins.length, enumerable: true,  configurable: true },
                    item:              { value: function(n) { return pluginArray[n] || null; }, enumerable: false, configurable: true },
                    namedItem:         { value: function(n) { return pluginArray[n] || null; }, enumerable: false, configurable: true },
                    refresh:           { value: function() {}, enumerable: false, configurable: true },
                    [Symbol.iterator]: { value: function*() { for (let i = 0; i < plugins.length; i++) yield plugins[i]; }, enumerable: false, configurable: true }
                });

                // Build MimeTypeArray-like object (deduplicated, with namedItem by type)
                const allMimes = mimeTypeDefs.map(function(mt) {
                    const mimeObj = Object.create(null);
                    Object.defineProperties(mimeObj, {
                        type:          { value: mt.type,        enumerable: true, configurable: true },
                        suffixes:      { value: mt.suffixes,    enumerable: true, configurable: true },
                        description:   { value: mt.description, enumerable: true, configurable: true },
                        enabledPlugin: { value: plugins[0],     enumerable: true, configurable: true }
                    });
                    return mimeObj;
                });
                const mimeTypeArray = Object.create(null);
                allMimes.forEach(function(mt, i) { mimeTypeArray[i] = mt; mimeTypeArray[mt.type] = mt; });
                Object.defineProperties(mimeTypeArray, {
                    length:            { value: allMimes.length, enumerable: true,  configurable: true },
                    item:              { value: function(n) { return mimeTypeArray[n] || null; }, enumerable: false, configurable: true },
                    namedItem:         { value: function(n) { return mimeTypeArray[n] || null; }, enumerable: false, configurable: true },
                    [Symbol.iterator]: { value: function*() { for (let i = 0; i < allMimes.length; i++) yield allMimes[i]; }, enumerable: false, configurable: true }
                });

                Object.defineProperty(Navigator.prototype, 'plugins', {
                    get: makeNative(function plugins() { return pluginArray; }, 'plugins'),
                    enumerable: true, configurable: true
                });
                Object.defineProperty(Navigator.prototype, 'mimeTypes', {
                    get: makeNative(function mimeTypes() { return mimeTypeArray; }, 'mimeTypes'),
                    enumerable: true, configurable: true
                });
            })();

            // --- 10. navigator.permissions ---
            // Headless returns 'denied' for notifications — real Chrome returns 'default'.
            // Google reCAPTCHA checks this to detect automation.
            if (navigator.permissions) {
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                const permState = {
                    'notifications':   'default',
                    'geolocation':     'prompt',
                    'camera':          'prompt',
                    'microphone':      'prompt',
                    'clipboard-read':  'prompt',
                    'clipboard-write': 'granted'
                };
                Object.defineProperty(navigator.permissions, 'query', {
                    value: makeNative(function query(descriptor) {
                        const name = descriptor && descriptor.name;
                        if (name && permState[name] !== undefined) {
                            return Promise.resolve({ state: permState[name], onchange: null });
                        }
                        return origQuery(descriptor);
                    }, 'query'),
                    writable: true, enumerable: false, configurable: true
                });
            }

            // --- 11. WebGL - mode "real" (no JS hooks) ---
            // getExtension hook returned plain {} - instanceof check fails, detectable.
            // Machine has real NVIDIA RTX 3060 so real GPU values match profile anyway.
            // WebGL params compared between main frame and OffscreenCanvas Worker
            // (no hooks in Worker) - any override causes mismatch = "Masking detected".

            // --- 12. ClientRects - mode "real" (no JS hooks) ---
            // noiseRect() returned plain {} - instanceof DOMRect fails, detectable.
            // Worker also has no hook so values differ anyway = mismatch.

            // --- 13. MediaDevices - mode "real" (no JS hooks) ---
            // Fake devices were plain {} - instanceof MediaDeviceInfo fails, detectable.

            // --- 14. WebGPU - mode "real" (no JS hooks) ---
            // Fake adapter was plain {} - instanceof GPUAdapter fails, detectable.
            // Real GPU (RTX 3060) is hardware-backed anyway.

            // --- 15. Watermark UI ---
            const watermarkStyle = '${style}';
            function createWatermark() {
                try {
                    if (document.getElementById('geekez-watermark')) return;
                    if (!document.body) { setTimeout(createWatermark, 50); return; }

                    if (watermarkStyle === 'banner') {
                        const banner = document.createElement('div');
                        banner.id = 'geekez-watermark';
                        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg,rgba(102,126,234,.5),rgba(118,75,162,.5));backdrop-filter:blur(10px);color:white;padding:5px 20px;text-align:center;font-size:12px;font-weight:500;z-index:2147483647;box-shadow:0 2px 10px rgba(0,0,0,.1);display:flex;align-items:center;justify-content:center;gap:8px;font-family:monospace;';
                        const icon = document.createElement('span'); icon.textContent = '\u{1F539}'; icon.style.fontSize = '14px';
                        const text = document.createElement('span'); text.textContent = '\u73AF\u5883\uFF1A${safeProfileName}';
                        const closeBtn = document.createElement('button');
                        closeBtn.textContent = '\xD7';
                        closeBtn.style.cssText = 'position:absolute;right:10px;background:rgba(255,255,255,.2);border:none;color:white;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:16px;line-height:1;font-family:monospace;';
                        closeBtn.onclick = function() { banner.style.display = 'none'; };
                        banner.appendChild(icon); banner.appendChild(text); banner.appendChild(closeBtn);
                        document.body.appendChild(banner);
                    } else {
                        const watermark = document.createElement('div');
                        watermark.id = 'geekez-watermark';
                        watermark.style.cssText = 'position:fixed;bottom:16px;right:16px;background:linear-gradient(135deg,rgba(102,126,234,.5),rgba(118,75,162,.5));backdrop-filter:blur(10px);color:white;padding:10px 16px;border-radius:8px;font-size:15px;font-weight:600;z-index:2147483647;pointer-events:none;user-select:none;box-shadow:0 4px 15px rgba(102,126,234,.4);display:flex;align-items:center;gap:8px;font-family:monospace;animation:geekez-pulse 2s ease-in-out infinite;';
                        const icon = document.createElement('span'); icon.textContent = '\uD83C\uDFAF'; icon.style.cssText = 'font-size:18px;animation:geekez-rotate 3s linear infinite;';
                        const text = document.createElement('span'); text.textContent = '${safeProfileName}';
                        watermark.appendChild(icon); watermark.appendChild(text);
                        document.body.appendChild(watermark);
                        if (!document.getElementById('geekez-watermark-styles')) {
                            const s = document.createElement('style');
                            s.id = 'geekez-watermark-styles';
                            s.textContent = '@keyframes geekez-pulse{0%,100%{box-shadow:0 4px 15px rgba(102,126,234,.4)}50%{box-shadow:0 4px 25px rgba(102,126,234,.6)}}@keyframes geekez-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
                            document.head.appendChild(s);
                        }
                    }
                } catch(e) { /* silent */ }
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', createWatermark);
            } else {
                createWatermark();
            }

        } catch(e) { console.error("FP Error", e); }
    })();
    `;
}

module.exports = { generateFingerprint, getInjectScript };
