const { app, BrowserWindow, ipcMain, dialog, screen, shell, Tray, Menu, nativeImage } = require('electron');
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


// Hardware acceleration enabled for better UI performance
// Only disable if GPU compatibility issues occur

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

// ─── License & Device Tracking ───────────────────────────────────────────────
const TOOLPHUC_API = 'https://tool.erp-x.com/api/geekez';
const LICENSE_FILE          = path.join(app.getPath('userData'), 'license.json');
const ACCESS_CACHE          = path.join(app.getPath('userData'), '.access_cache.json');
const DATA_PATH_CONFIRMED   = path.join(app.getPath('userData'), '.data_path_confirmed');
const SKIPPED_UPDATE_FILE   = path.join(app.getPath('userData'), '.skipped_update_version');
const GRACE_HOURS           = 48; // Offline grace period: cho dùng tiếp 48h nếu mất mạng

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

// Gọi heartbeat và trả về response (có thể null nếu lỗi mạng)
async function sendHeartbeat() {
    try {
        const deviceId = getDeviceId();
        const body = JSON.stringify({
            deviceId,
            deviceName: os.hostname(),
            platform: `${process.platform}-${process.arch}`,
            appVersion: app.getVersion(),
        });
        const result = await new Promise((resolve) => {
            const url = new URL(TOOLPHUC_API + '/heartbeat');
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
            });
            req.on('error', (err) => { debugLog('HEARTBEAT_ERROR', { error: err.message }); resolve(null); });
            req.setTimeout(8000, () => { req.destroy(); debugLog('HEARTBEAT_TIMEOUT', {}); resolve(null); });
            req.write(body);
            req.end();
        });
        debugLog('HEARTBEAT', { sent: JSON.parse(body), response: result });
        return result;
    } catch (err) {
        debugLog('HEARTBEAT_ERROR', { error: err.message });
        return null;
    }
}

// Lưu kết quả heartbeat vào cache local
function saveAccessCache(result) {
    try { fs.writeJsonSync(ACCESS_CACHE, { ...result, cachedAt: new Date().toISOString() }); } catch (_) {}
}

// Đọc cache và kiểm tra còn trong grace period không
function readAccessCache() {
    try {
        if (!fs.existsSync(ACCESS_CACHE)) return null;
        const cache = fs.readJsonSync(ACCESS_CACHE);
        const hours = (Date.now() - new Date(cache.cachedAt).getTime()) / 3600000;
        if (hours > GRACE_HOURS) return null; // Cache quá hạn
        return cache;
    } catch (_) { return null; }
}

// Kiểm tra quyền truy cập khi khởi động
// Trả về { allowed, reason, message } — luôn có kết quả (offline thì dùng cache)
async function checkAccess() {
    // Log trạng thái file local trước khi gọi server
    const localLicense = getSavedLicense();
    const cacheExists = fs.existsSync(ACCESS_CACHE);
    debugLog('LICENSE_STARTUP', {
        licenseFileExists: fs.existsSync(LICENSE_FILE),
        licenseKey: localLicense ? localLicense.licenseKey : null,
        licenseType: localLicense ? localLicense.tokenType : null,
        cacheFileExists: cacheExists,
        cacheContent: cacheExists ? (() => { try { return fs.readJsonSync(ACCESS_CACHE); } catch(_) { return null; } })() : null,
    });

    const result = await sendHeartbeat();

    if (result) {
        // Validate response — server có thể trả lỗi dạng {message: "..."} không có "allowed"
        // Trường hợp này coi như server lỗi, fallback về cache thay vì block user
        if (typeof result.allowed !== 'boolean') {
            debugLog('ACCESS_CHECK', { mode: 'server_error', serverMessage: result.message || result.error || 'unknown', action: 'fallback to cache' });
        } else {
            saveAccessCache(result);
            // Nếu server báo license bị thu hồi → xóa license.json local để UI cập nhật đúng
            if (result.licenseRevoked) {
                try { fs.removeSync(LICENSE_FILE); } catch (_) {}
                debugLog('LICENSE_REVOKED', { reason: result.reason });
            }
            debugLog('ACCESS_CHECK', {
                mode: 'online',
                allowed: result.allowed,
                reason: result.reason,
                requireLicense: result.requireLicense,
                licenseStatus: result.licenseStatus,
                willShowDialog: !result.allowed,
            });
            return result;
        }
    }

    // Mất mạng — dùng cache
    const cache = readAccessCache();
    if (cache) {
        const hoursLeft = Math.round(GRACE_HOURS - (Date.now() - new Date(cache.cachedAt).getTime()) / 3600000);
        debugLog('ACCESS_CHECK', { mode: 'offline_cache', hoursLeft, cachedAt: cache.cachedAt, allowed: cache.allowed !== false });
        return {
            ...cache,
            allowed: cache.allowed !== false,
            offlineMode: true,
            hoursLeft,
        };
    }

    // Không có cache → lần đầu dùng offline, cho qua
    debugLog('ACCESS_CHECK', { mode: 'offline_no_cache', allowed: true });
    return { allowed: true, offlineMode: true, hoursLeft: GRACE_HOURS };
}

// Đọc license đã lưu (nếu có)
function getSavedLicense() {
    try {
        if (fs.existsSync(LICENSE_FILE)) return fs.readJsonSync(LICENSE_FILE);
    } catch (_) {}
    return null;
}

// ─── License Blocked Dialog (custom window với ô nhập key) ───────────────────
// Trả về true nếu user kích hoạt thành công, false nếu đóng app
function showLicenseBlockedDialog(access) {
    return new Promise((resolve) => {
        const win = new BrowserWindow({
            width: 420,
            height: 340,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            center: true,
            title: 'BNC — Truy cập bị từ chối',
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        const msg = access.message || 'Thiết bị của bạn chưa được kích hoạt.';
        const deviceId = getDeviceId();

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  body { background:#1a1a2e; color:#e0e0e0; padding:24px; display:flex; flex-direction:column; gap:14px; height:100vh; }
  .title { color:#ff4444; font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .msg { font-size:13px; color:#bbb; line-height:1.5; }
  .device { font-size:10px; color:#666; font-family:monospace; background:#111; padding:5px 8px; border-radius:4px; word-break:break-all; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #444; background:#111; color:#e0e0e0; font-size:13px; font-family:monospace; letter-spacing:1px; outline:none; }
  input:focus { border-color:#4a9eff; }
  .row { display:flex; gap:10px; }
  .btn { flex:1; padding:10px; border-radius:8px; border:none; cursor:pointer; font-size:13px; font-weight:600; }
  .btn-activate { background:#4a9eff; color:#fff; }
  .btn-activate:disabled { background:#2a4a6e; color:#666; cursor:default; }
  .btn-close { background:#333; color:#aaa; }
  .err { font-size:12px; color:#ff6666; min-height:16px; }
  .ok  { font-size:12px; color:#4CAF50; min-height:16px; }
</style></head><body>
  <div class="title">&#9888; BNC — Truy cập bị từ chối</div>
  <div class="msg">${msg.replace(/</g,'&lt;')}</div>
  <div class="device">Device ID: ${deviceId}</div>
  <input id="k" type="text" placeholder="Nhập license key (XXXX-XXXX-XXXX-XXXX)" autofocus>
  <div id="status" class="err"></div>
  <div class="row">
    <button class="btn btn-close" onclick="window.close()">Đóng</button>
    <button class="btn btn-activate" id="ab" onclick="activate()">Kích hoạt</button>
  </div>
<script>
  document.getElementById('k').addEventListener('keydown', e => { if(e.key==='Enter') activate(); });
  async function activate() {
    const key = document.getElementById('k').value.trim();
    if (!key) { setStatus('Vui lòng nhập license key', false); return; }
    const ab = document.getElementById('ab');
    ab.disabled = true; ab.textContent = 'Đang kích hoạt...';
    setStatus('');
    try {
      const r = await fetch('http://localhost:__INTERNAL_PORT__/api/activate-license', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ licenseKey: key })
      });
      const data = await r.json();
      if (data.success) {
        setStatus('✅ Kích hoạt thành công! Đang khởi động...', true);
        setTimeout(() => window.location.href = 'activate://ok', 1000);
      } else {
        setStatus('❌ ' + (data.message || 'Kích hoạt thất bại'), false);
        ab.disabled = false; ab.textContent = 'Kích hoạt';
      }
    } catch(e) {
      setStatus('❌ Không kết nối được server', false);
      ab.disabled = false; ab.textContent = 'Kích hoạt';
    }
  }
  function setStatus(t, ok) {
    const el = document.getElementById('status');
    el.textContent = t;
    el.className = ok ? 'ok' : 'err';
  }
</script></body></html>`.replace('__INTERNAL_PORT__', INTERNAL_API_PORT);

        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

        let resolved = false;

        // Xử lý navigate đến activate://ok — kích hoạt thành công
        win.webContents.on('will-navigate', (e, url) => {
            if (url.startsWith('activate://ok')) {
                e.preventDefault();
                resolved = true;
                win.close();
                resolve(true);
            }
        });

        // User đóng cửa sổ → thoát app
        win.on('closed', () => {
            if (!resolved) resolve(false);
        });

        win.once('ready-to-show', () => win.show());
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Server Announcement (thông báo / cập nhật từ server) ────────────────────
// Cache announcement nhận được từ server
let cachedAnnouncement = null;
let updateShownThisSession = false;

// Kiểm tra version và hiện dialog nếu có bản mới — chỉ hiện 1 lần/session
async function checkAndNotifyUpdate(heartbeatResult) {
    debugLog('UPDATE_CHECK', { updateShownThisSession, hasResult: !!heartbeatResult, latestVersion: heartbeatResult?.latestVersion });

    if (updateShownThisSession) { debugLog('UPDATE_CHECK', 'skip — already shown this session'); return; }
    if (!heartbeatResult || !heartbeatResult.latestVersion) { debugLog('UPDATE_CHECK', 'skip — no latestVersion in heartbeat response'); return; }

    const current = app.getVersion();
    const latest = heartbeatResult.latestVersion;
    const isOutdated = latest.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0;
    debugLog('UPDATE_CHECK', { current, latest, isOutdated });
    if (!isOutdated) { debugLog('UPDATE_CHECK', 'skip — already on latest'); return; }

    const forceUpdate = heartbeatResult.forceUpdate === true;

    // Kiểm tra version đã bị skip chưa (chỉ áp dụng khi không force)
    if (!forceUpdate) {
        try {
            const skipped = fs.existsSync(SKIPPED_UPDATE_FILE)
                ? fs.readFileSync(SKIPPED_UPDATE_FILE, 'utf8').trim()
                : null;
            debugLog('UPDATE_CHECK', { skippedVersion: skipped });
            if (skipped === latest) { debugLog('UPDATE_CHECK', `skip — user previously skipped v${latest}`); return; }
        } catch (_) {}
    }

    debugLog('UPDATE_CHECK', { action: 'showing dialog', forceUpdate });
    updateShownThisSession = true;
    const downloadUrl = heartbeatResult.downloadUrl || 'https://tool.erp-x.com';
    const notes = heartbeatResult.releaseNotes ? `\n\n${heartbeatResult.releaseNotes}` : '';

    const buttons = forceUpdate ? ['Tải ngay'] : ['Tải ngay', 'Bỏ qua phiên bản này'];
    const { response } = await dialog.showMessageBox({
        type: 'info',
        title: `Có phiên bản mới — v${latest}`,
        message: `BNC Browser ${latest} đã sẵn sàng`,
        detail: `Bạn đang dùng v${current}. Tải phiên bản mới để có trải nghiệm tốt hơn.${notes}`,
        buttons,
        defaultId: 0,
        cancelId: forceUpdate ? 0 : 1,
        noLink: true,
    });

    debugLog('UPDATE_CHECK', { userResponse: response, buttonLabel: buttons[response] });

    if (response === 0) {
        debugLog('UPDATE_CHECK', { action: 'opening download URL', downloadUrl });
        shell.openExternal(downloadUrl);
        if (forceUpdate) {
            debugLog('UPDATE_CHECK', 'forceUpdate — quitting in 1.5s');
            setTimeout(() => app.quit(), 1500);
        }
    }

    // Bỏ qua version này → lưu vào file, không nhắc lại lần sau
    if (!forceUpdate && response === 1) {
        try {
            fs.writeFileSync(SKIPPED_UPDATE_FILE, latest, 'utf8');
            debugLog('UPDATE_CHECK', { action: 'saved skipped version', version: latest });
        } catch (_) {}
        setTimeout(() => { updateShownThisSession = false; }, 60 * 60 * 1000);
    }
}

// Gọi /api/geekez/announcement để lấy thông báo mới nhất từ server
// Server trả về: { show: bool, version?: string, url?: string, notes?: string, skipable?: bool }
async function fetchAnnouncement() {
    try {
        const deviceId = getDeviceId();
        const params = new URLSearchParams({ deviceId, appVersion: app.getVersion() });
        return await new Promise((resolve) => {
            const url = new URL(TOOLPHUC_API + '/announcement?' + params.toString());
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(6000, () => { req.destroy(); resolve(null); });
            req.end();
        });
        debugLog('ANNOUNCEMENT', { response: result });
        return result;
    } catch (err) {
        debugLog('ANNOUNCEMENT_ERROR', { error: err.message });
        return null;
    }
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
            let body = await new Promise(resolve => {
                let data = ''; req.on('data', chunk => data += chunk); req.on('end', () => resolve(data));
            });
            try {
                const { licenseKey } = JSON.parse(body);
                if (!licenseKey) { res.writeHead(400); return res.end(JSON.stringify({ success: false, message: 'Thiếu license key' })); }
                // Tái dùng IPC handler logic
                const deviceId = getDeviceId();
                const reqBody = JSON.stringify({ deviceId, licenseKey });
                const result = await new Promise((resolve, reject) => {
                    const activateUrl = new URL(TOOLPHUC_API + '/activate');
                    const areq = https.request({
                        hostname: activateUrl.hostname,
                        path: activateUrl.pathname,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
                    }, (ares) => {
                        let d = '';
                        ares.on('data', c => d += c);
                        ares.on('end', () => { try { resolve({ statusCode: ares.statusCode, body: JSON.parse(d) }); } catch (_) { resolve({ statusCode: ares.statusCode, body: {} }); } });
                    });
                    areq.on('error', reject);
                    areq.setTimeout(8000, () => { areq.destroy(); reject(new Error('Timeout')); });
                    areq.write(reqBody);
                    areq.end();
                });
                if (result.statusCode === 200 && result.body.allowed) {
                    const licenseData = { licenseKey, ...result.body.data, activatedAt: new Date().toISOString() };
                    await fs.writeJson(LICENSE_FILE, licenseData);
                    // Cập nhật cache access → allowed
                    saveAccessCache({ allowed: true, reason: null });
                    res.writeHead(200); return res.end(JSON.stringify({ success: true, message: result.body.message }));
                }
                res.writeHead(200); return res.end(JSON.stringify({ success: false, message: result.body.message || 'Kích hoạt thất bại' }));
            } catch (err) {
                res.writeHead(500); return res.end(JSON.stringify({ success: false, message: 'Lỗi server: ' + err.message }));
            }
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
        await fs.writeJson(PROFILES_FILE, profiles);
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
        await fs.writeJson(PROFILES_FILE, profiles);
        return { success: true, profile: profiles[idx] };
    }

    // DELETE /api/profiles/:idOrName
    if (method === 'DELETE' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        profiles = profiles.filter(p => p.id !== profile.id);
        await fs.writeJson(PROFILES_FILE, profiles);
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
        try { await proc.browser.close(); } catch (e) { }
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
                    args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu'],
                    defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
                });
                const page = (await browser.pages())[0] || await browser.newPage();
                const client = await page.createCDPSession();
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
            filename: `GeekEZ_FullBackup_${Date.now()}.geekez`,
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
            filename: `GeekEZ_Profiles_${Date.now()}.yaml`,
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
                        const newProfile = {
                            id: uuidv4(),
                            name,
                            proxyStr: item.proxyStr || '',
                            tags: item.tags || [],
                            fingerprint: item.fingerprint || await generateFingerprint({}),
                            createdAt: Date.now()
                        };
                        profiles.push(newProfile);
                        imported++;
                    }
                    await fs.writeJson(PROFILES_FILE, profiles);
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
                    const newProfile = { ...profile, id: uuidv4(), name };
                    profiles.push(newProfile);
                    imported++;
                }
                await fs.writeJson(PROFILES_FILE, profiles);
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
ipcMain.handle('start-api-server', async (e, { port }) => {
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

let tray = null;

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
    mainWindow = win;

    // Minimize to tray instead of closing
    win.on('close', (e) => {
        if (!app.isQuiting) {
            e.preventDefault();
            win.hide();
        }
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
        name: "GeekEZ Guard",
        version: "1.1.0",
        description: "Privacy & Password Protection",
        permissions: ["storage", "activeTab"],
        host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
        background: { service_worker: "background.js" },
        content_scripts: [
            { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, world: "MAIN" },
            { matches: ["<all_urls>"], js: ["content_pw.js"], run_at: "document_idle", all_frames: false, world: "ISOLATED" }
        ],
        action: { default_popup: "popup.html" }
    };
    const style = watermarkStyle || 'enhanced';
    // fingerprint.js: canvas/audio/WebGL/clientrects/permissions/mediaDevices all "mode real"
    // (no JS hooks) to avoid Worker comparison mismatch. makeNative + screen + plugins + chrome
    // are safe since Workers don't have navigator.plugins or window.screen.
    const scriptContent = getInjectScript(fingerprint, profileName, style);
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

    // Kiểm tra quyền truy cập + gửi heartbeat (song song với fetch announcement)
    const [access, announcement] = await Promise.all([checkAccess(), fetchAnnouncement()]);
    if (announcement) cachedAnnouncement = announcement;
    const sendAskDataPath = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.webContents.isLoading()) {
            mainWindow.webContents.once('did-finish-load', () => {
                mainWindow.webContents.send('license-activated-ask-data-path');
            });
        } else {
            mainWindow.webContents.send('license-activated-ask-data-path');
        }
    };

    let justActivated = false;
    debugLog('STARTUP_ACCESS', { allowed: access.allowed, requireLicense: access.requireLicense, licenseFileExists: fs.existsSync(LICENSE_FILE), offlineMode: access.offlineMode || false });

    if (!access.allowed) {
        debugLog('STARTUP_FLOW', 'blocked → showing license dialog');
        const activated = await showLicenseBlockedDialog(access);
        if (!activated) { app.quit(); return; }
        debugLog('STARTUP_FLOW', 'license activated via dialog');
        justActivated = true;
    } else if (access.requireLicense && !fs.existsSync(LICENSE_FILE) && !access.trialMode) {
        debugLog('STARTUP_FLOW', 'allowed but no local license file → showing license dialog');
        const activated = await showLicenseBlockedDialog({
            ...access,
            message: 'Vui lòng nhập license key để tiếp tục sử dụng.',
            reason: 'no_local_license'
        });
        if (!activated) { app.quit(); return; }
        debugLog('STARTUP_FLOW', 'license re-entered successfully');
        justActivated = true;
    } else {
        debugLog('STARTUP_FLOW', 'license OK, skipping dialog');
    }

    // Hỏi chọn thư mục lưu dữ liệu nếu: vừa kích hoạt LẦN ĐẦU, hoặc chưa từng xác nhận
    const dataPathAlreadyConfirmed = fs.existsSync(DATA_PATH_CONFIRMED);
    debugLog('STARTUP_DATA_PATH', { justActivated, dataPathAlreadyConfirmed, DATA_PATH_CONFIRMED });
    if (justActivated || (access.requireLicense && !dataPathAlreadyConfirmed)) {
        debugLog('STARTUP_FLOW', 'sending ask-data-path event to renderer');
        sendAskDataPath();
    } else {
        debugLog('STARTUP_FLOW', 'data path already confirmed, skipping');
    }

    // Thông báo dùng thử miễn phí nếu chưa có license
    if (access.trialMode && access.trialHoursLeft) {
        const hoursLeft = Math.ceil(access.trialHoursLeft); // làm tròn lên cho đẹp
        debugLog('TRIAL_MODE', { hoursLeft, trialHoursLeft: access.trialHoursLeft });
        const showTrialNotice = () => {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Đang dùng thử miễn phí',
                message: `Còn ${hoursLeft} giờ dùng thử miễn phí`,
                detail: 'Sau khi hết thời gian dùng thử, bạn cần license key để tiếp tục sử dụng.\nLiên hệ đội hỗ trợ để được cấp key.',
                buttons: ['OK'],
            }).catch(() => {});
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.webContents.isLoading()) {
                mainWindow.webContents.once('did-finish-load', () => setTimeout(showTrialNotice, 1500));
            } else {
                setTimeout(showTrialNotice, 1500);
            }
        }
    }

    // Kiểm tra version ngay khi khởi động
    await checkAndNotifyUpdate(access);

    // Heartbeat định kỳ mỗi 5 phút (cập nhật trạng thái online + check version)
    setInterval(async () => {
        const r = await sendHeartbeat();
        if (r) saveAccessCache(r);
        // Nếu bị chặn trong lúc đang dùng → thông báo và thoát
        if (r && !r.allowed) {
            dialog.showMessageBox({
                type: 'warning',
                title: 'BNC — Phiên bị thu hồi',
                message: r.message || 'Quyền truy cập của bạn đã bị thu hồi.',
                buttons: ['Đóng'],
            }).then(() => app.quit());
            return;
        }
        // Check update định kỳ (hàm tự guard không spam)
        if (r) checkAndNotifyUpdate(r);
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
        const xrayProcess = spawn(BIN_PATH, ['-c', tempConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: 'ignore', windowsHide: true });
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

// Lấy trạng thái license + deviceId hiện tại
ipcMain.handle('license-get-status', async () => {
    let saved = getSavedLicense();
    // Fallback: đọc licenseKey từ ACCESS_CACHE nếu LICENSE_FILE bị xoá
    if (!saved && fs.existsSync(ACCESS_CACHE)) {
        try {
            const cache = fs.readJsonSync(ACCESS_CACHE);
            if (cache.licenseKey) {
                saved = { licenseKey: cache.licenseKey, tokenType: cache.tokenType, fromCache: true };
            }
        } catch (_) {}
    }
    return { deviceId: getDeviceId(), license: saved || null };
});

// Kích hoạt license key
ipcMain.handle('license-activate', async (_, licenseKey) => {
    if (!licenseKey) return { success: false, message: 'Vui lòng nhập license key' };
    const deviceId = getDeviceId();
    const body = JSON.stringify({ deviceId, licenseKey });
    try {
        const result = await new Promise((resolve, reject) => {
            const url = new URL(TOOLPHUC_API + '/activate');
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
                    catch (_) { resolve({ statusCode: res.statusCode, body: {} }); }
                });
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body);
            req.end();
        });

        if (result.statusCode === 200 && result.body.allowed) {
            const licenseData = { licenseKey, ...result.body.data, activatedAt: new Date().toISOString() };
            await fs.writeJson(LICENSE_FILE, licenseData);
            // Lưu licenseKey vào ACCESS_CACHE để dùng khi LICENSE_FILE bị xoá
            saveAccessCache({ ...result.body, licenseKey });
            return { success: true, message: result.body.message, data: licenseData };
        }
        return { success: false, message: result.body.message || 'Kích hoạt thất bại' };
    } catch (err) {
        return { success: false, message: 'Không thể kết nối server: ' + err.message };
    }
});
// Huỷ kích hoạt — gọi server + xoá local file
// licenseKey truyền từ UI (không đọc file — file có thể đã bị xoá)
ipcMain.handle('license-deactivate', async (_, licenseKeyFromUI) => {
    try {
        const deviceId = getDeviceId();
        // Ưu tiên key từ UI → file local → ACCESS_CACHE
        let licenseKey = licenseKeyFromUI || null;
        if (!licenseKey && fs.existsSync(LICENSE_FILE)) {
            try { licenseKey = (fs.readJsonSync(LICENSE_FILE)).licenseKey; } catch (_) {}
        }
        if (!licenseKey && fs.existsSync(ACCESS_CACHE)) {
            try { licenseKey = (fs.readJsonSync(ACCESS_CACHE)).licenseKey || null; } catch (_) {}
        }

        // Gọi server — gửi cả deviceId lẫn licenseKey (server có thể tìm theo một trong hai)
        debugLog('DEACTIVATE_SEND', { deviceId, licenseKey, hasKey: !!licenseKey });
        {
            const body = JSON.stringify({ deviceId, licenseKey });
            const deactivateResult = await new Promise((resolve) => {
                const url = new URL(TOOLPHUC_API + '/deactivate');
                const req = https.request({
                    hostname: url.hostname,
                    path: url.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                }, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
                        catch (_) { resolve({ statusCode: res.statusCode, rawBody: data }); }
                    });
                });
                req.on('error', (err) => resolve({ error: err.message }));
                req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
                req.write(body);
                req.end();
            });
            debugLog('DEACTIVATE_RESPONSE', deactivateResult);
        }

        // Xoá local dù server có lỗi hay không
        if (fs.existsSync(LICENSE_FILE)) fs.removeSync(LICENSE_FILE);
        if (fs.existsSync(ACCESS_CACHE)) fs.removeSync(ACCESS_CACHE);
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
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
// ─────────────────────────────────────────────────────────────────────────────
// Thông báo từ server — nội dung & link cấu hình hoàn toàn trên tool.erp-x.com
ipcMain.handle('check-app-update', async () => {
    // Refresh announcement từ server mỗi lần user nhấn "Check Updates"
    const fresh = await fetchAnnouncement();
    if (fresh) cachedAnnouncement = fresh;

    // Đọc heartbeat cache để lấy downloadUrl / latestVersion làm fallback
    const hbCache = readAccessCache();

    const ann = cachedAnnouncement;
    if (ann && ann.show) {
        const url = ann.url || hbCache?.downloadUrl || '';
        const remote = ann.version || hbCache?.latestVersion || '';
        debugLog('CHECK_APP_UPDATE', { source: 'announcement', remote, url, skipable: ann.skipable });
        return {
            update: true,
            remote,
            url,
            notes:    ann.notes  || hbCache?.releaseNotes || '',
            skipable: ann.skipable !== false,
        };
    }

    // Không có announcement nhưng heartbeat báo có bản mới
    if (hbCache?.latestVersion) {
        const current = app.getVersion();
        const isOutdated = hbCache.latestVersion.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0;
        if (isOutdated) {
            debugLog('CHECK_APP_UPDATE', { source: 'heartbeat_cache', remote: hbCache.latestVersion, url: hbCache.downloadUrl });
            return {
                update: true,
                remote:   hbCache.latestVersion,
                url:      hbCache.downloadUrl || '',
                notes:    hbCache.releaseNotes || '',
                skipable: hbCache.forceUpdate !== true,
            };
        }
    }

    debugLog('CHECK_APP_UPDATE', { update: false });
    return { update: false };
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
    if (!proc || !proc.browser || !proc.browser.isConnected()) {
        return { error: 'Profile is not running. Please launch it first.' };
    }

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    const proxyIp = profile?.proxyStr?.split(':')[0] || '';

    const results = await runVerify(proc.browser, proxyIp, (progress) => {
        event.sender.send('verify-progress', progress);
    });

    return { success: true, results };
});
ipcMain.handle('get-profiles', async () => { if (!fs.existsSync(PROFILES_FILE)) return []; return fs.readJson(PROFILES_FILE); });
ipcMain.handle('update-profile', async (event, updatedProfile) => { let profiles = await fs.readJson(PROFILES_FILE); const index = profiles.findIndex(p => p.id === updatedProfile.id); if (index > -1) { profiles[index] = updatedProfile; await fs.writeJson(PROFILES_FILE, profiles); return true; } return false; });
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprint = data.fingerprint || generateFingerprint();

    // Apply timezone
    if (data.timezone) fingerprint.timezone = data.timezone;
    else fingerprint.timezone = "America/Los_Angeles";

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

    const newProfile = {
        id: uuidv4(),
        name: data.name,
        proxyStr: data.proxyStr,
        tags: data.tags || [],
        fingerprint: fingerprint,
        preProxyOverride: data.preProxyOverride || 'default',
        isSetup: false,
        createdAt: Date.now()
    };
    profiles.push(newProfile);
    await fs.writeJson(PROFILES_FILE, profiles);

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
    const group = { id: uuidv4(), name: data.name, createdAt: Date.now() };
    groups.push(group);
    await fs.writeJson(GROUPS_FILE, groups);
    return group;
});
ipcMain.handle('update-group', async (event, updated) => {
    const groups = readGroups();
    const idx = groups.findIndex(g => g.id === updated.id);
    if (idx > -1) { groups[idx] = { ...groups[idx], ...updated }; await fs.writeJson(GROUPS_FILE, groups); return true; }
    return false;
});
ipcMain.handle('delete-group', async (event, id) => {
    // Remove group and unassign all profiles in that group
    let groups = readGroups();
    groups = groups.filter(g => g.id !== id);
    await fs.writeJson(GROUPS_FILE, groups);
    if (fs.existsSync(PROFILES_FILE)) {
        let profiles = await fs.readJson(PROFILES_FILE);
        profiles = profiles.map(p => p.groupId === id ? { ...p, groupId: null } : p);
        await fs.writeJson(PROFILES_FILE, profiles);
    }
    return true;
});
ipcMain.handle('assign-profile-group', async (event, { profileId, groupId }) => {
    if (!fs.existsSync(PROFILES_FILE)) return false;
    let profiles = await fs.readJson(PROFILES_FILE);
    const idx = profiles.findIndex(p => p.id === profileId);
    if (idx > -1) { profiles[idx].groupId = groupId || null; await fs.writeJson(PROFILES_FILE, profiles); return true; }
    return false;
});

ipcMain.handle('delete-profile', async (event, id) => {
    // 关闭正在运行的进程
    if (activeProcesses[id]) {
        await forceKill(activeProcesses[id].xrayPid);
        try {
            await activeProcesses[id].browser.close();
        } catch (e) { }

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
    await fs.writeJson(PROFILES_FILE, profiles);

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

ipcMain.handle('check-fingerprint-chromium', async () => {
    const exePath = getFingerprintChromiumPath();
    if (!exePath) return { installed: false };
    try {
        const metaPath = path.join(FINGERPRINT_CHROMIUM_DIR, 'fp-meta.json');
        const meta = fs.existsSync(metaPath) ? fs.readJsonSync(metaPath) : {};
        return { installed: true, path: exePath, version: meta.version || 'unknown' };
    } catch (e) {
        return { installed: true, path: exePath, version: 'unknown' };
    }
});

ipcMain.handle('download-fingerprint-chromium', async (event) => {
    const sender = event.sender;
    const sendProgress = (stage, percent) => {
        try { sender.send('fp-chromium-progress', { stage, percent }); } catch (e) {}
    };

    try {
        sendProgress('Fetching release info...', 2);

        // 1. Get latest release from GitHub API
        const releaseData = await new Promise((resolve, reject) => {
            https.get(
                'https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest',
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
        if (!version) throw new Error('No release found on GitHub');

        const asset = (releaseData.assets || []).find(a => a.name.includes('windows_x64.zip'));
        if (!asset) throw new Error('Windows x64 zip not found in release assets');

        const sizeMB = Math.round(asset.size / 1024 / 1024);
        sendProgress(`Downloading ${asset.name} (${sizeMB} MB)...`, 5);

        // 2. Download with redirect-following and progress
        const tempFile = path.join(app.getPath('temp'), `fp-chromium-${version}.zip`);
        const total = asset.size;

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(tempFile);
            let received = 0;

            function doGet(url) {
                https.get(url, { headers: { 'User-Agent': 'GeekezBrowser/1.4.0' } }, (res) => {
                    if ([301, 302, 307, 308].includes(res.statusCode)) {
                        res.resume(); // drain redirect body so stream closes cleanly
                        return doGet(res.headers.location);
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`HTTP ${res.statusCode} downloading binary`));
                    }
                    res.on('data', chunk => {
                        received += chunk.length;
                        file.write(chunk);
                        const pct = Math.round((received / total) * 75) + 5;
                        const mb = Math.round(received / 1024 / 1024);
                        sendProgress(`Downloading... ${mb}/${sizeMB} MB`, pct);
                    });
                    res.on('end', () => { file.end(); resolve(); });
                    res.on('error', reject);
                }).on('error', reject);
            }
            doGet(asset.browser_download_url);
        });

        // 3. Extract zip
        sendProgress('Extracting...', 82);
        fs.ensureDirSync(FINGERPRINT_CHROMIUM_DIR);
        fs.emptyDirSync(FINGERPRINT_CHROMIUM_DIR);

        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(FINGERPRINT_CHROMIUM_DIR, true);

        sendProgress('Locating chrome.exe...', 93);

        // 4. If chrome.exe is nested in a subdirectory, flatten it
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
        let exePath = findExe(FINGERPRINT_CHROMIUM_DIR, exeName);
        if (!exePath) throw new Error(`${exeName} not found after extraction`);

        const exeDir = path.dirname(exePath);
        if (exeDir !== FINGERPRINT_CHROMIUM_DIR) {
            for (const entry of fs.readdirSync(exeDir)) {
                fs.moveSync(
                    path.join(exeDir, entry),
                    path.join(FINGERPRINT_CHROMIUM_DIR, entry),
                    { overwrite: true }
                );
            }
            exePath = path.join(FINGERPRINT_CHROMIUM_DIR, exeName);
        }

        // 5. Save metadata and cleanup
        fs.writeJsonSync(path.join(FINGERPRINT_CHROMIUM_DIR, 'fp-meta.json'), {
            version, downloadedAt: new Date().toISOString(), source: 'adryfish/fingerprint-chromium'
        });
        try { fs.removeSync(tempFile); } catch (e) {}

        sendProgress('Done!', 100);
        return { success: true, version, path: exePath };

    } catch (err) {
        sendProgress(`Error: ${err.message}`, -1);
        throw err;
    }
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

        const platform = process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'mac-x64' : 'linux64';
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
ipcMain.handle('remove-user-extension', async (e, extPath) => {
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
ipcMain.handle('open-url', async (e, url) => { await shell.openExternal(url); });

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

ipcMain.handle('set-data-directory', async (e, { newPath, migrate }) => {
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
    delete cleaned.userAgent;
    delete cleaned.userAgentMetadata;
    delete cleaned.webgl;
    return cleaned;
}

// 加密辅助函数
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC_HEADER = Buffer.from('GKEZ'); // GeekEZ magic bytes

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
ipcMain.handle('export-selected-data', async (e, { type, profileIds }) => {
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
        defaultPath: `GeekEZ_Backup_${typeNames[type] || type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return { success: true, count: selectedProfiles.length };
    }
    return { success: false, cancelled: true };
});

// 完整备份 (v2 跨平台方案 - 含浏览器数据，加密)
ipcMain.handle('export-full-backup', async (e, { profileIds, password }) => {
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
                    args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu'],
                    defaultViewport: null,
                    ignoreDefaultArgs: ['--enable-automation'],
                });
                const page = (await browser.pages())[0] || await browser.newPage();
                const client = await page.createCDPSession();
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
            defaultPath: `GeekEZ_FullBackup_${Date.now()}.geekez`,
            filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
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
ipcMain.handle('import-full-backup', async (e, { password }) => {
    try {
        const { filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
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
            const idx = currentProfiles.findIndex(cp => cp.id === profile.id);
            if (idx > -1) { currentProfiles[idx] = profile; } else { currentProfiles.push(profile); }
            importedCount++;
        }
        await fs.writeJson(PROFILES_FILE, currentProfiles);

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
                        args: ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-gpu'],
                        defaultViewport: null, ignoreDefaultArgs: ['--enable-automation'],
                    });
                    if (hasCookies) {
                        const page = (await browser.pages())[0] || await browser.newPage();
                        const client = await page.createCDPSession();
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
                        const idx = currentProfiles.findIndex(cp => cp.id === p.id);
                        if (idx > -1) currentProfiles[idx] = p;
                        else {
                            if (!p.id) p.id = uuidv4();
                            currentProfiles.push(p);
                        }
                    });
                    await fs.writeJson(PROFILES_FILE, currentProfiles);
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
                await fs.writeJson(PROFILES_FILE, profiles);
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
ipcMain.handle('export-data', async (e, type) => {
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
        defaultPath: `GeekEZ_Backup_${type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });
    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return true;
    }
    return false;
});

// --- 核心启动逻辑 ---
ipcMain.handle('launch-profile', async (event, profileId, watermarkStyle) => {
    const sender = event.sender;

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        if (proc.browser && proc.browser.isConnected()) {
            try {
                const targets = await proc.browser.targets();
                const pageTarget = targets.find(t => t.type() === 'page');
                if (pageTarget) {
                    const page = await pageTarget.page();
                    if (page) {
                        const session = await pageTarget.createCDPSession();
                        const { windowId } = await session.send('Browser.getWindowForTarget');
                        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
                        setTimeout(async () => {
                            try { await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch (e) { }
                        }, 100);
                        await page.bringToFront();
                    }
                }
                return "环境已唤醒";
            } catch (e) {
                await forceKill(proc.xrayPid);
                delete activeProcesses[profileId];
            }
        } else {
            await forceKill(proc.xrayPid);
            delete activeProcesses[profileId];
        }
        if (activeProcesses[profileId]) return "环境已唤醒";
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
        const isDirect = !profile.proxyStr || profile.proxyStr.trim() === '' || profile.proxyStr.trim().toLowerCase() === 'direct';

        let xrayProcess = null;
        let logFd = null;
        if (!isDirect) {
            const config = generateXrayConfig(profile.proxyStr, localPort, finalPreProxyConfig);
            fs.writeJsonSync(xrayConfigPath, config);
            logFd = fs.openSync(xrayLogPath, 'a');
            xrayProcess = spawn(BIN_PATH, ['-c', xrayConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: ['ignore', logFd, logFd], windowsHide: true });
            // 优化：减少等待时间，Xray 通常 300ms 内就能启动
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 0. Auto-detect geo signals from proxy IP (only when proxy present)
        if (!isDirect && profile.proxyStr) {
            const needsTimezone = !profile.fingerprint.timezone || profile.fingerprint.timezone === 'Auto';
            // Language needs sync when: not set, or default 'en-US' and timezone is non-English
            const needsLanguage = !profile.fingerprint.language || profile.fingerprint.language === 'auto'
                || profile.fingerprint.language === 'en-US';

            if (needsTimezone || needsLanguage) {
                console.log('🔍 Detecting proxy geo signals...');
                const geoData = await getProxyGeolocation(profile.proxyStr).catch(() => null);
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
            proxy: profile.proxyStr ? profile.proxyStr.split(':').slice(0,2).join(':') + ':***' : 'none',
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

        // 1. 生成 GeekEZ Guard 扩展（使用传递的水印样式）
        const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
        const extPath = await generateExtension(profileDir, profile.fingerprint, profile.name, style, profileId, isFingerprintChromium(chromePath));

        // 2. 获取用户自定义扩展
        const userExts = settings.userExtensions || [];

        // 3. 合并所有扩展路径
        let extPaths = extPath; // GeekEZ Guard
        if (userExts.length > 0) {
            extPaths += ',' + userExts.join(',');
        }

        // 4. 构建启动参数（性能优化）

        const launchArgs = [
            ...(isDirect ? ['--no-proxy-server'] : [`--proxy-server=socks5://127.0.0.1:${localPort}`]),
            `--user-data-dir=${userDataDir}`,
            `--window-size=${profile.fingerprint?.window?.width || 1280},${profile.fingerprint?.window?.height || 800}`,
            '--restore-last-session',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process,ExtensionsMenuAccessControl',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            `--lang=${targetLang}`,
            `--accept-lang=${targetLang}`,
            `--disable-extensions-except=${extPaths}`,
            `--load-extension=${extPaths}`,
            // 性能优化参数
            '--no-first-run',                    // 跳过首次运行向导
            '--no-default-browser-check',        // 跳过默认浏览器检查
            '--disable-session-crashed-bubble',  // 隐藏恢复会话提示气泡
            '--disable-background-timer-throttling', // 防止后台标签页被限速
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-dev-shm-usage',           // 减少共享内存使用
            '--disk-cache-size=52428800',        // 限制磁盘缓存为 50MB
            '--media-cache-size=52428800'        // 限制媒体缓存为 50MB
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
            if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
                launchArgs.push(`--timezone=${profile.fingerprint.timezone}`);
            }
            console.log(`[FP-Chromium] platform=windows, brand=Chrome (no canvas noise)`);
        }

        // 时区设置
        const env = { ...process.env };
        if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
            env.TZ = profile.fingerprint.timezone;
        }

        const browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            userDataDir: userDataDir,
            args: launchArgs,
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
            pipe: false,
            dumpio: false,
            env: env  // 注入环境变量
        });

        // ==========================================
        // Fix: Auto-close empty and extension tabs
        // ==========================================
        try {
            // Extension background scripts might open tabs immediately upon load
            // We use targetcreated to aggressively close them during the first 3 seconds
            const startTime = Date.now();
            const startupWindowMs = 3000;

            // Allow chrome-extension:// and remote URLs (like onboarding.immersivetranslate.com) 
            // to be caught and closed if they open dynamically during startup.
            const interceptor = async (target) => {
                if (Date.now() - startTime > startupWindowMs) {
                    browser.off('targetcreated', interceptor); // remove listener after 3s
                    return;
                }

                if (target.type() === 'page') {
                    try {
                        const page = await target.page();
                        if (page) {
                            const url = page.url();
                            // If it's an extension welcome page (either extension scheme or a remote onboarding URL)
                            // Note: we can't reliably guess all remote URLs, but typically restore-session pages 
                            // were already created BEFORE targetcreated fires for new extension tabs, or they load silently.
                            // Actually, Chrome session restore creates targets too.
                            // To be safe, we mainly target the active welcome pages that usually steal focus.
                            if (url.startsWith('chrome-extension://')) {
                                await page.close();
                            } else {
                                // For remote URLs like immersive translate, extensions often use chrome.tabs.create
                                // Wait for the URL to resolve and block the request so it doesn't flash
                                try {
                                    await page.setRequestInterception(true);
                                    page.on('request', async (request) => {
                                        if (Date.now() - startTime > startupWindowMs + 2000) {
                                            try { await request.continue(); } catch (e) { }
                                            return;
                                        }
                                        const reqUrl = request.url();
                                        if (request.isNavigationRequest() && (reqUrl.includes('onboarding.') || reqUrl.includes('welcome') || reqUrl.includes('install') || reqUrl.startsWith('chrome-extension://'))) {
                                            try { await request.abort(); } catch (e) { }
                                            try { await page.close(); } catch (e) { }
                                        } else {
                                            try { await request.continue(); } catch (e) { }
                                        }
                                    });
                                } catch (e) { }
                            }
                        }
                    } catch (e) { }
                }
            };

            browser.on('targetcreated', interceptor);

            // Wait a moment for the initial session to restore
            await new Promise(r => setTimeout(r, 1500));
            const pages = await browser.pages();

            let realTabCount = pages.filter(p => {
                const url = p.url();
                return url !== 'about:blank' && !url.startsWith('chrome-extension://') && !url.includes('onboarding.');
            }).length;

            for (const page of pages) {
                try {
                    const url = page.url();
                    if (url.startsWith('chrome-extension://') || url.includes('onboarding.')) {
                        await page.close();
                        continue;
                    }
                    if (url === 'about:blank' && realTabCount > 0) {
                        await page.close();
                    }
                } catch (e) { }
            }
        } catch (e) {
            console.error('Failed to cleanup initial tabs:', e);
        }

        activeProcesses[profileId] = {
            xrayPid: xrayProcess ? xrayProcess.pid : null,
            browser,
            logFd: logFd
        };
        sender.send('profile-status', { id: profileId, status: 'running' });

        // CDP Timezone Override (Windows only)
        // On macOS/Linux, TZ env var changes V8's timezone natively.
        // On Windows, V8 ignores TZ and uses Win32 API, so we use CDP instead.
        // This changes V8's internal timezone at the engine level - all Date methods
        // (toString, getTimezoneOffset, getHours, etc.) and Intl APIs work correctly.
        const targetTimezone = profile.fingerprint?.timezone;
        if (process.platform === 'win32' && targetTimezone && targetTimezone !== 'Auto') {
            try {
                const pages = await browser.pages();
                for (const page of pages) {
                    try {
                        const s = await page.createCDPSession();
                        await s.send('Emulation.setTimezoneOverride', { timezoneId: targetTimezone });
                    } catch (e) { }
                }
                browser.on('targetcreated', async (target) => {
                    if (target.type() === 'page') {
                        try {
                            // Use createCDPSession directly — faster than target.page().
                            // Avoids race condition where page loads and computes timezone
                            // before emulateTimezone() is called.
                            const session = await target.createCDPSession();
                            await session.send('Emulation.setTimezoneOverride', { timezoneId: targetTimezone });
                        } catch (e) { }
                    }
                });
            } catch (e) {
                console.error('CDP timezone override failed:', e.message);
            }
        }

        // CDP UA-CH Override — fix Chrome for Testing missing "Google Chrome" brand
        // CfT sends: "Chromium";v="147", "Not.A/Brand";v="8"
        // Real Chrome: "Google Chrome";v="147", "Chromium";v="147", "Not.A/Brand";v="99"
        // Pixelscan /s/api/hh checks secUA, secArch, secBitness, secPlatformVersion, secFullVersion
        // All empty → inconsistency signal. CDP Network.setUserAgentOverride with userAgentMetadata
        // fills these at V8 level — consistent across all contexts including Workers.
        {
            // Detect actual Chrome version from binary path (e.g. mac_arm-143.0.7499.169)
            let actualChromeVer = null;
            if (chromePath) {
                const m = chromePath.replace(/\\/g, '/').match(/-((\d+)\.(\d+)\.(\d+)\.(\d+))[/\\]/);
                if (m) actualChromeVer = m[1];
            }

            // Determine platform/arch from Node.js process
            const isMac = process.platform === 'darwin';
            const isArm = process.arch === 'arm64';

            // Get macOS version for Sec-CH-UA-Platform-Version (e.g. "14.0.0")
            let osMajorVersion = '10.0.0';
            if (isMac) {
                try {
                    const sysVer = process.getSystemVersion ? process.getSystemVersion() : '';
                    // sysVer is like "14.5" or "13.6.1"
                    const parts = sysVer.split('.');
                    osMajorVersion = `${parts[0] || '14'}.${parts[1] || '0'}.${parts[2] || '0'}`;
                } catch (e) { osMajorVersion = '14.0.0'; }
            }

            // Build a platform-correct fallback UA using the actual Chrome binary version
            const fallbackVer = actualChromeVer || (isMac ? '143.0.7499.169' : '147.0.7727.24');
            const fallbackUA = isMac
                ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fallbackVer} Safari/537.36`
                : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fallbackVer} Safari/537.36`;

            // Use stored UA if present, but force-correct the Chrome version to match actual binary
            let ua = profile.fingerprint?.userAgent || fallbackUA;
            if (actualChromeVer) {
                ua = ua.replace(/Chrome\/[\d.]+/, `Chrome/${actualChromeVer}`);
            }

            const uaMatch = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
            const major = uaMatch ? uaMatch[1] : fallbackVer.split('.')[0];
            const fullVer = uaMatch ? `${uaMatch[1]}.${uaMatch[2]}.${uaMatch[3]}.${uaMatch[4]}` : fallbackVer;

            const uaPlatform = isMac ? 'macOS' : 'Windows';
            const uaArch = isArm ? 'arm' : 'x86';

            const uaMetadata = {
                brands: [
                    { brand: 'Google Chrome', version: major },
                    { brand: 'Chromium', version: major },
                    { brand: 'Not.A/Brand', version: '99' }
                ],
                fullVersionList: [
                    { brand: 'Google Chrome', version: fullVer },
                    { brand: 'Chromium', version: fullVer },
                    { brand: 'Not.A/Brand', version: '99.0.0.0' }
                ],
                fullVersion: fullVer,
                platform: uaPlatform,
                platformVersion: osMajorVersion,
                architecture: uaArch,
                bitness: '64',
                model: '',
                mobile: false,
                wow64: false
            };
            // High-entropy UA-CH hints (Sec-CH-UA-Arch, Bitness, etc.) are only sent by
            // browsers when the server requests them via Accept-CH response header.
            // Chrome for Testing may not have stored Accept-CH permissions for Pixelscan,
            // so we inject them directly via Network.setExtraHTTPHeaders to ensure
            // secArch/secBitness/secPlatformVersion are populated in Pixelscan's /s/api/hh.
            const highEntropyHeaders = {
                'Sec-CH-UA-Arch': `"${uaArch}"`,
                'Sec-CH-UA-Bitness': '"64"',
                'Sec-CH-UA-Platform-Version': `"${osMajorVersion}"`,
                'Sec-CH-UA-Full-Version-List': `"Google Chrome";v="${fullVer}", "Chromium";v="${fullVer}", "Not.A/Brand";v="99.0.0.0"`,
                'Sec-CH-UA-Model': '""',
                'Sec-CH-UA-WoW64': '?0'
            };
            const applyUACH = async (session) => {
                try {
                    await session.send('Network.setUserAgentOverride', {
                        userAgent: ua,
                        userAgentMetadata: uaMetadata
                    });
                    await session.send('Network.setExtraHTTPHeaders', {
                        headers: highEntropyHeaders
                    });
                } catch (e) {}
            };
            try {
                const pages = await browser.pages();
                for (const page of pages) {
                    try { await applyUACH(await page.createCDPSession()); } catch (e) {}
                }
                browser.on('targetcreated', async (target) => {
                    if (target.type() === 'page') {
                        try { await applyUACH(await target.createCDPSession()); } catch (e) {}
                    }
                });
                console.log(`[CDP] UA-CH override: Chrome/${major}, platform=${uaPlatform}, arch=${uaArch}, ver=${fullVer}`);
            } catch (e) {
                console.error('CDP UA-CH override failed:', e.message);
            }
        }

        // NOTE: CDP Emulation.setDeviceMetricsOverride is a known detection vector.
        // Pixelscan detects it as "Masking detected". Screen values in profiles must
        // match the real machine's logical screen dimensions (real DPR × logical = physical).
        // No screen spoofing — profile screen should be set to real hardware values.

        browser.on('disconnected', async () => {
            if (activeProcesses[profileId]) {
                const pid = activeProcesses[profileId].xrayPid;
                const logFd = activeProcesses[profileId].logFd;

                // 关闭日志文件描述符
                if (logFd !== undefined) {
                    try {
                        fs.closeSync(logFd);
                    } catch (e) { }
                }

                delete activeProcesses[profileId];
                await forceKill(pid);

                // 性能优化：清理缓存文件，节省磁盘空间
                try {
                    const cacheDir = path.join(userDataDir, 'Default', 'Cache');
                    const codeCacheDir = path.join(userDataDir, 'Default', 'Code Cache');
                    if (fs.existsSync(cacheDir)) await fs.emptyDir(cacheDir);
                    if (fs.existsSync(codeCacheDir)) await fs.emptyDir(codeCacheDir);
                } catch (e) {
                    // 忽略清理错误
                }

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
});

app.on('before-quit', () => {
    app.isQuiting = true;
    Object.values(activeProcesses).forEach(p => forceKill(p.xrayPid));
});
// Helpers (Same)
function fetchJson(url) { return new Promise((resolve, reject) => { const req = https.get(url, { headers: { 'User-Agent': 'GeekEZ-Browser' } }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }); req.on('error', reject); }); }
function getLocalXrayVersion() { return new Promise((resolve) => { if (!fs.existsSync(BIN_PATH)) return resolve('v0.0.0'); try { const proc = spawn(BIN_PATH, ['-version']); let output = ''; proc.stdout.on('data', d => output += d.toString()); proc.on('close', () => { const match = output.match(/Xray\s+v?(\d+\.\d+\.\d+)/i); resolve(match ? (match[1].startsWith('v') ? match[1] : 'v' + match[1]) : 'v0.0.0'); }); proc.on('error', () => resolve('v0.0.0')); } catch (e) { resolve('v0.0.0'); } }); }
function compareVersions(v1, v2) { const p1 = v1.split('.').map(Number); const p2 = v2.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((p1[i] || 0) > (p2[i] || 0)) return 1; if ((p1[i] || 0) < (p2[i] || 0)) return -1; } return 0; }
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
