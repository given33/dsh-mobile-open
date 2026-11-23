// This is an explicit, single-destination command, NOT a trigger inferred from imported history.
// A normal sync packet (even one containing /cloud-run in its log) cannot enqueue work.
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { committedLength, hash, pack, validID } from './log.mjs';

const name = 'cloud-run';
const maxAge = 15 * 60_000;
const textLimit = 16 * 1024;
export const claimID = (sid, command) => hash('dsh-cloud-run/v1:' + sid + ':' + command);

export async function workspaceRoute(root, role, project) {
  if (dirname(resolve(project.path)) === resolve(root, 'workspaces')) {
    const file = join(root, 'routes', basename(project.path) + '.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    return {...saved, title:project.title.slice(0,256)};
  }
  return {owner:role, key:project.id, title:project.title.slice(0,256)};
}

export function registerCloudRun(ctx, root) {
  const prepared = new Map();
  const ownerCalls = new WeakSet();
  const finalizedCalls = new WeakSet();
  // The heavy prefix is compressed BEFORE returning from the command. Completing the
  // immutable input only appends the small native command/done record. A clean UI exit
  // need not wait for the next live snapshot or for the network to be available.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'command/done') return;
    const ticket = prepared.get(event.data.commandId);
    if (!ticket || ticket.sid !== session.id) return;
    prepared.delete(event.data.commandId);
    if (event.data.kind !== 'success' || event.seq !== ticket.seq) return;
    appendFileSync(ticket.tmp, JSON.stringify(event) + '}', {flush:true});
    renameSync(ticket.tmp, ticket.ready);
    finalizedCalls.add(ticket.signal);
  });
  ctx.commands.register({
    definitionId: 'dsh-mobile-link/cloud-run', name,
    description: '在当前会话提交由云端独立执行的新任务', input: {hint: '<任务内容>'},
    async handler({agent, commandId, rawInput, signal}) {
      const principal = ctx.invocation?.peer?.principal;
      if (!ownerCalls.has(signal) && principal?.kind !== 'owner') return {kind:'error', text:'请在桌面「手机连接 → 本会话云端执行」提交。'};
      const sid = agent.session.id, text = rawInput.trim();
      if (!text || Buffer.byteLength(text) > textLimit) return {kind:'error', text:'请输入任务内容，最多 16 KiB。'};
      if (!validID(sid) || !validID(commandId) || agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
        return {kind:'error', text:'请等待当前步骤结束；不会在云端重跑本机正在执行的命令。'};
      }
      // Only a live, successful human command on the desktop mints this intent. Its separate
      // command/done in the native session is also required before the peer can act.
      const intent = {v:1, session:sid, command:commandId, created:Date.now()};
      const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(sid));
      if (!project || ctx.workspaceRegistry.archivedSessionIds.includes(sid)) return {kind:'error',text:'工作区不存在或会话已归档。'};
      const session = agent.session;
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(sid,'read',{signal});
      let packet, seq;
      try {
        const events = (await reader.read()).events;
        const last = events.at(-1);
        if (last?.type !== 'command/run' || last.data.commandId !== commandId || committedLength(events) !== events.length) {
          return {kind:'error',text:'会话状态已更改，未提交云端任务。'};
        }
        seq = events.length;
        packet = await pack('desktop', await workspaceRoute(root,'desktop',project), reader.header, reader.inheritedEventCount, false, events);
      } finally { await reader.close(); }
      const dirQueue = join(root,'cloud-outgoing');
      await mkdir(dirQueue, {recursive:true,mode:0o700});
      const ready = join(dirQueue, claimID(sid,commandId) + '.json');
      const staging = join(dirQueue, hash(sid+':'+commandId) + '.tmp');
      packet.cloudIntent = intent;
      const prefix = JSON.stringify(packet).slice(0,-1) + ',"commandEnd":';
      if (Buffer.byteLength(prefix) + 4096 > 32*1024*1024) return {kind:'error',text:'会话太大，未提交云端任务。'};
      await writeFile(staging, prefix, {mode:0o600,flush:true});
      signal.throwIfAborted();
      if (session.seq !== seq) return {kind:'error',text:'会话同时发生了变化，未提交云端任务。'};
      prepared.set(commandId, {sid, seq, tmp:staging, ready, signal});
      return {kind:'success', text:'已在本机登记。在手机云端看到本轮开始后，即可退出或关闭电脑。'};
    },
  });
  return async (sid, text, signal) => {
    if (!validID(sid) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > textLimit ||
        !ctx.workspaceRegistry.list().some(w => w.sessionIds.includes(sid))) throw Error('Invalid cloud task');
    const resolved = await ctx.sessionController.resolveAgent(sid);
    if (!resolved.agent) throw Error('Native session is unavailable');
    ownerCalls.add(signal);
    try {
      const execution = await ctx.commands.execute(resolved.agent, '/cloud-run ' + text, [], signal);
      if (execution?.result.kind === 'success' && !finalizedCalls.has(signal)) throw Error('Cloud request not staged');
      return execution?.result;
    } finally { ownerCalls.delete(signal); }
  };
}

export function submittedText(intent, sid, events, now = Date.now()) {
  if (intent?.v !== 1 || intent.session !== sid || !validID(intent.command) || !Number.isSafeInteger(intent.created) ||
      intent.created > now + 60000 || now - intent.created > maxAge) return;
  const done = events.at(-1), run = events.at(-2);
  if (done?.type !== 'command/done' || done.data?.kind !== 'success' || done.data.commandId !== intent.command ||
      run?.type !== 'command/run' || run.data?.commandId !== intent.command || run.data.name !== name ||
      run.data.source?.kind !== 'user' || typeof run.data.args !== 'string') return;
  const text = run.data.args.trim();
  if (text && Buffer.byteLength(text) <= textLimit) return text;
}

export async function admitCloudTurn(ctx, root, packet, history, signal) {
  const sid = packet.source;
  const text = submittedText(packet.cloudIntent, sid, history);
  if (!text || packet.archived || ctx.workspaceRegistry.archivedSessionIds.includes(sid)) return;
  const controller = ctx.get?.('sessionController');
  if (!controller) throw Error('Cloud session controller unavailable');
  const key = claimID(sid,packet.cloudIntent.command);
  const dir = join(root, 'cloud-claims');
  await mkdir(dir, {recursive:true, mode:0o700});
  let claim;
  try { claim = await open(join(dir,key), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    // Persist ownership BEFORE submitting. On ambiguous failure (including lost power on the
    // cloud), retain the claim; never replay a potentially side-effecting native turn.
    await claim.writeFile('claimed\n');
    await claim.sync();
    if (process.platform !== 'win32') {
      const handle = await open(dir, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    signal.throwIfAborted();
    const result = await controller.prompt({sessionId:sid, requestId:key, mode:'queue', content:[{type:'text', text}]}, signal);
    if (!result.accepted) throw Error('Cloud DSH did not accept the task');
    await claim.writeFile('accepted\n');
    await claim.sync();
  } finally { await claim.close(); }
}
