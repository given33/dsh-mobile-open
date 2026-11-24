import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { optionalJson, retiredRoutes } from './catalog.mjs';
import { hash } from './log.mjs';

const file = fileURLToPath(new URL('./source_sync.py', import.meta.url));
const python = process.platform === 'win32' ? 'py' : 'python3';
const prefix = process.platform === 'win32' ? ['-3.11', '-B', file] : ['-B', file];
const run = promisify(execFile);
const identity = route => hash(`${route.owner}:${route.key}`);

async function exists(path) {
  try { await access(path); return true; }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

// Share in-flight attempts between the catalogue and the first local tool call.
export function createAutoSource(root, config) {
  const attempts = new Map();
  return async (project, route, retired) => {
    if (config.turnRelay !== true || config.autoSourceShare === false || route.owner !== config.role) return;
    const key = identity(route), cached = attempts.get(key);
    if (cached && cached.path === project.path) return cached.done;
    const attempt = {path:project.path};
    attempt.done = (async () => {
      const excluded = retired ?? retiredRoutes(await optionalJson(join(root,'retired-workspaces.json')));
      if (excluded.has(`${route.owner}:${route.key}`)) {
        if (attempts.get(key) === attempt) attempts.delete(key);
        return;
      }
      await run(python,[...prefix,'auto-bind',root,key,attempt.path],{windowsHide:true,timeout:15000});
    })();
    attempts.set(key, attempt);
    try { await attempt.done; }
    catch (err) { if (attempts.get(key) === attempt) attempts.delete(key); throw err; }
  };
}

export async function sourceState(root, route, action = 'status', args = []) {
  const key = identity(route);
  const folder = join(root,'source-grants');
  if (!await exists(join(folder,key+'.json')) || await exists(join(folder,key+'.disabled'))) return null;
  const result = await run(python, [...prefix, action, root, key, ...args], { windowsHide: true, timeout: 45000, maxBuffer: 2 ** 20 });
  return JSON.parse(result.stdout);
}

export async function sealSource(root, packet) {
  const state = await sourceState(root, packet.workspace, 'fence');
  if (!state) return;
  if (!state.ready) throw Error('源码有冲突或尚未应用的修订；未转交任务。');
  packet.sourceFence = { epoch: state.epoch, seq: state.seq };
}

export async function sourceReady(root, packet, archive = false) {
  const fence = packet.sourceFence;
  if (fence === undefined) return !await sourceState(root, packet.workspace); // Never start an unversioned handoff in an enrolled workspace.
  if (!/^[0-9a-f]{32}$/.test(fence?.epoch) || !Number.isSafeInteger(fence.seq) || fence.seq < 0) throw Error('无效源码检查点');
  const state = archive ? await sourceState(root, packet.workspace, 'git-backup', [fence.epoch, String(fence.seq)]) : await sourceState(root, packet.workspace, 'fence');
  return (!archive || !!state?.gitCommit) && !!state?.ready && state.peerEpoch === fence.epoch && state.received >= fence.seq;
}

export function watchSource(root, signal, role) {
  const child = spawn(python, [...prefix, 'watch', root, role], { signal, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {}); // Periodic transport scans remain available without the watcher.
}

export function registerSourceCommands(ctx, role, root, workspaceRoute) {
  ctx.commands.register({ definitionId: 'dsh-mobile-link/source-share', name: 'source-share',
    description: '查看源码同步状态；设备所有者可登记要共享的代码目录', input: {hint: '[--off | --project | src tests README.md]'},
    async handler({agent, rawInput}) {
      const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(agent.session.id));
      if (!project) return {kind:'error', text:'未找到本会话的工作区。'};
      const route = await workspaceRoute(root, role, project);
      const names = (rawInput || '').trim();
      if (names) {
        if (route.owner !== role || ctx.invocation?.peer?.principal?.kind !== 'owner') return {kind:'error',text:'只能由原工作区的设备所有者授权源码目录。'};
        if (names === '--off') {
          await run(python,[...prefix,'disable',root,identity(route)],{windowsHide:true,timeout:15000});
        } else {
          const scopes = names === '--project' ? ['*'] : names.startsWith('[') ? JSON.parse(names) : names.split(/\s+/u);
          if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => typeof s !== 'string')) throw Error('请输入目录或文件名。');
          try { await run(python,[...prefix,'bind',root,identity(route),project.path,...scopes],{windowsHide:true,timeout:15000}); }
          catch (err) {
            const message = err.stdout && JSON.parse(err.stdout).scopeError;
            if (message) return {kind:'error', text:message};
            throw err;
          }
        }
      }
      const state = await sourceState(root, route,'fence');
      if (!state) {
        const off = await exists(join(root,'source-grants',identity(route)+'.disabled'));
        return {kind:'success',text:off ? '源码同步已关闭（--off）。已配对的工作区只可按原范围恢复。' :
          '未自动纳入源码同步。受保护目录或非标准项目根不会自动共享；可在原工作区手动指定子目录：/source-share src tests'};
      }
      const issues = state.conflicts.length ? '；待合并：'+state.conflicts.join('、') : state.ready ? '' : '；存在尚未应用的版本';
      return {kind:'success',text:`${state.auto ? '自动同步' : '手动同步'}：本机版本 ${state.seq}，对端已持久接收 ${state.peerStored}；已收到对端版本 ${state.received}${issues}。`};
    }});
}

// Snapshot at tool boundaries, including ordinary writes from native tools. An error
// recording a result must never turn an already-executed operation into a retry.
export function registerSourceSteps(ctx, role, root, workspaceRoute, ensureAutoSource) {
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session;
    if (!session?.id || !exec.callId) return next();
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(session.id));
    if (!project) return next();
    const route = await workspaceRoute(root, role, project);
    await ensureAutoSource?.(project, route);
    const mark = phase => sourceState(root, route, 'mark', [session.id, exec.callId, phase]);
    const before = await mark('before');
    if (!before) return next();
    if (!before.ready) throw Error('共享源码存在冲突或还没应用；这个工具尚未执行。');
    // The desktop is the volatile executor. The cloud must still be able to make
    // progress with its durable copy after the desktop loses power.
    let waitForPeer = role === 'desktop';
    if (waitForPeer && before.auto === true) {
      const seen = await optionalJson(join(root,'failover','peer-observed.json'));
      const age = Date.now() - seen?.lastSeenAt;
      waitForPeer = Number.isSafeInteger(seen?.lastSeenAt) && age >= 0 && age <= 20000;
      if (!waitForPeer) console.warn('[dsh-mobile-link/source-sync] Peer offline; continuing with a local checkpoint');
    }
    async function confirm(snapshot) {
      if (!waitForPeer) return;
      const deadline = Date.now() + 20000;
      let current = snapshot;
      while (current && current.peerStored < snapshot.seq && Date.now() < deadline) {
        await delay(120, undefined, {signal:exec.signal});
        current = await sourceState(root, route);
      }
      if (current && current.peerStored >= snapshot.seq) return;
      if (before.auto === true && current && Date.now() >= deadline) {
        exec.signal?.throwIfAborted();
        console.warn('[dsh-mobile-link/source-sync] Peer acknowledgement timed out; continuing with a local checkpoint');
        waitForPeer = false;
        return;
      }
      throw Error('云端尚未确认源码检查点。');
    }
    try { await confirm(before); }
    catch (err) { throw Error('云端未确认：本步工具没有执行。', {cause:err}); }
    exec.signal?.throwIfAborted();
    let phase = 'threw';
    try {
      const result = await next();
      phase = 'returned';
      return result;
    } finally {
      try { await confirm(await mark(phase)); }
      catch { console.warn('[dsh-mobile-link/source-sync] Post-tool file checkpoint pending; original tool result preserved'); }
    }
  });
}
