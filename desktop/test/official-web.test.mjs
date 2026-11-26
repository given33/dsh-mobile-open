import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { on, once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { readHarnessSurface, PREVIEW_COMPAT_JS, RECONNECT_POLICY } from '../lib/mobile-shell.mjs';
import { WebSocket } from 'ws';
import { createLinkService } from '../lib/link-service.mjs';
import { createOfficialWeb } from '../lib/official-web.mjs';
import { createMobileFocusTracker } from '../lib/mobile-focus.mjs';
import { mobileHostActions } from '../lib/mobile-host-actions.mjs';
import { injectMobileShell, MOBILE_ANCHOR_PREBOOT_JS, MOBILE_SHELL_CSS, MOBILE_SHELL_JS } from '../lib/mobile-shell.mjs';

async function fixture(t, { mode = 'legacy', actions = true, terminal = false, history, officeBody, rpcBody, extraFetch, streamValue, priorEvents } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-official-web-'));
  const distRoot = join(dir, 'dist');
  await mkdir(join(distRoot, 'assets'), { recursive: true });
  await writeFile(join(distRoot, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>');
  await writeFile(join(distRoot, 'assets', 'official-hash.js'), '/* official bundle */\n'.repeat(300));
  const seen = { calls: [], fetches: [], streams: [], peers: [] };
  const fakePeer = { principal: { kind: 'owner' } };

  const officialWeb = mode === 'readResource'
    ? createOfficialWeb({
        distRoot: undefined,
        webServer: {
          async readResource(request, peer) {
            seen.peers.push(peer);
            assert.ok(peer?.principal?.kind === 'owner', 'DSH 0.2.2+ readResource requires PeerScope');
            const pathname = new URL(request.url).pathname;
            if (pathname === '/' || pathname === '/index.html') {
              return new Response('<html><head><base href="./"><script>globalThis.__DSH_BOOT__={v:"0.2.2"}</script></head><body><div id="root"></div></body></html>', {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
              });
            }
            if (pathname === '/plugins/live/combo.js') {
              return new Response('/* 0.2.2 live plugin combo */\n'.repeat(100), {
                status: 200,
                headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' },
              });
            }
            return new Response(null, { status: 404 });
          },
        },
      })
    : createOfficialWeb({
        distRoot,
        webServer: {
          renderIndex(html, peer) {
            seen.peers.push(peer);
            return html.replace('<head>', '<head><script>globalThis.__DSH_BOOT__={official:true}</script>');
          },
        },
        clientModules: {
          async fetchBundle() {
            return new Response('/* official live graph module */', {
              headers: { 'content-type': 'text/javascript', 'cache-control': 'private, max-age=31536000, immutable' },
            });
          },
        },
      });

  const listeners = new Map();
  const focus = createMobileFocusTracker();
  const upstream = {
    peerFor: () => fakePeer,
    rpc: async (method, body, id) => {
      const parsed = JSON.parse(body);
      seen.calls.push({ method, body: parsed, id });
      if (method === 'session/page' && history) return { status: 200, body: history };
      if (method === 'mobileOffice/read' && officeBody) return { status: 200, body: officeBody };
      if (rpcBody && rpcBody[method]) return { status: 200, body: rpcBody[method] };
      if (method === 'session/attachmentBinary') {
        return {
          status: 200,
          contentType: 'multipart/form-data; boundary=dsh-boundary',
          body: Buffer.from('--dsh-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--dsh-boundary--'),
        };
      }
      if (method === 'session/create') {
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: { sessionId: 'mobile-draft-1' } } })),
        };
      }
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: {} } })),
      };
    },
    fetch: async ({ method, url, headers, body }, id) => {
      seen.fetches.push({ method, url, contentType: headers['content-type'], size: body?.length ?? 0, id });
      if (extraFetch) {
        const custom = await extraFetch({ method, url, headers, body }, id);
        if (custom) return custom;
      }
      if (url.startsWith('/api/media/')) {
        return { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
      }
      if (url.startsWith('/api/upload/stream')) {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: true, size: body.length })) };
      }
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not-found') };
    },
    mux: async id => ({
      on(name, fn) { listeners.set(name, fn); },
      close() {},
      send(text) {
        const frame = JSON.parse(text);
        seen.streams.push({ id, frame });
        if (frame.type === 'open') listeners.get('message')?.(JSON.stringify({ type: 'item', streamId: frame.streamId, value: streamValue ?? { ready: true } }));
      },
    }),
  };

  const stateDir = join(dir, 'state'), journalFile = join(stateDir, 'link-events.jsonl');
  if (priorEvents) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(journalFile, priorEvents);
  }
  const link = await createLinkService({
    stateDir,
    upstream,
    officialWeb,
    focus,
    host: '127.0.0.1',
    port: 0,
    enabled: true,
    actions, terminal,
  });
  t.after(async () => { await link.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const status = await link.status();
  const port = status.port, origin = 'https://127.0.0.1:' + port;
  async function request(path, { method = 'GET', token, cookie, body, rawBody, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = rawBody !== undefined ? rawBody : body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = https.request({
        host: '127.0.0.1', port, path, method, rejectUnauthorized: false, agent: false,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined && rawBody === undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      }, res => {
        const bytes = [];
        res.on('data', chunk => bytes.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bytes) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const paired = await request('/mobile/v1/pair', { method: 'POST', body: { code: new URL(status.pairing.link).searchParams.get('c'), device: { id: 'phone-official-123', name: 'test' } } });
  const token = JSON.parse(paired.body).token;
  return { link, request, token, origin, seen, officialWeb, focus, journalFile, closeUpstream: () => listeners.get('close')(), emitFrame: frame => listeners.get('message')(JSON.stringify(frame)) };
}

test('official browser session uses a separate host-only cookie, mobile shell assets, gzip cache, and revokes with the phone', async t => {
  const { request, token, link } = await fixture(t);
  assert.equal((await request('/')).status, 401);
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(started.status, 200);
  assert.equal(JSON.parse(started.body).desktop.id, link.identity.id);
  const setCookie = started.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-dsh-mobile=/);
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(setCookie.includes(flag));
  assert.ok(!setCookie.includes(token));
  const cookie = setCookie.split(';')[0];
  assert.equal((await request('/mobile/v1/task-notifications', { cookie })).status, 401, 'WebView cookies cannot manage native delivery credentials');
  assert.equal((await request('/mobile/v1/web-session', { method: 'POST', cookie })).status, 401);

  const page = await request('/', { cookie });
  assert.equal(page.status, 200);
  const html = page.body.toString();
  assert.match(html, /__DSH_BOOT__/);
  assert.match(html, /__DSH_MOBILE_SHELL__/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /\/mobile\/v1\/shell\.css/);
  assert.match(html, /\/mobile\/v1\/shell\.js/);
  assert.ok(!html.includes(token));

  const shellCss = await request('/mobile/v1/shell.css', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(shellCss.status, 200);
  assert.equal(shellCss.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(shellCss.body).toString(), /--dsh-mobile-vh/);
  assert.equal((await request('/mobile/v1/shell.css', { cookie, headers: { 'If-None-Match': shellCss.headers.etag } })).status, 304);

  const shellJs = await request('/mobile/v1/shell.js', { cookie });
  assert.equal(shellJs.status, 200);
  assert.match(shellJs.body.toString(), /__DSH_MOBILE_BRIDGE__/);

  const asset = await request('/assets/official-hash.js', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(asset.body).toString(), /official bundle/);
  assert.equal((await request('/assets/official-hash.js', { cookie, headers: { 'If-None-Match': asset.headers.etag } })).status, 304);
  assert.equal((await request('/plugins/a/hash.js', { cookie })).status, 200);
  assert.equal((await request('/assets/..%2f..%2fsecret', { cookie })).status, 403);
  assert.equal((await request('/api/plugin/action', { cookie, method: 'POST', body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 401);

  await link.removeDevice('phone-official-123');
  assert.equal((await request('/', { cookie })).status, 401);
  assert.equal((await request('/assets/official-hash.js', { cookie })).status, 401, 'cached assets still require authorization');
});

test('DSH 0.2.2+ readResource passes PeerScope and serves live plugin bundles with mobile shell injection', async t => {
  const { request, token, seen } = await fixture(t, { mode: 'readResource' });
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(started.status, 200);
  const cookie = started.headers['set-cookie'][0].split(';')[0];

  const page = await request('/', { cookie });
  assert.equal(page.status, 200);
  const html = page.body.toString();
  assert.match(html, /v:"0\.2\.2"/);
  assert.match(html, /<base href="\/">/);
  assert.ok(!html.includes('<base href="./">'));
  assert.match(html, /__DSH_MOBILE_SHELL__/);
  assert.ok(seen.peers.length >= 1);

  const combo = await request('/plugins/live/combo.js', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(combo.status, 200);
  assert.equal(combo.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(combo.body).toString(), /0\.2\.2 live plugin combo/);
});

test('official API supports plugin RPC, multipart binary RPC, GET/POST /api Fetch routes, focus sync, and read-only watch mode', async t => {
  const { request, token, origin, link, seen, focus } = await fixture(t);
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  const cookie = started.headers['set-cookie'][0].split(';')[0];

  // Writable official mode: plugin RPC, workspace session creation, multipart RPC, GET media, streaming POST upload.
  const method = 'someOfficialPlugin/change';
  const body = { type: 'client-request', rpcId: 'official-1', method, payload: { args: { enabled: true } } };
  assert.equal((await request('/api/' + method, { method: 'POST', token, body })).status, 403, 'native unknown RPC remains closed');
  assert.equal((await request('/api/' + method, { method: 'POST', cookie, body, headers: { Origin: origin } })).status, 200);
  assert.equal(seen.calls[0].id, 'phone-official-123');
  assert.deepEqual(seen.calls[0].body, body);

  const created = await request('/api/session/create', {
    method: 'POST', cookie, headers: { Origin: origin },
    body: { type: 'client-request', rpcId: 'c1', method: 'session/create', payload: { args: {} } },
  });
  assert.equal(created.status, 200);

  const binaryRpc = await request('/api/session/attachmentBinary', {
    method: 'POST', cookie, headers: { Origin: origin },
    body: { type: 'client-request', rpcId: 'b1', method: 'session/attachmentBinary', payload: { args: {} } },
  });
  assert.equal(binaryRpc.status, 200);
  assert.match(binaryRpc.headers['content-type'], /^multipart\/form-data; boundary=dsh-boundary/);

  const media = await request('/api/media/demo.png', { cookie });
  assert.equal(media.status, 200);
  assert.equal(media.headers['content-type'], 'image/png');
  assert.deepEqual(media.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const uploaded = await request('/api/upload/stream?name=doc.pdf', {
    method: 'POST', cookie, rawBody: Buffer.from('hello-stream'),
    headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(uploaded.status, 200);
  assert.equal(JSON.parse(uploaded.body).size, 12);

  focus.update({ sessionId: 'sess-desktop-42', title: '前端工作流调试' });
  const sync = await request('/mobile/v1/sync', { cookie });
  assert.equal(sync.status, 200);
  const syncJson = JSON.parse(sync.body);
  assert.equal(syncJson.actions, true);
  assert.equal(syncJson.desktopFocus.sessionId, 'sess-desktop-42');
  assert.equal(syncJson.desktopFocus.title, '前端工作流调试');

  assert.equal((await request('/api/terminal/create', { method: 'POST', cookie, body: { ...body, method: 'terminal/create' } })).status, 403);
  const ws = new WebSocket(origin.replace('https:', 'wss:') + '/api/remote.mux', { rejectUnauthorized: false, headers: { Cookie: cookie, Origin: origin } });
  await once(ws, 'open');
  const received = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'open', streamId: 'official-follow', endpoint: 'session/follow', payload: { args: { request: { sessionId: 's1', activate: true } } } }));
  await received;
  assert.equal(seen.streams[0].frame.payload.args.request.activate, true);
  ws.close(); await once(ws, 'close');

  // Switch to read-only watch mode: official UI stays open for live viewing, reads pass, writes refuse.
  await link.setActions(false);
  const roWebSession = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(roWebSession.status, 200);
  assert.equal(JSON.parse(roWebSession.body).actions, false);

  assert.equal((await request('/api/' + method, { method: 'POST', cookie, body })).status, 403);
  assert.equal((await request('/api/upload/stream', { method: 'POST', cookie, rawBody: Buffer.from('x'), headers: { Origin: origin, 'Content-Type': 'application/octet-stream' } })).status, 403);
  assert.equal((await request('/api/media/demo.png', { cookie })).status, 200, 'read-only media viewing stays allowed');
  assert.equal((await request('/api/workflow/getRun', {
    method: 'POST', cookie, headers: { Origin: origin },
    body: { type: 'client-request', rpcId: 'wf1', method: 'workflow/getRun', payload: { args: {} } },
  })).status, 200, 'read-only workflow inspection stays allowed');

  const roWs = new WebSocket(origin.replace('https:', 'wss:') + '/api/remote.mux', { rejectUnauthorized: false, headers: { Cookie: cookie, Origin: origin } });
  await once(roWs, 'open');
  const roReceived = once(roWs, 'message');
  roWs.send(JSON.stringify({ type: 'open', streamId: 'ro-follow', endpoint: 'session/follow', payload: { args: { request: { sessionId: 's1', activate: true } } } }));
  await roReceived;
  assert.equal(seen.streams.at(-1).frame.payload.args.request.activate, false, 'read-only strips activate instead of closing socket');
  roWs.close(); await once(roWs, 'close');
});

test('mobile shell injects synchronous pre-boot anchor interceptor before Vite module scripts and ships bottom-docked hero, desktop-order context meter, and 120Hz CSS rules', () => {
  const rawHtml = '<!doctype html><html><head><meta charset="utf-8"><script type="module" crossorigin src="/assets/index-Ciz7DZxv.js"></script><link rel="stylesheet" href="/assets/index-CSAdOBx6.css"></head><body><div id="root"></div></body></html>';
  const injected = injectMobileShell(rawHtml, { version: '0.4.1', desktopName: 'DEMO-DESKTOP' });

  const prebootIdx = injected.indexOf('__DSH_MOBILE_ANCHORS__');
  const moduleIdx = injected.indexOf('<script type="module"');
  const cssIdx = injected.indexOf('<link rel="stylesheet" href="/mobile/v1/shell.css');
  assert.ok(prebootIdx > 0 && prebootIdx < moduleIdx, 'pre-boot anchor script must execute before <script type="module">');
  assert.ok(cssIdx > moduleIdx, 'shell.css must be placed at the end of <head> after official stylesheets');

  // Verify CSS fixes for centered new-session hero, official desktop centered single-row stats dock, slash overlay height, and 120Hz no-blur tokens.
  assert.match(MOBILE_SHELL_CSS, /\[data-content-phase="hero"\] \[data-conversation-scroll\][\s\S]*justify-content:\s*center\s*!important/);
  assert.match(MOBILE_SHELL_CSS, /--dml-kb-hero/);
  assert.doesNotMatch(MOBILE_SHELL_CSS, /\[data-composer-(?:card|dock)\]\s*\{[^}]*order:/);
  assert.match(MOBILE_SHELL_CSS, /#root \[data-composer-dock\]\s*\{[\s\S]*justify-content:\s*center;[\s\S]*flex-wrap:\s*nowrap;[\s\S]*margin-top:\s*7px;[\s\S]*column-gap:\s*12px;/);
  assert.doesNotMatch(MOBILE_SHELL_CSS, /\[data-composer-dock\][\s\S]*margin-inline-start:\s*auto/);
  assert.ok(MOBILE_SHELL_CSS.includes('env(safe-area-inset-bottom'));
  assert.ok(!injected.includes("content:'DSH'"), 'preboot routing mask must not flash literal DSH text on a blank white page');
  assert.match(MOBILE_SHELL_CSS, /\[data-trigger-menu\][\s\S]*--dsh-overlay-avail-h/);
  assert.match(MOBILE_SHELL_CSS, /--dsw-menu-backdrop-filter:\s*none\s*!important/);
  assert.match(MOBILE_SHELL_CSS, /--dsw-mask-blur:\s*none\s*!important/);
  assert.ok(!/body:not\(\[data-dsh-keyboard-open\]\)\s*#root\s*\{[^}]*safe-area-inset-bottom/.test(MOBILE_SHELL_CSS), 'bottom safe-area black bar padding on #root must be removed');

  // Verify JS engine includes all DSH popup anchor families.
  for (const family of [
    '--dsh-model-',
    '--dsh-menu-',
    '--dsh-context-',
    '--dsh-stat-',
    '--dsh-approval-warning-',
    '--dsh-jobs-',
    '--dsh-font-notice-',
    '--dsh-task-menu-',
    '--dsh-submenu-parent',
    '--dsh-overlay-avail-h',
  ]) {
    assert.ok(MOBILE_SHELL_JS.includes(family), `MOBILE_SHELL_JS must handle ${family}`);
  }
});

test('anchor pre-boot interceptor and popup positioning engine accurately position ModelSelect, Permission menu, Session menu, ContextMeter, and Submenu on iOS viewport', async () => {
  const vm = await import('node:vm');

  class FakeStyle {
    constructor() { this._props = new Map(); }
    setProperty(k, v) { this._props.set(k, String(v)); }
    getPropertyValue(k) { return this._props.get(k) || ''; }
    removeProperty(k) { this._props.delete(k); }
  }
  class FakeElement {
    constructor(tag = 'div', rect = { left: 0, top: 0, right: 40, bottom: 30, width: 40, height: 30 }) {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.classList = { contains: () => false };
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.isConnected = true;
      this._attrs = new Map();
      this._style = new FakeStyle();
      this._rect = rect;
      this.offsetWidth = rect.width;
      this.offsetHeight = rect.height;
    }
    get style() { return this._style; }
    setAttribute(k, v) { this._attrs.set(k, String(v)); }
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
    hasAttribute(k) { return this._attrs.has(k); }
    removeAttribute(k) { this._attrs.delete(k); }
    contains(other) {
      let cur = other;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = true;
      this.children.push(child);
      return child;
    }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return this._rect; }
    addEventListener() {}
  }
  class FakeHTMLElement extends FakeElement {}
  class FakeSVGElement extends FakeElement {}

  const root = new FakeHTMLElement('div');
  root.id = 'root';
  const body = new FakeHTMLElement('body');
  body.appendChild(root);
  const docEl = new FakeHTMLElement('html');
  const overlay = new FakeHTMLElement('div');
  const composerCard = new FakeHTMLElement('div', { left: 10, top: 650, right: 383, bottom: 760, width: 373, height: 110 });
  composerCard.setAttribute('data-composer-card', '');
  root.appendChild(composerCard);

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }

  const frames = [], listeners = new Map(); let showOverlay = true, composerReads = 0, rootWrites = 0;
  const flush = () => { while (frames.length) frames.shift()(); };
  const rect = composerCard.getBoundingClientRect.bind(composerCard);
  composerCard.getBoundingClientRect = () => { composerReads++; return rect(); };
  const write = root.style.setProperty.bind(root.style);
  root.style.setProperty = (k,v) => { if (k === 'height') rootWrites++; write(k,v); };
  const ctx = vm.createContext({
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    SVGElement: FakeSVGElement,
    CSSStyleDeclaration: FakeStyle,
    CSS: { escape: s => s },
    MutationObserver: FakeMutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    AbortController, WeakMap, Map, Set, Math, Number, String, Object, RegExp,
    parseFloat, queueMicrotask, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1,
    requestAnimationFrame: fn => frames.push(fn),
    getComputedStyle: () => ({
      position: 'fixed',
      backgroundColor: 'rgb(18, 19, 22)',
      getPropertyValue: () => '',
    }),
    visualViewport: { width: 393, height: 780, offsetTop: 0, addEventListener(k,fn) { listeners.set(k,fn); } },
    innerWidth: 393,
    innerHeight: 780,
    scrollTo() { assert.fail("keyboard must not fight native viewport scrolling"); },
    addEventListener() {},
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      title: 'DeepSeek Harness',
      documentElement: docEl,
      body,
      getElementById: id => (id === 'root' ? root : null),
      querySelector: sel => (sel === '[data-composer-card]' ? composerCard : sel === '[data-trigger-menu]' ? (showOverlay ? overlay : null) : null),
      addEventListener() {},
    },
  });
  ctx.globalThis = ctx;

  vm.runInContext(MOBILE_ANCHOR_PREBOOT_JS, ctx);
  vm.runInContext(MOBILE_SHELL_JS, ctx);

  flush();
  // 1. Slash command overlay available height should be calculated from composerCard.top (650 - 8 = 642 -> capped at 480px).
  assert.equal(overlay.style.getPropertyValue('--dsh-overlay-avail-h'), '480px');

  // An iOS keyboard animation may generate several viewport events per frame.
  showOverlay = false; const before = composerReads;
  ctx.visualViewport.height = 746; listeners.get('resize')(); flush();
  assert.equal(root.style.getPropertyValue('height'),'','reading history must not shorten the app');
  ctx.document.activeElement = {matches:()=>true};
  ctx.visualViewport.height = 440;
  for (let i=0;i<40;i++) listeners.get('resize')();
  assert.equal(frames.length,1); flush();
  assert.equal(root.style.getPropertyValue('height'),'440px');
  assert.equal(body.getAttribute('data-dsh-keyboard-open'),'true');
  for (let i=0;i<12;i++) listeners.get('resize')(); flush();
  assert.equal(rootWrites,1); assert.equal(composerReads,before);
  ctx.visualViewport.offsetTop=18; listeners.get('scroll')();flush();
  assert.equal(root.style.getPropertyValue('height'),'458px');
  ctx.visualViewport.offsetTop=0;
  // When SwiftUI resizes the actual WebView, remove the height override.
  ctx.innerHeight = 440; listeners.get('resize')(); flush();
  assert.equal(root.style.getPropertyValue('height'),'');
  ctx.innerHeight = ctx.visualViewport.height = 780; listeners.get('resize')(); flush();
  assert.equal(body.hasAttribute('data-dsh-keyboard-open'),false);
  ctx.document.activeElement=null; ctx.visualViewport.height=746;listeners.get('resize')();flush();
  assert.equal(root.style.getPropertyValue('height'),'');
  ctx.visualViewport.height=780;
  assert.equal(composerReads,before);

  const panel = new FakeHTMLElement('aside', {width:200, height:250});
  panel.id = 'dsh-session-panel-chat'; panel.setAttribute('data-session-panel', 'overlay');
  panel.matches = () => panel.getAttribute('data-session-panel') === 'overlay';
  const button = new FakeHTMLElement('button', {left:188, right:212, bottom:40, width:24, height:24});
  button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded','true');
  const decoy = new FakeHTMLElement('button'); decoy.setAttribute('aria-expanded','true');
  ctx.document.querySelectorAll = sel => sel === 'button[data-session-panel-toggle]' ? [decoy,button] : panel.matches() ? [panel] : [];
  const bridge = ctx.__DSH_MOBILE_BRIDGE__;
  bridge.repositionPopups();
  assert.equal(panel.style.getPropertyValue('--dml-panel-top'), '46px');
  assert.equal(panel.style.getPropertyValue('--dml-panel-left'), '100px');
  assert.equal(panel.style.getPropertyValue('--dml-panel-origin'), '100px');
  Object.assign(button._rect, {left:446,right:470}); bridge.setKeyboard(300,0); flush();
  assert.equal(panel.style.getPropertyValue('--dml-panel-height'), '424px');
  assert.equal(panel.style.getPropertyValue('--dml-panel-left'), '183px');
  Object.assign(button._rect, {left:4,right:28}); bridge.repositionPopups();
  assert.equal(panel.style.getPropertyValue('--dml-panel-left'), '10px');
  panel.setAttribute('data-session-panel','docked'); bridge.repositionPopups();
  assert.equal(panel.hasAttribute('data-dml-anchored'), false);
  assert.equal(panel.style.getPropertyValue('--dml-panel-top'), '');
  bridge.setKeyboard(0,0); flush();

  // 2. Session '...' menu in sidebar (at x=240..268, y=410..438) -> placed right below trigger at y=442, not bottom-left!
  const sessionTrigger = new FakeHTMLElement('span', { left: 240, top: 410, right: 268, bottom: 438, width: 28, height: 28 });
  root.appendChild(sessionTrigger);
  sessionTrigger.style.anchorName = '--dsh-menu-session1';

  const sessionMenu = new FakeHTMLElement('div', { left: 0, top: 0, right: 180, bottom: 200, width: 180, height: 200 });
  sessionMenu.setAttribute('data-anchor-side', 'bottom');
  sessionMenu.setAttribute('data-anchor-align', 'start');
  body.appendChild(sessionMenu);
  sessionMenu.style.positionAnchor = '--dsh-menu-session1';

  assert.equal(sessionMenu.style.getPropertyValue('top'), '442px');
  assert.equal(sessionMenu.style.getPropertyValue('left'), '203px'); // clamped to 393 - 10 - 180 = 203
  assert.equal(sessionMenu.style.getPropertyValue('bottom'), 'auto');
  assert.equal(sessionMenu.style.getPropertyValue('right'), 'auto');

  // 3. ModelSelect popup (trigger at bottom-right of composer: x=270..335, y=720..748) -> placed ABOVE trigger, right-aligned!
  const modelTrigger = new FakeHTMLElement('button', { left: 270, top: 720, right: 335, bottom: 748, width: 65, height: 28 });
  root.appendChild(modelTrigger);
  modelTrigger.style.setProperty('--dsh-model-anchor', '--dsh-model-m1');

  const modelMenu = new FakeHTMLElement('div', { left: 0, top: 0, right: 260, bottom: 240, width: 260, height: 240 });
  body.appendChild(modelMenu);
  modelMenu.style.setProperty('--dsh-model-anchor', '--dsh-model-m1');

  assert.equal(modelMenu.style.getPropertyValue('top'), '472px'); // 720 - 8 - 240 = 472
  assert.equal(modelMenu.style.getPropertyValue('left'), '75px'); // 335 - 260 = 75

  // 4. PermissionSelect popup (data-anchor-side="top", trigger at x=48..128, y=720..748) -> placed ABOVE trigger, left-aligned!
  const permTrigger = new FakeHTMLElement('span', { left: 48, top: 720, right: 128, bottom: 748, width: 80, height: 28 });
  root.appendChild(permTrigger);
  permTrigger.style.anchorName = '--dsh-menu-perm1';

  const permMenu = new FakeHTMLElement('div', { left: 0, top: 0, right: 210, bottom: 150, width: 210, height: 150 });
  permMenu.setAttribute('data-anchor-side', 'top');
  permMenu.setAttribute('data-anchor-align', 'start');
  body.appendChild(permMenu);
  permMenu.style.positionAnchor = '--dsh-menu-perm1';

  assert.equal(permMenu.style.getPropertyValue('top'), '566px'); // 720 - 4 - 150 = 566
  assert.equal(permMenu.style.getPropertyValue('left'), '48px');

  // 5. ContextMeter popup (--dsh-context-*, trigger above composer at x=310..375, y=624..644) -> placed ABOVE trigger, clamped to viewport!
  const ctxTrigger = new FakeHTMLElement('span', { left: 310, top: 624, right: 375, bottom: 644, width: 65, height: 20 });
  root.appendChild(ctxTrigger);
  ctxTrigger.style.anchorName = '--dsh-context-c1';

  const ctxPanel = new FakeHTMLElement('div', { left: 0, top: 0, right: 264, bottom: 180, width: 264, height: 180 });
  body.appendChild(ctxPanel);
  ctxPanel.style.positionAnchor = '--dsh-context-c1';

  assert.equal(ctxPanel.style.getPropertyValue('top'), '436px'); // 624 - 8 - 180 = 436
  assert.equal(ctxPanel.style.getPropertyValue('left'), '119px'); // clamped 393 - 10 - 264 = 119
});


test('history negotiates lossless gzip; never caches private pages', async t => {
  const fixtureData = JSON.parse(await readFile(new URL('./fixtures/synthetic-history.json',import.meta.url)));
  const snapshot = Object.entries(fixtureData.streams).find(([key]) => key.startsWith('session/follow:'))[1][0].value;
  const history = Buffer.from(JSON.stringify({result:{ok:true,value:snapshot}}));
  const {request,token}=await fixture(t,{history});
  const body={type:'client-request',rpcId:'h',method:'session/page',payload:{args:{}}};
  const run=encoding=>request('/api/session/page',{token,method:'POST',body,headers:{'accept-encoding':encoding}});
  const identity=await run('gzip;q=0'), compressed=await run('br, gzip;q=0.5');
  assert.equal(identity.headers['content-encoding'],undefined); assert.deepEqual(identity.body,history);
  assert.equal(compressed.headers['cache-control'],'no-store'); assert.equal(compressed.headers['content-encoding'],'gzip');
  assert.deepEqual(gunzipSync(compressed.body),identity.body); assert.ok(compressed.body.length < identity.body.length/2);
  t.diagnostic(`synthetic history in test page: ${identity.body.length} -> ${compressed.body.length} bytes`);
});

test('a sync watch wakes on focus, capability changes and pairing removal', {timeout:4000}, async t=>{
  const {request,token,focus,link}=await fixture(t);
  const watch=async cursor=>{const r=await request('/mobile/v1/sync'+(cursor?'?since='+encodeURIComponent(cursor):''),{token});return [r.status,JSON.parse(r.body)]};
  const [,start]=await watch(); const pending=watch(start.cursor);
  await new Promise(r=>setTimeout(r,20));focus.update({sessionId:'picked',title:'New plan'});
  const [,next]=await pending;assert.equal(next.desktopFocus.sessionId,'picked');assert.notEqual(next.cursor,start.cursor);
  const permission=watch(next.cursor);await link.setActions(false);const [,ro]=await permission;assert.equal(ro.actions,false);
  const last=watch(ro.cursor);await link.removeDevice('phone-official-123');assert.equal((await last)[0],401);
});

test('preview polyfills preserve existing entries, including undefined, on old WebKit',()=>{
  const ctx=vm.createContext({});vm.runInContext('delete Map.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsertComputed; delete Promise.withResolvers;',ctx);
  vm.runInContext(PREVIEW_COMPAT_JS,ctx);
  assert.equal(vm.runInContext(`const m=new Map([['x',undefined]]); let calls=0;
    m.getOrInsertComputed('x',()=>++calls); m.getOrInsertComputed('y',()=>++calls);
    const w=new WeakMap(), k={}; w.getOrInsertComputed(k,()=>7)===7 && calls===1 && m.get('x')===undefined && typeof Promise.withResolvers().resolve==='function'`,ctx),true);
});

test('large follow snapshot is compressed on the wire only when negotiated', async t => {
  const streamValue = {type:'snapshot', transcript: 'record-snapshot '.repeat(4000)};
  const {request, token, origin} = await fixture(t, {streamValue});
  const started = await request('/mobile/v1/web-session', {method:'POST',token});
  const cookie = started.headers['set-cookie'][0].split(';')[0];
  const sizes = [];
  for (const negotiate of [false,true]) {
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/api/remote.mux', {perMessageDeflate:negotiate,rejectUnauthorized:false,headers:{Cookie:cookie,Origin:origin}});
    try {
      await once(ws,'open'); const start = ws._socket.bytesRead;
      const result = once(ws,'message'); ws.send(JSON.stringify({type:'open',streamId:'s',endpoint:'session/follow',payload:{args:{request:{sessionId:'demo'}}}}));
      const [frame] = await result; assert.deepEqual(JSON.parse(frame).value,streamValue); sizes.push(ws._socket.bytesRead - start);
    } finally { ws.close(); await once(ws,'close'); }
  }
  assert.ok(sizes[1] < sizes[0] / 2, `wire bytes: ${sizes}`);
});

test('native setKeyboard drives GPU keyboard CSS variables without #root height reflow and keeps popups above keyboard', async () => {
  const vm = await import('node:vm');
  class FakeStyle {
    constructor() { this._props = new Map(); }
    setProperty(k, v) { this._props.set(k, String(v)); }
    getPropertyValue(k) { return this._props.get(k) || ''; }
    removeProperty(k) { this._props.delete(k); }
  }
  class FakeElement {
    constructor(tag = 'div', rect = { left: 0, top: 0, right: 393, bottom: 780, width: 393, height: 780 }) {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.classList = { contains: () => false };
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.isConnected = true;
      this._attrs = new Map();
      this._style = new FakeStyle();
      this._rect = rect;
      this.scrollTop = 0;
      this.scrollHeight = 1400;
      this.clientHeight = 780;
    }
    get style() { return this._style; }
    setAttribute(k, v) { this._attrs.set(k, String(v)); }
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
    hasAttribute(k) { return this._attrs.has(k); }
    removeAttribute(k) { this._attrs.delete(k); }
    contains(other) { let c = other; while (c) { if (c === this) return true; c = c.parentElement; } return false; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return this._rect; }
    addEventListener() {}
  }
  class FakeHTMLElement extends FakeElement {}
  const root = new FakeHTMLElement('div'); root.id = 'root';
  const body = new FakeHTMLElement('body'); body.appendChild(root);
  const docEl = new FakeHTMLElement('html');
  const activeScroll = new FakeHTMLElement('div');
  activeScroll.scrollHeight = 1600; activeScroll.clientHeight = 780; activeScroll.scrollTop = 820;
  let rootHeightWrites = 0;
  const origSet = root.style.setProperty.bind(root.style);
  root.style.setProperty = (k, v) => { if (k === 'height') rootHeightWrites++; origSet(k, v); };
  const listeners = new Map(), timers = [];
  const ctx = vm.createContext({
    Element: FakeElement, HTMLElement: FakeHTMLElement, SVGElement: FakeElement, CSSStyleDeclaration: FakeStyle,
    CSS: { escape: s => s },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} },
    AbortController, WeakMap, Map, Set, Math, Number, String, Object, RegExp, parseFloat, queueMicrotask,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}, setInterval: () => 1,
    requestAnimationFrame: fn => { fn(1000); return 1; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ position: 'fixed', backgroundColor: 'rgb(21, 21, 23)', getPropertyValue: () => '' }),
    visualViewport: { width: 393, height: 780, offsetTop: 0, addEventListener(k, fn) { listeners.set(k, fn); } },
    innerWidth: 393, innerHeight: 780,
    addEventListener() {},
    document: {
      readyState: 'complete', visibilityState: 'visible', title: 'DSH',
      documentElement: docEl, body, activeElement: null,
      getElementById: id => (id === 'root' ? root : null),
      querySelector: sel => (sel === '[data-content-phase="active"] [data-conversation-scroll]' ? activeScroll : null),
      addEventListener() {},
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(MOBILE_ANCHOR_PREBOOT_JS, ctx);
  vm.runInContext(MOBILE_SHELL_JS, ctx);

  // Open native keyboard (336pt, 250ms) -> zero #root height mutation, GPU CSS vars set, chat scrolled up cleanly.
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(336, 250);
  assert.equal(docEl.getAttribute('data-dml-native-kb'), 'true');
  assert.equal(docEl.style.getPropertyValue('--dml-kb'), '336px');
  assert.equal(docEl.style.getPropertyValue('--dml-kb-dur'), '250ms');
  assert.equal(docEl.style.getPropertyValue('--dml-kb-pad'), '336px');
  assert.equal(body.getAttribute('data-dsh-keyboard-open'), 'true');
  assert.equal(activeScroll.scrollTop, 1156);
  assert.equal(rootHeightWrites, 0);

  // Subsequent visualViewport jitter must NOT fight native keyboard mode or mutate #root height.
  ctx.visualViewport.height = 444;
  ctx.document.activeElement = { matches: () => true };
  listeners.get('resize')();
  assert.equal(rootHeightWrites, 0);

  // Close native keyboard -> glides scrollTop back and clears padding only after completion.
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(0, 250);
  assert.equal(docEl.style.getPropertyValue('--dml-kb'), '0px');
  assert.equal(body.hasAttribute('data-dsh-keyboard-open'), false);
  assert.equal(activeScroll.scrollTop, 820);
  assert.equal(docEl.style.getPropertyValue('--dml-kb-pad'), '0px');
  // Reading history must not be shifted by a full keyboard height on dismissal.
  activeScroll.scrollTop = 210;
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(336, 250);
  assert.equal(activeScroll.scrollTop, 210);
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(0, 250);
  assert.equal(activeScroll.scrollTop, 210);
  assert.equal(docEl.style.getPropertyValue('--dml-kb-pad'), '0px');
  // The user can take control after our initial bottom-follow adjustment.
  activeScroll.scrollTop = 820;
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(336, 250);
  activeScroll.scrollTop = 350;
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(0, 250);
  assert.equal(activeScroll.scrollTop, 350);
  // Keyboard height changes undo only the remaining owned adjustment.
  activeScroll.scrollTop = 820;
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(336, 250);
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(200, 250);
  assert.equal(activeScroll.scrollTop, 1020);
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(0, 250);
  assert.equal(activeScroll.scrollTop, 820);
  ctx.matchMedia = () => ({matches:true});
  ctx.__DSH_MOBILE_BRIDGE__.setKeyboard(336, 250);
  assert.equal(docEl.style.getPropertyValue('--dml-kb-dur'), '0ms');
  assert.match(MOBILE_SHELL_CSS, /html\[data-dml-native-kb="true"\] \[data-composer-seat\][\s\S]*translate3d/);
});

test('mobileOffice/read negotiates gzip compression and stays permitted in read-only watch mode', async t => {
  const bigOffice = Buffer.from(JSON.stringify({
    type: 'server-response', rpcId: 'mo-ro',
    result: { ok: true, value: { format: 'docx', version: 'v1', blocks: Array.from({ length: 120 }, (_, i) => ({ type: 'p', text: `机械原理第 ${i} 段公式推导内容 α + β = π` })) } },
  }));
  const { request, token, origin } = await fixture(t, { actions: false, officeBody: bigOffice });
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  const cookie = started.headers['set-cookie'][0].split(';')[0];
  const roRes = await request('/api/mobileOffice/read', {
    method: 'POST', cookie, headers: { Origin: origin, 'Accept-Encoding': 'gzip' },
    body: { type: 'client-request', rpcId: 'mo-ro', method: 'mobileOffice/read', payload: { args: { sessionId: 's1', path: 'doc.docx' } } },
  });
  assert.equal(roRes.status, 200, 'mobileOffice/read must be allowed in read-only mode');
  assert.equal(roRes.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(roRes.body), bigOffice);
  assert.ok(roRes.body.length < bigOffice.length / 3);
});

test('versioned shell assets & official bundles negotiate Brotli immutable caching, sync poke reports wsAlive, and browser cookies survive server restart', async t => {
  const { request, token, origin, link } = await fixture(t);
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(started.status, 200);
  const setCookie = started.headers['set-cookie'][0];
  assert.match(setCookie, /Max-Age=604800/, 'browser cookie TTL should be 7 days for instant cold relaunch');
  const cookie = setCookie.split(';')[0];
  assert.equal((await request('/mobile/v1/task-notifications', { cookie })).status, 401, 'WebView cookies cannot manage native delivery credentials');

  // 1. HTML injects content-hashed shell URLs; versioned requests get immutable + Brotli!
  const page = await request('/', { cookie, headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(page.status, 200);
  const html = (page.headers['content-encoding'] === 'br' ? brotliDecompressSync(page.body) : page.body).toString('utf8');
  const cssMatch = html.match(/\/mobile\/v1\/shell\.css\?v=[A-Za-z0-9_-]+/);
  const jsMatch = html.match(/\/mobile\/v1\/shell\.js\?v=[A-Za-z0-9_-]+/);
  assert.ok(cssMatch && jsMatch, 'HTML must reference content-hashed shell assets');

  const cssBr = await request(cssMatch[0], { cookie, headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(cssBr.status, 200);
  assert.equal(cssBr.headers['content-encoding'], 'br');
  assert.match(cssBr.headers['cache-control'], /immutable/);
  assert.match(brotliDecompressSync(cssBr.body).toString('utf8'), /--dml-kb/);

  const assetBr = await request('/assets/official-hash.js', { cookie, headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(assetBr.status, 200);
  assert.equal(assetBr.headers['content-encoding'], 'br');
  assert.match(assetBr.headers['cache-control'], /immutable/);
  assert.match(brotliDecompressSync(assetBr.body).toString('utf8'), /official bundle/);

  // 2. /mobile/v1/sync?poke=1 returns immediately (no 20s wait) with accurate wsAlive boolean.
  const noWs = await request('/mobile/v1/sync?poke=1', { cookie });
  assert.equal(noWs.status, 200);
  const noWsJson = JSON.parse(noWs.body);
  assert.equal(noWsJson.wsAlive, false);

  const ws = new WebSocket(origin.replace('https:', 'wss:') + '/api/remote.mux', {
    rejectUnauthorized: false, headers: { Cookie: cookie, Origin: origin },
  });
  await once(ws, 'open');
  const withWs = await request('/mobile/v1/sync?since=' + encodeURIComponent(noWsJson.cursor) + '&poke=1', { cookie });
  assert.equal(withWs.status, 200);
  assert.equal(JSON.parse(withWs.body).wsAlive, true);
  ws.close(); await once(ws, 'close');

  // 3. Restarting the link server preserves persisted hashed browser sessions (no 401 on relaunch)
  //    while revoking the device still invalidates immediately.
  await link.stop();
  await link.start();
  const restartedPort = (await link.status()).port;
  const afterRestart = await new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: restartedPort, path: '/mobile/v1/session', method: 'GET',
      rejectUnauthorized: false, agent: false, headers: { Cookie: cookie },
    }, res => {
      const b = []; res.on('data', c => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(b) }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(afterRestart.status, 200, 'persisted browser cookie should survive desktop link restart');
});

test('v0.4.15: universal JSON RPC gzip, GET /api cache + gzip, shell preload hints, and scroll/haptic/wake/newSession shell hooks', async t => {
  const bigWorkspaceList = Buffer.from(JSON.stringify({
    type: 'server-response',
    rpcId: 'ws-big',
    result: { ok: true, value: { items: Array.from({ length: 80 }, (_, i) => ({ id: `ws-${i}`, name: `Workspace item ${i} - 机械设计实验项目` })) } },
  }));
  const bigSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + '<circle cx="10" cy="10" r="8"/>'.repeat(120) + '</svg>');
  const bigJson = Buffer.from(JSON.stringify({ ok: true, entries: Array.from({ length: 260 }, (_, i) => `entry-${i}`) }));

  const { request, token, origin } = await fixture(t, {
    rpcBody: { 'workspace/list': bigWorkspaceList },
    extraFetch: async ({ url }) => {
      if (url === '/api/vector/diagram.svg') return { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: bigSvg };
      if (url === '/api/info/meta.json') return { status: 200, headers: { 'content-type': 'application/json' }, body: bigJson };
      return null;
    },
  });
  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(started.status, 200);
  const cookie = started.headers['set-cookie'][0].split(';')[0];

  // 1. Any JSON RPC >= 4096B (beyond fixed allowlist) is gzip-compressed cleanly.
  const rpcRes = await request('/api/workspace/list', {
    method: 'POST', cookie, headers: { Origin: origin, 'Accept-Encoding': 'gzip' },
    body: { type: 'client-request', rpcId: 'ws-big', method: 'workspace/list', payload: { args: {} } },
  });
  assert.equal(rpcRes.status, 200);
  assert.equal(rpcRes.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(rpcRes.body), bigWorkspaceList);

  // 2. GET /api/* uncached images get private 5-min caching; SVG/JSON >= 2KB get gzip.
  const imgRes = await request('/api/media/avatar.png', { cookie });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers['cache-control'], 'private, max-age=300');

  const svgRes = await request('/api/vector/diagram.svg', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(svgRes.status, 200);
  assert.equal(svgRes.headers['cache-control'], 'private, max-age=300');
  assert.equal(svgRes.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(svgRes.body), bigSvg);

  const jsonRes = await request('/api/info/meta.json', { cookie, headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(jsonRes.status, 200);
  assert.equal(jsonRes.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(jsonRes.body), bigJson);

  // 3. injectMobileShell places early preload hints matching tail stylesheet/script hashes.
  const html = injectMobileShell('<html><head></head><body><div id="root"></div></body></html>', { actions: true, terminal: false, version: '0.4.15' });
  const preloadCss = html.match(/<link rel="preload" as="style" href="(\/mobile\/v1\/shell\.css\?v=[^"]+)">/);
  const preloadJs = html.match(/<link rel="preload" as="script" href="(\/mobile\/v1\/shell\.js\?v=[^"]+)">/);
  const linkCss = html.match(/<link rel="stylesheet" href="(\/mobile\/v1\/shell\.css\?v=[^"]+)">/);
  const deferJs = html.match(/<script defer src="(\/mobile\/v1\/shell\.js\?v=[^"]+)"><\/script>/);
  assert.ok(preloadCss && preloadJs && linkCss && deferJs, 'HTML must emit preload and tail tags for shell assets');
  assert.equal(preloadCss[1], linkCss[1]);
  assert.equal(preloadJs[1], deferJs[1]);
  assert.ok(html.indexOf(preloadCss[0]) < html.indexOf(linkCss[0]));

  // 4. CSS/JS expose scroll-to-bottom pill, haptics, wakeCheck, newSession, and run safely in a minimal VM.
  assert.match(MOBILE_SHELL_CSS, /\.dsh-scroll-bottom/);
  assert.match(MOBILE_SHELL_CSS, /overscroll-behavior-x:\s*contain/);
  assert.match(MOBILE_SHELL_JS, /wakeCheck/);
  assert.match(MOBILE_SHELL_JS, /newSession/);
  assert.match(MOBILE_SHELL_JS, /taskRunning/);
  assert.match(MOBILE_SHELL_JS, /type:\s*'haptic'/);

  const posted = [], frames = [];
  const flush = () => { while (frames.length) frames.shift()(); };
  const docEl = {
    style: { setProperty() {} },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    hasAttribute() { return false; },
    classList: { contains() { return false; } },
    contains() { return false; },
    dataset: {},
    clientHeight: 800,
    clientWidth: 390,
  };
  const sandbox = {
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      title: 'Test',
      documentElement: docEl,
      body: { children: [], hasAttribute() { return false; }, appendChild() {} },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      createElement() { return { className: '', innerHTML: '', style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} }; },
    },
    webkit: { messageHandlers: { dshMobile: { postMessage: m => posted.push(m) } } },
    addEventListener() {},
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle() { return { backgroundColor: 'rgb(255,255,255)', colorScheme: 'light', getPropertyValue() { return ''; } }; },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    encodeURIComponent,
    Date, Math, JSON, Map, Set, Number, String, Boolean, Array, Object, Error, Promise,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ actions: true, terminal: false, cursor: 'c1', wsAlive: true }) }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(MOBILE_SHELL_JS, sandbox);
  assert.equal(typeof sandbox.__DSH_MOBILE_BRIDGE__.wakeCheck, 'function');
  assert.equal(typeof sandbox.__DSH_MOBILE_BRIDGE__.newSession, 'function');
  assert.equal(typeof sandbox.__DSH_MOBILE_BRIDGE__.reportUi, 'function');
  sandbox.__DSH_MOBILE_BRIDGE__.wakeCheck();
  sandbox.__DSH_MOBILE_CORDIS__ = { newSession: () => true, isCurrentSessionRunning: () => true, getCurrentSessionId: () => 's1', isCurrentSessionBlank: () => false };
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.newSession(), true);
  sandbox.__DSH_MOBILE_BRIDGE__.reportUi();
  flush();
  assert.ok(posted.some(m => m.type === 'ready'), 'VM smoke run must emit ready message');
  assert.ok(posted.some(m => m.type === 'ui' && m.taskRunning === true), 'UI report must emit live taskRunning boolean');
});

test('v0.5.0: authenticated ping RTT endpoint, mobileHost/status telemetry in read-only mode, and Mobile Hub/Reader/Lightbox/Prefs shell hooks', async t => {
  // 1. mobileHost/status returns safe PC telemetry directly from mobileHostActions.
  const actionsHandler = mobileHostActions({
    get: (name) => name === 'sessions'
      ? { list: { getSnapshot: () => ({ ids: ['a', 'b', 'c'], byId: { a: { blank: false }, b: { blank: true }, c: { origin: 'subagent' } } }) } }
      : null,
  });
  const hostInfo = await actionsHandler['mobileHost/status']();
  assert.equal(typeof hostInfo.hostname, 'string');
  assert.ok(hostInfo.cpuCount >= 1);
  assert.ok(hostInfo.memTotalBytes >= hostInfo.memFreeBytes);
  assert.equal(hostInfo.activeSessions, 1);

  // 2. GET /mobile/v1/ping enforces auth (401 unauthenticated) and returns live wsAlive status;
  //    POST /api/mobileHost/status is permitted in read-only mode.
  const hostRpcReply = Buffer.from(JSON.stringify({
    type: 'server-response', rpcId: 'mh-1', result: { ok: true, value: hostInfo },
  }));
  const { request, token, origin } = await fixture(t, {
    actions: false,
    rpcBody: { 'mobileHost/status': hostRpcReply },
  });

  const unauthPing = await request('/mobile/v1/ping');
  assert.equal(unauthPing.status, 401);

  const started = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(started.status, 200);
  const cookie = started.headers['set-cookie'][0].split(';')[0];

  const pingIdle = await request('/mobile/v1/ping', { cookie });
  assert.equal(pingIdle.status, 200);
  const pingIdleJson = JSON.parse(pingIdle.body);
  assert.equal(pingIdleJson.ok, true);
  assert.equal(pingIdleJson.wsAlive, false);
  assert.equal(typeof pingIdleJson.ts, 'number');

  const ws = new WebSocket(origin.replace('https:', 'wss:') + '/api/remote.mux', {
    rejectUnauthorized: false, headers: { Cookie: cookie, Origin: origin },
  });
  await once(ws, 'open');
  const pingLive = await request('/mobile/v1/ping', { token });
  assert.equal(pingLive.status, 200);
  assert.equal(JSON.parse(pingLive.body).wsAlive, true);
  ws.close(); await once(ws, 'close');

  const roHostRes = await request('/api/mobileHost/status', {
    method: 'POST', cookie, headers: { Origin: origin },
    body: { type: 'client-request', rpcId: 'mh-1', method: 'mobileHost/status', payload: { args: {} } },
  });
  assert.equal(roHostRes.status, 200, 'mobileHost/status must be permitted in read-only mode');
  assert.equal(JSON.parse(roHostRes.body).result.value.activeSessions, 1);

  // 3. CSS & JS include v0.5.0 Hub, Pro Reader, Lightbox, ScrollTop, and Display Prefs.
  for (const cssPat of [/\.dsh-scroll-top/, /\.dsh-lightbox/, /\.dml-reader-bar/, /\.dml-hub-sheet/, /data-dml-code-wrap/, /data-dml-font-scale/, /\.dml-git-diff/]) {
    assert.match(MOBILE_SHELL_CSS, cssPat);
  }
  const posted = [], frames = [], attrs = new Map(), vars = new Map();
  const flush = () => { while (frames.length) frames.shift()(); };
  const store = new Map([['dml.pref.fontScale', '110'], ['dml.pref.codeWrap', 'true']]);
  const docEl = {
    style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: k => attrs.get(k) ?? null,
    removeAttribute: k => attrs.delete(k),
    hasAttribute: k => attrs.has(k),
    classList: { contains: () => false },
    contains: () => false,
    dataset: {},
    clientHeight: 800,
    clientWidth: 390,
  };
  const toastEl = { className: '', textContent: '', dataset: {}, style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} };
  const sandbox = {
    localStorage: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      title: 'Test',
      documentElement: docEl,
      body: { children: [], hasAttribute() { return false; }, appendChild() {} },
      querySelector: sel => (sel === '.dsh-mobile-toast' ? toastEl : null),
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      createElement() { return { className: '', innerHTML: '', style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} }; },
    },
    webkit: { messageHandlers: { dshMobile: { postMessage: m => posted.push(m) } } },
    addEventListener() {},
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle() { return { backgroundColor: 'rgb(255,255,255)', colorScheme: 'light', getPropertyValue: () => '' }; },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    encodeURIComponent,
    Date, Math, JSON, Map, Set, Number, String, Boolean, Array, Object, Error, Promise,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ actions: true, terminal: false, cursor: 'c1', wsAlive: true }) }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(MOBILE_SHELL_JS, sandbox);

  assert.equal(attrs.get('data-dml-font-scale'), '110');
  assert.equal(vars.get('--dml-font-scale'), '1.1');
  assert.equal(attrs.get('data-dml-code-wrap'), 'true');

  let hubTab = '', inserted = '', rightToggled = false;
  sandbox.__DSH_MOBILE_CORDIS__ = {
    newSession: () => true,
    insertDraft: text => { inserted = text; return true; },
    openHub: tab => { hubTab = tab; return true; },
    toggleRightPanel: () => { rightToggled = true; return true; },
    isCurrentSessionRunning: () => false,
    getPendingApprovals: () => [{ sessionId: 's2', title: 'Approve', isCurrent: false }],
    getCurrentSessionId: () => 's1',
    isCurrentSessionBlank: () => false,
  };
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.insertDraft('你好'), true);
  assert.equal(inserted, '你好');
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.openHub('git'), true);
  assert.equal(hubTab, 'git');
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.toggleRightPanel(), true);
  assert.equal(rightToggled, true);
  sandbox.__DSH_MOBILE_BRIDGE__.onTaskEvent({ kind: 'completed', sessionId: 's2', title: '齿轮分析' });
  assert.match(toastEl.textContent, /齿轮分析/);
  sandbox.__DSH_MOBILE_BRIDGE__.reportUi();
  flush();
  assert.ok(posted.some(m => m.type === 'ui' && m.pendingCount === 1), 'UI report must emit pendingCount');
  assert.ok(posted.some(m => m.type === 'haptic' && m.style === 'success'), 'Task completion must emit success haptic');

  // 4. Verify 1024B RPC gzip threshold + explicit Content-Length, versioned vs unversioned plugin Cache-Control,
  //    preboot 4500ms routing failsafe watchdog, and removal of layout-thrashing runLegacySeatFlip.
  const midRpc = Buffer.from(JSON.stringify({
    type: 'server-response', rpcId: 'mid-1',
    result: { ok: true, value: { summary: 'A'.repeat(1400) } },
  }));
  const midSrv = await fixture(t, { mode: 'readResource', rpcBody: { 'workspace/summary': midRpc } });
  const midSess = await midSrv.request('/mobile/v1/web-session', { method: 'POST', token: midSrv.token });
  const midCookie = midSess.headers['set-cookie'][0].split(';')[0];
  const midRes = await midSrv.request('/api/workspace/summary', {
    method: 'POST', cookie: midCookie, headers: { Origin: midSrv.origin, 'Accept-Encoding': 'gzip' },
    body: { type: 'client-request', rpcId: 'mid-1', method: 'workspace/summary', payload: { args: {} } },
  });
  assert.equal(midRes.status, 200);
  assert.equal(midRes.headers['content-encoding'], 'gzip');
  assert.equal(midRes.headers['content-length'], String(midRes.body.length));

  const unrevPlugin = await midSrv.request('/plugins/live/combo.js', { cookie: midCookie });
  assert.equal(unrevPlugin.status, 200);
  assert.equal(unrevPlugin.headers['cache-control'], 'private, no-cache');
  const revPlugin = await midSrv.request('/plugins/live/combo.js?rev=abc123', { cookie: midCookie });
  assert.equal(revPlugin.status, 200);
  assert.match(revPlugin.headers['cache-control'], /immutable/);

  const injected = injectMobileShell('<html><head></head><body><div id="root"></div></body></html>', { version: '0.5.1' });
  assert.match(injected, /8500\)/);
  assert.match(injected, /dml-snap-curtain/);
  assert.match(injected, /dml\.visualSnap\.v1/);
  assert.doesNotMatch(MOBILE_SHELL_JS, /runLegacySeatFlip/);
  assert.match(MOBILE_SHELL_JS, /revealRoot/);
  assert.match(MOBILE_SHELL_JS, /onLaunchHydrated/);
});

test('v0.5.1 zero-flash visual snapshot curtain, zero-reflow composer, zcode-remote UX features, and advertised endpoints', async t => {
  // 1. /mobile/v1/web-session and /mobile/v1/session advertise current endpoints for relay migration.
  const { request, token } = await fixture(t);
  const wsRes = await request('/mobile/v1/web-session', { method: 'POST', token });
  assert.equal(wsRes.status, 200);
  const wsJson = JSON.parse(wsRes.body);
  assert.ok(Array.isArray(wsJson.endpoints), 'web-session should advertise endpoints when present');
  const cookie = wsRes.headers['set-cookie'][0].split(';')[0];
  const sessRes = await request('/mobile/v1/session', { cookie });
  assert.equal(sessRes.status, 200);
  const sessJson = JSON.parse(sessRes.body);
  assert.ok(Array.isArray(sessJson.endpoints), 'session endpoint should advertise endpoints');

  // 2. CSS invariants: offscreen turn content-visibility, zero-reflow composer seat, expandable composer, readline, AMOLED.
  assert.match(MOBILE_SHELL_CSS, /content-visibility:\s*auto/);
  assert.match(MOBILE_SHELL_CSS, /contain-intrinsic-size:\s*auto 96px/);
  assert.doesNotMatch(MOBILE_SHELL_CSS, /body\[data-dsh-keyboard-open\]\s+\[data-composer-seat\]/);
  assert.match(MOBILE_SHELL_CSS, /#dml-composer-expand/);
  assert.match(MOBILE_SHELL_CSS, /data-dml-composer-full="true"/);
  assert.match(MOBILE_SHELL_CSS, /_toBottomSlot/);
  assert.doesNotMatch(MOBILE_SHELL_CSS, /\.dml-readline/);
  assert.match(MOBILE_SHELL_CSS, /data-dml-amoled="true"/);
  assert.match(MOBILE_SHELL_CSS, /\.dml-turn-highlight/);

  // 3. client.js must NOT install a document.body subtree MutationObserver inside MobileHubOverlay.
  const clientSrc = await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(clientSrc, /mo\?\.observe\(document\.body,\s*\{[^}]*subtree:\s*true/);
  assert.match(clientSrc, /onLaunchHydrated/);
  assert.match(clientSrc, /data-dml-amoled-toggle/);
  assert.doesNotMatch(clientSrc, /data-dml-turn-nav-toggle|dsh-mobile-session-manager|dml-task-return/);

  // 4. Runtime VM test: AMOLED theme reporting, expandable composer toggle, Turn Navigator, and 2-frame snapshot curtain release.
  const posted = [], frames = [], attrs = new Map(), vars = new Map();
  const flush = () => { while (frames.length) frames.shift()(); };
  const store = new Map([['dml.pref.amoled', 'true']]);
  let curtainRemoved = false;
  const curtainNode = { id: 'dml-snap-curtain', remove() { curtainRemoved = true; } };
  let scrolledTo = null;
  const bubble0 = { textContent: '  请帮我整理演示笔记  ', classList: { add() {}, remove() {} }, scrollIntoView(opts) { scrolledTo = { idx: 0, opts }; } };
  const bubble1 = { textContent: '继续优化输入框动画', classList: { add() {}, remove() {} }, scrollIntoView(opts) { scrolledTo = { idx: 1, opts }; } };
  const scroller = {
    querySelectorAll: sel => (sel === '[data-message-bubble]' ? [bubble0, bubble1] : []),
    addEventListener() {},
    removeEventListener() {},
    scrollHeight: 800,
    scrollTop: 0,
    clientHeight: 800,
  };
  const docEl = {
    style: { backgroundColor: '#000000', setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: k => attrs.get(k) ?? null,
    removeAttribute: k => attrs.delete(k),
    hasAttribute: k => attrs.has(k),
    classList: { contains: c => c === 'dark' },
    contains: () => false,
    dataset: { theme: 'dark' },
    offsetWidth: 390,
    clientHeight: 800,
    clientWidth: 390,
  };
  attrs.set('data-dml-routing', 'dark');
  attrs.set('data-dml-snap-cover', 'true');
  const sandbox = {
    localStorage: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      title: 'Test',
      documentElement: docEl,
      body: { children: [], hasAttribute() { return false; }, appendChild() {} },
      querySelector: sel => (sel === '[data-conversation-scroll]' ? scroller : null),
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
      getElementById: id => id === 'root' ? { firstElementChild: {} } : (id === 'dml-snap-curtain' && !curtainRemoved ? curtainNode : null),
      createElement() { return { id: '', className: '', innerHTML: '', textContent: '', style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, appendChild() {} }; },
    },
    webkit: { messageHandlers: { dshMobile: { postMessage: m => posted.push(m) } } },
    addEventListener() {},
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle() { return { backgroundColor: 'rgb(21,21,23)', colorScheme: 'dark', getPropertyValue: () => '#151517' }; },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    encodeURIComponent,
    Date, Math, JSON, Map, Set, Number, String, Boolean, Array, Object, Error, Promise,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ actions: true, terminal: false, cursor: 'c1', wsAlive: true }) }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(MOBILE_SHELL_JS, sandbox);

  // AMOLED pure black theme reported to native iOS header & preboot storage.
  assert.equal(attrs.get('data-dml-amoled'), 'true');
  assert.ok(!posted.some(m => m.type === 'theme'), 'A covered bootstrap must not overwrite the saved theme');

  // Expandable composer toggle.
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.toggleComposerExpand(), true);
  assert.equal(attrs.get('data-dml-composer-full'), 'true');
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.toggleComposerExpand(), false);
  assert.equal(attrs.has('data-dml-composer-full'), false);

  // Turn Navigator lists user prompts and scrolls cleanly.
  const turns = sandbox.__DSH_MOBILE_BRIDGE__.listConversationTurns();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, '请帮我整理演示笔记');
  assert.equal(sandbox.__DSH_MOBILE_BRIDGE__.scrollToTurn(1), true);
  assert.equal(scrolledTo?.idx, 1);

  // 2-frame snapshot curtain release: routing clears immediately so #root paints behind curtain,
  // then curtain is removed cleanly after 2 animation frames + done() runs.
  let doneCalled = false;
  sandbox.__DSH_MOBILE_BRIDGE__.onLaunchHydrated(() => { doneCalled = true; });
  assert.equal(attrs.has('data-dml-routing'), false, 'data-dml-routing clears so #root paints behind curtain');
  assert.equal(attrs.has('data-dml-snap-cover'), true, 'curtain stays up until 2nd paint frame');
  assert.equal(doneCalled, false);
  // Step 1st rAF
  const firstBatch = frames.splice(0);
  for (const fn of firstBatch) fn();
  assert.equal(curtainRemoved, false, 'curtain must still wait for 2nd frame');
  // Step 2nd rAF
  flush();
  assert.ok(posted.some(m => m.type === 'theme' && m.confirmed && m.dark && m.bgBase === '#000000'));
  assert.equal(curtainRemoved, true, 'curtain removed cleanly on 2nd frame');
  assert.equal(attrs.has('data-dml-snap-cover'), false);
  assert.equal(doneCalled, true);
});


test('cold start trusts the painted Harness body, not the frozen html theme or transparent bootstrap', () => {
  const htmlAttrs = new Map([['data-theme', 'light']]);
  let bodyDark = false, base = '', painted = 'rgba(0, 0, 0, 0)';
  const root = { firstElementChild: null };
  const body = { hasAttribute: key => key === 'data-ds-dark-theme' && bodyDark };
  const doc = { body, getElementById: () => root, documentElement: {
    hasAttribute: key => htmlAttrs.has(key), getAttribute: key => htmlAttrs.get(key),
  } };
  const read = () => readHarnessSurface(doc, element => {
    assert.equal(element, body);
    return { getPropertyValue: key => key === '--dsw-alias-bg-base' ? base : '', backgroundColor: painted };
  });
  assert.equal(read(), null);
  root.firstElementChild = {};
  assert.equal(read(), null);
  bodyDark = true;
  base = '#ffffff'; // Light defaults on the root before the body theme stylesheet settles.
  assert.deepEqual(read(), { dark: true, bgBase: '#151517', sidebarFill: '#151517' });
  painted = 'rgb(21, 21, 23)';
  assert.equal(read().bgBase, painted);
  htmlAttrs.set('data-dml-amoled', 'true');
  assert.equal(read().bgBase, '#000000');
  htmlAttrs.set('data-dml-routing', 'dark');
  assert.equal(read(), null);
  htmlAttrs.clear();
  htmlAttrs.set('data-theme', 'dark'); // The user switched to light after restoring a dark frame.
  bodyDark = false;
  assert.deepEqual(read(), { dark: false, bgBase: '#ffffff', sidebarFill: '#ffffff' });
});

// Start at document-start: the injected head runs before either the host plugin or body.
function launchFixture(surface, readOnly = false) {
  const attrs = new Map(), bodyAttrs = new Set(), calls = [], changes = [], storage = new Map();
  const html = {style:{}, getAttribute:k=>attrs.get(k), hasAttribute:k=>attrs.has(k),
    removeAttribute:k=>attrs.delete(k), setAttribute:(k,v)=>attrs.set(k,v)};
  const document = {readyState:'loading', documentElement:html, body:null, addEventListener(){},
    getElementById:id=>id === 'root' ? {firstElementChild:{}} : null, querySelector:()=>null};
  const ctx = vm.createContext({document, __DSH_MOBILE_LAUNCH__:{lockTheme:'1',surface},
    localStorage:{getItem:k=>storage.get(k), setItem:(k,v)=>storage.set(k,v)},
    MutationObserver:class { constructor(f) {changes.push(f)} observe(){} disconnect(){} },
    getComputedStyle:()=>({getPropertyValue:()=>'', backgroundColor:bodyAttrs.has('data-ds-dark-theme')?'#151517':'#ffffff'}),
    webkit:{messageHandlers:{dshMobile:{postMessage:m=>calls.push(m)}}}, addEventListener(){},
    setTimeout:()=>1, clearTimeout(){}, requestAnimationFrame:()=>1, AbortController,
  });
  const page = injectMobileShell('<html><head></head><body></body></html>', {readOnly});
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  document.body = {hasAttribute:k=>bodyAttrs.has(k), toggleAttribute:(k,on)=>on?bodyAttrs.add(k):bodyAttrs.delete(k)};
  changes[0]();
  return {ctx, document, html, bodyAttrs, calls, changes, storage};
}

test('launch theme survives passive adoption; explicit setTheme unlocks and notifies native', async () => {
  const client = await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8');
  for (const [surface,readOnly] of [['dark',false],['light',true]]) {
    const other = surface === 'dark' ? 'light' : 'dark';
    const {ctx,document,html,bodyAttrs,calls,changes,storage} = launchFixture(surface,readOnly);
    assert.equal(storage.get('dml.surface'), surface);
    assert.equal(html.style.colorScheme, surface);
    assert.equal(bodyAttrs.has('data-ds-dark-theme'), surface === 'dark');
    vm.runInContext(MOBILE_SHELL_JS, ctx); html.removeAttribute('data-dml-routing');
    let plugin, cleanup, onChange, active = other;
    const writes = [];
    function adopt(value) { active=value; html.style.colorScheme=value; document.body.toggleAttribute('data-ds-dark-theme',value==='dark'); }
    const original = function(value) { writes.push(value); adopt(value); onChange?.(); return value; };
    const theme = {getTheme:()=>({active:{colorScheme:active}}), setTheme:original};
    ctx.window = {__ModuleLoader__:{load:m=>{plugin=m.factory(()=>({}))}}};
    vm.runInContext(client,ctx);
    plugin.apply({effect(){}, slots:{inject(){}}, inject(deps, fn) { if (deps.includes('theme')) fn({theme,
      effect:f=>{ cleanup=f() }, on:(event,f)=>{assert.equal(event,'theme/change');onChange=f;return ()=>{};}}); }});
    assert.deepEqual(writes,readOnly?[]:[surface]); await new Promise(r=>setImmediate(r));
    adopt(other); onChange(); changes[0]();
    assert.equal(html.style.colorScheme,surface);
    assert.equal(bodyAttrs.has('data-ds-dark-theme'), surface === 'dark');
    assert.equal(calls.some(m=>m.type==='theme' && (m.explicit || m.dark !== (surface === 'dark'))), false);
    if (other === 'light') ctx.getComputedStyle = () => ({getPropertyValue:()=>'',backgroundColor:'#151517'});
    assert.equal(theme.setTheme(other),other);
    assert.equal(ctx.__DSH_MOBILE_THEME_LOCK__.surface,null);
    assert.deepEqual(calls.filter(m=>m.type==='theme' && m.explicit).map(m=>[m.confirmed,m.dark]), [[true,other==='dark']]);
    cleanup(); assert.equal(theme.setTheme,original);
  }
});

test('credential refresh preserves pending mux; only confirmed dead pokes can replace a subscribed mux', async () => {
  const {ctx,calls} = launchFixture('light'); let count=0, now=15000;
  ctx.Date = class extends Date {static now(){return now;}};
  ctx.document.visibilityState = 'visible'; ctx.fetch = async () => ({ok:true,json:async()=>({wsAlive:false})});
  ctx.WebSocket = class extends EventTarget {readyState=0;};
  ctx.__DSH_MOBILE_CORDIS__ = {reconnect(){count++;}};
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const bridge = ctx.__DSH_MOBILE_BRIDGE__;
  const old = new ctx.WebSocket('/api/remote.mux'), ws = new ctx.WebSocket('/api/remote.mux');
  bridge.credentialsChanged(); assert.equal(count,0);
  ws.readyState=1; ws.dispatchEvent(new Event('open')); bridge.credentialsChanged(); assert.equal(count,0);
  bridge.setLogicalConnection('connected'); old.dispatchEvent(new Event('close'));
  assert.equal(bridge.setLogicalConnection('disconnected'),false);
  assert.equal(calls.some(m=>m.state==='disconnected'),false);
  bridge.credentialsChanged(); bridge.wakeCheck(); await new Promise(r=>setImmediate(r)); assert.equal(count,0);
  now += 1001; bridge.wakeCheck(); await new Promise(r=>setImmediate(r)); assert.equal(count,0);
  ws.dispatchEvent(new Event('message'));
  now += 3000; bridge.wakeCheck(); await new Promise(r=>setImmediate(r)); assert.equal(count,0);
  now += 3000; bridge.wakeCheck(); await new Promise(r=>setImmediate(r)); assert.equal(count,1);
  ws.readyState=3; ws.dispatchEvent(new Event('close')); now+=401;
  bridge.reconnect(); bridge.reconnect(true); assert.equal(count,1);
  now+=4599; bridge.reconnect(); bridge.reconnect(true); assert.equal(count,2);
});

async function officialMux(t, overrides) {
  const server = await fixture(t, { actions: true, terminal: false, ...overrides });
  const session = await server.request('/mobile/v1/web-session', { method: 'POST', token: server.token });
  assert.equal(session.status, 200);
  const cookie = session.headers['set-cookie'][0].split(';')[0];
  const options = { rejectUnauthorized: false, headers: { Cookie: cookie, Origin: server.origin } };
  const url = server.origin.replace('https:', 'wss:') + '/api/remote.mux';
  return { ...server, cookie, options, url };
}

test('writable cloud denies optional terminal streams and RPCs without closing event or follow streams', async t => {
  const { url, options, cookie, request, seen, emitFrame } = await officialMux(t);
  const ws = new WebSocket(url, options);
  try {
    await once(ws, 'open');
    let closed;
    ws.once('close', (code, reason) => { closed = `${code} ${reason}`; });
    const incoming = on(ws, 'message', { close: ['close'], signal: AbortSignal.timeout(5000) });
    const next = async () => {
      const result = await incoming.next();
      assert.ok(!result.done, `optional subscription closed the carrier: ${closed}`);
      return JSON.parse(result.value[0]);
    };
    const endpoints = ['$events', 'session/follow', 'terminal/watch', 'terminal/retain', 'terminal/attach'];
    for (const endpoint of endpoints) ws.send(JSON.stringify({ type: 'open', endpoint, streamId: endpoint,
      payload: { args: endpoint === 'session/follow' ? { request: { sessionId: 'fixture', activate: true } } : {} } }));
    for (const endpoint of endpoints) {
      const frame = await next();
      assert.equal(frame.streamId, endpoint);
      if (endpoint.startsWith('terminal/')) {
        assert.equal(frame.type, 'error'); assert.equal(frame.error.code, 'terminal-disabled');
        ws.send(JSON.stringify({type:'cancel', streamId:endpoint}));
      } else assert.equal(frame.type, 'item');
    }
    for (const method of ['terminal/list','terminal/shells','terminal/environment']) {
      const result = await request('/api/' + method, { method:'POST', cookie,
        body:{type:'client-request',rpcId:method,method,payload:{args:{}}} });
      assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).error, 'terminal-disabled');
    }
    for (const streamId of endpoints.slice(0, 2)) {
      const frame = {type:'item', streamId, value: streamId === '$events' ? {type:'ready',clientId:'c'} : {type:'delta',seq:2}};
      emitFrame(frame); assert.deepEqual(await next(), frame);
      ws.send(JSON.stringify({type:'cancel',streamId}));
    }
    ws.send(JSON.stringify({type:'open', endpoint:'session/follow', streamId:'follow-again',payload:{args:{}}}));
    assert.equal((await next()).streamId, 'follow-again');
    assert.deepEqual(seen.streams.map(s=>s.frame.streamId), ['$events','session/follow','$events','session/follow','follow-again']);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await incoming.return();
  } finally { ws.terminate(); }
});

test('foreground wake restores a closed loopback TLS mux through its first subscribed frame in <150ms', async t => {
  const { url, options } = await officialMux(t);
  const {ctx} = launchFixture('light');
  ctx.document.visibilityState = 'visible';
  ctx.WebSocket = class extends WebSocket { constructor() { super(url, options); } };
  ctx.fetch = () => new Promise(()=>{});
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const bridge = ctx.__DSH_MOBILE_BRIDGE__;
  let ws, received, connections = 0;
  function connect() {
    connections++; ws = new ctx.WebSocket(url);
    received = once(ws,'message', {signal:AbortSignal.timeout(3000)});
    ws.once('open',()=>ws.send(JSON.stringify({type:'open',endpoint:'$events',streamId:'events',payload:{args:{}}})));
  }
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect: connect };
  try {
    connect(); await received; assert.ok(bridge.setLogicalConnection('connected'));
    bridge.credentialsChanged(); bridge.wakeCheck(); assert.equal(connections, 1);
    ws.close(); await once(ws,'close');
    const start = performance.now();
    bridge.wakeCheck(); bridge.wakeCheck();
    assert.equal(connections, 2);
    assert.equal(JSON.parse((await received)[0]).streamId, 'events');
    const elapsed = performance.now()-start;
    t.diagnostic(`wake to subscribed loopback WSS frame: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 150, `${elapsed} ms`);
  } finally { ws?.terminate(); }
});

test('foreground, credentials and direct bridge share the handshake deadline and minimum gap', () => {
  const {ctx} = launchFixture('light'); let now=5000, count=0;
  ctx.Date = class extends Date {static now(){return now;}};
  ctx.document.visibilityState='visible'; ctx.fetch=()=>new Promise(()=>{});
  ctx.WebSocket=class extends EventTarget {readyState=0;};
  ctx.__DSH_MOBILE_CORDIS__={reconnect(){count++;}};
  vm.runInContext(MOBILE_SHELL_JS,ctx); const bridge=ctx.__DSH_MOBILE_BRIDGE__;
  const ws=new ctx.WebSocket('/api/remote.mux');
  now+=999; bridge.wakeCheck(); assert.equal(count,0);
  now++; bridge.wakeCheck(); assert.equal(count,0);
  ws.readyState=1; ws.dispatchEvent(new Event('open')); bridge.credentialsChanged(); assert.equal(count,0);
  for (const age of [2000,3000,3500,11999]) {
    now = 5000 + age; bridge.wakeCheck(); bridge.credentialsChanged(); bridge.reconnect(true); assert.equal(count,0);
  }
  now++; bridge.credentialsChanged(); assert.equal(count,1);
  bridge.wakeCheck(); bridge.reconnect(true); assert.equal(count,1);
  now+=4999; bridge.credentialsChanged(); assert.equal(count,1);
  now++; bridge.wakeCheck(); assert.equal(count,2);
  assert.ok(bridge.setLogicalConnection('connected')); now+=10000;
  bridge.credentialsChanged(); bridge.wakeCheck(); bridge.reconnect(true); assert.equal(count,2);
});


test('link journal correlates a shell wake with its WSS close and distinguishes an upstream close', async t => {
  const trace = '665b5609-37ab-435d-84f1-af3a54fc26d3';
  const { origin, url, link, request, cookie, options, closeUpstream, journalFile } = await officialMux(t);
  const { ctx, calls } = launchFixture('light');
  const requests = [];
  let now = Date.now();
  ctx.Date = class extends Date { static now() { return now; } };
  ctx.performance = { now: () => now };
  ctx.URL = URL;
  ctx.location = new URL(origin);
  ctx.crypto = { randomUUID: () => trace };
  ctx.__DSH_MOBILE_SHELL__.linkEvents = true;
  ctx.WebSocket = class extends WebSocket { constructor(target) { super(target, options); } };
  ctx.document.visibilityState = 'visible';
  ctx.fetch = (path, init) => {
    const result = request(path, { cookie, headers: init.headers }).then(res => ({ ok: res.status === 200, json: () => JSON.parse(res.body) }));
    requests.push(result);
    return result;
  };
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const ws = new ctx.WebSocket(url);
  await once(ws, 'open');
  const closed = once(ws, 'close');
  now += 30_000; // This diagnostic test targets a stalled logical connection beyond any handshake grace.
  const privateText = 'fixture-private-close-content';
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect() { ws.close(4001, privateText); return true; } };
  ctx.__DSH_MOBILE_BRIDGE__.wakeCheck();
  await Promise.all(requests);
  await closed;
  assert.ok(calls.some(m => m.type === 'link-force' && m.source === 'wakeCheck'));

  const upstreamSocket = new WebSocket(url, options);
  await once(upstreamSocket, 'open');
  const upstreamClosed = once(upstreamSocket, 'close');
  closeUpstream();
  assert.equal((await upstreamClosed)[0], 1011);
  await link.stop();
  const text = await readFile(journalFile, 'utf8');
  for (const secret of [cookie, trace, privateText, 'phone-official-123']) assert.ok(!text.includes(secret));
  const events = text.trimEnd().split('\n').map(JSON.parse);
  const forced = events.find(e => e.type === 'forced-reconnect');
  assert.equal(forced.source, 'wakeCheck');
  assert.ok(Number.isFinite(Date.parse(forced.clientAt)));
  assert.equal(forced.muxAgeMs, 30_000); assert.equal(forced.readyState, 1);
  const first = events.filter(e => e.socket === forced.socket);
  assert.equal(first.length, 4);
  const policyEvent = first.find(e => e.type === 'force-reconnect');
  assert.equal(policyEvent.reason, 'wakeCheck'); assert.equal(policyEvent.gapMs, null);
  assert.equal(policyEvent.wsAliveSamples, 0);
  assert.ok(first.every(e => e.device === forced.device && Number.isFinite(Date.parse(e.at))));
  const phone = first.find(e => e.type === 'disconnected');
  assert.equal(phone.source, 'phone-close'); assert.equal(phone.code, 4001);
  assert.equal(phone.reason, 'peer-supplied'); assert.ok(phone.durationMs >= 0);
  const remote = events.find(e => e.source === 'upstream-close');
  assert.equal(remote.code, 1011); assert.equal(remote.reason, 'Harness disconnected');
  assert.notEqual(remote.socket, forced.socket);
});

test('link journal enforces both retention limits across restarts', async t => {
  for (const [lines, width] of [[500, 0], [250, 1036]]) {
    const priorEvents = Array.from({ length: lines }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(width) }) + '\n').join('');
    // A byte-bound fixture ends just below the cap, before a new connect/close pair arrives.
    const seed = width ? priorEvents.slice(0, priorEvents.lastIndexOf('\n', 256 * 1024 - 2) + 1) : priorEvents;
    const padding = width ? JSON.stringify({ pad: 'x'.repeat(256 * 1024 - Buffer.byteLength(seed) - 13) }) + '\n' : '';
    const { url, options, journalFile, link } = await officialMux(t, { priorEvents: seed + padding });
    const ws = new WebSocket(url, options);
    await once(ws, 'open'); const closed = once(ws, 'close'); ws.close(); await closed;
    await link.stop();
    const text = await readFile(journalFile, 'utf8'), events = text.trimEnd().split('\n').map(JSON.parse);
    assert.ok(events.length <= 500 && Buffer.byteLength(text) <= 256 * 1024);
    assert.ok(events[0].i > 0); assert.equal(events.at(-1).type, 'disconnected');
  }
});

test('disabling link events omits the journal and shell telemetry', async t => {
  const previous = process.env.DSH_LINK_EVENTS;
  let server;
  try { process.env.DSH_LINK_EVENTS = '0'; server = await officialMux(t); }
  finally { if (previous === undefined) delete process.env.DSH_LINK_EVENTS; else process.env.DSH_LINK_EVENTS = previous; }
  const { url, options, request, cookie, link, journalFile } = server;
  assert.match((await request('/', { cookie })).body.toString(), /"linkEvents":false/);
  const ws = new WebSocket(url, options);
  await once(ws, 'open'); const closed = once(ws, 'close'); ws.close(); await closed;
  await link.stop(); await assert.rejects(readFile(journalFile), { code: 'ENOENT' });
});

// A single virtual link drives both the old bridge and the shipped injection. Opening
// TCP, loading HTML, committing subscriptions and replacing a mux are separate events.
function legacyPolicy({ now, current, force }) {
  let state = 'connecting';
  return { setLogicalConnection(next) { state = next; return true; }, wakeCheck() {
    const { ws, created } = current();
    if (ws.readyState >= 2 || (state !== 'connected' && !(ws.readyState === 0 && now() - created < 1000))) force();
  } };
}
function simulateCloud({ legacy = false, handshakeMs = 4000, upstreamEvery = 0 }) {
  const { ctx, calls } = launchFixture('light');
  let now = 0, ws, created, forceCount = 0, passive = 0, closes = 0, load;
  const transitions = [];
  let state = 'connecting';
  ctx.Date = class extends Date { static now() { return now; } };
  ctx.document.visibilityState = 'visible';
  ctx.WebSocket = class extends EventTarget { readyState = 0; };
  ctx.addEventListener = (type, fn) => { if (type === 'load') load = fn; };
  ctx.__DSH_MOBILE_SHELL__.linkEvents = true;
  ctx.fetch = () => new Promise(() => {}); // No network in the model.
  function transition(next) {
    if (next !== state) { state = next; transitions.push([now, next]); }
  }
  function create() {
    ws = new ctx.WebSocket('/api/remote.mux'); created = now;
    bridge.setLogicalConnection('connecting'); transition('connecting');
  }
  function force() { forceCount++; create(); return true; }
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect: force };
  if (!legacy) vm.runInContext(MOBILE_SHELL_JS, ctx);
  const bridge = legacy ? legacyPolicy({ now: () => now, current: () => ({ ws, created }), force }) : ctx.__DSH_MOBILE_BRIDGE__;
  create();
  let nextRecovery = legacy ? 2000 : RECONNECT_POLICY.recoveryDelaysMs[0], step = 0;
  for (now = 100; now <= 60000; now += 100) {
    if (now === 500) load?.();
    if (now - created === 100) { ws.readyState = 1; ws.dispatchEvent(new Event('open')); }
    if (now - created === handshakeMs && bridge.setLogicalConnection('connected')) transition('connected');
    if (upstreamEvery && now % upstreamEvery === 0) {
      ws.readyState = 3; ws.dispatchEvent(Object.assign(new Event('close'), { code: 1011 }));
      transition('disconnected'); closes++;
      bridge.wakeCheck(); bridge.credentialsChanged(); bridge.reconnect(true); // Race the page's own retry.
      create(); passive++;
    }
    if (state !== 'connected' && now >= nextRecovery) {
      bridge.wakeCheck();
      nextRecovery = now + (legacy ? 2000 : RECONNECT_POLICY.recoveryDelaysMs[Math.min(++step, 4)]);
    }
    if (!legacy && now % 1000 === 0) { bridge.credentialsChanged(); bridge.wakeCheck(); }
  }
  return { forceCount, passive, closes, transitions, breakers: calls.filter(x => x.type === 'breaker-open').map(x => x.source),
    breakerDeadlines: [...new Set(calls.filter(x => x.type === 'reconnect-budget' && x.budget.until).map(x => x.budget.until))] };
}

test('60s legacyPolicy reproduces a 4s cloud handshake loop', t => {
  const r = simulateCloud({ legacy: true });
  assert.ok(r.forceCount >= 3); assert.deepEqual(r.transitions, []);
  t.diagnostic(`forced=${r.forceCount}, connected=0`);
});
test('60s injected bridge converges once at 4s with zero forces', t => {
  const r = simulateCloud({});
  assert.equal(r.forceCount, 0); assert.deepEqual(r.transitions, [[4000, 'connected']]);
  t.diagnostic(`forced=${r.forceCount}, transitions=${JSON.stringify(r.transitions)}`);
});
test('60s upstream 1011 every 4s stays passive and opens one breaker on the third close', t => {
  const r = simulateCloud({ handshakeMs: 1000, upstreamEvery: 4000 });
  assert.equal(r.forceCount, 0); assert.equal(r.closes, 15); assert.equal(r.passive, r.closes);
  assert.deepEqual(r.breakers, ['upstream-1011']); assert.deepEqual(r.breakerDeadlines, [12000 + 60000]);
  t.diagnostic(`upstream=${r.closes}, passive=${r.passive}, forced=0, breaker-open@12000ms=1`);
});

test('confirmation timer takes its own second poke and rejects an in-flight sample after an item', async () => {
  const { ctx, calls } = launchFixture('light');
  let now = 20000, id = 0, resolve, pokes = 0, count = 0;
  const timers = new Map();
  ctx.Date = class extends Date { static now() { return now; } };
  ctx.setTimeout = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; };
  ctx.clearTimeout = key => timers.delete(key);
  ctx.document.visibilityState = 'visible';
  ctx.WebSocket = class extends EventTarget { readyState = 0; };
  ctx.fetch = path => {
    if (path.includes('poke=1')) { pokes++; return new Promise(r => { resolve = r; }); }
    return new Promise(() => {});
  };
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect: () => { count++; } };
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const ws = new ctx.WebSocket('/api/remote.mux'), bridge = ctx.__DSH_MOBILE_BRIDGE__;
  ws.readyState = 1; ws.dispatchEvent(new Event('open')); bridge.setLogicalConnection('connected');
  const answer = async () => { resolve({ ok: true, json: async () => ({ wsAlive: false }) }); await new Promise(r => setImmediate(r)); };
  bridge.wakeCheck(); ws.dispatchEvent(new Event('message')); await answer();
  assert.equal([...timers.values()].some(t => t.at === now + 3000), false);
  now += 1000; bridge.wakeCheck(); await answer(); assert.equal(count, 0);
  const confirmation = [...timers.values()].find(t => t.at === now + 3000);
  assert.ok(confirmation); now += 3000; confirmation.fn(); await answer();
  assert.equal(pokes, 3); assert.equal(count, 1);
  assert.ok(calls.some(m => m.type === 'reconnect-budget' && m.budget.forces === 1));
  assert.equal(calls.some(m => m.type === 'link-force'), false); // Diagnostics off, guards still live.
});

test('a silent third failed force trips by timer, survives a document replacement, then expires', () => {
  let now = 1000, forced = 0, id = 0;
  const timers = new Map(), storage = new Map(), all = [];
  function page() {
    const { ctx, calls } = launchFixture('light'); all.push(calls);
    ctx.Date = class extends Date { static now() { return now; } };
    ctx.localStorage = { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) };
    ctx.setTimeout = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; };
    ctx.clearTimeout = key => timers.delete(key);
    ctx.__DSH_MOBILE_SHELL__.linkEvents = true;
    ctx.fetch = () => new Promise(() => {});
    ctx.__DSH_MOBILE_CORDIS__ = { reconnect: () => { forced++; } };
    vm.runInContext(MOBILE_SHELL_JS, ctx);
    return ctx.__DSH_MOBILE_BRIDGE__;
  }
  let bridge = page();
  for (now of [13000, 18000, 23000]) assert.equal(bridge.reconnect(true), true);
  now = 33000; [...timers.values()].find(t => t.at === now).fn();
  now++; bridge = page();
  now = 92999; assert.equal(bridge.reconnect(true), false);
  now++; assert.equal(bridge.reconnect(true), true);
  assert.equal(forced, 4);
  assert.deepEqual(all.flat().filter(m => m.type === 'breaker-open').map(m => m.source), ['force-timeout']);
});

test('explicit reconnect clears a tripped device in grace, coalesces ten taps and leaves automatic callers guarded', () => {
  const { ctx, storage, calls } = launchFixture('light');
  const key = 'dml.reconnect-budget.v1';
  let now = 100, count = 0;
  const tripped = { updated: now, until: now + RECONNECT_POLICY.breakerCooldownMs, decision: now + 20,
    forces: RECONNECT_POLICY.breakerAfter, closes: 2, lastClose: now, lastForce: now - 10 };
  storage.set(key, JSON.stringify(tripped));
  ctx.Date = class extends Date { static now() { return now; } };
  ctx.fetch = () => new Promise(() => {});
  ctx.WebSocket = class extends EventTarget { readyState = 0; };
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect() {
    count++;
    assert.equal(bridge.forceUserReconnect(), 'pending'); // Synchronous Cordis re-entry.
    new ctx.WebSocket('/api/remote.mux');
    return true;
  } };
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const bridge = ctx.__DSH_MOBILE_BRIDGE__;
  const auto = () => { bridge.wakeCheck(); bridge.credentialsChanged(); bridge.reconnect(true, 'userRetry', true); };
  auto(); assert.equal(count, 0);
  assert.equal(JSON.parse(storage.get(key)).until, tripped.until);
  for (let i = 0; i < 10; i++) assert.equal(bridge.forceUserReconnect(), i ? 'pending' : 'started');
  assert.equal(count, 1);
  const cleared = JSON.parse(storage.get(key));
  assert.deepEqual([cleared.forces, cleared.decision, cleared.until, cleared.closes, cleared.lastClose], [0, 0, 0, 0, null]);
  assert.equal(cleared.lastForce, now);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(m => m.type === 'reconnect-budget').at(-1).budget)), cleared);
  assert.ok(calls.some(m => m.userOverride && m.budget.until === 0));
  now += RECONNECT_POLICY.minForceReconnectGapMs;
  auto(); assert.equal(count, 1);
  assert.equal(bridge.forceUserReconnect(), 'pending'); // The mux is still handshaking.
  now += RECONNECT_POLICY.handshakeGraceMs - RECONNECT_POLICY.minForceReconnectGapMs;
  auto(); assert.equal(count, 2);
});

test('native reset reaches the retained document and wins over a stale origin on next document start', () => {
  const key = 'dml.reconnect-budget.v1';
  const now = 10000;
  const old = { updated: now + 1, until: now + RECONNECT_POLICY.breakerCooldownMs, forces: 3, decision: 0, closes: 2, lastClose: now };
  const seed = { resetID: 'A786F75C-5D84-447F-90E2-B0B65D509BC8', updated: now, until: 0, forces: 0, decision: 0, closes: 0, lastClose: null };
  for (const retained of [true, false]) {
    const { ctx, storage, calls } = launchFixture('light');
    ctx.Date = class extends Date { static now() { return now; } };
    storage.set(key, JSON.stringify(old));
    if (!retained) ctx.__DSH_RECONNECT_BUDGET__ = seed;
    vm.runInContext(MOBILE_SHELL_JS, ctx);
    const bridge = ctx.__DSH_MOBILE_BRIDGE__;
    if (retained) bridge.applyNativeBudget(seed);
    const saved = JSON.parse(storage.get(key));
    assert.equal(saved.resetID, seed.resetID);
    assert.deepEqual([saved.forces, saved.decision, saved.until, saved.closes, saved.lastClose], [0, 0, 0, 0, null]);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(m => m.type === 'reconnect-budget').at(-1).budget)), saved);
    assert.equal(bridge.reconnect(true), false); // Applying a native seed does not grant user intent.
  }
});

test('a newly tripped breaker releases an earlier user attempt before the next explicit retry', () => {
  const { ctx, storage } = launchFixture('light');
  let now = 1000, forces = 0;
  ctx.Date = class extends Date { static now() { return now; } };
  ctx.WebSocket = class extends EventTarget { readyState = 0; };
  ctx.fetch = () => new Promise(() => {});
  ctx.__DSH_MOBILE_CORDIS__ = { reconnect() { forces++; } };
  vm.runInContext(MOBILE_SHELL_JS, ctx);
  const bridge = ctx.__DSH_MOBILE_BRIDGE__;
  assert.equal(bridge.forceUserReconnect(), 'started');
  for (let i = 0; i < RECONNECT_POLICY.breakerAfter; i++) {
    now++;
    const socket = new ctx.WebSocket('/api/remote.mux');
    socket.readyState = 3;
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1011 }));
  }
  assert.ok(JSON.parse(storage.get('dml.reconnect-budget.v1')).until > now);
  bridge.wakeCheck(); assert.equal(forces, 1);
  assert.equal(bridge.forceUserReconnect(), 'started');
  assert.equal(bridge.forceUserReconnect(), 'pending');
  assert.equal(forces, 2);
});

test('rebuilding a document with an open device breaker issues zero forces until the original deadline', t => {
  const key = 'dml.reconnect-budget.v1';
  const seed = { updated: 1000, until: 1000 + RECONNECT_POLICY.breakerCooldownMs, decision: 0,
    forces: 0, closes: RECONNECT_POLICY.breakerAfter, lastClose: 1000, lastForce: null };
  for (const origin of ['fresh origin with native seed', 'same origin with persisted seed']) {
    const { ctx, calls, storage } = launchFixture('light');
    let now = seed.updated + 1, forces = 0;
    ctx.Date = class extends Date { static now() { return now; } };
    if (origin.startsWith('fresh')) ctx.__DSH_RECONNECT_BUDGET__ = seed;
    else storage.set(key, JSON.stringify(seed));
    ctx.__DSH_MOBILE_SHELL__.linkEvents = true;
    ctx.WebSocket = class extends EventTarget { readyState = 0; };
    ctx.fetch = () => new Promise(() => {});
    ctx.__DSH_MOBILE_CORDIS__ = { reconnect() { forces++; } };
    vm.runInContext(MOBILE_SHELL_JS, ctx);
    const bridge = ctx.__DSH_MOBILE_BRIDGE__;
    new ctx.WebSocket('/api/remote.mux');
    const started = now;
    for (now of [started, started + RECONNECT_POLICY.handshakeGraceMs, seed.until - 1]) {
      bridge.wakeCheck(); bridge.credentialsChanged();
      assert.equal(bridge.reconnect(true), false);
      assert.equal(forces, 0, origin);
      assert.equal(calls.filter(m => m.type === 'link-force').length, 0);
      assert.equal(JSON.parse(storage.get(key)).until, seed.until);
    }
    now = seed.until;
    assert.equal(bridge.reconnect(true), true);
    assert.equal(forces, 1);
    t.diagnostic(`${origin}: 0 forces through ${seed.until - 1}ms, first allowed at ${now}ms`);
  }
});

for (const [endpoint, actions, denial] of [['terminal/watch', true, 'terminal-disabled'], ['session/prompt', false, 'actions-disabled']]) {
  test(`${denial}: restoring a denied subscription keeps the one ready mux, without automatic rebuild`, async t => {
    const {url, options, journalFile, seen} = await officialMux(t, {actions});
    const ws = new WebSocket(url, options);
    t.after(() => ws.terminate());
    const incoming = on(ws, 'message', {signal: AbortSignal.timeout(8000)});
    let closes = 0;
    ws.on('close', () => closes++);
    await once(ws, 'open');
    const open = (id, method) => ws.send(JSON.stringify({type:'open', streamId:id, endpoint:method, payload:{args:{}}}));
    open('events', '$events');
    assert.equal(JSON.parse((await incoming.next()).value[0]).type, 'item');
    open('optional', endpoint);
    const frame = JSON.parse((await incoming.next()).value[0]);
    assert.deepEqual(Object.keys(frame).sort(), ['error','streamId','type']);
    assert.equal(frame.type, 'error'); assert.equal(frame.streamId, 'optional');
    assert.deepEqual(Object.keys(frame.error).sort(), ['code','details','message']);
    assert.equal(frame.error.code, denial); assert.deepEqual(frame.error.details, {});
    assert.equal(typeof frame.error.message, 'string');
    assert.ok(!seen.streams.some(s => s.frame.endpoint === endpoint));
    await new Promise(resolve => setTimeout(resolve, 5100));
    open('follow', 'session/follow');
    assert.equal(JSON.parse((await incoming.next()).value[0]).streamId, 'follow');
    const rows = (await readFile(journalFile,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(closes, 0); assert.equal(rows.filter(r => r.type === 'connected').length, 1);
    assert.equal(rows.filter(r => r.type === 'disconnected').length, 0);
    await incoming.return(); ws.close(); await once(ws,'close');
  });
}

test('native trace POST correlates with its mux, validates whole batches, rate limits and rejects page cookies', async t => {
  const {url, options, token, cookie, request, journalFile} = await officialMux(t);
  const trace = '665b5609-37ab-435d-84f1-af3a54fc26d3', ticket = '4d00b678-9283-41d7-9186-7f350f3a1b95';
  const ws = new WebSocket(url + '?dmlTrace=' + trace, options);
  await once(ws,'open'); t.after(() => ws.terminate());
  const post = (body, auth = {token}) => request('/mobile/v1/sync',{method:'POST', ...auth, body});
  const rows = [['document-start',''],['mux','open'],['ws','connecting->connected'],['document-loaded','']].map(([type,detail]) =>
    ({type,detail,ms:Date.now(),ticket,page:ticket,socket:trace}));
  assert.equal((await post(rows,{cookie})).status,401);
  assert.equal((await post(rows)).status,200);
  assert.equal((await post(rows)).status,429);
  await new Promise(r => setTimeout(r,110));
  assert.equal((await post([...rows, {...rows[0], detail:'untrusted-page-text'}])).status,400);
  await new Promise(r => setTimeout(r,110));
  assert.equal((await post(Array(17).fill(rows[0]))).status,400);
  const text = await readFile(journalFile,'utf8'); const events = text.trim().split('\n').map(JSON.parse);
  const accepted = events.filter(x => x.client);
  assert.deepEqual(accepted.map(r=>r.type), rows.map(r=>r.type));
  assert.ok(accepted.every(r=>r.socket===events[0].socket && r.device===events[0].device && r.ticket===accepted[0].ticket));
  for (const forbidden of [ticket, trace, token,'untrusted-page-text']) assert.ok(!text.includes(forbidden));
  ws.close(); await once(ws,'close');
});

test('terminal queue overflow remains a valid stream failure on the browser wire', async t => {
  const {url, options, emitFrame} = await officialMux(t, {terminal:true});
  const ws = new WebSocket(url, options); t.after(() => ws.terminate());
  await once(ws,'open');
  ws.send(JSON.stringify({type:'open',streamId:'term',endpoint:'terminal/attach',payload:{args:{}}}));
  await once(ws,'message');
  const pending = once(ws,'message');
  emitFrame({type:'error',streamId:'term',error:{code:'terminal/queue-full',message:'full'}});
  const [data, binary] = await pending;
  assert.equal(binary,false); assert.deepEqual(JSON.parse(data).error,{code:'terminal/queue-full',message:'full',details:{}});
  ws.close(); await once(ws,'close');
});
