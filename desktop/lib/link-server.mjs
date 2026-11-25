// The phone-facing server: HTTPS + WSS with a pinned self-signed certificate.
//
//   GET  /mobile/v1/hello        unauthenticated: { desktop: {id,name}, protocol, fingerprint }
//   POST /mobile/v1/pair         { code, device } -> { desktop, token }        (one-time QR code)
//   POST /mobile/v1/web-session  bearer -> HttpOnly cookie for official DSH UI (read-only or writable)
//   GET  /mobile/v1/session      bearer/cookie -> { desktop, device, actions, terminal, upstream }
//   GET  /mobile/v1/sync         bearer/cookie -> { actions, terminal, upstream, desktopFocus }
//   GET  /mobile/v1/shell.css|js bearer/cookie -> mobile ergonomic layer for official DSH UI
//   POST /mobile/v1/unpair       bearer/cookie -> 204                          (phone forgets itself)
//   GET  /api/*                  cookie (official) -> DSH shared /api Fetch routes (media, previews, exports, icons)
//   POST /api/<method>           bearer/cookie -> DSH RPC envelope or streaming upload
//   WSS  /api/remote.mux         bearer/cookie -> DSH stream mux
//
// DSH frames are forwarded unchanged in both directions, so the phone parses
// exactly what the desktop web UI receives.
import { cloudRoute } from './family.mjs';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { createDesktopWeather } from './desktop-weather.mjs';
import { directoryPickerFallback } from './directory-picker.mjs';
import { writePrivate } from './identity.mjs';
import { MOBILE_FILE_LIMIT } from './mobile-attachments.mjs';
import { MOBILE_SHELL_CSS, MOBILE_SHELL_JS } from './mobile-shell.mjs';
import { WebSocket, WebSocketServer } from 'ws';

export const PROTOCOL = 1;
export const READ_RPC = new Set([
  'session/list', 'session/page', 'session/projections', 'session/modelCatalog', 'session/search',
  'session/attachment', 'workspace/list', 'skills/list', 'goals/get',
  'schedule/catalog', 'schedule/list', 'schedule/history', 'terminal/list',
  'permissionPresets/catalog', 'agentPresets/list', 'agentPresets/read',
  'workspaceFiles/list', 'mobileFiles/download', 'mobileOffice/read', 'mobileGit/status', 'mobileGit/diff', 'mobileHost/status', 'mobileRelay/status',
  'settings/describe', 'credentials/describe', 'llm/listConfigurableProviders', 'llm/listProviders',
  'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/registries', 'pluginManager/inspect',
  'pluginMarket/listIndexes', 'pluginMarket/search', 'pluginInventory/list', 'mobilePanels/list', 'mobilePanels/read',
]);
export const ACTION_RPC = new Set([
  'directoryPicker/list', 'directoryPicker/createDirectory', 'session/create', 'session/prompt', 'session/selectModel', 'session/cancel', 'session/rename',
  'session/fork', 'session/updateQueue', 'workspace/archiveSession', 'workspace/unarchiveSession',
  'workspace/pinSession', 'workspace/unpinSession', 'workspace/create', 'workspace/rename',
  'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore', 'job/kill',
  'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  'schedule/update', 'schedule/delete', 'mobileSchedule/create', 'mobileRelay/request', 'userQuestions/answer', '$events/result',
  'subagents/prompt', 'subagents/interruptByParent', 'agentPresets/select', 'mobilePermissions/select',
  'settings/mutate', 'credentials/set', 'credentials/unset', 'llm/discoverModels',
  'pluginManager/installBundle', 'pluginManager/cancelInstall', 'pluginManager/removeBundle',
  'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled', 'pluginMarket/setIndexes', 'mobilePanels/perform',
]);
export const TERMINAL_RPC = new Set(['terminal/create', 'terminal/close', 'terminal/rename', 'terminal/shells', 'terminal/environment']);
const CONTROL_RPC = new Set([...READ_RPC, ...ACTION_RPC]);
export const READ_STREAMS = new Set([
  '$events', 'session/control', 'session/follow', 'workspace/follow', 'job/list', 'job/follow', 'remoteAccess/follow',
]);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_UPLOAD_BODY = 64 * 1024 * 1024;
const MAX_STREAMS = 16;
const COMPRESSIBLE_RPC = new Set([
  'session/page', 'session/list', 'session/projections', 'session/search',
  'workspace/list', 'session/modelCatalog', 'skills/list', 'settings/describe',
  'pluginManager/listPlugins', 'pluginInventory/list',
  'mobileOffice/read', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'officeKit/render',
]);
const HISTORY_THRESHOLD = 1024;
const BROWSER_SESSION_TTL_MS = 7 * 86400e3;
const gzipHistory = promisify(gzip);
const acceptsEncoding = (header, encoding) => String(header ?? '').split(',').some(part =>
  new RegExp(`^\\s*${encoding}\\s*(?:;\\s*q=(?:1(?:\\.0{0,3})?|0\\.(?=\\d*[1-9])\\d{1,3}))?\\s*$`, 'i').test(part));
// Only choose gzip when explicitly accepted (including respecting gzip;q=0).
const acceptsGzip = header => acceptsEncoding(header, 'gzip');

const OFFICIAL_READ_ACTION_PATTERN = /^(?:list|get|read|describe|catalog|search|history|inspect|status|diff|projections|page|attachment|preview|modelCatalog|shells|environment|stat|info|check|resolve|outline|stats|snapshot|summary|fetch)(?:[A-Z].*)?$/;
const OFFICIAL_READ_STREAM_PATTERN = /^(?:follow|list|watch|subscribe|status|events|snapshot)(?:[A-Z].*)?$/;

/** Read-only official DSH RPC allowlist used when the user keeps "Allow phone actions" off. */
export function isOfficialReadRpc(method) {
  if (typeof method !== 'string' || !method || method.length > 200 || /[?#\\\s]/.test(method)) return false;
  if (READ_RPC.has(method)) return true;
  if (method === 'schedule/view') return true;
  if (ACTION_RPC.has(method) || TERMINAL_RPC.has(method) || method.startsWith('terminal/')) return false;
  if (method.startsWith('remoteAccess/')) return true;
  const slash = method.lastIndexOf('/');
  if (slash <= 0 || slash === method.length - 1) return false;
  return OFFICIAL_READ_ACTION_PATTERN.test(method.slice(slash + 1));
}

/** Read-only official DSH stream allowlist used when the user keeps "Allow phone actions" off. */
export function isOfficialReadStream(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 200 || /[?#\\\s]/.test(endpoint)) return false;
  if (READ_STREAMS.has(endpoint)) return true;
  if (endpoint.startsWith('terminal/')) return false;
  const slash = endpoint.lastIndexOf('/');
  if (slash <= 0 || slash === endpoint.length - 1) return false;
  return OFFICIAL_READ_STREAM_PATTERN.test(endpoint.slice(slash + 1));
}

const json = (res, status, value, extra = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
};

async function readBody(req, limit = MAX_BODY) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const e = new Error('too-large'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const bearer = req => {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

const peerAddress = req => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/** Per-address sliding window for unauthenticated endpoints. */
class RateLimit {
  #hits = new Map();
  constructor(max, windowMs, now = () => Date.now()) { Object.assign(this, { max, windowMs, now }); }
  allow(key) {
    const t = this.now(), list = (this.#hits.get(key) ?? []).filter(x => t - x < this.windowMs);
    if (list.length >= this.max) { this.#hits.set(key, list); return false; }
    list.push(t); this.#hits.set(key, list);
    if (this.#hits.size > 4096) this.#hits.clear();
    return true;
  }
}

/**
 * Validate one client -> host mux frame. Only `open` of an allowlisted stream
 * and `cancel` are accepted; session/follow may not activate a session unless
 * running an official writable browser session.
 */
export function checkClientFrame(msg, open, policy, terminal = false, officialWritable = false, maxStreams = MAX_STREAMS) {
  if (!msg || typeof msg !== 'object' || typeof msg.streamId !== 'string' || !msg.streamId || msg.streamId.length > 128) return 'bad-frame';
  if (msg.type === 'cancel') return open.has(msg.streamId) ? 'ok' : 'unknown-stream';
  if (msg.type === 'item' && terminal && open.get?.(msg.streamId) === 'terminal/attach') {
    const value = msg.value;
    if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return 'bad-input';
    if (value.type === 'write' && typeof value.data === 'string' && Buffer.byteLength(value.data) <= 32768) return 'ok';
    if (value.type === 'resize' && [value.cols, value.rows].every(n => Number.isSafeInteger(n) && n >= 2 && n <= 500)) return 'ok';
    return 'bad-input';
  }
  if (msg.type !== 'open') return 'write-forbidden';
  if (!policy.streams.has(msg.endpoint) && !(terminal && msg.endpoint === 'terminal/attach')) return 'endpoint-forbidden';
  if (open.has(msg.streamId)) return 'duplicate-stream';
  if (open.size >= (officialWritable ? 64 : maxStreams)) return 'too-many-streams';
  const args = msg.payload?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'bad-args';
  if (!officialWritable && msg.endpoint === 'session/follow' && args.request?.activate) return 'write-forbidden';
  return 'ok';
}

/** Validate a client RPC envelope against the method in the URL. */
export function checkEnvelope(envelope, method, policy) {
  if (!policy.rpc.has(method)) return 'method-forbidden';
  if (!envelope || envelope.type !== 'client-request' || envelope.method !== method || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128) return 'bad-envelope';
  const args = envelope.payload?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'bad-envelope';
  return 'ok';
}

const BROTLI_ASSET_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } };
function buildShellAsset(type, raw) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const digest = createHash('sha256').update(body).digest('base64url');
  return {
    type,
    body,
    gzip: gzipSync(body, { level: 5 }),
    br: brotliCompressSync(body, BROTLI_ASSET_OPTS),
    etag: 'W/"' + digest + '"',
    version: digest.slice(0, 10),
  };
}
const fflateBrowser = readFileSync(join(dirname(createRequire(import.meta.url).resolve('fflate')), '../umd/index.js'));
function workerAsset(file) {
  const source = Buffer.concat([fflateBrowser, Buffer.from('\n;'), readFileSync(new URL(file, import.meta.url))]);
  return buildShellAsset('text/javascript; charset=utf-8', source);
}
const SHELL_ASSETS = {
  '/mobile/v1/reader-worker.js': workerAsset('./reader-worker.js'),
  '/mobile/v1/folder-worker.js': workerAsset('./folder-worker.js'),
  '/mobile/v1/shell.css': buildShellAsset('text/css; charset=utf-8', MOBILE_SHELL_CSS),
  '/mobile/v1/shell.js': buildShellAsset('text/javascript; charset=utf-8', MOBILE_SHELL_JS),
};

// Only callers with allowlisted fields write here. Keep one bounded snapshot and
// one writer even if a burst arrives while the previous atomic rename is pending.
function linkJournal(file, log) {
  const maxBytes = 256 * 1024, maxLines = 500;
  let lines = [], writing, dirty = false, warned = false;
  const warn = () => {
    if (!warned) log({ type: 'error', where: 'link-events', message: 'event journal unavailable' });
    warned = true;
  };
  try {
    if (statSync(file).size <= maxBytes) lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-maxLines);
  } catch (error) { if (error.code !== 'ENOENT') warn(); }
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  return {
    record(event) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event });
      lines.push(line); bytes += Buffer.byteLength(line) + 1;
      while (lines.length > maxLines || bytes > maxBytes) bytes -= Buffer.byteLength(lines.shift()) + 1;
      dirty = true;
      writing ??= (async () => {
        do {
          dirty = false;
          try { await writePrivate(file, lines.join('\n') + '\n'); } catch { warn(); }
        } while (dirty);
        writing = undefined;
      })();
    },
    flush: () => writing,
  };
}

/**
 * @param {object} o
 * @param {{id,name,cert,key,fingerprint}} o.identity
 * @param {import('./devices.mjs').DeviceRegistry} o.devices
 * @param {import('./devices.mjs').PairingCodes} o.codes
 * @param {{ rpc(method: string, body: Buffer, id?: string): Promise<{status:number, contentType?:string, body:Buffer}>, fetch?: Function, upload?: Function, peerFor?: Function, mux(id?: string): Promise<{ send(text:string):void, close():void, on(event:'message'|'close', fn):void }>, available?(): boolean }} o.upstream
 * @param {{rpc:Set<string>, streams:Set<string>}} [o.policy]
 * @param {(event: object) => void} [o.log]
 */
export function createLinkServer({
  identity, devices, codes, upstream, officialWeb, focus, wake, endpoints, stateDir, notifications,
  policy = { rpc: READ_RPC, streams: READ_STREAMS }, log = () => {}, appVersion = '',
  actions = () => false, terminal = () => false,
}) {
  const allowTerminal = () => actions() && terminal();
  const desktopWeather = createDesktopWeather();
  const weatherLimit = new RateLimit(6, 60000);
  const pairLimit = new RateLimit(20, 60e3), helloLimit = new RateLimit(120, 60e3);
  const sockets = new Map(); // deviceId -> Set<WebSocket>
  const browserSessions = new Map();
  const browserRequests = new WeakSet();
  const cookieName = '__Host-dsh-mobile';
  const hashToken = value => createHash('sha256').update(value).digest('base64url');
  const journal = stateDir && process.env.DSH_LINK_EVENTS !== '0' ? linkJournal(join(stateDir, 'link-events.jsonl'), log) : null;
  const bridgeLimit = new RateLimit(120, 60e3);
  const socketTrace = new WeakMap();
  const deviceTag = id => hashToken(id).slice(0, 16);
  const muxTag = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? deviceTag(id) : null;
  function serverClose(ws, source) {
    const trace = socketTrace.get(ws);
    if (trace && !trace.source) trace.source = source;
  }
  const sessionsFile = stateDir ? join(stateDir, 'web-sessions.json') : null;
  let sessionWrites = Promise.resolve();
  // Hydrate unexpired hashed browser sessions so phone cookies survive desktop restarts cleanly.
  if (sessionsFile) {
    try {
      const saved = JSON.parse(readFileSync(sessionsFile, 'utf8'));
      const byId = new Map((devices.list?.() ?? []).map(d => [d.id, d]));
      const now = Date.now();
      for (const entry of Array.isArray(saved) ? saved : []) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.deviceId !== 'string') continue;
        if (!(entry.expiresAt > now)) continue;
        const dev = byId.get(entry.deviceId);
        if (dev) browserSessions.set(entry.key, { device: dev, expiresAt: entry.expiresAt });
      }
    } catch {}
  }
  const persistBrowserSessions = () => {
    if (!sessionsFile) return;
    const now = Date.now();
    const snapshot = [];
    for (const [key, session] of browserSessions) {
      if (session.expiresAt > now) snapshot.push({ key, deviceId: session.device.id, expiresAt: session.expiresAt });
    }
    const payload = JSON.stringify(snapshot);
    sessionWrites = sessionWrites.then(() => writePrivate(sessionsFile, payload), () => writePrivate(sessionsFile, payload)).catch(() => {});
  };
  const allEndpoints = { has: value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[?#\\\s]/.test(value) };
  const officialReadRpcPolicy = { rpc: { has: isOfficialReadRpc } };
  const officialReadStreamPolicy = { streams: { has: isOfficialReadStream } };
  const sameOrigin = req => {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
    try { return new URL(origin).origin === new URL('https://' + req.headers.host).origin; } catch { return false; }
  };
  const forgetBrowserDevice = devices.onChange?.(event => {
    if (event.type === 'removed') {
      let removed = false;
      for (const [key, session] of browserSessions) {
        if (session.device.id === event.id) { browserSessions.delete(key); removed = true; }
      }
      if (removed) persistBrowserSessions();
    }
  });
  const hasLiveSocket = deviceId => {
    const set = sockets.get(deviceId);
    if (!set || !set.size) return false;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) return true;
    return false;
  };
  const pokeSockets = deviceId => {
    const set = sockets.get(deviceId);
    if (!set) return;
    for (const ws of [...set]) {
      if (ws.readyState !== WebSocket.OPEN) { set.delete(ws); continue; }
      try { ws.ping(); } catch { try { serverClose(ws, 'poke-terminate'); ws.terminate(); } catch {} }
    }
  };
  // A single outstanding revision watch per visible page. Bound idle sockets and
  // detach the waiter on timeout, client abort, revocation or service shutdown.
  const syncWaiters = new Map();
  const wakeSync = () => { for (const wake of syncWaiters.keys()) wake(); };
  const unsubscribeFocus = focus?.subscribe?.(wakeSync);
  const syncState = (deviceId) => {
    const state = { actions: actions(), terminal: allowTerminal(), upstream: upstream.available?.() ?? true,
      desktopFocus: focus?.snapshot() ?? null, app: appVersion,
      ...(deviceId ? { wsAlive: hasLiveSocket(deviceId) } : {}) };
    return { ...state, cursor: [state.desktopFocus?.revision ?? 0, +state.actions, +state.terminal, +state.upstream].join(':') };
  };
  const desktop = () => ({ id: identity.id, name: identity.name });
  // Decisions must answer live events delivered on this phone's own socket.
  const deliveries = new Map();
  function claimDelivery(deviceId, args) {
    if (typeof args.clientId !== 'string' || typeof args.eventId !== 'string' ||
        args.outcome?.kind !== 'result' || !Object.hasOwn(args.outcome, 'value')) return null;
    for (const record of deliveries.values()) {
      if (record.deviceId !== deviceId || record.clientId !== args.clientId) continue;
      const event = record.pending.get(args.eventId);
      const answer = args.outcome.value;
      if (!event || event.busy) return null;
      if (event.kind === 'approval' && !['allowed-once', 'rejected'].includes(answer)) return null;
      if (event.kind === 'question' && !Array.isArray(answer?.answers)) return null;
      event.busy = true;
      return { record, event };
    }
    return null;
  }

  const authorize = req => {
    let device = devices.verify(bearer(req));
    if (!device && !req.headers.authorization && sameOrigin(req)) {
      const cookies = String(req.headers.cookie ?? '').split(';').map(value => value.trim());
      const token = cookies.find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const key = hashToken(token), session = browserSessions.get(key);
        if (session && session.expiresAt > Date.now()) { device = session.device; browserRequests.add(req); }
        else if (session) browserSessions.delete(key);
      }
    }
    if (device) devices.touch(device.id, peerAddress(req)).catch(() => {});
    return device;
  };

  const server = https.createServer({
    key: identity.key,
    cert: identity.cert,
    minVersion: 'TLSv1.2',
    sessionTimeout: 86400,
    // A 200 MiB upload over a mobile uplink can take several minutes.
    requestTimeout: 20 * 60e3,
    headersTimeout: 95e3,
    keepAliveTimeout: 90e3,
  }, async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://link.invalid');
    const path = url.pathname;
    try {
      if (path === '/mobile/v1/hello' && req.method === 'GET') {
        if (!helloLimit.allow(peerAddress(req))) return json(res, 429, { error: 'rate-limited' });
        return json(res, 200, { desktop: desktop(), protocol: PROTOCOL, fingerprint: identity.fingerprint, app: appVersion, upstream: upstream.available?.() ?? true });
      }
      if (path === '/mobile/v1/pair' && req.method === 'POST') {
        if (!pairLimit.allow(peerAddress(req))) return json(res, 429, { error: 'rate-limited' });
        let body;
        try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch (e) { return json(res, e.status ?? 400, { error: 'bad-request' }); }
        const verdict = codes.redeem(body?.code);
        if (verdict !== 'ok') { log({ type: 'pair-rejected', reason: verdict, address: peerAddress(req) }); return json(res, verdict === 'locked' ? 429 : 403, { error: `code-${verdict}` }); }
        const { device, token } = await devices.add(body?.device ?? {});
        log({ type: 'paired', device: { id: device.id, name: device.name }, address: peerAddress(req) });
        return json(res, 200, { desktop: desktop(), token });
      }
      const device = authorize(req);
      if (!device) return json(res, 401, { error: 'pairing-required' }, { 'WWW-Authenticate': 'Bearer' });
      if (path === '/mobile/v1/cloud-route' && req.method === 'GET') {
        const native = devices.verify(bearer(req));
        if (!native || native.delegated) return json(res, 403, {error: 'desktop-bearer-required'});
        const route = await cloudRoute(stateDir, identity.id, native);
        return route ? json(res, 200, route) : json(res, 404, {error: 'cloud-not-configured'});
      }
      if (path === '/mobile/v1/weather' && req.method === 'POST') {
        if (!weatherLimit.allow(device.id)) return json(res, 429, { error:'rate-limited' });
        let body;
        try { body = JSON.parse((await readBody(req, 256)).toString('utf8')); }
        catch (e) { return json(res, e.status ?? 400, {error: 'bad-request'}); }
        if (!body || Object.keys(body).length !== 1 || !['clock', 'weather'].includes(body.mode)) {
          return json(res, 400, {error: 'expected-desktop-weather-mode'});
        }
        return json(res, 200, await desktopWeather(body.mode), {'Cache-Control': 'no-store'});
      }
      if (path === '/mobile/v1/task-notifications' && notifications) {
        // Native paired-device token only; never expose push credentials or controls to WebView scripts.
        if (!devices.verify(bearer(req))) return json(res, 401, {error:'bearer-required'});
        if (req.method === 'GET') return json(res,200,notifications.status(device.id));
        if (req.method !== 'POST') return json(res,405,{error:'method'});
        try { await notifications.configure(device.id, JSON.parse((await readBody(req,4096)).toString('utf8'))); }
        catch(e){return json(res,e instanceof SyntaxError?400:e.status??500,{error:'notification-config-failed'});}
        return json(res,200,{ok:true});
      }
      if (path === '/mobile/v1/web-session' && req.method === 'POST') {
        if (!devices.verify(bearer(req))) return json(res, 401, { error: 'bearer-required' });
        if (!officialWeb?.available()) return json(res, 503, { error: 'official-web-unavailable' });
        // Keep tokens out of HTML, JS and URLs. Browser sessions are host scoped,
        // short lived, and invalidated immediately with their paired device.
        // Works in both read-only watch mode and writable action mode.
        const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + BROWSER_SESSION_TTL_MS;
        for (const [key, session] of browserSessions) if (session.expiresAt <= Date.now()) browserSessions.delete(key);
        if (browserSessions.size >= 128) browserSessions.delete(browserSessions.keys().next().value);
        browserSessions.set(hashToken(token), { device, expiresAt });
        persistBrowserSessions();
        const advertisedEndpoints = typeof endpoints === 'function' ? endpoints() : [];
        return json(res, 200, {
          url: '/', desktop: desktop(), app: appVersion, expiresAt, wake: await wake?.() ?? null,
          actions: actions(), terminal: allowTerminal(),
          ...(advertisedEndpoints.length ? { endpoints: advertisedEndpoints } : {}),
        }, {
          'Set-Cookie': cookieName + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(BROWSER_SESSION_TTL_MS / 1000),
        });
      }
      if (path === '/mobile/v1/session' && req.method === 'GET') {
        const advertisedEndpoints = typeof endpoints === 'function' ? endpoints() : [];
        return json(res, 200, {
          desktop: desktop(), device: { id: device.id, name: device.name }, protocol: PROTOCOL,
          actions: actions(), terminal: allowTerminal(), upstream: upstream.available?.() ?? true, app: appVersion,
          ...(advertisedEndpoints.length ? { endpoints: advertisedEndpoints } : {}),
        });
      }
      if (path === '/mobile/v1/ping' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          ts: Date.now(),
          app: appVersion,
          wsAlive: hasLiveSocket(device.id),
        });
      }
      if (path === '/mobile/v1/sync' && req.method === 'GET') {
        // A same-origin shell may attach timing metadata to an ordinary, non-poking sync read.
        const source = req.headers['x-dsh-force-source'];
        if (journal && browserRequests.has(req) && ['wakeCheck', 'visibility', 'online', 'pageshow', 'resume', 'poke-wsAlive', 'bridge'].includes(source) && bridgeLimit.allow(device.id)) {
          const when = Number(req.headers['x-dsh-force-at']);
          const age = req.headers['x-dsh-mux-age'], ready = req.headers['x-dsh-mux-ready'];
          if (Number.isSafeInteger(when) && when > 0 && when <= 8.64e15) {
            journal.record({ type: 'forced-reconnect', source, device: deviceTag(device.id),
              socket: muxTag(req.headers['x-dsh-mux']), clientAt: new Date(when).toISOString(),
              muxAgeMs: /^\d{1,12}$/.test(age) ? Number(age) : null, readyState: /^[0-3]$/.test(ready) ? Number(ready) : null });
          }
        }
        const poke = url.searchParams.get('poke') === '1';
        if (poke) pokeSockets(device.id);
        let state = syncState(device.id);
        if (!poke && url.searchParams.get('since') === state.cursor) {
          if (syncWaiters.size >= 128 || [...syncWaiters.values()].filter(id => id === device.id).length >= 4)
            return json(res, 429, { error: 'too-many-sync-watches' });
          await new Promise(resolve => {
            const wake = () => { clearTimeout(timer); res.off('close', wake); syncWaiters.delete(wake); resolve(); };
            const timer = setTimeout(wake, 20_000);
            res.once('close', wake);
            syncWaiters.set(wake, device.id);
          });
          if (res.destroyed) return;
          if (!authorize(req)) return json(res, 401, { error: 'pairing-required' });
          state = syncState(device.id);
        }
        return json(res, 200, state);
      }
      if (Object.hasOwn(SHELL_ASSETS, path) && ['GET', 'HEAD'].includes(req.method)) {
        const asset = SHELL_ASSETS[path];
        const immutable = url.searchParams.get('v') === asset.version;
        const headers = {
          'content-type': asset.type,
          'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
          etag: asset.etag,
          vary: 'Accept-Encoding',
          'x-content-type-options': 'nosniff',
        };
        if (req.headers['if-none-match'] === asset.etag) {
          res.writeHead(304, headers);
          return res.end();
        }
        const acceptEncoding = req.headers['accept-encoding'] ?? '';
        const useBr = acceptsEncoding(acceptEncoding, 'br');
        const useGzip = !useBr && acceptsGzip(acceptEncoding);
        const body = useBr ? asset.br : useGzip ? asset.gzip : asset.body;
        if (useBr) headers['content-encoding'] = 'br';
        else if (useGzip) headers['content-encoding'] = 'gzip';
        headers['content-length'] = body.length;
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (path === '/mobile/v1/unpair' && req.method === 'POST') {
        await devices.remove(device.id);
        res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end();
      }
      if (path === '/api/session/uploadFileBinary' && req.method === 'POST') {
        if (!actions()) return json(res, 403, { error: 'actions-disabled' });
        if (typeof upstream.upload !== 'function') return json(res, 501, { error: 'upload-unavailable' });
        if (String(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return json(res, 415, { error: 'binary-required' });
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || sessionId.length > 128) return json(res, 400, { error: 'session-required' });
        const name = url.searchParams.get('name');
        const mediaType = url.searchParams.get('mediaType');
        const tooLarge = { error: 'file-too-large', maxBytes: MOBILE_FILE_LIMIT };
        if (Number(req.headers['content-length']) > MOBILE_FILE_LIMIT) return json(res, 413, tooLarge);

        // The upstream commits the attachment only after EOF. Do not yield EOF for
        // oversized, aborted or revoked uploads, even when no Content-Length was sent.
        let rejected;
        const checkAccess = () => {
          if (!authorize(req)) rejected = [401, { error: 'pairing-required' }];
          else if (!actions()) rejected = [403, { error: 'actions-disabled' }];
          if (rejected) throw new Error(rejected[1].error);
        };
        async function* readUpload() {
          let bytes = 0, lastCheck = Date.now();
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length;
            if (bytes > MOBILE_FILE_LIMIT) {
              rejected = [413, tooLarge];
              throw new Error(tooLarge.error);
            }
            if (Date.now() - lastCheck >= 1000) { checkAccess(); lastCheck = Date.now(); }
            yield chunk;
          }
          checkAccess();
        }
        let result;
        try {
          result = await upstream.upload({ sessionId, name, mediaType, body: readUpload() }, device.id);
        } catch (error) {
          if (!rejected) throw error;
        }
        if (rejected) return json(res, ...rejected);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(result.body);
      }
      // Forward GET/HEAD /api/* routes (chat images/media, deliverable files, document previews,
      // session log exports, plugin icons) through DSH's shared /api Fetch handler.
      if (path.startsWith('/api/') && browserRequests.has(req) && ['GET', 'HEAD'].includes(req.method) && typeof upstream.fetch === 'function') {
        const result = await upstream.fetch({ method: req.method, url: req.url, headers: req.headers }, device.id);
        const outHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...result.headers };
        const ct = String(outHeaders['content-type'] ?? '');
        // Allow short private caching of static images/icons so scrolling chat or plugin lists never re-downloads over 5G.
        if (result.status === 200 && !result.headers?.['cache-control'] && /^(?:image\/|font\/)/i.test(ct)) {
          outHeaders['cache-control'] = 'private, max-age=300';
        }
        let body = result.body;
        if (req.method === 'GET' && result.status === 200 && body.length >= 2048
            && /(?:json|svg|text\/|javascript|xml)/i.test(ct)
            && !outHeaders['content-encoding']
            && acceptsGzip(req.headers['accept-encoding'])) {
          const compressed = await gzipHistory(body, { level: 1 });
          if (compressed.length + 64 < body.length) {
            body = compressed;
            for (const k of Object.keys(outHeaders)) {
              const lower = k.toLowerCase();
              if (lower === 'content-length' || lower === 'vary') delete outHeaders[k];
            }
            outHeaders['content-encoding'] = 'gzip';
            outHeaders['content-length'] = String(body.length);
            outHeaders.vary = 'Accept-Encoding';
          }
        }
        res.writeHead(result.status, outHeaders);
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      // Forward non-JSON POST /api/* routes (streaming file uploads, chat imports) for writable official sessions.
      if (path.startsWith('/api/') && browserRequests.has(req) && req.method === 'POST'
          && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')
          && typeof upstream.fetch === 'function') {
        if (!actions()) return json(res, 403, { error: 'actions-disabled' });
        let body;
        try { body = await readBody(req, MAX_UPLOAD_BODY); }
        catch (error) { return json(res, error.status ?? 400, { error: 'invalid-body' }); }
        if (!authorize(req)) return json(res, 401, { error: 'pairing-required' });
        if (!actions()) return json(res, 403, { error: 'actions-disabled' });
        const result = await upstream.fetch({ method: 'POST', url: req.url, headers: req.headers, body }, device.id);
        res.writeHead(result.status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...result.headers });
        return res.end(result.body);
      }
      if (path.startsWith('/api/') && req.method === 'POST') {
        const method = path.slice(5);
        let envelope;
        const writable = actions();
        const official = browserRequests.has(req);
        const terminalMethod = TERMINAL_RPC.has(method) || (official && method.startsWith('terminal/'));
        if (terminalMethod && !allowTerminal()) return json(res, 403, { error: 'terminal-disabled' });
        const enabledPolicy = official && writable
          ? { rpc: allEndpoints }
          : official
            ? officialReadRpcPolicy
            : terminalMethod
              ? { rpc: TERMINAL_RPC }
              : writable && ACTION_RPC.has(method)
                ? { rpc: CONTROL_RPC }
                : policy;
        if (!enabledPolicy.rpc.has(method)) {
          return json(res, 403, { error: ACTION_RPC.has(method) || official ? 'actions-disabled' : 'method-forbidden' });
        }
        try { envelope = JSON.parse((await readBody(req, ['session/prompt', 'subagents/prompt'].includes(method) && writable ? 16 * 1024 * 1024 : MAX_BODY)).toString('utf8')); }
        catch (e) { return json(res, e.status ?? 400, { error: 'bad-envelope' }); }
        const verdict = checkEnvelope(envelope, method, enabledPolicy);
        if (verdict !== 'ok') return json(res, 400, { error: verdict });
        // Revocation and permission changes can happen while the body is read.
        if (!authorize(req)) return json(res, 401, { error: 'pairing-required' });
        if (official && !actions() && !isOfficialReadRpc(method)) return json(res, 403, { error: 'actions-disabled' });
        if (ACTION_RPC.has(method) && !actions()) return json(res, 403, { error: 'actions-disabled' });
        if (terminalMethod && !allowTerminal()) return json(res, 403, { error: 'terminal-disabled' });
        const args = envelope.payload.args;
        // The official Gateway validates event ids and the owning Peer, including
        // next/rejected events and third-party plugin interactions.
        const claim = method === '$events/result' && !official ? claimDelivery(device.id, args) : null;
        if (method === '$events/result' && !official && !claim) return json(res, 409, { error: 'interaction-unavailable' });
        try {
          const body = Buffer.from(JSON.stringify(envelope));
          let result = await upstream.rpc(method, body, device.id, { official });
          if (method === 'directoryPicker/list' || method === 'directoryPicker/createDirectory') result = await directoryPickerFallback(body, result);
          if (claim && result.status >= 200 && result.status < 300) {
            let accepted = false;
            try { accepted = JSON.parse(result.body).result?.ok === true; } catch {}
            if (accepted) claim.record.pending.delete(args.eventId);
          }
          const type = result.contentType ?? 'application/json; charset=utf-8';
          const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
          let payload = result.body;
          if (result.status === 200 && payload.length >= HISTORY_THRESHOLD
              && (COMPRESSIBLE_RPC.has(method) || /^application\/json\b/i.test(type))) {
            headers.Vary = 'Accept-Encoding';
            if (acceptsGzip(req.headers['accept-encoding'])) {
              const compressed = await gzipHistory(payload, { level: 1 });
              if (compressed.length + 64 < payload.length) {
                payload = compressed;
                headers['Content-Encoding'] = 'gzip';
              }
            }
          }
          headers['Content-Length'] = payload.length;
          res.writeHead(result.status, headers);
          return res.end(payload);
        } finally { if (claim) claim.event.busy = false; }
      }
      if (browserRequests.has(req) && officialWeb && ['GET', 'HEAD'].includes(req.method)) {
        const peer = upstream.peerFor?.(device.id);
        const result = await officialWeb.fetch(req, {
          peer,
          shellMeta: {
            version: appVersion,
            linkEvents: !!journal,
            desktopName: identity.name,
            readOnly: !actions(),
            terminal: allowTerminal(),
          },
        });
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      return json(res, 404, { error: 'not-found' });
    } catch (error) {
      log({ type: 'error', where: path, message: error?.message });
      if (!res.headersSent) json(res, 502, { error: 'upstream-unavailable' }); else res.end();
    }
  });

  server.on('connection', socket => {
    try { socket.setNoDelay(true); socket.setKeepAlive(true, 15_000); } catch {}
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: {
    serverNoContextTakeover: true, clientNoContextTakeover: true, threshold: HISTORY_THRESHOLD,
    zlibDeflateOptions: { level: 1 }, concurrencyLimit: 4,
  } });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://link.invalid');
    const device = url.pathname === '/api/remote.mux' ? authorize(req) : undefined;
    if (!device) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => attach(client, device, peerAddress(req), browserRequests.has(req), muxTag(url.searchParams.get('dmlTrace'))));
  });

  async function attach(client, device, address, official, tag) {
    const started = performance.now();
    const context = { socket: tag ?? randomBytes(8).toString('hex'), device: deviceTag(device.id) };
    const trace = {};
    socketTrace.set(client, trace);
    journal?.record({ type: 'connected', ...context });
    const set = sockets.get(device.id) ?? new Set(); set.add(client); sockets.set(device.id, set);
    log({ type: 'connected', device: { id: device.id, name: device.name }, address });
    const open = new Map(), queue = [];
    const delivery = { deviceId: device.id, streamId: null, clientId: null, pending: new Map() };
    deliveries.set(client, delivery);
    const clearDelivery = () => {
      delivery.streamId = null; delivery.clientId = null; delivery.pending.clear();
    };
    let remote, closed = false;
    const finish = (code = 1011, reason = 'Harness disconnected', source = 'link-server', observedCode = code, observedReason = reason) => {
      if (closed) return; closed = true;
      deliveries.delete(client);
      set.delete(client); if (!set.size && sockets.get(device.id) === set) sockets.delete(device.id);
      try { client.close(code, reason); } catch {}
      try { remote?.close(); } catch {}
      journal?.record({ type: 'disconnected', ...context, source: trace.source ?? source, code: observedCode,
        reason: observedReason, durationMs: Math.round(performance.now() - started) });
      log({ type: 'disconnected', device: { id: device.id, name: device.name } });
    };
    client.on('message', (bytes, isBinary) => {
      let msg;
      try { msg = JSON.parse(bytes.toString('utf8')); } catch { return finish(1008, 'bad-frame'); }
      if (isBinary) return finish(1008, 'text-required');
      const officialWritable = official && actions();
      // In official read-only mode, strip session/follow activate instead of tearing down the socket.
      if (official && !officialWritable && msg?.type === 'open' && msg.endpoint === 'session/follow' && msg.payload?.args?.request?.activate) {
        msg = {
          ...msg,
          payload: {
            ...msg.payload,
            args: {
              ...msg.payload.args,
              request: { ...msg.payload.args.request, activate: false },
            },
          },
        };
      }
      const streamPolicy = officialWritable
        ? { streams: allEndpoints }
        : official
          ? officialReadStreamPolicy
          : policy;
      const terminalAllowed = allowTerminal();
      // Terminal subscriptions are optional, even in a writable official session.
      // Refuse just that stream; closing the carrier would restart every subscriber.
      if (msg?.type === 'open' && typeof msg.endpoint === 'string' && msg.endpoint.startsWith('terminal/') && !terminalAllowed) {
        client.send(JSON.stringify({ type: 'error', streamId: msg.streamId, error: { code: 'terminal-disabled', message: '请在电脑上允许手机使用终端。' } }));
        return;
      }
      const verdict = checkClientFrame(msg, open, streamPolicy, terminalAllowed, officialWritable, official ? 64 : MAX_STREAMS);
      if (verdict === 'unknown-stream') return;
      if (verdict !== 'ok') {
        if (official && !officialWritable && msg?.type === 'open' && verdict === 'endpoint-forbidden') {
          client.send(JSON.stringify({ type: 'error', streamId: msg.streamId, error: { code: 'actions-disabled', message: '电脑端未开启「允许手机操作」，当前仅可实时查看。' } }));
          return;
        }
        return finish(1008, `frame-policy: ${verdict}`);
      }
      if (msg.type === 'open') {
        if (msg.endpoint === '$events') {
          if (delivery.streamId) return finish(1008, 'duplicate-event-stream');
          delivery.streamId = msg.streamId;
        }
        open.set(msg.streamId, msg.endpoint);
      } else if (msg.type === 'cancel') {
        open.delete(msg.streamId);
        if (delivery.streamId === msg.streamId) clearDelivery();
      }
      const text = JSON.stringify(msg);
      try {
        if (remote) remote.send(text); else if (queue.push(text) > 64) finish(1008, 'too-many-queued');
      } catch { finish(); }
    });
    // Keep sockets alive across short mobile background switches (up to 3 min idle)
    // without prematurely tearing them down on a single suspended radio window.
    let lastTraffic = Date.now();
    const seen = () => { lastTraffic = Date.now(); };
    client.on('pong', seen); client.on('message', seen);
    const beat = setInterval(() => { if (Date.now()-lastTraffic >= 180e3) { serverClose(client, 'heartbeat-terminate'); client.terminate(); return; } try { client.ping(); } catch {} }, 15e3);
    beat.unref?.();
    client.on('close', (code, reason) => {
      clearInterval(beat);
      // Peer-supplied close text can contain arbitrary page data. Only retain known constants.
      const text = reason.toString();
      const safeReason = !text ? 'empty' : ['unpaired', 'configuration changed', 'closed'].includes(text) ? text : 'peer-supplied';
      finish(1000, 'closed', code === 1006 ? 'transport-lost' : 'phone-close', code, safeReason);
    });
    client.on('error', () => finish(1011, 'Harness disconnected', 'phone-error'));
    try {
      remote = await upstream.mux(device.id);
    } catch (error) {
      log({ type: 'error', where: 'mux', message: error?.message });
      return finish(1013, 'Harness unavailable', 'upstream-open');
    }
    if (closed) { try { remote.close(); } catch {} return; }
    remote.on('message', (data, isBinary = false) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 16 * MAX_BODY) return finish(1013, 'phone too slow');
      let frame;
      try { frame = JSON.parse(data.toString()); } catch {}
      if (frame?.type === 'end' || frame?.type === 'error') open.delete(frame.streamId);
      if (delivery.streamId !== null && frame?.streamId === delivery.streamId) {
        if (frame.type !== 'item') clearDelivery();
        else {
          const value = frame.value;
          if (value?.type === 'ready') { delivery.clientId = value.clientId; delivery.pending.clear(); }
          else if (value?.type === 'cancel') delivery.pending.delete(value.eventId);
          else if (value?.type === 'waterfall') {
            const kind = value.event === 'approval/request' ? 'approval'
              : value.event === 'user-questions/request' ? 'question' : null;
            if (kind) delivery.pending.set(value.eventId, { kind, busy: false });
          }
        }
      }
      // Independent large history frames only; live deltas, terminal data and
      // interaction frames do not pay the deflate latency or share a dictionary.
      const compress = !isBinary && data.length >= HISTORY_THRESHOLD && frame?.type === 'item'
        && frame.value?.type === 'snapshot' && open.get(frame.streamId) === 'session/follow';
      client.send(data, { binary: isBinary, compress }, error => { if (error) finish(); });
    });
    remote.on('close', () => finish(1011, 'Harness disconnected', 'upstream-close'));
    try { for (const text of queue.splice(0)) remote.send(text); }
    catch { finish(); }
  }

  // Revoking a device closes its live sockets immediately.
  const unsubscribe = devices.onChange(event => {
    if (event.type !== 'removed') return;
    for (const [wake, id] of syncWaiters) if (id === event.id) wake();
    for (const ws of sockets.get(event.id) ?? []) {
      deliveries.delete(ws);
      serverClose(ws, 'unpair'); ws.close(4401, 'unpaired');
    }
    void Promise.resolve(upstream.revoke?.(event.id)).catch(() => {});
  });

  return {
    server,
    listen(port = 3081, host = '::') {
      return new Promise((resolve, reject) => {
        const onError = e => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError).once('listening', onListening).listen(port, host);
      });
    },
    connected() { return [...sockets.entries()].map(([id, set]) => ({ id, connections: set.size })); },
    disconnect() {
      wakeSync();
      for (const set of sockets.values()) for (const ws of set) {
        serverClose(ws, 'configuration'); ws.close(1012, 'configuration changed');
      }
    },
    async close() {
      unsubscribe();
      unsubscribeFocus?.();
      wakeSync();
      forgetBrowserDevice?.();
      await sessionWrites;
      browserSessions.clear();
      for (const set of sockets.values()) for (const ws of set) {
        serverClose(ws, 'shutdown-terminate'); ws.terminate();
      }
      const socketsClosed = new Promise(resolve => wss.close(resolve));
      const closed = new Promise(resolve => server.close(() => resolve()));
      server.closeAllConnections?.();
      await Promise.all([closed, socketsClosed]);
      await journal?.flush();
      await devices.flush?.();
    },
  };
}
