// Host half of the dsh-mobile-link DSH plugin.
//
// Runs inside the DSH host process (desktop app or `dsh web`). It serves paired
// phones from its own TLS listener, dispatching their authorized DSH requests
// and official frontend resources in-process, and gives the desktop panel
// (plugin/client.js) a small API on the host's own web server, behind the
// host's own login check.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installModelRouting } from './model-routing.mjs';
import { registerCloudRun } from '../lib/task-sync/cloud-turn.mjs';
import { taskSync, syncModels } from '../lib/task-sync/host.mjs';
import { createLinkService } from '../lib/link-service.mjs';
import { inProcessUpstream } from '../lib/upstream-inprocess.mjs';
import { mobileHostActions, nativeScheduleAction } from '../lib/mobile-host-actions.mjs';
import { createPanelRegistry } from '../lib/mobile-panels.mjs';
import { createOfficialWeb } from '../lib/official-web.mjs';
import { createMobileFocusTracker } from '../lib/mobile-focus.mjs';

export const name = 'dsh-mobile-link';
export const inject = ['webServer', 'typertGateway', 'connection'];

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? ''; } catch { return ''; }
})();

/** Panel API prefix on the host's web server. */
export const PANEL_PATH = '/dsh-mobile-link';

const PORT_MIN = 1024, PORT_MAX = 65535;

/** Config from cordis.patch.yml; every field is optional. */
export function readConfig(config = {}) {
  // 0 picks a free port (tests); otherwise an unprivileged port, default 3081.
  const port = config.port === 0 || (Number.isInteger(config.port) && config.port >= PORT_MIN && config.port <= PORT_MAX) ? config.port : 3081;
  const list = value => (Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : []);
  return {
    port,
    host: typeof config.host === 'string' && config.host ? config.host : undefined,
    name: typeof config.name === 'string' ? config.name : undefined,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : undefined,
    actions: typeof config.actions === 'boolean' ? config.actions : undefined,
    terminal: typeof config.terminal === 'boolean' ? config.terminal : undefined,
    extraHosts: list(config.extraHosts),
    tunnels: list(config.tunnels).filter(u => /^https:\/\/[^/?#@]+(\/[^?#]*)?$/.test(u)),
    stateDir: typeof config.stateDir === 'string' && config.stateDir
      ? config.stateDir
      : join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'mobile-link'),
  };
}

const send = (res, status, value) => {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
};

async function readJsonBody(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx, rawConfig = {}) {
  const config = readConfig(rawConfig);
  if (rawConfig.modelRouting !== false) {
    ctx.inject?.(['llm'], child => installModelRouting(child, config.stateDir));
  }
  let submitCloudTurn;
  if (rawConfig.taskSync?.role) {
    const root = join(config.stateDir,'..','mobile-task-sync');
    if (rawConfig.taskSync.role === 'desktop' && rawConfig.taskSync.cloudTurns === true) {
      ctx.inject(['commands','sessions','workspaceRegistry','sessionPersistence','sessionController'], child => {
        submitCloudTurn = registerCloudRun(child, root);
        child.effect(() => () => { submitCloudTurn = undefined; });
      });
    }
    ctx.inject(['settings'], child => syncModels(child,rawConfig.taskSync.role,root));
    ctx.inject(['workspaceRegistry','sessionPersistence'], child => {
      taskSync(child, rawConfig.taskSync, root);
    });
  }
  const say = (...parts) => console.log('[dsh-mobile-link]', ...parts);
  let service, disposed = false;
  ctx.on?.('session/event', (session, event) => service?.notifications?.event(session.id, event, () => {
    const cwd = session.header?.cwd;
    const workspace = ctx.get?.('workspaceRegistry')?.list().find(w => w.path === cwd || w.sessionIds.includes(session.id));
    return {
      title: ctx.get?.('sessionTitle')?.get(session)?.title,
      workspace: workspace?.title || cwd?.split(/[\\/]/).filter(Boolean).at(-1),
    };
  }));
  const panels = createPanelRegistry();
  const focus = createMobileFocusTracker();
  ctx.provide?.('mobilePanels', { register: panels.register });
  const upstream = inProcessUpstream({ connection: ctx.connection, typertGateway: ctx.typertGateway, local: {
    ...mobileHostActions(ctx), 'mobilePanels/list': panels.list, 'mobilePanels/read': panels.read, 'mobilePanels/perform': panels.perform,
  }, nativeLocal: method => nativeScheduleAction(ctx, method) });

  const officialWeb = createOfficialWeb({
    webServer: ctx.webServer,
    clientModules: () => ctx.get?.('clientModules') ?? ctx.clientModules,
    connection: ctx.connection,
  });

  const ready = createLinkService({
    stateDir: config.stateDir, upstream, officialWeb, focus,
    name: config.name, port: config.port, host: config.host,
    enabled: config.enabled, actions: config.actions, terminal: config.terminal, extraHosts: config.extraHosts, tunnels: config.tunnels, appVersion: VERSION,
    log: event => {
      if (event.type === 'paired') say(`paired ${event.device?.name ?? ''} from ${event.address ?? ''}`);
      else if (event.type === 'pair-rejected') say(`rejected a pairing attempt (${event.reason}) from ${event.address ?? ''}`);
      else if (event.type === 'error') say(`error in ${event.where}: ${event.message ?? ''}`);
    },
  }).then(async created => {
    service = created;
    if (disposed) await created.close();
    else say(`ready (${created.listening ? `listening on ${config.port}` : 'phone connections off'})`);
    return created;
  }, error => { console.error('[dsh-mobile-link] could not start:', error); throw error; });
  ready.catch(() => {});
  panels.register('dsh-mobile-link', {
    id: 'connection', title: '手机连接', detail: '电脑连接组件的运行状态。',
    async read() {
      const link = await ready;
      return { revision: 1, info: [
        { title: '连接组件版本', value: VERSION },
        { title: '监听端口', value: String(config.port) },
        { title: '状态', value: link.listening ? '已启用' : '已停用' },
      ] };
    },
  });

  ctx.effect(() => () => {
    disposed = true;
    ready.then(created => created.close(), () => {});
  }, 'dsh-mobile-link: phone link');

  async function handle(req, res, peer) {
    // 0.2.3-alpha.2 authenticates web routes before calling the handler and
    // passes their PeerScope. Older hosts authenticate through Connection.
    const rejection = typeof ctx.connection.requestRejection === 'function'
      ? ctx.connection.requestRejection(req)
      : !peer || peer.signal?.aborted ? 401 : peer.principal?.kind !== 'owner' ? 403 : undefined;
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
    const path = new URL(req.url ?? '/', 'http://host.invalid').pathname.slice(PANEL_PATH.length) || '/';
    let link;
    try { link = await ready; } catch { return send(res, 503, { error: 'not-started' }); }
    try {
      if (req.method === 'GET' && path === '/presence') {
        // Same desktop-only authenticated route as /status; no pairing secrets or history.
        res.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-store', 'x-accel-buffering':'no' });
        let previous;
        const publish = () => { const online=link.hasPhones(); if(online!==previous){previous=online;res.write('data: '+JSON.stringify({online})+'\n\n');} };
        const off=link.onChange(publish); res.write('retry: 750\n\n'); publish();
        const beat=setInterval(()=>res.write(': ping\n\n'),20000); beat.unref?.();
        res.once('close',()=>{clearInterval(beat);off();}); return;
      }
      if (req.method === 'GET' && path === '/status') return send(res, 200, {...await link.status(), cloudTurns:!!submitCloudTurn});
      if (req.method !== 'POST') return send(res, 404, { error: 'not-found' });
      // A JSON body is required for every change: a cross-site form cannot send one.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json-required' });
      if (path === '/cloud-run') {
        if (!submitCloudTurn || peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return send(res,403,{error:'owner-required'});
        const {sessionId, text} = await readJsonBody(req, 96 * 1024);
        const result = await submitCloudTurn(sessionId, text, AbortSignal.any([peer.signal]));
        return send(res,200,{result});
      }
      const body = await readJsonBody(req);
      if (path === '/desktop-focus') {
        return send(res, 200, focus.update(body));
      }
      if (path === '/enabled') {
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled-required' });
        await link.setEnabled(body.enabled);
        return send(res, 200, await link.status());
      }
      if (path === '/actions') {
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled-required' });
        await link.setActions(body.enabled);
        return send(res, 200, await link.status());
      }
      if (path === '/terminal') {
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled-required' });
        await link.setTerminal(body.enabled);
        return send(res, 200, await link.status());
      }
      if (path === '/code') { link.rotateCode(); return send(res, 200, await link.status()); }
      if (path === '/devices/remove') {
        if (typeof body.id !== 'string') return send(res, 400, { error: 'id-required' });
        await link.removeDevice(body.id);
        return send(res, 200, await link.status());
      }
      return send(res, 404, { error: 'not-found' });
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error?.status === 413 ? 'too-large' : 'failed' });
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PANEL_PATH, auth: 'required', handler: handle }),
    'dsh-mobile-link: desktop panel API');
}
