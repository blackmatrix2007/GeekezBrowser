# GeekezBrowser Improvement Checklist
## Based on ADBLogin V109 Analysis + fingerprint.js Audit

---

## MODULE A — WebGL Fingerprint Spoofing
**Priority: CRITICAL** | Status: [ ] Not implemented

WebGL is one of the most reliable browser fingerprinting vectors. Currently fingerprint.js has zero WebGL coverage.

### A1 — UNMASKED Vendor/Renderer strings
- [ ] Hook `WebGLRenderingContext.prototype.getParameter`
- [ ] Hook `WebGL2RenderingContext.prototype.getParameter`
- [ ] Return spoofed string for `UNMASKED_VENDOR_WEBGL` (extension constant `37445`)
- [ ] Return spoofed string for `UNMASKED_RENDERER_WEBGL` (extension constant `37446`)
- [ ] Use ANGLE format for Windows: `"Google Inc. (Intel)"` / `"ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"`
- [ ] Pool includes: Intel UHD 620, Intel Iris Xe, NVIDIA GTX 1650, AMD Radeon RX 580, Apple M1/M2
- [ ] Vendor/renderer must be consistent with OS profile (Win → ANGLE format, Mac → Apple format)
- [ ] `makeNative()` applied to patched getParameter

### A2 — WebGL Parameter Randomization (glParamValues)
Derived from ADBLogin `GologinGenPreferences.cs` hash dispatch switch (~40 params).

- [ ] `MAX_TEXTURE_SIZE` — realistic values: 8192, 16384 (NOT default 65536)
- [ ] `MAX_RENDERBUFFER_SIZE` — match MAX_TEXTURE_SIZE
- [ ] `MAX_VIEWPORT_DIMS` — `[8192, 8192]` or `[16384, 16384]`
- [ ] `MAX_TEXTURE_IMAGE_UNITS` — 16
- [ ] `MAX_VERTEX_TEXTURE_IMAGE_UNITS` — 16
- [ ] `MAX_COMBINED_TEXTURE_IMAGE_UNITS` — 32
- [ ] `MAX_VERTEX_ATTRIBS` — 16
- [ ] `MAX_VERTEX_UNIFORM_VECTORS` — 256 or 512
- [ ] `MAX_FRAGMENT_UNIFORM_VECTORS` — 224 or 512
- [ ] `MAX_VARYING_VECTORS` — 15 or 30
- [ ] `MAX_CUBE_MAP_TEXTURE_SIZE` — 8192 or 16384
- [ ] `MAX_DRAW_BUFFERS` (WebGL2) — 4 or 8
- [ ] `MAX_COLOR_ATTACHMENTS` (WebGL2) — 4 or 8
- [ ] `MAX_SAMPLES` (WebGL2) — 4, 8, or 16
- [ ] `MAX_ELEMENTS_INDICES` — 16777215
- [ ] `MAX_ELEMENTS_VERTICES` — 1048575
- [ ] `ALIASED_LINE_WIDTH_RANGE` — `[1, 1]`
- [ ] `ALIASED_POINT_SIZE_RANGE` — `[1, 1024]` or `[1, 255.875]`
- [ ] `MAX_3D_TEXTURE_SIZE` (WebGL2) — 2048
- [ ] `MAX_ARRAY_TEXTURE_LAYERS` (WebGL2) — 2048
- [ ] `MAX_TEXTURE_LOD_BIAS` (WebGL2) — 2 or 16
- [ ] `MAX_UNIFORM_BUFFER_BINDINGS` (WebGL2) — 24 or 36
- [ ] `MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS` (WebGL2) — 64
- [ ] `MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS` (WebGL2) — 4
- [ ] Use seeded PRNG (xoshiro128**) so same profile always gives same params
- [ ] Params must be consistent across both WebGL1 and WebGL2 contexts

### A3 — WebGL Extension Spoofing
- [ ] `getExtension('WEBGL_debug_renderer_info')` returns object (not null)
- [ ] Supported extensions list consistent with real GPU profile
- [ ] `getSupportedExtensions()` returns realistic array (not headless minimal set)

---

## MODULE B — ClientRects Noise
**Priority: HIGH** | Status: [ ] Not implemented

Headless Chrome returns integer-perfect pixel values. Real Chrome has subpixel floating-point imprecision due to font rendering.

### B1 — Element bounding rect noise
- [ ] Hook `Element.prototype.getBoundingClientRect`
- [ ] Add ±0.0001–0.0005 subpixel noise to `top`, `left`, `right`, `bottom` values
- [ ] `width` and `height` remain consistent (right-left, bottom-top)
- [ ] Noise is deterministic per element per profile (seeded PRNG with element tag + position)
- [ ] `makeNative()` applied

### B2 — Multiple client rects
- [ ] Hook `Element.prototype.getClientRects`
- [ ] Apply same noise pattern to each DOMRect in the returned DOMRectList
- [ ] `makeNative()` applied

### B3 — Range bounding rect
- [ ] Hook `Range.prototype.getBoundingClientRect`
- [ ] Hook `Range.prototype.getClientRects`
- [ ] Apply same noise
- [ ] `makeNative()` applied

### B4 — Noise properties
- [ ] Noise magnitude: max ±0.5px — imperceptible to layout but breaks fingerprint hash
- [ ] Noise seed derived from profile seed, NOT `Math.random()` (deterministic)
- [ ] Same element always returns same noised value within a session

---

## MODULE C — MediaDevices Enumeration Spoofing
**Priority: HIGH** | Status: [ ] Not implemented

Headless Chrome returns `[]` from `enumerateDevices()`. Real Chrome always has at least one audio output device.

### C1 — Device list injection
- [ ] Hook `navigator.mediaDevices.enumerateDevices`
- [ ] Return realistic device list based on profile OS
- [ ] Minimum: 1 `audioinput` (microphone), 1 `audiooutput` (speakers/headphones), 1 `videoinput` (webcam)
- [ ] Typical Windows profile: Internal Mic, Speakers/Headphones, Integrated Webcam

### C2 — Device object structure
- [ ] Each device has: `deviceId` (non-empty string), `groupId`, `kind`, `label`
- [ ] `label` populated (empty label = no permission granted detection)
- [ ] Labels match realistic hardware: "Microphone (Realtek High Definition Audio)", "Speakers (Realtek High Definition Audio)"
- [ ] `deviceId` is deterministic per profile (seeded hash, 64-char hex)
- [ ] `groupId` consistent — mic and speaker in same group

### C3 — Permission integration
- [ ] `getUserMedia` does not throw immediately
- [ ] `mediaDevices.getSupportedConstraints()` returns realistic constraints object

---

## MODULE D — WebGPU Adapter Spoofing
**Priority: HIGH** | Status: [ ] Not implemented

Headless Chrome exposes `navigator.gpu` with SwiftShader (software renderer), real Chrome shows hardware GPU.

### D1 — Adapter info
- [ ] Hook `navigator.gpu.requestAdapter()` — returns Promise resolving to fake adapter
- [ ] `adapter.info.vendor` — e.g. `"intel"`, `"nvidia"`, `"amd"`, `"apple"`
- [ ] `adapter.info.architecture` — e.g. `"gen-12lp"` (Intel), `"ampere"` (NVIDIA)
- [ ] `adapter.info.device` — e.g. `"0x9a49"` (Intel Iris Xe)
- [ ] `adapter.info.description` — empty string (matches real Chrome behavior)
- [ ] `adapter.info.vendorID` — PCI vendor ID as string
- [ ] `adapter.info.deviceID` — PCI device ID as string

### D2 — Adapter features
- [ ] `adapter.features` — Set of supported feature strings matching real GPU
- [ ] Include: `"depth-clip-control"`, `"depth32float-stencil8"`, `"texture-compression-bc"`, `"texture-compression-bc-sliced-3d"`, `"indirect-first-instance"`, `"rg11b10ufloat-renderable"`, `"bgra8unorm-storage"`, `"float32-filterable"`, `"clip-distances"`, `"dual-source-blending"`
- [ ] Feature set consistent with vendor (Intel vs NVIDIA vs AMD have different feature sets)

### D3 — Adapter limits
- [ ] `adapter.limits` object with ~30 properties
- [ ] Key limits: `maxTextureDimension2D: 32768`, `maxBindGroups: 4`, `maxVertexBuffers: 8`
- [ ] Limits consistent with hardware tier (integrated vs discrete)
- [ ] `requestAdapterInfo()` returns same data as `adapter.info`

### D4 — GPUDevice
- [ ] `adapter.requestDevice()` returns realistic GPUDevice
- [ ] `device.features` same as adapter features
- [ ] `device.limits` same as adapter limits
- [ ] `device.lost` returns never-resolving Promise

---

## FIX 1 — Canvas Noise Improvement
**Priority: HIGH** | Status: [ ] Needs fix (current implementation weak)

**Current bug**: Only modifies alpha channel at every 53rd pixel — creates detectable pattern.

### Fix checklist
- [ ] Remove `if ((i + noiseSeed) % 53 === 0)` condition
- [ ] Apply noise to ALL pixels, not just every 53rd
- [ ] Modify R, G, B channels (±1 to each), NOT alpha channel
- [ ] Alpha must remain 255 (transparent canvas detection)
- [ ] Noise magnitude: ±1 per channel (imperceptible visually, breaks hash)
- [ ] Noise per-pixel deterministic via seeded PRNG position
- [ ] Different profiles produce different canvas hashes

---

## FIX 2 — Audio Noise Improvement
**Priority: MEDIUM** | Status: [ ] Needs fix (current implementation weak)

**Current bug**: Only adds noise to first 100 samples of audio buffer — fingerprinting reads the entire buffer.

### Fix checklist
- [ ] Remove `if (i < 100)` condition
- [ ] Apply noise to ALL samples in the buffer
- [ ] Noise magnitude: ±0.0001 (inaudible, breaks fingerprint hash)
- [ ] Use seeded PRNG so same profile always produces same audio hash
- [ ] Different profiles produce different audio hashes

---

## FIX 3 — WebGL Vendor Strings in PRODUCTION_FIXES.md
**Priority: MEDIUM** | Status: [ ] Wrong values

**Current bug**: Windows preset uses `"NVIDIA Corporation"` as WebGL vendor — Chrome on Windows uses ANGLE so the real value is `"Google Inc. (NVIDIA Corporation)"`.

### Fix checklist
- [ ] Windows + NVIDIA: vendor = `"Google Inc. (NVIDIA Corporation)"`, renderer = `"ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)"`
- [ ] Windows + Intel: vendor = `"Google Inc. (Intel)"`, renderer = `"ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"`
- [ ] Windows + AMD: vendor = `"Google Inc. (AMD)"`, renderer = `"ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)"`
- [ ] macOS: vendor = `"Apple Inc."`, renderer = `"Apple M2"` (Metal backend, no ANGLE)
- [ ] Linux: vendor = `"Google Inc. (Intel Open Source Technology Center)"`, renderer = `"ANGLE (Intel, Mesa Intel(R) UHD Graphics 620...)"` (Mesa)

---

## Implementation Notes

### PRNG Requirement
All noise and randomization MUST use xoshiro128** seeded from profile seed — NOT `Math.random()`.
This ensures:
- Same profile = same fingerprint every time (deterministic)
- Different profiles = different fingerprints
- Fingerprint cannot change mid-session

### makeNative() Requirement
All hooked native functions must have `toString()` patched via `makeNative()` to return the native function source string. Otherwise `Function.prototype.toString.call(fn)` reveals the hook.

### Injection Order
Modules must be injected in this order to avoid race conditions:
1. PRNG (seed first)
2. WebGL (before any page script can access GPU)
3. ClientRects (before layout)
4. MediaDevices (before permission checks)
5. WebGPU (before any WebGPU init)

---

## Priority Matrix

| Item | Detection Risk | Implementation Effort | Priority |
|------|---------------|----------------------|----------|
| MODULE A — WebGL | CRITICAL | Medium | 1 |
| FIX 1 — Canvas noise | HIGH | Low | 2 |
| FIX 2 — Audio noise | HIGH | Low | 3 |
| MODULE B — ClientRects | HIGH | Low | 4 |
| MODULE C — MediaDevices | HIGH | Low | 5 |
| MODULE D — WebGPU | MEDIUM | High | 6 |
| FIX 3 — Vendor strings | MEDIUM | Low | 7 |
