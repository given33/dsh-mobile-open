// Host half of the dsh-mobile-link DSH plugin.
//
// Runs inside the DSH host process (desktop app or `dsh web`). It serves paired
// phones from its own TLS listener, dispatching their authorized DSH requests
// and official frontend resources in-process, and gives the desktop panel
// (plugin/client.js) a small API on the host's own web server, behind the
// host's own login check.
import { registerSourceCommands, registerSourceSteps } from '../lib/task-sync/source-state.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installModelRouting } from './model-routing.mjs';
import { registerScriptCheckpoint } from '../lib/task-sync/script-checkpoint-tool.mjs';
import { registerDeploymentRef } from '../lib/task-sync/deployment-ref.mjs';
import { registerGitReleasePlan } from '../lib/task-sync/git-release-tool.mjs';
import { registerEnvironment, textOutput } from '../lib/task-sync/relay-environment.mjs';
import { registerTurnRelay } from '../lib/task-sync/relay-turn.mjs';
import { sessionPlacement } from '../lib/task-sync/command-placement.mjs';
import { registerCloudRun, workspaceRoute } from '../lib/task-sync/cloud-turn.mjs';
import { registerPortableSteps, registerStepReceipts } from '../lib/task-sync/portable-step.mjs';
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
  let submitCloudTurn, shellPlacement;
  if (rawConfig.taskSync?.role) {
    const root = join(config.stateDir,'..','mobile-task-sync');
    const role = rawConfig.taskSync.role;
    if (['desktop','cloud'].includes(role) && rawConfig.taskSync.turnRelay === true) {
      ctx.inject(['tools'],child => registerScriptCheckpoint(child,root,textOutput));
      ctx.inject(['tools'],child => registerGitReleasePlan(child,textOutput));
      ctx.inject(['tools'],child => registerDeploymentRef(child,textOutput));
      ctx.inject(['tools','workingDirectory','sessions','sessionPersistence'], child => registerEnvironment(child,role,root));
      ctx.inject(['workspaceRegistry'], child => {
        shellPlacement = async ({sessionId, value}) => {
          const project = child.workspaceRegistry.list().find(p => p.sessionIds.includes(sessionId));
          if (!project || child.workspaceRegistry.archivedSessionIds.includes(sessionId) ||
              (await workspaceRoute(root, role, project)).owner !== role) return {available:false};
          return {available:true, role, value:await sessionPlacement(root, role, project.id, sessionId, value)};
        };
        child.effect(() => () => { shellPlacement = undefined; });
      });
      ctx.inject(['tools','sessions','sessionPersistence','workspaceRegistry','workingDirectory'], child => registerTurnRelay(child,role,root));
      ctx.inject(['systemPrompt'], child => child.systemPrompt.section({name:'mobile-link:relay', order:850,
        text:'This DSH has a paired execution host. Use relay_environment to check the actual OS, native shells and workspace manifests. When the owner wants work to survive this host going offline, proactively call relay_remaining_task alone at a completed step boundary BEFORE starting the next long operation, if the task can run there. On the peer, verify source files, dependencies, credentials and previous side effects; never translate a destructive command blindly or bypass required approvals. For an authorized release to an opted-in Git target, record relay_git_release_plan before any push. Use the helper returned by relay_environment through the native shell: node HELPER status|prepare|finish REMOTE BRANCH OPERATION IDENTITY BASE DESIRED. Keep the original operation; check target status before retries. Committed means the Git branch was updated, not that CI or deployment succeeded. For a GitHub deployment, record relay_deployment_ref with the original authorized target. After a switch, read relay_environment.deploymentVerification and check for a fresh owner-configured observation matching the original referenceOperation. Otherwise, if allowed, run node HELPER TICKET via the native shell. Do not change sandbox rules or create watch policies. Use relay_wait_deployment for a first or changed owner observation; a timeout is not a deployment outcome. Pending means wait, success describes this specific rollout only. Unknown, failure or a missing creation response is not permission to submit again. Do not fabricate an ID or actor. Do not enable target policies yourself. For replay-safe computation in scripts you can adapt, use relay_environment.scriptProgress, bind the recipe to code and inputs, save explicit state and check paired acknowledgement. If native sandbox denies access, use relay_script_checkpoint(quiet or load), pass only explicit data into the approved project script, and save its checkpoint result using the same job and recipe. Never loosen the sandbox. A prestarted standby can resume a quiet checkpoint; quiet is not proof of source death and never authorizes installs, external writes or deployments. When relay_environment provides resultDelivery, stage the exact final bytes of its requested workspace outputs under the indicated directory before finishing. Never synthesize a missing result. If relay_environment.handoff.deferredCall says sourceExecution is not-started, the source shell body was never invoked for that specific call. Review its original purpose and timeout, choose the native target command and obtain its normal approvals. Never infer that any earlier call did not run. A live process is not portable. Do not transfer again merely because of an automatic handoff.',
        retirement:'The paired-host execution relay is unavailable.'}));
    }
    if (rawConfig.taskSync.portableSteps === true) {
      const {role, sshHost} = rawConfig.taskSync;
      if (role === 'desktop') {
        ctx.inject(['tools','workingDirectory','workspaceRegistry'], child => registerPortableSteps(child,sshHost));
      }
      ctx.inject(['commands'], child => registerStepReceipts(child,role,root));
    }
    if (rawConfig.taskSync.role === 'desktop' && rawConfig.taskSync.cloudTurns === true) {
      ctx.inject(['commands','sessions','workspaceRegistry','sessionPersistence','sessionController'], child => {
        submitCloudTurn = registerCloudRun(child, root);
        child.effect(() => () => { submitCloudTurn = undefined; });
      });
    }
    ctx.inject(['tools','workspaceRegistry'], child => registerSourceSteps(child,role,root,workspaceRoute));
    ctx.inject(['commands','workspaceRegistry'], child => registerSourceCommands(child,role,root,workspaceRoute));
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
      if (req.method === 'GET' && path === '/status') return send(res, 200, {...await link.status(), cloudTurns:!!submitCloudTurn, shellPlacement:!!shellPlacement});
      if (req.method !== 'POST') return send(res, 404, { error: 'not-found' });
      // A JSON body is required for every change: a cross-site form cannot send one.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json-required' });
      if (path === '/shell-placement') {
        if (!shellPlacement || peer?.principal?.kind !== 'owner' || peer.signal.aborted) return send(res,403,{error:'owner-required'});
        const request = await readJsonBody(req);
        if (typeof request?.sessionId !== 'string' || (request.value !== undefined && !['peer','local','default'].includes(request.value))) {
          return send(res,400,{error:'invalid-placement'});
        }
        return send(res,200,await shellPlacement(request));
      }
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
