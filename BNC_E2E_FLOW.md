# BNC — Luồng E2E: Mua Gói → Slot → Quản lý Profile

> Cập nhật: 2026-05-15 — Slot model hoàn chỉnh với billing cycle + profile locking

---

## 1. Cấu hình gói (Plan Catalogue)

Nguồn duy nhất: `server/config/bncPlans.js`

| Gói     | Giá/tháng  | Slots cấp | Max Thiết bị | Loại             |
|---------|------------|-----------|--------------|------------------|
| Starter | 199.000đ   | 30        | **1**        | Single-device    |
| Pro     | 399.000đ   | 100       | **1**        | Single-device    |
| Team    | 699.000đ   | 300       | **3**        | Multi-device     |
| Scale   | 1.299.000đ | 1000      | **5**        | Multi-device     |
| Test    | 5.000đ     | 2         | **2**        | Dev/test only    |

**Mỗi lần mua gói → cộng `maxProfiles` slot vào pool của account (không nhân số tháng).**

**Multi-device hoạt động như thế nào:**
- Server tính `maxDevices = max(maxDevices)` trên **tất cả** sub active của account
- Thiết bị đăng nhập quá giới hạn → thiết bị cũ nhất (trừ thiết bị vừa login) bị kick

---

## 2. Mô hình Slot

```
bnc_customer_slots (1 row per account)
  total_granted  — tổng slot đã mua (cộng dồn, không bao giờ giảm)
  slots_used     — tổng slot đã tiêu (tăng dần, không giảm)
  available      = total_granted - slots_used  (không âm)
```

### 4 sự kiện thay đổi slot

| Sự kiện | Thay đổi | Ghi chú |
|---------|----------|---------|
| **Mua gói** | `total_granted += plan.maxProfiles` | Webhook Casso hoặc Admin tạo thủ công |
| **Tạo profile** | `slots_used += 1` | Atomic `UPDATE ... RETURNING`, block nếu available = 0 |
| **Billing hàng tháng** | `slots_used += MIN(COUNT(profiles), available)` | SQL: `LEAST(slots_used + cnt, total_granted)` |
| **Xóa profile** | Không thay đổi | Slot đã dùng không được hoàn lại |

### 3 Cases đã confirmed

**Case 1 — Mua gói nhưng không tạo profile:**
```
Gói A: 10 slots
Mua → available = 10
Không tạo profile → billing charge 0 (không có profile nào)
Sau 1 tháng, 40 ngày, 1 năm → vẫn còn 10 slots
```

**Case 2 — Tạo profile + billing hàng tháng:**
```
Gói A: 10 slots
Mua → available = 10
Tạo 1 profile → slots_used += 1 → available = 9
Billing tháng 1: charge 1 (1 profile đang chạy) → available = 8
Billing tháng 2: charge 1 → available = 7
... (mỗi tháng -1 nếu không mua thêm)
```

**Case 3 — Hết slot, mua thêm, profiles unlock:**
```
Gói A: 10 slots, tạo 10 profiles → available = 0
→ Tất cả 10 profiles bị LOCK (không dùng được)

Mua gói 2 slots → available = 2
→ 2 profile CŨ NHẤT được unlock
→ 8 profile còn lại vẫn locked

Billing chạy → charge 2 (2 unlocked profiles) → available = 0
→ Tất cả locked lại
```

### Profile locking — isLocked

```
Profiles sort theo clientCreatedAt ASC (profile cũ nhất được ưu tiên giữ slot)

index < available  →  unlocked: dùng bình thường
index >= available →  isLocked = true:
    - UI: mờ 45%, badge 🔒 "Hết slot"
    - Nút KHỞI ĐỘNG: disabled
    - Không thể mở profile cho đến khi mua thêm slot
```

### Billing cycle

- **Production**: Cron chạy lúc `00:00 ngày 1 hàng tháng` (Asia/Ho_Chi_Minh)
- **Test**: Set `BNC_BILLING_INTERVAL_MINUTES=N` trong `server/.env`
- **File**: `server/cron/bncBillingJob.js`

### Khi available = 0

| Hành động | Kết quả |
|-----------|---------|
| Tạo profile mới | ❌ Block — server 400 + client guard trước form |
| KHỞI ĐỘNG profile | ❌ Nút disabled hoàn toàn |
| Mua gói | ✅ Unlock profiles ngay sau payment webhook |

---

## 3. Luồng Đăng nhập

```
GeekezBrowser → POST /api/bnc/login
              ← { accessToken, customer, slots: { totalGranted, slotsUsed, available } }

main.js: saveBncAuth({
    accessToken,
    email,
    customerId,
    slots,          // slot pool của account
})
```

- `slots` lưu trong `_bncAuth` (in-memory), hiện trong pill + dropdown avatar
- Heartbeat 5 phút gọi `GET /api/bnc/slots` để refresh slot count

---

## 4. Luồng Mua Gói (Chuyển khoản)

```
1. User mở Plans modal → chọn gói → xem QR thanh toán
2. Nội dung chuyển khoản: "BNC{customerId}" (ví dụ: BNC2)
3. Số tiền = price của gói (ví dụ 5.000đ cho Test)
4. User chuyển khoản → đóng payment modal

5. App tự động poll server mỗi 5 giây (tối đa 3 phút):
   GET /api/bnc/slots
   → so sánh totalGranted với giá trị trước khi mở modal
   → nếu totalGranted tăng → phát hiện thanh toán thành công

6. Casso nhận giao dịch → gọi webhook → yttool.vn/webhook
7. Server xác thực HMAC-SHA512 → processBncPayment():
   - Parse "BNC2" → customerId = 2
   - So khớp amount với plan (±10%) → tìm gói phù hợp
   - months = round(amount / plan.price), tối thiểu 1
   - INSERT bnc_subscriptions (status=active, endDate = now + months*30 ngày)
   - grantSlots(customerId, plan.maxProfiles)  ← cộng slot pool

8. Poll phát hiện totalGranted tăng → toast "✅ Đã kích hoạt gói X"
   - _bncAuth.slots được cập nhật
   - _updatePlanPill() — cập nhật pill + dropdown
   - loadProfiles() reload
```

**Lưu ý:** Nhiều gói active song song là bình thường — mỗi lần mua thêm slot vào pool.

---

## 5. Luồng Tạo Profile

```
User bấm "Thêm profile"
→ openAddModal() kiểm tra slots.available > 0
  → nếu 0 → hỏi "Mua thêm slots?" → openPlansModal()
  → nếu > 0 → mở form

User điền form → bấm Lưu
→ save-profile IPC
→ main.js:
    newProfile = { id: uuidv4(), name, proxy, fingerprint, ... }
    writeJson(PROFILES_FILE)   // lưu local ngay lập tức
    _decrementSlot()           // optimistic UI update

→ bncApiCall('POST', '/profiles', newProfile)  // fire-and-forget sync
→ Server createProfile():
    1. consumeSlots(customerId, 1) [atomic]
       → nếu hết slot → 400 lỗi, onProfileSyncStatus(false) → rollback decrement
    2. INSERT bnc_profiles (customer_id, name, proxy, fingerprint, ...)

Nếu sync thành công: onProfileSyncStatus(true) — giữ optimistic state
Nếu sync fail: onProfileSyncStatus(false) — rollback _bncAuth.slots
```

---

## 6. Luồng Đồng bộ Profile (Manual)

```
Bấm "🔄 Đồng bộ Profile" trong dropdown
→ IPC: bnc-sync-profiles
→ main.js:
    GET /api/bnc/profiles  (trả tất cả profiles của account)
    
    Nếu server có profiles:
        writeJson(PROFILES_FILE, serverProfiles)  // server là source of truth
        → loadProfiles() reload UI
    
    Nếu server không có:
        POST /api/bnc/profiles/bulk { profiles: localProfiles }  // upload local lên
        → consumeSlots(customerId, newProfiles.length) [atomic]
        → nếu hết slot → 409 lỗi

Sau sync: refresh slots từ server → _updatePlanPill()
```

---

## 7. Luồng Sync tự động khi Login

```
bnc-login IPC thành công:
    serverProfiles = result.profiles  // server trả tất cả profiles của account

    Nếu serverProfiles.length > 0:
        writeJson(PROFILES_FILE, serverProfiles)  // dùng server làm master

    Nếu serverProfiles.length === 0:
        localProfiles = readJson(PROFILES_FILE)
        POST /profiles/bulk { profiles: localProfiles }  // upload local lên server
```

---

## 8. Multi-device Session Management

```
Login:
    BncSession.upsert({ customerId, deviceId, deviceName, platform })
    allSessions = findAll ORDER BY last_seen_at ASC
    maxDevices = max(maxDevices across all active subscriptions)
    
    Nếu allSessions.length > maxDevices:
        kick = sessions[0..N] (cũ nhất, trừ thiết bị vừa login)
        BncSession.destroy(kick)

Heartbeat (mỗi 5 phút):
    GET /api/bnc/slots
    → 401 reason=other_device/device_kicked → hiện overlay "Đăng nhập máy khác"
    → cập nhật _bncAuth.slots → _updatePlanPill()
```

---

## 9. Database Schema (liên quan)

```sql
bnc_subscriptions
  id            INTEGER PK AUTOINCREMENT
  customer_id   INTEGER FK → customers.id
  plan_type     ENUM('test','starter','pro','team','scale')
  max_profiles  INTEGER   -- số slot cấp trong lần mua này
  max_devices   INTEGER
  start_date    TIMESTAMP
  end_date      TIMESTAMP
  status        ENUM('active','expired','cancelled')
  price         INTEGER   -- VND tại thời điểm mua
  note          VARCHAR

bnc_customer_slots           -- pool slot cộng dồn của account
  customer_id   INTEGER PK FK → customers.id
  total_granted INTEGER      -- tổng slot đã cấp (cộng dồn)
  slots_used    INTEGER      -- tổng slot đã tiêu (không giảm khi xoá profile)
  created_at    TIMESTAMP
  updated_at    TIMESTAMP
  -- available = total_granted - slots_used (computed)

bnc_profiles
  id            UUID PK      -- do client tạo
  customer_id   INTEGER FK → customers.id
  name          VARCHAR
  proxy_str     VARCHAR
  fingerprint   JSONB
  group_id      UUID
  is_setup      BOOLEAN
  subscription_id INTEGER FK → bnc_subscriptions.id  (nullable — billing reference)

bnc_sessions
  customer_id   INTEGER FK
  device_id     VARCHAR(100)
  device_name   VARCHAR
  platform      VARCHAR
  last_seen_at  TIMESTAMP
  PRIMARY KEY (customer_id, device_id)
```

---

## 10. Files Chính

| File | Vai trò |
|------|---------|
| `server/config/bncPlans.js` | Nguồn duy nhất cho plan config |
| `server/utils/bncSlots.js` | getSlots / grantSlots / consumeSlots (atomic) |
| `server/controllers/bncController.js` | Login, slots, profiles CRUD |
| `server/controllers/bncAdminController.js` | Admin: tạo/gia hạn/huỷ gói, listCustomers |
| `server/routes/webhook.js` → `processBncPayment()` | Xử lý webhook Casso → tạo sub + grant slots |
| `server/models/bncSubscriptionModel.js` | ORM bnc_subscriptions (billing record) |
| `server/models/bncProfileModel.js` | ORM bnc_profiles |
| `server/scripts/migrate_bnc_sync.js` | Migration idempotent — tạo bnc_customer_slots |
| `GeekezBrowser/main.js` | IPC handlers, auth file, BNC API calls, heartbeat 5 phút |
| `GeekezBrowser/renderer.js` | UI: login, slot pill, payment poll, openAddModal guard |
| `GeekezBrowser/preload.js` | contextBridge — expose electronAPI |
| `GeekezBrowser/index.html` | UI layout, modals, dropdown |

---

## 11. Sequence Diagram (E2E)

```mermaid
sequenceDiagram
    actor U as Khách hàng
    participant App as GeekezBrowser
    participant Main as main.js (Electron)
    participant Server as yttool.vn/api/bnc
    participant DB as PostgreSQL
    participant Casso as Casso Webhook

    %% ── LOGIN ──────────────────────────────────────────────
    U->>App: Đăng nhập
    App->>Main: bnc-login IPC
    Main->>Server: POST /api/bnc/login
    Server->>DB: SELECT bnc_customer_slots WHERE customer_id = X
    DB-->>Server: { total_granted: 100, slots_used: 3, available: 97 }
    Server-->>Main: { accessToken, customer, slots }
    Main->>Main: saveBncAuth({ slots })
    Main-->>App: { slots }
    App->>App: _updatePlanPill() — hiện "97 / 100 slots"

    %% ── MUA GÓI MỚI ────────────────────────────────────────
    U->>App: Mở Plans modal → chọn gói Test
    App->>Main: bnc-get-payment-info IPC
    Main-->>App: { bankAccountNo, transferContent: "BNC2" }
    App->>U: Hiện QR + nội dung "BNC2"
    U->>U: Chuyển khoản 5.000đ — "BNC2"

    U->>App: Đóng payment modal → startPaymentPoll()

    Casso->>Server: POST /webhook (amount=5000, desc="BNC2")
    Server->>Server: verifyWebhookSignature HMAC-SHA512
    Server->>DB: INSERT bnc_subscriptions(customerId=2, planType=test, maxProfiles=2)
    Server->>DB: UPDATE bnc_customer_slots SET total_granted = total_granted + 2
    DB-->>Server: { total_granted: 102, slots_used: 3, available: 99 }

    App->>Main: bnc-get-subscriptions IPC (poll mỗi 5s)
    Main->>Server: GET /api/bnc/slots
    Server-->>Main: { slots: { totalGranted: 102, ... } }
    Main-->>App: slots
    App->>App: totalGranted tăng → toast "✅ Đã kích hoạt Test (+2 slots)"
    App->>App: _updatePlanPill() — hiện "99 / 102 slots"

    %% ── TẠO PROFILE ────────────────────────────────────────
    U->>App: Tạo profile mới
    App->>App: openAddModal() — slots.available = 99 > 0 → mở form
    App->>Main: save-profile IPC { name, proxy, ... }
    Main->>Main: writeJson(PROFILES_FILE)
    Main-->>App: profile saved locally ✅
    App->>App: _decrementSlot() — optimistic: available = 98

    Main--)Server: POST /api/bnc/profiles { ...profile }
    Note right of Main: fire-and-forget, không block UI
    Server->>DB: UPDATE bnc_customer_slots SET slots_used = slots_used + 1
                  WHERE available >= 1 RETURNING customer_id
    DB-->>Server: { customer_id: 2 } — OK
    Server->>DB: INSERT bnc_profiles (customer_id=2, name=..., ...)
    Server-->>Main: 201 { profile }
    Main-->>App: onProfileSyncStatus(true) — giữ optimistic state
```
