const { app, BrowserWindow, ipcMain, dialog, screen, shell, Tray, Menu, nativeImage, Notification, powerMonitor, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { runVerify } = require('./verify');
const { spawn, exec, execSync } = require('child_process');
const getPort = require('get-port');
const puppeteer = require('puppeteer'); // 使用原生 puppeteer，不带 extra
const { v4: uuidv4 } = require('uuid');
const yaml = require('js-yaml');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const initSqlJs = require('sql.js');

// ─── Stable userData path: pinned to 'BNC' regardless of productName ──────────
// MUST be called before any app.getPath('userData') — all constants below depend on it.
// Pinning prevents data loss when app is renamed or electron-builder productName changes.
{
    const _newData = path.join(app.getPath('appData'), 'BNC');
    app.setPath('userData', _newData);
    // One-time migration: copy existing data from old 'GeekEZ Browser' folder (users upgrading)
    const _oldData = path.join(app.getPath('appData'), 'GeekEZ Browser');
    if (!fs.existsSync(_newData) && fs.existsSync(_oldData)) {
        try { fs.copySync(_oldData, _newData); } catch (e) { /* non-fatal — app still starts clean */ }
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// Native crash dumps (Crashpad), local-only — no data leaves the machine.
// The "Application Popup"/Windows Event Log crashes seen repeatedly (always ending
// in the same low 12 bits, e.g. 0x...0304, across different processes/boots — a
// strong ASLR signature of the same instruction in the same DLL) only gave us a
// bare instruction address with no symbol or stack trace. A real minidump here is
// the only way to actually identify which module/function is at fault instead of
// continuing to guess (GPU driver, AV, etc.).
try {
    const crashDumpsDir = path.join(app.getPath('userData'), 'CrashDumps');
    app.setPath('crashDumps', crashDumpsDir);
    crashReporter.start({
        productName: 'BNC',
        companyName: 'GeekEZ',
        submitURL: 'https://example.invalid/crash-report', // never contacted — uploadToServer is false
        uploadToServer: false,
        compress: true,
    });
} catch (e) { /* non-fatal — app still starts without crash dumps */ }

// Hardware acceleration enabled for better UI performance
// Only disable if GPU compatibility issues occur
//
// Diagnostic evidence pointed here: two "Application Error" crashes (Windows Event
// Log, source "Application Popup") hit the SAME absolute instruction address across
// two unrelated processes (BNC and a plain Chrome window) on this machine, with AV
// (Kaspersky) fully exited beforehand — ruling out an injected security hook. Since
// Windows re-randomizes a system DLL's ASLR base once per boot (not per process),
// two different processes crashing at the identical address is a strong signal they
// both loaded the SAME DLL — most likely the GPU/display driver, since both BNC and
// Chrome are Chromium-based and both hardware-accelerate through it. Disabling GPU
// acceleration in BNC removes BNC's dependency on that driver path entirely; if the
// driver is really at fault, this should stop BNC's crashes even though a separate
// Chrome window would still be exposed to the same bug.
if (process.env.BNC_ENABLE_GPU !== '1') {
    app.disableHardwareAcceleration();
}

const { generateXrayConfig } = require('./utils');
const { generateFingerprint, getInjectScript } = require('./fingerprint');

const isDev = !app.isPackaged;
const RESOURCES_BIN = isDev ? path.join(__dirname, 'resources', 'bin') : path.join(process.resourcesPath, 'bin');
// Use platform+arch specific directory for xray binary
const PLATFORM_ARCH = `${process.platform}-${process.arch}`; // e.g., darwin-arm64, darwin-x64, win32-x64
const BIN_DIR = path.join(RESOURCES_BIN, PLATFORM_ARCH);
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'xray.exe' : 'xray');
// Fallback to old location for backward compatibility
const BIN_DIR_LEGACY = RESOURCES_BIN;
const BIN_PATH_LEGACY = path.join(BIN_DIR_LEGACY, process.platform === 'win32' ? 'xray.exe' : 'xray');
// Use platform-specific path if it exists, otherwise fall back to legacy flat path
const EFFECTIVE_BIN_PATH = fs.existsSync(BIN_PATH) ? BIN_PATH : BIN_PATH_LEGACY;
const EFFECTIVE_BIN_DIR  = fs.existsSync(BIN_PATH) ? BIN_DIR  : BIN_DIR_LEGACY;

// 自定义数据目录支持
const APP_CONFIG_FILE = path.join(app.getPath('userData'), 'app-config.json');
const DEFAULT_DATA_PATH = path.join(app.getPath('userData'), 'BrowserProfiles');
const FINGERPRINT_CHROMIUM_DIR = path.join(app.getPath('userData'), 'fingerprint-chromium');
const CHROME_FOR_TESTING_DIR = path.join(app.getPath('userData'), 'chrome-for-testing');
// Custom Chromium build (user's own fork/build hosted on their GitHub)
// Change CUSTOM_CHROMIUM_REPO to your own repo after running chromium-build scripts
const CUSTOM_CHROMIUM_REPO = 'adryfish/fingerprint-chromium'; // Replace: 'your-username/geekez-chromium'
const CUSTOM_CHROMIUM_DIR = path.join(app.getPath('userData'), 'custom-chromium');

// 读取自定义数据目录
function getCustomDataPath() {
    try {
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = fs.readJsonSync(APP_CONFIG_FILE);
            if (config.customDataPath && fs.existsSync(config.customDataPath)) {
                return config.customDataPath;
            }
        }
    } catch (e) {
        console.error('Failed to read custom data path:', e);
    }
    return DEFAULT_DATA_PATH;
}

const DATA_PATH = getCustomDataPath();
const TRASH_PATH = path.join(app.getPath('userData'), '_Trash_Bin');
const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const GROUPS_FILE   = path.join(DATA_PATH, 'groups.json');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');

fs.ensureDirSync(DATA_PATH);
fs.ensureDirSync(TRASH_PATH);

// Two concurrent callers (e.g. repairing 2 profiles seconds apart) previously
// raced on the SAME fixed "profiles.json.tmp" path: whichever finished first
// renamed it away, so the second caller's rename hit ENOENT — sometimes
// wiping profiles.json in the process. Serialize writes through a queue AND
// give each call its own temp filename so overlapping calls can't collide.
let _writeProfilesQueue = Promise.resolve();
async function writeProfilesAtomic(profiles) {
    const previous = _writeProfilesQueue.catch(() => {}); // don't let a prior failure block later writes
    const run = previous.then(async () => {
        const tmp = `${PROFILES_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeJson(tmp, profiles);
        await fs.move(tmp, PROFILES_FILE, { overwrite: true });
    });
    _writeProfilesQueue = run;
    return run;
}

// ─── Update Check ────────────────────────────────────────────────────────────
const DATA_PATH_CONFIRMED   = path.join(app.getPath('userData'), '.data_path_confirmed');

// ─── BNC Auth ────────────────────────────────────────────────────────────────
const BNC_API       = 'https://yttool.vn/api/bnc';
const BNC_AUTH_FILE  = path.join(app.getPath('userData'), 'bnc_auth.json');
const BNC_TERMS_FILE = path.join(app.getPath('userData'), 'bnc_terms.json');

function saveBncAuth(data) {
    try { fs.writeJsonSync(BNC_AUTH_FILE, data); } catch (_) {}
}

function getSavedBncAuth() {
    try {
        if (fs.existsSync(BNC_AUTH_FILE)) return fs.readJsonSync(BNC_AUTH_FILE);
    } catch (_) {}
    return null;
}

// Gọi muachungtool /api/bnc/login — trả về { accessToken, customer, slots } hoặc null
async function bncLogin(email, password) {
    try {
        const os = require('os');
        const body = JSON.stringify({
            email, password,
            deviceId: getDeviceId(),
            deviceName: os.hostname(),
            platform: `${process.platform}-${process.arch}`,
        });
        const loginUrl = BNC_API + '/login';
        console.log('[DEBUG:BNC_LOGIN] Calling', loginUrl, 'email:', email);
        return await new Promise((resolve) => {
            const url = new URL(loginUrl);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'x-device-id': getDeviceId(),
                    'x-app-version': app.getVersion(),
                },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    console.log('[DEBUG:BNC_LOGIN] HTTP', res.statusCode, 'raw:', data.slice(0, 300));
                    try {
                        const parsed = JSON.parse(data);
                        resolve({ ...parsed, _statusCode: res.statusCode });
                    } catch (e) {
                        console.log('[DEBUG:BNC_LOGIN] JSON parse error:', e.message);
                        resolve(null);
                    }
                });
            });
            req.on('error', (e) => {
                console.log('[DEBUG:BNC_LOGIN] Request error:', e.message);
                resolve(null);
            });
            req.setTimeout(8000, () => {
                console.log('[DEBUG:BNC_LOGIN] Timeout!');
                req.destroy(); resolve(null);
            });
            req.write(body);
            req.end();
        });
    } catch (e) {
        console.log('[DEBUG:BNC_LOGIN] Exception:', e.message);
        return null;
    }
}

// Ping server để verify token + lấy slots mới nhất — trả về { slots, _statusCode } hoặc null
// Gọi /subscription một lần với token cụ thể (không retry)
async function _bncPingOnce(accessToken) {
    try {
        return await new Promise((resolve) => {
            const url = new URL(BNC_API + '/subscription');
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + accessToken,
                    'x-device-id': getDeviceId(),
                    'x-app-version': app.getVersion(),
                },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve({ ...JSON.parse(data), _statusCode: res.statusCode }); } catch (_) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => { req.destroy(); resolve(null); });
            req.end();
        });
    } catch (_) { return null; }
}

// Đổi refreshToken lấy accessToken mới — không cần auth header
async function bncRefreshToken() {
    const auth = getSavedBncAuth();
    if (!auth?.refreshToken) return null;
    try {
        const bodyStr = JSON.stringify({ refreshToken: auth.refreshToken, deviceId: getDeviceId() });
        return await new Promise((resolve) => {
            const url = new URL(BNC_API + '/refresh');
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve({ ...JSON.parse(data), _statusCode: res.statusCode }); } catch (_) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => { req.destroy(); resolve(null); });
            req.write(bodyStr);
            req.end();
        });
    } catch (_) { return null; }
}

async function bncPingServer() {
    const auth = getSavedBncAuth();
    if (!auth || !auth.accessToken) return null;
    try {
        let result = await _bncPingOnce(auth.accessToken);

        // Token hết hạn → thử refresh tự động
        if (result && (result._statusCode === 401 || result._statusCode === 403)) {
            const refreshed = await bncRefreshToken();
            if (refreshed?._statusCode === 200 && refreshed.accessToken) {
                saveBncAuth({ ...auth, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, savedAt: new Date().toISOString() });
                result = await _bncPingOnce(refreshed.accessToken);
            }
        }

        return result;
    } catch (_) { return null; }
}

// Helper: gọi BNC API với auth + deviceId (fire-and-forget sync, không block local op)
async function bncApiCall(method, path, body) {
    const auth = getSavedBncAuth();
    if (!auth || !auth.accessToken) return null;
    try {
        const bodyStr = body ? JSON.stringify(body) : null;
        const url = new URL(BNC_API + path);
        return await new Promise((resolve) => {
            const headers = {
                'Authorization': 'Bearer ' + auth.accessToken,
                'x-device-id': getDeviceId(),
                'Content-Type': 'application/json',
            };
            if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method,
                headers,
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve({ ...JSON.parse(data), _statusCode: res.statusCode }); } catch (_) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(10000, () => { req.destroy(); resolve(null); });
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    } catch (_) { return null; }
}

// Kiểm tra quyền truy cập BNC — chỉ cần đăng nhập (token hợp lệ) là được dùng
// Profile limit do slots kiểm soát, không phải subscription
async function bncCheckAccess() {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) {
        return { allowed: false, reason: 'not_logged_in' };
    }

    const result = await bncPingServer();

    if (result && (result._statusCode === 401 || result._statusCode === 403)) {
        try { fs.removeSync(BNC_AUTH_FILE); } catch (_) {}
        const reason = result.reason === 'device_kicked' ? 'device_kicked' : 'token_invalid';
        return { allowed: false, reason };
    }

    if (!result) {
        // Offline — có token local → vẫn cho vào
        return { allowed: true, offlineMode: true };
    }

    // Cập nhật slots nếu server trả về
    if (result.slots) {
        saveBncAuth({ ...auth, slots: result.slots });
    }

    return { allowed: true, slots: result.slots };
}
// ─────────────────────────────────────────────────────────────────────────────

// Tạo device ID ổn định từ hardware UUID (không thay đổi dù reinstall app)
function getDeviceId() {
    try {
        let raw = '';
        if (process.platform === 'darwin') {
            raw = execSync("ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/{print $3}'")
                .toString().replace(/["\n\r]/g, '').trim();
        } else if (process.platform === 'win32') {
            // wmic bị xóa khỏi Windows 11 24H2+, dùng PowerShell thay thế
            try {
                raw = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', { stdio: ['pipe','pipe','pipe'] })
                    .toString().trim();
            } catch (_) {
                // fallback: registry MachineGuid (ổn định, không cần admin)
                raw = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { stdio: ['pipe','pipe','pipe'] })
                    .toString().match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] || '';
            }
        } else {
            raw = fs.existsSync('/etc/machine-id')
                ? fs.readFileSync('/etc/machine-id', 'utf-8').trim()
                : os.hostname();
        }
        if (!raw) raw = os.hostname() + os.cpus()[0]?.model;
        return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
    } catch (e) {
        const fallbackFile = path.join(app.getPath('userData'), '.device_id');
        if (fs.existsSync(fallbackFile)) return fs.readFileSync(fallbackFile, 'utf-8').trim();
        const id = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(fallbackFile, id);
        return id;
    }
}

// Kiểm tra version mới từ yttool.vn — thay thế heartbeat toolphuc
// Trả về { version, downloadUrl, forceUpdate, releaseNotes, minVersion } hoặc null
async function bncCheckVersion() {
    try {
        return await new Promise((resolve) => {
            const url = new URL(BNC_API + '/version');
            const auth = getSavedBncAuth();
            const headers = {
                'x-app-version':  app.getVersion(),
                'x-app-platform': process.platform,           // 'win32' | 'darwin'
            };
            if (auth?.email) headers['x-bnc-email'] = auth.email;
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'GET',
                headers,
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => { req.destroy(); resolve(null); });
            req.end();
        });
    } catch (_) { return null; }
}

// ─── License Blocked Dialog (custom window với ô nhập key) ───────────────────
// Trả về true nếu user kích hoạt thành công, false nếu đóng app
// ─── BNC Login Dialog — email + password (thay thế license key dialog) ───────
// Trả về true nếu đăng nhập thành công, false nếu user đóng app
function showBncLoginDialog(access) {
    return new Promise((resolve) => {
        const msg = access.message || 'Đăng nhập tài khoản BNC để tiếp tục sử dụng.';
        const isExpired = access.reason === 'expired';

        const win = new BrowserWindow({
            width: 420,
            height: isExpired ? 300 : 380,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            center: true,
            title: 'BNC — Đăng nhập',
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        const BNC_LOGIN_URL = BNC_API + '/login';

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  body { background:#1a1a2e; color:#e0e0e0; padding:24px; display:flex; flex-direction:column; gap:14px; height:100vh; }
  .logo { font-size:20px; font-weight:800; color:#4a9eff; letter-spacing:2px; }
  .msg { font-size:13px; color:${isExpired ? '#ff9966' : '#aaa'}; line-height:1.5; }
  label { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.5px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #333; background:#111; color:#e0e0e0; font-size:13px; outline:none; }
  input:focus { border-color:#4a9eff; }
  .row { display:flex; gap:10px; }
  .btn { flex:1; padding:10px; border-radius:8px; border:none; cursor:pointer; font-size:13px; font-weight:600; }
  .btn-login { background:#4a9eff; color:#fff; }
  .btn-login:disabled { background:#1a3a5e; color:#555; cursor:default; }
  .btn-close { background:#2a2a2a; color:#aaa; }
  .err { font-size:12px; color:#ff6666; min-height:16px; }
  .ok  { font-size:12px; color:#4CAF50; min-height:16px; }
  .field { display:flex; flex-direction:column; gap:4px; }
</style></head><body>
  <div class="logo">BNC Browser</div>
  <div class="msg">${msg.replace(/</g,'&lt;')}</div>
  ${isExpired ? '' : `
  <div class="field"><label>Email</label><input id="email" type="email" placeholder="email@example.com" autofocus></div>
  <div class="field"><label>Mật khẩu</label><input id="pass" type="password" placeholder="Mật khẩu"></div>
  `}
  <div id="status" class="err"></div>
  <div class="row">
    <button class="btn btn-close" onclick="window.close()">Thoát</button>
    ${isExpired
        ? '<button class="btn btn-login" onclick="window.location.href=\'activate://renew\'">Liên hệ gia hạn</button>'
        : '<button class="btn btn-login" id="lb" onclick="doLogin()">Đăng nhập</button>'
    }
  </div>
<script>
  const BNC_LOGIN_URL = '${BNC_LOGIN_URL}';
  document.addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
  async function doLogin() {
    const email = (document.getElementById('email')||{}).value?.trim();
    const pass  = (document.getElementById('pass')||{}).value;
    if (!email || !pass) { setStatus('Vui lòng nhập đầy đủ email và mật khẩu'); return; }
    const lb = document.getElementById('lb');
    lb.disabled = true; lb.textContent = 'Đang đăng nhập...';
    setStatus('');
    try {
      const r = await fetch(BNC_LOGIN_URL, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, password: pass })
      });
      const data = await r.json();
      if (r.ok && data.accessToken) {
        setStatus('✅ Đăng nhập thành công! Đang khởi động...', true);
        // Pass token + customer info back to main via navigate
        const cid = (data.customer && data.customer.id) ? data.customer.id : '';
        setTimeout(() => {
          window.location.href = 'bnc-auth://ok?token=' + encodeURIComponent(data.accessToken) + '&email=' + encodeURIComponent(email) + '&cid=' + cid;
        }, 800);
      } else {
        setStatus('❌ ' + (data.message || 'Đăng nhập thất bại'));
        lb.disabled = false; lb.textContent = 'Đăng nhập';
      }
    } catch(e) {
      setStatus('❌ Không kết nối được server. Kiểm tra lại mạng.');
      lb.disabled = false; lb.textContent = 'Đăng nhập';
    }
  }
  function setStatus(t, ok) {
    const el = document.getElementById('status');
    el.textContent = t;
    el.className = ok ? 'ok' : 'err';
  }
</script></body></html>`;

        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

        let resolved = false;

        win.webContents.on('will-navigate', (e, navUrl) => {
            if (navUrl.startsWith('bnc-auth://ok')) {
                e.preventDefault();
                try {
                    const params = new URL(navUrl.replace('bnc-auth://ok', 'http://x'));
                    const token = params.searchParams.get('token');
                    const email = params.searchParams.get('email');
                    const customerId = params.searchParams.get('cid') || null;
                    if (token) saveBncAuth({ accessToken: token, email, customerId, savedAt: new Date().toISOString() });
                } catch (_) {}
                resolved = true;
                win.close();
                resolve(true);
            } else if (navUrl.startsWith('activate://renew')) {
                e.preventDefault();
                shell.openExternal('https://yttool.vn');
            }
        });

        win.on('closed', () => {
            if (!resolved) resolve(false);
        });

        win.once('ready-to-show', () => win.show());
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Update Check ────────────────────────────────────────────────────────────
// ─── Auto Updater — electron-updater, generic provider yttool.vn/updates ─────
const { autoUpdater } = require('electron-updater');
let updatePromptShownForVersion = null;

// A custom auto-relaunch (spawning a detached batch script to wait for the installer
// to finish, then relaunch BNC.exe) was tried here across several iterations — a
// flat `ping`-based delay, then `choice`, then a VBS console-hiding wrapper, then a
// pure `tasklist`-paced loop with no delay command at all. Every variant kept
// showing visible (sometimes stuck) console windows on at least one real machine
// regardless of `windowsHide`, and one variant vanished with zero trace at all (no
// crash dump, no Application Error, no AV block). Reverted to electron-updater's
// own quitAndInstall(isSilent, isForceRunAfter) — see the comments at its two call
// sites below for why the historical reason for avoiding it (installer spawned as
// this process's own child, killed by installer.nsh's old `taskkill /T` on BNC.exe)
// no longer applies, since that /T was removed independently of this update flow.

function setupAutoUpdater() {
    autoUpdater.autoDownload    = true;
    // Mac: shell script handles install — disabling autoInstallOnAppQuit prevents Squirrel.Mac
    // from staging the update and blocking the next startup (unsigned app → Squirrel install fails)
    autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';

    // Unsigned Mac build — skip signature verification so the extracted zip can replace the app
    if (process.platform === 'darwin') {
        autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(undefined);
    }

    // Route electron-updater logs to debug log file (was null — silent)
    autoUpdater.logger = {
        info:  (msg) => debugLog('UPDATER', { level: 'info',  msg: String(msg) }),
        warn:  (msg) => debugLog('UPDATER', { level: 'warn',  msg: String(msg) }),
        error: (msg) => debugLog('UPDATER', { level: 'error', msg: String(msg) }),
        debug: () => {},
    };

    autoUpdater.on('update-available', (info) => {
        console.log(`[UPDATE] Bản mới: v${info.version} — đang tải ngầm...`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-downloading', { version: info.version });
        }
    });

    autoUpdater.on('download-progress', (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-progress', { percent: Math.round(progress.percent) });
        }
    });

    autoUpdater.on('update-downloaded', async (info) => {
        // Heartbeat mỗi 5 phút gọi checkForUpdates() lại — nếu không guard, dialog
        // "Cập nhật sẵn sàng" sẽ hiện lại liên tục mỗi 5 phút kể cả khi user đã
        // chọn "Để sau". Chỉ hỏi 1 lần cho mỗi version trong phiên chạy hiện tại.
        if (updatePromptShownForVersion === info.version) return;
        updatePromptShownForVersion = info.version;

        console.log(`[UPDATE] Đã tải xong v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-ready', { version: info.version });
        }
        // Lấy forceUpdate + releaseNotes từ BNC server
        const versionResult = await bncCheckVersion().catch(() => null);
        const forceUpdate   = versionResult?.forceUpdate === true;
        const notes         = versionResult?.releaseNotes || info.releaseNotes || '';
        const noteText      = notes ? `\n\n${notes}` : '';

        if (forceUpdate) {
            const plainNotesForce = noteText.replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
            if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
            try {
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'Cập nhật bắt buộc',
                    message: `BNC Browser v${info.version} yêu cầu cập nhật bắt buộc`,
                    detail: `Ứng dụng sẽ tự động khởi động lại ngay bây giờ.${plainNotesForce ? '\n\n' + plainNotesForce : ''}`,
                    buttons: ['Cài ngay'],
                });
            } catch (_) { /* timeout — install anyway */ }
            const kills = Object.values(activeProcesses).map(async p => {
                try { await forceKill(p.xrayPid); } catch (_) {}
                try { if (p.chromeProcess?.pid) await forceKill(p.chromeProcess.pid); } catch (_) {}
            });
            await Promise.all(kills);
            activeProcesses = {};
            await new Promise(r => setTimeout(r, 600));
            app.isQuiting = true;
            if (process.platform === 'darwin') {
                const zipPath2 = info.downloadedFile
                    || path.join(os.homedir(), 'Library', 'Caches', 'geekez-browser-updater', 'pending', `BNC-${info.version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`);
                const tmpDir2  = path.join(os.tmpdir(), `bnc-apply-${info.version}`);
                const script2  = [
                    '#!/bin/bash', 'sleep 3',
                    `rm -rf "${tmpDir2}"`, `mkdir -p "${tmpDir2}"`,
                    `ditto -x -k "${zipPath2}" "${tmpDir2}"`,
                    `rm -rf /Applications/BNC.app`,
                    `ditto "${tmpDir2}/BNC.app" /Applications/BNC.app`,
                    `open /Applications/BNC.app`,
                ].join('\n');
                const sp2 = path.join(os.tmpdir(), 'bnc-update-force.sh');
                fs.writeFileSync(sp2, script2, { mode: 0o755 });
                spawn('bash', [sp2], { detached: true, stdio: 'ignore' }).unref();
                app.quit();
            } else {
                // electron-updater's own mechanism (isSilent, isForceRunAfter) — see the
                // long comment above scheduleWinRelaunch's old definition for why a custom
                // batch-script relaunch was tried and abandoned (visible/stuck console
                // windows on at least one real machine, regardless of windowsHide).
                autoUpdater.quitAndInstall(true, true);
            }
            return;
        }

        // Strip HTML tags khỏi notes (native dialog chỉ hiển thị plain text)
        const plainNotes = noteText.replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();

        // Focus window trước khi show dialog — tránh macOS timeout dialog khi app ở background
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }

        let response = 1; // default: "Để sau"
        try {
            const result = await dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: `Cập nhật sẵn sàng — v${info.version}`,
                message: `BNC Browser ${info.version} đã tải về thành công`,
                detail: `Click "Cài & Khởi động lại" để áp dụng.${plainNotes ? '\n\n' + plainNotes : ''}`,
                buttons: ['Cài & Khởi động lại', 'Để sau'],
                defaultId: 0, cancelId: 1,
            });
            response = result.response;
        } catch (dlgErr) {
            // Dialog bị timeout (macOS dismiss khi app mất focus) — bỏ qua, user có thể dùng nút trong UI
            debugLog('UPDATER', { level: 'warn', msg: `showMessageBox timed out: ${dlgErr.message}` });
        }

        if (response === 0) {
            // Kill tất cả child processes trước khi cài — tránh NSIS "Failed to uninstall" (file bị lock)
            const kills = Object.values(activeProcesses).map(async p => {
                try { await forceKill(p.xrayPid); } catch (_) {}
                try { if (p.chromeProcess?.pid) await forceKill(p.chromeProcess.pid); } catch (_) {}
            });
            await Promise.all(kills);
            activeProcesses = {};
            await new Promise(r => setTimeout(r, 600)); // cho OS release file lock
            app.isQuiting = true;
            if (process.platform === 'darwin') {
                // Mac: Squirrel.Mac (dùng bởi quitAndInstall) yêu cầu code signing → không apply được.
                // Dùng shell script detached: extract zip → ditto replace app → open lại.
                const zipPath = info.downloadedFile
                    || path.join(os.homedir(), 'Library', 'Caches', 'geekez-browser-updater', 'pending', `BNC-${info.version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`);
                const tmpDir  = path.join(os.tmpdir(), `bnc-apply-${info.version}`);
                const script  = [
                    '#!/bin/bash',
                    'sleep 3',
                    `rm -rf "${tmpDir}"`,
                    `mkdir -p "${tmpDir}"`,
                    `ditto -x -k "${zipPath}" "${tmpDir}"`,
                    `rm -rf /Applications/BNC.app`,
                    `ditto "${tmpDir}/BNC.app" /Applications/BNC.app`,
                    `open /Applications/BNC.app`,
                ].join('\n');
                const scriptPath = path.join(os.tmpdir(), 'bnc-update.sh');
                fs.writeFileSync(scriptPath, script, { mode: 0o755 });
                debugLog('UPDATER', { level: 'info', msg: `Spawning update script: ${scriptPath}` });
                spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
                app.quit();
            } else {
                // Win: electron-updater's own quitAndInstall(isSilent, isForceRunAfter) —
                // NSIS relaunches the app itself once the install finishes. The earlier
                // avoidance of this API was about quitAndInstall spawning the installer as
                // this process's own child before quitting, which used to matter when
                // installer.nsh's preInit still killed BNC.exe with taskkill /T (that /T
                // cascaded down and killed the installer too, since it was a child at that
                // point) — that /T was removed independently of this update-flow change, so
                // the original hazard no longer applies. A custom batch-script relaunch
                // (tasklist polling, no ping/choice/VBS — those were each tried and dropped
                // for being unreliable outside a real console) still showed visible/stuck
                // console windows on at least one real machine regardless of windowsHide;
                // reverting to the library's own well-tested path instead of continuing to
                // chase that.
                autoUpdater.quitAndInstall(true, true);
            }
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('[UPDATE] electron-updater error:', err.message);
        // Mac: ditto script xử lý install — không mở browser
        if (process.platform === 'darwin') return;
        // Win: fallback mở browser nếu electron-updater thất bại
        bncCheckVersion().then(v => { if (v) _checkVersionFallback(v); }).catch(() => {});
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// --- Debug logger (writes to DATA_PATH/geekez_debug.log) ---
const DEBUG_LOG = path.join(DATA_PATH, 'geekez_debug.log');
function debugLog(tag, obj) {
    try {
        const line = `[${new Date().toISOString()}] [${tag}] ${JSON.stringify(obj, null, 2)}\n${'='.repeat(80)}\n`;
        fs.appendFileSync(DEBUG_LOG, line);
        console.log(`[DEBUG:${tag}]`, JSON.stringify(obj));
    } catch(e) {}
}

// --- Fatal crash capture: main-process uncaught errors, renderer crashes, GPU/utility crashes ---
// None of these were previously logged anywhere — a main-process uncaughtException already
// terminated the app silently (Node's default with no listener), and a renderer/GPU crash left
// the window blank with zero trace. Logs locally always; also best-effort pushes to the BNC
// server via the existing logged-in-only bncApiCall('/crash-report') channel so support can see
// it without asking the customer for their log file.
function reportAppCrash(reason, extra) {
    debugLog('FATAL', { level: 'error', msg: reason, ...extra });
    bncApiCall('POST', '/crash-report', {
        type: 'app-crash', reason,
        deviceId: getDeviceId(), deviceName: os.hostname(),
        appVersion: app.getVersion(), platform: process.platform, osRelease: os.release(),
        uptimeMs: Math.round(process.uptime() * 1000),
        ...extra,
    }).catch(() => {});
}

process.on('uncaughtException', (err) => {
    // Preserves Node's default behavior (process would already exit here with no listener
    // attached) — just gives the crash a local + server record before it does.
    reportAppCrash('uncaughtException', { error: err.message, stack: err.stack });
    setTimeout(() => app.exit(1), 1500);
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reportAppCrash('unhandledRejection', { error: err.message, stack: err.stack });
});

app.on('render-process-gone', (_event, _webContents, details) => {
    reportAppCrash(`render-process-gone-${details.reason}`, { exitCode: details.exitCode });
});

app.on('child-process-gone', (_event, details) => {
    reportAppCrash(`child-process-gone-${details.type}-${details.reason}`, { exitCode: details.exitCode });
});

// System sleep/wake — a prior silent disappearance landed right after a resume-from-sleep,
// which is a known trigger for GPU/driver-level Chromium crashes that die before any of the
// JS-level handlers above can fire. Logging suspend/resume so the next occurrence can be
// timed against it directly instead of inferred from Windows power event logs after the fact.
app.whenReady().then(() => {
    powerMonitor.on('suspend', () => debugLog('POWER', { level: 'info', msg: 'system suspend (sleep)', uptimeMs: Math.round(process.uptime() * 1000) }));
    powerMonitor.on('resume', () => debugLog('POWER', { level: 'info', msg: 'system resume (wake)', uptimeMs: Math.round(process.uptime() * 1000) }));
    powerMonitor.on('lock-screen', () => debugLog('POWER', { level: 'info', msg: 'lock-screen' }));
    powerMonitor.on('unlock-screen', () => debugLog('POWER', { level: 'info', msg: 'unlock-screen' }));
});
// ─────────────────────────────────────────────────────────────────────────────

let activeProcesses = {};
let apiServer = null;
let apiServerRunning = false;
let mainWindow = null; // Global reference for API-to-UI communication

// ============================================================================
// REST API Server
// ============================================================================
function createApiServer(port, apiKey) {
    const server = http.createServer(async (req, res) => {
        // CORS: restrict to localhost only (server is bound to 127.0.0.1)
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // API key authentication
        if (apiKey) {
            const providedKey = req.headers['x-api-key'] || new URL(req.url, `http://localhost:${port}`).searchParams.get('api_key');
            if (providedKey !== apiKey) {
                res.writeHead(401);
                res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                return;
            }
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        // Parse body for POST/PUT
        let body = '';
        if (method === 'POST' || method === 'PUT') {
            body = await new Promise(resolve => {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => resolve(data));
            });
        }

        try {
            const result = await handleApiRequest(method, pathname, body, url.searchParams);
            res.writeHead(result.status || 200);
            res.end(JSON.stringify(result.data || result));
        } catch (err) {
            console.error('API Error:', err);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    return server;
}

// 2. 仅用于扩展密码同步的内部服务器 (独立端口 12139，无条件常驻)
let internalApiServer = null;
const INTERNAL_API_PORT = 12139;

function createInternalApiServer() {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        const url = new URL(req.url, `http://localhost:${INTERNAL_API_PORT}`);

        // Kích hoạt license từ blocked dialog (không qua preload vì dialog dùng data: URL)
        if (req.method === 'POST' && url.pathname === '/api/activate-license') {
            // Legacy endpoint — BNC dùng subscription thay license key
            res.writeHead(410); return res.end(JSON.stringify({ success: false, message: 'License key không còn được hỗ trợ. Dùng tài khoản BNC.' }));
        }

        if (req.method === 'POST' && url.pathname === '/api/passwords/sync') {
            let body = await new Promise(resolve => {
                let data = ''; req.on('data', chunk => data += chunk); req.on('end', () => resolve(data));
            });
            try {
                const data = JSON.parse(body);
                if (!data.profileId || !data.passwords) {
                    res.writeHead(400); return res.end(JSON.stringify({ success: false, error: 'profileId and passwords required' }));
                }
                const pwFile = require('path').join(DATA_PATH, data.profileId, 'passwords.json');
                await require('fs-extra').ensureDir(require('path').dirname(pwFile));
                await writeEncryptedPasswords(pwFile, data.passwords, data.profileId);
                res.writeHead(200); res.end(JSON.stringify({ success: true, count: data.passwords.length }));
            } catch (err) {
                res.writeHead(500); res.end(JSON.stringify({ success: false, error: err.message }));
            }
        } else {
            res.writeHead(404); res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
        }
    });
    return server;
}

// --- Browser data backup helper (module scope) ---
const backupExcludeDirs = new Set([
    'Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache',
    'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'Service Worker',
    'component_crx_cache', 'extensions_crx_cache', 'blob_storage',
    'File System', 'IndexedDB', 'CertificateRevocation',
    'Safe Browsing', 'BudgetDatabase', 'Platform Notifications',
    'Storage', 'databases', 'Session Storage'
]);

async function collectDirRecursive(dirPath, basePath) {
    const files = {};
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        // Normalize to forward slashes for cross-platform compatibility (Win -> Mac)
        const relativePath = path.relative(basePath, fullPath).split(path.sep).join('/');
        if (entry.isDirectory()) {
            if (backupExcludeDirs.has(entry.name)) continue;
            const subFiles = await collectDirRecursive(fullPath, basePath);
            Object.assign(files, subFiles);
        } else if (entry.isFile()) {
            try {
                const content = await fs.readFile(fullPath);
                files[relativePath] = content.toString('base64');
            } catch (err) {
                console.error(`Failed to read ${relativePath}:`, err.message);
            }
        }
    }
    return files;
}

// --- Chrome 密码解密辅助函数 ---
// 解密 Chrome 主密钥 (平台相关)
async function handleApiRequest(method, pathname, body, params) {
    let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};

    // Helper: Find profile by ID or Name
    const findProfile = (idOrName) => {
        return profiles.find(p => p.id === idOrName || p.name === idOrName);
    };

    // Helper: Generate unique name
    const generateUniqueName = (baseName) => {
        if (!profiles.find(p => p.name === baseName)) return baseName;
        let suffix = 2;
        while (profiles.find(p => p.name === `${baseName}-${String(suffix).padStart(2, '0')}`)) {
            suffix++;
        }
        return `${baseName}-${String(suffix).padStart(2, '0')}`;
    };

    // GET /api/status
    if (method === 'GET' && pathname === '/api/status') {
        return { success: true, running: Object.keys(activeProcesses), count: Object.keys(activeProcesses).length };
    }

    // GET /api/profiles
    if (method === 'GET' && pathname === '/api/profiles') {
        return { success: true, profiles: profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags, running: !!activeProcesses[p.id] })) };
    }

    // GET /api/profiles/:idOrName
    const profileMatch = pathname.match(/^\/api\/profiles\/([^\/]+)$/);
    if (method === 'GET' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        return { success: true, profile: { ...profile, running: !!activeProcesses[profile.id] } };
    }

    // POST /api/profiles - Create with unique name
    if (method === 'POST' && pathname === '/api/profiles') {
        const data = JSON.parse(body);
        const id = uuidv4();
        const fingerprint = await generateFingerprint({});
        const baseName = data.name || `Profile-${Date.now()}`;
        const uniqueName = generateUniqueName(baseName);
        const newProfile = {
            id,
            name: uniqueName,
            proxyStr: data.proxyStr || '',
            tags: data.tags || [],
            fingerprint,
            createdAt: Date.now()
        };
        profiles.push(newProfile);
        await writeProfilesAtomic(profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, profile: newProfile };
    }

    // PUT /api/profiles/:idOrName - Edit
    if (method === 'PUT' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const idx = profiles.findIndex(p => p.id === profile.id);
        const data = JSON.parse(body);
        // If name changed, ensure uniqueness
        if (data.name && data.name !== profile.name) {
            data.name = generateUniqueName(data.name);
        }
        profiles[idx] = { ...profiles[idx], ...data };
        await writeProfilesAtomic(profiles);
        return { success: true, profile: profiles[idx] };
    }

    // DELETE /api/profiles/:idOrName
    if (method === 'DELETE' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        profiles = profiles.filter(p => p.id !== profile.id);
        await writeProfilesAtomic(profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, message: 'Profile deleted' };
    }

    // GET /api/open/:idOrName - Launch profile
    const openMatch = pathname.match(/^\/api\/open\/([^\/]+)$/);
    if (method === 'GET' && openMatch) {
        const profile = findProfile(decodeURIComponent(openMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        if (activeProcesses[profile.id]) return { success: true, message: 'Already running', profileId: profile.id };
        // Trigger launch via IPC to main window
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('api-launch-profile', profile.id);
        }
        return { success: true, message: 'Launch requested', profileId: profile.id, name: profile.name };
    }

    // POST /api/profiles/:idOrName/stop - Stop profile
    const stopMatch = pathname.match(/^\/api\/profiles\/([^\/]+)\/stop$/);
    if (method === 'POST' && stopMatch) {
        const profile = findProfile(decodeURIComponent(stopMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const proc = activeProcesses[profile.id];
        if (!proc) return { status: 404, data: { success: false, error: 'Profile not running' } };
        await forceKill(proc.xrayPid);
        try { await forceKill(proc.chromeProcess?.pid); } catch (e) { }
        if (proc.logFd !== undefined) {
            try { fs.closeSync(proc.logFd); } catch (e) { }
        }
        delete activeProcesses[profile.id];
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('profile-stopped', profile.id);
        }
        return { success: true, message: 'Profile stopped' };
    }



    // GET /api/export/all?password=xxx - Export full backup (v2)
    if (method === 'GET' && pathname === '/api/export/all') {
        const password = params.get('password');
        if (!password) return { status: 400, data: { success: false, error: 'Password required. Use ?password=yourpassword' } };

        const backupData = {
            version: 2,
            createdAt: Date.now(),
            profiles: profiles.map(p => ({ ...p, fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint })),
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // 1. 文件拷贝
        const filesToBackup = [
            'Bookmarks', 'Bookmarks.bak', 'History', 'History-journal',
            'Favicons', 'Favicons-journal', 'Preferences', 'Secure Preferences',
            'Top Sites', 'Top Sites-journal', 'Web Data', 'Web Data-journal'
        ];
        const chromePath = getChromiumPath();
        for (const profile of profiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            const defaultDir = path.join(profileDataDir, 'Default');
            if (!fs.existsSync(defaultDir)) continue;
            const browserFiles = {};
            for (const f of filesToBackup) {
                const fp = path.join(defaultDir, f);
                if (fs.existsSync(fp)) {
                    try { browserFiles[f] = (await fs.readFile(fp)).toString('base64'); } catch (e) { }
                }
            }
            if (Object.keys(browserFiles).length > 0) backupData.browserData[profile.id] = browserFiles;

            // 2. CDP Cookie + 密码解密
            if (!backupData.browserData[profile.id]) backupData.browserData[profile.id] = {};
            try {
                const browser = await puppeteer.launch({
                    headless: 'new', executablePath: chromePath, userDataDir: profileDataDir,
                    args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu',
                           '--disable-features=LockProfileCookieDatabase'],
                    defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
                });
                const client = await browser.target().createCDPSession();
                const { cookies } = await client.send('Network.getAllCookies');
                await browser.close();
                backupData.browserData[profile.id]._cookies = cookies;
            } catch (err) { }
            try {
                const pwJsonFile = path.join(DATA_PATH, profile.id, 'passwords.json');
                const passwords = await readEncryptedPasswords(pwJsonFile, profile.id);
                if (passwords.length > 0) backupData.browserData[profile.id]._passwords = passwords;
            } catch (err) { }
        }

        const jsonStr = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonStr, 'utf8'));
        const encrypted = encryptData(compressed, password);

        return {
            success: true,
            data: encrypted.toString('base64'),
            filename: `BNC_FullBackup_${Date.now()}.bnc`,
            profileCount: profiles.length
        };
    }

    // GET /api/export/fingerprint - Export YAML fingerprints
    if (method === 'GET' && pathname === '/api/export/fingerprint') {
        const exportData = profiles.map(p => ({
            id: p.id,
            name: p.name,
            proxyStr: p.proxyStr,
            tags: p.tags,
            fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint
        }));
        const yamlStr = yaml.dump(exportData, { lineWidth: -1, noRefs: true });
        return {
            success: true,
            data: yamlStr,
            filename: `BNC_Profiles_${Date.now()}.yaml`,
            profileCount: profiles.length
        };
    }

    // POST /api/import - Import backup (YAML or encrypted)
    if (method === 'POST' && pathname === '/api/import') {
        try {
            const data = JSON.parse(body);
            const content = data.content;
            const password = data.password;

            if (!content) return { status: 400, data: { success: false, error: 'Content required' } };

            // Try YAML first
            try {
                const yamlData = yaml.load(content);
                if (Array.isArray(yamlData)) {
                    let imported = 0;
                    for (const item of yamlData) {
                        const name = generateUniqueName(item.name || `Imported-${Date.now()}`);
                        const fp = item.fingerprint || generateFingerprint();
                        normalizeFingerprintForPlatform(fp);
                        const newProfile = {
                            id: uuidv4(),
                            name,
                            proxyStr: item.proxyStr || '',
                            tags: item.tags || [],
                            fingerprint: fp,
                            createdAt: Date.now()
                        };
                        profiles.push(newProfile);
                        imported++;
                    }
                    await writeProfilesAtomic(profiles);
                    notifyUIRefresh(); // Notify UI to refresh
                    return { success: true, message: `Imported ${imported} profiles from YAML`, count: imported };
                }
            } catch (yamlErr) { }

            // Try encrypted backup
            if (!password) return { status: 400, data: { success: false, error: 'Password required for encrypted backup' } };

            try {
                const encrypted = Buffer.from(content, 'base64');
                const decrypted = decryptData(encrypted, password);
                const decompressed = await gunzip(decrypted);
                const backupData = JSON.parse(decompressed.toString('utf8'));

                let imported = 0;
                for (const profile of backupData.profiles || []) {
                    const name = generateUniqueName(profile.name);
                    normalizeFingerprintForPlatform(profile.fingerprint);
                    const newProfile = { ...profile, id: uuidv4(), name };
                    profiles.push(newProfile);
                    imported++;
                }
                await writeProfilesAtomic(profiles);
                notifyUIRefresh(); // Notify UI to refresh
                return { success: true, message: `Imported ${imported} profiles from backup`, count: imported };
            } catch (decryptErr) {
                return { status: 400, data: { success: false, error: 'Invalid password or corrupted backup' } };
            }
        } catch (err) {
            return { status: 400, data: { success: false, error: err.message } };
        }
    }

    return { status: 404, data: { success: false, error: 'Endpoint not found' } };
}

// API Server IPC handlers
ipcMain.handle('start-api-server', async (_, { port }) => {
    if (apiServerRunning) {
        return { success: false, error: 'API server already running' };
    }
    try {
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
        apiServer = createApiServer(port, settings.apiKey || null);
        await new Promise((resolve, reject) => {
            apiServer.listen(port, '127.0.0.1', () => resolve());
            apiServer.on('error', reject);
        });
        apiServerRunning = true;
        console.log(`🔌 API Server started on http://localhost:${port}`);
        return { success: true, port };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('stop-api-server', async () => {
    if (!apiServer) return { success: true };
    return new Promise(resolve => {
        apiServer.close(() => {
            apiServer = null;
            apiServerRunning = false;
            console.log('🔌 API Server stopped');
            resolve({ success: true });
        });
    });
});

ipcMain.handle('get-api-status', () => {
    return { running: apiServerRunning };
});


function forceKill(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        try {
            if (process.platform === 'win32') exec(`taskkill /pid ${pid} /T /F`, () => resolve());
            else { process.kill(pid, 'SIGKILL'); resolve(); }
        } catch (e) { resolve(); }
    });
}

function getChromiumPath() {
    // 1. Custom binary from settings (highest priority — Fingerprint-Chromium etc.)
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (s.customChromePath && fs.existsSync(s.customChromePath)) {
                console.log('[Chrome] Using custom binary:', s.customChromePath);
                return s.customChromePath;
            }
        }
    } catch (e) {}

    // 1.4. Custom Chromium build (user's own build from chromium-build/ scripts)
    // This has C++ level anti-detect patches - highest quality fingerprinting
    const customPath = getCustomChromiumPath();
    if (customPath) {
        console.log('[Chrome] Using Custom Chromium (C++ patches):', customPath);
        return customPath;
    }

    // 1.5. Auto-downloaded Chrome for Testing (Google official Chromium — real canvas hash)
    const cftPath = getChromeForTestingPath();
    if (cftPath) {
        console.log('[Chrome] Using Chrome for Testing:', cftPath);
        return cftPath;
    }

    // 1.6. Auto-downloaded Fingerprint-Chromium (adryfish — Ungoogled Chromium base)
    const fpPath = getFingerprintChromiumPath();
    if (fpPath) {
        console.log('[Chrome] Using Fingerprint-Chromium:', fpPath);
        return fpPath;
    }

    // 2. Bundled Chrome for Testing (original behavior)
    const basePath = isDev ? path.join(__dirname, 'resources', 'puppeteer') : path.join(process.resourcesPath, 'puppeteer');
    function findFile(dir, filename) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) { const res = findFile(fullPath, filename); if (res) return res; }
                else if (file === filename) return fullPath;
            }
        } catch (e) { return null; } return null;
    }
    if (fs.existsSync(basePath)) {
        const bundled = process.platform === 'darwin'
            ? findFile(basePath, 'Google Chrome for Testing')
            : findFile(basePath, 'chrome.exe');
        if (bundled) return bundled;
    }

    // 3. Real Chrome installed on machine (fallback — better hardware fingerprint than Chrome for Testing)
    if (process.platform === 'win32') {
        const candidates = [
            path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
        for (const c of candidates) { if (fs.existsSync(c)) { console.log('[Chrome] Using real Chrome:', c); return c; } }
    } else if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
        for (const c of candidates) { if (fs.existsSync(c)) return c; }
    } else {
        const candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
        for (const c of candidates) { if (fs.existsSync(c)) return c; }
    }

    return null;
}

// Chrome for Testing (Google official Chromium) helpers
function getChromeForTestingPath() {
    try {
        const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
        const candidate = path.join(CHROME_FOR_TESTING_DIR, exe);
        if (fs.existsSync(candidate)) return candidate;
    } catch (e) {}
    return null;
}

function isChromeForTesting(chromePath) {
    if (!chromePath) return false;
    return chromePath.replace(/\\/g, '/').startsWith(CHROME_FOR_TESTING_DIR.replace(/\\/g, '/'));
}

// Fingerprint-Chromium (adryfish/fingerprint-chromium) helpers
function getFingerprintChromiumPath() {
    try {
        const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
        const candidate = path.join(FINGERPRINT_CHROMIUM_DIR, exe);
        if (fs.existsSync(candidate)) return candidate;
    } catch (e) {}
    return null;
}

function isFingerprintChromium(chromePath) {
    if (!chromePath) return false;
    return chromePath.replace(/\\/g, '/').startsWith(FINGERPRINT_CHROMIUM_DIR.replace(/\\/g, '/'));
}

// FNV-1a 32-bit hash → deterministic seed per profile
function getFingerprintSeed(noiseSeed) {
    if (!noiseSeed) return Math.floor(Math.random() * 2147483647);
    const str = String(noiseSeed);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) & 0x7FFFFFFF;
}

// Settings management
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return { enableRemoteDebugging: false };
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        console.error('Failed to save settings:', e);
        return false;
    }
}

// IP Geolocation Detection for Auto-Detect Feature
// Map country to primary language code
function getLanguageFromCountry(country) {
    const countryLanguageMap = {
        'Australia': 'en-AU',
        'United States': 'en-US',
        'United Kingdom': 'en-GB',
        'Canada': 'en-CA',
        'Germany': 'de-DE',
        'France': 'fr-FR',
        'Spain': 'es-ES',
        'Italy': 'it-IT',
        'Japan': 'ja-JP',
        'China': 'zh-CN',
        'South Korea': 'ko-KR',
        'Brazil': 'pt-BR',
        'Mexico': 'es-MX',
        'Netherlands': 'nl-NL',
        'The Netherlands': 'nl-NL',
        'Russia': 'ru-RU',
        'India': 'en-IN',
        'Singapore': 'en-SG',
        'Hong Kong': 'zh-HK',
        'Taiwan': 'zh-TW',
        'Thailand': 'th-TH',
        'Vietnam': 'vi-VN',
        'Indonesia': 'id-ID',
        'Malaysia': 'ms-MY',
        'Philippines': 'en-PH',
        'Poland': 'pl-PL',
        'Turkey': 'tr-TR',
        'Sweden': 'sv-SE',
        'Norway': 'no-NO',
        'Denmark': 'da-DK',
        'Finland': 'fi-FI',
        'Austria': 'de-AT',
        'Switzerland': 'de-CH',
        'Belgium': 'nl-BE',
        'Portugal': 'pt-PT',
        'Greece': 'el-GR',
        'Czech Republic': 'cs-CZ',
        'Romania': 'ro-RO',
        'Hungary': 'hu-HU',
        'Ukraine': 'uk-UA',
        'Argentina': 'es-AR',
        'Chile': 'es-CL',
        'Colombia': 'es-CO',
        'Peru': 'es-PE',
        'Venezuela': 'es-VE',
        'South Africa': 'en-ZA',
        'Egypt': 'ar-EG',
        'Saudi Arabia': 'ar-SA',
        'United Arab Emirates': 'ar-AE',
        'Israel': 'he-IL',
        'New Zealand': 'en-NZ',
        'Ireland': 'en-IE'
    };
    return countryLanguageMap[country] || 'en-US';
}

// Detect proxy IP geolocation using ip-api.com (free, no API key needed)
async function getProxyGeolocation(proxyStr) {
    try {
        // Parse IP from proxy string
        // Supported formats:
        //   IPv4: ip:port, ip:port:user:pass, socks5://ip:port
        //   IPv6: [::1]:port, [::1]:port:user:pass, raw IPv6 (no port)
        let ip = proxyStr.trim();

        // Remove protocol if exists
        ip = ip.replace(/^(socks5|socks4|http|https):\/\//, '');

        // Handle bracketed IPv6: [2a0f:d941::1]:port:user:pass
        const bracketedIPv6 = ip.match(/^\[([^\]]+)\]/);
        if (bracketedIPv6) {
            ip = bracketedIPv6[1];
        } else {
            // Count colons: >1 colon and no dot = raw IPv6
            const colonCount = (ip.match(/:/g) || []).length;
            if (colonCount > 1 && !ip.includes('.')) {
                // Raw IPv6, take as-is (ip-api.com accepts full IPv6)
                // Strip any trailing :user:pass that looks like it was appended
                // IPv6 addresses have at least 2 colons, a port suffix would be :port which is ambiguous
                // Safe approach: if the string has exactly 7 colons it's a full IPv6, use it whole
                if (colonCount >= 7) {
                    // Full IPv6 address, use entire string
                } else {
                    // Might have extra :user:pass — can't reliably parse, use as-is
                }
            } else {
                // IPv4 or hostname: extract first segment before colon
                ip = ip.split(':')[0];
            }
        }

        // Validate: IPv4 or IPv6
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        const ipv6Regex = /^[0-9a-fA-F:]+$/;
        if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
            console.error('Invalid IP format:', ip);
            return null;
        }

        console.log(`🔍 Detecting geolocation for IP: ${ip}`);

        // Query ip-api.com (free, 45 requests/minute limit)
        const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,timezone,lat,lon`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'success') {
            const result = {
                ip: ip,
                country: data.country,
                countryCode: data.countryCode,
                city: data.city,
                timezone: data.timezone,
                latitude: data.lat,
                longitude: data.lon,
                language: getLanguageFromCountry(data.country)
            };
            console.log('✅ Geolocation detected:', result);
            return result;
        } else {
            console.error('❌ Geolocation API error:', data.message || 'Unknown error');
            return null;
        }
    } catch (error) {
        console.error('❌ Failed to detect proxy geolocation:', error.message);
        return null;
    }
}

// ─── Windows Taskbar: 1 profile = 1 icon ─────────────────────────────────────
// Sets the AppUserModelID on each visible Chrome window via SHGetPropertyStoreForWindow.
// This overrides Chrome's process-level AUMID at window-level, so Windows taskbar
// groups each profile window separately instead of merging all Chrome windows.
// Uses inline C# via PowerShell Add-Type — no native addon required.
//
// Fixes vs origin/feature/1profile-1icon branch:
//   - Marshal.FreeCoTaskMem() called in finally block (no memory leak)
//   - Proper HRESULT return types on IPropertyStore interface methods
//   - retry parameter for slower machines
//   - Always enabled on Win32 (no settings.taskbarIconMode guard needed)
function applyWindowAUMID(chromePid, aumid) {
    if (process.platform !== 'win32' || !chromePid) return;

    const cs = [
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class GKZ {',
        '  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),',
        '   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        '  interface IPropertyStore {',
        '    int GetCount(out uint cProps);',
        '    int GetAt(uint iProp, out PropertyKey pkey);',
        '    int GetValue(ref PropertyKey key, out PropVariant pv);',
        '    int SetValue(ref PropertyKey key, ref PropVariant pv);',
        '    int Commit();',
        '  }',
        '  [StructLayout(LayoutKind.Sequential, Pack=4)]',
        '  public struct PropertyKey { public Guid fmtid; public uint pid; }',
        '  [StructLayout(LayoutKind.Explicit)]',
        '  public struct PropVariant {',
        '    [FieldOffset(0)] public ushort vt;',
        '    [FieldOffset(8)] public IntPtr pwszVal;',
        '  }',
        '  [DllImport("shell32.dll")]',
        '  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid,',
        '    [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);',
        '  [DllImport("shell32.dll")]',
        '  static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);',
        '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWndProc p, IntPtr l);',
        '  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
        '  delegate bool EnumWndProc(IntPtr h, IntPtr l);',
        '  public static int SetAUMID(int pid, string aumid) {',
        '    int count = 0, total = 0;',
        '    var iid  = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");',
        '    var pkey = new PropertyKey {',
        '      fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };',
        '    EnumWindows(delegate(IntPtr hwnd, IntPtr _) {',
        '      int wp; GetWindowThreadProcessId(hwnd, out wp);',
        '      if (wp == pid) {',
        '        total++;',
        '        IPropertyStore store;',
        '        int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);',
        '        if (hr == 0 && store != null) {',
        '          var ptr = Marshal.StringToCoTaskMemUni(aumid);',
        '          try {',
        '            var pv = new PropVariant { vt = 31, pwszVal = ptr };',
        '            int hrSet = store.SetValue(ref pkey, ref pv);',
        '            int hrCmt = store.Commit();',
        '            Console.Error.WriteLine("[GKZ] hwnd=" + hwnd.ToInt64() + " hrSet=0x" + hrSet.ToString("X") + " hrCmt=0x" + hrCmt.ToString("X"));',
        '            if (hrSet == 0 && hrCmt == 0) count++;',
        '          } finally { Marshal.FreeCoTaskMem(ptr); }',
        '        } else {',
        '          Console.Error.WriteLine("[GKZ] hwnd=" + hwnd.ToInt64() + " SHGetPS hr=0x" + hr.ToString("X"));',
        '        }',
        '      }',
        '      return true;',
        '    }, IntPtr.Zero);',
        '    if (count > 0) SHChangeNotify(0x08000000, 0x0000, IntPtr.Zero, IntPtr.Zero);',
        '    Console.Out.WriteLine("[GKZ-Taskbar] PID=" + pid + " total=" + total + " set=" + count + " AUMID=" + aumid);',
        '    return count;',
        '  }',
        '}'
    ].join('\n');

    const scriptPath = path.join(os.tmpdir(), `gkz-aumid-${chromePid}.ps1`);
    const safeAumid = aumid.replace(/[^A-Za-z0-9.\-_]/g, '');
    const psScript = [
        `Add-Type -TypeDefinition @'\n${cs}\n'@ -Language CSharp -ErrorAction Stop`,
        `[GKZ]::SetAUMID(${chromePid}, '${safeAumid}') | Out-Null`
    ].join('\n');

    try {
        fs.writeFileSync(scriptPath, psScript, 'utf8');
        // No detached:true — keep pipe open until process exits so stdout/stderr are fully captured
        const ps = spawn('powershell', [
            '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '', err = '';
        ps.stdout?.on('data', d => { out += d; });
        ps.stderr?.on('data', d => { err += d; });
        ps.on('close', code => {
            const diag = [out.trim(), err.trim()].filter(Boolean).join(' | ').replace(/\r?\n/g, ' | ');
            console.log(`[Taskbar] exit=${code} ${diag}`);
            try { fs.unlinkSync(scriptPath); } catch(_) {}
        });
    } catch(e) {
        console.warn('[Taskbar] AUMID apply error:', e.message);
        try { fs.unlinkSync(scriptPath); } catch(_) {}
    }
}

let tray = null;

// Generate a diagnostic report for "Chrome doesn't launch" cases on customer machines.
// Writes to %TEMP%/bnc-diagnostic-{timestamp}.txt and opens with default text editor.
// Customer screenshots/sends back. Targets the top failure causes on Windows:
// missing VC++ runtime, AV blocking, non-ASCII path, corrupt binary, userDataDir lock.
async function runChromeDiagnostic() {
    const lines = [];
    const log = (s) => lines.push(s);

    log('===== BNC Chrome Launch Diagnostic =====');
    log(`Time: ${new Date().toISOString()}`);
    try { log(`App version: ${app.getVersion()}`); } catch (_) {}
    log('');

    // 1. System
    log('--- System ---');
    log(`Platform: ${process.platform} ${process.arch}`);
    log(`OS: ${os.type()} ${os.release()}`);
    log(`Hostname: ${os.hostname()}`);
    const userInfo = os.userInfo();
    log(`Username: ${userInfo.username}`);
    log(`Home dir: ${userInfo.homedir}`);
    const homeHasNonAscii = /[^\x00-\x7F]/.test(userInfo.homedir);
    log(`Home dir ASCII-only: ${!homeHasNonAscii ? 'YES (ok)' : 'NO (✗ Chrome can fail to read path with Vietnamese diacritics)'}`);
    log(`userData dir: ${app.getPath('userData')}`);
    log('');

    // 2. VC++ runtime DLLs (most common silent crash cause on Windows)
    if (process.platform === 'win32') {
        log('--- Visual C++ Runtime ---');
        const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
            const dllPath = path.join(sys32, dll);
            log(`${dll}: ${fs.existsSync(dllPath) ? 'FOUND' : '✗ MISSING — install vc_redist.x64.exe'}`);
        }
        log('');
    }

    // 3. Chrome binary discovery
    log('--- Chrome binary ---');
    let chromePath = null;
    try { chromePath = getChromiumPath(); } catch (e) { log(`getChromiumPath() failed: ${e.message}`); }
    log(`Resolved path: ${chromePath || '(none)'}`);
    if (chromePath) {
        log(`Exists: ${fs.existsSync(chromePath) ? 'YES' : '✗ NO'}`);
        if (fs.existsSync(chromePath)) {
            try {
                const stat = fs.statSync(chromePath);
                log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
                log(`Modified: ${stat.mtime.toISOString()}`);
            } catch (_) {}
        }
    }
    log('');

    // 4. `chrome.exe --version` — fastest way to see if Chrome can execute at all.
    // Must mirror the real launch flags (--no-sandbox, --disable-breakpad): without them
    // this probe hits the OS sandbox broker and crashpad init, both of which real profile
    // launches never touch, producing "Access is denied (0x5)" / crashpad pipe noise that
    // has nothing to do with why an actual launch failed.
    log('--- chrome --version test ---');
    if (chromePath && fs.existsSync(chromePath)) {
        try {
            const out = execSync(`"${chromePath}" --version --no-sandbox --disable-breakpad`, { timeout: 5000, windowsHide: true }).toString().trim();
            log(`Output: ${out}`);
            log('Result: PASS — Chrome binary can execute');
        } catch (err) {
            log(`Error code: ${err.code || err.status}`);
            log(`stderr: ${(err.stderr?.toString() || '').slice(0, 800) || '(none)'}`);
            log('Result: ✗ FAIL — Chrome cannot even print version (with the same flags real launches use)');
            log('Likely cause: missing VC++ runtime, AV blocking binary, corrupt download, non-ASCII path');
        }
    } else {
        log('Skipped — binary not found');
    }
    log('');

    // 5. Network reachability to Google (timeout = Chrome hang on startup)
    log('--- Network test ---');
    const httpsGet = (url, timeoutMs) => new Promise((resolve) => {
        const https = require('https');
        const start = Date.now();
        const req = https.get(url, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - start }));
        });
        req.on('error', (e) => resolve({ ok: false, err: e.message, ms: Date.now() - start }));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - start }); });
    });
    for (const url of ['https://www.google.com/generate_204', 'https://accounts.google.com/']) {
        const r = await httpsGet(url, 5000);
        log(`${url}: ${r.ok ? `OK ${r.status}` : `FAIL (${r.err})`} in ${r.ms}ms`);
    }
    log('');

    // 6. Hint table for common exit codes
    log('--- Exit code reference ---');
    log('-1073741515 (0xC0000135): missing VC++ Redistributable');
    log('-1073741511 (0xC0000139): missing DLL (mojo_core.dll etc.)');
    log('-1073741502 (0xC0000142): DLL init failed (often AV)');
    log('1: userDataDir locked by another Chrome process');
    log('null + SIGTERM/SIGKILL: process killed (AV, parent, OS)');
    log('');

    log('===== END =====');

    const report = lines.join('\n');
    const outPath = path.join(os.tmpdir(), `bnc-diagnostic-${Date.now()}.txt`);
    try {
        fs.writeFileSync(outPath, report, 'utf8');
        shell.openPath(outPath); // opens with default text editor (Notepad on Windows)
    } catch (e) {
        console.error('[Diagnostic] write/open failed:', e);
    }
    return { path: outPath, report };
}

ipcMain.handle('run-chrome-diagnostic', async () => {
    return runChromeDiagnostic();
});

function createTray(win) {
    const iconPath = path.join(__dirname, 'icon.png');
    const trayIcon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty();
    tray = new Tray(trayIcon);
    tray.setToolTip('BNC Browser');
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show', click: () => { win.show(); win.focus(); } },
        { type: 'separator' },
        { label: 'Chẩn đoán Chrome', click: () => runChromeDiagnostic().catch(e => console.error(e)) },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { win.show(); win.focus(); });
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
        width: Math.round(width * 0.5), height: Math.round(height * 0.601), minWidth: 900, minHeight: 600,
        title: "BNC Browser", backgroundColor: '#1e1e2d',
        icon: path.join(__dirname, 'icon.png'),
        titleBarOverlay: { color: '#1e1e2d', symbolColor: '#ffffff', height: 35 },
        titleBarStyle: 'hidden',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    win.setMenuBarVisibility(false);
    win.loadFile('index.html');
    if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
    mainWindow = win;

    // Show confirm dialog on X — give user 3 choices instead of closing silently
    win.on('close', async (e) => {
        if (app.isQuiting) return; // Already going through quit flow, let it close
        e.preventDefault();

        const runningCount = Object.keys(activeProcesses).length;
        const warningLine = runningCount > 0
            ? `Cảnh báo: ${runningCount} profile đang chạy sẽ bị dừng khi đóng ứng dụng.\n\n`
            : '';

        const { response } = await dialog.showMessageBox(win, {
            type: 'question',
            title: 'GeekezBrowser',
            message: 'Bạn muốn làm gì?',
            detail: `${warningLine}Chọn hành động để tiếp tục.`,
            buttons: ['Thu nhỏ vào tray', 'Đóng ứng dụng', 'Hủy'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
        });

        if (response === 0) {
            win.hide(); // Minimize to tray, keep running
        } else if (response === 1) {
            app.isQuiting = true;
            app.quit();
        }
        // response === 2: Hủy — do nothing, window stays open
    });

    createTray(win);
    return win;
}

// Helper to notify UI to refresh profiles
function notifyUIRefresh() {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('refresh-profiles');
    }
}

async function generateExtension(profilePath, fingerprint, profileName, watermarkStyle, profileId, fpChromiumMode = false) {
    const extDir = path.join(profilePath, 'extension');
    await fs.ensureDir(extDir);

    // 读取已保存的密码 (解密)
    const pwFile = path.join(DATA_PATH, profileId, 'passwords.json');
    const passwords = await readEncryptedPasswords(pwFile, profileId);

    // 内部扩展固定使用独立端口 12139
    const apiPort = 12139;

    const manifest = {
        manifest_version: 3,
        name: "BNC Guard",
        version: "1.1.0",
        description: "Privacy & Password Protection",
        permissions: ["storage", "activeTab"],
        host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
        background: { service_worker: "background.js" },
        content_scripts: [
            {
                matches: ["<all_urls>"],
                exclude_matches: [
                    "https://accounts.google.com/*",
                    "https://accounts.youtube.com/*",
                    "https://myaccount.google.com/*",
                    "https://mail.google.com/*",
                    "https://*.gstatic.com/*",
                    "https://www.google.com/recaptcha/*",
                    "https://recaptcha.google.com/*",
                    "https://*.doubleclick.net/*"
                ],
                js: ["content.js"],
                run_at: "document_start",
                all_frames: true,
                world: "MAIN"
            },
            {
                matches: ["<all_urls>"],
                exclude_matches: [
                    "https://accounts.google.com/*",
                    "https://accounts.youtube.com/*",
                    "https://mail.google.com/*",
                    "https://myaccount.google.com/*"
                ],
                js: ["content_pw.js"],
                run_at: "document_idle",
                all_frames: false,
                world: "ISOLATED"
            }
        ],
        action: { default_popup: "popup.html" }
    };
    const style = watermarkStyle || 'enhanced';
    // fingerprint.js: canvas/audio/WebGL/clientrects/permissions/mediaDevices all "mode real"
    // (no JS hooks) to avoid Worker comparison mismatch. makeNative + screen + plugins + chrome
    // are safe since Workers don't have navigator.plugins or window.screen.
    const scriptContent = getInjectScript(fingerprint, profileName, style, fpChromiumMode);
    // (old manual fpChromiumMode injection removed — use getInjectScript above)
    if (false) `(function() {
    // --- makeNative: override Function.prototype.toString so injected functions look native ---
    // Needed because Pixelscan calls Function.prototype.toString.call(fn) to detect JS overrides.
    // Workers don't have navigator.plugins so there's no cross-context inconsistency here.
    const _nativeRegistry = new WeakMap();
    const _origFPToString = Function.prototype.toString;
    Object.defineProperty(Function.prototype, 'toString', {
        value: function toString() {
            if (_nativeRegistry.has(this)) return _nativeRegistry.get(this);
            return _origFPToString.call(this);
        },
        writable: true, enumerable: false, configurable: true
    });
    _nativeRegistry.set(Function.prototype.toString, 'function toString() { [native code] }');
    const makeNative = function(func, name) {
        _nativeRegistry.set(func, 'function ' + name + '() { [native code] }');
        try { delete func.prototype; } catch(e) {}
        return func;
    };

    // --- navigator.plugins + navigator.mimeTypes ---
    // Real Chrome 90+ always has 5 PDF plugins. Ungoogled Chromium strips them → instant detection.
    // Workers don't have navigator.plugins so injecting here causes no Worker inconsistency.
    (function() {
        var pluginDefs = [
            { name: 'PDF Viewer',                description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer',         description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            { name: 'Chromium PDF Viewer',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
            { name: 'WebKit built-in PDF',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' }
        ];
        var mimeTypeDefs = [
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            { type: 'text/pdf',        suffixes: 'pdf', description: 'Portable Document Format' }
        ];
        var plugins = pluginDefs.map(function(def) {
            var plugin = Object.create(null);
            var mimes = mimeTypeDefs.map(function(mt) {
                var mimeObj = Object.create(null);
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
                [Symbol.iterator]: { value: function*() { for (var i = 0; i < mimes.length; i++) yield mimes[i]; }, enumerable: false, configurable: true }
            });
            return plugin;
        });
        var pluginArray = Object.create(null);
        plugins.forEach(function(p, i) { pluginArray[i] = p; pluginArray[p.name] = p; });
        Object.defineProperties(pluginArray, {
            length:            { value: plugins.length, enumerable: true,  configurable: true },
            item:              { value: function(n) { return pluginArray[n] || null; }, enumerable: false, configurable: true },
            namedItem:         { value: function(n) { return pluginArray[n] || null; }, enumerable: false, configurable: true },
            refresh:           { value: function() {}, enumerable: false, configurable: true },
            [Symbol.iterator]: { value: function*() { for (var i = 0; i < plugins.length; i++) yield plugins[i]; }, enumerable: false, configurable: true }
        });
        var allMimes = mimeTypeDefs.map(function(mt) {
            var mimeObj = Object.create(null);
            Object.defineProperties(mimeObj, {
                type:          { value: mt.type,        enumerable: true, configurable: true },
                suffixes:      { value: mt.suffixes,    enumerable: true, configurable: true },
                description:   { value: mt.description, enumerable: true, configurable: true },
                enabledPlugin: { value: plugins[0],     enumerable: true, configurable: true }
            });
            return mimeObj;
        });
        var mimeTypeArray = Object.create(null);
        allMimes.forEach(function(mt, i) { mimeTypeArray[i] = mt; mimeTypeArray[mt.type] = mt; });
        Object.defineProperties(mimeTypeArray, {
            length:            { value: allMimes.length, enumerable: true,  configurable: true },
            item:              { value: function(n) { return mimeTypeArray[n] || null; }, enumerable: false, configurable: true },
            namedItem:         { value: function(n) { return mimeTypeArray[n] || null; }, enumerable: false, configurable: true },
            [Symbol.iterator]: { value: function*() { for (var i = 0; i < allMimes.length; i++) yield allMimes[i]; }, enumerable: false, configurable: true }
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

    // --- Restore window.chrome APIs stripped by Ungoogled Chromium ---
    var chromeVal = {
        app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        },
        runtime: {
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', GC_PRESSURE: 'gc_pressure', OS_UPDATE: 'os_update' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
        },
        csi: function() { return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 5000, tran: 15 }; },
        loadTimes: function() { return { commitLoadTime: Date.now() / 1000, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; }
    };
    try {
        if (!window.chrome) {
            // chrome hoàn toàn không tồn tại (Ungoogled Chromium không có extension)
            Object.defineProperty(window, 'chrome', { writable: true, enumerable: true, configurable: true, value: chromeVal });
            console.log('[GZ] window.chrome defined from scratch');
        } else {
            // chrome tồn tại nhưng thiếu app/csi/loadTimes — thêm vào
            if (!window.chrome.app) window.chrome.app = chromeVal.app;
            if (!window.chrome.csi) window.chrome.csi = chromeVal.csi;
            if (!window.chrome.loadTimes) window.chrome.loadTimes = chromeVal.loadTimes;
            console.log('[GZ] window.chrome patched (app/csi/loadTimes added)');
        }
    } catch(e) {
        console.warn('[GZ] window.chrome patch failed:', e.message);
    }
    console.log('[GZ] chrome.app:', typeof window.chrome, typeof window.chrome.app, typeof window.chrome.csi);
    // Intercept eval to log what Pixelscan is testing
    try {
        var _origEval = window.eval;
        var _evalPatched = function eval(code) {
            if (typeof code === 'string' && code.length < 400) {
                console.log('[GZ] eval(' + code.length + '):', code.substring(0, 120));
            }
            return _origEval.call(this, code);
        };
        Object.defineProperty(window, 'eval', { value: _evalPatched, writable: true, configurable: true });
        _nativeRegistry.set(_evalPatched, 'function eval() { [native code] }');
    } catch(e) { console.warn('[GZ] eval intercept failed:', e.message); }
    console.log('[GZ] plugins:', navigator.plugins.length, '| plugins[0]:', navigator.plugins[0] && navigator.plugins[0].name);
})();`;
    await fs.writeJson(path.join(extDir, 'manifest.json'), manifest);
    await fs.writeFile(path.join(extDir, 'content.js'), scriptContent);

    // --- background.js ---
    const backgroundJs = `
const PROFILE_ID = ${JSON.stringify(profileId || '')};
const API_PORT = ${apiPort};
const INIT_PASSWORDS = ${JSON.stringify(passwords)};

// 初始化密码数据
chrome.runtime.onInstalled.addListener(() => { initPasswords(); });
chrome.runtime.onStartup.addListener(() => { initPasswords(); });

async function initPasswords() {
    const { geekez_passwords } = await chrome.storage.local.get('geekez_passwords');
    if (!geekez_passwords || geekez_passwords.length === 0) {
        if (INIT_PASSWORDS.length > 0) {
            await chrome.storage.local.set({ geekez_passwords: INIT_PASSWORDS });
        }
    }
}

async function getPasswords() {
    const { geekez_passwords } = await chrome.storage.local.get('geekez_passwords');
    return geekez_passwords || [];
}

async function savePassword(entry) {
    const pws = await getPasswords();
    const idx = pws.findIndex(p => p.origin === entry.origin && p.username === entry.username);
    const now = Date.now();
    if (idx > -1) {
        pws[idx] = { ...pws[idx], ...entry, updatedAt: now };
    } else {
        pws.push({ ...entry, createdAt: now, updatedAt: now });
    }
    await chrome.storage.local.set({ geekez_passwords: pws });
    syncToElectron(pws);
    return pws;
}

async function deletePassword(origin, username) {
    let pws = await getPasswords();
    pws = pws.filter(p => !(p.origin === origin && p.username === username));
    await chrome.storage.local.set({ geekez_passwords: pws });
    syncToElectron(pws);
    return pws;
}

function syncToElectron(passwords) {
    fetch(\`http://127.0.0.1:\${API_PORT}/api/passwords/sync\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: PROFILE_ID, passwords })
    }).then(r => r.json())
      .then(res => console.log('Sync to Electron success:', res))
      .catch(err => console.error('Sync to Electron failed:', err));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'QUERY_PASSWORDS') {
        getPasswords().then(pws => {
            const matches = pws.filter(p => msg.origin && p.origin === msg.origin);
            sendResponse({ passwords: matches });
        });
        return true;
    }
    if (msg.type === 'SAVE_PASSWORD') {
        savePassword(msg.entry).then(pws => sendResponse({ success: true, count: pws.length }));
        return true;
    }
    if (msg.type === 'DELETE_PASSWORD') {
        deletePassword(msg.origin, msg.username).then(pws => sendResponse({ success: true, count: pws.length }));
        return true;
    }
    if (msg.type === 'GET_ALL_PASSWORDS') {
        getPasswords().then(pws => sendResponse({ passwords: pws }));
        return true;
    }
});
`;
    await fs.writeFile(path.join(extDir, 'background.js'), backgroundJs);

    // --- content_pw.js (密码自动填充 + 保存检测) ---
    const contentPwJs = `
(function() {
    'use strict';
    let fillAttempted = false;

    function getOrigin() { return location.origin; }

    function findPasswordFields() {
        return Array.from(document.querySelectorAll('input[type="password"]:not([data-geekez-processed])'));
    }

    function findUsernameField(pwField) {
        const form = pwField.closest('form') || document.body;
        const inputs = Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'));
        const pwIdx = inputs.indexOf(pwField);
        for (let i = pwIdx - 1; i >= 0; i--) {
            const inp = inputs[i];
            const t = (inp.type || '').toLowerCase();
            const n = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            const ac = (inp.autocomplete || '').toLowerCase();
            if (t === 'email' || t === 'text' || t === 'tel' ||
                ac.includes('username') || ac.includes('email') ||
                n.includes('user') || n.includes('email') || n.includes('login') || n.includes('account') ||
                id.includes('user') || id.includes('email') || id.includes('login') || id.includes('account')) {
                return inp;
            }
        }
        if (pwIdx > 0) return inputs[pwIdx - 1];
        return null;
    }

    function createFillButton(pwField, passwords) {
        if (passwords.length === 0) return;
        const btn = document.createElement('div');
        btn.setAttribute('data-geekez-fill', 'true');
        btn.style.cssText = 'position:absolute;width:20px;height:20px;cursor:pointer;z-index:999999;background:#4285f4;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);';
        btn.textContent = 'G';
        btn.title = 'GeeKez 自动填充';

        const rect = pwField.getBoundingClientRect();
        btn.style.position = 'absolute';
        btn.style.left = (rect.right - 25 + window.scrollX) + 'px';
        btn.style.top = (rect.top + (rect.height - 20) / 2 + window.scrollY) + 'px';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (passwords.length === 1) {
                doFill(pwField, passwords[0]);
            } else {
                showDropdown(btn, pwField, passwords);
            }
        });
        document.body.appendChild(btn);
    }

    function showDropdown(anchor, pwField, passwords) {
        const existing = document.querySelector('[data-geekez-dropdown]');
        if (existing) existing.remove();
        const dd = document.createElement('div');
        dd.setAttribute('data-geekez-dropdown', 'true');
        dd.style.cssText = 'position:absolute;z-index:9999999;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:200px;max-height:200px;overflow-y:auto;';
        const r = anchor.getBoundingClientRect();
        dd.style.left = (r.left + window.scrollX) + 'px';
        dd.style.top = (r.bottom + 4 + window.scrollY) + 'px';
        passwords.forEach(pw => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;';
            item.textContent = pw.username;
            item.addEventListener('mouseenter', () => item.style.background = '#f5f5f5');
            item.addEventListener('mouseleave', () => item.style.background = '#fff');
            item.addEventListener('click', () => { doFill(pwField, pw); dd.remove(); });
            dd.appendChild(item);
        });
        document.body.appendChild(dd);
        setTimeout(() => document.addEventListener('click', () => dd.remove(), { once: true }), 100);
    }

    function doFill(pwField, pw) {
        const userField = findUsernameField(pwField);
        if (userField) setVal(userField, pw.username);
        setVal(pwField, pw.password);
    }

    function setVal(el, val) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        if(nativeSetter) nativeSetter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 保存最后输入的凭据
    let lastCreds = { origin: getOrigin(), url: location.href, name: location.hostname };

    function processPage() {
        const pwFields = findPasswordFields();
        if (pwFields.length === 0) return;
        
        pwFields.forEach(pwField => {
            if (pwField.hasAttribute('data-geekez-processed')) return;
            pwField.setAttribute('data-geekez-processed', 'true');
            
            // 记录用户输入，即使没有form submit也能捕获
            pwField.addEventListener('blur', () => {
                if (pwField.value) {
                    lastCreds.password = pwField.value;
                    const uField = findUsernameField(pwField);
                    if (uField && uField.value) lastCreds.username = uField.value;
                }
            });
            const uField = findUsernameField(pwField);
            if (uField) {
                uField.addEventListener('blur', () => {
                   if (uField.value) lastCreds.username = uField.value; 
                });
            }
        });

        chrome.runtime.sendMessage({ type: 'QUERY_PASSWORDS', origin: getOrigin() }, (resp) => {
            if (!resp || !resp.passwords) return;
            pwFields.forEach(pwField => {
                if(!pwField.hasAttribute('data-geekez-btn-added')) {
                    pwField.setAttribute('data-geekez-btn-added', 'true');
                    createFillButton(pwField, resp.passwords);
                }
                if (!fillAttempted && resp.passwords.length === 1) {
                    fillAttempted = true;
                    doFill(pwField, resp.passwords[0]);
                }
            });
        });
    }

    // 监听表单提交 - 提示保存密码
    function monitorSubmit() {
        function attemptSave(pwField) {
            let uVal = lastCreds.username, pVal = lastCreds.password;
            if (pwField && pwField.value) pVal = pwField.value;
            if (pwField) {
                const uField = findUsernameField(pwField);
                if (uField && uField.value) uVal = uField.value;
            }
            if (uVal && pVal) {
                chrome.runtime.sendMessage({ type: 'SAVE_PASSWORD', entry: { ...lastCreds, username: uVal, password: pVal } });
            }
        }

        document.addEventListener('submit', (e) => {
            const form = e.target;
            const pwField = form.querySelector('input[type="password"]') || Array.from(document.querySelectorAll('input[type="password"]')).pop();
            attemptSave(pwField);
        }, true);

        // 也监听点击登录按钮 (扩大范围，捕获 div/span 等模拟按钮)
        document.addEventListener('click', (e) => {
            const el = e.target;
            const text = (el.innerText || el.textContent || '').toLowerCase();
            const btn = el.closest('button, input[type="submit"], input[type="button"], .btn, .button');
            
            if (btn || text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('signin') || text.includes('登录') || text.includes('登入')) {
                const pwField = (btn ? btn.closest('form') : null)?.querySelector('input[type="password"]') || Array.from(document.querySelectorAll('input[type="password"]')).pop();
                attemptSave(pwField);
            }
        }, true);
        
        // 离开页面前如果有输入也尝试保存
        window.addEventListener('beforeunload', () => {
            if (lastCreds.username && lastCreds.password) {
                chrome.runtime.sendMessage({ type: 'SAVE_PASSWORD', entry: lastCreds });
            }
        });
    }

    processPage();
    monitorSubmit();
    const obs = new MutationObserver(() => { setTimeout(processPage, 500); });
    obs.observe(document.body, { childList: true, subtree: true });
})();
`;
    await fs.writeFile(path.join(extDir, 'content_pw.js'), contentPwJs);

    // --- popup.html ---
    const popupHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:320px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#1a1a2e;color:#e0e0e0;font-size:13px}
.header{padding:12px 16px;background:linear-gradient(135deg,#16213e,#0f3460);display:flex;align-items:center;gap:8px}
.header h1{font-size:15px;font-weight:600;color:#e94560}
.header span{font-size:11px;color:#888;margin-left:auto}
.list{max-height:300px;overflow-y:auto;padding:4px 0}
.item{padding:10px 16px;border-bottom:1px solid #222;cursor:pointer;transition:background .15s}
.item:hover{background:#16213e}
.item .site{font-weight:500;color:#e94560;font-size:12px;margin-bottom:2px}
.item .user{color:#ccc;font-size:12px}
.item .actions{display:flex;gap:6px;margin-top:4px}
.item .actions button{background:none;border:1px solid #444;color:#aaa;font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer}
.item .actions button:hover{border-color:#e94560;color:#e94560}
.empty{padding:24px 16px;text-align:center;color:#666;font-size:12px}
.add-form{padding:12px 16px;border-top:1px solid #333}
.add-form input{width:100%;padding:6px 8px;margin:3px 0;background:#16213e;border:1px solid #333;border-radius:4px;color:#e0e0e0;font-size:12px}
.add-form button{width:100%;padding:6px;margin-top:6px;background:#e94560;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500}
.add-form button:hover{background:#c73450}
.add-pw-btn{display:block;width:100%;padding:8px;background:none;border:none;border-top:1px solid #333;color:#e94560;cursor:pointer;font-size:12px}
</style></head>
<body>
<div class="header"><h1>🔑 GeeKez</h1><span>密码管理</span></div>
<div class="list" id="list"></div>
<button class="add-pw-btn" id="addPwBtn">+ 添加密码</button>
<div class="add-form" id="addForm" style="display:none">
<input id="addUrl" placeholder="网址 URL"><input id="addUser" placeholder="用户名"><input id="addPw" type="password" placeholder="密码">
<button id="addBtn">保存</button>
</div>
<script src="popup.js"></script>
</body></html>`;
    await fs.writeFile(path.join(extDir, 'popup.html'), popupHtml);

    // --- popup.js ---
    const popupJs = `
document.addEventListener('DOMContentLoaded', async () => {
    const list = document.getElementById('list');
    const addPwBtn = document.getElementById('addPwBtn');
    const addForm = document.getElementById('addForm');
    const addBtn = document.getElementById('addBtn');

    addPwBtn.addEventListener('click', () => {
        addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
    });

    addBtn.addEventListener('click', () => {
        const url = document.getElementById('addUrl').value.trim();
        const user = document.getElementById('addUser').value.trim();
        const pw = document.getElementById('addPw').value;
        if (!url || !user || !pw) return;
        let origin;
        try { origin = new URL(url).origin; } catch { origin = url; }
        chrome.runtime.sendMessage({
            type: 'SAVE_PASSWORD',
            entry: { url, origin, username: user, password: pw, name: new URL(url).hostname || url }
        }, () => { loadList(); addForm.style.display = 'none'; });
    });

    function loadList() {
        chrome.runtime.sendMessage({ type: 'GET_ALL_PASSWORDS' }, (resp) => {
            const pws = (resp && resp.passwords) || [];
            if (pws.length === 0) {
                list.innerHTML = '<div class="empty">暂无保存的密码</div>';
                return;
            }
            list.innerHTML = pws.map(pw => \`
                <div class="item">
                    <div class="site">\${esc(pw.name || pw.origin)}</div>
                    <div class="user">\${esc(pw.username)}</div>
                    <div class="actions">
                        <button data-action="copy" data-pw="\${esc(pw.password)}">复制密码</button>
                        <button data-action="delete" data-origin="\${esc(pw.origin)}" data-user="\${esc(pw.username)}">删除</button>
                    </div>
                </div>
            \`).join('');

            list.querySelectorAll('[data-action="copy"]').forEach(btn => {
                btn.addEventListener('click', () => {
                    navigator.clipboard.writeText(btn.dataset.pw).then(() => { btn.textContent = '✓ 已复制'; setTimeout(() => btn.textContent = '复制密码', 1500); });
                });
            });
            list.querySelectorAll('[data-action="delete"]').forEach(btn => {
                btn.addEventListener('click', () => {
                    chrome.runtime.sendMessage({ type: 'DELETE_PASSWORD', origin: btn.dataset.origin, username: btn.dataset.user }, () => loadList());
                });
            });
        });
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    loadList();
});
`;
    await fs.writeFile(path.join(extDir, 'popup.js'), popupJs);

    return extDir;
}

app.whenReady().then(async () => {
    createWindow();

    // Khởi động internal server TRƯỚC — license dialog cần gọi /api/activate-license
    try {
        internalApiServer = createInternalApiServer();
        internalApiServer.listen(INTERNAL_API_PORT, '127.0.0.1', () => {
            console.log(`🛡️ Internal Guard Server auto-started on http://localhost:${INTERNAL_API_PORT}`);
        });
        internalApiServer.on('error', (err) => {
            console.error('Internal Guard Server failed to start:', err);
        });
    } catch (e) {
        console.error('Failed to auto-start Internal Guard Server:', e);
    }

    // ── Auto Updater ────────────────────────────────────────────────────────────
    setupAutoUpdater();
    // Check ngay khi khởi động (sau khi mainWindow đã sẵn sàng)
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);

    // ── BNC Subscription Check ──────────────────────────────────────────────────
    const [bncAccess, versionResult] = await Promise.all([
        bncCheckAccess(),
        bncCheckVersion(),
    ]);
    // bncCheckVersion chỉ dùng để lấy releaseNotes/forceUpdate, electron-updater lo phần download/install

    debugLog('BNC_STARTUP', { allowed: bncAccess.allowed, reason: bncAccess.reason, offlineMode: bncAccess.offlineMode || false });

    // Gửi trạng thái đến renderer để hiện login overlay nếu cần
    const sendBncState = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const send = () => mainWindow.webContents.send('bnc-auth-state', {
            isLoggedIn: bncAccess.allowed,
            reason: bncAccess.reason,
            offlineMode: bncAccess.offlineMode,
        });
        if (mainWindow.webContents.isLoading()) {
            mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 200));
        } else {
            setTimeout(send, 200);
        }
    };
    sendBncState();

    // Sau startup: sync profiles silent để cập nhật isLocked theo available mới nhất
    // Guard: chỉ ghi nếu auth không thay đổi kể từ lúc start (tránh race với manual login)
    if (bncAccess.allowed && !bncAccess.offlineMode) {
        const startupCustomerId = getSavedBncAuth()?.customerId;
        console.log(`[BNC_STARTUP_SYNC] Start — customerId=${startupCustomerId}`);
        bncApiCall('GET', '/profiles').then(async (res) => {
            const currentCustomerId = getSavedBncAuth()?.customerId;
            console.log(`[BNC_STARTUP_SYNC] Complete — startupId=${startupCustomerId}, currentId=${currentCustomerId}`);
            if (currentCustomerId !== startupCustomerId) {
                console.log('[BNC_STARTUP_SYNC] ⚠ Auth changed → skip overwrite');
                return;
            }
            const serverProfiles = res?.profiles || [];
            console.log(`[BNC_STARTUP_SYNC] Writing ${serverProfiles.length} profiles to file`);
            if (serverProfiles.length > 0) {
                await writeProfilesAtomic(serverProfiles);
                console.log('[BNC_STARTUP_SYNC] ✓ Sent bnc-profiles-reloaded');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('bnc-profiles-reloaded');
                }
            }
        }).catch((e) => console.error('[BNC_STARTUP_SYNC] Error:', e.message));
    }

    // Data path prompt
    const dataPathAlreadyConfirmed = fs.existsSync(DATA_PATH_CONFIRMED);

    // Heartbeat mỗi 5 phút — chỉ check token hợp lệ + cập nhật slots
    setInterval(async () => {
        const result = await bncPingServer();
        if (!result) return; // offline
        if (result._statusCode === 401 || result._statusCode === 403) {
            try { fs.removeSync(BNC_AUTH_FILE); } catch (_) {}
            dialog.showMessageBox({
                type: 'warning',
                title: 'BNC — Phiên hết hạn',
                message: 'Phiên đăng nhập đã hết hạn. Vui lòng khởi động lại và đăng nhập lại.',
                buttons: ['Đóng'],
            }).then(() => app.quit());
            return;
        }
        // Cập nhật slots từ server + recompute isLocked cho profiles local
        if (result.slots) {
            const auth = getSavedBncAuth();
            if (auth) saveBncAuth({ ...auth, slots: result.slots, teams: result.teams ?? auth.teams ?? [] });
            if (mainWindow && !mainWindow.isDestroyed() && result.teams) {
                mainWindow.webContents.send('bnc-teams-updated', result.teams);
            }
            // Recompute isLocked: sort theo clientCreatedAt ASC, index < available = active
            try {
                if (fs.existsSync(PROFILES_FILE)) {
                    const profiles = await fs.readJson(PROFILES_FILE);
                    const available = result.slots.available || 0;
                    const sorted = [...profiles].sort((a, b) => (a.clientCreatedAt || 0) - (b.clientCreatedAt || 0));
                    const canRun = result.slots.canRun ?? result.slots.available ?? 0;
                    const updated = profiles.map(p => {
                        const rank = sorted.findIndex(s => s.id === p.id);
                        return { ...p, isLocked: rank >= canRun };
                    });
                    await writeProfilesAtomic(updated);
                }
            } catch (_) {}
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bnc-slots-updated', result.slots);
            }
        }
        // Hiển thị thông báo mới từ server (Electron OS notification)
        if (result.notifications && result.notifications.length > 0) {
            try {
                const seenFile = path.join(app.getPath('userData'), 'bnc_seen_notif.json');
                const seen = new Set(fs.existsSync(seenFile) ? fs.readJsonSync(seenFile) : []);
                const newNotifs = result.notifications.filter(n => !seen.has(n.id));
                for (const n of newNotifs) {
                    new Notification({ title: n.title, body: n.body }).show();
                    seen.add(n.id);
                }
                if (newNotifs.length > 0) {
                    fs.writeJsonSync(seenFile, [...seen].slice(-500));
                }
                // Gửi sang renderer để hiển thị badge + list (kể cả đã seen qua OS notification)
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('bnc-notifications-updated', result.notifications);
                }
            } catch (_) {}
        }

        // Check version mới — chỉ dùng electron-updater (download + ditto install)
        // checkAndNotifyUpdate đã bỏ: mở browser thay vì tự cài
        autoUpdater.checkForUpdates().catch(() => {});
    }, 5 * 60 * 1000);

    // Auto-start public API server if enabled
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.enableApiServer && !apiServerRunning) {
                const port = settings.apiPort || 12138;
                apiServer = createApiServer(port, settings.apiKey || null);
                apiServer.listen(port, '127.0.0.1', () => {
                    apiServerRunning = true;
                    console.log(`🔌 Public API Server auto-started on http://localhost:${port}`);
                });
                apiServer.on('error', (err) => {
                    console.error('Public API Server failed to auto-start:', err);
                });
            }
        }
    } catch (e) {
        console.error('Failed to auto-start Public API server:', e);
    }

    setTimeout(() => { fs.emptyDir(TRASH_PATH).catch(() => { }); }, 10000);
});

// IPC Handles
ipcMain.handle('get-app-info', () => { return { name: app.getName(), version: app.getVersion() }; });
ipcMain.handle('fetch-url', async (e, url) => { try { const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.text(); } catch (e) { throw e.message; } });
ipcMain.handle('test-proxy-latency', async (e, proxyStr) => {
    const tempPort = await getPort(); const tempConfigPath = path.join(app.getPath('userData'), `test_config_${tempPort}.json`);
    try {
        let outbound; try { const { parseProxyLink } = require('./utils'); outbound = parseProxyLink(proxyStr, "proxy_test"); } catch (err) { return { success: false, msg: "Format Err" }; }
        const config = { log: { loglevel: "none" }, inbounds: [{ port: tempPort, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }], outbounds: [outbound, { protocol: "freedom", tag: "direct" }], routing: { rules: [{ type: "field", outboundTag: "proxy_test", port: "0-65535" }] } };
        await fs.writeJson(tempConfigPath, config);
        const xrayProcess = spawn(EFFECTIVE_BIN_PATH, ['-c', tempConfigPath], { cwd: EFFECTIVE_BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: 'ignore', windowsHide: true });
        await new Promise(r => setTimeout(r, 800));
        const start = Date.now(); const agent = new SocksProxyAgent(`socks5://127.0.0.1:${tempPort}`);
        const result = await new Promise((resolve) => {
            const req = http.get('http://cp.cloudflare.com/generate_204', { agent, timeout: 5000 }, (res) => {
                const latency = Date.now() - start; if (res.statusCode === 204) resolve({ success: true, latency }); else resolve({ success: false, msg: `HTTP ${res.statusCode}` });
            });
            req.on('error', () => resolve({ success: false, msg: "Err" })); req.on('timeout', () => { req.destroy(); resolve({ success: false, msg: "Timeout" }); });
        });
        await forceKill(xrayProcess.pid); try { fs.unlinkSync(tempConfigPath); } catch (e) { } return result;
    } catch (err) { return { success: false, msg: err.message }; }
});

// Auto-detect proxy geolocation
ipcMain.handle('detect-proxy-location', async (e, proxyStr) => {
    return await getProxyGeolocation(proxyStr);
});

ipcMain.handle('set-title-bar-color', (e, colors) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) { if (process.platform === 'win32') try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol }); } catch (e) { } win.setBackgroundColor(colors.bg); } });

// ─── License IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('is-packaged', () => app.isPackaged);

// ─── BNC Auth IPC handlers ────────────────────────────────────────────────────

// Đăng nhập: gọi muachungtool /api/bnc/login, lưu token
ipcMain.handle('bnc-login', async (_, { email, password }) => {
    console.log('[DEBUG:BNC_IPC_LOGIN] called with email:', email);
    const result = await bncLogin(email, password);
    console.log('[DEBUG:BNC_IPC_LOGIN] result:', JSON.stringify(result)?.slice(0, 300));
    if (!result) return { success: false, message: 'Không kết nối được server. Kiểm tra lại mạng.' };
    if (result._statusCode === 401 || !result.accessToken) {
        return { success: false, message: result.message || 'Email hoặc mật khẩu không đúng' };
    }
    const customerId = result.customer?.id || null;
    const slots = result.slots || { totalGranted: 0, slotsUsed: 0, available: 0 };
    const teams = result.teams || [];
    saveBncAuth({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || null,
        email, customerId, slots,
        teams,
        activeWorkspace: 'own',
        savedAt: new Date().toISOString(),
    });
    console.log('[DEBUG:BNC_IPC_LOGIN] success, customerId:', customerId, '| slots:', slots);

    // ── Profile/Group sync from server ──────────────────────────────────
    const serverProfiles = result.profiles || [];
    const serverGroups   = result.groups   || [];

    if (serverProfiles.length > 0) {
        // Server has profiles → use server as source of truth
        await writeProfilesAtomic(serverProfiles);
        console.log(`[BNC_LOGIN_SYNC] ✓ Wrote ${serverProfiles.length} profiles for customerId=${customerId}`);
    } else {
        // Server has no profiles → upload local profiles (initial sync)
        const localProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        if (localProfiles.length > 0) {
            bncApiCall('POST', '/profiles/bulk', { profiles: localProfiles })
                .then(() => console.log('[BNC_SYNC] Uploaded', localProfiles.length, 'local profiles to server'))
                .catch(() => {});
        }
    }

    // Bidirectional group sync: merge server + local (server wins on conflict, local-only are uploaded)
    {
        const localGroups = fs.existsSync(GROUPS_FILE) ? await fs.readJson(GROUPS_FILE) : [];
        const serverIds = new Set(serverGroups.map(g => g.id));
        const localOnly = localGroups.filter(g => !serverIds.has(g.id));
        const merged = [...serverGroups.map(g => ({...g, synced: true})), ...localOnly];
        await fs.writeJson(GROUPS_FILE, merged);
        if (localOnly.length > 0) {
            bncApiCall('POST', '/groups/bulk', { groups: localOnly })
                .then(() => console.log('[BNC_SYNC] Uploaded', localOnly.length, 'local-only group(s) to server'))
                .catch(() => {});
        }
        console.log('[BNC_SYNC] Groups merged: server=', serverGroups.length, 'localOnly=', localOnly.length);
    }

    return { success: true, customer: result.customer, slots, teams };
});

// Terms of Service: check / accept / decline
ipcMain.handle('bnc-terms-status', async () => {
    try {
        if (fs.existsSync(BNC_TERMS_FILE)) {
            const data = fs.readJsonSync(BNC_TERMS_FILE);
            return { accepted: !!data?.acceptedAt, acceptedAt: data?.acceptedAt || null };
        }
    } catch (_) {}
    return { accepted: false };
});
ipcMain.handle('bnc-terms-accept', async () => {
    try { fs.writeJsonSync(BNC_TERMS_FILE, { acceptedAt: new Date().toISOString() }); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
});

// Refresh teams + slots ngay lập tức (cho nút reload workspace)
ipcMain.handle('bnc-refresh-teams', async () => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false, error: 'not_logged_in' };
    try {
        const res = await bncApiCall('GET', '/subscription');
        if (!res || res._statusCode === 401) return { success: false, error: 'unauthorized' };
        const teams = res.teams || [];
        saveBncAuth({ ...auth, teams, slots: res.slots || auth.slots });
        return { success: true, teams, slots: res.slots };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Đăng xuất: xóa token local
ipcMain.handle('bnc-logout', async () => {
    const prevAuth = getSavedBncAuth();
    console.log(`[BNC_LOGOUT] customerId=${prevAuth?.customerId}, email=${prevAuth?.email}`);
    try { fs.removeSync(BNC_AUTH_FILE); } catch (_) {}
    try { await fs.writeJson(PROFILES_FILE, []); console.log('[BNC_LOGOUT] ✓ Cleared profiles.json'); } catch (_) {}
    try { await fs.writeJson(GROUPS_FILE, []); console.log('[BNC_LOGOUT] ✓ Cleared groups.json'); } catch (_) {}
    return { success: true };
});

// Lấy trạng thái auth hiện tại (từ file + cache)
ipcMain.handle('bnc-get-auth', async () => {
    const auth = getSavedBncAuth();
    if (!auth) return { isLoggedIn: false };
    return {
        isLoggedIn: true,
        email: auth.email,
        customerId: auth.customerId,
        slots: auth.slots || { totalGranted: 0, slotsUsed: 0, available: 0 },
        teams: auth.teams || [],
        activeWorkspace: auth.activeWorkspace || 'own',
    };
});

// Poll sau thanh toán — trả về slots mới nhất từ server (webhook đã grantSlots)
ipcMain.handle('bnc-get-subscriptions', async () => {
    const result = await bncPingServer();
    const auth = getSavedBncAuth();
    const freshSlots = (result?._statusCode === 401 || result?._statusCode === 403) ? null : result?.slots;
    if (freshSlots && auth) saveBncAuth({ ...auth, slots: freshSlots });
    // Trả thêm latestSubMs để renderer phát hiện sub mới tạo sau khi modal mở
    const latestSubMs = result?.subscriptions?.length
        ? Math.max(...result.subscriptions.map(s => new Date(s.startDate || s.start_date || 0).getTime()))
        : (result?.subscription?.startDate ? new Date(result.subscription.startDate).getTime() : 0);
    return {
        slots: freshSlots || auth?.slots || { totalGranted: 0, slotsUsed: 0, available: 0 },
        latestSubMs: latestSubMs || 0,
    };
});

// Danh sách plans
ipcMain.handle('bnc-get-plans', async () => {
    try {
        return await new Promise((resolve) => {
            const url = new URL(BNC_API + '/plans');
            const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'GET' }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data).plans || []); } catch (_) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.setTimeout(8000, () => { req.destroy(); resolve([]); });
            req.end();
        });
    } catch (_) { return []; }
});

// Trigger install update từ renderer (user click "Cài ngay" trong UI)
ipcMain.handle('install-app-update', () => {
    app.quit();
});

// Mark notifications đã đọc trên server
ipcMain.handle('bnc-mark-notifications-read', async (_, ids) => {
    return await bncApiCall('PUT', '/notifications/read', { ids: ids || [] });
});

// Fetch notifications on-demand (khi user mở chuông, không đợi heartbeat 5 phút)
ipcMain.handle('bnc-fetch-notifications', async () => {
    const result = await bncApiCall('GET', '/notifications?limit=20');
    return result?.notifications || [];
});

// Fetch paginated notifications cho trang Thông Báo
ipcMain.handle('bnc-fetch-notifications-page', async (_, page = 1, limit = 20) => {
    return await bncApiCall('GET', `/notifications?page=${page}&limit=${limit}`);
});

// Thông tin thanh toán (bank + Lemon Squeezy — link quốc tế lấy từ server vì
// cần backend gắn customerId vào custom_data cho webhook nhận diện đúng người mua)
ipcMain.handle('bnc-get-payment-info', async () => {
    const auth = getSavedBncAuth();
    const info = {
        bankAcqId: '970415',
        bankAccountNo: '102876221138',
        bankAccountName: 'NGO VAN PHUC',
        transferContent: auth?.customerId ? `BNC${auth.customerId}` : 'BNC',
    };
    try {
        const remote = await bncApiCall('GET', '/payment-info');
        if (remote?._statusCode === 200) {
            if (remote.lemonSqueezy) info.lemonSqueezy = remote.lemonSqueezy;
            if (remote.stripe) info.stripe = remote.stripe;
        }
    } catch (_) { /* QR ngân hàng vẫn hiển thị bình thường nếu backend lỗi */ }
    return info;
});
// Tạo Stripe Checkout Session — gọi server, trả { url } để renderer mở bằng shell.openExternal
ipcMain.handle('bnc-stripe-create-checkout', async (_, plan) => {
    try {
        const result = await bncApiCall('POST', '/stripe/create-checkout-session', { plan });
        if (result?._statusCode === 200 && result.url) return { url: result.url };
        return { error: result?.message || 'Không tạo được phiên thanh toán' };
    } catch (e) {
        return { error: e.message };
    }
});

// ─── BNC Sync Profiles (manual / debug) ──────────────────────────────────────
ipcMain.handle('bnc-sync-profiles', async () => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false, error: 'Chưa đăng nhập' };

    try {
        // 1. Fetch tất cả profiles từ server (không filter sub — lấy hết)
        const res = await bncApiCall('GET', '/profiles');
        if (!res) return { success: false, error: 'Không kết nối được server' };
        if (res._statusCode === 401) return { success: false, error: 'Token hết hạn, vui lòng đăng nhập lại' };

        const serverProfiles = res.profiles || [];
        console.log('[BNC_SYNC] Server trả về', serverProfiles.length, 'profiles');

        if (serverProfiles.length === 0) {
            // Server không có → upload local lên
            const localProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
            if (localProfiles.length > 0) {
                const uploadRes = await bncApiCall('POST', '/profiles/bulk', { profiles: localProfiles });
                console.log('[BNC_SYNC] Upload local → server:', JSON.stringify(uploadRes));
                return { success: true, direction: 'upload', count: localProfiles.length, serverResponse: uploadRes };
            }
            return { success: true, direction: 'nothing', count: 0, message: 'Cả server lẫn local đều không có profile' };
        }

        // 2. Server có profiles → ghi đè local, mark tất cả đã sync
        const markedProfiles = serverProfiles.map(p => ({ ...p, syncedToServer: true }));
        await writeProfilesAtomic(markedProfiles);
        console.log('[BNC_SYNC] Ghi', markedProfiles.length, 'profiles xuống local');

        return {
            success: true,
            direction: 'download',
            count: serverProfiles.length,
            profiles: serverProfiles.map(p => ({ id: p.id, name: p.name })),
        };
    } catch (e) {
        console.error('[BNC_SYNC] Lỗi:', e.message);
        return { success: false, error: e.message };
    }
});

// ─── BNC Device Sessions ─────────────────────────────────────────────────────
ipcMain.handle('bnc-get-sessions', async () => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { error: 'not_logged_in' };
    try {
        const res = await bncApiCall('GET', '/sessions');
        const sub = await bncApiCall('GET', '/subscription');
        return {
            sessions: res.sessions || [],
            maxDevices: sub?.subscription?.maxDevices ?? 1,
            currentDeviceId: getDeviceId(),
        };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('bnc-kick-session', async (_, deviceId) => {
    if (!deviceId) return { error: 'missing deviceId' };
    try {
        await bncApiCall('DELETE', `/sessions/${deviceId}`);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});
// ─── BNC Team / Workspace ────────────────────────────────────────────────────

ipcMain.handle('bnc-team-invite', async (_, { email, permissions, allowedGroups, allowedProfiles, profileLimit, note }) => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false, error: 'Chưa đăng nhập' };
    try {
        const res = await bncApiCall('POST', '/team/invite', { email, permissions, allowedGroups, allowedProfiles, profileLimit, note });
        if (!res) return { success: false, error: 'Không thể kết nối server' };
        if (res._statusCode >= 400) return { success: false, error: res.message || 'Lỗi server' };
        return { success: true, member: res.member };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('bnc-team-get-members', async () => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { members: [] };
    try {
        const res = await bncApiCall('GET', '/team/members');
        return { members: res.members || [] };
    } catch (e) { return { members: [] }; }
});

ipcMain.handle('bnc-team-update-member', async (_, { memberId, permissions, allowedGroups, allowedProfiles, profileLimit, note }) => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false, error: 'Chưa đăng nhập' };
    try {
        const res = await bncApiCall('PUT', `/team/members/${memberId}`, { permissions, allowedGroups, allowedProfiles, profileLimit, note });
        if (!res) return { success: false, error: 'Không thể kết nối server' };
        if (res._statusCode >= 400) return { success: false, error: res.message || 'Lỗi server' };
        return { success: true, member: res.member };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('bnc-team-remove-member', async (_, memberId) => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false };
    try {
        await bncApiCall('DELETE', `/team/members/${memberId}`);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Chuyển workspace — load profiles của owner về local
ipcMain.handle('bnc-switch-workspace', async (_, ownerCustomerId) => {
    const auth = getSavedBncAuth();
    if (!auth?.accessToken) return { success: false, error: 'not_logged_in' };

    if (ownerCustomerId === 'own') {
        // Quay về workspace của chính mình
        saveBncAuth({ ...auth, activeWorkspace: 'own', activePermissions: null });
        // Sync lại profile của chính mình từ server
        try {
            const res = await bncApiCall('GET', '/profiles');
            const profiles = res.profiles || [];
            await writeProfilesAtomic(profiles);
            const groupRes = await bncApiCall('GET', '/groups');
            await fs.writeJson(GROUPS_FILE, groupRes.groups || []);
            if (mainWindow) mainWindow.webContents.send('bnc-workspace-loaded', { ownerCustomerId: 'own', profileCount: profiles.length });
        } catch (e) {
            console.error('[TEAM] Error restoring own workspace:', e.message);
        }
        return { success: true };
    }

    try {
        const res = await bncApiCall('GET', `/team/workspace/${ownerCustomerId}`);
        if (!res || res.error) return { success: false, error: res?.error || 'Không tải được workspace' };

        const profiles = res.profiles || [];
        const groups   = res.groups   || [];
        await writeProfilesAtomic(profiles);
        await fs.writeJson(GROUPS_FILE, groups);

        saveBncAuth({
            ...auth,
            activeWorkspace: ownerCustomerId,
            activePermissions: res.permissions || null,
            activeOwnerInfo: res.ownerInfo || null,
        });

        if (mainWindow) mainWindow.webContents.send('bnc-workspace-loaded', {
            ownerCustomerId,
            profileCount: profiles.length,
            permissions: res.permissions,
            ownerInfo: res.ownerInfo,
        });

        return { success: true, profileCount: profiles.length, permissions: res.permissions, ownerInfo: res.ownerInfo };
    } catch (e) {
        console.error('[TEAM] switchWorkspace error:', e.message);
        return { success: false, error: e.message };
    }
});

// ─────────────────────────────────────────────────────────────────────────────

// Lấy deviceId (dùng trong settings để hiển thị)
ipcMain.handle('license-get-status', async () => {
    return { deviceId: getDeviceId(), license: null };
});
// ─── Data Path Confirmed Flag ─────────────────────────────────────────────────
ipcMain.handle('data-path-get-confirmed', () => fs.existsSync(DATA_PATH_CONFIRMED));
ipcMain.handle('data-path-set-confirmed', () => {
    try {
        fs.ensureFileSync(DATA_PATH_CONFIRMED);
        debugLog('DATA_PATH_CONFIRMED', { path: DATA_PATH_CONFIRMED });
        return { success: true };
    } catch (e) { return { success: false }; }
});
// ─── Restart App ──────────────────────────────────────────────────────────────
ipcMain.handle('restart-app', () => {
    debugLog('RESTART', 'user triggered app restart');
    app.relaunch();
    app.exit(0);
});
// ─── Debug log từ renderer ────────────────────────────────────────────────────
ipcMain.handle('renderer-debug-log', (_, tag, data) => {
    debugLog('RENDERER:' + tag, data);
});
// ─── Check update — gọi yttool.vn/api/bnc/version ────────────────────────────
ipcMain.handle('check-app-update', async () => {
    const v = await bncCheckVersion();
    // Trigger electron-updater check GitHub song song (events xử lý qua update-downloaded)
    autoUpdater.checkForUpdates().catch(() => {});
    if (!v?.version) return { update: false };
    const current = app.getVersion();
    const isOutdated = v.version.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0;
    if (!isOutdated) return { update: false };
    return {
        update: true,
        remote: v.version,
        url: v.downloadUrl || 'https://yttool.vn',
        notes: v.releaseNotes || '',
        skipable: v.forceUpdate !== true,
    };
});
ipcMain.handle('check-xray-update', async () => { try { const data = await fetchJson('https://api.github.com/repos/XTLS/Xray-core/releases/latest'); if (!data || !data.tag_name) return { update: false }; const remoteVer = data.tag_name; const currentVer = await getLocalXrayVersion(); if (remoteVer !== currentVer) { let assetName = ''; const arch = os.arch(); const platform = os.platform(); if (platform === 'win32') assetName = `Xray-windows-${arch === 'x64' ? '64' : '32'}.zip`; else if (platform === 'darwin') assetName = `Xray-macos-${arch === 'arm64' ? 'arm64-v8a' : '64'}.zip`; else assetName = `Xray-linux-${arch === 'x64' ? '64' : '32'}.zip`; const downloadUrl = `https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/download/${remoteVer}/${assetName}`; return { update: true, remote: remoteVer.replace(/^v/, ''), downloadUrl }; } return { update: false }; } catch (e) { return { update: false }; } });
ipcMain.handle('download-xray-update', async (e, url) => {
    const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray';
    const tempBase = os.tmpdir();
    const updateId = `xray_update_${Date.now()}`;
    const tempDir = path.join(tempBase, updateId);
    const zipPath = path.join(tempDir, 'xray.zip');
    try {
        fs.mkdirSync(tempDir, { recursive: true });
        await downloadFile(url, zipPath);
        if (process.platform === 'win32') await new Promise((resolve) => exec('taskkill /F /IM xray.exe', () => resolve()));
        activeProcesses = {};
        await new Promise(r => setTimeout(r, 3000));
        const extractDir = path.join(tempDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZip(zipPath, extractDir);
        function findXrayBinary(dir) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const found = findXrayBinary(fullPath);
                    if (found) return found;
                } else if (file === exeName) {
                    return fullPath;
                }
            }
            return null;
        }
        const xrayBinary = findXrayBinary(extractDir);
        console.log('[Update Debug] Searched in:', extractDir);
        console.log('[Update Debug] Found binary:', xrayBinary);
        if (!xrayBinary) {
            // 列出所有文件帮助调试
            const allFiles = [];
            function listAllFiles(dir, prefix = '') {
                const files = fs.readdirSync(dir);
                files.forEach(file => {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        allFiles.push(prefix + file + '/');
                        listAllFiles(fullPath, prefix + file + '/');
                    } else {
                        allFiles.push(prefix + file);
                    }
                });
            }
            listAllFiles(extractDir);
            console.log('[Update Debug] All extracted files:', allFiles);
            throw new Error('Xray binary not found in package');
        }

        // Windows文件锁规避：先重命名旧文件，再复制新文件
        const oldPath = BIN_PATH + '.old';
        if (fs.existsSync(BIN_PATH)) {
            try {
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (e) { }
            fs.renameSync(BIN_PATH, oldPath);
        }
        fs.copyFileSync(xrayBinary, BIN_PATH);
        // 删除旧文件
        try {
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch (e) { }
        if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, '755');
        // 清理临时目录（即使失败也不影响更新）
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('[Cleanup Warning] Failed to remove temp dir:', cleanupErr.message);
        }
        return true;
    } catch (e) {
        console.error('Xray update failed:', e);
        try {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) { }
        return false;
    }
});
ipcMain.handle('get-running-ids', () => Object.keys(activeProcesses));

ipcMain.handle('verify-profile', async (event, profileId) => {
    const proc = activeProcesses[profileId];
    const isAlive = proc && proc.chromeProcess && proc.chromeProcess.exitCode === null;
    if (!isAlive) {
        return { error: 'Profile is not running. Please launch it first.' };
    }

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    const proxyIp = profile?.proxyStr?.split(':')[0] || '';
    const chromePath = getChromiumPath();
    const userDataDir = path.join(DATA_DIR, 'profiles', profileId, 'userdata');

    // Launch headless Chrome for verification without interfering with the running instance
    let verifyBrowser;
    try {
        verifyBrowser = await puppeteer.launch({
            headless: 'new',
            executablePath: chromePath,
            args: ['--no-first-run', '--disable-extensions', '--no-sandbox',
                   ...(profile?.proxyStr && profile.proxyStr !== 'direct' ? [`--proxy-server=socks5://${proxyIp}:${profile.proxyStr.split(':')[1]}`] : [])],
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation']
        });
        const results = await runVerify(verifyBrowser, proxyIp, (progress) => {
            event.sender.send('verify-progress', progress);
        });
        return { success: true, results };
    } finally {
        if (verifyBrowser) { try { await verifyBrowser.close(); } catch(e) {} }
    }
});
// Helper: cập nhật syncedToServer cho 1 profile trong file local
async function updateProfileSyncStatus(id, synced) {
    try {
        if (!fs.existsSync(PROFILES_FILE)) return;
        const profiles = await fs.readJson(PROFILES_FILE);
        const idx = profiles.findIndex(p => p.id === id);
        if (idx > -1) {
            profiles[idx].syncedToServer = synced;
            await writeProfilesAtomic(profiles);
        }
    } catch (_) {}
}

ipcMain.handle('get-profiles', async () => {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    try {
        return await fs.readJson(PROFILES_FILE);
    } catch (_) {
        return [];
    }
});
ipcMain.handle('update-profile', async (event, updatedProfile) => {
    let profiles = await fs.readJson(PROFILES_FILE);
    const index = profiles.findIndex(p => p.id === updatedProfile.id);
    if (index > -1) {
        profiles[index] = updatedProfile;
        await writeProfilesAtomic(profiles);
        // Sync to server (fire-and-forget)
        bncApiCall('PUT', `/profiles/${updatedProfile.id}`, updatedProfile).catch(() => {});
        return true;
    }
    return false;
});
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprint = data.fingerprint || generateFingerprint();

    // Apply timezone — "Auto" means geo-detect from proxy IP at launch time
    if (data.timezone) fingerprint.timezone = data.timezone;
    else fingerprint.timezone = "Auto";

    // Apply city and geolocation
    if (data.city) fingerprint.city = data.city;
    if (data.geolocation) fingerprint.geolocation = data.geolocation;

    // Apply language
    if (data.language && data.language !== 'auto') fingerprint.language = data.language;

    // Apply custom screen resolution if provided
    if (data.screen && data.screen.width && data.screen.height) {
        fingerprint.screen = data.screen;
        fingerprint.window = data.screen;
    }

    const auth = getSavedBncAuth();
    const newProfile = {
        id: uuidv4(),
        name: data.name,
        proxyStr: data.proxyStr,
        tags: data.tags || [],
        note: data.note || '',
        fingerprint: fingerprint,
        preProxyOverride: data.preProxyOverride || 'default',
        isSetup: false,
        createdAt: Date.now(),
        syncedToServer: false,  // pending — cập nhật sau khi server xác nhận
    };
    profiles.push(newProfile);
    await writeProfilesAtomic(profiles);

    // Sync to server — track kết quả và notify renderer
    bncApiCall('POST', '/profiles', newProfile).then(res => {
        const ok = res && (res._statusCode === 201 || res._statusCode === 200);
        updateProfileSyncStatus(newProfile.id, ok);
        if (!event.sender.isDestroyed()) {
            event.sender.send('profile-sync-status', { id: newProfile.id, syncedToServer: ok });
        }
    }).catch(() => {
        if (!event.sender.isDestroyed()) {
            event.sender.send('profile-sync-status', { id: newProfile.id, syncedToServer: false });
        }
    });

    debugLog('PROFILE_CREATED', {
        id: newProfile.id,
        name: newProfile.name,
        proxy: newProfile.proxyStr ? newProfile.proxyStr.split(':').slice(0,2).join(':') + ':***' : 'none',
        fingerprint: {
            timezone:          newProfile.fingerprint.timezone,
            language:          newProfile.fingerprint.language,
            screen:            newProfile.fingerprint.screen,
            devicePixelRatio:  newProfile.fingerprint.devicePixelRatio,
            hardwareConcurrency: newProfile.fingerprint.hardwareConcurrency,
            deviceMemory:      newProfile.fingerprint.deviceMemory,
            platform:          newProfile.fingerprint.platform,
            webgl_vendor:      newProfile.fingerprint.webgl?.vendor,
            webgl_renderer:    newProfile.fingerprint.webgl?.renderer,
            noiseSeed:         newProfile.fingerprint.noiseSeed,
            geolocation:       newProfile.fingerprint.geolocation,
        }
    });

    return newProfile;
});

// --- Profile Groups ---
function readGroups() {
    if (!fs.existsSync(GROUPS_FILE)) return [];
    try { return fs.readJsonSync(GROUPS_FILE); } catch (e) { return []; }
}
ipcMain.handle('get-groups', () => readGroups());
ipcMain.handle('save-group', async (event, data) => {
    const groups = readGroups();
    const group = { id: uuidv4(), name: data.name, createdAt: Date.now(), synced: false };
    groups.push(group);
    await fs.writeJson(GROUPS_FILE, groups);
    bncApiCall('POST', '/groups', group)
        .then(async () => {
            const gs = readGroups();
            const idx = gs.findIndex(g => g.id === group.id);
            if (idx > -1) { gs[idx].synced = true; await fs.writeJson(GROUPS_FILE, gs); }
        })
        .catch(() => {});
    return group;
});
ipcMain.handle('update-group', async (event, updated) => {
    const groups = readGroups();
    const idx = groups.findIndex(g => g.id === updated.id);
    if (idx > -1) { groups[idx] = { ...groups[idx], ...updated, synced: false }; await fs.writeJson(GROUPS_FILE, groups); }
    if (idx > -1) bncApiCall('PUT', `/groups/${updated.id}`, { name: updated.name })
        .then(async () => {
            const gs = readGroups(); const i = gs.findIndex(g => g.id === updated.id);
            if (i > -1) { gs[i].synced = true; await fs.writeJson(GROUPS_FILE, gs); }
        }).catch(() => {});
    return idx > -1;
});
ipcMain.handle('sync-group', async (event, id) => {
    const groups = readGroups();
    const group = groups.find(g => g.id === id);
    if (!group) return false;
    try {
        await bncApiCall('PUT', `/groups/${id}`, { name: group.name });
        const gs = readGroups();
        const idx = gs.findIndex(g => g.id === id);
        if (idx > -1) { gs[idx].synced = true; await fs.writeJson(GROUPS_FILE, gs); }
        return true;
    } catch (e) {
        return false;
    }
});
ipcMain.handle('delete-group', async (event, id) => {
    // Remove group and unassign all profiles in that group
    let groups = readGroups();
    groups = groups.filter(g => g.id !== id);
    await fs.writeJson(GROUPS_FILE, groups);
    if (fs.existsSync(PROFILES_FILE)) {
        let profiles = await fs.readJson(PROFILES_FILE);
        profiles = profiles.map(p => p.groupId === id ? { ...p, groupId: null } : p);
        await writeProfilesAtomic(profiles);
    }
    // Sync to server (fire-and-forget)
    bncApiCall('DELETE', `/groups/${id}`).catch(() => {});
    return true;
});
ipcMain.handle('assign-profile-group', async (event, { profileId, groupId }) => {
    if (!fs.existsSync(PROFILES_FILE)) return false;
    let profiles = await fs.readJson(PROFILES_FILE);
    const idx = profiles.findIndex(p => p.id === profileId);
    if (idx > -1) {
        profiles[idx].groupId = groupId || null;
        await writeProfilesAtomic(profiles);
        // Sync to server (fire-and-forget)
        bncApiCall('PUT', `/profiles/${profileId}`, { groupId: groupId || null }).catch(() => {});
    }
    return idx > -1;
});

ipcMain.handle('delete-profile', async (event, id) => {
    // 关闭正在运行的进程
    if (activeProcesses[id]) {
        await forceKill(activeProcesses[id].xrayPid);
        try { await forceKill(activeProcesses[id].chromeProcess?.pid); } catch (e) { }

        // 关闭日志文件描述符（Windows 必须）
        if (activeProcesses[id].logFd !== undefined) {
            try {
                fs.closeSync(activeProcesses[id].logFd);
                console.log('Closed log file descriptor');
            } catch (e) {
                console.error('Failed to close log fd:', e.message);
            }
        }

        delete activeProcesses[id];
        // Windows 需要更长的等待时间让文件释放
        await new Promise(r => setTimeout(r, 1000));
    }

    // 从 profiles.json 中删除
    let profiles = await fs.readJson(PROFILES_FILE);
    profiles = profiles.filter(p => p.id !== id);
    await writeProfilesAtomic(profiles);
    // Sync to server (fire-and-forget)
    bncApiCall('DELETE', `/profiles/${id}`).catch(() => {});

    // 永久删除 profile 文件夹（带重试机制）
    const profileDir = path.join(DATA_PATH, id);
    let deleted = false;

    // 尝试删除 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (fs.existsSync(profileDir)) {
                // 使用 fs-extra 的 remove，它会递归删除
                await fs.remove(profileDir);
                console.log(`Deleted profile folder: ${profileDir}`);
                deleted = true;
                break;
            } else {
                deleted = true;
                break;
            }
        } catch (err) {
            console.error(`Delete attempt ${attempt} failed:`, err.message);
            if (attempt < 3) {
                // 等待后重试
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
    }

    // 如果删除失败，移到回收站作为后备方案
    if (!deleted && fs.existsSync(profileDir)) {
        console.warn(`Failed to delete, moving to trash: ${profileDir}`);
        const trashDest = path.join(TRASH_PATH, `${id}_${Date.now()}`);
        try {
            await fs.move(profileDir, trashDest);
            console.log(`Moved to trash: ${trashDest}`);
        } catch (err) {
            console.error(`Failed to move to trash:`, err);
        }
    }

    return true;
});
ipcMain.handle('get-settings', async () => { if (fs.existsSync(SETTINGS_FILE)) return fs.readJson(SETTINGS_FILE); return { preProxies: [], mode: 'single', enablePreProxy: false, enableRemoteDebugging: false }; });
ipcMain.handle('save-settings', async (e, settings) => { await fs.writeJson(SETTINGS_FILE, settings); return true; });
ipcMain.handle('get-chrome-path', async () => {
    const current = getChromiumPath();
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    return { current, custom: settings.customChromePath || '' };
});

ipcMain.handle('select-chrome-binary', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Select Chrome / Fingerprint-Chromium binary',
        filters: process.platform === 'win32'
            ? [{ name: 'Executable', extensions: ['exe'] }]
            : [{ name: 'All Files', extensions: ['*'] }]
    });
    if (!filePaths || filePaths.length === 0) return null;
    const selected = filePaths[0];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    settings.customChromePath = selected;
    await fs.writeJson(SETTINGS_FILE, settings);
    return selected;
});

ipcMain.handle('clear-chrome-binary', async () => {
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    delete settings.customChromePath;
    await fs.writeJson(SETTINGS_FILE, settings);
    return true;
});


// ─── Custom Chromium (User's own build) ──────────────────────────────────────
// Download from user's own GitHub repo (set CUSTOM_CHROMIUM_REPO above)

function getCustomChromiumPath() {
    try {
        const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
        const candidate = path.join(CUSTOM_CHROMIUM_DIR, exe);
        if (fs.existsSync(candidate)) return candidate;
    } catch (e) {}
    return null;
}

ipcMain.handle('check-custom-chromium', async () => {
    const exePath = getCustomChromiumPath();
    if (!exePath) return { installed: false, repo: CUSTOM_CHROMIUM_REPO };
    try {
        const metaPath = path.join(CUSTOM_CHROMIUM_DIR, 'geekez-meta.json');
        const fpMetaPath = path.join(CUSTOM_CHROMIUM_DIR, 'fp-meta.json');
        const meta = fs.existsSync(metaPath) ? fs.readJsonSync(metaPath) :
                     fs.existsSync(fpMetaPath) ? fs.readJsonSync(fpMetaPath) : {};
        return { installed: true, path: exePath, version: meta.version || 'unknown',
                 repo: CUSTOM_CHROMIUM_REPO, patches: meta.patches || [] };
    } catch (e) {
        return { installed: true, path: exePath, version: 'unknown', repo: CUSTOM_CHROMIUM_REPO };
    }
});

ipcMain.handle('download-custom-chromium', async (event) => {
    const sender = event.sender;
    const sendProgress = (stage, percent) => {
        try { sender.send('custom-chromium-progress', { stage, percent }); } catch (e) {}
    };

    try {
        sendProgress('Fetching release info from ' + CUSTOM_CHROMIUM_REPO + '...', 2);

        const releaseData = await new Promise((resolve, reject) => {
            https.get(
                `https://api.github.com/repos/${CUSTOM_CHROMIUM_REPO}/releases/latest`,
                { headers: { 'User-Agent': 'GeekezBrowser/1.4.0' } },
                (res) => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(new Error('Failed to parse release info')); }
                    });
                    res.on('error', reject);
                }
            ).on('error', reject);
        });

        const version = releaseData.tag_name;
        if (!version) throw new Error('No release found in ' + CUSTOM_CHROMIUM_REPO);

        // Select asset based on platform
        const platformMap = { win32: 'windows', darwin: 'mac', linux: 'linux' };
        const platformKey = platformMap[process.platform] || process.platform;

        const asset = (releaseData.assets || []).find(a => {
            const n = a.name.toLowerCase();
            return n.includes('.zip') && (
                n.includes(platformKey) ||
                (process.platform === 'win32' && n.includes('win')) ||
                (process.platform === 'darwin' && (n.includes('mac') || n.includes('darwin')))
            );
        });

        if (!asset) {
            const available = (releaseData.assets || []).map(a => a.name).join(', ');
            throw new Error(`No ${platformKey} asset found. Available: ${available}`);
        }

        const sizeMB = Math.round(asset.size / 1024 / 1024);
        sendProgress(`Downloading ${asset.name} (${sizeMB} MB)...`, 5);

        const tempFile = path.join(app.getPath('temp'), `custom-chromium-${version}.zip`);
        const total = asset.size;

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(tempFile);
            let received = 0;
            function doGet(url) {
                https.get(url, { headers: { 'User-Agent': 'GeekezBrowser/1.4.0' } }, (res) => {
                    if ([301, 302, 307, 308].includes(res.statusCode)) {
                        res.resume();
                        return doGet(res.headers.location);
                    }
                    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                    res.on('data', chunk => {
                        received += chunk.length;
                        file.write(chunk);
                        const pct = Math.round((received / total) * 75) + 5;
                        sendProgress(`Downloading... ${Math.round(received/1024/1024)}/${sizeMB} MB`, pct);
                    });
                    res.on('end', () => { file.end(); resolve(); });
                    res.on('error', reject);
                }).on('error', reject);
            }
            doGet(asset.browser_download_url);
        });

        sendProgress('Extracting...', 82);
        fs.ensureDirSync(CUSTOM_CHROMIUM_DIR);
        fs.emptyDirSync(CUSTOM_CHROMIUM_DIR);

        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(CUSTOM_CHROMIUM_DIR, true);

        sendProgress('Locating chrome binary...', 93);

        const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
        function findExe(dir, target) {
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (fs.statSync(full).isDirectory()) { const r = findExe(full, target); if (r) return r; }
                else if (entry === target) return full;
            }
            return null;
        }

        let exePath = findExe(CUSTOM_CHROMIUM_DIR, exeName);
        if (!exePath) throw new Error('Chrome binary not found in zip');

        const exeDir = path.dirname(exePath);
        if (exeDir !== CUSTOM_CHROMIUM_DIR) {
            for (const entry of fs.readdirSync(exeDir)) {
                fs.moveSync(path.join(exeDir, entry), path.join(CUSTOM_CHROMIUM_DIR, entry), { overwrite: true });
            }
            exePath = path.join(CUSTOM_CHROMIUM_DIR, exeName);
        }

        if (process.platform !== 'win32') {
            fs.chmodSync(exePath, 0o755);
        }

        fs.writeJsonSync(path.join(CUSTOM_CHROMIUM_DIR, 'fp-meta.json'), {
            version, downloadedAt: new Date().toISOString(), source: CUSTOM_CHROMIUM_REPO
        });

        try { fs.removeSync(tempFile); } catch (e) {}

        sendProgress('Done!', 100);
        return { success: true, version, path: exePath };

    } catch (err) {
        sendProgress(`Error: ${err.message}`, -1);
        throw err;
    }
});

ipcMain.handle('check-chrome-for-testing', async () => {
    const p = getChromeForTestingPath();
    if (!p) return { installed: false };
    try {
        const meta = fs.readJsonSync(path.join(CHROME_FOR_TESTING_DIR, 'cft-meta.json'));
        return { installed: true, version: meta.version, path: p };
    } catch (e) {
        return { installed: true, version: 'unknown', path: p };
    }
});

ipcMain.handle('download-chrome-for-testing', async (event) => {
    const sender = event.sender;
    const sendProgress = (stage, percent) => {
        try { sender.send('cft-progress', { stage, percent }); } catch (e) {}
    };

    try {
        sendProgress('Fetching version info...', 2);

        // 1. Get latest stable version from Google's CfT API
        const apiData = await new Promise((resolve, reject) => {
            https.get(
                'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
                { headers: { 'User-Agent': 'GeekezBrowser/1.4.0' } },
                (res) => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(new Error('Failed to parse CfT version info')); }
                    });
                    res.on('error', reject);
                }
            ).on('error', reject);
        });

        const stable = apiData.channels && apiData.channels.Stable;
        if (!stable) throw new Error('Stable channel not found in CfT API response');
        const version = stable.version;

        const platform = process.platform === 'win32' ? 'win64'
            : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
            : 'linux64';
        const chromeDownloads = stable.downloads && stable.downloads.chrome;
        if (!chromeDownloads) throw new Error('Chrome downloads not found in CfT API response');
        const asset = chromeDownloads.find(d => d.platform === platform);
        if (!asset) throw new Error(`No CfT download found for platform: ${platform}`);

        sendProgress(`Downloading Chrome for Testing ${version} (~150 MB)...`, 5);

        // 2. Download zip with progress
        const tempFile = path.join(app.getPath('temp'), `chrome-for-testing-${version}.zip`);
        // Remove stale temp file from previous failed attempts
        try { fs.removeSync(tempFile); } catch (e) {}

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(tempFile);
            let received = 0;
            let total = 0;
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve();
            };

            function doGet(url) {
                https.get(url, { headers: { 'User-Agent': 'GeekezBrowser/1.4.0' } }, (res) => {
                    if ([301, 302, 307, 308].includes(res.statusCode)) {
                        res.resume();
                        return doGet(res.headers.location);
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return done(new Error(`HTTP ${res.statusCode} downloading CfT`));
                    }
                    total = parseInt(res.headers['content-length'] || '0', 10);
                    res.on('data', chunk => {
                        received += chunk.length;
                        file.write(chunk);
                        if (total > 0) {
                            const pct = Math.round((received / total) * 75) + 5;
                            const mb = Math.round(received / 1024 / 1024);
                            const totalMb = Math.round(total / 1024 / 1024);
                            sendProgress(`Downloading... ${mb}/${totalMb} MB`, pct);
                        }
                    });
                    res.on('end', () => file.end());
                    res.on('error', done);
                }).on('error', done);
            }
            file.on('finish', () => done());
            file.on('error', done);
            doGet(asset.url);
        });

        // Validate downloaded file is a zip (magic bytes PK\x03\x04)
        const fileStat = fs.statSync(tempFile);
        if (fileStat.size < 1024 * 1024) {
            const sample = fs.readFileSync(tempFile, { encoding: 'utf8', flag: 'r' }).substring(0, 200);
            try { fs.removeSync(tempFile); } catch (e) {}
            throw new Error(`Downloaded file too small (${fileStat.size} bytes). Possible network error. Preview: ${sample.replace(/\n/g, ' ')}`);
        }
        const magic = Buffer.alloc(4);
        const fd = fs.openSync(tempFile, 'r');
        fs.readSync(fd, magic, 0, 4, 0);
        fs.closeSync(fd);
        if (magic[0] !== 0x50 || magic[1] !== 0x4B) {
            try { fs.removeSync(tempFile); } catch (e) {}
            throw new Error(`Downloaded file is not a ZIP (magic: ${magic.toString('hex')}). Check network/proxy.`);
        }

        // 3. Extract zip
        sendProgress('Extracting...', 82);
        fs.ensureDirSync(CHROME_FOR_TESTING_DIR);
        fs.emptyDirSync(CHROME_FOR_TESTING_DIR);

        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(CHROME_FOR_TESTING_DIR, true);

        sendProgress('Locating chrome.exe...', 93);

        // 4. Flatten nested directory if needed
        function findExe(dir, target) {
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (fs.statSync(full).isDirectory()) {
                    const r = findExe(full, target);
                    if (r) return r;
                } else if (entry === target) return full;
            }
            return null;
        }

        const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
        let exePath = findExe(CHROME_FOR_TESTING_DIR, exeName);
        if (!exePath) throw new Error(`${exeName} not found after extraction`);

        const exeDir = path.dirname(exePath);
        if (exeDir !== CHROME_FOR_TESTING_DIR) {
            for (const entry of fs.readdirSync(exeDir)) {
                fs.moveSync(
                    path.join(exeDir, entry),
                    path.join(CHROME_FOR_TESTING_DIR, entry),
                    { overwrite: true }
                );
            }
            exePath = path.join(CHROME_FOR_TESTING_DIR, exeName);
        }

        // 5. Save metadata and cleanup
        fs.writeJsonSync(path.join(CHROME_FOR_TESTING_DIR, 'cft-meta.json'), {
            version, downloadedAt: new Date().toISOString(), source: 'googlechromelabs/chrome-for-testing'
        });
        try { fs.removeSync(tempFile); } catch (e) {}

        sendProgress('Done!', 100);
        return { success: true, version, path: exePath };

    } catch (err) {
        sendProgress(`Error: ${err.message}`, -1);
        throw err;
    }
});

ipcMain.handle('select-extension-folder', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Extension Folder'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});
ipcMain.handle('add-user-extension', async (e, extPath) => {
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    if (!settings.userExtensions) settings.userExtensions = [];
    if (!settings.userExtensions.includes(extPath)) {
        settings.userExtensions.push(extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('remove-user-extension', async (_, extPath) => {
    if (!fs.existsSync(SETTINGS_FILE)) return true;
    const settings = await fs.readJson(SETTINGS_FILE);
    if (settings.userExtensions) {
        settings.userExtensions = settings.userExtensions.filter(p => p !== extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('get-user-extensions', async () => {
    if (!fs.existsSync(SETTINGS_FILE)) return [];
    const settings = await fs.readJson(SETTINGS_FILE);
    return settings.userExtensions || [];
});
ipcMain.handle('open-url', async (_, url) => { await shell.openExternal(url); });

// --- 自定义数据目录 ---
ipcMain.handle('get-data-path-info', async () => {
    return {
        currentPath: DATA_PATH,
        defaultPath: DEFAULT_DATA_PATH,
        isCustom: DATA_PATH !== DEFAULT_DATA_PATH
    };
});

ipcMain.handle('select-data-directory', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Data Directory'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});

ipcMain.handle('set-data-directory', async (_, { newPath, migrate }) => {
    try {
        // 验证路径
        if (!newPath) {
            return { success: false, error: 'Invalid path' };
        }

        // 确保目录存在
        await fs.ensureDir(newPath);

        // 检查是否有写入权限
        const testFile = path.join(newPath, '.geekez-test');
        try {
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
        } catch (e) {
            return { success: false, error: 'No write permission to selected directory' };
        }

        // 如果需要迁移数据
        if (migrate && DATA_PATH !== newPath) {
            const oldProfiles = path.join(DATA_PATH, 'profiles.json');
            const oldSettings = path.join(DATA_PATH, 'settings.json');

            // 迁移 profiles.json
            if (fs.existsSync(oldProfiles)) {
                await fs.copy(oldProfiles, path.join(newPath, 'profiles.json'));
            }
            // 迁移 settings.json
            if (fs.existsSync(oldSettings)) {
                await fs.copy(oldSettings, path.join(newPath, 'settings.json'));
            }

            // 迁移所有环境数据目录
            const profiles = fs.existsSync(oldProfiles) ? await fs.readJson(oldProfiles) : [];
            for (const profile of profiles) {
                const oldDir = path.join(DATA_PATH, profile.id);
                const newDir = path.join(newPath, profile.id);
                if (fs.existsSync(oldDir)) {
                    console.log(`Migrating profile ${profile.id}...`);
                    await fs.copy(oldDir, newDir);
                }
            }
        }

        // 保存新路径到配置
        await fs.writeJson(APP_CONFIG_FILE, { customDataPath: newPath });

        return { success: true, requiresRestart: true };
    } catch (err) {
        console.error('Failed to set data directory:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('reset-data-directory', async () => {
    try {
        // 删除自定义配置
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = await fs.readJson(APP_CONFIG_FILE);
            delete config.customDataPath;
            await fs.writeJson(APP_CONFIG_FILE, config);
        }
        return { success: true, requiresRestart: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// --- 导出/导入功能 (重构版) ---

// 辅助函数：清理 fingerprint 中的无用字段
function cleanFingerprint(fp) {
    if (!fp) return fp;
    const cleaned = { ...fp };
    // Strip all OS-specific fields — these are regenerated for the target OS on first launch
    delete cleaned.userAgent;
    delete cleaned.userAgentMetadata;
    delete cleaned.webgl;
    delete cleaned.webgpu;
    delete cleaned.platform;
    delete cleaned.mediaDevices;
    return cleaned;
}

// Re-generate OS-specific fingerprint fields for the current platform.
// Called after importing a profile from another OS so it works correctly on this machine.
function normalizeFingerprintForPlatform(fp) {
    if (!fp) return fp;
    const needsRegen = !fp.platform || !fp.webgl || !fp.webgpu || !fp.mediaDevices || !fp.userAgent;
    if (needsRegen) {
        const fresh = generateFingerprint();
        if (!fp.platform)     fp.platform     = fresh.platform;
        if (!fp.userAgent)    fp.userAgent     = fresh.userAgent;
        if (!fp.webgl)        fp.webgl         = fresh.webgl;
        if (!fp.webgpu)       fp.webgpu        = fresh.webgpu;
        if (!fp.mediaDevices) fp.mediaDevices  = fresh.mediaDevices;
    }
    return fp;
}

// 加密辅助函数
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC_HEADER = Buffer.from('GKEZ'); // BNC magic bytes

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function encryptData(data, password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 格式: MAGIC(4) + VERSION(4) + SALT(16) + IV(12) + AUTH_TAG(16) + ENCRYPTED_DATA
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1, 0); // Version 1

    return Buffer.concat([MAGIC_HEADER, version, salt, iv, authTag, encrypted]);
}

function decryptData(encryptedBuffer, password) {
    // 验证 magic header
    const magic = encryptedBuffer.slice(0, 4);
    if (!magic.equals(MAGIC_HEADER)) {
        throw new Error('Invalid backup file format');
    }

    let offset = 4;
    const version = encryptedBuffer.readUInt32LE(offset);
    offset += 4;

    if (version !== 1) {
        throw new Error(`Unsupported backup version: ${version}`);
    }

    const salt = encryptedBuffer.slice(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;

    const iv = encryptedBuffer.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    const authTag = encryptedBuffer.slice(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;

    const encrypted = encryptedBuffer.slice(offset);

    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// --- 密码加密存储辅助函数 ---
async function readEncryptedPasswords(pwFile, profileId) {
    if (!fs.existsSync(pwFile)) return [];
    try {
        const encrypted = await fs.readFile(pwFile);
        const decrypted = decryptData(encrypted, 'GeekEZ_PW_' + profileId);
        return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
        try {
            // 兼容之前明文保存的 JSON，透明升级到加密
            const plain = await fs.readJson(pwFile);
            if (Array.isArray(plain)) {
                writeEncryptedPasswords(pwFile, plain, profileId).catch(() => { });
                return plain;
            }
        } catch (e2) { }
    }
    return [];
}

async function writeEncryptedPasswords(pwFile, passwords, profileId) {
    const data = Buffer.from(JSON.stringify(passwords), 'utf8');
    const encrypted = encryptData(data, 'GeekEZ_PW_' + profileId);
    await fs.writeFile(pwFile, encrypted);
}

// 获取用于选择器的环境列表
ipcMain.handle('get-export-profiles', async () => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags || [] }));
});

// 导出选定环境 (精简版，不含浏览器数据)
ipcMain.handle('export-selected-data', async (_, { type, profileIds }) => {
    const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

    // 过滤选中的环境
    const selectedProfiles = allProfiles
        .filter(p => profileIds.includes(p.id))
        .map(p => ({
            ...p,
            fingerprint: cleanFingerprint(p.fingerprint)
        }));

    let exportObj = {};

    if (type === 'all' || type === 'profiles') {
        exportObj.profiles = selectedProfiles;
    }
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
    }

    if (Object.keys(exportObj).length === 0) return { success: false, error: 'No data to export' };

    const typeNames = { all: 'profiles', profiles: 'profiles', proxies: 'proxies' };
    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `BNC_Backup_${typeNames[type] || type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return { success: true, count: selectedProfiles.length };
    }
    return { success: false, cancelled: true };
});

// 完整备份 (v2 跨平台方案 - 含浏览器数据，加密)
ipcMain.handle('export-full-backup', async (_, { profileIds, password }) => {
    try {
        const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

        const selectedProfiles = allProfiles
            .filter(p => profileIds.includes(p.id))
            .map(p => ({ ...p, fingerprint: cleanFingerprint(p.fingerprint) }));

        const backupData = {
            version: 2,
            createdAt: Date.now(),
            profiles: selectedProfiles,
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // --- 1. 文件/目录拷贝：书签、历史记录、扩展数据等 ---
        const filesToBackup = [
            'Bookmarks', 'Bookmarks.bak',
            'History', 'History-journal',
            'Favicons', 'Favicons-journal',
            'Preferences', 'Secure Preferences',
            'Top Sites', 'Top Sites-journal',
            'Web Data', 'Web Data-journal'
        ];

        for (const profile of selectedProfiles) {
            const defaultDir = path.join(DATA_PATH, profile.id, 'browser_data', 'Default');
            if (!fs.existsSync(defaultDir)) continue;
            const browserFiles = {};
            for (const fileName of filesToBackup) {
                const filePath = path.join(defaultDir, fileName);
                if (fs.existsSync(filePath)) {
                    try {
                        const content = await fs.readFile(filePath);
                        browserFiles[fileName] = content.toString('base64');
                    } catch (err) {
                        console.error(`备份文件失败 ${fileName}:`, err.message);
                    }
                }
            }
            if (Object.keys(browserFiles).length > 0) {
                backupData.browserData[profile.id] = browserFiles;
            }
        }

        // --- 2. CDP 获取 Cookie + 解密密码 ---
        const chromePath = getChromiumPath();
        for (const profile of selectedProfiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            if (!fs.existsSync(profileDataDir)) continue;
            if (!backupData.browserData[profile.id]) backupData.browserData[profile.id] = {};

            // 2a. Cookie: 无头启动浏览器 → CDP 获取明文 Cookie
            try {
                const browser = await puppeteer.launch({
                    headless: 'new',
                    executablePath: chromePath,
                    userDataDir: profileDataDir,
                    args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu',
                           '--disable-features=LockProfileCookieDatabase'],
                    defaultViewport: null,
                    ignoreDefaultArgs: ['--enable-automation'],
                });
                const client = await browser.target().createCDPSession();
                const { cookies } = await client.send('Network.getAllCookies');
                await browser.close();
                backupData.browserData[profile.id]._cookies = cookies;
                console.log(`已导出 ${cookies.length} 个 Cookie (${profile.id})`);
            } catch (err) {
                console.error(`CDP Cookie 导出失败 (${profile.id}):`, err.message);
            }

            // 2b. 密码: 读取 passwords.json (GeeKez 扩展，解密)
            try {
                const pwJsonFile = path.join(DATA_PATH, profile.id, 'passwords.json');
                const passwords = await readEncryptedPasswords(pwJsonFile, profile.id);
                if (passwords.length > 0) {
                    backupData.browserData[profile.id]._passwords = passwords;
                    console.log(`已导出 ${passwords.length} 个密码 from passwords.json (${profile.id})`);
                }
            } catch (err) {
                console.error(`密码导出失败 (${profile.id}):`, err.message);
            }
        }

        // 压缩并加密
        const jsonData = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonData, 'utf8'));
        const encrypted = encryptData(compressed, password);

        const { filePath } = await dialog.showSaveDialog({
            title: 'Export Full Backup',
            defaultPath: `BNC_FullBackup_${Date.now()}.bnc`,
            filters: [{ name: 'BNC Backup', extensions: ['bnc'] }]
        });

        if (filePath) {
            await fs.writeFile(filePath, encrypted);
            return { success: true, count: selectedProfiles.length };
        }
        return { success: false, cancelled: true };
    } catch (err) {
        console.error('Full backup failed:', err);
        return { success: false, error: err.message };
    }
});

// 导入完整备份 (支持 v1 旧格式 + v2 跨平台格式)
ipcMain.handle('import-full-backup', async (_, { password }) => {
    try {
        const { filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'BNC Backup', extensions: ['bnc'] }]
        });

        if (!filePaths || filePaths.length === 0) {
            return { success: false, cancelled: true };
        }

        const encrypted = await fs.readFile(filePaths[0]);
        const decrypted = decryptData(encrypted, password);
        const decompressed = await gunzip(decrypted);
        const backupData = JSON.parse(decompressed.toString('utf8'));

        if (backupData.version !== 1 && backupData.version !== 2) {
            throw new Error(`不支持的备份版本: ${backupData.version}`);
        }

        // 还原 profiles
        const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        let importedCount = 0;
        for (const profile of backupData.profiles) {
            // Re-generate platform-specific fingerprint fields for the target OS
            normalizeFingerprintForPlatform(profile.fingerprint);
            const idx = currentProfiles.findIndex(cp => cp.id === profile.id);
            if (idx > -1) { currentProfiles[idx] = profile; } else { currentProfiles.push(profile); }
            importedCount++;
        }
        await writeProfilesAtomic(currentProfiles);

        // 还原代理和订阅
        const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
        if (backupData.preProxies) {
            if (!currentSettings.preProxies) currentSettings.preProxies = [];
            for (const p of backupData.preProxies) {
                if (!currentSettings.preProxies.find(cp => cp.id === p.id)) currentSettings.preProxies.push(p);
            }
        }
        if (backupData.subscriptions) {
            if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
            for (const s of backupData.subscriptions) {
                if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) currentSettings.subscriptions.push(s);
            }
        }
        await fs.writeJson(SETTINGS_FILE, currentSettings);

        // 还原浏览器数据
        const chromePath = getChromiumPath();
        for (const [profileId, browserFiles] of Object.entries(backupData.browserData || {})) {
            const profileDataDir = path.join(DATA_PATH, profileId, 'browser_data');
            const defaultDir = path.join(profileDataDir, 'Default');
            await fs.ensureDir(defaultDir);

            // 1. 还原文件拷贝数据 (书签、历史记录等)
            for (const [fileName, content] of Object.entries(browserFiles)) {
                if (fileName.startsWith('_')) continue; // 跳过 _cookies, _passwords
                if (typeof content !== 'string') continue;
                try {
                    // v2: 直接文件名 → Default/ 下
                    // v1 兼容: 带路径的文件名
                    if (fileName.includes('/') || fileName.includes('\\')) {
                        const targetPath = path.join(profileDataDir, fileName);
                        await fs.ensureDir(path.dirname(targetPath));
                        await fs.writeFile(targetPath, Buffer.from(content, 'base64'));
                    } else {
                        await fs.writeFile(path.join(defaultDir, fileName), Buffer.from(content, 'base64'));
                    }
                } catch (err) {
                    console.error(`还原文件失败 ${fileName}:`, err.message);
                }
            }

            // 2. v2 格式: 还原 Cookie (CDP) - 必须先于密码写入
            const hasCookies = browserFiles._cookies && browserFiles._cookies.length > 0;
            const hasPasswords = browserFiles._passwords && browserFiles._passwords.length > 0;

            if (hasCookies || hasPasswords) {
                // 先启动浏览器处理 Cookie（这也会生成 Local State 和加密密钥）
                try {
                    const browser = await puppeteer.launch({
                        headless: 'new', executablePath: chromePath, userDataDir: profileDataDir,
                        args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu',
                               '--disable-features=LockProfileCookieDatabase'],
                        defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
                    });
                    if (hasCookies) {
                        const client = await browser.target().createCDPSession();
                        let cookieCount = 0;
                        for (const cookie of browserFiles._cookies) {
                            try {
                                const params = {
                                    name: cookie.name, value: cookie.value,
                                    domain: cookie.domain, path: cookie.path,
                                    secure: cookie.secure, httpOnly: cookie.httpOnly,
                                    sameSite: cookie.sameSite || 'Lax',
                                };
                                if (cookie.expires > 0) params.expires = cookie.expires;
                                await client.send('Network.setCookie', params);
                                cookieCount++;
                            } catch (ce) { }
                        }
                        console.log(`已导入 ${cookieCount}/${browserFiles._cookies.length} 个 Cookie (${profileId})`);
                    }
                    await browser.close();
                    // 等待浏览器完全释放文件锁
                    await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                    console.error(`CDP Cookie 导入失败 (${profileId}):`, err.message);
                }
            }

            // 3. v2 格式: 密码写入 passwords.json (加密)
            if (hasPasswords) {
                try {
                    const pwFile = path.join(DATA_PATH, profileId, 'passwords.json');
                    await writeEncryptedPasswords(pwFile, browserFiles._passwords, profileId);
                    console.log(`已恢复 ${browserFiles._passwords.length} 个密码到 passwords.json (${profileId})`);
                } catch (err) {
                    console.error(`密码恢复失败 (${profileId}):`, err.message);
                }
            }
        }

        return { success: true, count: importedCount };
    } catch (err) {
        console.error('Import full backup failed:', err);
        if (err.message.includes('Unsupported state') || err.message.includes('bad decrypt')) {
            return { success: false, error: '密码错误或文件已损坏' };
        }
        return { success: false, error: err.message };
    }
});

// 导入普通备份 (YAML)
ipcMain.handle('import-data', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePaths && filePaths.length > 0) {
        try {
            const content = await fs.readFile(filePaths[0], 'utf8');
            const data = yaml.load(content);
            let updated = false;

            if (data.profiles || data.preProxies || data.subscriptions) {
                if (Array.isArray(data.profiles)) {
                    const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    data.profiles.forEach(p => {
                        // Re-generate platform-specific fingerprint fields for this OS
                        normalizeFingerprintForPlatform(p.fingerprint);
                        const idx = currentProfiles.findIndex(cp => cp.id === p.id);
                        if (idx > -1) currentProfiles[idx] = p;
                        else {
                            if (!p.id) p.id = uuidv4();
                            currentProfiles.push(p);
                        }
                    });
                    await writeProfilesAtomic(currentProfiles);
                    updated = true;
                }
                if (Array.isArray(data.preProxies) || Array.isArray(data.subscriptions)) {
                    const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
                    if (data.preProxies) {
                        if (!currentSettings.preProxies) currentSettings.preProxies = [];
                        data.preProxies.forEach(p => {
                            if (!currentSettings.preProxies.find(cp => cp.id === p.id)) currentSettings.preProxies.push(p);
                        });
                    }
                    if (data.subscriptions) {
                        if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
                        data.subscriptions.forEach(s => {
                            if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) currentSettings.subscriptions.push(s);
                        });
                    }
                    await fs.writeJson(SETTINGS_FILE, currentSettings);
                    updated = true;
                }
            } else if (data.name && data.proxyStr && data.fingerprint) {
                // 单个环境导入
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const newProfile = { ...data, id: uuidv4(), isSetup: false, createdAt: Date.now() };
                profiles.push(newProfile);
                await writeProfilesAtomic(profiles);
                updated = true;
            }
            return updated;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }
    return false;
});

// 保留旧的 export-data 用于向后兼容 (deprecated)
ipcMain.handle('export-data', async (_, type) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

    // 清理 fingerprint
    const cleanedProfiles = profiles.map(p => ({
        ...p,
        fingerprint: cleanFingerprint(p.fingerprint)
    }));

    let exportObj = {};
    if (type === 'all' || type === 'profiles') exportObj.profiles = cleanedProfiles;
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
    }
    if (Object.keys(exportObj).length === 0) return false;

    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `BNC_Backup_${type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });
    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return true;
    }
    return false;
});

// ─── Cloud session sync (cookies) ──────────────────────────────────────────
// Lets a customer open the same logged-in profile (Gmail/YouTube still signed
// in) on a different machine without re-authenticating. Cookies are pushed to
// the server after a profile closes and pulled before the next launch, on
// whichever machine is used. Encryption happens server-side only — this
// client only ever sends/receives plaintext cookie JSON over TLS.
//
// Both directions are strictly best-effort: any failure (offline, not logged
// into BNC, server error) must never block using a profile. A user who never
// touches the cloud pays zero cost — bncApiCall() short-circuits to null
// when there's no saved auth token.

// Pull a newer cookie snapshot from the server (if one exists) and inject it
// into this profile's browser_data via a throwaway headless Chrome + CDP,
// before the real windowed launch. Returns the snapshot's server timestamp
// (ms) if one was applied, otherwise null.
async function pullAndApplyProfileSession(profileId, userDataDir, chromePath, localLastSyncedAt) {
    try {
        const auth = getSavedBncAuth();
        if (!auth?.accessToken) return null;

        const res = await bncApiCall('GET', `/profiles/${profileId}/session`);
        if (!res || !res.found) return null;

        const serverUpdatedAt = new Date(res.updatedAt).getTime();
        if (localLastSyncedAt && serverUpdatedAt <= localLastSyncedAt) return null; // already up to date
        if (!Array.isArray(res.cookies) || res.cookies.length === 0) return serverUpdatedAt;

        const browser = await puppeteer.launch({
            headless: 'new', executablePath: chromePath, userDataDir,
            args: [
                '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu',
                '--disable-features=LockProfileCookieDatabase',
            ],
            defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
        });
        try {
            const client = await browser.target().createCDPSession();
            let applied = 0;
            for (const cookie of res.cookies) {
                try {
                    const params = {
                        name: cookie.name, value: cookie.value,
                        domain: cookie.domain, path: cookie.path,
                        secure: cookie.secure, httpOnly: cookie.httpOnly,
                        sameSite: cookie.sameSite || 'Lax',
                    };
                    if (cookie.expires > 0) params.expires = cookie.expires;
                    await client.send('Network.setCookie', params);
                    applied++;
                } catch (_) {}
            }
            console.log(`[SessionSync] Pulled & applied ${applied}/${res.cookies.length} cookies for ${profileId} (from device ${res.deviceId || '?'})`);
        } finally {
            await browser.close();
            // Match the 1000ms buffer used elsewhere (import-full-backup) after closing a
            // headless Chrome on the same userDataDir — Chrome's SingletonLock file needs a
            // moment to clear on Windows before the real windowed Chrome spawns on it, or the
            // new process instantly exits thinking another instance already owns the profile.
            await new Promise(r => setTimeout(r, 1000));
        }
        return serverUpdatedAt;
    } catch (e) {
        console.warn(`[SessionSync] pull failed for ${profileId}:`, e.message);
        return null;
    }
}

// Push this profile's current cookies to the server. Fire-and-forget from the
// caller — runs its own throwaway headless Chrome the same way the existing
// full-backup export does.
async function pushProfileSessionToServer(profileId, userDataDir, chromePath) {
    try {
        const auth = getSavedBncAuth();
        if (!auth?.accessToken) return;

        // Give OS/AV time to fully release browser_data file locks after Chrome exits.
        // 2s instead of 500ms: SQLite WAL checkpoint on Windows + AV scan can be slow.
        await new Promise(r => setTimeout(r, 2000));

        const browser = await puppeteer.launch({
            headless: 'new', executablePath: chromePath, userDataDir,
            args: [
                '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu',
                // Chrome 127+: disable App-Bound Encryption so headless can read cookies
                // that were written by the real (windowed) Chrome on the same machine.
                '--disable-features=LockProfileCookieDatabase',
            ],
            defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
        });
        let cookies = [];
        try {
            // Must use browser-level target (not page target) so Network.getAllCookies
            // returns the full cookie store, not just cookies for the current page origin.
            const client = await browser.target().createCDPSession();
            const result = await client.send('Network.getAllCookies');
            cookies = result.cookies || [];
        } finally {
            await browser.close();
            await new Promise(r => setTimeout(r, 1000));
        }
        if (cookies.length === 0) return;

        const res = await bncApiCall('PUT', `/profiles/${profileId}/session`, { cookies, deviceId: getDeviceId() });
        if (res && res.cookieCount !== undefined) {
            console.log(`[SessionSync] Pushed ${res.cookieCount} cookies for ${profileId}`);
            try {
                const profiles = await fs.readJson(PROFILES_FILE);
                const idx = profiles.findIndex(p => p.id === profileId);
                if (idx !== -1) {
                    profiles[idx]._sessionSyncedAt = Date.now();
                    await writeProfilesAtomic(profiles);
                }
            } catch (_) {}
        }
    } catch (e) {
        console.warn(`[SessionSync] push failed for ${profileId}:`, e.message);
    }
}

// Repair a profile whose browser_data appears corrupted (repeated instant-crash on launch).
// Backs up (not deletes outright) the current browser_data — a wrong diagnosis or an
// unrelated crash streak shouldn't destroy real data — then clears the crash streak so the
// next launch gets a clean slate. If this profile ever pushed cookies to the cloud, the
// pre-launch pull in launch-profile will restore the login session automatically.
ipcMain.handle('repair-profile', async (_event, profileId) => {
    try {
        const profileDir = path.join(DATA_PATH, profileId);
        const userDataDir = path.join(profileDir, 'browser_data');

        if (fs.existsSync(userDataDir)) {
            const backupDir = path.join(profileDir, `browser_data_broken_${Date.now()}`);
            try {
                await fs.move(userDataDir, backupDir);
                console.log(`[Repair][${profileId}] Backed up browser_data → ${backupDir}`);
            } catch (moveErr) {
                console.warn(`[Repair][${profileId}] backup move failed (${moveErr.message}), removing instead`);
                await fs.remove(userDataDir).catch(() => {});
            }
        }

        // Prune old repair backups (>14 days) so disk usage doesn't creep up over time.
        try {
            const entries = await fs.readdir(profileDir);
            const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
            for (const entry of entries) {
                const m = entry.match(/^browser_data_broken_(\d+)$/);
                if (m && parseInt(m[1]) < cutoff) {
                    await fs.remove(path.join(profileDir, entry)).catch(() => {});
                }
            }
        } catch (_) {}

        const profiles = await fs.readJson(PROFILES_FILE);
        const idx = profiles.findIndex(p => p.id === profileId);
        if (idx !== -1) {
            profiles[idx]._consecutiveCrashes = 0;
            await writeProfilesAtomic(profiles);
        }

        return { success: true };
    } catch (e) {
        console.error(`[Repair][${profileId}] failed:`, e);
        return { success: false, error: e.message };
    }
});

// --- 核心启动逻辑 ---
ipcMain.handle('launch-profile', async (event, profileId, watermarkStyle) => {
    const sender = event.sender;

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        const isAlive = proc.chromeProcess && proc.chromeProcess.exitCode === null;
        if (isAlive) {
            return "环境已唤醒";
        } else {
            await forceKill(proc.xrayPid);
            if (proc.logFd !== undefined) { try { fs.closeSync(proc.logFd); } catch(e) {} }
            delete activeProcesses[profileId];
        }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Load settings early for userExtensions and remote debugging
    const settings = await fs.readJson(SETTINGS_FILE).catch(() => ({
        enableRemoteDebugging: false,
        userExtensions: [],
        preProxies: [],
        mode: 'single',
        enablePreProxy: false
    }));

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    if (!profile.fingerprint) profile.fingerprint = generateFingerprint();
    if (!profile.fingerprint.languages) profile.fingerprint.languages = ['en-US', 'en'];

    // Pre-proxy settings (settings already loaded above)
    const override = profile.preProxyOverride || 'default';
    const shouldUsePreProxy = override === 'on' || (override === 'default' && settings.enablePreProxy);
    let finalPreProxyConfig = null;
    let switchMsg = null;
    if (shouldUsePreProxy && settings.preProxies && settings.preProxies.length > 0) {
        const active = settings.preProxies.filter(p => p.enable !== false);
        if (active.length > 0) {
            if (settings.mode === 'single') { const target = active.find(p => p.id === settings.selectedId) || active[0]; finalPreProxyConfig = { preProxies: [target] }; }
            else if (settings.mode === 'balance') { const target = active[Math.floor(Math.random() * active.length)]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Balance: [${target.remark}]`; }
            else if (settings.mode === 'failover') { const target = active[0]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Failover: [${target.remark}]`; }
        }
    }

    try {
        const localPort = await getPort();
        const profileDir = path.join(DATA_PATH, profileId);
        const userDataDir = path.join(profileDir, 'browser_data');
        const xrayConfigPath = path.join(profileDir, 'config.json');
        const xrayLogPath = path.join(profileDir, 'xray_run.log');
        fs.ensureDirSync(userDataDir);

        try {
            const defaultProfileDir = path.join(userDataDir, 'Default');
            fs.ensureDirSync(defaultProfileDir);
            const preferencesPath = path.join(defaultProfileDir, 'Preferences');
            let preferences = {};
            if (fs.existsSync(preferencesPath)) preferences = await fs.readJson(preferencesPath);
            if (!preferences.bookmark_bar) preferences.bookmark_bar = {};
            preferences.bookmark_bar.show_on_all_tabs = true;
            if (preferences.protection) delete preferences.protection;
            if (!preferences.profile) preferences.profile = {};
            preferences.profile.name = profile.name;
            if (!preferences.webrtc) preferences.webrtc = {};
            preferences.webrtc.ip_handling_policy = 'disable_non_proxied_udp';
            await fs.writeJson(preferencesPath, preferences);
        } catch (e) { }

        // Direct mode: no proxy — skip Xray entirely
        // Falls back to settings.defaultProxy when profile has no proxy configured
        const effectiveProxy = profile.proxyStr?.trim() || settings.defaultProxy?.trim() || '';
        const isDirect = !effectiveProxy || effectiveProxy.toLowerCase() === 'direct';

        let xrayProcess = null;
        let logFd = null;
        if (!isDirect) {
            // Raw IP:PORT:USER:PASS format is ambiguous — commercial providers ship the
            // same syntax for both HTTP and SOCKS5. Auto-detect on first launch and cache
            // on the profile so subsequent launches skip the probe.
            let rawProtocolHint = profile.rawProxyProtocol || null;
            const isRawFormat = /^[^:\/]+:\d+(:[^:]+:[^:]+)?$/.test(effectiveProxy) && !effectiveProxy.includes('://');
            if (isRawFormat && !rawProtocolHint) {
                try {
                    const { detectRawProxyProtocol } = require('./utils');
                    const [host, port, user, pass] = effectiveProxy.split(':');
                    const detected = await detectRawProxyProtocol(host, parseInt(port), user, pass);
                    if (detected) {
                        rawProtocolHint = detected;
                        console.log(`[Proxy] Auto-detected ${detected.toUpperCase()} for ${host}:${port}`);
                        // Persist so we don't re-probe every launch.
                        try {
                            const profiles = fs.readJsonSync(PROFILES_FILE, { throws: false }) || [];
                            const idx = profiles.findIndex(x => x.id === profile.id);
                            if (idx !== -1) { profiles[idx].rawProxyProtocol = detected; fs.writeJsonSync(PROFILES_FILE, profiles); }
                        } catch (_) {}
                    } else {
                        console.warn(`[Proxy] Could not detect protocol for ${host}:${port} — falling back to SOCKS5`);
                    }
                } catch (e) {
                    console.warn('[Proxy] Detect error:', e.message);
                }
            }
            const config = generateXrayConfig(effectiveProxy, localPort, finalPreProxyConfig, rawProtocolHint);
            fs.writeJsonSync(xrayConfigPath, config);
            logFd = fs.openSync(xrayLogPath, 'a');
            xrayProcess = spawn(EFFECTIVE_BIN_PATH, ['-c', xrayConfigPath], { cwd: EFFECTIVE_BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: ['ignore', logFd, logFd], windowsHide: true });
            // 优化：减少等待时间，Xray 通常 300ms 内就能启动
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 0. Auto-detect geo signals from proxy IP (only when proxy present)
        if (!isDirect && effectiveProxy) {
            const needsTimezone = !profile.fingerprint.timezone
                || profile.fingerprint.timezone === 'Auto'
                || profile.fingerprint.timezone === 'America/Los_Angeles'; // migrate legacy default
            // Language sync: only when not explicitly set by user
            const needsLanguage = !profile.fingerprint.language || profile.fingerprint.language === 'auto';

            if (needsTimezone || needsLanguage) {
                console.log('🔍 Detecting proxy geo signals...');
                const geoData = await getProxyGeolocation(effectiveProxy).catch(() => null);
                if (geoData) {
                    if (needsTimezone && geoData.timezone) {
                        profile.fingerprint.timezone = geoData.timezone;
                        console.log(`✅ Timezone: ${geoData.timezone} (${geoData.city}, ${geoData.country})`);
                    }
                    if (needsLanguage && geoData.language && geoData.language !== 'en-US') {
                        profile.fingerprint.language = geoData.language;
                        console.log(`🌐 Language: ${geoData.language} (${geoData.country})`);
                    }
                    if (!profile.fingerprint.geolocation && geoData.latitude && geoData.longitude) {
                        profile.fingerprint.geolocation = { latitude: geoData.latitude, longitude: geoData.longitude };
                    }
                    // Always persist countryCode for flag display in UI
                    if (geoData.countryCode) {
                        profile.fingerprint.countryCode = geoData.countryCode;
                        const profiles = fs.readJsonSync(PROFILES_FILE, { throws: false }) || [];
                        const idx = profiles.findIndex(x => x.id === profile.id);
                        if (idx !== -1) { profiles[idx] = profile; fs.writeJsonSync(PROFILES_FILE, profiles); }
                    }
                } else if (needsTimezone) {
                    profile.fingerprint.timezone = 'UTC';
                    console.log('⚠️ Geo detect failed — timezone fallback: UTC');
                }
            }
        }

        // Normalize platform-specific fingerprint fields for this OS.
        // Handles profiles imported from another OS (Win→Mac or Mac→Win) where
        // platform/webgl/userAgent/mediaDevices are missing or wrong for this machine.
        normalizeFingerprintForPlatform(profile.fingerprint);

        // Fallback: ensure devicePixelRatio exists (old profiles created before this field was added)
        if (!profile.fingerprint.devicePixelRatio) {
            profile.fingerprint.devicePixelRatio = 1;
        }

        // 0b. Resolve Language — uses auto-detected value above if available
        const targetLang = profile.fingerprint?.language && profile.fingerprint.language !== 'auto'
            ? profile.fingerprint.language
            : 'en-US';

        // Update in-memory profile so generateExtension gets explicit language
        profile.fingerprint.language = targetLang;
        profile.fingerprint.languages = [targetLang, targetLang.split('-')[0]];

        // --- DEBUG: Log full fingerprint state before launch ---
        const chromePath = getChromiumPath();
        debugLog('PROFILE_LAUNCH', {
            id:   profileId,
            name: profile.name,
            proxy: effectiveProxy ? effectiveProxy.split(':').slice(0,2).join(':') + ':***' : 'none',
            chromeBinary: chromePath || 'NOT FOUND',
            usingFpChromium: isFingerprintChromium(chromePath),
            fingerprint: {
                timezone:            profile.fingerprint.timezone,
                language:            profile.fingerprint.language,
                languages:           profile.fingerprint.languages,
                platform:            profile.fingerprint.platform,
                screen:              profile.fingerprint.screen,
                devicePixelRatio:    profile.fingerprint.devicePixelRatio,
                hardwareConcurrency: profile.fingerprint.hardwareConcurrency,
                deviceMemory:        profile.fingerprint.deviceMemory,
                noiseSeed:           profile.fingerprint.noiseSeed,
                geolocation:         profile.fingerprint.geolocation,
                webgl_vendor:        profile.fingerprint.webgl?.vendor,
                webgl_renderer:      profile.fingerprint.webgl?.renderer,
                webgpu_vendor:       profile.fingerprint.webgpu?.info?.vendor,
                mediaDevices_count:  profile.fingerprint.mediaDevices?.length,
                has_webgl_params:    !!profile.fingerprint.webgl?.params,
            }
        });

        // 1. Generate BNC Guard extension (using passed watermark style)
        const style = watermarkStyle || 'enhanced'; // default: enhanced watermark
        const extPath = await generateExtension(profileDir, profile.fingerprint, profile.name, style, profileId, isFingerprintChromium(chromePath));

        // 2. Get user custom extensions
        const userExts = settings.userExtensions || [];

        // 3. Merge all extension paths
        let extPaths = extPath; // BNC Guard
        if (userExts.length > 0) {
            extPaths += ',' + userExts.join(',');
        }

        // 4. 构建启动参数（性能优化）

        // Bypass proxy for Google auth + main services so Gmail sign-in works with any
        // proxy quality. Tradeoff: Google's Recent Security Activity will record the
        // user's real IP instead of the proxy IP, because sign-in traffic goes direct.
        // For strict IP consistency (Google logs proxy IP), remove accounts.google.com
        // and *.google.com from this list — but that requires a good residential proxy.
        // Note: *.google.com only matches subdomains, not the apex 'google.com'.
        // gmail.com is a separate apex domain (redirects to mail.google.com) — needs its own entry.
        // Vietnam locale Google (google.com.vn / accounts.google.com.vn) is where Google
        // redirects the SetSID handoff when it sees a Vietnamese IP — must bypass or the
        // sign-in never completes.
        // YouTube domains are included so the browser stays usable even when the proxy
        // itself is unreachable; the tradeoff is that video playback then leaks the
        // real IP because googlevideo.com is fetched direct.
        const GOOGLE_BYPASS = [
            'google.com', '*.google.com', 'accounts.google.com',
            'google.com.vn', '*.google.com.vn',
            'gmail.com',
            'youtube.com', '*.youtube.com', '*.ytimg.com',
            'googlevideo.com', '*.googlevideo.com',
            '*.googleapis.com', '*.gstatic.com', '*.googleusercontent.com'
        ].join(';');

        const launchArgs = [
            // Direct mode: no proxy args — Chrome uses system proxy settings naturally.
            // Do NOT pass --no-proxy-server: it bypasses system-level proxies (Surge/ClashX/VPN
            // Network Extensions) and can cause traffic to route through Google tunnels (googlezip.net).
            ...(isDirect
                ? []
                : [
                    `--proxy-server=socks5://127.0.0.1:${localPort}`,
                    `--proxy-bypass-list=${GOOGLE_BYPASS}`
                  ]
            ),
            `--user-data-dir=${userDataDir}`,
            `--window-size=${profile.fingerprint?.window?.width || 1280},${profile.fingerprint?.window?.height || 800}`,
            '--restore-last-session',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',

            '--disable-features=IsolateOrigins,ExtensionsMenuAccessControl',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            `--lang=${targetLang}`,
            `--accept-lang=${targetLang}`,
            `--disable-extensions-except=${extPaths}`,
            `--load-extension=${extPaths}`,
            // 性能优化参数
            '--no-first-run',                    // 跳过首次运行向导
            '--no-default-browser-check',        // 跳过默认浏览器检查
            '--disable-infobars',                // ẩn các infobar (Chrome for Testing banner, unsupported flag warnings)
            '--disable-session-crashed-bubble',  // 隐藏恢复会话提示气泡
            '--disable-background-timer-throttling', // 防止后台标签页被限速
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-dev-shm-usage',           // 减少共享内存使用
            '--disk-cache-size=314572800',       // 300MB — realistic for real user
            '--media-cache-size=104857600',      // 100MB — enough for YouTube buffering
            // Keep only the two anti-hang flags actually required for the crashpad/GCM
            // deadlock on some Windows machines. The wider "disable everything Google-y"
            // set (metrics-recording-only, disable-sync, enable-logging, etc.) turned out to
            // read as an automation signal — Google was flagging login even with a good
            // proxy, while commercial anti-detect browsers using vanilla Chrome flags
            // sailed through the same accounts. Stay closer to what a real user's Chrome
            // sends.
            '--disable-breakpad',                 // skip crashpad init (avoids named-pipe deadlock on Windows)
            '--disable-component-update'          // no on-startup component fetch (network hang guard)
        ];

        // 4b. Custom Chromium C++ patch flags (only when using custom/fingerprint chromium)
        // These flags are recognized by our C++ patches to control anti-detect behavior
        const isCustomBuild = chromePath && (
            chromePath.startsWith(CUSTOM_CHROMIUM_DIR) ||
            chromePath.startsWith(FINGERPRINT_CHROMIUM_DIR)
        );
        if (isCustomBuild && profile.fingerprint.noiseSeed) {
            const seed = getFingerprintSeed(profile.fingerprint.noiseSeed);
            launchArgs.push(
                `--canvas-noise-seed=${seed >>> 0}`,
                `--audio-noise-seed=${(seed ^ 0xABCD1234) >>> 0}`,
                `--audio-noise-level=0.0000001`,
                `--perf-noise-seed=${(seed ^ 0xFFFF0000) >>> 0}`
            );
            if (profile.fingerprint.webgl?.vendor) {
                launchArgs.push(`--webgl-vendor=${profile.fingerprint.webgl.vendor}`);
            }
            if (profile.fingerprint.webgl?.renderer) {
                launchArgs.push(`--webgl-renderer=${profile.fingerprint.webgl.renderer}`);
            }
            console.log(`[GeekezChromium] C++ patch flags: seed=${seed}`);
        }

        // 5. Remote Debugging Port (if enabled)
        if (settings.enableRemoteDebugging && profile.debugPort) {
            launchArgs.push(`--remote-debugging-port=${profile.debugPort}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('⚠️  REMOTE DEBUGGING ENABLED');
            console.log(`📡 Port: ${profile.debugPort}`);
            console.log(`🔗 Connect: chrome://inspect or ws://localhost:${profile.debugPort}`);
            console.log('⚠️  WARNING: May increase automation detection risk!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // 6. Custom Launch Arguments (if enabled)
        if (settings.enableCustomArgs && profile.customArgs) {
            const customArgsList = profile.customArgs
                .split(/[\n\s]+/)
                .map(arg => arg.trim())
                .filter(arg => arg && arg.startsWith('--'));

            if (customArgsList.length > 0) {
                launchArgs.push(...customArgsList);
                console.log('⚡ Custom Args:', customArgsList.join(' '));
            }
        }

        // 5. 启动浏览器
        if (!chromePath) {
            await forceKill(xrayProcess.pid);
            throw new Error("Chrome binary not found.");
        }

        // Fingerprint-Chromium: platform/brand flags only — no --fingerprint canvas noise.
        // The --fingerprint flag causes Pixelscan C2/C4/C10 canvas test failures because
        // the noise applied in the main frame differs from Web Worker context (content scripts
        // don't inject into Workers), creating a cross-context hash mismatch → "Masking detected".
        // Real GPU canvas values (RTX 3060 on this machine) are legitimate Chrome fingerprints.
        if (isFingerprintChromium(chromePath)) {
            launchArgs.push('--fingerprint-platform=windows');
            launchArgs.push('--fingerprint-brand=Chrome');
            if (profile.fingerprint?.hardwareConcurrency) {
                launchArgs.push(`--fingerprint-hardware-concurrency=${profile.fingerprint.hardwareConcurrency}`);
            }
            console.log(`[FP-Chromium] platform=windows, brand=Chrome (no canvas noise)`);
        }

        // Timezone setup:
        // - env.TZ works on macOS/Linux (POSIX) but Windows ignores TZ env var entirely
        // - --timezone= flag (valid Chrome 92+) works on all platforms including Windows
        // → always push --timezone= so Windows CfT gets correct timezone
        const env = { ...process.env };
        if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
            launchArgs.push(`--timezone=${profile.fingerprint.timezone}`);
            env.TZ = profile.fingerprint.timezone; // fallback for macOS/Linux; no-op on Windows
        }

        // Add User-Agent from profile.
        // FP-Chromium: always use Windows UA because --fingerprint-platform=windows
        //   patches Sec-CH-UA-Platform at C++ level — profile UA may be macOS if generated on Mac.
        // CfT / stock Chrome: use profile UA (platform-matched on creation) or fall back
        //   to a UA that matches the actual host OS, so Sec-CH-UA-Platform is consistent.
        let spawnUA;
        if (isFingerprintChromium(chromePath)) {
            spawnUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`;
        } else {
            spawnUA = profile.fingerprint?.userAgent || (
                process.platform === 'darwin'
                    ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`
                    : process.platform === 'win32'
                        ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`
                        : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`
            );
        }
        launchArgs.push(`--user-agent=${spawnUA}`);

        // Pre-flight: verify chrome binary actually exists & is reachable. spawn() on Windows
        // returns successfully even for paths it can't execute (it surfaces the failure
        // asynchronously as an 'error' event), so checking here gives a clearer error upfront.
        if (!fs.existsSync(chromePath)) {
            if (xrayProcess) await forceKill(xrayProcess.pid);
            throw new Error(`Chrome binary not found: ${chromePath}`);
        }

        // Capture stderr via 'pipe' (not a file descriptor) so output reaches us even
        // when Chrome dies mid-startup. On Windows, passing an fd to spawn() can drop
        // bytes for GUI-subsystem children like Chrome — using a pipe + JS event handler
        // is reliable everywhere.
        // Pull a newer cloud session (cookies) before launching, if the server has one —
        // carries login state over from another device. Best-effort: never blocks launch
        // on failure, and costs nothing for customers not logged into BNC cloud sync.
        try {
            const newSyncedAt = await pullAndApplyProfileSession(profileId, userDataDir, chromePath, profile._sessionSyncedAt);
            if (newSyncedAt) {
                const profiles = await fs.readJson(PROFILES_FILE);
                const idx = profiles.findIndex(p => p.id === profileId);
                if (idx !== -1) { profiles[idx]._sessionSyncedAt = newSyncedAt; await writeProfilesAtomic(profiles); }
            }
        } catch (e) {
            console.warn(`[SessionSync] pre-launch pull error for ${profileId}:`, e.message);
        }

        // Note: createWriteStream surfaces ENOENT asynchronously via 'error', not via the
        // sync constructor, so wrap in ensureDir + error listener to avoid crashing the
        // launch flow if the directory is briefly missing or the disk is read-only.
        const chromeLogPath = path.join(userDataDir, 'chrome-launch.log');
        let chromeLogStream = null;
        try {
            fs.ensureDirSync(userDataDir);
            chromeLogStream = fs.createWriteStream(chromeLogPath, { flags: 'w' });
            chromeLogStream.on('error', (e) => {
                console.warn(`[Launch][${profileId}] chrome-launch.log write error:`, e.code, e.message);
                try { chromeLogStream.destroy(); } catch (_) {}
                chromeLogStream = null;
            });
        } catch (e) {
            console.warn(`[Launch][${profileId}] could not open chrome-launch.log:`, e.code, e.message);
            chromeLogStream = null;
        }

        const chromeProcess = spawn(chromePath, launchArgs, {
            env: env,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Forward chrome stdout/stderr to log file + Node console (truncated) for live debug.
        const writeLog = (chunk) => {
            try { if (chromeLogStream) chromeLogStream.write(chunk); } catch (_) {}
        };
        if (chromeProcess.stdout) chromeProcess.stdout.on('data', writeLog);
        if (chromeProcess.stderr) chromeProcess.stderr.on('data', writeLog);

        // Capture async spawn errors (ENOENT, EACCES, anti-virus blocking the executable, etc.)
        chromeProcess.on('error', (spawnErr) => {
            console.error(`[Launch][${profileId}] spawn error:`, spawnErr.code, spawnErr.message);
            if (!sender.isDestroyed()) {
                sender.send('profile-status', { id: profileId, status: 'stopped', error: `Spawn failed: ${spawnErr.code || ''} ${spawnErr.message}` });
            }
        });

        if (!chromeProcess.pid) {
            if (xrayProcess) await forceKill(xrayProcess.pid);
            if (chromeLogStream) { try { chromeLogStream.end(); } catch (_) {} }
            throw new Error('Failed to spawn Chrome process.');
        }

        activeProcesses[profileId] = {
            xrayPid: xrayProcess ? xrayProcess.pid : null,
            xrayLocalPort: isDirect ? null : localPort,
            chromeProcess,
            logFd: logFd,
            startedAt: Date.now()
        };
        sender.send('profile-status', { id: profileId, status: 'running' });
        console.log(`[Launch] Chrome PID=${chromeProcess.pid}, mode=${profile.chromeBinaryMode || 'auto'}, binary=${path.basename(chromePath)}`);

        // Windows: set unique AppUserModelID per profile window so each profile gets its own
        // taskbar button instead of all Chrome windows being grouped together.
        // Try at 3s (normal machines) and again at 8s (slower machines / cold start).
        if (process.platform === 'win32' && chromeProcess.pid) {
            const aumid = `GKZ.${profileId.replace(/-/g, '').slice(0, 16)}`;
            setTimeout(() => applyWindowAUMID(chromeProcess.pid, aumid), 3000);
            setTimeout(() => applyWindowAUMID(chromeProcess.pid, aumid), 8000);
        }

        chromeProcess.on('exit', async (code, signal) => {
            const uptimeMs = Date.now() - (activeProcesses[profileId]?.startedAt || Date.now());
            console.log(`[Launch][${profileId}] Chrome exited code=${code} signal=${signal} uptime=${uptimeMs}ms log=${chromeLogPath}`);
            const isCrash = uptimeMs < 5000;
            // < 5 s uptime is virtually always an instant crash on Windows. Flag it so the UI
            // can surface a "Chrome failed to start" message instead of a silent "stopped".
            if (isCrash && !sender.isDestroyed()) {
                sender.send('profile-status', { id: profileId, status: 'stopped', error: `Chrome crashed on launch (code=${code}). Check log: ${chromeLogPath}` });
            }

            // Auto-submit a crash report so support can diagnose "Chrome won't open" without
            // asking the customer to dig through file paths. Fire-and-forget, reads whatever
            // chrome-launch.log captured before this process died.
            if (isCrash) {
                const reportAfterLog = () => {
                    let logExcerpt = '';
                    try { logExcerpt = fs.readFileSync(chromeLogPath, 'utf8'); } catch (_) {}
                    bncApiCall('POST', '/crash-report', {
                        profileId, deviceId: getDeviceId(), deviceName: os.hostname(),
                        appVersion: app.getVersion(), platform: process.platform, osRelease: os.release(),
                        chromeBinary: path.basename(chromePath), exitCode: code, exitSignal: signal,
                        uptimeMs, logExcerpt,
                    }).catch(() => {});
                };
                if (chromeLogStream) { chromeLogStream.end(reportAfterLog); } else { reportAfterLog(); }

                // Track consecutive instant-crashes. A repeated pattern (>=2 in a row) usually
                // means corrupted browser_data (bad cache/profile files from an abrupt previous
                // shutdown), not a one-off fluke — confirmed by manually reproducing this on a
                // customer machine: deleting browser_data and relaunching fixed it immediately.
                // Offer a one-click repair instead of making support walk through it by hand
                // every time.
                try {
                    const profiles = await fs.readJson(PROFILES_FILE);
                    const idx = profiles.findIndex(p => p.id === profileId);
                    if (idx !== -1) {
                        const streak = (profiles[idx]._consecutiveCrashes || 0) + 1;
                        profiles[idx]._consecutiveCrashes = streak;
                        await writeProfilesAtomic(profiles);
                        if (streak >= 2 && !sender.isDestroyed()) {
                            sender.send('profile-repair-suggested', { id: profileId, name: profile.name, streak });
                        }
                    }
                } catch (_) {}
            } else {
                if (chromeLogStream) { try { chromeLogStream.end(); } catch(_) {} }
                // Real session (not an instant crash) — push cookies to cloud so this
                // profile can be reopened logged-in on another machine. Fire-and-forget,
                // runs its own throwaway headless Chrome; never blocks the UI.
                pushProfileSessionToServer(profileId, userDataDir, chromePath).catch(() => {});
                // A normal launch means browser_data is fine — clear any crash streak.
                try {
                    const profiles = await fs.readJson(PROFILES_FILE);
                    const idx = profiles.findIndex(p => p.id === profileId);
                    if (idx !== -1 && profiles[idx]._consecutiveCrashes) {
                        profiles[idx]._consecutiveCrashes = 0;
                        await writeProfilesAtomic(profiles);
                    }
                } catch (_) {}
            }

            if (activeProcesses[profileId]) {
                const { xrayPid, logFd: fd } = activeProcesses[profileId];
                if (fd !== undefined) { try { fs.closeSync(fd); } catch(e) {} }
                delete activeProcesses[profileId];
                await forceKill(xrayPid);
                try {
                    // Only clear Cache when it exceeds 300MB — preserve Service Workers and normal cache
                    // Real browsers evict cache automatically, not wipe it entirely on exit
                    const cacheDir = path.join(userDataDir, 'Default', 'Cache');
                    if (fs.existsSync(cacheDir)) {
                        const { size: cacheSize } = await fs.stat(cacheDir).catch(() => ({ size: 0 }));
                        const CACHE_LIMIT = 300 * 1024 * 1024; // 300MB
                        if (cacheSize > CACHE_LIMIT) {
                            await fs.emptyDir(cacheDir);
                            console.log(`[Cache] Cleared ${Math.round(cacheSize/1024/1024)}MB cache (exceeded 300MB limit)`);
                        }
                    }
                    // Never clear Code Cache — V8 compiled bytecode, speeds up reload, not a fingerprint risk
                } catch (e) {}
                if (!sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'stopped' });
            }
        });

        return switchMsg;
    } catch (err) {
        console.error(err);
        throw err;
    }
});

app.on('window-all-closed', () => {
    // Do NOT quit — window is hidden to tray. Only quit via tray menu or app.isQuiting flag.
    // Logged so an unexpected total-window-loss (renderer crash, OOM) is distinguishable from
    // an intentional tray-hide when diagnosing "app tự tắt" reports.
    debugLog('APP_LIFECYCLE', { level: 'info', msg: 'window-all-closed', isQuiting: !!app.isQuiting, uptimeMs: Math.round(process.uptime() * 1000) });
});

app.on('before-quit', () => {
    debugLog('APP_LIFECYCLE', { level: 'info', msg: 'before-quit', wasAlreadyQuiting: !!app.isQuiting, uptimeMs: Math.round(process.uptime() * 1000) });
    app.isQuiting = true;
    Object.values(activeProcesses).forEach(p => {
        forceKill(p.xrayPid);
        if (p.chromeProcess) forceKill(p.chromeProcess.pid);
    });
});
// Helpers (Same)
function fetchJson(url) { return new Promise((resolve, reject) => { const req = https.get(url, { headers: { 'User-Agent': 'BNC-Browser' } }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }); req.on('error', reject); }); }
function getLocalXrayVersion() { return new Promise((resolve) => { if (!fs.existsSync(BIN_PATH)) return resolve('v0.0.0'); try { const proc = spawn(BIN_PATH, ['-version']); let output = ''; proc.stdout.on('data', d => output += d.toString()); proc.on('close', () => { const match = output.match(/Xray\s+v?(\d+\.\d+\.\d+)/i); resolve(match ? (match[1].startsWith('v') ? match[1] : 'v' + match[1]) : 'v0.0.0'); }); proc.on('error', () => resolve('v0.0.0')); } catch (e) { resolve('v0.0.0'); } }); }
function downloadFile(url, dest) { return new Promise((resolve, reject) => { const file = fs.createWriteStream(dest); https.get(url, (response) => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { downloadFile(response.headers.location, dest).then(resolve).catch(reject); return; } response.pipe(file); file.on('finish', () => file.close(resolve)); }).on('error', (err) => { fs.unlink(dest, () => { }); reject(err); }); }); }
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
            // Windows: 使用 adm-zip（可靠）
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(destDir, true);
                console.log('[Extract Success] Extracted to:', destDir);
                resolve();
            } catch (err) {
                console.error('[Extract Error]', err);
                reject(err);
            }
        } else {
            // macOS/Linux: 使用原生 unzip 命令
            exec(`unzip -o "${zipPath}" -d "${destDir}"`, (err, stdout, stderr) => {
                if (err) {
                    console.error('[Extract Error]', err);
                    console.error('[Extract stderr]', stderr);
                    reject(err);
                } else {
                    console.log('[Extract Success]', stdout);
                    resolve();
                }
            });
        }
    });
}
