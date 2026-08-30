# So Sánh Chi Tiết: LoHa AutoBrowser vs GeekezBrowser

**Ngày phân tích:** 2026-08-07
**Phiên bản:** LoHa.Browser 1.4.1 (x64) | GeekezBrowser-fork branch `feature/onlineslot` (BNC) v1.5.0
**Mục đích:** Đánh giá kiến trúc kỹ thuật để xác định điểm mạnh/yếu và định hướng phát triển tiếp theo

**Nguồn dữ liệu:**
- GeekezBrowser: đọc trực tiếp source code trong repo này (`main.js`, `renderer.js`, `package.json`, `ARCHITECTURE.md`, `chromium-build/patches/`).
- LoHa: dựa trên bản mô tả kỹ thuật do người dùng cung cấp (đã giải nén `extract_page/`, `extract_page_app/`, `extract_page_asar/`, `extract_browser/` tại `lohatech`), **chưa tự tay đối chiếu source** — các mục LoHa dưới đây đánh dấu "theo mô tả" ở nơi cần thiết.

---

## 📊 Tổng Quan So Sánh Nhanh

| Tiêu Chí | GeekezBrowser | LoHa AutoBrowser | Winner |
|---|---|---|---|
| **Desktop shell** | Electron 39 (Node + Chromium riêng đóng gói) | Tauri (Rust core) + WebView2 hệ thống | 🏆 LoHa (nhẹ hơn, ít trùng lặp Chromium) |
| **Trình duyệt lõi cho profile** | 3 nguồn song song: patch tự viết (9 patch) + fork ngoài `adryfish/fingerprint-chromium` + Chrome for Testing (không patch) | CloakBrowser — 1 nguồn duy nhất, chuyên biệt, tự nhận "pass mọi bot-detection test" | 🏆 LoHa (đồng bộ hơn, ít fallback yếu) |
| **Lớp JS bổ sung** | `fingerprint.js` — inject script runtime (canvas/webgl/audio/clientRect noise) | Không thấy mô tả tương đương (có thể có nhưng không nằm trong tóm tắt) | 🤝 Chưa đủ dữ liệu |
| **Driver automation** | `puppeteer` 24.x — dùng **native**, `puppeteer-extra-plugin-stealth` khai báo trong `package.json` nhưng **không được require ở đâu** | Playwright-core 1.60, dùng thật, đầy đủ | 🏆 LoHa (driver thực sự được dùng, không có dependency "chết") |
| **Automation / RPA engine** | ❌ Không có — không tìm thấy workflow engine, element picker, hay screencast trong toàn bộ `main.js`/`renderer.js` | ✅ `workflow_run/step_next/step_continue/stop` + `picker_start/stop/test` (record & pick) + `screencast_start/stop` | 🏆 LoHa (chênh lệch lớn nhất) |
| **2FA / TOTP** | ❌ Không có | ✅ `otplib` + `thirty-two`, tự sinh mã TOTP | 🏆 LoHa |
| **Cookie lifecycle** | Ngầm định qua `userDataDir` per-profile, không có API riêng | `startCookieCapture`/`finalizeCookieCapture` tường minh per-session | 🏆 LoHa |
| **Proxy engine** | **Xray-core** — VMess/VLESS/Trojan/SS, REALITY/XHTTP/gRPC/mKCP/WS, proxy chain | Không thấy mô tả — nhiều khả năng chỉ pass proxy args thẳng vào Chromium | 🏆 GeekezBrowser |
| **Backend thương mại** | Có sẵn: BNC Auth (JWT), subscription PostgreSQL/Sequelize, Casso webhook thanh toán ngân hàng | Không đề cập trong mô tả | 🏆 GeekezBrowser (chưa chắc LoHa thiếu, chỉ là không nằm trong phạm vi mô tả) |
| **Open source / khả năng tuỳ biến** | ✅ Toàn bộ source có sẵn, CC BY-NC-SA | CloakBrowser (lõi) là mã nguồn mở công khai, nhưng lớp Tauri/sidecar của LoHa là closed | 🤝 Tie (mỗi bên mở một phần khác nhau) |

**Kết luận sơ bộ:** LoHa thắng 6 tiêu chí (chủ yếu ở tầng stealth-core và automation/RPA), GeekezBrowser thắng 2 tiêu chí (proxy engine, backend thương mại đã build sẵn).

---

## 🔍 Phân Tích Kỹ Thuật Chi Tiết

### 1. Kiến trúc tổng thể

#### GeekezBrowser (đã đọc source)
```
┌──────────────────────────────────────────────────────────┐
│                 GeekezBrowser Architecture                │
├──────────────────────────────────────────────────────────┤
│  Layer 1: GUI (Electron v39 + Node.js)                    │
│    ├── main.js      (~4,200 dòng — IPC, BNC auth,        │
│    │                  profile launch, Xray)               │
│    ├── renderer.js  (~3,100 dòng — toàn bộ UI logic)      │
│    ├── preload.js   (contextBridge — IPC an toàn)         │
│    └── index.html   (~2,200 dòng — UI markup + CSS)       │
│                                                             │
│  Layer 2: Browser Automation                               │
│    └── puppeteer@24.34.0 — dùng NATIVE                     │
│        (puppeteer-extra-plugin-stealth có khai báo         │
│         trong package.json nhưng KHÔNG được require)       │
│                                                             │
│  Layer 3: Browser Core (3 nguồn song song)                 │
│    ├── Chromium tự patch (chromium-build/patches/, 9 patch)│
│    ├── fingerprint-chromium (fork ngoài: adryfish)         │
│    └── Chrome for Testing (Chrome thật, KHÔNG patch)        │
│                                                             │
│  Layer 4: Fingerprint Engine (JS runtime)                  │
│    └── fingerprint.js — inject script bổ sung              │
│        canvas/webgl/audio noise, clientRect, perf.now       │
│                                                             │
│  Layer 5: Network Engine (Xray-core)                       │
│    └── VMess/VLESS/Trojan/SS, REALITY/XHTTP/gRPC/mKCP/WS   │
│                                                             │
│  Layer 6: Auth & Subscription (BNC, thêm ở v1.4.0)          │
│    ├── HTTPS → yttool.vn/api/bnc (Node/Express)             │
│    ├── PostgreSQL + Sequelize                               │
│    └── Casso webhook — auto-renew qua chuyển khoản          │
└──────────────────────────────────────────────────────────┘
```

#### LoHa AutoBrowser (theo mô tả người dùng cung cấp)
```
┌──────────────────────────────────────────────────────────┐
│                  LoHa AutoBrowser Architecture             │
├──────────────────────────────────────────────────────────┤
│  Layer 1: Installer                                        │
│    └── NSIS 3 (nsis_tauri_utils.dll)                        │
│                                                             │
│  Layer 2: Desktop shell                                     │
│    └── Tauri (Rust core: loha-autobrowser.exe) + WebView2   │
│                                                             │
│  Layer 3: Automation sidecar                                │
│    └── node-runtime.exe (Node 20+, portable, esbuild/Bun)   │
│        giao tiếp Tauri qua JSON-line protocol (stdin/stdout)│
│        id/type/payload per request                          │
│                                                             │
│  Layer 4: Browser core                                      │
│    └── cloakbrowser v0.3.28 (mã nguồn mở, CloakHQ)           │
│        Chromium 146.0.7680.177.4 đã patch fingerprint        │
│                                                             │
│  Layer 5: Driver                                             │
│    └── Playwright-core 1.60.0                                │
│                                                             │
│  Layer 6: 2FA                                                │
│    └── otplib + thirty-two — tự sinh TOTP                    │
│                                                             │
│  Layer 7: Automation engine (dispatch table thực tế)         │
│    ├── launch/stop/list — quản lý phiên/profile              │
│    ├── workflow_run/step_next/step_continue/step_stop        │
│    ├── picker_start/stop/test — record & pick element         │
│    ├── screencast_start/stop — stream hình real-time          │
│    └── set_window_bounds — điều khiển cửa sổ qua CDP           │
│                                                             │
│  Layer 8: Cookie                                              │
│    └── startCookieCapture/finalizeCookieCapture per-session   │
└──────────────────────────────────────────────────────────┘
```

**Nhận xét:** Hai sản phẩm giải hai bài toán hơi khác nhau. GeekezBrowser tối ưu cho "quản lý nhiều profile + proxy + thương mại hoá". LoHa tối ưu cho "chạy kịch bản automation nhiều tài khoản có giám sát" — workflow engine, picker, screencast là những thứ chỉ có ý nghĩa khi mục tiêu là RPA, không phải browsing thủ công.

---

### 2. Browser Core & Khả Năng Né Detection

**GeekezBrowser — vấn đề thật:** codebase hỗ trợ 3 nguồn Chromium khác nhau cho profile:

1. `chromium-build/patches/` — 9 patch tự viết (`001-navigator-webdriver-always-false.patch` → `009-font-fingerprint-reduce.patch`). Đây là lớp source-level thật, đáng tin nhất, nhưng phạm vi hẹp hơn nhiều so với patch set thường thấy ở các anti-detect browser thương mại (không thấy patch cho WebRTC leak, permission API, hoặc plugin/mimeType).
2. `adryfish/fingerprint-chromium` ([main.js:61](main.js#L61)) — phụ thuộc vào maintainer bên ngoài, không kiểm soát được lộ trình cập nhật.
3. Chrome for Testing — bản Chrome chính chủ, **không có patch stealth nào**, chỉ có ý nghĩa là fallback khi 2 nguồn trên không khả dụng.

Vì 3 nguồn cùng tồn tại, mức độ "ẩn danh" thực tế của một profile phụ thuộc vào việc người dùng chọn browser nào lúc launch — không đồng nhất, và fallback #3 gần như bằng không.

**LoHa (theo mô tả):** CloakBrowser là một nguồn duy nhất, được công bố công khai là dự án chuyên biệt cho stealth, Chromium 146.x (mới hơn phiên bản GeekezBrowser build trên — cần xác nhận version cụ thể GeekezBrowser đang dùng). Vì chỉ có 1 nguồn, không có tình trạng "profile A patch, profile B không patch" như bên GeekezBrowser.

**Điểm cộng GeekezBrowser không nên bỏ qua:** `fingerprint.js` có lớp JS injection runtime bổ sung ở trên native patch — nghĩa là dù dùng Chrome for Testing (nguồn #3, không patch native), vẫn có một lớp che chắn JS-level. Đây là kiến trúc "phòng thủ 2 lớp" hợp lý, chỉ là lớp native đang yếu và không đồng nhất.

---

### 3. Automation Driver

GeekezBrowser cài `puppeteer-extra` và `puppeteer-extra-plugin-stealth` trong `package.json` ([package.json:120-121](package.json#L120-L121)) nhưng `main.js` dùng thẳng `puppeteer` native với comment tường minh:

```js
const puppeteer = require('puppeteer'); // 使用原生 puppeteer，不带 extra
```

Nghĩa là **plugin stealth đang không hoạt động** ở bất kỳ luồng nào trong `main.js` (verify, launch, hay đâu khác) — dependency tồn tại nhưng vô dụng, chỉ tốn dung lượng cài đặt. Đây là điểm nên dọn: hoặc bỏ hẳn dependency, hoặc thực sự bật nó lên nếu có lý do đang tắt.

LoHa dùng Playwright-core thật sự làm driver cho sidecar Node — driver được sử dụng đúng như khai báo.

---

### 4. Automation / RPA — khoảng cách lớn nhất

Đây là chênh lệch rõ ràng nhất giữa hai sản phẩm. Đã grep toàn bộ `main.js`, `renderer.js`, `preload.js`, `utils.js`, `fingerprint.js` cho các từ khoá `workflow`, `picker` (automation), `screencast`, `otplib`, `totp` — kết quả:

- `workflow`: không có kết quả nào.
- `picker`: chỉ có UI picker thông thường (chọn thư mục, chọn thành viên) ở [renderer.js:702](renderer.js#L702), [renderer.js:3998](renderer.js#L3998) — **không liên quan** đến element picker automation.
- `screencast`, `otplib`, `totp`: không có kết quả nào.

→ GeekezBrowser hiện tại **thuần là trình quản lý profile + proxy + launcher**, không có khả năng chạy kịch bản, không ghi lại thao tác, không giám sát real-time, không tự động 2FA. Nếu mục tiêu sản phẩm là hỗ trợ vận hành hàng loạt tài khoản có kịch bản lặp lại (ví dụ auto check-in, auto claim, auto login hàng loạt), đây là tính năng LoHa có mà GeekezBrowser thiếu hoàn toàn, không phải thiếu một phần.

---

### 5. Proxy & Network — điểm mạnh của GeekezBrowser

Xray-core là proxy engine chuyên nghiệp, hỗ trợ nhiều giao thức hiện đại (VMess/VLESS/Trojan/Shadowsocks, transport REALITY/XHTTP/gRPC/mKCP/WS), có proxy chain (Local → Pre-Proxy → Target) và smart routing IPv4/IPv6 ([main.js:2244](main.js#L2244), [main.js:4064](main.js#L4064)). Mô tả LoHa không đề cập lớp proxy engine tương đương — nhiều khả năng LoHa chỉ truyền proxy args thẳng cho Chromium/CDP (`set_window_bounds` cho thấy họ điều khiển qua CDP), tức là ít linh hoạt hơn khi cần xoay nhiều loại proxy hoặc proxy chain.

*Lưu ý:* đây là phần dựa trên "không thấy nhắc tới" trong mô tả, không phải bằng chứng LoHa chắc chắn thiếu — cần xem trực tiếp `sidecar.mjs` hoặc Rust core nếu muốn kết luận chắc chắn.

---

### 6. Backend thương mại — điểm mạnh khác của GeekezBrowser

BNC (branch `feature/onlineslot`) đã có sẵn toàn bộ hạ tầng SaaS: đăng nhập JWT, kiểm tra subscription theo chu kỳ 30 phút với cache 24h grace-period khi mất mạng, webhook Casso nhận diện mã giao dịch `BNC{customerId}` để tự gia hạn ([ARCHITECTURE.md:125-184](ARCHITECTURE.md#L125-L184)). Đây là hạ tầng thu tiền + license đã chạy được ngay, mô tả LoHa không nhắc tới phần này.

---

## 🎯 Kết Luận & Khuyến Nghị

**Không có "thắng tuyệt đối"** — hai sản phẩm nhắm hai use-case khác nhau:

- Nếu định nghĩa "tốt hơn" = **trình duyệt ẩn danh dùng thủ công, đã có sẵn business layer để bán** → GeekezBrowser đang ở vị trí tốt hơn để triển khai ngay, nhờ Xray proxy engine mạnh và hệ thống subscription/thanh toán đã hoàn chỉnh.
- Nếu định nghĩa "tốt hơn" = **nền tảng automation/RPA vận hành nhiều tài khoản theo kịch bản** → LoHa vượt trội rõ ràng, vì có cả tầng automation (workflow + picker + screencast + TOTP) mà GeekezBrowser thiếu hoàn toàn.
- Riêng ở **lớp stealth-core**, LoHa có kiến trúc gọn và đồng nhất hơn (1 nguồn Chromium chuyên biệt) so với GeekezBrowser (3 nguồn chắp vá, 1 trong 3 không patch gì cả).

### Khuyến nghị hành động cho GeekezBrowser

1. **Dọn nợ kỹ thuật ngay:** hoặc bật `puppeteer-extra-plugin-stealth` thật sự, hoặc gỡ dependency — hiện đang khai báo nhưng vô dụng.
2. **Thu hẹp về 1 nguồn Chromium chính:** ưu tiên đầu tư patch tự viết (`chromium-build/patches/`) làm nguồn chuẩn duy nhất, hạ cấp Chrome for Testing xuống chế độ "debug only", tránh để người dùng vô tình chọn nguồn không patch trong môi trường production.
3. **Nếu muốn cạnh tranh mảng automation:** đây là hạng mục tính năng lớn (workflow engine + element picker + screencast), không phải patch nhỏ — cần đánh giá riêng có đáng đầu tư hay không dựa trên nhu cầu khách hàng thực tế của BNC, trước khi bắt tay code.
4. **Giữ và phát huy lợi thế proxy/backend đã có** — đây là 2 điểm GeekezBrowser đang thực sự đi trước, không nên đánh đổi khi refactor các phần trên.

---

## ⚠️ Giới hạn của phân tích này

Phần LoHa dựa hoàn toàn trên bản tóm tắt kỹ thuật do người dùng cung cấp (đã giải nén sẵn tại `lohatech/extract_*`), không phải do tôi tự đọc `sidecar.mjs`, `database.js`, `scheduler.js`, hay Rust core binary. Các mục đánh dấu "theo mô tả" cần được xác minh trực tiếp trong source nếu muốn dùng làm căn cứ quyết định đầu tư — đặc biệt là phần proxy engine của LoHa, hiện chỉ suy luận từ việc "không được nhắc tới".
