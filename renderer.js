// i18n structure moved to i18n.js and locales/

// ════════════════════════════════════════════════════════════════════════════
// PROXY AFFILIATE LINK
// ════════════════════════════════════════════════════════════════════════════
// "Mua Proxy" button in the Add/Edit profile modals — shallow affiliate integration,
// no backend/API purchase flow. Swap this single URL to change provider (e.g. once
// an IPRoyal referral link is available) — nothing else needs to change.
const PROXY_AFFILIATE_URL = 'https://proxy6.net/?r=659546';

function openProxyAffiliateLink() {
    window.electronAPI.invoke('open-url', PROXY_AFFILIATE_URL);
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════════════════════
// Generic opener for external-site tools — renders in-app via <webview> on the
// embeddedToolPage (not a separate OS window). A fresh <webview> is created per
// call with its own persist:tool-{id} session partition, so one tool's login
// (proxy6.net, phuc.vn/2fa, ...) never mixes with another's, and each is
// remembered across app restarts (partitions persist to disk under userData).
function openEmbeddedTool(id, url, title) {
    _switchPage('embeddedToolPage', null);
    document.getElementById('embeddedToolTitle').textContent = title || '';
    const container = document.getElementById('embeddedToolWebviewContainer');
    const loading = document.getElementById('embeddedToolLoading');

    // Remove only the previous tool's <webview> (different id = different session
    // partition) — the loading spinner div is a static sibling in this same
    // container and must survive, so no full innerHTML wipe here.
    document.getElementById('embeddedToolWebview')?.remove();

    if (loading) loading.style.display = 'flex';

    const webview = document.createElement('webview');
    webview.id = 'embeddedToolWebview';
    webview.setAttribute('partition', `persist:tool-${id}`);
    webview.setAttribute('src', url);
    // -webkit-app-region:no-drag — without it the webview inherits "drag" from the
    // window chrome and every click inside the embedded page is swallowed as a
    // window-drag gesture instead of reaching the page.
    webview.style.cssText = 'flex:1;width:100%;height:100%;border:none;-webkit-app-region:no-drag;';

    const hideLoading = () => { if (loading) loading.style.display = 'none'; };
    webview.addEventListener('did-start-loading', () => { if (loading) loading.style.display = 'flex'; });
    webview.addEventListener('did-stop-loading', hideLoading);
    webview.addEventListener('did-fail-load', hideLoading);

    container.appendChild(webview);
}

function closeEmbeddedTool() {
    showToolsPage();
}

function reloadEmbeddedTool() {
    document.getElementById('embeddedToolWebview')?.reload();
}

function open2faTool() {
    openEmbeddedTool('2fa', 'https://phuc.vn/2fa/', '2FA Generator');
}

// ── YouTube thumbnail grabber — fully native, no external site needed.
// YouTube serves thumbnails from a predictable public URL per video ID at
// several fixed resolutions; no API key or auth required.
const YT_THUMB_SIZES = [
    { key: 'maxresdefault', label: 'Max (1280×720)' },
    { key: 'sddefault',     label: 'SD (640×480)' },
    { key: 'hqdefault',     label: 'HQ (480×360)' },
    { key: 'mqdefault',     label: 'MQ (320×180)' },
];

function extractYoutubeId(input) {
    const s = (input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s; // already a bare video ID
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([\w-]{11})/,
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return m[1];
    }
    return null;
}

function openYoutubeThumbModal() {
    document.getElementById('ytThumbInput').value = '';
    document.getElementById('ytThumbResults').innerHTML = '';
    document.getElementById('ytThumbModal').style.display = 'flex';
    setTimeout(() => document.getElementById('ytThumbInput')?.focus(), 100);
}

function closeYoutubeThumbModal() {
    document.getElementById('ytThumbModal').style.display = 'none';
}

function loadYoutubeThumbs() {
    const input = document.getElementById('ytThumbInput').value;
    const id = extractYoutubeId(input);
    const results = document.getElementById('ytThumbResults');
    if (!id) {
        results.innerHTML = '<div style="color:#f44336;font-size:13px;padding:10px 0;">Không nhận diện được video ID — dán link YouTube đầy đủ hoặc video ID (11 ký tự).</div>';
        return;
    }
    _ytThumbCurrentId = id;
    document.getElementById('ytThumbDownloadAllRow').style.display = 'block';
    results.innerHTML = YT_THUMB_SIZES.map(({ key, label }) => {
        const url = `https://img.youtube.com/vi/${id}/${key}.jpg`;
        const filename = `${id}_${key}.jpg`;
        return `
        <div style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.2);">
            <img src="${url}" style="width:100%;display:block;background:#111;" onerror="this.parentElement.style.display='none'">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;gap:8px;">
                <span style="font-size:11px;color:#888;">${label}</span>
                <div style="display:flex;gap:6px;">
                    <button onclick="window.electronAPI.invoke('open-url','${url}')" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">Mở</button>
                    <button onclick="ytThumbDownloadOne('${url}','${filename}')" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #00b8d4;background:transparent;color:#00b8d4;cursor:pointer;">Tải về</button>
                </div>
            </div>
        </div>`;
    }).join('');
}

let _ytThumbCurrentId = '';

async function ytThumbDownloadOne(url, filename) {
    const r = await window.electronAPI.invoke('download-thumb', { url, filename });
    if (!r?.ok) showBncToast('Không tải được ảnh', 2500);
}

async function ytThumbDownloadAll() {
    const id = _ytThumbCurrentId;
    if (!id) return;
    const items = YT_THUMB_SIZES.map(({ key }) => ({
        url: `https://img.youtube.com/vi/${id}/${key}.jpg`,
        filename: `${id}_${key}.jpg`,
    }));
    const r = await window.electronAPI.invoke('download-all-thumbs', items);
    if (r?.ok) {
        const msg = r.failed > 0 ? `Đã tải ${r.total - r.failed}/${r.total} ảnh` : `Đã tải ${r.total} ảnh`;
        showBncToast(msg, 3000);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// BNC AUTH UI
// ════════════════════════════════════════════════════════════════════════════
let _bncAuth = null; // { email, customerId, slots: { totalGranted, slotsUsed, slotsBilled, available, canRun } }
let _bncNotifications = [];

async function bncInit() {
    // Nhận trạng thái từ main process (gửi sau access check)
    window.electronAPI.onBncAuthState(async (state) => {
        if (!state.isLoggedIn) {
            showBncLoginOverlay(state.reason);
        } else {
            hideBncLoginOverlay();
            await bncLoadUserInfo();
        }
    });

    // Auto-update teams khi heartbeat phát hiện thay đổi
    window.electronAPI.onBncTeamsUpdated((teams) => {
        if (_bncAuth) _bncAuth.teams = teams || [];
        _renderWorkspaceSelector(_bncAuth?.teams || []);
    });

    // Fallback: tự check nếu không nhận được event (reload / cache)
    try {
        const auth = await window.electronAPI.bncGetAuth();
        _bncAuth = auth;
        if (!auth || !auth.isLoggedIn) {
            showBncLoginOverlay();
        } else {
            hideBncLoginOverlay();
            bncRenderUserInfo(auth);
            _renderWorkspaceSelector(auth.teams || []);
            if (auth.activeWorkspace && auth.activeWorkspace !== 'own') {
                await _switchWorkspace(auth.activeWorkspace);
            }
            await ensureBncTermsAccepted();
        }
    } catch (_) {}

    // Register link → show in-app register form
    document.getElementById('bncRegisterLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('bncLoginForm').style.display = 'none';
        document.getElementById('bncRegisterForm').style.display = 'block';
        document.getElementById('bncRegNameInput')?.focus();
    });
    document.getElementById('bncBackToLoginLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('bncRegisterForm').style.display = 'none';
        document.getElementById('bncLoginForm').style.display = 'block';
    });
    document.getElementById('bncForgotLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.invoke('open-url', 'https://yttool.vn/quen-mat-khau');
    });

    // Đóng dropdown khi click ngoài
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('bncUserDropdown');
        const btn = document.getElementById('bncAvatarBtn');
        if (dd && !dd.contains(e.target) && !btn?.contains(e.target)) {
            dd.style.display = 'none';
        }
        const wsMenu = document.getElementById('wsDropdown');
        const wsBtn = document.getElementById('wsCurrent');
        if (wsMenu && !wsMenu.contains(e.target) && !wsBtn?.contains(e.target)) {
            wsMenu.style.display = 'none';
        }
    });

    // Heartbeat cập nhật slots từ server
    window.electronAPI.onBncSlotsUpdated((slots) => {
        if (_bncAuth && slots) {
            const prevAvailable = _bncAuth.slots?.available ?? -1;
            _bncAuth.slots = slots;
            _updatePlanPill(_bncAuth);
            // Reload profile list nếu available thay đổi → isLocked thay đổi
            if (slots.available !== prevAvailable) {
                loadProfiles();
            }
        }
    });

    // ── Auto-updater events ───────────────────────────────────────────────────
    window.electronAPI.onUpdateDownloading(({ version }) => {
        const bar = document.getElementById('updateBar');
        const txt = document.getElementById('updateBarText');
        const prog = document.getElementById('updateProgressWrap');
        if (bar) bar.style.display = 'flex';
        if (txt) txt.textContent = `Đang tải v${version}...`;
        if (prog) prog.style.display = 'block';
    });
    window.electronAPI.onUpdateProgress(({ percent }) => {
        const p = document.getElementById('updateProgressBar');
        const t = document.getElementById('updateBarText');
        if (p) p.style.width = percent + '%';
        if (t) t.textContent = `Đang tải... ${percent}%`;
    });
    window.electronAPI.onUpdateReady(({ version }) => {
        const bar  = document.getElementById('updateBar');
        const txt  = document.getElementById('updateBarText');
        const prog = document.getElementById('updateProgressWrap');
        const btn  = document.getElementById('updateInstallBtn');
        if (bar)  bar.style.display = 'flex';
        if (txt)  txt.textContent = `v${version} sẵn sàng`;
        if (prog) prog.style.display = 'none';
        if (btn)  btn.style.display = 'inline-block';
        showBncToast(`🎉 BNC Browser v${version} đã sẵn sàng cài đặt`, 8000);
    });

    // Nhận notifications từ heartbeat (main.js push mỗi 5 phút)
    window.electronAPI.onBncNotificationsUpdated((notifs) => {
        const prev = new Set((_bncNotifications || []).map(n => n.id));
        _bncNotifications = notifs || [];
        _renderNotifBadge();
        // Hiện dialog cho notification mới có displayMode=dialog (hoặc không set = mặc định dialog)
        const newOnes = _bncNotifications.filter(n =>
            !n.isRead && !prev.has(n.id) &&
            (!n.metadata?.displayMode || n.metadata?.displayMode === 'dialog')
        );
        if (newOnes.length > 0) bncShowNotifDialog(newOnes);
    });

    // Startup sync: main.js đã fetch profiles mới từ server → reload UI
    window.electronAPI.onBncProfilesReloaded(() => {
        loadProfiles();
    });

    // Cập nhật badge sync cho từng profile khi main.js xác nhận sync xong
    window.electronAPI.onProfileSyncStatus(({ id, syncedToServer }) => {
        const badge = document.getElementById('sync-' + id);
        if (badge) {
            const color = syncedToServer ? '#22c55e' : '#ef4444';
            const icon  = syncedToServer ? '✔' : '✘';
            badge.title = syncedToServer ? 'Đã sync lên yttool.vn' : 'Chưa sync lên server';
            badge.textContent = '☁ ' + icon;
            badge.style.color = color;
            badge.style.background = color + '22';
            badge.style.borderColor = color + '66';
        }
        // Nếu server từ chối (hết slot / lỗi) → hoàn lại 1 slot optimistic
        if (!syncedToServer && _bncAuth?.slots) {
            _bncAuth.slots.slotsUsed = Math.max(0, _bncAuth.slots.slotsUsed - 1);
            _bncAuth.slots.available += 1;
            _updatePlanPill(_bncAuth);
        }
    });
}

function showBncLoginOverlay(reason) {
    const overlay = document.getElementById('bncLoginOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const notice = document.getElementById('bncLoginNotice');
    if (notice) {
        if (reason === 'device_kicked') {
            notice.textContent = 'Thiết bị khác vừa đăng nhập vào tài khoản của bạn. Vui lòng đăng nhập lại.';
            notice.style.cssText = 'display:block;margin-bottom:16px;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;background:rgba(255,180,0,0.12);border:1px solid rgba(255,180,0,0.35);color:#ffb400;';
        } else if (reason === 'token_invalid') {
            notice.textContent = 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
            notice.style.cssText = 'display:block;margin-bottom:16px;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;background:rgba(0,224,255,0.08);border:1px solid rgba(0,224,255,0.2);color:#00e0ff;';
        } else {
            notice.style.display = 'none';
        }
    }
    setTimeout(() => document.getElementById('bncEmailInput')?.focus(), 300);
}

function hideBncLoginOverlay() {
    const overlay = document.getElementById('bncLoginOverlay');
    if (overlay) overlay.style.display = 'none';
}


function toggleBncPassword() {
    const inp = document.getElementById('bncPasswordInput');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function doBncLogin() {
    const email    = document.getElementById('bncEmailInput')?.value?.trim();
    const password = document.getElementById('bncPasswordInput')?.value;
    const errEl    = document.getElementById('bncLoginError');
    const btn      = document.getElementById('bncLoginBtn');

    if (!email || !password) {
        errEl.textContent = 'Vui lòng nhập đầy đủ email và mật khẩu';
        errEl.style.display = 'block'; return;
    }
    errEl.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Đang đăng nhập...';

    try {
        const result = await window.electronAPI.bncLogin(email, password);
        if (result.success) {
            _bncAuth = {
                isLoggedIn: true, email, customerId: result.customer?.id,
                slots: result.slots || { totalGranted: 0, slotsUsed: 0, available: 0 },
                teams: result.teams || [],
                activeWorkspace: 'own',
            };
            hideBncLoginOverlay();
            bncRenderUserInfo(_bncAuth);
            _renderWorkspaceSelector(_bncAuth.teams);
            await loadProfiles(); // Load profiles của account vừa login
            await ensureBncTermsAccepted();
        } else {
            errEl.textContent = result.message || 'Đăng nhập thất bại';
            errEl.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Đăng nhập';
        }
    } catch (e) {
        errEl.textContent = 'Lỗi kết nối. Kiểm tra lại mạng.';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Đăng nhập';
    }
}

async function doBncRegister() {
    const name     = document.getElementById('bncRegNameInput')?.value?.trim();
    const email    = document.getElementById('bncRegEmailInput')?.value?.trim();
    const password = document.getElementById('bncRegPwInput')?.value;
    const confirm  = document.getElementById('bncRegPwConfirmInput')?.value;
    const errEl    = document.getElementById('bncRegError');
    const btn      = document.getElementById('bncRegBtn');

    errEl.style.display = 'none';
    if (!name || !email || !password || !confirm) {
        errEl.textContent = 'Vui lòng điền đầy đủ thông tin';
        errEl.style.display = 'block'; return;
    }
    if (password !== confirm) {
        errEl.textContent = 'Mật khẩu xác nhận không khớp';
        errEl.style.display = 'block'; return;
    }
    if (password.length < 6) {
        errEl.textContent = 'Mật khẩu phải từ 6 ký tự trở lên';
        errEl.style.display = 'block'; return;
    }

    btn.disabled = true; btn.textContent = 'Đang đăng ký...';
    try {
        const result = await window.electronAPI.bncRegister(name, email, password, confirm);
        if (result.success) {
            // Auto-load bằng cách gọi login luôn để lấy đầy đủ slots/profiles
            const loginResult = await window.electronAPI.bncLogin(email, password);
            _bncAuth = {
                isLoggedIn: true, email,
                customerId: result.customer?.id,
                slots: loginResult?.slots || { totalGranted: 0, slotsUsed: 0, available: 0 },
                teams: loginResult?.teams || [],
                activeWorkspace: 'own',
            };
            hideBncLoginOverlay();
            bncRenderUserInfo(_bncAuth);
            _renderWorkspaceSelector(_bncAuth.teams);
            await loadProfiles();
            await ensureBncTermsAccepted();
        } else {
            errEl.textContent = result.message || 'Đăng ký thất bại';
            errEl.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Đăng ký';
        }
    } catch (e) {
        errEl.textContent = 'Lỗi kết nối. Kiểm tra lại mạng.';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Đăng ký';
    }
}

async function refreshBncTeams() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    try {
        const result = await window.electronAPI.bncRefreshTeams();
        if (!result?.success) {
            showBncToast('⚠ Không tải lại được workspace', 3000);
            return;
        }
        if (_bncAuth) {
            _bncAuth.teams = result.teams || [];
            if (result.slots) _bncAuth.slots = result.slots;
        }
        _renderWorkspaceSelector(_bncAuth?.teams || []);
        bncRenderUserInfo(_bncAuth);
        const count = (result.teams || []).length;
        showBncToast(`✓ Đã tải lại — ${count} workspace`, 2500);
    } catch (e) {
        showBncToast('⚠ Lỗi khi tải lại workspace', 3000);
    }
}

async function ensureBncTermsAccepted() {
    try {
        const status = await window.electronAPI.bncTermsStatus();
        if (status?.accepted) return;
    } catch (_) {}
    const overlay = document.getElementById('bncTermsOverlay');
    const cb      = document.getElementById('bncTermsCheckbox');
    const btn     = document.getElementById('bncTermsAcceptBtn');
    if (cb)  cb.checked = false;
    if (btn) btn.classList.add('terms-btn-locked');
    if (overlay) overlay.style.display = 'flex';
}

async function bncAcceptTerms() {
    const cb = document.getElementById('bncTermsCheckbox');
    if (!cb?.checked) {
        // Customer reported "can't click anything to close this" — they were clicking this
        // button without having checked the box above it. Since the button is intentionally
        // always clickable now (see index.html comment), draw attention to what's actually
        // missing instead of doing nothing silently.
        const label = document.getElementById('bncTermsCheckLabel');
        if (label) {
            label.classList.remove('bnc-terms-nudge');
            void label.offsetWidth; // restart animation if triggered twice in a row
            label.classList.add('bnc-terms-nudge');
            setTimeout(() => label.classList.remove('bnc-terms-nudge'), 900);
        }
        return;
    }
    try { await window.electronAPI.bncTermsAccept(); } catch (_) {}
    const overlay = document.getElementById('bncTermsOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function bncDeclineTerms() {
    const overlay = document.getElementById('bncTermsOverlay');
    if (overlay) overlay.style.display = 'none';
    await doBncLogout();
}

async function doBncLogout() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    await window.electronAPI.bncLogout();
    _bncAuth = null;
    // Reset UI
    document.getElementById('bncAvatarInitial').textContent = '?';
    document.getElementById('bncDropEmail').textContent = '';
    document.getElementById('bncDropPlan').textContent = '';
    const pill = document.getElementById('bncPlanPill');
    if (pill) pill.style.display = 'none';
    showBncLoginOverlay();
}

function toggleBncUserMenu() {
    const dd  = document.getElementById('bncUserDropdown');
    const btn = document.getElementById('bncAvatarBtn');
    if (!dd) return;
    if (dd.style.display !== 'none') { dd.style.display = 'none'; return; }

    // Tính vị trí fixed dựa trên avatar button
    const rect = btn.getBoundingClientRect();
    dd.style.top  = (rect.bottom + 6) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    dd.style.left = 'auto';
    dd.style.display = 'block';
}

function bncRenderUserInfo(auth) {
    if (!auth?.email) return;
    const initial = (auth.email[0] || '?').toUpperCase();
    const avatarInitialEl = document.getElementById('bncAvatarInitial');
    const dropAvatarEl = document.getElementById('bncDropAvatar');
    if (avatarInitialEl) avatarInitialEl.textContent = initial;
    if (dropAvatarEl) dropAvatarEl.textContent = initial;
    const emailEl = document.getElementById('bncDropEmail');
    if (emailEl) emailEl.textContent = auth.email;

    const slots = auth.slots;
    const planEl = document.getElementById('bncDropPlan');
    if (planEl) {
        if (slots && slots.totalGranted > 0) {
            planEl.textContent = `${slots.canRun ?? slots.available} / ${slots.totalGranted} slots`;
        } else {
            planEl.textContent = 'Chưa có slot';
        }
    }

    // "Thành Viên" sidebar — chỉ hiện khi đang ở workspace của chính mình và có slot
    const navTeam = document.getElementById('nav-team');
    if (navTeam) {
        const isOwner = !auth.activeWorkspace || auth.activeWorkspace === 'own';
        const hasSlots = auth.slots && auth.slots.totalGranted > 0;
        navTeam.style.display = (isOwner && hasSlots) ? '' : 'none';
    }

    // Plan pill bên cạnh avatar
    _updatePlanPill(auth);
}

function _updatePlanPill(auth) {
    const pill = document.getElementById('bncPlanPill');
    if (!pill) return;

    const slots = auth?.slots;

    const canRunVal   = slots?.canRun    ?? 0;
    const availableVal = slots?.available ?? 0;

    // Đồng bộ luôn dropdown text để pill và dropdown luôn nhất quán
    const planEl = document.getElementById('bncDropPlan');
    if (planEl) {
        planEl.textContent = (slots && canRunVal > 0)
            ? `${availableVal}/${canRunVal} slot trống`
            : 'Chưa có slot';
    }

    if (!slots || canRunVal === 0) {
        pill.style.display = 'none';
        return;
    }

    pill.textContent = `${availableVal}/${canRunVal} slot`;
    pill.title = `Còn trống ${availableVal} • Tối đa ${canRunVal} profile`;
    pill.style.display = 'block';

    // Màu cảnh báo dựa trên available/canRun
    const ratio = availableVal / canRunVal;
    if (availableVal === 0) {
        pill.style.background = 'rgba(239,68,68,0.15)';
        pill.style.color = '#ef4444';
        pill.style.borderColor = 'rgba(239,68,68,0.4)';
    } else if (ratio <= 0.3) {
        pill.style.background = 'rgba(245,158,11,0.15)';
        pill.style.color = '#f59e0b';
        pill.style.borderColor = 'rgba(245,158,11,0.4)';
    } else {
        pill.style.background = 'rgba(0,224,255,0.1)';
        pill.style.color = '#00e0ff';
        pill.style.borderColor = 'rgba(0,224,255,0.25)';
    }
}

async function bncLoadUserInfo() {
    try {
        const auth = await window.electronAPI.bncGetAuth();
        if (auth) {
            _bncAuth = auth;
            bncRenderUserInfo(auth);
            _renderWorkspaceSelector(auth.teams || []);
            // Auto-restore team workspace nếu lần trước đang ở team workspace
            if (auth.activeWorkspace && auth.activeWorkspace !== 'own') {
                await _switchWorkspace(auth.activeWorkspace);
            }
            await ensureBncTermsAccepted();
        }
    } catch (_) {}
}

// ── Workspace Selector ───────────────────────────────────────────────────────
function _renderWorkspaceSelector(teams) {
    const bar = document.getElementById('workspaceBar');
    if (!bar) return;

    if (!teams || teams.length === 0) {
        bar.style.display = 'none';
        _applyWorkspacePermissions(null);
        _renderSidebarWs([]);
        return;
    }

    // Populate team list in dropdown
    const list = document.getElementById('wsTeamList');
    if (list) {
        list.innerHTML = teams.map(t => `
            <div class="ws-item" data-ws="${t.ownerId}" onclick="_switchWorkspace(${t.ownerId})"
                style="padding:10px 14px;font-size:13px;color:#e0e0e0;cursor:pointer;display:flex;align-items:center;gap:9px;"
                onmouseover="this.style.background='rgba(255,255,255,0.06)'"
                onmouseout="this.style.background=window._activeWorkspace==${t.ownerId}?'rgba(0,224,255,0.06)':'transparent'">
                <span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;flex-shrink:0;"></span>
                <span>${t.ownerName || t.ownerEmail}</span>
            </div>`).join('');
    }

    const active = _bncAuth?.activeWorkspace || 'own';
    window._activeWorkspace = active;
    _updateWsCurrentDisplay(active, teams);
    bar.style.display = 'block';
    _renderSidebarWs(teams);
}

function _renderSidebarWs(teams) {
    const section = document.getElementById('sidebarWsSection');
    if (!section) return;
    if (!teams || teams.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    // Own workspace label
    const ownName = document.getElementById('sbWsOwnName');
    if (ownName) ownName.textContent = _bncAuth?.email || 'Workspace của tôi';
    // Team list
    const list = document.getElementById('sbWsTeamList');
    if (list) {
        list.innerHTML = teams.map(t => `
            <div id="sbWsTeam-${t.ownerId}" onclick="_switchWorkspace(${t.ownerId})" style="display:flex;align-items:center;gap:7px;padding:7px 8px;border-radius:7px;cursor:pointer;font-size:12px;color:#e0e0e0;" onmouseover="this.style.background='rgba(255,255,255,0.07)'" onmouseout="this.style.background=window._activeWorkspace==${t.ownerId}?'rgba(245,158,11,0.08)':'transparent'">
                <span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;flex-shrink:0;"></span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.ownerName || t.ownerEmail}</span>
                <span class="sbWsCheck" data-ws="${t.ownerId}" style="color:#f59e0b;font-size:12px;display:none;">✔</span>
            </div>`).join('');
    }
    _updateSidebarWsActive(window._activeWorkspace || 'own');
}

function _updateSidebarWsActive(activeWs) {
    // Own checkmark
    const ownCheck = document.getElementById('sbWsOwnCheck');
    const ownItem  = document.getElementById('sbWsOwn');
    if (ownCheck) ownCheck.style.display = activeWs === 'own' ? '' : 'none';
    if (ownItem)  ownItem.style.background = activeWs === 'own' ? 'rgba(0,224,255,0.08)' : 'transparent';
    // Team checkmarks
    document.querySelectorAll('.sbWsCheck').forEach(el => {
        el.style.display = el.dataset.ws == activeWs ? '' : 'none';
    });
    document.querySelectorAll('#sbWsTeamList > div').forEach(el => {
        const wsId = el.id?.replace('sbWsTeam-', '');
        el.style.background = wsId == activeWs ? 'rgba(245,158,11,0.08)' : 'transparent';
    });
}

function _updateWsCurrentDisplay(activeWs, teams) {
    const nameEl = document.getElementById('wsCurrentName');
    const dotEl  = document.getElementById('wsCurrentDot');
    const ownItem = document.getElementById('wsOwnItem');

    if (nameEl) {
        if (activeWs === 'own') {
            nameEl.textContent = _bncAuth?.email || 'Workspace của tôi';
        } else {
            const t = (teams || _bncAuth?.teams || []).find(t => t.ownerId == activeWs);
            nameEl.textContent = t?.ownerName || t?.ownerEmail || String(activeWs);
        }
    }
    if (dotEl) dotEl.style.background = activeWs === 'own' ? '#00e0ff' : '#f59e0b';

    if (ownItem) ownItem.style.background = activeWs === 'own' ? 'rgba(0,224,255,0.06)' : 'transparent';
    document.querySelectorAll('#wsTeamList .ws-item').forEach(el => {
        el.style.background = el.dataset.ws == activeWs ? 'rgba(0,224,255,0.06)' : 'transparent';
    });
    _updateSidebarWsActive(activeWs);
}

function toggleWsDropdown() {
    const menu = document.getElementById('wsDropdown');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

async function _switchWorkspace(ownerCustomerId) {
    const menu = document.getElementById('wsDropdown');
    if (menu) menu.style.display = 'none';
    const result = await window.electronAPI.switchWorkspace(ownerCustomerId);
    if (!result.success) { alert('Không thể chuyển workspace: ' + (result.error || 'Lỗi không xác định')); return; }

    if (_bncAuth) {
        _bncAuth.activeWorkspace = ownerCustomerId;
        _bncAuth.activePermissions = result.permissions || null;
        _bncAuth.activeOwnerInfo = result.ownerInfo || null;
    }

    window._activeWorkspace = ownerCustomerId;
    _updateWsCurrentDisplay(ownerCustomerId, _bncAuth?.teams || []);

    _applyWorkspacePermissions(ownerCustomerId === 'own' ? null : (_bncAuth?.activePermissions || null));

    await loadProfiles();
}

function _applyWorkspacePermissions(permissions) {
    // null = own workspace → full quyền
    const perm = permissions?.profile || null;
    const canCreate = !perm || perm.create !== false;

    // Nút "Thêm profile"
    const addBtn = document.getElementById('addProfileBtn');
    if (addBtn) addBtn.style.display = canCreate ? '' : 'none';

    // Các mục sidebar chỉ hiện ở own workspace
    const isOwn = permissions === null;
    const navTeam = document.getElementById('nav-team');
    if (navTeam) {
        const hasSlots = _bncAuth?.slots && _bncAuth.slots.totalGranted > 0;
        navTeam.style.display = (isOwn && hasSlots) ? '' : 'none';
    }
    // "Mua Gói" — luôn hiển thị ở mọi workspace
    const navPlans = document.getElementById('nav-plans');
    if (navPlans) navPlans.style.display = '';
    const dropPlans = document.getElementById('dropPlansItem');
    if (dropPlans) dropPlans.style.display = '';
    // "Đồng bộ Profile" — chỉ hiện ở own workspace (tránh upload nhầm profiles của người khác)
    const dropSync = document.getElementById('dropSyncItem');
    if (dropSync) dropSync.style.display = isOwn ? '' : 'none';

    // Lưu vào global để launch() và action menu kiểm tra
    window._activeWorkspacePerm = permissions;
}

// ── Team Members UI ──────────────────────────────────────────────────────────
let _teamMembers = [];

const _ALL_PAGES = ['profilesPage', 'teamPage', 'groupsPage', 'plansPage', 'notificationsPage', 'settingsPage', 'toolsPage', 'embeddedToolPage'];
function _switchPage(activePageId, activeNavId) {
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    document.getElementById(activeNavId)?.classList.add('active');
    _ALL_PAGES.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = (id === activePageId) ? 'flex' : 'none';
    });
    closeInvitePanel();
}

async function showTeamPage() {
    _switchPage('teamPage', 'nav-team');
    await refreshTeamMembers();
}

// ─── Notifications full-page ─────────────────────────────────────────────────
let _notifPage = 1;
const _NOTIF_PER_PAGE = 20;

async function showNotificationsPage() {
    _switchPage('notificationsPage', 'nav-notifications');
    _notifPage = 1;
    await _loadNotifPage();
}

async function _loadNotifPage() {
    const list  = document.getElementById('notifPageList');
    const pager = document.getElementById('notifPagePager');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;color:#555;padding:40px 0;">Đang tải...</div>';

    try {
        const data = await window.electronAPI.bncFetchNotificationsPage(_notifPage, _NOTIF_PER_PAGE);
        const notifs = data?.notifications || [];
        const total  = data?.total || 0;
        const totalPages = Math.max(1, Math.ceil(total / _NOTIF_PER_PAGE));

        if (notifs.length === 0) {
            list.innerHTML = '<div style="text-align:center;color:#555;padding:60px 0;font-size:14px;">Chưa có thông báo nào</div>';
            pager.innerHTML = '';
            return;
        }

        list.innerHTML = notifs.map(n => {
            const dt = new Date(n.createdAt).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
            const unread = !n.isRead;
            return `<div style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;border-radius:8px;margin-bottom:4px;${unread ? 'background:rgba(0,224,255,0.05);' : ''}"
                         onclick="_openNotifFromPage('${n.id}', this)">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    ${unread ? '<span style="width:7px;height:7px;border-radius:50%;background:#00e0ff;flex-shrink:0;display:inline-block;"></span>' : '<span style="width:7px;height:7px;flex-shrink:0;display:inline-block;"></span>'}
                    <span style="font-size:13px;font-weight:${unread ? '600' : '400'};color:${unread ? '#e0e0e0' : '#aaa'};">${n.title}</span>
                    <span style="font-size:11px;color:#555;margin-left:auto;white-space:nowrap;">${dt}</span>
                </div>
                <div style="font-size:12px;color:#888;line-height:1.6;padding-left:15px;">${n.body}</div>
            </div>`;
        }).join('');

        pager.innerHTML = `
            <button onclick="_notifPageGo(${_notifPage - 1})" ${_notifPage <= 1 ? 'disabled' : ''}
                style="padding:4px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#aaa;border-radius:6px;cursor:pointer;">‹ Trước</button>
            <span style="color:#666;">Trang ${_notifPage} / ${totalPages} &nbsp;(${total} thông báo)</span>
            <button onclick="_notifPageGo(${_notifPage + 1})" ${_notifPage >= totalPages ? 'disabled' : ''}
                style="padding:4px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#aaa;border-radius:6px;cursor:pointer;">Sau ›</button>`;
    } catch (_) {
        list.innerHTML = '<div style="text-align:center;color:#e05;padding:40px 0;">Lỗi tải thông báo</div>';
    }
}

async function _notifPageGo(page) {
    _notifPage = page;
    await _loadNotifPage();
    document.getElementById('notifPageList')?.scrollTo(0, 0);
}

function _openNotifFromPage(id, el) {
    // Đánh dấu đã đọc ngay trên UI
    const dot = el.querySelector('span[style*="background:#00e0ff"]');
    if (dot) {
        dot.style.background = 'transparent';
        el.style.background = '';
        const titleEl = el.querySelector('span:nth-child(2)');
        if (titleEl) { titleEl.style.fontWeight = '400'; titleEl.style.color = '#aaa'; }
        window.electronAPI.bncMarkNotificationsRead([Number(id)]).catch(() => {});
        // Sync vào _bncNotifications nếu có
        const n = _bncNotifications.find(x => String(x.id) === String(id));
        if (n) { n.isRead = true; _renderNotifBadge(); }
    }
}

function showProfilesPage() {
    _switchPage('profilesPage', 'nav-profiles');
}

function showGroupsPage() {
    _switchPage('groupsPage', 'nav-groups');
    renderGroupManagerList();
    document.getElementById('newGroupInput')?.focus();
}

// Fallback used only if the server is unreachable — keeps the Tools page from
// being completely empty offline. The real list normally comes from
// GET /api/bnc/tools (see bnc-get-tools in main.js), so adding/removing tools
// going forward is a server-side edit, no app update needed.
const _TOOLS_FALLBACK = [
    { id: 'yt-thumbnail', title: 'Lấy Thumbnail YouTube', icon: '🖼️', desc: 'Dán link video → lấy ảnh thumbnail full độ phân giải', type: 'native' },
    { id: '2fa', title: '2FA Generator', icon: '🔐', desc: 'Sinh mã xác thực 2 lớp', type: 'embed', url: 'https://phuc.vn/2fa/' },
];

function _renderToolsGrid(tools) {
    const grid = document.getElementById('toolsGrid');
    if (!grid) return;
    if (!tools || tools.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;color:#666;font-size:12px;">Không tải được danh sách công cụ.</div>';
        return;
    }
    grid.innerHTML = tools.map(tool => {
        const action = tool.type === 'native'
            ? (tool.id === 'yt-thumbnail' ? 'openYoutubeThumbModal()' : '')
            : `openEmbeddedTool('${tool.id}', '${(tool.url || '').replace(/'/g, "\\'")}', '${(tool.title || '').replace(/'/g, "\\'")}')`;
        return `
        <div onclick="${action}"
            style="background:rgba(0,0,0,0.2);border:1.5px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px 16px;display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:border-color .15s;-webkit-app-region:no-drag;"
            onmouseover="this.style.borderColor='rgba(0,224,255,0.4)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.08)'">
            <div style="font-size:28px;">${tool.icon || '🛠️'}</div>
            <div style="font-size:14px;font-weight:700;color:#fff;">${tool.title || ''}</div>
            <div style="font-size:11px;color:#888;">${tool.desc || ''}</div>
        </div>`;
    }).join('');
}

async function showToolsPage() {
    _switchPage('toolsPage', 'nav-tools');
    try {
        const tools = await window.electronAPI.bncGetTools();
        _renderToolsGrid(tools && tools.length > 0 ? tools : _TOOLS_FALLBACK);
    } catch (_) {
        _renderToolsGrid(_TOOLS_FALLBACK);
    }
}

async function showPlansPage() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    _switchPage('plansPage', 'nav-plans');
    // Load plans into grid
    const plans = await window.electronAPI.bncGetPlans();
    const grid = document.getElementById('bncPlansGrid');
    if (!grid) return;
    const fmt = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';
    grid.innerHTML = plans.map(p => `
        <div data-plan-id="${p.id}" data-plan-price="${p.price}" data-plan-name="${p.name}"
            style="background:rgba(0,0,0,0.2);border:1.5px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px 16px;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:border-color .15s;"
            onmouseover="this.style.borderColor='rgba(0,224,255,0.4)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.08)'">
            <div style="font-size:15px;font-weight:800;color:#fff;">${p.name}</div>
            <div>
                <span style="font-size:20px;font-weight:800;color:#fff;">${fmt(p.price)}</span>
                <span style="font-size:11px;color:#667;">/lần</span>
            </div>
            <div style="font-size:11px;color:#888;flex:1;">
                <div style="margin-bottom:4px;">✓ ${p.maxProfiles >= 9999 ? 'Không giới hạn hồ sơ' : p.maxProfiles + ' hồ sơ'}</div>
                <div style="margin-bottom:4px;">✓ ${p.maxDevices} thiết bị đăng nhập</div>
                <div>✓ Windows &amp; macOS</div>
            </div>
            <button data-btn="select-plan"
                style="padding:9px 0;border-radius:8px;border:none;background:linear-gradient(135deg,#00e0ff,#0055ff);color:#fff;font-size:13px;font-weight:700;cursor:pointer;width:100%;pointer-events:none;">
                Chọn gói
            </button>
        </div>`).join('');
    grid.onclick = (e) => {
        const card = e.target.closest('[data-plan-id]');
        if (!card) return;
        openPaymentModal(card.dataset.planId, Number(card.dataset.planPrice), card.dataset.planName);
    };
}

const _ROLE_DESCS = {
    admin:   'Toàn quyền: thêm thành viên, tạo/xóa/sửa hồ sơ và nhóm.',
    manager: 'Có thể tạo, sửa hồ sơ và nhóm. Không thể xóa hoặc thêm thành viên.',
    member:  'Không thể thêm thành viên và chỉ được xem hồ sơ của nhóm thành viên.',
};
const _ROLE_PERMS = {
    admin:   { profile: { launch:true, create:true, delete:true, editProxy:true, editFingerprint:true, editNote:true }, group: { create:true, edit:true, delete:true } },
    manager: { profile: { launch:true, create:true, delete:false, editProxy:true, editFingerprint:true, editNote:true }, group: { create:true, edit:true, delete:false } },
    member:  { profile: { launch:true, create:false, delete:false, editProxy:false, editFingerprint:false, editNote:false }, group: { create:false, edit:false, delete:false } },
};

let _inviteSelectedGroups   = [];
let _editSelectedGroups     = [];
let _inviteSelectedProfiles = [];
let _editSelectedProfiles   = [];

function _roleFromPerms(perm, gperm) {
    const p = perm || {};
    const g = gperm || {};
    if (p.create && p.delete && g.create && g.delete) return 'admin';
    if (p.create && !p.delete && g.create && !g.delete) return 'manager';
    return 'member';
}

function applyInviteRole(role) {
    document.getElementById('inviteRoleDesc').textContent = _ROLE_DESCS[role] || '';
}

function applyEditRole(role) {
    document.getElementById('editRoleDesc').textContent = _ROLE_DESCS[role] || '';
}

async function openInviteMemberModal() {
    _inviteSelectedGroups   = [];
    _inviteSelectedProfiles = [];
    document.getElementById('inviteEmail').value = '';
    document.getElementById('inviteProfileLimit').value = '';
    document.getElementById('inviteNote').value = '';
    document.querySelectorAll('input[name="inviteRole"]').forEach(r => { r.checked = r.value === 'member'; });
    applyInviteRole('member');
    _switchShareTab('invite', 'group');
    await Promise.all([
        _loadGroupsForDropdown('inviteGroupList', _inviteSelectedGroups, 'invite'),
        _loadProfilesForDropdown('inviteProfileList', _inviteSelectedProfiles, 'invite'),
    ]);
    _renderGroupTags('invite');
    _renderProfileTags('invite');
    document.getElementById('inviteMemberModal').style.display = 'flex';
    document.getElementById('inviteEmail')?.focus();
}

function closeInviteMemberModal() {
    document.getElementById('inviteMemberModal').style.display = 'none';
}

function openInvitePanel() { openInviteMemberModal(); }
function closeInvitePanel() { closeInviteMemberModal(); }

async function _loadGroupsForDropdown(listId, selectedArr, prefix) {
    const res = await window.electronAPI.getGroups();
    const groups = res || [];
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = groups.length === 0
        ? '<div style="font-size:12px;color:#999;padding:8px 10px;">Chưa có nhóm nào</div>'
        : groups.map(g => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:5px;cursor:pointer;font-size:13px;color:var(--text-primary);" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" value="${g.id}" data-name="${g.name.replace(/"/g,'&quot;')}" style="width:14px;height:14px;flex-shrink:0;margin:0;cursor:pointer;" onchange="_onGroupCheckChange('${prefix}',this)"
                    ${selectedArr.some(s => s.id === g.id) ? 'checked' : ''}>
                <span>${g.name}</span>
            </label>`).join('');
}

function _onGroupCheckChange(prefix, checkbox) {
    const arr = prefix === 'invite' ? _inviteSelectedGroups : _editSelectedGroups;
    if (checkbox.checked) {
        if (!arr.some(s => s.id == checkbox.value)) arr.push({ id: checkbox.value, name: checkbox.dataset.name });
    } else {
        const idx = arr.findIndex(s => s.id == checkbox.value);
        if (idx >= 0) arr.splice(idx, 1);
    }
    _renderGroupTags(prefix);
}

// ── Shared tag renderers ────────────────────────────────────────────────────
function _renderGroupTags(prefix) {
    const arr = prefix === 'invite' ? _inviteSelectedGroups : _editSelectedGroups;
    const tagsEl = document.getElementById(prefix === 'invite' ? 'inviteGroupTags' : 'editGroupTags');
    const labelEl = document.getElementById(prefix === 'invite' ? 'inviteGroupTagsLabel' : 'editGroupTagsLabel');
    if (!tagsEl) return;
    tagsEl.querySelectorAll('.group-tag').forEach(t => t.remove());
    if (labelEl) labelEl.textContent = arr.length === 0 ? 'Chưa chọn nhóm nào' : '';
    arr.forEach(g => {
        const tag = document.createElement('span');
        tag.className = 'group-tag';
        tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(0,224,255,0.12);color:#00e0ff;border-radius:12px;font-size:11px;';
        tag.innerHTML = `${g.name} <span style="cursor:pointer;opacity:.7;" onclick="_removeGroupTag('${prefix}','${g.id}')">✕</span>`;
        tagsEl.insertBefore(tag, labelEl || null);
    });
}

function _removeGroupTag(prefix, groupId) {
    const arr = prefix === 'invite' ? _inviteSelectedGroups : _editSelectedGroups;
    const idx = arr.findIndex(s => s.id == groupId);
    if (idx >= 0) arr.splice(idx, 1);
    _renderGroupTags(prefix);
    const list = document.getElementById(prefix === 'invite' ? 'inviteGroupList' : 'editGroupList');
    if (list) { const cb = list.querySelector(`input[value="${groupId}"]`); if (cb) cb.checked = false; }
}

function _renderProfileTags(prefix) {
    const arr = prefix === 'invite' ? _inviteSelectedProfiles : _editSelectedProfiles;
    const tagsEl = document.getElementById(prefix === 'invite' ? 'inviteProfileTags' : 'editProfileTags');
    const labelEl = document.getElementById(prefix === 'invite' ? 'inviteProfileTagsLabel' : 'editProfileTagsLabel');
    if (!tagsEl) return;
    tagsEl.querySelectorAll('.profile-tag').forEach(t => t.remove());
    if (labelEl) labelEl.textContent = arr.length === 0 ? 'Chưa chọn profile nào' : '';
    arr.forEach(p => {
        const tag = document.createElement('span');
        tag.className = 'profile-tag';
        tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(100,200,100,0.15);color:#4caf50;border-radius:12px;font-size:11px;';
        tag.innerHTML = `${p.name} <span style="cursor:pointer;opacity:.7;" onclick="_removeProfileTag('${prefix}','${p.id}')">✕</span>`;
        tagsEl.insertBefore(tag, labelEl || null);
    });
}

function _removeProfileTag(prefix, profileId) {
    const arr = prefix === 'invite' ? _inviteSelectedProfiles : _editSelectedProfiles;
    const idx = arr.findIndex(s => s.id === profileId);
    if (idx >= 0) arr.splice(idx, 1);
    _renderProfileTags(prefix);
    const list = document.getElementById(prefix === 'invite' ? 'inviteProfileList' : 'editProfileList');
    if (list) { const cb = list.querySelector(`input[value="${profileId}"]`); if (cb) cb.checked = false; }
}

// ── Tab switcher + search filter ────────────────────────────────────────────
function _switchShareTab(prefix, tab) {
    const isGroup = tab === 'group';
    const groupPanel   = document.getElementById(prefix === 'invite' ? 'inviteGroupPanel'   : 'editGroupPanel');
    const profilePanel = document.getElementById(prefix === 'invite' ? 'inviteProfilePanel' : 'editProfilePanel');
    const groupTags    = document.getElementById(prefix === 'invite' ? 'inviteGroupTags'    : 'editGroupTags');
    const profileTags  = document.getElementById(prefix === 'invite' ? 'inviteProfileTags'  : 'editProfileTags');
    const tabGroup     = document.getElementById(prefix === 'invite' ? 'inviteTabGroup'     : 'editTabGroup');
    const tabProfile   = document.getElementById(prefix === 'invite' ? 'inviteTabProfile'   : 'editTabProfile');
    if (groupPanel)   groupPanel.style.display   = isGroup ? '' : 'none';
    if (profilePanel) profilePanel.style.display = isGroup ? 'none' : '';
    if (groupTags)    groupTags.style.display     = isGroup ? 'flex' : 'none';
    if (profileTags)  profileTags.style.display   = isGroup ? 'none' : 'flex';
    const activeStyle   = `padding:5px 16px;font-size:12px;font-weight:600;border:none;cursor:pointer;background:var(--accent);color:var(--bg-color);`;
    const inactiveStyle = `padding:5px 16px;font-size:12px;font-weight:600;border:none;cursor:pointer;background:transparent;color:var(--text-secondary);`;
    if (tabGroup)   tabGroup.style.cssText   = isGroup ? activeStyle : inactiveStyle;
    if (tabProfile) tabProfile.style.cssText = isGroup ? inactiveStyle : activeStyle;
}

function _filterShareList(prefix, type, query) {
    const listId = prefix === 'invite'
        ? (type === 'group' ? 'inviteGroupList' : 'inviteProfileList')
        : (type === 'group' ? 'editGroupList'   : 'editProfileList');
    const list = document.getElementById(listId);
    if (!list) return;
    const q = query.toLowerCase();
    list.querySelectorAll('label').forEach(label => {
        const name = label.querySelector('span')?.textContent?.toLowerCase() || '';
        label.style.display = name.includes(q) ? '' : 'none';
    });
}

// ── Profile picker for invite / edit member ─────────────────────────────────
async function _loadProfilesForDropdown(listId, selectedArr, prefix) {
    const profiles = (await window.electronAPI.getProfiles()) || [];
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = profiles.length === 0
        ? '<div style="font-size:12px;color:#999;padding:8px 10px;">Chưa có profile nào</div>'
        : profiles.map(p => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:5px;cursor:pointer;font-size:13px;color:var(--text-primary);" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" value="${p.id}" data-name="${(p.name||p.id).replace(/"/g,'&quot;')}" style="width:14px;height:14px;flex-shrink:0;margin:0;cursor:pointer;" onchange="_onProfileCheckChange('${prefix}',this)"
                    ${selectedArr.some(s => s.id === p.id) ? 'checked' : ''}>
                <span>${p.name || p.id}</span>
            </label>`).join('');
}

function _onProfileCheckChange(prefix, checkbox) {
    const arr = prefix === 'invite' ? _inviteSelectedProfiles : _editSelectedProfiles;
    if (checkbox.checked) {
        if (!arr.some(s => s.id === checkbox.value)) arr.push({ id: checkbox.value, name: checkbox.dataset.name });
    } else {
        const idx = arr.findIndex(s => s.id === checkbox.value);
        if (idx >= 0) arr.splice(idx, 1);
    }
    _renderProfileTags(prefix);
}

async function openTeamModal() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    await showTeamPage();
}

function closeTeamModal() {
    showProfilesPage();
}

function closeEditMemberModal() {
    const modal = document.getElementById('editMemberModal');
    if (modal) modal.style.display = 'none';
    _editingMemberId = null;
}

async function refreshTeamMembers() {
    const res = await window.electronAPI.teamGetMembers();
    _teamMembers = res.members || [];
    renderTeamMemberList();
}

function renderTeamMemberList() {
    const tbody = document.getElementById('teamMemberList');
    if (!tbody) return;
    if (_teamMembers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#555;padding:40px;font-size:14px;">Chưa có thành viên nào</td></tr>';
        return;
    }
    tbody.innerHTML = _teamMembers.map(m => {
        const perm = m.permissions?.profile || {};
        const permTags = [
            perm.launch !== false ? '<span style="font-size:10px;padding:2px 7px;background:rgba(0,224,255,0.1);color:#00e0ff;border-radius:4px;white-space:nowrap;">Mở</span>' : '',
            perm.create ? '<span style="font-size:10px;padding:2px 7px;background:rgba(167,139,250,0.1);color:#a78bfa;border-radius:4px;white-space:nowrap;">Tạo</span>' : '',
            perm.delete ? '<span style="font-size:10px;padding:2px 7px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:4px;white-space:nowrap;">Xóa</span>' : '',
            perm.editProxy ? '<span style="font-size:10px;padding:2px 7px;background:rgba(245,158,11,0.1);color:#f59e0b;border-radius:4px;white-space:nowrap;">Proxy</span>' : '',
            perm.editFingerprint ? '<span style="font-size:10px;padding:2px 7px;background:rgba(16,185,129,0.1);color:#10b981;border-radius:4px;white-space:nowrap;">FP</span>' : '',
            perm.editNote ? '<span style="font-size:10px;padding:2px 7px;background:rgba(99,102,241,0.1);color:#6366f1;border-radius:4px;white-space:nowrap;">Note</span>' : '',
        ].filter(Boolean).join(' ');
        const statusBadge = m.status === 'pending'
            ? '<span style="font-size:11px;padding:2px 8px;background:rgba(245,158,11,0.1);color:#f59e0b;border-radius:10px;white-space:nowrap;">⏳ Chờ</span>'
            : '<span style="font-size:11px;padding:2px 8px;background:rgba(16,185,129,0.1);color:#10b981;border-radius:10px;white-space:nowrap;">✅ Hoạt động</span>';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
            <td style="padding:12px 12px;font-size:13px;color:#e0e0e0;">${m.memberName || '—'}</td>
            <td style="padding:12px 12px;font-size:13px;color:#aaa;">${m.memberEmail}</td>
            <td style="padding:12px 12px;">${statusBadge}</td>
            <td style="padding:12px 12px;"><div style="display:flex;gap:4px;flex-wrap:wrap;">${permTags || '<span style="color:#555;font-size:12px;">—</span>'}</div></td>
            <td style="padding:12px 12px;font-size:12px;color:#666;">${m.note || '—'}</td>
            <td style="padding:12px 12px;text-align:right;white-space:nowrap;">
                <button onclick="openEditMemberModal(${m.id})" style="background:#3a3f4b;border:1px solid #555;color:#e0e0e0;padding:5px 14px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:500;margin-right:6px;">SỬA</button>
                <button onclick="removeTeamMember(${m.id})" style="background:#4a1515;border:1px solid #c0392b;color:#ff6b6b;padding:5px 14px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:500;">XÓA</button>
            </td>
        </tr>`;
    }).join('');
}

function openInviteMemberForm() {
    const form = document.getElementById('inviteMemberForm');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function submitInviteMember() {
    const email = document.getElementById('inviteEmail')?.value?.trim();
    if (!email) { alert('Nhập email thành viên'); return; }

    const role = document.querySelector('input[name="inviteRole"]:checked')?.value || 'member';
    const permissions = _ROLE_PERMS[role] || _ROLE_PERMS.member;
    const profileLimit = parseInt(document.getElementById('inviteProfileLimit')?.value) || null;
    const allowedGroups   = _inviteSelectedGroups.length   > 0 ? _inviteSelectedGroups.map(g => g.id)   : null;
    const allowedProfiles = _inviteSelectedProfiles.length > 0 ? _inviteSelectedProfiles.map(p => p.id) : null;
    const note = document.getElementById('inviteNote')?.value?.trim() || null;

    const result = await window.electronAPI.teamInvite({ email, permissions, allowedGroups, allowedProfiles, profileLimit, note });
    if (result.success) {
        closeInviteMemberModal();
        await refreshTeamMembers();
    } else {
        alert(result.error || 'Lỗi mời thành viên');
    }
}

async function removeTeamMember(memberId) {
    if (!confirm('Xóa thành viên này khỏi nhóm?')) return;
    const result = await window.electronAPI.teamRemoveMember(memberId);
    if (result.success) await refreshTeamMembers();
    else alert(result.error || 'Lỗi xóa thành viên');
}

let _editingMemberId = null;
async function openEditMemberModal(memberId) {
    const member = _teamMembers.find(m => m.id === memberId);
    if (!member) return;
    _editingMemberId = memberId;
    const modal = document.getElementById('editMemberModal');
    if (!modal) return;

    document.getElementById('editMemberName').value = member.memberName || '';
    document.getElementById('editMemberEmail').value = member.memberEmail || '';

    const perm = member.permissions?.profile || {};
    const gperm = member.permissions?.group || {};
    const detectedRole = _roleFromPerms(perm, gperm);
    document.querySelectorAll('input[name="editRole"]').forEach(r => { r.checked = r.value === detectedRole; });
    applyEditRole(detectedRole);

    // Resolve group names from local cache
    const allLocalGroups = (await window.electronAPI.getGroups()) || [];
    const groupNameMap = Object.fromEntries(allLocalGroups.map(g => [g.id, g.name]));
    _editSelectedGroups = member.allowedGroups
        ? member.allowedGroups.map(id => ({ id, name: groupNameMap[id] || id }))
        : [];

    // Resolve profile names from local cache
    const allLocalProfiles = (await window.electronAPI.getProfiles()) || [];
    const profileNameMap = Object.fromEntries(allLocalProfiles.map(p => [p.id, p.name || p.id]));
    _editSelectedProfiles = member.allowedProfiles
        ? member.allowedProfiles.map(id => ({ id, name: profileNameMap[id] || id }))
        : [];

    _switchShareTab('edit', 'group');
    await Promise.all([
        _loadGroupsForDropdown('editGroupList', _editSelectedGroups, 'edit'),
        _loadProfilesForDropdown('editProfileList', _editSelectedProfiles, 'edit'),
    ]);
    _renderGroupTags('edit');
    _renderProfileTags('edit');

    document.getElementById('editProfileLimit').value = member.profileLimit || '';
    document.getElementById('editNote').value = member.note || '';
    modal.style.display = 'flex';
}

async function submitEditMember() {
    if (!_editingMemberId) return;
    const role = document.querySelector('input[name="editRole"]:checked')?.value || 'member';
    const permissions = _ROLE_PERMS[role] || _ROLE_PERMS.member;
    const profileLimit = parseInt(document.getElementById('editProfileLimit')?.value) || null;
    const allowedGroups   = _editSelectedGroups.length   > 0 ? _editSelectedGroups.map(g => g.id)   : null;
    const allowedProfiles = _editSelectedProfiles.length > 0 ? _editSelectedProfiles.map(p => p.id) : null;
    const note = document.getElementById('editNote')?.value?.trim() || null;

    const result = await window.electronAPI.teamUpdateMember({ memberId: _editingMemberId, permissions, allowedGroups, allowedProfiles, profileLimit, note });
    if (result.success) {
        closeEditMemberModal();
        await refreshTeamMembers();
    } else {
        alert(result.error || 'Lỗi cập nhật thành viên');
    }
}

// ── Plans Modal ──────────────────────────────────────────────────────────────
async function openPlansModal() {
    await showPlansPage();
}

function closePlansModal() {
    showProfilesPage();
}

// ── Payment Modal ─────────────────────────────────────────────────────────────
async function openPaymentModal(planId, price, planName) {
    console.log('[BNC] openPaymentModal called:', planId, price, planName);
    const paymentModal = document.getElementById('bncPaymentModal');
    const content      = document.getElementById('bncPaymentContent');

    // Hide plans page while payment modal is open
    document.getElementById('plansPage').style.display = 'none';
    paymentModal.style.display = 'flex';
    content.innerHTML = '<div style="color:#aaa;padding:20px 0;">Đang tải thông tin...</div>';

    // Bắt đầu poll ngay khi modal mở — không chờ user đóng
    startPaymentPoll();

    try {
        const info = await window.electronAPI.bncGetPaymentInfo();
        const fmt  = (n) => new Intl.NumberFormat('vi-VN').format(n);
        // Ưu tiên SePay nếu server trả về — chỉ version mới hiểu field này
        const activeBank = info.sepay || info;
        const qrUrl = `https://img.vietqr.io/image/${activeBank.bankAcqId}-${activeBank.bankAccountNo}-compact2.png?amount=${price}&addInfo=${encodeURIComponent(activeBank.transferContent)}&accountName=${encodeURIComponent(activeBank.bankAccountName)}`;

        const deviceInfo = info.deviceAddOn || {};
        const deviceQrUrl = deviceInfo.transferContent
            ? `https://img.vietqr.io/image/${activeBank.bankAcqId}-${activeBank.bankAccountNo}-compact2.png?amount=${deviceInfo.pricePerDevice}&addInfo=${encodeURIComponent(deviceInfo.transferContent)}&accountName=${encodeURIComponent(activeBank.bankAccountName)}`
            : null;
        const bankName = activeBank.bankAcqId === '970422' ? 'MB Bank' : 'Vietinbank';
        const ls = info.lemonSqueezy || {};
        const stripeInfo = (info.stripe?.available) ? info.stripe : null;

        content.innerHTML = `
            <div style="margin-bottom:14px;">
                <div style="font-size:13px;color:#aaa;margin-bottom:4px;">Gói đã chọn</div>
                <div style="font-size:18px;font-weight:700;color:#00e0ff;">${planName} — ${fmt(price)}đ</div>
            </div>
            <img src="${qrUrl}" alt="QR" style="width:200px;height:200px;border-radius:10px;margin-bottom:14px;background:#fff;" onerror="this.style.display='none'">
            <div style="background:rgba(0,0,0,0.3);border-radius:8px;padding:14px;text-align:left;font-size:13px;line-height:1.8;color:#ccc;margin-bottom:4px;">
                <div><span style="color:#888;">Ngân hàng:</span> <strong style="color:#fff;">${bankName}</strong></div>
                <div><span style="color:#888;">Số TK:</span> <strong style="color:#00e0ff;">${activeBank.bankAccountNo}</strong></div>
                <div><span style="color:#888;">Chủ TK:</span> <strong style="color:#fff;">${activeBank.bankAccountName}</strong></div>
                <div><span style="color:#888;">Số tiền:</span> <strong style="color:#fff;">${fmt(price)}đ</strong></div>
                <div><span style="color:#888;">Nội dung:</span> <strong style="color:#ff9800;font-family:monospace;font-size:14px;">${activeBank.transferContent}</strong></div>
            </div>
            <div style="font-size:11px;color:#666;margin-top:10px;">Hệ thống tự động gia hạn sau khi nhận được chuyển khoản (thường trong vài phút)</div>
            ${deviceQrUrl ? `
            <div style="margin-top:18px;border-top:1px solid rgba(255,255,255,0.07);padding-top:16px;">
                <div style="font-size:13px;font-weight:600;color:#e0e0e0;margin-bottom:10px;">➕ Thêm thiết bị (+${fmt(deviceInfo.pricePerDevice)}đ/máy)</div>
                <img src="${deviceQrUrl}" alt="QR thiết bị" style="width:160px;height:160px;border-radius:10px;margin-bottom:10px;background:#fff;" onerror="this.style.display='none'">
                <div style="background:rgba(0,0,0,0.3);border-radius:8px;padding:10px 14px;text-align:left;font-size:12px;line-height:1.8;color:#ccc;">
                    <div><span style="color:#888;">Số tiền:</span> <strong style="color:#fff;">${fmt(deviceInfo.pricePerDevice)}đ</strong></div>
                    <div><span style="color:#888;">Nội dung:</span> <strong style="color:#ff9800;font-family:monospace;">${deviceInfo.transferContent}</strong></div>
                    <div style="margin-top:4px;font-size:11px;color:#555;">${deviceInfo.note || 'D2 = +2 thiết bị, v.v.'}</div>
                </div>
            </div>` : ''}
            ${(ls.monthly?.url || ls.annual?.url || stripeInfo) ? `
            <div style="margin-top:18px;border-top:1px solid rgba(255,255,255,0.07);padding-top:16px;">
                <div style="font-size:13px;font-weight:600;color:#e0e0e0;margin-bottom:10px;">🌍 Hoặc thanh toán quốc tế (thẻ/PayPal)</div>
                <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
                    ${ls.monthly?.url ? `<button data-ls-plan="monthly" style="padding:8px 16px;border-radius:8px;border:1px solid #00e0ff;background:rgba(0,224,255,0.1);color:#00e0ff;font-size:13px;cursor:pointer;">$${ls.monthly.price}/tháng (LS)</button>` : ''}
                    ${ls.annual?.url ? `<button data-ls-plan="annual" style="padding:8px 16px;border-radius:8px;border:1px solid #00e0ff;background:rgba(0,224,255,0.1);color:#00e0ff;font-size:13px;cursor:pointer;">$${ls.annual.price}/năm (LS)</button>` : ''}
                    ${stripeInfo?.monthly ? `<button data-stripe-plan="monthly" style="padding:8px 16px;border-radius:8px;border:1px solid #7c5cff;background:rgba(124,92,255,0.1);color:#b09cff;font-size:13px;cursor:pointer;">$${stripeInfo.monthly.price}/tháng (Stripe)</button>` : ''}
                    ${stripeInfo?.annual ? `<button data-stripe-plan="annual" style="padding:8px 16px;border-radius:8px;border:1px solid #7c5cff;background:rgba(124,92,255,0.1);color:#b09cff;font-size:13px;cursor:pointer;">$${stripeInfo.annual.price}/năm (Stripe)</button>` : ''}
                </div>
                <div style="font-size:11px;color:#666;margin-top:8px;">Mở trình duyệt để thanh toán an toàn — hệ thống tự động kích hoạt sau khi xác nhận</div>
            </div>` : ''}
            <button onclick="closePaymentModal(true)" style="margin-top:14px;padding:8px 20px;border-radius:8px;border:1px solid #444;background:transparent;color:#aaa;font-size:13px;cursor:pointer;">← Quay lại</button>
        `;

        // Mở trình duyệt hệ thống (không nhúng webview trong app) khi bấm nút quốc tế
        content.querySelectorAll('[data-ls-plan]').forEach(btn => {
            const url = ls[btn.dataset.lsPlan]?.url;
            if (url) btn.addEventListener('click', () => window.electronAPI.invoke('open-url', url));
        });
        content.querySelectorAll('[data-stripe-plan]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Đang tạo link...';
                try {
                    const result = await window.electronAPI.bncStripeCreateCheckout(btn.dataset.stripePlan);
                    if (result?.url) {
                        window.electronAPI.invoke('open-url', result.url);
                        startPaymentPoll();
                    } else {
                        showBncToast('❌ ' + (result?.error || 'Không tạo được link thanh toán'), 4000);
                        btn.disabled = false;
                        btn.textContent = btn.dataset.stripePlan === 'annual' ? `$${stripeInfo.annual.price}/năm (Stripe)` : `$${stripeInfo.monthly.price}/tháng (Stripe)`;
                    }
                } catch (_) {
                    btn.disabled = false;
                }
            });
        });
    } catch (e) {
        content.innerHTML = `<div style="color:#f44336;padding:20px 0;">Lỗi tải thông tin thanh toán.<br><button onclick="closePaymentModal(true)" style="margin-top:12px;padding:8px 20px;border-radius:8px;border:1px solid #444;background:transparent;color:#aaa;font-size:13px;cursor:pointer;">← Quay lại</button></div>`;
    }
}

function closePaymentModal(backToPlans) {
    document.getElementById('bncPaymentModal').style.display = 'none';
    // Poll đã chạy từ lúc openPaymentModal — không start lại ở đây
    if (backToPlans) showPlansPage(); else showProfilesPage();
}

// Poll server sau khi thanh toán — tối đa 5 phút, mỗi 5 giây
// Phát hiện thanh toán bằng: totalGranted tăng HOẶC canRun lên 9999 HOẶC có sub mới
let _paymentPollTimer = null;
function startPaymentPoll() {
    const knownGranted = _bncAuth?.slots?.totalGranted || 0;
    const knownCanRun  = _bncAuth?.slots?.canRun ?? 0;
    const pollStartMs  = Date.now();
    let attempts = 0;
    const MAX = 60; // 60 × 5s = 5 phút

    // Hiện toast báo đang chờ
    showBncToast('⏳ Đang chờ xác nhận thanh toán...', 0);

    _paymentPollTimer && clearInterval(_paymentPollTimer);
    _paymentPollTimer = setInterval(async () => {
        attempts++;
        try {
            const result = await window.electronAPI.bncGetSubscriptions();
            const slots = result.slots || null;
            const hasNewSub  = (result.latestSubMs || 0) > pollStartMs;
            const justGotSub = slots && (slots.canRun >= 9999) && (knownCanRun < 9999);
            if (slots && (slots.totalGranted > knownGranted || hasNewSub || justGotSub)) {
                clearInterval(_paymentPollTimer);
                _paymentPollTimer = null;

                // Tự đóng payment modal và quay lại plans page
                const paymentModal = document.getElementById('bncPaymentModal');
                if (paymentModal) paymentModal.style.display = 'none';
                showPlansPage();

                const added = slots.totalGranted - knownGranted;
                if (_bncAuth) {
                    _bncAuth.slots = slots;
                    bncRenderUserInfo(_bncAuth);
                }

                showBncToast(`✅ Nạp thành công! +${added} slots mới. Còn: ${slots.canRun ?? slots.available} slots.`, 5000);
                // BUG #6 FIX: sync profiles ngay để recompute isLocked với available mới
                window.electronAPI.bncSyncProfiles().then(() => loadProfiles()).catch(() => {});
                return;
            }
        } catch (_) {}

        if (attempts >= MAX) {
            clearInterval(_paymentPollTimer);
            _paymentPollTimer = null;
            showBncToast('⚠ Không nhận được xác nhận. Kiểm tra lại sau vài phút.', 6000);
        }
    }, 5000);
}

// Toast notification nhỏ góc dưới phải
function showBncToast(msg, duration = 4000) {
    let toast = document.getElementById('bncToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'bncToast';
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;background:#1e2535;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px 18px;font-size:13px;color:#e0e0e0;box-shadow:0 4px 20px rgba(0,0,0,0.5);max-width:320px;line-height:1.5;transition:opacity .3s;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.display = 'block';

    if (toast._hideTimer) clearTimeout(toast._hideTimer);
    if (duration > 0) {
        toast._hideTimer = setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => { toast.style.display = 'none'; }, 300);
        }, duration);
    }
}

async function syncBncProfiles() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    showBncToast('🔄 Đang đồng bộ profile...', 0);
    try {
        const result = await window.electronAPI.bncSyncProfiles();
        console.log('[SYNC_RESULT]', JSON.stringify(result, null, 2));
        if (!result.success) {
            showBncToast(`❌ Lỗi đồng bộ: ${result.error}`, 6000);
            return;
        }
        if (result.direction === 'download') {
            showBncToast(`✅ Tải về ${result.count} profiles từ server`, 4000);
        } else if (result.direction === 'upload') {
            showBncToast(`✅ Đã upload ${result.count} profiles lên server`, 4000);
        } else {
            showBncToast('⚠ Không có profile nào (cả local lẫn server)', 4000);
        }
        if (typeof loadProfiles === 'function') await loadProfiles();

        // Refresh slots từ server sau sync để pill luôn đúng
        try {
            const slotResult = await window.electronAPI.bncGetSubscriptions();
            if (slotResult?.slots && _bncAuth) {
                _bncAuth.slots = slotResult.slots;
                _updatePlanPill(_bncAuth);
            }
        } catch (_) {}
    } catch (e) {
        showBncToast(`❌ ${e.message}`, 5000);
    }
}

function openBncPaymentHistory() {
    document.getElementById('bncUserDropdown').style.display = 'none';
    window.electronAPI.invoke('open-url', 'https://yttool.vn/tai-khoan/giao-dich');
}

// Platform class cho body (Windows titlebar fix) — dùng navigator.platform, không cần IPC
try {
    const ua = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    if (ua.includes('win')) document.body.classList.add('platform-win32');
} catch (_) {}

// Khởi động BNC UI
bncInit();

// Electron Mac: body có -webkit-app-region:drag nên wheel event bị OS capture.
// Gắn wheel listener thủ công để bncNotifList scroll được bất kể drag region.
(function attachNotifScrollFix() {
    function _attachWheel(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('wheel', (e) => {
            e.stopPropagation();
            el.scrollTop += e.deltaY;
        }, { passive: true });
    }
    function _attach() {
        _attachWheel('bncNotifList');   // dropdown panel
        _attachWheel('notifPageList');  // full notifications page
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _attach);
    } else {
        _attach();
    }
})();

// ════════════════════════════════════════════════════════════════════════════

// Ẩn tabs dev-only khi chạy bản release (app.isPackaged = true)
async function initSettingsTabs() {
    try {
        const packaged = await window.electronAPI.isPackaged();
        if (packaged) {
            document.querySelectorAll('.dev-only').forEach(el => el.style.display = 'none');
            // Set active tab về license
            document.getElementById('licenseTabBtn')?.classList.add('active');
        }
    } catch (_) {}
}
initSettingsTabs();

let globalSettings = { preProxies: [], subscriptions: [], mode: 'single', enablePreProxy: false };
let currentEditId = null;
let confirmCallback = null;
let currentProxyGroup = 'manual';
let inputCallback = null;
let searchText = '';
let viewMode = localStorage.getItem('geekez_view') || 'list';
let allGroups = [];          // profile groups cache
let currentGroupFilter = ''; // '' = all, groupId = filter by group
let assignGroupProfileId = null; // profile being moved to group
let _selectedProfileIds = new Set();

// Custom City Dropdown Initialization (Matches Timezone Logic)
function initCustomCityDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    if (!input || !dropdown) return;

    // Build cached list
    let allOptions = [];
    // 1. Add English "Auto" option
    allOptions.push({ name: "Auto (IP Based)", isAuto: true });
    // 2. Add cities
    if (window.CITY_DATA) {
        allOptions = allOptions.concat(window.CITY_DATA);
    }

    let selectedIndex = -1;

    function populateDropdown(filter = '') {
        const lowerFilter = filter.toLowerCase();
        // 如果是 "Auto" 则显示全部，否则按关键词过滤
        const shouldShowAll = filter === 'Auto (IP Based)' || filter === '';

        const filtered = shouldShowAll ? allOptions : allOptions.filter(item =>
            item.name.toLowerCase().includes(lowerFilter)
        );

        dropdown.innerHTML = filtered.map((item, index) =>
            `<div class="timezone-item" data-name="${item.name}" data-index="${index}">${item.name}</div>`
        ).join('');

        selectedIndex = -1;
    }

    function showDropdown() {
        populateDropdown(''); // Always show full list on click
        dropdown.classList.add('active');
    }

    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    function selectItem(name) {
        input.value = name;
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);

    // Prevent blur from closing immediately so click can register
    // Relaxed for click-outside logic instead

    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) dropdown.classList.add('active');
    });

    // Keyboard nav
    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].dataset.name);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    function updateSelection(items) {
        items.forEach((item, index) => item.classList.toggle('selected', index === selectedIndex));
        if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) selectItem(item.dataset.name);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}

// --- Language Dropdown Helpers ---
function getLanguageName(code) {
    if (!code || code === 'auto') return "Auto (System Default)";
    if (!window.LANGUAGE_DATA) return code;
    const entry = window.LANGUAGE_DATA.find(x => x.code === code);
    return entry ? entry.name : "Auto (System Default)";
}

function getLanguageCode(name) {
    if (!name || name === "Auto (System Default)") return 'auto';
    if (!window.LANGUAGE_DATA) return 'auto';
    const entry = window.LANGUAGE_DATA.find(x => x.name === name);
    return entry ? entry.code : 'auto';
}

function initCustomLanguageDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    // Use window.LANGUAGE_DATA from languages.js
    const allOptions = window.LANGUAGE_DATA || [];
    let selectedIndex = -1;

    function populateDropdown(filter = '') {
        const lowerFilter = filter.toLowerCase();
        const shouldShowAll = filter === '' || filter === 'Auto (System Default)';
        const filtered = shouldShowAll ? allOptions : allOptions.filter(item =>
            item.name.toLowerCase().includes(lowerFilter)
        );

        dropdown.innerHTML = filtered.map((item, index) =>
            `<div class="timezone-item" data-code="${item.code}" data-index="${index}">${item.name}</div>`
        ).join('');
        selectedIndex = -1;
    }

    function showDropdown() {
        populateDropdown('');
        dropdown.classList.add('active');
    }

    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    function selectItem(name) {
        input.value = name;
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) dropdown.classList.add('active');
    });

    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].innerText);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    function updateSelection(items) {
        items.forEach((item, index) => item.classList.toggle('selected', index === selectedIndex));
        if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) selectItem(item.innerText);
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}


function decodeBase64Content(str) {
    try {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    } catch (e) { return atob(str); }
}

function getProxyRemark(link) {
    if (!link) return '';
    link = link.trim();
    try {
        if (link.startsWith('vmess://')) {
            const base64Str = link.replace('vmess://', '');
            const configStr = decodeBase64Content(base64Str);
            try { return JSON.parse(configStr).ps || ''; } catch (e) { return ''; }
        } else if (link.includes('#')) {
            return decodeURIComponent(link.split('#')[1]).trim();
        }
    } catch (e) { }
    return '';
}

function renderHelpContent() {
    const manualHTML = curLang === 'vi' ?
        `<div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">1. Tạo Profile</h4><p style="font-size:14px;">Nhập tên và proxy. Hệ thống tự động tạo dấu tay duy nhất với phần cứng ngẫu nhiên.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">2. Khởi động</h4><p style="font-size:14px;">Nhấn Khởi động. Nhãn xanh xuất hiện khi đang chạy. Mỗi profile hoàn toàn cô lập.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">3. Proxy trước (Tùy chọn)</h4><p style="font-size:14px;">Proxy chuỗi để ẩn IP thật. Dùng TCP để ổn định.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">4. Lưu ý thực hành</h4><p style="font-size:14px;">• Dùng IP dân cư chất lượng cao<br>• Một tài khoản/một profile<br>• Tránh chuyển đổi thường xuyên<br>• Mô phỏng hành vi người dùng thật</p></div>` :
        curLang === 'en' ?
        `<div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">1. Create Environment</h4><p style="font-size:14px;">Enter a name and proxy link. The system auto-generates a unique fingerprint with randomized Hardware.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">2. Launch</h4><p style="font-size:14px;">Click Launch. A green badge indicates active status. Each environment is fully isolated.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">3. Pre-Proxy (Optional)</h4><p style="font-size:14px;">Chain proxy for IP hiding. Use TCP protocols for stability.</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">4. Best Practices</h4><p style="font-size:14px;">• Use high-quality residential IPs<br>• Keep one account per environment<br>• Avoid frequent switching<br>• Simulate real user behavior</p></div>` :
        `<div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">1. 新建环境</h4><p style="font-size:14px;">填写名称与代理链接。系统自动生成唯一指纹（硬件随机化）。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">2. 启动环境</h4><p style="font-size:14px;">点击启动，列表中显示绿色运行标签。每个环境完全隔离。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">3. 前置代理（可选）</h4><p style="font-size:14px;">用于隐藏本机IP或链路加速。建议使用TCP协议。</p></div>
         <div style="margin-bottom:25px;"><h4 style="color:var(--accent);margin-bottom:8px;">4. 最佳实践</h4><p style="font-size:14px;">• 使用高质量住宅IP<br>• 一个账号固定一个环境<br>• 避免频繁切换<br>• 模拟真实用户行为</p></div>`;

    const _aboutCoreTech = (t1, t2, t3, t4, s1, s2, s3, s4, d1, d2, d3, d4) =>
        `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;">
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">${t1}</div>
                <div style="font-size:11px;opacity:0.7;">${d1}</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">${t2}</div>
                <div style="font-size:11px;opacity:0.7;">${d2}</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">${t3}</div>
                <div style="font-size:11px;opacity:0.7;">${d3}</div>
            </div>
            <div style="background:var(--input-bg);padding:12px;border-radius:8px;border:1px solid var(--border);">
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;">${t4}</div>
                <div style="font-size:11px;opacity:0.7;">${d4}</div>
            </div>
         </div>`;

    const _aboutDetection = (items) =>
        `<div style="background:var(--input-bg);padding:14px;border-radius:8px;border:1px solid var(--border);margin-bottom:24px;">
            <div style="display:flex;flex-wrap:wrap;gap:16px;">
                ${items.map(i => `<div style="font-size:12px;"><span style="color:#4CAF50;">✓</span> ${i}</div>`).join('')}
            </div>
         </div>`;

    const _aboutPlatforms = (items) =>
        `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;">
            ${items.map(([label, color]) => `<span style="background:linear-gradient(135deg,${color}33,${color}1a);color:${color};padding:6px 12px;border-radius:20px;font-size:11px;font-weight:500;">${label}</span>`).join('')}
         </div>`;

    const _sectionHeader = (gradient, title) =>
        `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:4px;height:18px;background:linear-gradient(180deg,${gradient});border-radius:2px;"></div>
            <h4 style="margin:0;color:var(--text-primary);font-size:14px;font-weight:600;">${title}</h4>
         </div>`;

    const _platforms = [
        ['Amazon','#f39c12'],['TikTok','#27ae60'],['Facebook','#2980b9'],
        ['Shopee','#e67e22'],['Lazada','#bf0000'],['Mercado','#f1c40f']
    ];

    const aboutHTML = curLang === 'vi' ?
        `<div style="text-align:center;margin-bottom:24px;padding:20px 0;">
            <div style="font-size:28px;font-weight:700;color:var(--text-primary);letter-spacing:1px;"><span style="color:var(--accent);">Anti-Detect</span> Browser</div>
            <div style="font-size:12px;opacity:0.5;margin-top:4px;">v1.4.0 · Trình duyệt chống phát hiện</div>
         </div>
         ${_sectionHeader('var(--accent), #7c3aed', 'CÔNG NGHỆ CỐT LÕI')}
         ${_aboutCoreTech('🧬 Nhân Chrome thật','🔐 Dấu tay phần cứng','🌍 60+ ngôn ngữ','⚡ Tăng tốc GPU',
             '','','','','Nhân Chrome gốc + JS Injection','Ngẫu nhiên hóa CPU/RAM','Giả lập múi giờ & ngôn ngữ','Hiệu năng UI mượt mà')}
         ${_sectionHeader('#4CAF50, #2196F3', 'TRẠNG THÁI PHÁT HIỆN')}
         ${_aboutDetection(['Browserscan: Sạch','Pixelscan: Sạch','TLS Fingerprint thật','API Hook tối thiểu'])}
         ${_sectionHeader('#FF9800, #F44336', 'TƯƠNG THÍCH NỀN TẢNG')}
         ${_aboutPlatforms(_platforms)}` :
        curLang === 'en' ?
        `<div style="text-align:center;margin-bottom:24px;padding:20px 0;">
            <div style="font-size:28px;font-weight:700;color:var(--text-primary);letter-spacing:1px;"><span style="color:var(--accent);">Anti-Detect</span> Browser</div>
            <div style="font-size:12px;opacity:0.5;margin-top:4px;">v1.4.0 · Anti-detect Browser</div>
         </div>
         ${_sectionHeader('var(--accent), #7c3aed', 'CORE TECHNOLOGY')}
         ${_aboutCoreTech('🧬 Real Chrome Kernel','🔐 Hardware Fingerprint','🌍 60+ Languages','⚡ GPU Acceleration',
             '','','','','Native Chrome + JS Injection','CPU/Memory Randomization','Timezone & Locale Spoofing','Smooth UI Performance')}
         ${_sectionHeader('#4CAF50, #2196F3', 'DETECTION STATUS')}
         ${_aboutDetection(['Browserscan Passed','Pixelscan Clean','Real TLS Fingerprint','Minimal API Hook'])}
         ${_sectionHeader('#FF9800, #F44336', 'PLATFORM COMPATIBILITY')}
         ${_aboutPlatforms(_platforms)}` :
        `<div style="text-align:center;margin-bottom:24px;padding:20px 0;">
            <div style="font-size:28px;font-weight:700;color:var(--text-primary);letter-spacing:1px;"><span style="color:var(--accent);">Anti-Detect</span> Browser</div>
            <div style="font-size:12px;opacity:0.5;margin-top:4px;">v1.4.0 · 指纹浏览器</div>
         </div>
         ${_sectionHeader('var(--accent), #7c3aed', '核心技术')}
         ${_aboutCoreTech('🧬 真实 Chrome 内核','🔐 硬件指纹随机化','🌍 60+ 语言适配','⚡ GPU 硬件加速',
             '','','','','原生内核 + JS 注入','CPU/内存完全随机','时区与语言完美伪装','流畅 UI 渲染体验')}
         ${_sectionHeader('#4CAF50, #2196F3', '检测状态')}
         ${_aboutDetection(['Browserscan 全绿','Pixelscan 无检测','TLS 指纹真实','最小化 API Hook'])}
         ${_sectionHeader('#FF9800, #F44336', '平台适配')}
         ${_aboutPlatforms([['Amazon','#f39c12'],['TikTok','#27ae60'],['Facebook','#2980b9'],['虾皮','#e67e22'],['乐天','#bf0000'],['美客多','#f1c40f']])}` ;

    const manualEl = document.getElementById('help-manual');
    const aboutEl = document.getElementById('help-about');
    if (manualEl) manualEl.innerHTML = manualHTML;
    if (aboutEl) aboutEl.innerHTML = aboutHTML;
}

function applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.innerText = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('.running-badge').forEach(el => { el.innerText = t('runningStatus'); });
    const themeSel = document.getElementById('themeSelect');
    if (themeSel) { themeSel.options[0].text = t('themeGeek'); themeSel.options[1].text = t('themeLight'); themeSel.options[2].text = t('themeDark'); }
    const langBtn = document.getElementById('langToggleBtn');
    if (langBtn) {
        langBtn.textContent = curLang === 'vi' ? 'VI' : 'EN';
        langBtn.style.background = 'var(--accent)';
        langBtn.style.color = 'var(--bg-color)';
    }
    renderHelpContent();
    updateToolbar(); loadGroups().then(() => loadProfiles()); renderGroupTabs();
}

function toggleLang() {
    curLang = curLang === 'en' ? 'vi' : 'en';
    localStorage.setItem('geekez_lang', curLang);
    applyLang();
}

function setTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('geekez_theme', themeName);
    const themeColors = {
        'geek': { bg: '#1e1e2d', symbol: '#ffffff' },
        'light': { bg: '#f0f2f5', symbol: '#000000' },
        'dark': { bg: '#121212', symbol: '#ffffff' }
    };
    const colors = themeColors[themeName] || themeColors['geek'];
    window.electronAPI.invoke('set-title-bar-color', colors);
}

// Show Alert (supports loading state)
function showAlert(msg, showBtn = true) {
    const msgEl = document.getElementById('alertMsg');
    // Reset styling that openNotifDetail() sets for its own use — otherwise a
    // normal showAlert() call after viewing a notification inherits its
    // left-aligned/pre-wrap style.
    msgEl.style.whiteSpace = '';
    msgEl.style.textAlign = '';
    msgEl.innerText = msg;
    const btn = document.getElementById('alertBtn');
    if (btn) btn.style.display = showBtn ? 'block' : 'none';
    document.getElementById('alertModal').style.display = 'flex';
}
function showConfirm(msg, callback) { document.getElementById('confirmMsg').innerText = msg; document.getElementById('confirmModal').style.display = 'flex'; confirmCallback = callback; }
function closeConfirm(result) {
    document.getElementById('confirmModal').style.display = 'none';
    if (result && confirmCallback) confirmCallback();
    confirmCallback = null;
}

function showInput(title, callback) {
    document.getElementById('inputModalTitle').innerText = title;
    document.getElementById('inputModalValue').value = '';
    document.getElementById('inputModal').style.display = 'flex';
    document.getElementById('inputModalValue').focus();
    inputCallback = callback;
}
function closeInputModal() { document.getElementById('inputModal').style.display = 'none'; inputCallback = null; }
function submitInputModal() {
    const val = document.getElementById('inputModalValue').value.trim();
    if (val && inputCallback) inputCallback(val);
    closeInputModal();
}

// Auto-Detect Timezone/Location/Language from Proxy IP
// mode: 'add' (Tạo Profile) hoặc 'edit' (Chỉnh sửa Profile).
// Gọi trực tiếp từ addEventListener sẽ nhận Event object → coi như 'add'.
async function autoDetectFromProxy(mode = 'add') {
    if (mode && typeof mode === 'object') mode = 'add';
    const ids = mode === 'edit'
        ? { proxy: 'editProxy', btn: 'editAutoDetectBtn', tz: 'editTimezone', city: 'editCity', lang: 'editLanguage' }
        : { proxy: 'addProxy',  btn: 'autoDetectBtn',     tz: 'addTimezone',  city: 'addCity',  lang: 'addLanguage'  };

    const proxyText = document.getElementById(ids.proxy).value.trim();
    if (!proxyText) {
        showAlert('Please enter a proxy first');
        return;
    }

    // Take first line if multiple proxies
    const proxyStr = proxyText.split('\n')[0].trim();

    try {
        const btn = document.getElementById(ids.btn);
        const originalText = btn.textContent;
        btn.textContent = '🔄 Detecting...';
        btn.disabled = true;

        const geoData = await window.electronAPI.detectProxyLocation(proxyStr);

        if (!geoData) {
            showAlert('Failed to detect proxy location. Please check proxy format or IP.');
            btn.textContent = originalText;
            btn.disabled = false;
            return;
        }

        // Auto-fill timezone
        if (geoData.timezone) {
            document.getElementById(ids.tz).value = geoData.timezone;
        }

        // Auto-fill city/location
        if (geoData.city && window.CITY_DATA) {
            const cityData = window.CITY_DATA.find(c =>
                c.name.toLowerCase().includes(geoData.city.toLowerCase()) ||
                geoData.city.toLowerCase().includes(c.name.toLowerCase())
            );
            if (cityData) {
                document.getElementById(ids.city).value = cityData.name;
            } else {
                console.warn(`City "${geoData.city}" not found in CITY_DATA, falling back to IP-based`);
                document.getElementById(ids.city).value = 'Auto (IP Based)';
            }
        }

        // Auto-fill language
        if (geoData.language) {
            const languageInput = document.getElementById(ids.lang);
            if (languageInput) {
                const langName = getLanguageName(geoData.language);
                languageInput.value = langName !== 'Auto (System Default)' ? langName : geoData.language;
            }
        }

        showAlert(`✅ Auto-detected: ${geoData.city}, ${geoData.country}\nTimezone: ${geoData.timezone}\nLanguage: ${geoData.language}`);

        btn.textContent = originalText;
        btn.disabled = false;
    } catch (error) {
        console.error('Auto-detect error:', error);
        showAlert('Error during auto-detection: ' + error.message);
        const btn = document.getElementById(ids.btn);
        btn.textContent = '🔍 Auto-Detect Location';
        btn.disabled = false;
    }
}

async function init() {
    const savedTheme = localStorage.getItem('geekez_theme') || 'light';
    setTheme(savedTheme);
    document.getElementById('themeSelect').value = savedTheme;
    setTimeout(() => { const s = document.getElementById('splash'); if (s) { s.style.opacity = '0'; setTimeout(() => s.remove(), 500); } }, 1500);

    globalSettings = await window.electronAPI.getSettings();
    if (!globalSettings.preProxies) globalSettings.preProxies = [];
    if (!globalSettings.subscriptions) globalSettings.subscriptions = [];

    document.getElementById('enablePreProxy').checked = globalSettings.enablePreProxy || false;
    document.getElementById('enablePreProxy').addEventListener('change', updateToolbar);
    window.electronAPI.onProfileStatus(({ id, status }) => {
        const badge = document.getElementById(`status-${id}`);
        if (badge) status === 'running' ? badge.classList.add('active') : badge.classList.remove('active');
        // Re-render list so Verify button appears/disappears with running state
        loadProfiles();
    });

    // Repeated instant-crash on launch (>=2 in a row) usually means corrupted browser_data —
    // offer a one-click repair (backup + reset, then relaunch through the normal flow).
    window.electronAPI.onProfileRepairSuggested(({ id, name, streak }) => {
        showConfirm(
            `Profile "${name}" không mở lên được ${streak} lần liên tiếp.\n\nCó thể do dữ liệu trình duyệt (cache/profile Chrome) bị hỏng. Sửa bằng cách reset dữ liệu?\n\nNếu profile này đã từng đồng bộ cloud, phiên đăng nhập sẽ được khôi phục tự động sau khi mở lại.`,
            async () => {
                const res = await window.electronAPI.repairProfile(id);
                if (res?.success) {
                    showAlert('Đã sửa xong, đang mở lại profile...');
                    launch(id);
                } else {
                    showAlert('Sửa lỗi thất bại: ' + (res?.error || 'Lỗi không xác định'));
                }
            }
        );
    });

    // API event listeners for remote refresh and launch
    window.electronAPI.onRefreshProfiles(() => {
        console.log('API triggered profile refresh');
        loadProfiles();
    });

    window.electronAPI.onApiLaunchProfile((id) => {
        console.log('API triggered launch for:', id);
        launch(id);
    });

    // Sau khi kích hoạt license từ dialog khởi động → hỏi chọn thư mục lưu dữ liệu
    window.electronAPI.onLicenseActivated(() => {
        setTimeout(() => askDataPathAfterActivation(), 500);
    });

    // 核心修复：版本号注入
    const info = await window.electronAPI.invoke('get-app-info');
    const verSpan = document.getElementById('app-version');
    if (verSpan) verSpan.innerText = `v${info.version}`;

    checkSubscriptionUpdates();
    applyLang();

    // Load timezones after DOM is ready - Custom Dropdown
    if (typeof window.TIMEZONES !== 'undefined' && Array.isArray(window.TIMEZONES)) {
        initCustomTimezoneDropdown('addTimezone', 'addTimezoneDropdown');
        initCustomTimezoneDropdown('editTimezone', 'editTimezoneDropdown');
    }

    // Auto-Detect button click event
    const autoDetectBtn = document.getElementById('autoDetectBtn');
    if (autoDetectBtn) {
        autoDetectBtn.addEventListener('click', autoDetectFromProxy);
    }

    // Auto-Detect button trong modal Chỉnh sửa Profile
    const editAutoDetectBtn = document.getElementById('editAutoDetectBtn');
    if (editAutoDetectBtn) {
        editAutoDetectBtn.addEventListener('click', () => autoDetectFromProxy('edit'));
    }

    // Auto-detect on blur event (optional, can be disabled by user)
    const proxyTextarea = document.getElementById('addProxy');
    if (proxyTextarea) {
        proxyTextarea.addEventListener('blur', async () => {
            const autoDetectEnabled = localStorage.getItem('geekez_auto_detect_on_blur');
            // Default enabled, user can disable by setting to 'false'
            if (autoDetectEnabled !== 'false') {
                const proxyText = proxyTextarea.value.trim();
                // Only auto-detect if proxy is entered and timezone is still default
                const currentTimezone = document.getElementById('addTimezone').value;
                if (proxyText && currentTimezone === 'Auto (No Change)') {
                    await autoDetectFromProxy();
                }
            }
        });
    }

    // Check for updates silently on startup
    checkUpdatesSilent();
}


async function checkSubscriptionUpdates() {
    const now = Date.now();
    let updated = false;
    for (const sub of globalSettings.subscriptions) {
        if (!sub.interval || sub.interval == '0') continue;
        const intervalMs = parseInt(sub.interval) * 3600 * 1000;
        if (now - (sub.lastUpdated || 0) > intervalMs) {
            await updateSubscriptionNodes(sub);
            updated = true;
        }
    }
    if (updated) await window.electronAPI.saveSettings(globalSettings);
}

async function checkUpdates() {
    const btn = document.getElementById('btnUpdate');

    // Show "Checking..." without button
    showAlert(t('checkingUpdate'), false);

    try {
        const appRes = await window.electronAPI.invoke('check-app-update');

        // Hide alert modal first to avoid conflict with showConfirm or to refresh state
        document.getElementById('alertModal').style.display = 'none';

        if (appRes.update) {
            // electron-updater đã bắt đầu download nền trong check-app-update IPC handler.
            // Không mở browser — hiện toast và chờ update-downloaded event kích hoạt thanh cập nhật.
            showBncToast(`🔄 Đang tải bản cập nhật v${appRes.remote}... Thanh cài đặt sẽ xuất hiện khi xong.`, 6000);
            return;
        }

        // Xray update chạy ngầm, không thông báo cho user
        window.electronAPI.invoke('check-xray-update').then(xrayRes => {
            if (xrayRes.update) window.electronAPI.invoke('download-xray-update', xrayRes.downloadUrl);
        }).catch(() => {});

        // No Update -> Show Alert with OK button
        showAlert(t('noUpdate'));

        // Clear badge if no update found after manual check
        btn.classList.remove('has-update');
    } catch (e) {
        showAlert(t('updateError') + ' ' + e.message);
    }
}

async function checkUpdatesSilent() {
    try {
        const appRes = await window.electronAPI.invoke('check-app-update');
        if (appRes.update) {
            // Nếu server đặt skipable: false → không được bỏ qua, bỏ qua logic skip
            const skipable = appRes.skipable !== false;
            if (skipable) {
                const skippedVersion = localStorage.getItem('geekez_skipped_version');
                if (skippedVersion === appRes.remote) {
                    console.log(`Version ${appRes.remote} was skipped by user`);
                    return;
                }
            }

            const btn = document.getElementById('btnUpdate');
            if (btn) btn.classList.add('has-update');
            // electron-updater đang download nền → không mở browser, chỉ badge nút update
            // Thanh "Cài & Khởi động lại" sẽ tự hiện khi update-downloaded event fire
            return;
        }
        const xrayRes = await window.electronAPI.invoke('check-xray-update');
        if (xrayRes.update) {
            const btn = document.getElementById('btnUpdate');
            if (btn) btn.classList.add('has-update');
        }
    } catch (e) {
        console.error('Silent update check failed:', e);
    }
}

// Simple markdown parser for release notes
function parseMarkdown(md) {
    if (!md) return '';
    return md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') // Escape HTML
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italic
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="#" onclick="window.electronAPI.invoke(\'open-url\', \'$2\'); return false;" style="color:var(--accent);text-decoration:none;">$1</a>') // Links
        .replace(/^\s*-\s+(.*)$/gm, '<li>$1</li>') // List items
        .replace(/(<li>.*<\/li>)/s, '<ul style="padding-left: 20px; margin: 5px 0;">$1</ul>') // Wrap lists
        .replace(/\n\n/g, '<br><br>') // Paragraphs
        .replace(/\n/g, '<br>'); // Line breaks
}

// Show update/announcement dialog — content từ server
// skipable=false: server bắt buộc hiển thị, không cho bỏ qua
function showUpdateConfirm(version, url, notes, skipable = true) {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmMsg');
    const notesEl = document.getElementById('confirmNotes');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');

    // Tiêu đề: nếu có version thì hiện, không thì dùng chuỗi chung
    msgEl.innerHTML = version
        ? `${t('appUpdateFound')} (v${version})`
        : (t('appUpdateFound') || 'Thông báo mới');

    if (notes) {
        notesEl.innerHTML = parseMarkdown(notes);
        notesEl.style.display = 'block';
    } else {
        notesEl.style.display = 'none';
    }

    // Nút tải xuống / xem chi tiết
    yesBtn.textContent = url ? (t('goDownload') || 'Tải xuống') : (t('done') || 'OK');
    yesBtn.style.display = '';
    yesBtn.onclick = () => {
        modal.style.display = 'none';
        if (url) window.electronAPI.invoke('open-url', url);
    };

    // Nút bỏ qua — ẩn nếu server đặt skipable: false
    if (skipable && version) {
        noBtn.textContent = t('skipVersion') || 'Bỏ qua phiên bản này';
        noBtn.style.display = '';
        noBtn.onclick = () => {
            localStorage.setItem('geekez_skipped_version', version);
            modal.style.display = 'none';
            showAlert(t('versionSkipped') || `Đã bỏ qua v${version}`);
        };
    } else {
        // Không cho bỏ qua hoặc không có version → ẩn nút Skip
        noBtn.style.display = 'none';
        noBtn.onclick = null;
    }

    modal.style.display = 'flex';
}


function filterProfiles(text) {
    searchText = text.toLowerCase();
    loadProfiles();
}

function toggleViewMode() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
    localStorage.setItem('geekez_view', viewMode);
    loadProfiles();
}

// 简单的颜色生成器
// Convert ISO country code to flag emoji (e.g. "GB" → "🇬🇧")
// ========= Tags & Note mini-dialogs (GPMLogin style) =========
let _addTags = [], _editTags = [];
let _addNote = '', _editNote = '';
let _tagsCtx = null, _noteCtx = null;
let _inlineProfileId = null; // for direct edit from profile list

// Open tags dialog from Add/Edit modal
function openTagsDialog(ctx) {
    _tagsCtx = ctx; _inlineProfileId = null;
    const tags = ctx === 'add' ? _addTags : _editTags;
    _renderTagChips([...tags]);
    document.getElementById('tagsDialogInput').value = '';
    document.getElementById('tagsMiniDialog').style.display = 'flex';
    setTimeout(() => document.getElementById('tagsDialogInput').focus(), 50);
}

// Open tags dialog directly from profile list item
async function openTagsDialogInline(profileId) {
    _tagsCtx = null; _inlineProfileId = profileId;
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === profileId);
    _renderTagChips(p ? [...(p.tags || [])] : []);
    document.getElementById('tagsDialogInput').value = '';
    document.getElementById('tagsMiniDialog').style.display = 'flex';
    setTimeout(() => document.getElementById('tagsDialogInput').focus(), 50);
}

async function closeTagsDialog(save) {
    if (save) {
        const chips = document.querySelectorAll('#tagsChipsArea .chip-item');
        const tags = [...chips].map(c => c.dataset.tag);
        if (_inlineProfileId) {
            // Save directly to profile
            const profiles = await window.electronAPI.getProfiles();
            const p = profiles.find(x => x.id === _inlineProfileId);
            if (p) { p.tags = tags; await window.electronAPI.updateProfile(p); }
            await loadProfiles();
        } else if (_tagsCtx) {
            if (_tagsCtx === 'add') _addTags = tags;
            else _editTags = tags;
            _updateTagsTrigger(_tagsCtx);
        }
    }
    document.getElementById('tagsMiniDialog').style.display = 'none';
    _tagsCtx = null; _inlineProfileId = null;
}

function handleTagInputKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val) { _addTagChip(val); e.target.value = ''; }
    }
}

function _addTagChip(tag) {
    const area = document.getElementById('tagsChipsArea');
    const existing = [...area.querySelectorAll('.chip-item')].map(c => c.dataset.tag);
    if (existing.includes(tag)) return;
    document.getElementById('tagsChipsEmpty').style.display = 'none';
    const chip = document.createElement('span');
    chip.className = 'chip-item';
    chip.dataset.tag = tag;
    chip.innerHTML = `${tag.replace(/</g,'&lt;')}<button class="chip-x" onclick="this.parentElement.remove();_syncChipsEmpty()" title="Remove">×</button>`;
    area.appendChild(chip);
}

function _syncChipsEmpty() {
    const area = document.getElementById('tagsChipsArea');
    const empty = document.getElementById('tagsChipsEmpty');
    if (empty) empty.style.display = area.querySelectorAll('.chip-item').length === 0 ? '' : 'none';
}

function _renderTagChips(tags) {
    const area = document.getElementById('tagsChipsArea');
    area.querySelectorAll('.chip-item').forEach(c => c.remove());
    document.getElementById('tagsChipsEmpty').style.display = tags.length === 0 ? '' : 'none';
    tags.forEach(t => _addTagChip(t));
}

function _updateTagsTrigger(ctx) {
    const tags = ctx === 'add' ? _addTags : _editTags;
    const el = document.getElementById(ctx === 'add' ? 'addTagsTrigger' : 'editTagsTrigger');
    if (!el) return;
    if (tags.length === 0) {
        el.innerHTML = `<span class="tags-trigger-placeholder">Add tags...</span>`;
    } else {
        el.innerHTML = tags.map(t =>
            `<span class="tag" style="background:${stringToColor(t)}33;color:${stringToColor(t)};border:1px solid ${stringToColor(t)}44;">${t.replace(/</g,'&lt;')}</span>`
        ).join('');
    }
}

function openNoteDialog(ctx) {
    _noteCtx = ctx; _inlineProfileId = null;
    document.getElementById('noteDialogInput').value = ctx === 'add' ? _addNote : _editNote;
    document.getElementById('noteMiniDialog').style.display = 'flex';
    setTimeout(() => document.getElementById('noteDialogInput').focus(), 50);
}

async function openNoteDialogInline(profileId) {
    _noteCtx = null; _inlineProfileId = profileId;
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === profileId);
    document.getElementById('noteDialogInput').value = p ? (p.note || '') : '';
    document.getElementById('noteMiniDialog').style.display = 'flex';
    setTimeout(() => document.getElementById('noteDialogInput').focus(), 50);
}

async function closeNoteDialog(save) {
    if (save) {
        const note = document.getElementById('noteDialogInput').value.trim();
        if (_inlineProfileId) {
            const profiles = await window.electronAPI.getProfiles();
            const p = profiles.find(x => x.id === _inlineProfileId);
            if (p) { p.note = note; await window.electronAPI.updateProfile(p); }
            await loadProfiles();
        } else if (_noteCtx) {
            if (_noteCtx === 'add') _addNote = note;
            else _editNote = note;
            _updateNoteTrigger(_noteCtx);
        }
    }
    document.getElementById('noteMiniDialog').style.display = 'none';
    _noteCtx = null; _inlineProfileId = null;
}

function _updateNoteTrigger(ctx) {
    const note = ctx === 'add' ? _addNote : _editNote;
    const el = document.getElementById(ctx === 'add' ? 'addNoteTrigger' : 'editNoteTrigger');
    if (!el) return;
    el.innerHTML = note
        ? `<span style="font-size:12px;">${note.replace(/</g,'&lt;')}</span>`
        : `<span class="note-trigger-placeholder">Add note...</span>`;
}
// ===================================================

function generateMac(seed) {
    let s = (seed || 1) >>> 0;
    const bytes = [];
    for (let i = 0; i < 6; i++) {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        bytes.push(s >>> 24);
    }
    // Locally administered, unicast
    bytes[0] = (bytes[0] & 0xFE) | 0x02;
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function copyMac(mac, btn) {
    navigator.clipboard.writeText(mac).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        btn.style.color = '#4caf50';
        setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1200);
    });
}

function countryCodeToFlag(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
}

// Extract country code from proxy geo data stored on profile
function getProxyFlag(p) {
    const cc = p.fingerprint?.countryCode || p._countryCode || '';
    return countryCodeToFlag(cc);
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + "00000".substring(0, 6 - c.length) + c;
}

async function loadProfiles() {
    try {
        const profiles = await window.electronAPI.getProfiles();
        console.log(`[LOAD_PROFILES] ${profiles.length} profiles | account=${_bncAuth?.email} | locked=${profiles.filter(p=>p.isLocked).length}`);
        window._cachedProfiles = profiles; // cache for group assignment modal
        const runningIds = await window.electronAPI.getRunningIds();
        const listEl = document.getElementById('profileList');

        if (viewMode === 'grid') {
            listEl.classList.add('grid-view');
            document.getElementById('viewIcon').innerHTML = '<path d="M3 10h18M3 14h18M3 18h18M3 6h18" stroke-width="2"/>';
        } else {
            listEl.classList.remove('grid-view');
            document.getElementById('viewIcon').innerHTML = '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>';
        }

        listEl.innerHTML = '';
        const filtered = profiles.filter(p => {
            const text = searchText;
            const matchSearch = p.name.toLowerCase().includes(text) ||
                p.proxyStr.toLowerCase().includes(text) ||
                (p.tags && p.tags.some(t => t.toLowerCase().includes(text)));
            const matchGroup = !currentGroupFilter ||
                (currentGroupFilter === '__none__' ? !p.groupId : p.groupId === currentGroupFilter);
            return matchSearch && matchGroup;
        });

        if (filtered.length === 0) {
            const isSearch = searchText.length > 0;
            const msg = isSearch ? "No Search Results" : t('emptyStateMsg');
            listEl.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><div class="empty-state-text">${msg}</div></div>`;
            return;
        }

        filtered.forEach(p => {
            const fp = p.fingerprint || {};
            const screen = fp.screen || { width: 0, height: 0 };
            const override = p.preProxyOverride || 'default';
            const isRunning = runningIds.includes(p.id);

            // Tags chips
            const safeId = p.id.replace(/[^a-zA-Z0-9_-]/g, '');
            let tagsHtml = '';
            if (p.tags && p.tags.length > 0) {
                tagsHtml = p.tags.map(tag =>
                    `<span class="tag" style="background:${stringToColor(tag)}33; color:${stringToColor(tag)}; border:1px solid ${stringToColor(tag)}44;">${tag}</span>`
                ).join('');
            }

            const groupOfProfile = allGroups.find(g => g.id === p.groupId);
            const groupBadge = groupOfProfile
                ? `<span style="font-size:11px;opacity:0.6;margin-left:6px;">📁 ${groupOfProfile.name}</span>`
                : '';

            // Country flag
            const flag = getProxyFlag(p);
            const flagHtml = flag ? `<span style="font-size:16px;margin-right:4px;" title="${p.fingerprint?.countryCode || ''}">${flag}</span>` : '';

            // MAC
            const mac = generateMac(fp.noiseSeed);

            // Note pill
            const notePill = p.note
                ? `<span class="pi-note-pill no-drag" onclick="openNoteDialogInline('${p.id}')" title="${p.note.replace(/"/g,'&quot;')}">📝 ${p.note.replace(/</g,'&lt;').substring(0,30)}${p.note.length>30?'…':''}</span>`
                : `<span class="pi-note-pill no-drag" style="opacity:0.3;" onclick="openNoteDialogInline('${p.id}')">📝 note...</span>`;

            // Tags pills
            const tagsPills = (p.tags && p.tags.length > 0)
                ? p.tags.map(tag => `<span class="pi-tag-pill tag no-drag" style="background:${stringToColor(tag)}22;color:${stringToColor(tag)};border:1px solid ${stringToColor(tag)}44;">${tag}</span>`).join('')
                : `<span style="opacity:0.3;font-size:11px;">🏷️...</span>`;

            // Proxy display — format: [proto://]host:port[:user:pass] hoặc host:port:user:pass
            const rawProxy = p.proxyStr || '';
            const isDirect = !rawProxy.trim();
            const hasProto = rawProxy.includes('://');
            const proxyProto = isDirect ? 'DIRECT' : (hasProto ? rawProxy.split('://')[0].toUpperCase() : 'PROXY');
            const proxyBody = hasProto ? rawProxy.split('://')[1] : rawProxy;
            const proxyParts = proxyBody.split(':');
            const proxyHost = isDirect ? 'Mạng máy tính' : proxyParts.slice(0, 2).join(':');

            // Sync status badge
            const ss = p.syncedToServer;
            const syncColor = ss === true ? '#22c55e' : ss === false ? '#ef4444' : '#9ca3af';
            const syncIcon  = ss === true ? '✔' : ss === false ? '✘' : '?';
            const syncTitle = ss === true ? 'Đã sync lên yttool.vn' : ss === false ? 'Chưa sync lên server' : 'Chưa rõ trạng thái sync';
            const syncBadge = `<span id="sync-${p.id}" title="${syncTitle}"
                style="display:inline-flex;align-items:center;gap:2px;font-size:10px;font-weight:600;margin-left:5px;padding:1px 5px;border-radius:10px;background:${syncColor}22;color:${syncColor};border:1px solid ${syncColor}66;flex-shrink:0;cursor:default;line-height:1.4;">
                ☁ ${syncIcon}
            </span>`;

            const isLocked = !!p.isLocked;
            const el = document.createElement('div');
            el.className = 'profile-item no-drag';
            if (isLocked) el.style.cssText = 'opacity:0.45;pointer-events:none;user-select:none;';
            el.innerHTML = `
                <!-- Checkbox -->
                <div class="no-drag" style="display:flex;align-items:center;justify-content:center;">
                    <input type="checkbox" class="profile-select-cb no-drag" data-id="${p.id}" style="width:15px;height:15px;cursor:pointer;accent-color:#00e0ff;" onchange="_onProfileCheckboxChange('${p.id}',this.checked)" ${_selectedProfileIds.has(p.id)?'checked':''}>
                </div>
                <!-- Col 1: identity -->
                <div class="pi-main">
                    <div class="pi-name-row">${flagHtml}<h4>${p.name}</h4><span id="status-${p.id}" class="running-badge ${isRunning ? 'active' : ''}">${t('runningStatus')}</span>${groupBadge}${syncBadge}${isLocked ? `<span title="Profile bị khóa — hết slot" style="margin-left:5px;font-size:11px;padding:1px 6px;border-radius:10px;background:#f4433622;color:#f44336;border:1px solid #f4433666;">🔒 Hết slot</span>` : ''}</div>
                    <div class="pi-sub-row">
                        ${notePill}
                        <div class="pi-tags-wrap no-drag" onclick="openTagsDialogInline('${p.id}')" title="Edit tags">${tagsPills}</div>
                    </div>
                </div>
                <!-- Col 2: proxy + MAC -->
                <div class="pi-tech">
                    <div class="pi-proxy-row"><span class="tag" style="flex-shrink:0;">${proxyProto}</span><span style="overflow:hidden;text-overflow:ellipsis;">${proxyHost}</span></div>
                    <div class="pi-mac-row">💻 <span class="mac-addr">${mac}</span><button class="mac-copy-btn no-drag" onclick="event.stopPropagation();copyMac('${mac}',this)" title="Copy MAC">⧉</button></div>
                </div>
                <!-- Col 3: res + preproxy -->
                <div class="pi-meta">
                    <span class="tag">${screen.width}x${screen.height}</span>
                    <span class="tag" style="border:1px solid var(--accent);padding:0;">
                        <select class="quick-switch-select no-drag" onchange="quickUpdatePreProxy('${p.id}', this.value)">
                            <option value="default" ${override === 'default' ? 'selected' : ''}>${t('qsDefault')}</option>
                            <option value="on" ${override === 'on' ? 'selected' : ''}>${t('qsOn')}</option>
                            <option value="off" ${override === 'off' ? 'selected' : ''}>${t('qsOff')}</option>
                        </select>
                    </span>
                </div>
                <!-- Col 4: actions -->
                <div class="actions" style="${isLocked ? 'pointer-events:auto;' : ''}">
                    ${isLocked
                        ? `<button class="no-drag" disabled style="opacity:0.4;cursor:not-allowed;" onclick="event.stopPropagation();showConfirm('Profile bị khóa do hết slot.\\n\\nMua thêm gói để mở khóa?',()=>openPlansModal())">${t('launch')}</button>`
                        : `<button onclick="launch('${p.id}', this)" class="no-drag">${t('launch')}</button>`
                    }
                    ${(() => { const wp = window._activeWorkspacePerm?.profile || null;
                        const canEdit   = !wp || wp.editProxy !== false || wp.editFingerprint !== false || wp.editNote !== false;
                        const canDelete = !wp || wp.delete !== false;
                        return (canEdit   ? `<button class="outline no-drag" onclick="openEditModal('${p.id}')">${t('edit')}</button><button class="outline no-drag" onclick="openAssignGroup('${p.id}')" title="Move to group">📁</button>${isRunning ? `<button class="outline no-drag" onclick="openVerifyModal('${p.id}')" title="Verify">✓</button>` : ''}` : '')
                             + (canDelete ? `<button class="danger no-drag" onclick="remove('${p.id}')">${t('delete')}</button>` : '');
                    })()}
                </div>
            `;
            listEl.appendChild(el);
        });
    } catch (e) { console.error(e); }
}


async function quickUpdatePreProxy(id, val) {
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === id);
    if (p) { p.preProxyOverride = val; await window.electronAPI.updateProfile(p); }
}

function openAddModal() {
    // ── BNC: kiểm tra slots còn lại ───────────────────────────────────────
    const slots = _bncAuth?.slots;
    if (slots !== undefined && slots.available <= 0) {
        const msg = slots.totalGranted === 0
            ? 'Bạn chưa có slot profile nào.\n\nMua gói để bắt đầu tạo profile?'
            : `Bạn đã dùng hết ${slots.totalGranted} slot profile.\n\nMua thêm slots để tạo profile mới?`;
        showConfirm(msg, () => openPlansModal());
        return;
    }
    // ─────────────────────────────────────────────────────────────────────

    document.getElementById('addName').value = '';
    document.getElementById('addProxy').value = '';
    _addTags = []; _addNote = '';
    _updateTagsTrigger('add'); _updateNoteTrigger('add');
    document.getElementById('addTimezone').value = 'Auto (No Change)';

    // Initialize location dropdown
    initCustomCityDropdown('addCity', 'addCityDropdown');
    document.getElementById('addCity').value = 'Auto (IP Based)';

    // Initialize language dropdown
    initCustomLanguageDropdown('addLanguage', 'addLanguageDropdown');
    document.getElementById('addLanguage').value = 'Auto (System Default)';

    document.getElementById('addModal').style.display = 'flex';
}
function closeAddModal() { document.getElementById('addModal').style.display = 'none'; }

async function saveNewProfile() {
    const nameBase = document.getElementById('addName').value.trim();
    const proxyText = document.getElementById('addProxy').value.trim();
    const timezoneInput = document.getElementById('addTimezone').value;
    // 将 "Auto (No Change)" 转换为 "Auto" 存储
    const timezone = timezoneInput === 'Auto (No Change)' ? 'Auto' : timezoneInput;

    const cityInput = document.getElementById('addCity').value;
    let city = null;
    let geolocation = null;
    if (cityInput && cityInput !== 'Auto (IP Based)') {
        const cityData = window.CITY_DATA ? window.CITY_DATA.find(c => c.name === cityInput) : null;
        if (cityData) {
            city = cityData.name;
            geolocation = { latitude: cityData.lat, longitude: cityData.lng, accuracy: 100 };
        }
    }

    // Get language value
    const languageInput = document.getElementById('addLanguage').value;
    const language = getLanguageCode(languageInput);

    // Get pre-proxy value
    const preProxyOverride = document.getElementById('addPreProxyOverride').value;

    // Get screen resolution
    const resW = parseInt(document.getElementById('addResW').value);
    const resH = parseInt(document.getElementById('addResH').value);
    let screen = null;
    if (!isNaN(resW) && !isNaN(resH)) {
        screen = { width: resW, height: resH };
    }

    const tags = _addTags;
    const note = _addNote;

    // Split multi-line proxy links
    const proxyLines = proxyText.split('\n').map(l => l.trim()).filter(l => l);

    // Optimistic slot decrement — server sẽ trừ thật, client cập nhật ngay để pill phản ánh đúng
    function _decrementSlot() {
        if (_bncAuth?.slots) {
            _bncAuth.slots.slotsUsed += 1;
            _bncAuth.slots.available = Math.max(0, _bncAuth.slots.available - 1);
            _updatePlanPill(_bncAuth);
        }
    }

    // No proxy — require a name, create single profile with no proxy
    if (proxyLines.length === 0) {
        if (!nameBase) return showAlert(t('inputReq'));
        try {
            await window.electronAPI.saveProfile({ name: nameBase, proxyStr: '', tags, note, timezone, city, geolocation, language, screen, preProxyOverride });
            _decrementSlot();
        } catch (e) {
            console.error(`Failed to create profile ${nameBase}:`, e);
        }
        closeAddModal();
        await loadProfiles();
        return;
    }

    // Batch create with proxy lines
    let createdCount = 0;
    for (let i = 0; i < proxyLines.length; i++) {
        const proxyStr = proxyLines[i];
        let name;

        if (!nameBase) {
            // No name input — derive from proxy remark
            name = getProxyRemark(proxyStr) || `Profile-${String(i + 1).padStart(2, '0')}`;
        } else if (proxyLines.length === 1) {
            // Single proxy — use input name as-is
            name = nameBase;
        } else {
            // Multiple proxies — append index
            name = `${nameBase}-${String(i + 1).padStart(2, '0')}`;
        }

        try {
            await window.electronAPI.saveProfile({ name, proxyStr, tags, note, timezone, city, geolocation, language, screen, preProxyOverride });
            createdCount++;
            _decrementSlot();
        } catch (e) {
            console.error(`Failed to create profile ${name}:`, e);
        }
    }

    closeAddModal();
    await loadProfiles();

    if (proxyLines.length > 1) {
        showAlert(`${t('msgBatchCreated') || 'Batch created'}: ${createdCount} ${t('msgProfiles') || 'profiles'}`);
    }
}

// Chrome + xray mất vài giây để khởi động — không có phản hồi gì trên nút
// khiến người dùng tưởng chưa bấm được, dễ bấm lại nhiều lần liên tiếp
// (từng thấy log nhiều lệnh launch chồng lên nhau cho cùng 1 profile).
// Disable + hiện spinner ngay khi bấm để rõ ràng "đang xử lý".
function _setLaunchBtnLoading(btn, isLoading) {
    if (!btn) return;
    if (isLoading) {
        if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'default';
        btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;"></span>';
    } else {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
        if (btn.dataset.origHtml !== undefined) btn.innerHTML = btn.dataset.origHtml;
    }
}

async function launch(id, btnEl) {
    const ws = _bncAuth?.activeWorkspace || 'own';
    // Kiểm tra isLocked từ profile data
    const profiles = await window.electronAPI.getProfiles();
    const profile = profiles.find(p => p.id === id);
    if (profile?.isLocked) {
        showConfirm('Profile này bị khóa do hết slot.\n\nMua thêm gói để mở khóa?', () => openPlansModal());
        return;
    }
    // Fallback: kiểm tra canRun — bỏ qua nếu đang ở team workspace (dùng slot của owner)
    const slots = _bncAuth?.slots;
    if (ws === 'own' && slots !== undefined && (slots.canRun ?? slots.available) <= 0) {
        showConfirm('Bạn đã hết slot — không thể mở profile.\n\nMua thêm gói để tiếp tục sử dụng?', () => openPlansModal());
        return;
    }
    _setLaunchBtnLoading(btnEl, true);
    try {
        const watermarkStyle = localStorage.getItem('geekez_watermark_style') || 'enhanced';
        const msg = await window.electronAPI.launchProfile(id, watermarkStyle);
        if (msg && msg.includes(':')) showAlert(msg);
    } catch (e) { showAlert('Error: ' + e.message); }
    finally { _setLaunchBtnLoading(btnEl, false); }
}

function remove(id) {
    showConfirm(t('confirmDel'), async () => { await window.electronAPI.deleteProfile(id); await loadProfiles(); });
}

async function openEditModal(id) {
    const profiles = await window.electronAPI.getProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    currentEditId = id;
    const fp = p.fingerprint || {};
    document.getElementById('editName').value = p.name;
    document.getElementById('editProxy').value = p.proxyStr;
    _editTags = [...(p.tags || [])]; _editNote = p.note || '';
    _updateTagsTrigger('edit'); _updateNoteTrigger('edit');

    // 回填时区，将 "Auto" 转换为 "Auto (No Change)" 显示
    const savedTimezone = fp.timezone || 'Auto';
    const displayTimezone = savedTimezone === 'Auto' ? 'Auto (No Change)' : savedTimezone;
    document.getElementById('editTimezone').value = displayTimezone;

    initCustomCityDropdown('editCity', 'editCityDropdown');

    // Use stored value directly or Default English Auto
    const savedCity = fp.city || "Auto (IP Based)";
    document.getElementById('editCity').value = savedCity;

    const sel = document.getElementById('editPreProxyOverride');
    sel.options[0].text = t('optDefault'); sel.options[1].text = t('optOn'); sel.options[2].text = t('optOff');
    sel.value = p.preProxyOverride || 'default';
    document.getElementById('editResW').value = fp.screen?.width || 1920;
    document.getElementById('editResH').value = fp.screen?.height || 1080;

    // Init Language Dropdown
    initCustomLanguageDropdown('editLanguage', 'editLanguageDropdown');
    document.getElementById('editLanguage').value = getLanguageName(fp.language || 'auto');

    // Load debug port and show/hide based on global setting
    const settings = await window.electronAPI.getSettings();
    const debugPortSection = document.getElementById('debugPortSection');
    if (settings.enableRemoteDebugging) {
        debugPortSection.style.display = 'block';
        document.getElementById('editDebugPort').value = p.debugPort || '';
    } else {
        debugPortSection.style.display = 'none';
    }

    // Load custom args and show/hide based on global setting
    const customArgsSection = document.getElementById('customArgsSection');
    if (settings.enableCustomArgs) {
        customArgsSection.style.display = 'block';
        document.getElementById('editCustomArgs').value = p.customArgs || '';
    } else {
        customArgsSection.style.display = 'none';
    }

    document.getElementById('editMacAddr').textContent = generateMac(fp.noiseSeed);

    document.getElementById('editModal').style.display = 'flex';
}
function closeEditModal() { document.getElementById('editModal').style.display = 'none'; currentEditId = null; }
async function saveEditProfile() {
    console.log('[saveEditProfile] Called, currentEditId:', currentEditId);
    if (!currentEditId) return;
    const profiles = await window.electronAPI.getProfiles();
    let p = profiles.find(x => x.id === currentEditId);
    console.log('[saveEditProfile] Found profile:', p);
    if (p) {
        p.name = document.getElementById('editName').value;
        p.proxyStr = document.getElementById('editProxy').value;
        p.tags = _editTags;
        p.note = _editNote;
        p.preProxyOverride = document.getElementById('editPreProxyOverride').value;

        if (!p.fingerprint) p.fingerprint = {};
        p.fingerprint.screen = { width: parseInt(document.getElementById('editResW').value), height: parseInt(document.getElementById('editResH').value) };
        p.fingerprint.window = p.fingerprint.screen;
        const timezoneValue = document.getElementById('editTimezone').value;
        console.log('[saveEditProfile] Timezone value:', timezoneValue);
        p.fingerprint.timezone = timezoneValue === 'Auto (No Change)' ? 'Auto' : timezoneValue;
        console.log('[saveEditProfile] Converted timezone:', p.fingerprint.timezone);


        // Save City & Geolocation
        const cityInput = document.getElementById('editCity').value;
        if (cityInput && cityInput !== 'Auto (IP Based)') {
            const cityData = window.CITY_DATA ? window.CITY_DATA.find(c => c.name === cityInput) : null;
            if (cityData) {
                p.fingerprint.city = cityData.name;
                p.fingerprint.geolocation = { latitude: cityData.lat, longitude: cityData.lng, accuracy: 100 };
            }
        } else {
            // Auto mode: remove geolocation to let system/IP decide
            delete p.fingerprint.city;
            delete p.fingerprint.geolocation;
        }
        p.fingerprint.language = getLanguageCode(document.getElementById('editLanguage').value);

        // Save debug port if enabled
        const debugPortInput = document.getElementById('editDebugPort');
        if (debugPortInput.parentElement.style.display !== 'none') {
            const portValue = debugPortInput.value.trim();
            p.debugPort = portValue ? parseInt(portValue) : null;
        }

        // Save custom args if enabled
        const customArgsInput = document.getElementById('editCustomArgs');
        if (customArgsInput.parentElement.style.display !== 'none') {
            p.customArgs = customArgsInput.value.trim();
        }

        console.log('[saveEditProfile] Calling updateProfile...');
        await window.electronAPI.updateProfile(p);
        console.log('[saveEditProfile] Profile updated successfully');
        closeEditModal(); loadProfiles();
    }
}

async function openProxyManager() {
    globalSettings = await window.electronAPI.getSettings();
    if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
    renderGroupTabs();
    document.getElementById('proxyModal').style.display = 'flex';
}
function closeProxyManager() { document.getElementById('proxyModal').style.display = 'none'; }

function renderGroupTabs() {
    const container = document.getElementById('proxyGroupTabs');
    if (!container) return;
    container.innerHTML = '';
    const manualBtn = document.createElement('div');
    manualBtn.className = `tab-btn no-drag ${currentProxyGroup === 'manual' ? 'active' : ''}`;
    manualBtn.innerText = t('groupManual');
    manualBtn.onclick = () => switchProxyGroup('manual');
    container.appendChild(manualBtn);
    globalSettings.subscriptions.forEach(sub => {
        const btn = document.createElement('div');
        btn.className = `tab-btn no-drag ${currentProxyGroup === sub.id ? 'active' : ''}`;
        btn.innerText = sub.name || 'Sub';
        btn.onclick = () => switchProxyGroup(sub.id);
        container.appendChild(btn);
    });
    renderProxyNodes();
}

function switchProxyGroup(gid) { currentProxyGroup = gid; renderGroupTabs(); }

function renderProxyNodes() {
    const modeSel = document.getElementById('proxyMode');
    if (modeSel.options.length === 0) modeSel.innerHTML = `<option value="single">${t('modeSingle')}</option><option value="balance">${t('modeBalance')}</option><option value="failover">${t('modeFailover')}</option>`;
    modeSel.value = globalSettings.mode || 'single';
    document.getElementById('notifySwitch').checked = globalSettings.notify || false;

    const list = (globalSettings.preProxies || []).filter(p => {
        if (currentProxyGroup === 'manual') return !p.groupId || p.groupId === 'manual';
        return p.groupId === currentProxyGroup;
    });

    const listEl = document.getElementById('preProxyList');
    listEl.innerHTML = '';

    const groupName = currentProxyGroup === 'manual' ? t('groupManual') : (globalSettings.subscriptions.find(s => s.id === currentProxyGroup)?.name || 'Sub');
    document.getElementById('currentGroupTitle').innerText = `${groupName} (${list.length})`;

    const btnTest = document.querySelector('button[onclick="testCurrentGroup()"]');
    if (btnTest) btnTest.innerText = t('btnTestGroup');
    const btnNewSub = document.querySelector('button[onclick="openSubEditModal(true)"]');
    if (btnNewSub) btnNewSub.innerText = t('btnImportSub');
    const btnEditSub = document.getElementById('btnEditSub');
    if (btnEditSub) btnEditSub.innerText = t('btnEditSub');

    const isManual = currentProxyGroup === 'manual';
    document.getElementById('manualAddArea').style.display = isManual ? 'block' : 'none';
    document.getElementById('btnEditSub').style.display = isManual ? 'none' : 'inline-block';

    list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'proxy-row no-drag';
        const isSel = globalSettings.mode === 'single' && globalSettings.selectedId === p.id;
        if (isSel) div.style.background = "rgba(0,224,255,0.08)";

        const inputType = globalSettings.mode === 'single' ? 'radio' : 'checkbox';
        const checked = globalSettings.mode === 'single' ? isSel : (p.enable !== false);
        const onchange = globalSettings.mode === 'single' ? `selP('${p.id}')` : `togP('${p.id}')`;
        const inputHtml = `<input type="${inputType}" name="ps" ${checked ? 'checked' : ''} onchange="${onchange}" style="cursor:pointer; margin:0;" class="no-drag">`;

        let latHtml = '';
        if (p.latency !== undefined) {
            if (p.latency === -1 || p.latency === 9999) latHtml = `<span class="proxy-latency" style="border:1px solid #e74c3c; color:#e74c3c;">Fail</span>`;
            else {
                const color = p.latency < 500 ? '#27ae60' : (p.latency < 1000 ? '#f39c12' : '#e74c3c');
                latHtml = `<span class="proxy-latency" style="border:1px solid ${color}; color:${color};">${p.latency}ms</span>`;
            }
        } else {
            latHtml = `<span class="proxy-latency" style="border:1px solid var(--text-secondary); opacity:0.3;">-</span>`;
        }

        const proto = (p.url.split('://')[0] || 'UNK').toUpperCase();
        let displayRemark = p.remark;
        if (!displayRemark || displayRemark.trim() === '') displayRemark = 'Node';

        div.innerHTML = `
            <div class="proxy-left">${inputHtml}</div>
            <div class="proxy-mid">
                <div class="proxy-header"><span class="proxy-proto">${proto}</span><span class="proxy-remark" title="${displayRemark}">${displayRemark}</span>${latHtml}</div>
            </div>
            <div class="proxy-right">
                <button class="outline no-drag" onclick="testSingleProxy('${p.id}')">${t('btnTest')}</button>
                ${isManual ? `<button class="outline no-drag" onclick="editPreProxy('${p.id}')">${t('btnEdit')}</button>` : ''}
                <button class="danger no-drag" onclick="delP('${p.id}')">✕</button>
            </div>
        `;
        listEl.appendChild(div);
    });

    const btnDone = document.querySelector('#proxyModal button[data-i18n="done"]');
    if (btnDone) btnDone.innerText = t('done');
}

function resetProxyInput() {
    document.getElementById('editProxyId').value = '';
    document.getElementById('newProxyRemark').value = '';
    document.getElementById('newProxyUrl').value = '';
    const btn = document.getElementById('btnSaveProxy');
    btn.innerText = t('add'); btn.className = '';
}

function editPreProxy(id) {
    const p = globalSettings.preProxies.find(x => x.id === id);
    if (!p) return;
    document.getElementById('editProxyId').value = p.id;
    document.getElementById('newProxyRemark').value = p.remark;
    document.getElementById('newProxyUrl').value = p.url;
    const btn = document.getElementById('btnSaveProxy');
    btn.innerText = t('save'); btn.className = 'outline';
    document.getElementById('newProxyUrl').focus();
}

async function savePreProxy() {
    const id = document.getElementById('editProxyId').value;
    let remark = document.getElementById('newProxyRemark').value;
    const url = document.getElementById('newProxyUrl').value.trim();
    if (!url) return;
    if (!remark) remark = getProxyRemark(url) || 'Manual Node';
    if (!globalSettings.preProxies) globalSettings.preProxies = [];
    if (id) {
        const idx = globalSettings.preProxies.findIndex(x => x.id === id);
        if (idx > -1) { globalSettings.preProxies[idx].remark = remark; globalSettings.preProxies[idx].url = url; }
    } else {
        globalSettings.preProxies.push({ id: Date.now().toString(), remark, url, enable: true, groupId: 'manual' });
    }
    resetProxyInput(); renderProxyNodes(); await window.electronAPI.saveSettings(globalSettings);
}

// --- Subscription Management ---
function openSubEditModal(isNew) {
    const modal = document.getElementById('subEditModal');
    const headerTitle = modal.querySelector('.modal-header span'); if (headerTitle) headerTitle.innerText = t('subTitle');
    const labels = modal.querySelectorAll('label'); if (labels[0]) labels[0].innerText = t('subName'); if (labels[1]) labels[1].innerText = t('subUrl'); if (labels[2]) labels[2].innerText = t('subInterval');
    const options = document.getElementById('subInterval').options; options[0].text = t('optDisabled'); options[1].text = t('opt24h'); options[2].text = t('opt72h'); options[3].text = t('optCustom');
    const btnDel = document.getElementById('btnDelSub'); btnDel.innerText = t('btnDelSub'); btnDel.style.display = isNew ? 'none' : 'inline-block';
    const btnSave = modal.querySelector('button[onclick="saveSubscription()"]'); if (btnSave) btnSave.innerText = t('btnSaveUpdate');

    if (isNew) {
        document.getElementById('subId').value = '';
        document.getElementById('subName').value = '';
        document.getElementById('subUrl').value = '';
        document.getElementById('subInterval').value = '24';
        document.getElementById('subCustomInterval').style.display = 'none';
    }
    modal.style.display = 'flex';
    document.getElementById('subInterval').onchange = function () { document.getElementById('subCustomInterval').style.display = this.value === 'custom' ? 'block' : 'none'; }
}

function closeSubEditModal() { document.getElementById('subEditModal').style.display = 'none'; }

function editCurrentSubscription() {
    const sub = globalSettings.subscriptions.find(s => s.id === currentProxyGroup);
    if (!sub) return;
    openSubEditModal(false);
    document.getElementById('subId').value = sub.id;
    document.getElementById('subName').value = sub.name;
    document.getElementById('subUrl').value = sub.url;
    const sel = document.getElementById('subInterval');
    const cust = document.getElementById('subCustomInterval');
    if (['0', '24', '72'].includes(sub.interval)) { sel.value = sub.interval; cust.style.display = 'none'; }
    else { sel.value = 'custom'; cust.style.display = 'block'; cust.value = sub.interval; }
}

async function saveSubscription() {
    const id = document.getElementById('subId').value;
    const name = document.getElementById('subName').value || 'Subscription';
    const url = document.getElementById('subUrl').value.trim();
    let interval = document.getElementById('subInterval').value;
    if (interval === 'custom') interval = document.getElementById('subCustomInterval').value;
    if (!url) return;

    let sub;
    if (id) {
        sub = globalSettings.subscriptions.find(s => s.id === id);
        if (sub) { sub.name = name; sub.url = url; sub.interval = interval; }
    } else {
        function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
        sub = { id: `sub-${Date.now()}`, name, url, interval, lastUpdated: 0 };
        globalSettings.subscriptions.push(sub);
    }
    closeSubEditModal();
    await updateSubscriptionNodes(sub);
    currentProxyGroup = sub.id;
    renderGroupTabs();
    await window.electronAPI.saveSettings(globalSettings);
}

async function deleteSubscription() {
    const id = document.getElementById('subId').value;
    if (!id) return;
    showConfirm(t('confirmDelSub'), async () => {
        globalSettings.subscriptions = globalSettings.subscriptions.filter(s => s.id !== id);
        globalSettings.preProxies = globalSettings.preProxies.filter(p => p.groupId !== id);
        currentProxyGroup = 'manual';
        closeSubEditModal(); renderGroupTabs(); await window.electronAPI.saveSettings(globalSettings);
    });
}

async function updateSubscriptionNodes(sub) {
    try {
        const content = await window.electronAPI.invoke('fetch-url', sub.url);
        let decoded = content;
        try { if (!content.includes('://')) decoded = decodeBase64Content(content); } catch (e) { }
        const lines = decoded.split(/[\r\n]+/);
        globalSettings.preProxies = globalSettings.preProxies.filter(p => p.groupId !== sub.id);
        let count = 0;
        lines.forEach(line => {
            line = line.trim();
            if (line && line.includes('://')) {
                const remark = getProxyRemark(line) || `Node ${count + 1}`;
                function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
                globalSettings.preProxies.push({ id: uuidv4(), remark, url: line, enable: true, groupId: sub.id });
                count++;
            }
        });
        sub.lastUpdated = Date.now();
        showAlert(`${t('msgSubUpdated')} ${sub.name} (${count} ${t('msgNodes')})`);
    } catch (e) {
        showAlert(`${t('msgUpdateFailed')} ${e.message}`);
    }
}

async function testSingleProxy(id) {
    const p = globalSettings.preProxies.find(x => x.id === id);
    if (!p) return;
    const btn = Array.from(document.querySelectorAll('#preProxyList button.outline')).find(el => el.onclick.toString().includes(id));
    if (btn) btn.innerText = "...";
    try {
        const res = await window.electronAPI.invoke('test-proxy-latency', p.url);
        p.latency = res.success ? res.latency : -1;
        renderProxyNodes();
    } catch (e) { console.error(e); }
}

async function testCurrentGroup() {
    const list = (globalSettings.preProxies || []).filter(p => {
        if (currentProxyGroup === 'manual') return !p.groupId || p.groupId === 'manual';
        return p.groupId === currentProxyGroup;
    });
    if (list.length === 0) return;

    // 先将所有测试按钮设置为加载状态
    list.forEach(p => {
        const btn = Array.from(document.querySelectorAll('#preProxyList button.outline')).find(el => el.onclick && el.onclick.toString().includes(p.id));
        if (btn) btn.innerText = "...";
    });

    const promises = list.map(async (p) => {
        const res = await window.electronAPI.invoke('test-proxy-latency', p.url);
        p.latency = res.success ? res.latency : -1;
        return p;
    });
    await Promise.all(promises);
    if (globalSettings.mode === 'single') {
        let best = null, min = 99999;
        list.forEach(p => { if (p.latency > 0 && p.latency < min) { min = p.latency; best = p; } });
        if (best) {
            globalSettings.selectedId = best.id;
            if (document.getElementById('notifySwitch').checked) new Notification('BNC', { body: `Auto-Switched: ${best.remark}` });
        }
    }
    renderProxyNodes();
}

function delP(id) { globalSettings.preProxies = globalSettings.preProxies.filter(p => p.id !== id); renderProxyNodes(); }
function selP(id) { globalSettings.selectedId = id; renderProxyNodes(); }
function togP(id) { const p = globalSettings.preProxies.find(x => x.id === id); if (p) p.enable = !p.enable; }

async function saveProxySettings() {
    globalSettings.mode = document.getElementById('proxyMode').value;
    globalSettings.notify = document.getElementById('notifySwitch').checked;
    await window.electronAPI.saveSettings(globalSettings);
    closeProxyManager(); updateToolbar();
}

function updateToolbar() {
    const enable = document.getElementById('enablePreProxy').checked;
    globalSettings.enablePreProxy = enable;
    window.electronAPI.saveSettings(globalSettings);
    const d = document.getElementById('currentProxyDisplay');
    if (!enable) { d.innerText = "OFF"; d.style.color = "var(--text-secondary)"; d.style.border = "1px solid var(--border)"; return; }
    d.style.color = "var(--accent)"; d.style.border = "1px solid var(--accent)";
    let count = 0;
    if (globalSettings.mode === 'single') count = globalSettings.selectedId ? 1 : 0;
    else count = (globalSettings.preProxies || []).filter(p => p.enable !== false).length;
    let modeText = "";
    if (globalSettings.mode === 'single') modeText = t('modeSingle');
    else if (globalSettings.mode === 'balance') modeText = t('modeBalance');
    else modeText = t('modeFailover');
    d.innerText = `${modeText} [${count}]`;
}

// Export Logic (重构版)
let exportType = '';
let selectedProfileIds = [];
let passwordCallback = null;
let isImportMode = false;

function openExportModal() { document.getElementById('exportModal').style.display = 'flex'; }
function closeExportModal() { document.getElementById('exportModal').style.display = 'none'; }

async function openExportSelectModal(type) {
    exportType = type;
    closeExportModal();

    // 如果是仅导出代理，不需要选择环境
    if (type === 'proxies') {
        try {
            const result = await window.electronAPI.invoke('export-selected-data', { type: 'proxies', profileIds: [] });
            if (result.success) showAlert(t('msgExportSuccess'));
            else if (!result.cancelled) showAlert(result.error || t('msgNoData'));
        } catch (e) { showAlert("Export Failed: " + e.message); }
        return;
    }

    // 获取环境列表
    const profiles = await window.electronAPI.invoke('get-export-profiles');

    if (profiles.length === 0) {
        showAlert(t('expNoProfiles'));
        return;
    }

    // 渲染选择器
    renderExportProfileList(profiles);

    // 默认全选
    selectedProfileIds = profiles.map(p => p.id);
    document.getElementById('exportSelectAll').checked = true;
    updateExportSelectedCount(profiles.length);

    // 更新标题（使用 i18n）
    const titleSpan = document.querySelector('#exportSelectTitle span[data-i18n]');
    const iconSpan = document.querySelector('#exportSelectTitle span:first-child');
    if (type === 'full-backup') {
        if (titleSpan) titleSpan.innerText = t('expSelectTitleFull');
        if (iconSpan) iconSpan.innerText = '🔐';
    } else {
        if (titleSpan) titleSpan.innerText = t('expSelectTitle');
        if (iconSpan) iconSpan.innerText = '📦';
    }

    document.getElementById('exportSelectModal').style.display = 'flex';
}

function closeExportSelectModal() {
    document.getElementById('exportSelectModal').style.display = 'none';
    selectedProfileIds = [];
}

function renderExportProfileList(profiles) {
    const container = document.getElementById('exportProfileList');
    if (!profiles || profiles.length === 0) {
        container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--text-secondary);">
            <div style="font-size: 24px; margin-bottom: 8px;">📭</div>
            <div>${t('expNoProfiles')}</div>
        </div>`;
        return;
    }

    let html = '';
    for (const p of profiles) {
        const tagsHtml = (p.tags || []).map(tag =>
            `<span style="font-size: 9px; padding: 2px 6px; background: ${stringToColor(tag)}22; color: ${stringToColor(tag)}; border-radius: 4px; margin-left: 6px; font-weight: 500;">${tag}</span>`
        ).join('');

        html += `<label style="display: flex; align-items: center; padding: 10px 12px; margin: 4px 0; background: rgba(255,255,255,0.03); border: 1px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;" 
            onmouseover="this.style.background='rgba(0,255,255,0.05)'; this.style.borderColor='var(--accent)';" 
            onmouseout="this.style.background='rgba(255,255,255,0.03)'; this.style.borderColor='transparent';">
            <input type="checkbox" id="export-${p.id}" checked 
                onchange="handleExportCheckboxChange('${p.id}', this.checked)"
                style="width: 18px; height: 18px; margin-right: 12px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name || t('expNoProfiles')}</div>
            </div>
            <div style="display: flex; align-items: center; flex-shrink: 0;">${tagsHtml}</div>
        </label>`;
    }
    container.innerHTML = html;
}

// 处理单个 checkbox 变化
function handleExportCheckboxChange(id, checked) {
    if (checked) {
        if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
    } else {
        selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
    }

    // 更新全选状态
    const allCheckboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    document.getElementById('exportSelectAll').checked = allChecked;

    updateExportSelectedCount(allCheckboxes.length);
}

function toggleExportProfile(id) {
    const checkbox = document.getElementById(`export-${id}`);
    checkbox.checked = !checkbox.checked;

    if (checkbox.checked) {
        if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
    } else {
        selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
    }

    // 更新全选状态
    const allCheckboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    document.getElementById('exportSelectAll').checked = allChecked;

    updateExportSelectedCount(allCheckboxes.length);
}

function toggleExportSelectAll() {
    const selectAll = document.getElementById('exportSelectAll').checked;
    const checkboxes = document.querySelectorAll('#exportProfileList input[type="checkbox"]');

    checkboxes.forEach(cb => {
        cb.checked = selectAll;
        const id = cb.id.replace('export-', '');
        if (selectAll) {
            if (!selectedProfileIds.includes(id)) selectedProfileIds.push(id);
        }
    });

    if (!selectAll) selectedProfileIds = [];

    updateExportSelectedCount(checkboxes.length);
}

function updateExportSelectedCount(total) {
    document.getElementById('exportSelectedCount').innerText = `${selectedProfileIds.length}/${total}`;
}

async function confirmExport() {
    if (selectedProfileIds.length === 0) {
        showAlert('请至少选择一个环境');
        return;
    }

    // 保存选中的 ID（因为 closeExportSelectModal 会清空）
    const idsToExport = [...selectedProfileIds];
    const typeToExport = exportType;

    closeExportSelectModal();

    if (typeToExport === 'full-backup') {
        // 保存到全局变量供密码提交后使用
        selectedProfileIds = idsToExport;
        isImportMode = false;
        openPasswordModal('Đặt mật khẩu sao lưu', true);
    } else {
        // 直接导出
        try {
            const result = await window.electronAPI.invoke('export-selected-data', {
                type: typeToExport,
                profileIds: idsToExport
            });
            if (result.success) {
                showAlert(`Xuất dữ liệu thành công! ${result.count} profile.`);
            } else if (!result.cancelled) {
                showAlert(result.error || t('msgNoData'));
            }
        } catch (e) {
            showAlert("Export Failed: " + e.message);
        }
    }
}

// 密码模态框
function openPasswordModal(title, showConfirm) {
    document.getElementById('passwordModalTitle').innerText = title;
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupPasswordConfirm').value = '';

    // 导入时不需要确认密码
    const confirmLabel = document.getElementById('confirmPasswordLabel');
    const confirmInput = document.getElementById('backupPasswordConfirm');
    if (showConfirm) {
        confirmLabel.style.display = 'block';
        confirmInput.style.display = 'block';
    } else {
        confirmLabel.style.display = 'none';
        confirmInput.style.display = 'none';
    }

    document.getElementById('passwordModal').style.display = 'flex';
    document.getElementById('backupPassword').focus();
}

function closePasswordModal() {
    document.getElementById('passwordModal').style.display = 'none';
    passwordCallback = null;
}

async function submitPassword() {
    const password = document.getElementById('backupPassword').value;
    const confirmPassword = document.getElementById('backupPasswordConfirm').value;

    if (!password) {
        showAlert('Vui lòng nhập mật khẩu');
        return;
    }

    if (!isImportMode && password !== confirmPassword) {
        showAlert('Hai mật khẩu không khớp');
        return;
    }

    if (password.length < 4) {
        showAlert('Mật khẩu phải có ít nhất 4 ký tự');
        return;
    }

    closePasswordModal();

    if (isImportMode) {
        // 导入完整备份
        try {
            const result = await window.electronAPI.invoke('import-full-backup', { password });
            if (result.success) {
                showAlert(`Nhập dữ liệu thành công! ${result.count} profile đã được khôi phục.`);
                loadProfiles();
                globalSettings = await window.electronAPI.getSettings();
                renderGroupTabs();
                updateToolbar();
            } else if (!result.cancelled) {
                showAlert(result.error || 'Nhập dữ liệu thất bại');
            }
        } catch (e) {
            showAlert("Import Failed: " + e.message);
        }
    } else {
        // Export full backup
        try {
            const result = await window.electronAPI.invoke('export-full-backup', {
                profileIds: selectedProfileIds,
                password
            });
            if (result.success) {
                showAlert(`Backup thành công! ${result.count} profile đã được xuất.`);
            } else if (!result.cancelled) {
                showAlert(result.error || 'Backup thất bại');
            }
        } catch (e) {
            showAlert("Backup Failed: " + e.message);
        }
    }
}

// Import Logic
async function importData() {
    try {
        const result = await window.electronAPI.invoke('import-data');
        if (result) {
            globalSettings = await window.electronAPI.getSettings();
            if (!globalSettings.preProxies) globalSettings.preProxies = [];
            if (!globalSettings.subscriptions) globalSettings.subscriptions = [];
            loadProfiles(); renderGroupTabs(); updateToolbar();
            showAlert(t('msgImportSuccess'));
        }
    } catch (e) { showAlert("Import Failed: " + e.message); }
}

// 导入完整备份（.geekez 文件）
async function importFullBackup() {
    isImportMode = true;
    openPasswordModal('Nhập mật khẩu backup', false);
}

// Import Menu Toggle
function toggleImportMenu() {
    const menu = document.getElementById('importMenu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function closeImportMenu() {
    document.getElementById('importMenu').style.display = 'none';
}

// 点击其他地方关闭菜单
document.addEventListener('click', (e) => {
    const menu = document.getElementById('importMenu');
    const btn = document.getElementById('importBtn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.style.display = 'none';
    }
});

function openImportSub() { showInput(t('importSubTitle'), importSubscription); }
async function importSubscription(url) {
    if (!url) return;
    try {
        const content = await window.electronAPI.invoke('fetch-url', url);
        if (!content) return showAlert(t('subErr'));
        let decoded = content;
        try { if (!content.includes('://')) decoded = decodeBase64Content(content); } catch (e) { }
        const lines = decoded.split(/[\r\n]+/);
        let count = 0;
        if (!globalSettings.preProxies) globalSettings.preProxies = [];
        const groupId = `group-${Date.now()}`;
        const groupName = `Sub ${new Date().toLocaleTimeString()}`;
        lines.forEach(line => {
            line = line.trim();
            if (line && line.includes('://')) {
                const remark = getProxyRemark(line) || `Node ${count + 1}`;
                function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); }
                globalSettings.preProxies.push({
                    id: uuidv4(), remark, url: line, enable: true, groupId, groupName
                });
                count++;
            }
        });
        renderProxyNodes(); await window.electronAPI.saveSettings(globalSettings);
        showAlert(`${t('msgImported')} ${count} ${t('msgNodes')}`);
    } catch (e) { showAlert(t('subErr') + " " + e); }
}

function switchHelpTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const idx = tabName === 'manual' ? 0 : 1;
    const tabs = document.querySelectorAll('#helpModal .tab-btn');
    if (tabs[idx]) tabs[idx].classList.add('active');
    document.querySelectorAll('.help-section').forEach(el => el.classList.remove('active'));
    document.getElementById(`help-${tabName}`).classList.add('active');
}
// ============================================================================
// Settings Modal Functions
// ============================================================================
async function showSettingsPage() {
    _switchPage('settingsPage', 'nav-settings');
    try {
        const packaged = await window.electronAPI.isPackaged();
        if (packaged) {
            switchSettingsTab('license');
        } else {
            loadUserExtensions();
            loadWatermarkStyle();
            loadRemoteDebuggingSetting();
            loadCustomArgsSetting();
            loadApiServerSetting();
            loadDataPathSetting();
            loadDefaultProxySetting();
        }
    } catch (_) {
        loadUserExtensions();
        loadWatermarkStyle();
        loadRemoteDebuggingSetting();
        loadCustomArgsSetting();
        loadApiServerSetting();
        loadDataPathSetting();
        loadDefaultProxySetting();
    }
}
async function openSettings() { await showSettingsPage(); }
function closeSettings() { showProfilesPage(); }

// Watermark Style Functions
function loadWatermarkStyle() {
    const style = localStorage.getItem('geekez_watermark_style') || 'enhanced';
    const radios = document.getElementsByName('watermarkStyle');
    radios.forEach(radio => {
        if (radio.value === style) {
            radio.checked = true;
            radio.parentElement.style.borderColor = 'var(--accent)';
        } else {
            radio.parentElement.style.borderColor = 'var(--border)';
        }
    });
}

function saveWatermarkStyle(style) {
    localStorage.setItem('geekez_watermark_style', style);
    const radios = document.getElementsByName('watermarkStyle');
    radios.forEach(radio => {
        if (radio.checked) {
            radio.parentElement.style.borderColor = 'var(--accent)';
        } else {
            radio.parentElement.style.borderColor = 'var(--border)';
        }
    });
    showAlert('水印样式已保存，重启环境后生效');
}

// --- 自定义数据目录 ---
async function loadDataPathSetting() {
    try {
        const info = await window.electronAPI.invoke('get-data-path-info');
        // Update cả tab Advanced lẫn tab License
        ['currentDataPath', 'currentDataPath2'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = info.currentPath;
        });
        ['resetDataPathBtn', 'resetDataPathBtn2'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = info.isCustom ? 'inline-block' : 'none';
        });
    } catch (e) {
        console.error('[DataPath] Failed:', e);
        ['currentDataPath', 'currentDataPath2'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = 'Lỗi: ' + e.message;
        });
    }
}

async function selectDataDirectory() {
    const newPath = await window.electronAPI.invoke('select-data-directory');
    if (!newPath) return;

    // 确认迁移
    const migrate = confirm(t('dataPathConfirmMigrate') || '是否将现有数据迁移到新目录？\n\n选择"确定"迁移数据\n选择"取消"仅更改路径（不迁移）');

    showAlert(t('dataPathMigrating') || '正在迁移数据，请稍候...');

    const result = await window.electronAPI.invoke('set-data-directory', { newPath, migrate });

    if (result.success) {
        ['currentDataPath', 'currentDataPath2'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = newPath;
        });
        ['resetDataPathBtn', 'resetDataPathBtn2'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'inline-block';
        });
        ['dataPathWarning'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
        const warnLicense = document.getElementById('licenseDataPathWarning');
        if (warnLicense) warnLicense.style.display = 'inline';
        showAlert(t('dataPathSuccess') || 'Đã đổi thư mục, vui lòng khởi động lại');
    } else {
        showAlert((t('dataPathError') || 'Thao tác thất bại: ') + result.error);
    }
}

async function resetDataDirectory() {
    if (!confirm(t('dataPathConfirmReset') || 'Đặt lại thư mục dữ liệu mặc định?\n\nLưu ý: Dữ liệu từ thư mục tùy chỉnh sẽ không được di chuyển.')) {
        return;
    }

    const result = await window.electronAPI.invoke('reset-data-directory');

    if (result.success) {
        const info = await window.electronAPI.invoke('get-data-path-info');
        ['currentDataPath', 'currentDataPath2'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = info.defaultPath;
        });
        ['resetDataPathBtn', 'resetDataPathBtn2'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        const warn = document.getElementById('dataPathWarning');
        if (warn) warn.style.display = 'block';
        showAlert(t('dataPathResetSuccess') || 'Đã khôi phục mặc định, vui lòng khởi động lại');
    } else {
        showAlert((t('dataPathError') || 'Thao tác thất bại: ') + result.error);
    }
}

async function saveRemoteDebuggingSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableRemoteDebugging = enabled;
    await window.electronAPI.saveSettings(settings);
    showAlert(enabled ? '远程调试已启用，编辑环境时可设置端口' : '远程调试已禁用');
}

// Unified toggle handler for developer features
function handleDevToggle(checkbox) {
    const toggleSwitch = checkbox.closest('.toggle-switch');
    const track = toggleSwitch?.querySelector('.toggle-track');
    const knob = toggleSwitch?.querySelector('.toggle-knob');

    // Animate toggle - update track color and knob position
    if (track) {
        track.style.background = checkbox.checked ? 'var(--accent)' : 'var(--border)';
    }
    if (knob) {
        knob.style.left = checkbox.checked ? '22px' : '2px';
    }

    // Call appropriate save function based on checkbox id
    if (checkbox.id === 'enableRemoteDebugging') {
        saveRemoteDebuggingSetting(checkbox.checked);
    } else if (checkbox.id === 'enableCustomArgs') {
        saveCustomArgsSetting(checkbox.checked);
    } else if (checkbox.id === 'enableApiServer') {
        saveApiServerSetting(checkbox.checked);
    }
}

// Update toggle visual state (for loading saved state)
function updateToggleVisual(checkbox) {
    const toggleSwitch = checkbox.closest('.toggle-switch');
    const track = toggleSwitch?.querySelector('.toggle-track');
    const knob = toggleSwitch?.querySelector('.toggle-knob');

    if (track) {
        track.style.background = checkbox.checked ? 'var(--accent)' : 'var(--border)';
    }
    if (knob) {
        knob.style.left = checkbox.checked ? '22px' : '2px';
    }
}

async function loadRemoteDebuggingSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableRemoteDebugging');
    if (checkbox) {
        checkbox.checked = settings.enableRemoteDebugging || false;
        updateToggleVisual(checkbox);
    }
}

async function loadDefaultProxySetting() {
    const settings = await window.electronAPI.getSettings();
    const input = document.getElementById('defaultProxy');
    if (input) input.value = settings.defaultProxy || '';
}

async function saveDefaultProxy() {
    const input = document.getElementById('defaultProxy');
    if (!input) return;
    const settings = await window.electronAPI.getSettings();
    settings.defaultProxy = input.value.trim();
    await window.electronAPI.saveSettings(settings);
    showAlert('✅ Đã lưu proxy mặc định');
}

// Custom Args Settings
async function saveCustomArgsSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableCustomArgs = enabled;
    await window.electronAPI.saveSettings(settings);
    showAlert(enabled ? t('customArgsEnabled') || '自定义启动参数已启用' : t('customArgsDisabled') || '自定义启动参数已禁用');
}

async function loadCustomArgsSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableCustomArgs');
    if (checkbox) {
        checkbox.checked = settings.enableCustomArgs || false;
        updateToggleVisual(checkbox);
    }
}

// API Server Settings
async function saveApiServerSetting(enabled) {
    const settings = await window.electronAPI.getSettings();
    settings.enableApiServer = enabled;
    await window.electronAPI.saveSettings(settings);

    // Show/hide port section
    document.getElementById('apiPortSection').style.display = enabled ? 'block' : 'none';

    if (enabled) {
        // Start API server
        const port = settings.apiPort || 12138;
        const result = await window.electronAPI.invoke('start-api-server', { port });
        if (result.success) {
            document.getElementById('apiStatus').style.display = 'inline-block';
            showAlert(`${t('apiStarted') || 'API 服务已启动'}: http://localhost:${port}`);
        } else {
            showAlert((t('apiError') || 'API 启动失败: ') + result.error);
        }
    } else {
        // Stop API server
        await window.electronAPI.invoke('stop-api-server');
        document.getElementById('apiStatus').style.display = 'none';
        showAlert(t('apiStopped') || 'API 服务已停止');
    }
}

async function saveApiPort() {
    const port = parseInt(document.getElementById('apiPortInput').value) || 12138;
    if (port < 1024 || port > 65535) {
        showAlert(t('apiPortInvalid') || '端口号必须在 1024-65535 之间');
        return;
    }

    const settings = await window.electronAPI.getSettings();
    settings.apiPort = port;
    await window.electronAPI.saveSettings(settings);
    document.getElementById('apiPortDisplay').textContent = port;

    // Restart API server if enabled
    if (settings.enableApiServer) {
        await window.electronAPI.invoke('stop-api-server');
        const result = await window.electronAPI.invoke('start-api-server', { port });
        if (result.success) {
            showAlert(`${t('apiRestarted') || 'API 服务已重启'}: http://localhost:${port}`);
        }
    } else {
        showAlert(t('apiPortSaved') || 'API 端口已保存');
    }
}

async function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value.trim();
    const settings = await window.electronAPI.getSettings();
    settings.apiKey = key || null;
    await window.electronAPI.saveSettings(settings);
    showAlert(key ? 'API key saved. Restart API server to apply.' : 'API key cleared (no auth).');
}

function generateApiKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    for (let i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('apiKeyInput').value = key;
}

async function loadApiServerSetting() {
    const settings = await window.electronAPI.getSettings();
    const checkbox = document.getElementById('enableApiServer');
    const portInput = document.getElementById('apiPortInput');
    const portDisplay = document.getElementById('apiPortDisplay');
    const portSection = document.getElementById('apiPortSection');
    const apiStatus = document.getElementById('apiStatus');
    const apiKeyInput = document.getElementById('apiKeyInput');

    if (checkbox) {
        checkbox.checked = settings.enableApiServer || false;
        updateToggleVisual(checkbox);
    }
    if (portInput) {
        portInput.value = settings.apiPort || 12138;
    }
    if (portDisplay) {
        portDisplay.textContent = settings.apiPort || 12138;
    }
    if (portSection) {
        portSection.style.display = settings.enableApiServer ? 'block' : 'none';
    }
    if (apiKeyInput) {
        apiKeyInput.value = settings.apiKey || '';
    }

    // Check if API is running
    try {
        const status = await window.electronAPI.invoke('get-api-status');
        if (apiStatus) {
            apiStatus.style.display = status.running ? 'inline-block' : 'none';
        }
    } catch (e) { }
}

function openApiDocs() {
    window.electronAPI.invoke('open-url', 'https://browser.geekez.net/docs.html#doc-api');
}

function switchSettingsTab(tabName, clickedBtn) {
    // Update tab buttons — dùng tham số thay vì event.target để gọi được từ code
    document.querySelectorAll('#settingsPage .tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = clickedBtn || document.querySelector(`#settingsPage .tab-btn[onclick*="'${tabName}'"]`);
    if (activeBtn) activeBtn.classList.add('active');

    // Update tab content
    document.querySelectorAll('.settings-section').forEach(section => {
        section.style.display = 'none';
    });
    document.getElementById('settings-' + tabName).style.display = 'block';
    if (tabName === 'chrome') loadChromePath();
    if (tabName === 'license') { loadBncDevices(); loadDataPathSetting(); }
    if (tabName === 'advanced') loadDataPathSetting();
}
// ============================================================================
// Extension Management Functions
// ============================================================================
async function loadChromePath() {
    const info = await window.electronAPI.getChromePath();
    const el = document.getElementById('chrome-path-display');
    if (el) el.textContent = info.current || 'Not found';
    checkCft();
}

async function checkCft() {
    const statusEl = document.getElementById('cft-status');
    const btnEl = document.getElementById('cft-btn');
    if (!statusEl) return;
    try {
        const result = await window.electronAPI.checkChromeForTesting();
        if (result.installed) {
            statusEl.textContent = `Installed — v${result.version}`;
            statusEl.style.color = 'var(--success, #22c55e)';
            if (btnEl) { btnEl.textContent = 'Update'; btnEl.disabled = false; }
        } else {
            // Check if app is currently using bundled CfT (from resources/puppeteer/)
            try {
                const pathInfo = await window.electronAPI.invoke('get-chrome-path-info');
                const activePath = (pathInfo?.current || '').replace(/\\/g, '/');
                if (activePath.includes('puppeteer') && activePath.includes('Google Chrome for Testing')) {
                    // Extract version from path e.g. mac_arm-143.0.7499.169
                    const m = activePath.match(/[\-_]([\d]+\.[\d]+\.[\d]+\.[\d]+)/);
                    const ver = m ? m[1] : '';
                    statusEl.textContent = `Bundled${ver ? ' — v' + ver : ''} (dùng sẵn trong app)`;
                    statusEl.style.color = 'var(--success, #22c55e)';
                    if (btnEl) { btnEl.textContent = 'Update'; btnEl.disabled = false; }
                    return;
                }
            } catch (_) {}
            statusEl.textContent = 'Not installed';
            statusEl.style.color = '';
            if (btnEl) { btnEl.textContent = 'Download'; btnEl.disabled = false; }
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Check failed';
    }
}

let _cftProgressListenerAttached = false;
async function downloadCft() {
    const btn = document.getElementById('cft-btn');
    const wrap = document.getElementById('cft-progress-wrap');
    const bar = document.getElementById('cft-bar');
    const txt = document.getElementById('cft-progress-text');
    const statusEl = document.getElementById('cft-status');

    if (btn) btn.disabled = true;
    if (wrap) wrap.style.display = 'block';
    if (bar) bar.style.width = '0%';
    if (txt) txt.textContent = 'Starting...';

    if (!_cftProgressListenerAttached) {
        _cftProgressListenerAttached = true;
        window.electronAPI.onCftProgress((data) => {
            if (bar) bar.style.width = Math.max(0, data.percent) + '%';
            if (txt) txt.textContent = data.stage;
            if (data.percent === 100) {
                if (btn) { btn.textContent = 'Update'; btn.disabled = false; }
                if (statusEl) { statusEl.textContent = 'Installed'; statusEl.style.color = 'var(--success, #22c55e)'; }
                setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 3000);
                loadChromePath();
            } else if (data.percent < 0) {
                if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
            }
        });
    }

    try {
        await window.electronAPI.downloadChromeForTesting();
    } catch (e) {
        if (txt) txt.textContent = 'Download failed: ' + e.message;
        if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
    }
}


async function selectChromeBinary() {
    const result = await window.electronAPI.selectChromeBinary();
    if (result) { showAlert('Chrome binary set: ' + result); loadChromePath(); }
}

async function clearChromeBinary() {
    await window.electronAPI.clearChromeBinary();
    showAlert('Reset to default Chrome binary.');
    loadChromePath();
}

async function selectExtensionFolder() {
    const path = await window.electronAPI.invoke('select-extension-folder');
    if (path) {
        await window.electronAPI.invoke('add-user-extension', path);
        await loadUserExtensions();
        showAlert(t('settingsExtAdded'));
    }
}
async function loadUserExtensions() {
    const exts = await window.electronAPI.invoke('get-user-extensions');
    const list = document.getElementById('userExtensionList');
    if (!list) return;

    if (exts.length === 0) {
        list.innerHTML = `<div style="opacity:0.5; text-align:center; padding:20px;">${t('settingsExtNoExt')}</div>`;
        return;
    }

    list.innerHTML = exts.map(ext => {
        const name = ext.split(/[\\/]/).pop();
        return `
            <div class="ext-item">
                <div>
                    <div style="font-weight:bold;">${name}</div>
                    <div style="font-size:11px; opacity:0.6;">${ext}</div>
                </div>
                <button class="danger outline" onclick="removeUserExtension('${ext.replace(/\\/g, '\\\\')}')" style="padding:4px 12px; font-size:11px;">${t('settingsExtRemove')}</button>
            </div>
        `;
    }).join('');
}
async function removeUserExtension(path) {
    await window.electronAPI.invoke('remove-user-extension', path);
    await loadUserExtensions();
    showAlert(t('settingsExtRemoved'));
}
function openHelp() { switchHelpTab('manual'); document.getElementById('helpModal').style.display = 'flex'; } // flex
function closeHelp() { document.getElementById('helpModal').style.display = 'none'; }


// Custom timezone dropdown initialization
function initCustomTimezoneDropdown(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    if (!input || !dropdown || !window.TIMEZONES) return;

    let selectedIndex = -1;

    // Populate dropdown with all timezones
    function populateDropdown(filter = '') {
        const filtered = window.TIMEZONES.filter(tz =>
            tz.toLowerCase().includes(filter.toLowerCase())
        );

        dropdown.innerHTML = filtered.map((tz, index) =>
            `<div class="timezone-item" data-value="${tz}" data-index="${index}">${tz}</div>`
        ).join('');

        selectedIndex = -1;
    }



    // Hide dropdown
    function hideDropdown() {
        dropdown.classList.remove('active');
        selectedIndex = -1;
    }

    // Select item
    function selectItem(value) {
        input.value = value;
        hideDropdown();
    }

    // Input focus - show dropdown (Show ALL options, ignore current value filter)
    input.addEventListener('focus', () => {
        populateDropdown('');
        dropdown.classList.add('active');
    });

    // Input typing - filter
    input.addEventListener('input', () => {
        populateDropdown(input.value);
        if (!dropdown.classList.contains('active')) {
            dropdown.classList.add('active');
        }
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.timezone-item:not(.hidden)');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex].dataset.value);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    // Update selection highlight
    function updateSelection(items) {
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === selectedIndex);
        });
        if (items[selectedIndex]) {
            items[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    // Click on item
    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.timezone-item');
        if (item) {
            selectItem(item.dataset.value);
        }
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            hideDropdown();
        }
    });
}
init();

// ============================================================================
// Auto-Verify Feature
// ============================================================================
(function() {
    const s = document.createElement('style');
    s.textContent = '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
})();

let verifyProgressHandler = null;

function openVerifyModal(profileId) {
    // Create modal if not exists
    let modal = document.getElementById('verify-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'verify-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--bg-card, #1e1e2e);border:1px solid var(--border,#333);border-radius:12px;padding:24px;width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <h3 style="margin:0;font-size:16px;">Auto Verify Fingerprint</h3>
                    <button onclick="closeVerifyModal()" style="background:none;border:none;color:var(--text,#ccc);font-size:20px;cursor:pointer;padding:0 4px;">&times;</button>
                </div>
                <div id="verify-body"></div>
                <div style="margin-top:16px;text-align:right;">
                    <button onclick="closeVerifyModal()" class="outline">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    modal.style.display = 'flex';
    const body = document.getElementById('verify-body');
    body.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.7;">Starting verification...</div>';

    // Track sites
    const siteState = {
        pixelscan:   { name: 'Pixelscan',                 status: 'pending' },
        sannysoft:   { name: 'Bot Detection (Sannysoft)',  status: 'pending' },
        scamalytics: { name: 'Scamalytics IP Score',       status: 'pending' }
    };

    function renderBody() {
        body.innerHTML = Object.entries(siteState).map(([id, s]) => {
            const icon = s.status === 'pending'  ? '⏳'
                       : s.status === 'loading'  ? '<span style="animation:spin 1s linear infinite;display:inline-block">⟳</span>'
                       : s.status === 'error'    ? '❌'
                       :                           '✅';

            let detail = '';
            if (s.status === 'done') {
                if (id === 'pixelscan') {
                    const badge = (v, good, bad) => {
                        const color = v === good ? '#22c55e' : v === bad ? '#ef4444' : '#f59e0b';
                        return `<span style="background:${color}22;color:${color};border:1px solid ${color}44;border-radius:4px;padding:1px 6px;font-size:11px;">${v}</span>`;
                    };
                    detail = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                        ${badge(s.masking,   'pass', 'fail')} Masking
                        ${badge(s.bot,       'pass', 'fail')} Bot
                        ${badge(s.proxy,     'pass', 'fail')} Proxy
                        ${badge(s.consistent,'pass', 'warn')} Consistent
                    </div>`;
                    if (s.webgl) detail += `<div style="margin-top:4px;font-size:11px;opacity:0.6;">GPU: ${s.webgl}</div>`;
                } else if (id === 'sannysoft') {
                    const checks = s.checks || {};
                    const entries = Object.entries(checks).slice(0, 8);
                    if (entries.length) {
                        detail = `<div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px;">
                            ${entries.map(([k,v]) => `<span>${v.pass ? '✅' : '❌'} ${k}</span>`).join('')}
                        </div>`;
                    }
                } else if (id === 'scamalytics') {
                    if (s.score !== null) {
                        const color = s.score < 30 ? '#22c55e' : s.score < 60 ? '#f59e0b' : '#ef4444';
                        detail = `<div style="margin-top:6px;">
                            <span style="font-size:20px;font-weight:bold;color:${color}">${s.score}</span>
                            <span style="opacity:0.6;font-size:12px;"> / 100 fraud score</span>
                            ${s.risk ? `<span style="margin-left:8px;color:${color}">${s.risk}</span>` : ''}
                        </div>`;
                    }
                }
            } else if (s.status === 'error') {
                detail = `<div style="margin-top:4px;font-size:11px;color:#ef4444;opacity:0.8;">${s.error}</div>`;
            }

            return `<div style="padding:12px;border:1px solid var(--border,#333);border-radius:8px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:16px;">${icon}</span>
                    <strong style="font-size:13px;">${s.name}</strong>
                </div>
                ${detail}
            </div>`;
        }).join('');
    }

    renderBody();

    // Listen for progress events
    if (verifyProgressHandler) {
        // Remove old listener by re-registering (simplest approach)
    }
    verifyProgressHandler = (data) => {
        if (siteState[data.id]) {
            Object.assign(siteState[data.id], data);
        }
        renderBody();
    };
    window.electronAPI.onVerifyProgress(verifyProgressHandler);

    // Run verification
    window.electronAPI.verifyProfile(profileId).then(result => {
        if (result.error) {
            body.innerHTML = `<div style="color:#ef4444;padding:16px;">${result.error}</div>`;
        } else {
            // Merge final results (in case progress missed something)
            if (result.results) {
                Object.entries(result.results).forEach(([id, data]) => {
                    if (siteState[id]) Object.assign(siteState[id], data);
                });
            }
            renderBody();
        }
    }).catch(e => {
        body.innerHTML = `<div style="color:#ef4444;padding:16px;">Error: ${e.message}</div>`;
    });
}

function closeVerifyModal() {
    const modal = document.getElementById('verify-modal');
    if (modal) modal.style.display = 'none';
}

// ==================== Profile Groups ====================

async function loadGroups() {
    allGroups = await window.electronAPI.getGroups();
    renderGroupFilter();
}

function renderGroupFilter() {
    const sel = document.getElementById('groupFilterSelect');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Groups</option>' +
        '<option value="__none__">No Group</option>' +
        allGroups.map(g => `<option value="${g.id}">${g.name} </option>`).join('');
    sel.value = prev || '';
}

function filterByGroup(groupId) {
    currentGroupFilter = groupId;
    loadProfiles();
}

function openGroupManager() {
    showGroupsPage();
}

function closeGroupManager() {
    showProfilesPage();
}

function renderGroupManagerList() {
    const container = document.getElementById('groupList');
    if (!container) return;
    if (allGroups.length === 0) {
        container.innerHTML = '<div style="text-align:center;opacity:0.45;padding:24px;font-size:13px;">No groups yet. Create one above.</div>';
        return;
    }
    container.innerHTML = allGroups.map(g => {
        const syncDot = g.synced === true
            ? `<span title="Đã sync lên yttool.vn" style="font-size:11px;color:#22c55e;flex-shrink:0;">✔</span>`
            : `<span title="Chưa sync — click để thử lại" style="font-size:11px;color:#f59e0b;cursor:pointer;flex-shrink:0;" onclick="syncGroupNow('${g.id}')">↺</span>`;
        return `
        <div style="display:flex;align-items:center;padding:9px 4px;border-bottom:1px solid var(--border);gap:8px;"
             onmouseover="this.style.background='rgba(128,128,128,0.06)'" onmouseout="this.style.background='transparent'">
            <span style="font-size:14px;opacity:0.7;">📁</span>
            <span id="group-name-${g.id}" style="flex:1;font-size:13px;color:var(--text-color);">${g.name}</span>
            ${syncDot}
            <div style="display:flex;gap:4px;flex-shrink:0;">
                <button onclick="editGroupInline('${g.id}')"
                    style="background:transparent;border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;color:var(--text-color);"
                    onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">✏️ Rename</button>
                <button onclick="deleteGroupConfirm('${g.id}','${g.name.replace(/'/g,"\\'")}')"
                    style="background:transparent;border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;color:#ef4444;"
                    onmouseover="this.style.borderColor='#ef4444'" onmouseout="this.style.borderColor='var(--border)'">🗑️</button>
            </div>
        </div>`;
    }).join('');
}

async function syncGroupNow(groupId) {
    const group = allGroups.find(g => g.id === groupId);
    if (!group) return;
    try {
        await window.electronAPI.syncGroup(groupId);
        await loadGroups();
        renderGroupManagerList();
    } catch (e) {
        console.error('[syncGroupNow] failed:', e);
    }
}

async function addGroup() {
    const input = document.getElementById('newGroupInput');
    const name = input.value.trim();
    if (!name) return;
    await window.electronAPI.saveGroup({ name });
    input.value = '';
    await loadGroups();
    renderGroupManagerList();
}

function editGroupInline(id) {
    const span = document.getElementById('group-name-' + id);
    if (!span) return;
    const group = allGroups.find(g => g.id === id);
    span.innerHTML = `<input id="edit-g-${id}" value="${group.name}"
        style="font-size:13px;padding:4px 8px;width:100%;border:1px solid var(--accent);border-radius:4px;background:var(--card-bg);color:var(--text-color);outline:none;box-sizing:border-box;"
        onblur="saveGroupEdit('${id}')" onkeydown="if(event.key==='Enter')saveGroupEdit('${id}');if(event.key==='Escape')renderGroupManagerList();">`;
    document.getElementById('edit-g-' + id).focus();
}

async function saveGroupEdit(id) {
    const input = document.getElementById('edit-g-' + id);
    if (!input) return;
    const name = input.value.trim();
    if (!name) { renderGroupManagerList(); return; }
    await window.electronAPI.updateGroup({ id, name });
    await loadGroups();
    renderGroupManagerList();
}

function deleteGroupConfirm(id, name) {
    showConfirm(`Delete group "${name}"? Profiles in this group will be unassigned.`, async () => {
        await window.electronAPI.deleteGroup(id);
        await loadGroups();
        renderGroupManagerList();
        loadProfiles();
    });
}

// Assign profile to group
function openAssignGroup(profileId) {
    assignGroupProfileId = profileId;
    const sel = document.getElementById('assignGroupSelect');
    const profile = window._cachedProfiles && window._cachedProfiles.find(p => p.id === profileId);
    sel.innerHTML = '<option value="">Default (No Group)</option>' +
        allGroups.map(g => `<option value="${g.id}" ${profile && profile.groupId === g.id ? 'selected' : ''}>${g.name}</option>`).join('');
    document.getElementById('assignGroupModal').style.display = 'flex';
}

function closeAssignGroup() {
    document.getElementById('assignGroupModal').style.display = 'none';
    assignGroupProfileId = null;
}

async function confirmAssignGroup() {
    if (!assignGroupProfileId) return;
    const groupId = document.getElementById('assignGroupSelect').value || null;
    await window.electronAPI.assignProfileGroup(assignGroupProfileId, groupId);
    closeAssignGroup();
    await loadProfiles();
}

// ── Bulk Profile Selection ────────────────────────────────────────────────────
function _onProfileCheckboxChange(id, checked) {
    if (checked) _selectedProfileIds.add(id);
    else _selectedProfileIds.delete(id);
    _updateBulkBar();
}

function _updateBulkBar() {
    const bar = document.getElementById('bulkActionBar');
    const label = document.getElementById('bulkCountLabel');
    if (!bar) return;
    const count = _selectedProfileIds.size;
    if (count === 0) {
        bar.style.display = 'none';
    } else {
        bar.style.display = 'flex';
        if (label) label.textContent = `Đã chọn ${count} profile`;
    }
}

function _clearProfileSelection() {
    _selectedProfileIds.clear();
    document.querySelectorAll('.profile-select-cb').forEach(cb => cb.checked = false);
    _updateBulkBar();
}

async function _bulkMoveToGroup() {
    if (_selectedProfileIds.size === 0) return;
    const options = [{ id: '', name: '(Không thuộc nhóm nào)' }, ...allGroups];
    // Build a simple modal
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:var(--bg-color);border:1px solid var(--accent);border-radius:10px;padding:20px;min-width:280px;max-width:360px;">
            <div style="font-size:14px;font-weight:700;margin-bottom:14px;color:var(--text-primary);">Chuyển ${_selectedProfileIds.size} profile vào nhóm</div>
            <select id="_bulkGroupSelect" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg);color:var(--text-primary);margin-bottom:14px;">
                ${options.map(g => `<option value="${g.id}">📁 ${g.name}</option>`).join('')}
            </select>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="_bulkGroupCancel" style="padding:6px 16px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);border-radius:6px;cursor:pointer;font-size:13px;">Hủy</button>
                <button id="_bulkGroupConfirm" style="padding:6px 18px;background:var(--accent);border:none;color:var(--bg-color);border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Chuyển</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const chosen = await new Promise(resolve => {
        overlay.querySelector('#_bulkGroupCancel').onclick = () => { overlay.remove(); resolve(null); };
        overlay.querySelector('#_bulkGroupConfirm').onclick = () => {
            const val = overlay.querySelector('#_bulkGroupSelect').value;
            overlay.remove();
            resolve(val || null);
        };
        overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });

    if (chosen === null) return; // cancelled
    const groupId = chosen === '' ? null : chosen;
    const ids = [..._selectedProfileIds];
    for (const profileId of ids) {
        await window.electronAPI.assignProfileGroup(profileId, groupId);
    }
    _clearProfileSelection();
    await loadProfiles();
}

// ============================================================================
// Device Management (BNC)
// ============================================================================
async function loadBncDevices() {
    const deviceIdEl = document.getElementById('licenseDeviceId');
    const listEl = document.getElementById('bncDevicesList');
    const maxEl = document.getElementById('bncMaxDevices');

    try {
        const { deviceId } = await window.electronAPI.licenseGetStatus();
        if (deviceIdEl) deviceIdEl.textContent = deviceId || '-';

        const result = await window.electronAPI.invoke('bnc-get-sessions');
        if (!result || result.error) {
            if (listEl) listEl.innerHTML = '<div style="color:#aaa;font-size:.85rem;padding:8px 0">Chưa đăng nhập hoặc không thể tải danh sách thiết bị.</div>';
            return;
        }

        const { sessions = [], maxDevices = 1, currentDeviceId } = result;

        if (maxEl) maxEl.textContent = `${sessions.length} / ${maxDevices} thiết bị`;

        if (!listEl) return;
        if (sessions.length === 0) {
            listEl.innerHTML = '<div style="color:#aaa;font-size:.85rem;padding:8px 0">Chưa có thiết bị nào đăng nhập.</div>';
            return;
        }

        listEl.innerHTML = sessions.map(s => {
            const isCurrent = s.deviceId === currentDeviceId;
            const lastSeen = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString('vi-VN') : '-';
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${isCurrent ? 'rgba(76,175,80,0.08)' : 'rgba(255,255,255,0.04)'};border-radius:8px;margin-bottom:6px;border:1px solid ${isCurrent ? 'rgba(76,175,80,0.25)' : 'rgba(255,255,255,0.08)'}">
                <div style="flex:1;min-width:0">
                  <div style="font-size:.88rem;font-weight:600;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.deviceName || s.deviceId}</div>
                  <div style="font-size:.75rem;color:#888;margin-top:2px">${s.platform || ''} · Hoạt động: ${lastSeen}</div>
                </div>
                ${isCurrent
                    ? '<span style="font-size:.75rem;background:rgba(76,175,80,0.2);color:#4CAF50;padding:3px 8px;border-radius:12px;white-space:nowrap">Thiết bị này</span>'
                    : `<button onclick="kickBncDevice('${s.deviceId}')" style="padding:5px 12px;border-radius:6px;border:1px solid rgba(244,67,54,0.4);background:rgba(244,67,54,0.1);color:#f44336;font-size:.78rem;cursor:pointer">Đăng xuất</button>`
                }
              </div>`;
        }).join('');
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div style="color:#f44336;font-size:.85rem;padding:8px 0">Lỗi khi tải danh sách thiết bị.</div>';
    }
}

async function kickBncDevice(deviceId) {
    if (!confirm('Đăng xuất thiết bị này khỏi tài khoản BNC?')) return;
    try {
        await window.electronAPI.invoke('bnc-kick-session', deviceId);
        await loadBncDevices();
    } catch (e) {
        alert('Lỗi khi đăng xuất thiết bị: ' + (e.message || e));
    }
}

async function askDataPathAfterActivation() {
    await window.electronAPI.debugLog('ASK_DATA_PATH', 'dialog shown');
    const info = await window.electronAPI.invoke('get-data-path-info');
    const defaultPath = info.currentPath;
    await window.electronAPI.debugLog('ASK_DATA_PATH', { defaultPath });

    // Helper: hỏi restart app
    const askRestart = () => new Promise((res) => {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100000';
        ov.innerHTML = `
          <div style="background:#1e1e2d;border-radius:14px;padding:32px 28px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.5);color:#eee;font-family:sans-serif;text-align:center">
            <div style="font-size:2rem;margin-bottom:12px">🔄</div>
            <div style="font-size:1rem;font-weight:600;margin-bottom:8px">Cần khởi động lại</div>
            <div style="font-size:.85rem;color:#aaa;margin-bottom:22px">Để áp dụng cấu hình, vui lòng khởi động lại ứng dụng ngay bây giờ.</div>
            <button id="restartNow" style="padding:10px 28px;border-radius:8px;border:none;background:#e74c3c;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer">Khởi động lại ngay</button>
          </div>`;
        document.body.appendChild(ov);
        ov.querySelector('#restartNow').onclick = () => { ov.remove(); res(); };
    });

    // Tạo overlay 3 nút động
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99999';
    overlay.innerHTML = `
      <div style="background:#1e1e2d;border-radius:14px;padding:32px 28px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.5);color:#eee;font-family:sans-serif;text-align:center">
        <div style="font-size:2.2rem;margin-bottom:12px">📁</div>
        <div style="font-size:1.05rem;font-weight:600;margin-bottom:8px">Chọn thư mục lưu dữ liệu profile</div>
        <div style="font-size:.82rem;color:#aaa;margin-bottom:6px">Thư mục mặc định:</div>
        <div style="font-size:.8rem;background:#12121e;padding:8px 10px;border-radius:7px;word-break:break-all;color:#ccc;margin-bottom:22px">${defaultPath}</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button id="dpBtn_default" style="padding:10px;border-radius:8px;border:none;background:#e74c3c;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer">✅ Dùng thư mục mặc định</button>
          <button id="dpBtn_choose"  style="padding:10px;border-radius:8px;border:1.5px solid #555;background:transparent;color:#eee;font-size:.9rem;cursor:pointer">📂 Chọn thư mục khác...</button>
          <button id="dpBtn_later"   style="padding:8px;border-radius:8px;border:none;background:transparent;color:#666;font-size:.8rem;cursor:pointer">Để sau (sẽ hỏi lại lần sau)</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    await new Promise((resolve) => {
        overlay.querySelector('#dpBtn_default').onclick = async () => {
            overlay.remove();
            await window.electronAPI.debugLog('ASK_DATA_PATH', 'user chose default path');
            await window.electronAPI.dataPathSetConfirmed();
            await askRestart();
            await window.electronAPI.debugLog('ASK_DATA_PATH', 'restarting app');
            await window.electronAPI.restartApp();
            resolve();
        };

        overlay.querySelector('#dpBtn_choose').onclick = async () => {
            overlay.remove();
            await window.electronAPI.debugLog('ASK_DATA_PATH', 'user opening folder picker');
            const newPath = await window.electronAPI.invoke('select-data-directory');
            if (!newPath) {
                await window.electronAPI.debugLog('ASK_DATA_PATH', 'folder picker cancelled → will ask again next launch');
                resolve();
                return;
            }
            await window.electronAPI.debugLog('ASK_DATA_PATH', { chosenPath: newPath });
            const migrate = confirm('Di chuyển dữ liệu hiện có sang thư mục mới?\n\nOK: Di chuyển\nHủy: Chỉ đổi đường dẫn');
            showAlert('Đang di chuyển...', false);
            const result = await window.electronAPI.invoke('set-data-directory', { newPath, migrate });
            await window.electronAPI.debugLog('ASK_DATA_PATH', { setDirectoryResult: result });
            if (result.success) {
                await window.electronAPI.dataPathSetConfirmed();
                loadDataPathSetting();
                await askRestart();
                await window.electronAPI.debugLog('ASK_DATA_PATH', 'restarting app after custom path');
                await window.electronAPI.restartApp();
            } else {
                showAlert('Thao tác thất bại: ' + result.error);
            }
            resolve();
        };

        overlay.querySelector('#dpBtn_later').onclick = async () => {
            overlay.remove();
            await window.electronAPI.debugLog('ASK_DATA_PATH', 'user chose later → will ask next launch');
            resolve();
        };
    });
}


// ─── Notification Panel ──────────────────────────────────────────────────────
function _renderNotifBadge() {
    const badge = document.getElementById('bncNotifBadge');
    if (!badge) return;
    const unread = _bncNotifications.filter(n => !n.isRead).length;
    if (unread > 0) {
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

function _renderNotifList() {
    const list = document.getElementById('bncNotifList');
    if (!list) return;
    if (_bncNotifications.length === 0) {
        list.innerHTML = '<div style="padding:24px 16px;text-align:center;color:#555;font-size:13px;">Chưa có thông báo</div>';
        return;
    }
    list.innerHTML = _bncNotifications.map(n => {
        const dt = new Date(n.createdAt).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        return `<div onclick="openNotifDetail('${n.id}')" style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;${!n.isRead ? 'background:rgba(0,224,255,0.04);' : ''}">
            <div style="font-size:13px;font-weight:${!n.isRead ? '600' : '400'};color:${!n.isRead ? '#e0e0e0' : '#aaa'};">${n.title}</div>
            <div style="font-size:12px;color:#888;margin-top:3px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${n.body}</div>
            <div style="font-size:10px;color:#555;margin-top:5px;">${dt}</div>
        </div>`;
    }).join('');
}

// Bấm vào 1 thông báo trong dropdown (dropdown quá bé để đọc hết) → mở modal lớn
// hiện đầy đủ nội dung, đồng thời đánh dấu đã đọc riêng thông báo đó.
function openNotifDetail(id) {
    const n = _bncNotifications.find(x => String(x.id) === String(id));
    if (!n) return;
    const dt = new Date(n.createdAt).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    document.getElementById('bncNotifPanel').style.display = 'none';
    const msgEl = document.getElementById('alertMsg');
    msgEl.style.whiteSpace = 'pre-wrap';
    msgEl.style.textAlign = 'left';
    msgEl.innerHTML = `<strong style="display:block;margin-bottom:8px;">${n.title}</strong>${n.body}<div style="margin-top:10px;font-size:11px;color:#888;">${dt}</div>`;
    const btn = document.getElementById('alertBtn');
    if (btn) btn.style.display = 'block';
    document.getElementById('alertModal').style.display = 'flex';
    if (!n.isRead) {
        n.isRead = true;
        _renderNotifBadge();
        window.electronAPI.bncMarkNotificationsRead([n.id]).catch(() => {});
    }
}

function toggleNotifPanel() {
    const panel = document.getElementById('bncNotifPanel');
    const btn   = document.getElementById('bncBellBtn');
    if (!panel || !btn) return;
    if (panel.style.display === 'none') {
        const rect = btn.getBoundingClientRect();
        panel.style.top  = (rect.bottom + 6) + 'px';
        panel.style.right = (window.innerWidth - rect.right - 4) + 'px';
        panel.style.left = 'auto';
        panel.style.display = 'flex';
        _renderNotifList();
        // Fetch mới từ server — không đợi heartbeat 5 phút
        window.electronAPI.bncFetchNotifications().then(notifs => {
            if (Array.isArray(notifs) && notifs.length >= 0) {
                // Giữ trạng thái isRead local cho notif đã đọc trong session này
                const readLocally = new Set(_bncNotifications.filter(n => n.isRead).map(n => n.id));
                _bncNotifications = notifs.map(n => ({ ...n, isRead: n.isRead || readLocally.has(n.id) }));
                _renderNotifBadge();
                if (panel.style.display !== 'none') _renderNotifList();
            }
        }).catch(() => {});
        // Đóng dropdown user nếu đang mở
        const ud = document.getElementById('bncUserDropdown');
        if (ud) ud.style.display = 'none';
    } else {
        panel.style.display = 'none';
    }
}

// Đóng panel khi click ra ngoài
document.addEventListener('click', (e) => {
    const panel = document.getElementById('bncNotifPanel');
    const btn   = document.getElementById('bncBellBtn');
    if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.style.display = 'none';
    }
}, true);

async function markAllNotifsRead() {
    _bncNotifications.forEach(n => { n.isRead = true; });
    _renderNotifBadge();
    _renderNotifList();
    try { await window.electronAPI.bncMarkNotificationsRead([]); } catch (_) {}
}

// ─── Trigger install from UI ─────────────────────────────────────────────────
async function triggerInstallUpdate() {
    try { await window.electronAPI.installAppUpdate(); } catch (_) {}
}

// ─── Arrange Window ───────────────────────────────────────────────────────────

let _awSettings = null;

// ─── BNC Notification Dialog ──────────────────────────────────────────────────
let _notifDialogQueue = [];
let _notifDialogIdx = 0;

function bncShowNotifDialog(notifs) {
    if (!notifs || !notifs.length) return;
    _notifDialogQueue = notifs;
    _notifDialogIdx = 0;
    _renderNotifDialogItem();
    const el = document.getElementById('bncNotifDialog');
    if (el) { el.style.display = 'flex'; }
}

function _renderNotifDialogItem() {
    const n = _notifDialogQueue[_notifDialogIdx];
    if (!n) return;
    const iconMap = { warning: '⚠️', error: '🔴', success: '✅', info: '📢' };
    document.getElementById('bncNotifDialogIcon').textContent = iconMap[n.type] || '📢';
    document.getElementById('bncNotifDialogTitle').textContent = n.title || '';
    document.getElementById('bncNotifDialogBody').textContent = n.body || '';
    const nextBtn = document.getElementById('bncNotifDialogNextBtn');
    if (nextBtn) nextBtn.style.display = _notifDialogQueue.length > 1 && _notifDialogIdx < _notifDialogQueue.length - 1 ? 'inline-block' : 'none';
    // Mark as read
    if (n.id) window.electronAPI.bncMarkNotificationsRead([Number(n.id)]).catch(() => {});
}

function bncNotifDialogNext() {
    _notifDialogIdx++;
    if (_notifDialogIdx < _notifDialogQueue.length) {
        _renderNotifDialogItem();
    } else {
        bncNotifDialogClose();
    }
}

function bncNotifDialogClose() {
    const el = document.getElementById('bncNotifDialog');
    if (el) el.style.display = 'none';
    _notifDialogQueue = [];
    _notifDialogIdx = 0;
}

async function openArrangeWindow() {
    const modal = document.getElementById('arrangeWindowModal');
    if (!modal) return;
    _awSettings = await window.electronAPI.getArrangeSettings();
    // populate fields
    document.getElementById('aw-sizeMode').value = _awSettings.sizeMode || 'auto';
    document.getElementById('aw-arrangeMode').value = _awSettings.arrangeMode || 'separate';
    document.getElementById('aw-winW').value = _awSettings.windowWidth || 800;
    document.getElementById('aw-winH').value = _awSettings.windowHeight || 600;
    const rowsSel = document.getElementById('aw-rows');
    const colsSel = document.getElementById('aw-cols');
    rowsSel.value = String(_awSettings.rows || 2);
    colsSel.value = String(_awSettings.cols || 3);
    document.getElementById('aw-scale').value = _awSettings.scale || 100;
    document.getElementById('aw-atSameTime').checked = _awSettings.arrangeAtSameTime !== false;
    onAwSizeModeChange();
    modal.style.display = 'flex';
    await awDrawPreview('opening');
}

function closeArrangeWindow() {
    const modal = document.getElementById('arrangeWindowModal');
    if (modal) modal.style.display = 'none';
    _awSaveSettings();
}

function _awGetSettings() {
    const sizeMode = document.getElementById('aw-sizeMode').value;
    return {
        sizeMode,
        arrangeMode: document.getElementById('aw-arrangeMode').value,
        windowWidth: parseInt(document.getElementById('aw-winW').value) || 800,
        windowHeight: parseInt(document.getElementById('aw-winH').value) || 600,
        rows: parseInt(document.getElementById('aw-rows').value) || 2,
        cols: parseInt(document.getElementById('aw-cols').value) || 3,
        scale: parseFloat(document.getElementById('aw-scale').value) || 100,
        arrangeAtSameTime: document.getElementById('aw-atSameTime').checked,
    };
}

async function _awSaveSettings() {
    try { await window.electronAPI.saveArrangeSettings(_awGetSettings()); } catch (_) {}
}

function onAwSizeModeChange() {
    const mode = document.getElementById('aw-sizeMode').value;
    document.getElementById('aw-row-size').style.display = mode === 'userSize' ? 'table-row' : 'none';
    document.getElementById('aw-row-rowscols').style.display = mode === 'userRowsCols' ? 'table-row' : 'none';
    // re-draw preview after a tick
    setTimeout(() => awDrawPreview('opening'), 50);
}

async function awDrawPreview(type) {
    const canvas = document.getElementById('aw-preview');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // get running profiles or selected profiles count
    let count = 0;
    if (type === 'opening') {
        try {
            const ids = await window.electronAPI.getRunningIds?.() || [];
            count = ids.length;
        } catch (_) { count = 0; }
    } else {
        const selected = getSelectedProfileIds();
        count = selected.length;
    }
    if (count === 0) count = 4; // show sample grid if none

    const settings = _awGetSettings();
    const result = await window.electronAPI.calcArrangeLayout(count, settings);
    if (!result) return;

    const { workArea, cellW, cellH, numCols } = result;
    const numRows = Math.ceil(count / numCols);
    const scaleX = (W - 8) / workArea.width;
    const scaleY = (H - 8) / workArea.height;
    const padX = 4, padY = 4;

    // background (screen)
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, H);

    // draw grid cells
    const colors = ['#00e0ff33', '#7c3aed33', '#10b98133', '#f59e0b33'];
    for (let i = 0; i < count; i++) {
        const col = i % numCols;
        const row = Math.floor(i / numCols);
        const rx = padX + col * cellW * scaleX;
        const ry = padY + row * cellH * scaleY;
        const rw = cellW * scaleX - 2;
        const rh = cellH * scaleY - 2;

        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#00e0ff88';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx, ry, rw, rh);

        // number label
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(10, Math.min(16, rh * 0.3))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i + 1, rx + rw / 2, ry + rh / 2);
    }

    // info text
    ctx.fillStyle = '#888';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${numCols}×${numRows}  ${cellW}×${cellH}px`, W - 4, H - 2);
}

async function awPreview(type) {
    await awDrawPreview(type);
}

async function awArrangeOpening() {
    const settings = _awGetSettings();
    try {
        const result = await window.electronAPI.arrangeOpeningProfiles(settings);
        if (!result.success) {
            if (result.needsAccessibility) {
                showBncToast('⚠️ Cần cấp quyền Accessibility: Vào System Settings → Privacy & Security → Accessibility → bật BNC (hoặc Electron). Sau đó thử lại.');
            } else {
                showBncToast(result.message || 'Không có profile nào đang mở');
            }
        } else {
            showBncToast(`Đã sắp xếp ${result.count} cửa sổ`);
        }
    } catch (e) {
        showBncToast('Lỗi sắp xếp: ' + e.message);
    }
    _awSaveSettings();
}

async function awOpenAndArrangeSelected() {
    const profileIds = getSelectedProfileIds();
    if (!profileIds.length) {
        showBncToast('Chưa chọn profile nào');
        return;
    }
    const settings = _awGetSettings();
    const result = await window.electronAPI.calcArrangeLayout(profileIds.length, settings);
    if (!result) return;

    let launched = 0;
    for (let i = 0; i < profileIds.length; i++) {
        const pos = result.positions[i];
        try {
            await window.electronAPI.launchProfile(profileIds[i], null, pos);
            launched++;
        } catch (_) {}
        if (i < profileIds.length - 1) await new Promise(r => setTimeout(r, 300));
    }
    showBncToast(`Đã mở và sắp xếp ${launched} profile`);
    _awSaveSettings();
}

function getSelectedProfileIds() {
    return [...document.querySelectorAll('.profile-item.selected')].map(el => el.dataset.id).filter(Boolean);
}

// close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('arrangeWindowModal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeArrangeWindow(); });
});
