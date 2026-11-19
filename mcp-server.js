// BNC MCP server — Model Context Protocol (Streamable HTTP, JSON responses) so an LLM client
// (Claude Code, Claude Desktop, Cursor…) can manage and drive BNC profiles:
//   list → start (returns CDP endpoint) → drive via Playwright/Puppeteer/CDP → stop.
//
// Mounted at POST /mcp on the local API server (127.0.0.1). Enabled by settings.enableMcp,
// authenticated with `Authorization: Bearer <settings.apiKey>` (key is mandatory for MCP).
// All profile/group mutations go through the same IPC handlers the UI uses, so server sync,
// fingerprint generation and launch gating (slot / locked checks in the renderer) stay identical.

const crypto = require('crypto');
const http = require('http');

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_BODY = 1024 * 1024;

const sessions = new Map(); // sessionId -> { createdAt, protocolVersion, client }

// ─── Tool definitions ───────────────────────────────────────────────────────
const S = {
    id: { type: 'string', description: 'Profile ID (or exact profile name)' },
    str: (d) => ({ type: 'string', description: d }),
    int: (d, extra = {}) => ({ type: 'integer', description: d, ...extra }),
};

// Field names follow the de-facto convention of other anti-detect browsers' local APIs
// (snake_case: raw_proxy, timezone_base_on_ip, fixed_language, addition_args, startup_urls…)
// so existing automation scripts/prompts carry over. Older BNC names stay as aliases.
const PROFILE_FIELDS = {
    name: S.str('Profile name'),
    group_id: S.str('Group ID ("" = no group)'),
    raw_proxy: S.str('Proxy, e.g. socks5://user:pass@host:port, http://host:port, host:port:user:pass, or a vmess/vless/trojan/ss link. "" = direct. (alias: proxy)'),
    timezone: S.str('IANA timezone, e.g. Asia/Ho_Chi_Minh'),
    timezone_base_on_ip: { type: 'boolean', description: 'true = detect timezone from proxy IP at launch (overrides timezone)' },
    fixed_language: S.str('Browser language, e.g. vi-VN (alias: language)'),
    is_language_base_on_ip: { type: 'boolean', description: 'true = automatic language (overrides fixed_language)' },
    custom_user_agent: S.str('Override User-Agent. Keep the Chrome major version equal to the BNC engine, otherwise UA and Client Hints disagree'),
    tags: { type: 'array', items: { type: 'string' } },
    note: S.str('Free-text note'),
};

const TOOLS = [
    {
        name: 'list_profiles',
        description: 'List BNC browser profiles (paginated). Each item: id, name, group, tags, has_proxy, status (online/offline).',
        inputSchema: { type: 'object', properties: {
            page: S.int('Page number, starts at 1', { minimum: 1, default: 1 }),
            per_page: S.int('Items per page, max 200 (alias: page_size)', { minimum: 1, maximum: 200, default: 50 }),
            search: S.str('Case-insensitive filter on name, tags and note'),
            sort: { type: 'string', enum: ['created_desc', 'created_asc', 'name_asc', 'name_desc'], default: 'created_desc' },
            group_id: S.str('Only profiles in this group ("none" = ungrouped)'),
            running_only: { type: 'boolean', description: 'Only running profiles' },
        } },
    },
    {
        name: 'get_profile',
        description: 'Get one profile: settings, proxy, key fingerprint fields, status and CDP endpoint if running.',
        inputSchema: { type: 'object', properties: { id: S.id }, required: ['id'] },
    },
    {
        name: 'create_profile',
        description: 'Create a new profile with a freshly generated fingerprint (same path as the "New profile" button). Default: timezone from proxy IP, automatic language.',
        inputSchema: { type: 'object', properties: {
            ...PROFILE_FIELDS,
            screen_width: S.int('Custom screen width (needs screen_height)'),
            screen_height: S.int('Custom screen height (needs screen_width)'),
        }, required: ['name'] },
    },
    {
        name: 'update_profile',
        description: 'Update profile settings. Only the given fields change. Takes effect on next start.',
        inputSchema: { type: 'object', properties: { id: S.id, ...PROFILE_FIELDS }, required: ['id'] },
    },
    {
        name: 'delete_profile',
        description: 'PERMANENTLY delete a profile and its browser data (cookies, logins). Cannot be undone — ask the user before calling, then pass confirm=true.',
        inputSchema: { type: 'object', properties: {
            id: S.id,
            confirm: { type: 'boolean', description: 'Must be true. Only set after the user explicitly agreed.' },
        }, required: ['id', 'confirm'] },
    },
    {
        name: 'start_profile',
        description: 'Start a profile and return its Chrome DevTools Protocol endpoint. Connect with Playwright chromium.connectOverCDP(websocket_debugging_url), puppeteer.connect({browserWSEndpoint}), Selenium (goog:chromeOptions.debuggerAddress = 127.0.0.1:<remote_debugging_port>), or raw CDP. Respects slot/lock limits of the BNC account.',
        inputSchema: { type: 'object', properties: {
            id: S.id,
            remote_debugging_port: S.int('Fixed CDP port (default: random free port)', { minimum: 1024, maximum: 65535 }),
            addition_args: S.str('Extra Chrome switches separated by spaces, e.g. "--start-maximized --mute-audio". Switches BNC manages itself (user-data-dir, proxy, extensions, debugging port, fingerprint, timezone, language) are rejected. "--remote-allow-origins=<origins>" is accepted (needed by CDP clients that send an Origin header, e.g. Python websocket-client).'),
            startup_urls: { description: 'URL(s) to open after start: array or comma-separated string (http/https only)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
            window_position: S.str('Window position "x,y", e.g. "0,0"'),
            window_size: S.str('Window size "width,height", e.g. "1280,800"'),
            allow_origins: S.str('Same as --remote-allow-origins in addition_args, e.g. "http://localhost". Avoid "*": any website open on this machine could then control the browser.'),
            timeout_sec: S.int('Max seconds to wait for the browser (default 90)', { minimum: 10, maximum: 300 }),
        }, required: ['id'] },
    },
    {
        name: 'stop_profile',
        description: 'Stop a running profile (closes its browser window).',
        inputSchema: { type: 'object', properties: { id: S.id }, required: ['id'] },
    },
    {
        name: 'list_running_profiles',
        description: 'List currently running profiles with their CDP endpoints.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'list_groups',
        description: 'List profile groups with profile counts.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'create_group',
        description: 'Create a profile group.',
        inputSchema: { type: 'object', properties: { name: S.str('Group name') }, required: ['name'] },
    },
    {
        name: 'update_group',
        description: 'Rename a profile group.',
        inputSchema: { type: 'object', properties: { id: S.str('Group ID'), name: S.str('New name') }, required: ['id', 'name'] },
    },
    {
        name: 'delete_group',
        description: 'Delete a group. Profiles in it are kept and become ungrouped. Ask the user first, then pass confirm=true.',
        inputSchema: { type: 'object', properties: {
            id: S.str('Group ID'),
            confirm: { type: 'boolean', description: 'Must be true' },
        }, required: ['id', 'confirm'] },
    },
    {
        name: 'list_extensions',
        description: 'List user extensions that BNC loads into profiles.',
        inputSchema: { type: 'object', properties: {} },
    },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
class ToolError extends Error {}

function maskProxy(p) {
    if (!p) return '';
    // Hide credentials: scheme://user:pass@host:port → scheme://***@host:port ; host:port:user:pass → host:port:***
    return String(p).replace(/\/\/[^@\/]+@/, '//***@').replace(/^([^:\/]+:\d+):.+$/, '$1:***');
}

// Switches BNC sets itself — overriding them would break isolation, proxying or the fingerprint.
const MANAGED_SWITCH_RE = /^--(user-data-dir|profile-directory|remote-debugging-(port|pipe|address)|load-extension|disable-extensions-except|disable-extensions|proxy-server|proxy-bypass-list|proxy-pac-url|no-proxy-server|proxy-auto-detect|fingerprint[\w-]*|disable-spoofing|timezone|lang|accept-lang|user-agent|disable-web-security|no-sandbox|disable-site-isolation-trials|enable-automation)(=|$)/i;
const ORIGIN_LIST_RE = /^(\*|https?:\/\/[A-Za-z0-9.\-\[\]:]+)$/;

function validateOrigins(value) {
    const list = String(value).split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length || !list.every(o => ORIGIN_LIST_RE.test(o))) {
        throw new ToolError('remote-allow-origins must be a comma-separated list of origins like http://localhost:3000');
    }
    return list.join(',');
}

/** "--a --b=1 --c=\"x y\"" → { args: [...], allowOrigins } ; rejects managed/unsafe switches. */
function parseAdditionArgs(str) {
    const out = { args: [], allowOrigins: null };
    if (!str) return out;
    const tokens = String(str).match(/--[^\s=]+(?:=(?:"[^"]*"|'[^']*'|\S*))?|\S+/g) || [];
    for (let t of tokens) {
        if (!t.startsWith('--')) throw new ToolError(`addition_args: "${t}" is not a --switch (use startup_urls for URLs)`);
        t = t.replace(/=(["'])(.*)\1$/, '=$2');
        const m = t.match(/^--remote-allow-origins=(.+)$/i);
        if (m) { out.allowOrigins = validateOrigins(m[1]); continue; }
        if (MANAGED_SWITCH_RE.test(t)) throw new ToolError(`addition_args: ${t.split('=')[0]} is managed by BNC and cannot be overridden`);
        if (/[\r\n\0]/.test(t)) throw new ToolError('addition_args: invalid characters');
        out.args.push(t);
    }
    if (out.args.length > 30) throw new ToolError('addition_args: too many switches');
    return out;
}

function parsePair(value, label) {
    if (value === undefined || value === null || value === '') return null;
    const m = String(value).trim().match(/^(-?\d{1,5})\s*[,x×]\s*(-?\d{1,5})$/i);
    if (!m) throw new ToolError(`${label} must look like "a,b" (e.g. "1280,800")`);
    return [parseInt(m[1]), parseInt(m[2])];
}

function parseStartupUrls(v) {
    if (!v) return [];
    const list = (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
    for (const u of list) {
        let ok = false;
        try { ok = ['http:', 'https:'].includes(new URL(u).protocol); } catch (_) {}
        if (!ok) throw new ToolError(`startup_urls: not an http(s) URL: ${u}`);
    }
    if (list.length > 20) throw new ToolError('startup_urls: at most 20 URLs');
    return list;
}

const SORTS = {
    created_desc: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    created_asc: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    name_asc: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }),
    name_desc: (a, b) => String(b.name || '').localeCompare(String(a.name || ''), undefined, { numeric: true }),
};
function normalizeSort(s) {
    if (!s) return 'created_desc';
    // accept created_desc / CreatedDesc / created-desc
    const k = String(s).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (!SORTS[k]) throw new ToolError(`sort must be one of: ${Object.keys(SORTS).join(', ')}`);
    return k;
}

function httpRequest(method, url, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, timeout: timeoutMs }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

function httpGetJson(url, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function waitForCdp(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const v = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
            if (v && v.webSocketDebuggerUrl) return v;
        } catch (e) { lastErr = e; }
        await new Promise(r => setTimeout(r, 400));
    }
    throw new ToolError(`Browser started but CDP port ${port} did not answer (${lastErr ? lastErr.message : 'timeout'})`);
}

function cdpInfo(port, version) {
    if (!port) return null;
    return {
        remote_debugging_port: port,
        websocket_debugging_url: version?.webSocketDebuggerUrl || null,
        http_endpoint: `http://127.0.0.1:${port}`,
        // BNC ships no WebDriver binary — Selenium users attach with debuggerAddress instead.
        driver_path: '',
        selenium_debugger_address: `127.0.0.1:${port}`,
        browser: version?.Browser || null,
    };
}

// Accept both `id` and `profile_id` (and `proxy`/`raw_proxy`, `language`/`fixed_language`…).
const pick = (a, ...keys) => { for (const k of keys) if (a[k] !== undefined) return a[k]; return undefined; };

// ─── Tool implementations ───────────────────────────────────────────────────
function createTools(ctx) {
    const loadProfiles = async () => (await ctx.invoke('get-profiles')) || [];
    const findProfile = async (idOrName) => {
        if (!idOrName) throw new ToolError('id is required');
        const profiles = await loadProfiles();
        const p = profiles.find(x => x.id === idOrName) || profiles.find(x => x.name === idOrName);
        if (!p) throw new ToolError(`Profile not found: ${idOrName}`);
        return p;
    };
    const groupMap = async () => {
        const groups = (await ctx.invoke('get-groups')) || [];
        return Object.fromEntries(groups.map(g => [g.id, g.name]));
    };
    const isRunning = (id) => {
        const proc = ctx.activeProcesses()[id];
        return !!(proc && proc.chromeProcess && proc.chromeProcess.exitCode === null);
    };
    const summary = (p, groups) => ({
        id: p.id,
        name: p.name,
        group_id: p.groupId || null,
        group: p.groupId ? (groups[p.groupId] || null) : null,
        tags: p.tags || [],
        note: p.note || '',
        has_proxy: !!p.proxyStr,
        locked: !!p.isLocked,
        status: isRunning(p.id) ? 'online' : 'offline',
        running: isRunning(p.id),
        created_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    });
    const assertGroup = async (gid) => {
        if (gid && !(await groupMap())[gid]) throw new ToolError(`Group not found: ${gid}`);
    };
    /** Apply GPM-style / BNC-style profile fields onto a profile + fingerprint. Returns changed keys. */
    const applyProfileFields = (a, prof, fp) => {
        const changed = [];
        const name = pick(a, 'name');
        if (name !== undefined) { const n = String(name).trim(); if (!n) throw new ToolError('name cannot be empty'); prof.name = n; changed.push('name'); }
        const proxy = pick(a, 'raw_proxy', 'proxy');
        if (proxy !== undefined) { prof.proxyStr = String(proxy || '').trim(); changed.push('raw_proxy'); }
        if (a.tags !== undefined) { prof.tags = Array.isArray(a.tags) ? a.tags.map(String) : []; changed.push('tags'); }
        if (a.note !== undefined) { prof.note = String(a.note); changed.push('note'); }
        if (a.group_id !== undefined) { prof.groupId = a.group_id || null; changed.push('group_id'); }
        if (a.timezone_base_on_ip === true) { fp.timezone = 'Auto'; changed.push('timezone'); }
        else if (a.timezone !== undefined) { fp.timezone = a.timezone || 'Auto'; changed.push('timezone'); }
        const lang = pick(a, 'fixed_language', 'language');
        if (a.is_language_base_on_ip === true || (lang !== undefined && (!lang || lang === 'auto'))) { delete fp.language; changed.push('language'); }
        else if (lang !== undefined) { fp.language = String(lang); changed.push('language'); }
        if (a.custom_user_agent !== undefined) {
            if (a.custom_user_agent) {
                if (!/^Mozilla\/5\.0 \(.+\) AppleWebKit\/.+Chrome\/\d+/.test(a.custom_user_agent)) throw new ToolError('custom_user_agent must be a Chrome User-Agent string');
                fp.userAgent = String(a.custom_user_agent);
            }
            changed.push('custom_user_agent');
        }
        return changed;
    };
    const runningCdp = async (id) => {
        const proc = ctx.activeProcesses()[id];
        if (!proc?.debugPort) return null;
        let v = null;
        try { v = await httpGetJson(`http://127.0.0.1:${proc.debugPort}/json/version`, 1500); } catch (_) {}
        return cdpInfo(proc.debugPort, v);
    };

    return {
        async list_profiles(a) {
            const page = Math.max(1, parseInt(a.page) || 1);
            const size = Math.min(200, Math.max(1, parseInt(pick(a, 'per_page', 'page_size')) || 50));
            const sort = normalizeSort(a.sort);
            const groups = await groupMap();
            let list = await loadProfiles();
            if (a.search) {
                const q = String(a.search).toLowerCase();
                list = list.filter(p => [p.name, p.note, ...(p.tags || [])].some(s => s && String(s).toLowerCase().includes(q)));
            }
            if (a.group_id) list = list.filter(p => a.group_id === 'none' ? !p.groupId : p.groupId === a.group_id);
            if (a.running_only) list = list.filter(p => isRunning(p.id));
            list = list.slice().sort(SORTS[sort]);
            const total = list.length;
            return {
                total, page, per_page: size, total_pages: Math.max(1, Math.ceil(total / size)), sort,
                profiles: list.slice((page - 1) * size, page * size).map(p => summary(p, groups)),
            };
        },

        async get_profile(a) {
            const p = await findProfile(pick(a, 'id', 'profile_id'));
            const fp = p.fingerprint || {};
            return {
                ...summary(p, await groupMap()),
                raw_proxy: maskProxy(p.proxyStr),
                pre_proxy: p.preProxyOverride || 'default',
                timezone_base_on_ip: !fp.timezone || fp.timezone === 'Auto',
                is_language_base_on_ip: !fp.language,
                fingerprint: {
                    platform: fp.platform, user_agent: fp.userAgent,
                    timezone: fp.timezone, language: fp.language || (fp.languages || [])[0],
                    screen: fp.screen, device_pixel_ratio: fp.devicePixelRatio,
                    hardware_concurrency: fp.hardwareConcurrency, device_memory: fp.deviceMemory,
                    webgl_vendor: fp.webgl?.vendor, webgl_renderer: fp.webgl?.renderer,
                },
                cdp: isRunning(p.id) ? await runningCdp(p.id) : null,
            };
        },

        async create_profile(a) {
            if (!String(a.name || '').trim()) throw new ToolError('name is required');
            await assertGroup(a.group_id);
            // Map onto the same payload the "New profile" form sends to save-profile.
            const prof = {}, fp = {};
            applyProfileFields(a, prof, fp);
            const data = {
                name: prof.name,
                proxyStr: prof.proxyStr || '',
                tags: prof.tags || [],
                note: prof.note || '',
                timezone: fp.timezone && fp.timezone !== 'Auto' ? fp.timezone : undefined, // undefined → "Auto"
                language: fp.language || undefined,
                groupId: prof.groupId || null,
                preProxyOverride: 'default',
            };
            if (a.screen_width && a.screen_height) data.screen = { width: parseInt(a.screen_width), height: parseInt(a.screen_height) };
            let p = await ctx.invoke('save-profile', data);
            if (fp.userAgent) {
                // save-profile has no UA field — patch it in afterwards.
                p = { ...p, fingerprint: { ...(p.fingerprint || {}), userAgent: fp.userAgent } };
                await ctx.invoke('update-profile', p);
            }
            ctx.refreshUI();
            return { success: true, profile: summary(p, await groupMap()) };
        },

        async update_profile(a) {
            const p = await findProfile(pick(a, 'id', 'profile_id'));
            const next = { ...p, fingerprint: { ...(p.fingerprint || {}) } };
            await assertGroup(a.group_id);
            const changed = applyProfileFields(a, next, next.fingerprint);
            if (!changed.length) throw new ToolError('Nothing to update');
            const ok = await ctx.invoke('update-profile', next);
            if (!ok) throw new ToolError('Update failed');
            ctx.refreshUI();
            const running = isRunning(p.id);
            return { success: true, updated: changed, message: running ? 'Profile is running — changes apply after restart' : 'Updated' };
        },

        async delete_profile(a) {
            if (a.confirm !== true) throw new ToolError('Refused: deleting is permanent (browser data, cookies, logins). Ask the user, then call again with confirm=true.');
            const p = await findProfile(pick(a, 'id', 'profile_id'));
            await ctx.invoke('delete-profile', p.id);
            ctx.refreshUI();
            return { success: true, message: 'Deleted', profile_id: p.id, profile_name: p.name };
        },

        async start_profile(a) {
            const p = await findProfile(pick(a, 'id', 'profile_id'));
            const base = { success: true, message: 'Started', warning_message: '', profile_id: p.id, profile_name: p.name };
            if (p.isLocked) throw new ToolError('Profile is locked (no slot). Buy/upgrade a plan in BNC to unlock it.');
            if (isRunning(p.id)) {
                const cdp = await runningCdp(p.id);
                const pid = ctx.activeProcesses()[p.id]?.chromeProcess?.pid || null;
                if (cdp) return { ...base, message: 'Already running', process_id: pid, ...cdp };
                throw new ToolError('Profile is already running without a CDP port (opened from the BNC window). Call stop_profile, then start_profile again.');
            }

            // Validate everything before launching anything.
            const extra = parseAdditionArgs(a.addition_args);
            let allowOrigins = extra.allowOrigins;
            if (a.allow_origins) allowOrigins = validateOrigins(a.allow_origins);
            const pos = parsePair(a.window_position, 'window_position');
            const size = parsePair(a.window_size, 'window_size');
            if (size && (size[0] < 200 || size[1] < 150)) throw new ToolError('window_size too small');
            const urls = parseStartupUrls(a.startup_urls);
            const fixedPort = a.remote_debugging_port ? parseInt(a.remote_debugging_port) : null;
            if (fixedPort !== null && !(fixedPort >= 1024 && fixedPort <= 65535)) throw new ToolError('remote_debugging_port must be 1024-65535');
            let window = null;
            if (pos || size) {
                const fw = p.fingerprint?.window || {};
                window = {
                    x: pos ? pos[0] : 0, y: pos ? pos[1] : 0,
                    w: size ? size[0] : (fw.width || 1280), h: size ? size[1] : (fw.height || 800),
                };
            }

            const timeoutMs = Math.min(300, Math.max(10, parseInt(a.timeout_sec) || 90)) * 1000;
            const port = await ctx.reservePort(p.id, { port: fixedPort, allowOrigins, extraArgs: extra.args, window });
            const result = await ctx.requestLaunch(p.id, timeoutMs);
            if (!result || !result.ok) {
                ctx.releasePort(p.id);
                throw new ToolError(`Start failed: ${result?.error || 'unknown error'}`);
            }
            const proc = ctx.activeProcesses()[p.id];
            const realPort = proc?.debugPort || port;
            const version = await waitForCdp(realPort, Math.min(30000, timeoutMs));

            const warnings = [];
            if (allowOrigins === '*') warnings.push('remote-allow-origins=* lets any website open on this machine control this browser.');
            if (result.message && /:/.test(result.message)) warnings.push(result.message);
            for (const u of urls) {
                try {
                    const code = await httpRequest('PUT', `http://127.0.0.1:${realPort}/json/new?${encodeURI(u)}`);
                    if (code >= 400) warnings.push(`Could not open ${u} (HTTP ${code})`);
                } catch (e) { warnings.push(`Could not open ${u}: ${e.message}`); }
            }
            return { ...base, warning_message: warnings.join(' '), process_id: proc?.chromeProcess?.pid || null, ...cdpInfo(realPort, version) };
        },

        async stop_profile(a) {
            const p = await findProfile(pick(a, 'id', 'profile_id'));
            if (!isRunning(p.id)) return { success: false, message: 'Profile is not running', profile_id: p.id };
            const r = await ctx.invoke('stop-profile', p.id);
            return { success: !!r?.success, message: r?.success ? 'Stopped' : 'Stop failed', profile_id: p.id, profile_name: p.name };
        },

        async list_running_profiles() {
            const profiles = await loadProfiles();
            const ids = Object.keys(ctx.activeProcesses()).filter(isRunning);
            const out = [];
            for (const id of ids) {
                const p = profiles.find(x => x.id === id);
                out.push({ profile_id: id, profile_name: p?.name || null, process_id: ctx.activeProcesses()[id]?.chromeProcess?.pid || null, ...(await runningCdp(id) || { remote_debugging_port: null, note: 'Opened from the BNC window — no CDP port' }) });
            }
            return { count: out.length, profiles: out };
        },

        async list_groups() {
            const groups = (await ctx.invoke('get-groups')) || [];
            const profiles = await loadProfiles();
            return { groups: groups.map(g => ({ id: g.id, name: g.name, created_at: g.createdAt ? new Date(g.createdAt).toISOString() : null, profile_count: profiles.filter(p => p.groupId === g.id).length })) };
        },

        async create_group(a) {
            const name = String(a.name || '').trim();
            if (!name) throw new ToolError('name is required');
            const g = await ctx.invoke('save-group', { name });
            ctx.refreshUI();
            return { success: true, group: { id: g?.id, name: g?.name || name } };
        },

        async update_group(a) {
            const groups = (await ctx.invoke('get-groups')) || [];
            if (!groups.find(g => g.id === a.id)) throw new ToolError(`Group not found: ${a.id}`);
            const name = String(a.name || '').trim();
            if (!name) throw new ToolError('name is required');
            await ctx.invoke('update-group', { id: a.id, name });
            ctx.refreshUI();
            return { success: true, group: { id: a.id, name } };
        },

        async delete_group(a) {
            if (a.confirm !== true) throw new ToolError('Refused: ask the user, then call again with confirm=true.');
            const groups = (await ctx.invoke('get-groups')) || [];
            const g = groups.find(x => x.id === a.id);
            if (!g) throw new ToolError(`Group not found: ${a.id}`);
            await ctx.invoke('delete-group', g.id);
            ctx.refreshUI();
            return { success: true, message: 'Group deleted, its profiles are now ungrouped', group: { id: g.id, name: g.name } };
        },

        async list_extensions() {
            const exts = (await ctx.invoke('get-user-extensions')) || [];
            return { extensions: exts.map(e => typeof e === 'string' ? { path: e } : { id: e.id, name: e.name, path: e.path, enabled: e.enabled !== false }) };
        },
    };
}

// ─── JSON-RPC dispatch ──────────────────────────────────────────────────────
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function dispatch(msg, ctx, tools, state) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return rpcError(msg?.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const { method, params = {} } = msg;

    if (isNotification) return null; // notifications/initialized, notifications/cancelled… — nothing to do

    try {
        switch (method) {
            case 'initialize': {
                const requested = params.protocolVersion;
                const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
                const sid = crypto.randomUUID();
                sessions.set(sid, { createdAt: Date.now(), protocolVersion, client: params.clientInfo || null });
                state.newSessionId = sid;
                return { jsonrpc: '2.0', id: msg.id, result: {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'bnc', title: 'BNC Browser', version: ctx.appVersion },
                    instructions: 'BNC anti-detect browser. Typical flow: list_profiles → start_profile (returns websocket_debugging_url) → drive the browser over CDP (Playwright connectOverCDP / Puppeteer connect) → stop_profile. Never call delete_profile/delete_group without the user\'s explicit consent.',
                } };
            }
            case 'ping':
                return { jsonrpc: '2.0', id: msg.id, result: {} };
            case 'tools/list':
                return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
            case 'tools/call': {
                const name = params.name;
                const fn = tools[name];
                if (!fn) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
                const args = params.arguments || {};
                ctx.log({ tool: name, args: { ...args, proxy: args.proxy ? maskProxy(args.proxy) : undefined } });
                try {
                    const out = await fn(args);
                    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false } };
                } catch (e) {
                    const text = e instanceof ToolError ? e.message : `Internal error: ${e.message}`;
                    if (!(e instanceof ToolError)) ctx.log({ tool: name, error: e.stack || e.message });
                    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } };
                }
            }
            case 'resources/list':
                return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };
            case 'prompts/list':
                return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
            default:
                return rpcError(msg.id, -32601, `Method not found: ${method}`);
        }
    } catch (e) {
        return rpcError(msg.id, -32603, e.message);
    }
}

// ─── HTTP entry ─────────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
}

/**
 * ctx = {
 *   appVersion, settings(): Promise<object>, invoke(channel, ...args), activeProcesses(),
 *   reservePort(profileId, opts) -> port, releasePort(profileId), requestLaunch(profileId, timeoutMs) -> {ok, error},
 *   refreshUI(), log(obj)
 * }
 */
function createMcpHandler(ctx) {
    const tools = createTools(ctx);

    return async function handleMcp(req, res) {
        // CORS / DNS-rebinding protection: only local Host, and only local (or absent) Origin.
        res.removeHeader('Access-Control-Allow-Origin');
        const host = req.headers.host || '';
        const origin = req.headers.origin;
        if (!LOCAL_HOST_RE.test(host)) return send(res, 403, rpcError(null, -32000, 'Forbidden host'));
        if (origin && !LOCAL_ORIGIN_RE.test(origin)) return send(res, 403, rpcError(null, -32000, 'Forbidden origin'));

        const settings = await ctx.settings();
        if (!settings.enableMcp) {
            return send(res, 404, { error: 'MCP is disabled. Enable it in BNC Settings > API Server > MCP.' });
        }
        const key = settings.apiKey;
        if (!key) return send(res, 401, { error: 'MCP requires an API key. Set one in BNC Settings > API Server.' });
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] || '');
        const a = Buffer.from(String(provided)), b = Buffer.from(String(key));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return send(res, 401, rpcError(null, -32001, 'Unauthorized'), { 'WWW-Authenticate': 'Bearer' });
        }

        if (req.method === 'DELETE') {
            const sid = req.headers['mcp-session-id'];
            if (sid) sessions.delete(sid);
            return send(res, 200, undefined);
        }
        if (req.method === 'GET') {
            // No server-initiated SSE stream.
            return send(res, 405, undefined, { Allow: 'POST, DELETE' });
        }
        if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST, DELETE' });

        const ctype = String(req.headers['content-type'] || '');
        if (!ctype.includes('application/json')) return send(res, 415, rpcError(null, -32700, 'Content-Type must be application/json'));

        let raw = '';
        try {
            raw = await new Promise((resolve, reject) => {
                let d = '';
                req.on('data', c => { d += c; if (d.length > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); } });
                req.on('end', () => resolve(d));
                req.on('error', reject);
            });
        } catch (e) { return send(res, 413, rpcError(null, -32700, e.message)); }

        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return send(res, 400, rpcError(null, -32700, 'Parse error')); }

        const msgs = Array.isArray(msg) ? msg : [msg];
        const isInit = msgs.some(m => m && m.method === 'initialize');
        const sid = req.headers['mcp-session-id'];
        if (!isInit && sid && !sessions.has(sid)) {
            // Session expired (e.g. BNC restarted) → client must re-initialize.
            return send(res, 404, rpcError(null, -32000, 'Session not found'));
        }

        const state = {};
        const replies = [];
        for (const m of msgs) {
            const r = await dispatch(m, ctx, tools, state);
            if (r) replies.push(r);
        }
        const headers = state.newSessionId ? { 'Mcp-Session-Id': state.newSessionId } : {};
        if (!replies.length) { res.writeHead(202, headers); return res.end(); }
        return send(res, 200, Array.isArray(msg) ? replies : replies[0], headers);
    };
}

module.exports = { createMcpHandler, TOOLS, maskProxy };
