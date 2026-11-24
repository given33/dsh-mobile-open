// A device selection is a request to yield the current turn, not permission to replay it.
// Only the protected queue can start the peer. Passive copies and UI state never can.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { claimID, dispatchState, workspaceRoute } from './cloud-turn.mjs';
import { hash, maxPacket, pack, validID } from './log.mjs';
import { collectInputs } from './relay-inputs.mjs';
import { authorizeResults } from './relay-results.mjs';
import { sealSource } from './source-state.mjs';
import { continuation, passiveDelivery, switchBoundary } from './relay-boundary.mjs';
import { readHistory, taskProgress } from './host-change.mjs';

function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function registerDeviceSwitch(ctx, role, root) {
  const dir = join(root, 'device-switches'), out = join(root, 'relay-outgoing');
  const staged = new Map();
  const path = id => join(dir, hash(id) + '.json');
  function read(id) {
    try { return JSON.parse(readFileSync(path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function save(record, state, message) {
    mkdirSync(dir, {recursive:true, mode:0o700});
    const updated = {...record, state, message}, filename = path(record.session);
    writeFileSync(filename + '.tmp', JSON.stringify(updated), {mode:0o600, flush:true});
    renameSync(filename + '.tmp', filename); syncDirectory(dir);
    return updated;
  }
  async function request({sessionId, target, command, expectedRunning}) {
    if (!validID(sessionId) || !/^[a-f0-9]{32}$/.test(command) || target !== (role === 'cloud' ? 'desktop' : 'cloud')) throw Error('目标设备或会话不正确。');
    if (!ctx.workspaceRegistry.list().some(p => p.sessionIds.includes(sessionId)) || ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) throw Error('当前会话不是活动工作区的会话。');
    // Streaming can append provider delivery records during a disk read. Re-read rather
    // than asking the phone to tap twice. Admission independently rechecks the exact turn.
    let agent, events;
    for (let attempt = 0; ; attempt++) {
      agent = ctx.agents.get(sessionId);
      events = await readHistory(ctx,sessionId,agent?.session);
      const resident = ctx.agents.get(sessionId);
      if ((!agent && !resident) || (agent && resident && resident.session.seq === events.length)) break;
      if (attempt === 5) throw Error('当前会话正在快速变更，请稍后再试。');
      await delay(40);
    }
    const old = read(sessionId);
    const start = events.findLast(e => e.type === 'turn/start');
    const active = agent?.status === 'running' && start && !events.slice(start.seq + 1).some(e => e.type === 'turn/end');
    if (old && (old.command === command || (['requested','sealing','yielded'].includes(old.state) && (!start || old.start === start.seq)))) return old;
    if (!active && start && !events.slice(start.seq+1).some(e=>e.type === 'turn/end')) throw Error('上一轮没有结束回执，不能当作空闲会话切换。');
    if (!active) {
      if (expectedRunning && !events.some(e => e.type === 'turn/end' && e.data?.turn === start?.data.turn && e.data.reason?.kind === 'completed')) throw Error('原设备尚未确认任务状态，未启动第二份任务。');
      if (agent && (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)) throw Error('会话正在排队，暂不能交接。');
      return {state:'idle'};
    }
    return save({session:sessionId, turn:start.data.turn, start:start.seq, command}, 'requested');
  }
  async function status({sessionId, command}) {
    if (sessionId === undefined && command === undefined) return {role, protocol:1};
    if (!validID(sessionId) || !/^[a-f0-9]{32}$/.test(command)) throw Error('无效接力凭据。');
    const local = read(sessionId);
    if (local?.command === command) return local;
    const key = claimID(sessionId, command), state = await dispatchState(root,key);
    return {state:state === 'ready' && existsSync(join(root,'relay-incoming',key+'.json')) ? 'received' : state};
  }
  // Prepare at a native pre-step AFTER the previous tool batch has settled. The framework
  // emits turn/end(blocked) itself when we reject. No model cooperation or fake event needed.
  ctx.on('agent/pre-step', async ({agent, turn, step, signal, messages}, next) => {
    const session = agent.session, record = read(session.id);
    if (['sealing','yielded'].includes(record?.state) && step === 1) {
      // A new message on the old host cannot fork a surrendered task. Only an admitted
      // return transfer or a mirrored terminal result for that specific claim releases it.
      const localReturn = messages.find(m => m.source?.kind === 'user' && /^[a-f0-9]{64}$/.test(m.source.rpcId ?? '') && m.content?.[0]?.text === continuation);
      const events = await readHistory(ctx,session.id,session,signal), key = claimID(session.id,record.command);
      const original = events.findLast(e => e.seq > record.start && e.type === 'user/message' && e.data?.source?.rpcId === key);
      const finished = original && events.slice(original.seq+1).some(e => e.type === 'turn/end');
      if (!finished && !(localReturn && await dispatchState(root,localReturn.source.rpcId) !== 'ready')) return {kind:'reject'};
      save(record,'finished');
    }
    if (record?.state !== 'requested' || turn !== record.turn || step <= 1) return next();
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    try {
      const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(session.id));
      const idle = () => !messages.length && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length &&
        !ctx.get('jobs')?.list(session.id).some(j => ['running','stopping'].includes(j.status)) &&
        !ctx.agents.list().some(child => {
          const seen = new Set();
          for (let a = child; child.status === 'running' && a?.session.header.origin === 'subagent' && !seen.has(a); a = ctx.agents.get(a.session.header.parentSession)) {
            if (a.session.header.parentSession === session.id) return true;
            seen.add(a);
          }
          return false;
        });
      if (!project || ctx.workspaceRegistry.archivedSessionIds.includes(session.id) || !idle()) throw Error('仍有排队消息或后台任务，原设备继续执行。');
      const sandbox = ctx.get('sandboxPolicy')?.resolve({session}).mode, approval = ctx.get('approval');
      if (!['read-only','workspace-write','danger-full-access'].includes(sandbox) || !approval) throw Error('无法核实原会话权限。');
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(session.id,'read',{signal});
      let packet, last;
      const intent = {v:2, boundary:'device-switch', session:session.id, command:record.command, from:role, created:Date.now(),
        security:{sandbox, approval:approval.overrideOf(session) ?? approval.config.policy ?? 'ask'}};
      try {
        const {events} = await reader.read(); last = events.at(-1);
        if (!switchBoundary(events, turn, step-1) || events.findLast(e=>e.type === 'turn/start')?.seq !== record.start) throw Error('尚无完整的工具步骤边界。');
        if (taskProgress(events,reader.inheritedEventCount).verifyBeforeRetry.length) throw Error('前序操作结果不明，请先核查；原设备继续执行。');
        const route = await workspaceRoute(root,role,project);
        packet = await pack(role,route,reader.header,reader.inheritedEventCount,false,events);
        packet.relayInputs = await collectInputs(root,route,project.path);
      } finally { await reader.close(); }
      await sealSource(root,packet);
      if (!packet.sourceFence) throw Error('此工作区尚未登记源码同步，请先用 /source-share 授权要接力的目录。');
      const key = claimID(session.id,record.command);
      packet.relayOutputs = await authorizeResults(root,role,project,packet.workspace,sandbox,session.id,key);
      const prefix = JSON.stringify({...packet,cloudIntent:intent}).slice(0,-1) + ',"relayEnd":';
      if (Buffer.byteLength(prefix) + 8192 > maxPacket) throw Error('会话超过接力包限制。');
      signal.throwIfAborted();
      if (session.seq !== last.seq+1 || !idle()) throw Error('原会话状态已变化，未转交。');
      mkdirSync(out,{recursive:true,mode:0o700});
      const tmp = join(out,key+'.switch-tmp');
      writeFileSync(tmp,prefix,{flag:'wx',mode:0o600,flush:true});
      save(record,'sealing'); // Persist the source fence BEFORE the peer can see a runnable packet.
      staged.set(session.id,{tmp, ready:join(out,key+'.json'), seq:last.seq, record, tail:[]});
      return {kind:'reject'};
    } catch (error) { save(record,'failed',error.message); return decision; }
  });
  ctx.on('session/event',(session,event) => {
    const ticket = staged.get(session.id);
    if (ticket) {
      const {seq,tail,record,tmp,ready} = ticket;
      const expected = event.seq === seq+tail.length+1 && tail.length < 16;
      if (expected && passiveDelivery(event)) { tail.push(event); return; }
      staged.delete(session.id);
      if (expected && event.type === 'turn/end' && event.data.turn === record.turn && event.data.reason?.kind === 'blocked') {
        const fd = openSync(tmp,'a');
        try { writeFileSync(fd,JSON.stringify([...tail,event])+'}'); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp,ready); syncDirectory(out); save(record,'yielded');
      } else { if (existsSync(tmp)) unlinkSync(tmp); save(record,'failed','交接日志发生变化，未授权目标端执行。'); }
    } else if (event.type === 'turn/end') {
      const record = read(session.id);
      if (record?.state === 'requested' && record.turn === event.data.turn) {
        const done = event.data.reason?.kind === 'completed';
        save(record,done ? 'finished' : 'failed',done ? undefined : '原任务未正常结束，不自动重试。');
      }
    }
  });
  return {request,status};
}
