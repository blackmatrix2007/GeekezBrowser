# BNC Browser — Architecture v1.4.0
_Updated: 2026-05-06_

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron (Node.js + Chromium) |
| UI | Vanilla HTML/CSS/JS (index.html + renderer.js) |
| IPC | Electron contextBridge / ipcMain / ipcRenderer |
| Proxy engine | Xray-core (V2Ray compatible, bundled binary) |
| Browser launch | Chrome for Testing / Fingerprint Chromium (spawned subprocess) |
| Auth backend | Node.js/Express @ yttool.vn (muachungtool) |
| Database | PostgreSQL (hosted 103.146.23.70) |
| ORM | Sequelize |
| Payment detection | Casso webhook → muachungtool |

---

## 2. Process Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Electron Main Process               │
│  main.js                                            │
│  ├── app.whenReady() — startup orchestration        │
│  ├── BrowserWindow (mainWindow) — single window UI  │
│  ├── Internal Guard API Server (port 12139)         │
│  │     └── /api/activate-license (local only)       │
│  ├── ipcMain.handle() — ~30 IPC channels            │
│  ├── BNC Auth (HTTPS → yttool.vn/api/bnc)           │
│  ├── Xray-core subprocess (proxy routing)           │
│  └── Chrome/Chromium subprocesses (profiles)        │
│                                                     │
│  Periodic timers:                                   │
│  ├── 30min — BNC subscription re-check             │
│  └── 30min — toolphuc heartbeat (update check)     │
└───────────────┬─────────────────────────────────────┘
                │ contextBridge (preload.js)
                ▼
┌─────────────────────────────────────────────────────┐
│              Renderer Process (index.html)           │
│  renderer.js                                        │
│  ├── BNC Auth UI (login overlay, avatar, dropdown)  │
│  ├── Profile list / CRUD                            │
│  ├── Groups management                              │
│  ├── Proxy chain manager                            │
│  ├── Settings modal                                 │
│  └── i18n (vi/en via i18n.js + locales/)           │
└─────────────────────────────────────────────────────┘
```

---

## 3. IPC Channel Map (preload.js ↔ main.js)

### Profile management
| Channel | Direction | Description |
|---------|-----------|-------------|
| `get-profiles` | R→M | Load all profiles from disk |
| `save-profile` | R→M | Create new profile |
| `update-profile` | R→M | Update profile |
| `delete-profile` | R→M | Delete profile + data dir |
| `launch-profile` | R→M | Spawn Chrome with proxy/fingerprint |
| `get-running-ids` | R→M | Which profiles are currently running |
| `profile-status` | M→R | Running/stopped events |
| `verify-profile` | R→M | Anti-detect verify check |

### Groups
| Channel | Description |
|---------|-------------|
| `get-groups`, `save-group`, `update-group`, `delete-group` | CRUD |
| `assign-profile-group` | Move profile to group |

### BNC Auth (added v1.4.0)
| Channel | Description |
|---------|-------------|
| `bnc-login` | Login with email/pw → save JWT + cache |
| `bnc-logout` | Clear local auth files |
| `bnc-get-auth` | Read saved auth + sub cache |
| `bnc-get-subscription` | Live check from server |
| `bnc-get-plans` | Plan catalogue (hardcoded) |
| `bnc-get-payment-info` | Bank info for VietQR |
| `bnc-auth-state` (M→R) | Push auth state on startup |

### Settings / Chrome
| Channel | Description |
|---------|-------------|
| `get-settings`, `save-settings` | App settings (JSON file) |
| `get-chrome-path`, `select-chrome-binary` | Chrome binary selection |
| `check-chrome-for-testing`, `download-chrome-for-testing` | CfT management |

### Misc
| Channel | Description |
|---------|-------------|
| `export-profile`, `import-profile` | YAML import/export |
| `detect-proxy-location` | GeoIP via API |
| `open-url` | Open link in system browser |
| `is-packaged` | Whether running as packaged app |
| `renderer-debug-log` | Main-process console from renderer |

---

## 4. Data Storage (userData directory)

```
~/Library/Application Support/BNC/
├── profiles.json          — all profile records
├── groups.json            — group definitions
├── settings.json          — app settings
├── bnc_auth.json          — BNC JWT + customerId + email
├── .bnc_sub_cache.json    — subscription cache (24h grace)
├── .access_cache.json     — toolphuc heartbeat cache
├── .skipped_update_version — dismissed update version
├── DATA_PATH_CONFIRMED    — flag: data path confirmed by user
└── profiles/
    └── {profileId}/       — Chrome user data per profile
```

---

## 5. BNC Subscription System

```
User enters email + password
        │
        ▼
Electron main.js: bncLogin()
  HTTPS POST https://yttool.vn/api/bnc/login
        │
        ▼
muachungtool (Express + Sequelize + PostgreSQL)
  bncController.bncLogin()
  ├── Customer.findOne({ email })
  ├── Users.findOne({ email }) → bcrypt.compare(pw, hash)
  ├── BncSubscription.findOne({ customerId, status:'active', endDate > now })
  └── jwt.sign({ customerId, email }, secret, '30d')
        │
        ▼
Response: { accessToken, customer, subscription }
        │
        ▼
Electron saves:
  ├── bnc_auth.json    { accessToken, email, customerId }
  └── .bnc_sub_cache.json  { planType, maxProfiles, daysRemaining, ... }
        │
        ▼
Renderer: hideBncLoginOverlay() → show avatar + plan info
```

### Subscription check flow (startup + every 30min)
```
bncCheckAccess()
  ├── getSavedBncAuth() → null? → { allowed: false, reason: 'not_logged_in' }
  ├── HTTPS GET /api/bnc/subscription (Bearer token)
  │     ├── 200 active  → { allowed: true, daysRemaining, isWarning }
  │     ├── 200 expired → { allowed: false, reason: 'expired' }
  │     └── 401         → clear auth → { allowed: false, reason: 'token_expired' }
  └── Network error → readBncSubCache() → grace period 24h
        ├── cache valid  → { allowed: true, offlineMode: true }
        └── cache stale  → { allowed: false, reason: 'offline_no_cache' }
```

### Auto-renewal via bank transfer (Casso webhook)
```
Bank transfer with content "BNC47"
        │
        ▼
Casso → POST https://yttool.vn/webhook/casso
        │
        ▼
webhook.js: extractTransactionCodes(description)
  → finds /BNC\d+/gi → ['BNC47']
        │
        ▼
processBncPayment(code='BNC47', amount)
  ├── customerId = 47
  ├── BncSubscription.findOne({ customerId })
  ├── Extend endDate +30 days
  └── status = 'active'
```

---

## 6. Profile Launch Flow

```
User clicks "Launch" on a profile
        │
        ▼
renderer: ipcRenderer.invoke('launch-profile', id, watermarkStyle)
        │
        ▼
main.js: launchProfile(id)
  ├── Load profile config (proxy, fingerprint, UA, timezone, ...)
  ├── Start Xray-core with SOCKS5 inbound → proxy outbound
  ├── Build Chrome flags:
  │     --proxy-server=socks5://127.0.0.1:{port}
  │     --user-data-dir=profiles/{id}
  │     --fingerprint-brand / --user-agent / --lang / ...
  └── spawn(chromePath, flags)
        │
        ▼
main.js: sends 'profile-status' { id, running: true } → renderer
renderer: updates row UI (green dot, Stop button)
```

---

## 7. Backend API (yttool.vn — muachungtool)

**Base URL:** `https://yttool.vn/api`

| Route | Auth | Description |
|-------|------|-------------|
| `POST /bnc/login` | None | BNC login, returns JWT + sub |
| `GET /bnc/subscription` | BNC JWT | Current subscription status |
| `GET /bnc/plans` | None | Plan catalogue |
| `GET /bnc/payment-info` | BNC JWT | Bank info for VietQR QR |
| `GET /admin/bnc/subscriptions` | Admin JWT | List all subscriptions |
| `POST /admin/bnc/subscriptions` | Admin JWT | Create subscription |
| `PUT /admin/bnc/:id/renew` | Admin JWT | Extend subscription |
| `PUT /admin/bnc/:id/cancel` | Admin JWT | Cancel subscription |
| `POST /webhook/casso` | HMAC | Bank transfer webhook |

---

## 8. Plans

| Plan | Profiles | Price/month |
|------|----------|-------------|
| Starter | 30 | 199,000đ |
| Pro | 100 | 399,000đ |
| Team | 300 | 699,000đ |
| Scale | 1,000 | 1,299,000đ |

Payment code format: `BNC{customerId}` (e.g. `BNC47`)
Bank: Vietinbank — 102876221138 — NGO VAN PHUC

---

## 9. Key Files

| File | Role |
|------|------|
| `main.js` (~4200 lines) | Main process: IPC, BNC auth, profile launch, Xray |
| `renderer.js` (~3100 lines) | Renderer: all UI logic |
| `index.html` (~2200 lines) | UI markup + CSS |
| `preload.js` (58 lines) | contextBridge — safe IPC bridge |
| `i18n.js` | Translation loader |
| `locales/vi.json`, `locales/en.json` | Translations |
| `utils.js` | Proxy parsing utilities |
| `package.json` | Electron app config, build targets |
