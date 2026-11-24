import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from './log.mjs';

const file = fileURLToPath(new URL('./source_sync.py', import.meta.url));
const python = process.platform === 'win32' ? 'py' : 'python3';
const prefix = process.platform === 'win32' ? ['-3.11', '-B', file] : ['-B', file];
const run = promisify(execFile);
const identity = route => hash(`${route.owner}:${route.key}`);

export async function sourceState(root, route, action = 'status', args = []) {
  const key = identity(route);
  try { await access(join(root, 'source-grants', key + '.json')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const result = await run(python, [...prefix, action, root, key, ...args], { windowsHide: true, timeout: 45000, maxBuffer: 2 ** 20 });
  return JSON.parse(result.stdout);
}

export async function sealSource(root, packet) {
  const state = await sourceState(root, packet.workspace, 'fence');
  if (!state) return;
  if (!state.ready) throw Error('源码有冲突或尚未应用的修订；未转交任务。');
  packet.sourceFence = { epoch: state.epoch, seq: state.seq };
}

export async function sourceReady(root, packet) {
  const fence = packet.sourceFence;
  if (fence === undefined) return !await sourceState(root, packet.workspace); // Never start an unversioned handoff in an enrolled workspace.
  if (!/^[0-9a-f]{32}$/.test(fence?.epoch) || !Number.isSafeInteger(fence.seq) || fence.seq < 0) throw Error('无效源码检查点');
  const state = await sourceState(root, packet.workspace, 'fence');
  return !!state?.ready && state.peerEpoch === fence.epoch && state.received >= fence.seq;
}

export function watchSource(root, signal) {
  const child = spawn(python, [...prefix, 'watch', root], { signal, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {}); // Periodic transport scans remain available without the watcher.
}

export function registerSourceCommands(ctx, role, root, workspaceRoute) {
  ctx.commands.register({ definitionId: 'dsh-mobile-link/source-share', name: 'source-share',
    description: '查看源码同步状态；设备所有者可登记要共享的代码目录', input: {hint: '[src tests README.md]'},
    async handler({agent, rawInput}) {
      const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(agent.session.id));
      if (!project) return {kind:'error', text:'未找到本会话的工作区。'};
      const route = await workspaceRoute(root, role, project);
      const names = (rawInput || '').trim();
      if (names) {
        if (route.owner !== role || ctx.invocation?.peer?.principal?.kind !== 'owner') return {kind:'error',text:'只能由原工作区的设备所有者授权源码目录。'};
        const scopes = names === '--project' ? ['*'] : names.startsWith('[') ? JSON.parse(names) : names.split(/\s+/u);
        if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => typeof s !== 'string')) throw Error('请输入目录或文件名。');
        await run(python,[...prefix,'bind',root,identity(route),project.path,...scopes],{windowsHide:true,timeout:15000});
      }
      const state = await sourceState(root, route,'fence');
      if (!state) return {kind:'success',text:'本工作区尚未共享源码。整个工程：/source-share --project；指定目录：/source-share src tests README.md'};
      const issues = state.conflicts.length ? '；待合并：'+state.conflicts.join('、') : state.ready ? '' : '；存在尚未应用的版本';
      return {kind:'success',text:`本机版本 ${state.seq}，对端已持久接收 ${state.peerStored}；已收到对端版本 ${state.received}${issues}。`};
    }});
}

// Snapshot at tool boundaries, including ordinary writes from native tools. An error
// recording a result must never turn an already-executed operation into a retry.
export function registerSourceSteps(ctx, role, root, workspaceRoute) {
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session;
    if (!session?.id || !exec.callId) return next();
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(session.id));
    if (!project) return next();
    const route = await workspaceRoute(root, role, project);
    const mark = phase => sourceState(root, route, 'mark', [session.id, exec.callId, phase]);
    const before = await mark('before');
    if (!before) return next();
    if (!before.ready) throw Error('共享源码存在冲突或还没应用；这个工具尚未执行。');
    // The desktop is the volatile executor. The cloud must still be able to make
    // progress with its durable copy after the desktop loses power.
    async function confirm(snapshot) {
      if (role !== 'desktop') return;
      const deadline = Date.now() + 20000;
      let current = snapshot;
      while (current && current.peerStored < snapshot.seq && Date.now() < deadline) {
        await delay(350, undefined, {signal:exec.signal});
        current = await sourceState(root, route);
      }
      if (!current || current.peerStored < snapshot.seq) throw Error('云端尚未确认源码检查点。');
    }
    try { await confirm(before); }
    catch (err) { throw Error('云端未确认：本步工具没有执行。', {cause:err}); }
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
