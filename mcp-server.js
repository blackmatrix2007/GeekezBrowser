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

const TOOLS = [
    {
        name: 'list_profiles',
        description: 'List BNC browser profiles (paginated). Each item: id, name, group, tags, has_proxy, running.',
        inputSchema: { type: 'object', properties: {
            page: S.int('Page number, starts at 1', { minimum: 1, default: 1 }),
            page_size: S.int('Items per page (max 200)', { minimum: 1, maximum: 200, default: 50 }),
            search: S.str('Case-insensitive filter on name, tags and note'),
            group_id: S.str('Only profiles in this group ("none" = ungrouped)'),
            running_only: { type: 'boolean', description: 'Only running profiles' },
        } },
    },
    {
        name: 'get_profile',
        description: 'Get one profile: settings, proxy, key fingerprint fields, running state and CDP endpoint if running.',
        inputSchema: { type: 'object', properties: { id: S.id }, required: ['id'] },
    },
    {
        name: 'create_profile',
        description: 'Create a new profile with a freshly generated fingerprint (same path as the "New profile" button).',
        inputSchema: { type: 'object', properties: {
            name: S.str('Profile name'),
            proxy: S.str('Proxy string, e.g. socks5://user:pass@host:port, http://host:port, host:port:user:pass, or a vmess/vless/trojan/ss link. Empty = direct'),
            group_id: S.str('Group ID to put the profile in'),
            tags: { type: 'array', items: { type: 'string' } },
            note: S.str('Free-text note'),
            timezone: S.str('IANA timezone, e.g. Asia/Ho_Chi_Minh. Omit = "Auto" (from proxy IP at launch)'),
            language: S.str('Browser language, e.g. vi-VN. Omit = auto'),
            screen_width: S.int('Custom screen width (needs screen_height)'),
            screen_height: S.int('Custom screen height (needs screen_width)'),
        }, required: ['name'] },
    },
    {
        name: 'update_profile',
        description: 'Update profile settings. Only the given fields change. Takes effect on next start.',
        inputSchema: { type: 'object', properties: {
            id: S.id,
            name: S.str('New name'),
            proxy: S.str('New proxy string ("" = direct)'),
            group_id: S.str('Group ID ("" = remove from group)'),
            tags: { type: 'array', items: { type: 'string' } },
            note: S.str('Note'),
            timezone: S.str('IANA timezone or "Auto"'),
            language: S.str('Browser language or "auto"'),
        }, required: ['id'] },
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
        description: 'Start a profile and return its Chrome DevTools Protocol endpoint. Connect with Playwright chromium.connectOverCDP(websocket_debugging_url), puppeteer.connect({browserWSEndpoint}), or raw CDP. Respects slot/lock limits of the BNC account.',
        inputSchema: { type: 'object', properties: {
            id: S.id,
            allow_origins: S.str('Value for --remote-allow-origins, only needed by clients that send an Origin header on the CDP websocket (e.g. Python websocket-client). Example: "http://localhost". Avoid "*".'),
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
        http_endpoint: `http://127.0.0.1:${port}`,
        websocket_debugging_url: version?.webSocketDebuggerUrl || null,
        browser: version?.Browser || null,
    };
}

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
        running: isRunning(p.id),
    });
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
            const size = Math.min(200, Math.max(1, parseInt(a.page_size) || 50));
            const groups = await groupMap();
            let list = await loadProfiles();
            if (a.search) {
                const q = String(a.search).toLowerCase();
                list = list.filter(p => [p.name, p.note, ...(p.tags || [])].some(s => s && String(s).toLowerCase().includes(q)));
            }
            if (a.group_id) list = list.filter(p => a.group_id === 'none' ? !p.groupId : p.groupId === a.group_id);
            if (a.running_only) list = list.filter(p => isRunning(p.id));
            const total = list.length;
            return {
                total, page, page_size: size, total_pages: Math.max(1, Math.ceil(total / size)),
                profiles: list.slice((page - 1) * size, page * size).map(p => summary(p, groups)),
            };
        },

        async get_profile(a) {
            const p = await findProfile(a.id);
            const fp = p.fingerprint || {};
            return {
                ...summary(p, await groupMap()),
                proxy: maskProxy(p.proxyStr),
                pre_proxy: p.preProxyOverride || 'default',
                created_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
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
            const name = String(a.name || '').trim();
            if (!name) throw new ToolError('name is required');
            if (a.group_id) {
                const groups = await groupMap();
                if (!groups[a.group_id]) throw new ToolError(`Group not found: ${a.group_id}`);
            }
            const data = {
                name,
                proxyStr: a.proxy || '',
                tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
                note: a.note || '',
                timezone: a.timezone || undefined,
                language: a.language || undefined,
                groupId: a.group_id || null,
                preProxyOverride: 'default',
            };
            if (a.screen_width && a.screen_height) data.screen = { width: parseInt(a.screen_width), height: parseInt(a.screen_height) };
            const p = await ctx.invoke('save-profile', data);
            ctx.refreshUI();
            return { created: true, profile: summary(p, await groupMap()) };
        },

        async update_profile(a) {
            const p = await findProfile(a.id);
            const next = { ...p, fingerprint: { ...(p.fingerprint || {}) } };
            const changed = [];
            if (a.name !== undefined) { const n = String(a.name).trim(); if (!n) throw new ToolError('name cannot be empty'); next.name = n; changed.push('name'); }
            if (a.proxy !== undefined) { next.proxyStr = String(a.proxy); changed.push('proxy'); }
            if (a.tags !== undefined) { next.tags = Array.isArray(a.tags) ? a.tags.map(String) : []; changed.push('tags'); }
            if (a.note !== undefined) { next.note = String(a.note); changed.push('note'); }
            if (a.group_id !== undefined) {
                if (a.group_id && !(await groupMap())[a.group_id]) throw new ToolError(`Group not found: ${a.group_id}`);
                next.groupId = a.group_id || null; changed.push('group_id');
            }
            if (a.timezone !== undefined) { next.fingerprint.timezone = a.timezone || 'Auto'; changed.push('timezone'); }
            if (a.language !== undefined) {
                if (!a.language || a.language === 'auto') delete next.fingerprint.language; else next.fingerprint.language = a.language;
                changed.push('language');
            }
            if (!changed.length) throw new ToolError('Nothing to update');
            const ok = await ctx.invoke('update-profile', next);
            if (!ok) throw new ToolError('Update failed');
            ctx.refreshUI();
            return { updated: changed, running: isRunning(p.id), note: isRunning(p.id) ? 'Profile is running — changes apply after restart' : undefined };
        },

        async delete_profile(a) {
            if (a.confirm !== true) throw new ToolError('Refused: deleting is permanent. Ask the user, then call again with confirm=true.');
            const p = await findProfile(a.id);
            await ctx.invoke('delete-profile', p.id);
            ctx.refreshUI();
            return { deleted: true, id: p.id, name: p.name };
        },

        async start_profile(a) {
            const p = await findProfile(a.id);
            if (p.isLocked) throw new ToolError('Profile is locked (no slot). Buy/upgrade a plan in BNC to unlock it.');
            if (isRunning(p.id)) {
                const cdp = await runningCdp(p.id);
                if (cdp) return { id: p.id, name: p.name, already_running: true, ...cdp };
                throw new ToolError('Profile is already running without a CDP port (started from the UI). Call stop_profile, then start_profile again.');
            }
            if (a.allow_origins && !String(a.allow_origins).split(',').every(o => o === '*' || /^https?:\/\/[A-Za-z0-9.\-\[\]:]+$/.test(o.trim()))) {
                throw new ToolError('allow_origins must be a comma-separated list of origins like http://localhost:3000');
            }
            const timeoutMs = Math.min(300, Math.max(10, parseInt(a.timeout_sec) || 90)) * 1000;
            const port = await ctx.reservePort(p.id, { allowOrigins: a.allow_origins || null });
            const result = await ctx.requestLaunch(p.id, timeoutMs);
            if (!result || !result.ok) {
                ctx.releasePort(p.id);
                throw new ToolError(`Start failed: ${result?.error || 'unknown error'}`);
            }
            const proc = ctx.activeProcesses()[p.id];
            const realPort = proc?.debugPort || port;
            const version = await waitForCdp(realPort, Math.min(30000, timeoutMs));
            return { id: p.id, name: p.name, pid: proc?.chromeProcess?.pid || null, ...cdpInfo(realPort, version) };
        },

        async stop_profile(a) {
            const p = await findProfile(a.id);
            if (!isRunning(p.id)) return { stopped: false, id: p.id, message: 'Profile is not running' };
            const r = await ctx.invoke('stop-profile', p.id);
            return { stopped: !!r?.success, id: p.id, name: p.name };
        },

        async list_running_profiles() {
            const profiles = await loadProfiles();
            const ids = Object.keys(ctx.activeProcesses()).filter(isRunning);
            const out = [];
            for (const id of ids) {
                const p = profiles.find(x => x.id === id);
                out.push({ id, name: p?.name || null, cdp: await runningCdp(id) });
            }
            return { count: out.length, profiles: out };
        },

        async list_groups() {
            const groups = (await ctx.invoke('get-groups')) || [];
            const profiles = await loadProfiles();
            return { groups: groups.map(g => ({ id: g.id, name: g.name, profile_count: profiles.filter(p => p.groupId === g.id).length })) };
        },

        async create_group(a) {
            const name = String(a.name || '').trim();
            if (!name) throw new ToolError('name is required');
            const g = await ctx.invoke('save-group', { name });
            ctx.refreshUI();
            return { created: true, group: { id: g?.id, name: g?.name || name } };
        },

        async update_group(a) {
            const groups = (await ctx.invoke('get-groups')) || [];
            if (!groups.find(g => g.id === a.id)) throw new ToolError(`Group not found: ${a.id}`);
            const name = String(a.name || '').trim();
            if (!name) throw new ToolError('name is required');
            await ctx.invoke('update-group', { id: a.id, name });
            ctx.refreshUI();
            return { updated: true, id: a.id, name };
        },

        async delete_group(a) {
            if (a.confirm !== true) throw new ToolError('Refused: ask the user, then call again with confirm=true.');
            const groups = (await ctx.invoke('get-groups')) || [];
            const g = groups.find(x => x.id === a.id);
            if (!g) throw new ToolError(`Group not found: ${a.id}`);
            await ctx.invoke('delete-group', g.id);
            ctx.refreshUI();
            return { deleted: true, id: g.id, name: g.name };
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
