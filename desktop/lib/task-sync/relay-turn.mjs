import { commandSpec, eventSpec, placedOnPeer, placedReceipt, stoppedValue } from './command-placement.mjs';
import { isDeepStrictEqual } from 'node:util';
import { authorizeResults } from './relay-results.mjs';
import { collectInputs } from './relay-inputs.mjs';
import { appendFileSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claimID, workspaceRoute } from './cloud-turn.mjs';
import { maxPacket, pack, validID } from './log.mjs';
import { noArgs, textOutput } from './relay-environment.mjs';
import { continuation, receipt, relayTool, singleCall, validTail, passiveDelivery } from './relay-boundary.mjs';

export function registerTurnRelay(ctx,role,root) {
  const pending = new Map();
  const dir = join(root,'relay-outgoing');
  function discard(ticket) {
    pending.delete(ticket.intent.session);
    try { unlinkSync(ticket.tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  ctx.effect(() => () => { for (const ticket of pending.values()) discard(ticket); });
  ctx.on('session/event',(session,event) => {
    const t = pending.get(session.id);
    if (!t) return;
    // Steering, another call, an interrupted turn or any unexpected log suffix revokes the offer.
    const expected = ['tool/result','step/end','turn/end'][t.tail.filter(e=>!passiveDelivery(e)).length];
    if (t.tail.length >= 16 || (!passiveDelivery(event) && event.type !== expected) || event.seq !== t.call.seq + 1 + t.tail.length) return discard(t);
    t.tail.push(event);
    if (event.type !== 'turn/end') return;
    if (!validTail(t.intent,t.call,t.tail)) return discard(t);
    pending.delete(session.id);
    appendFileSync(t.tmp,JSON.stringify(t.tail)+'}',{flush:true});
    renameSync(t.tmp,t.ready);
    if (process.platform !== 'win32') {
      const fd = openSync(dir,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  });
  async function stage(exec, spec, cwd) {
    const boundary = spec ? 'before-shell' : undefined;
    const agent = exec.agent, session = agent?.session;
    if (!validID(session?.id) || !validID(exec.callId) || exec.parent || (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) || pending.has(session.id)) throw Error('当前不是可接力的独立步骤。');
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(session.id));
    if (!project || ctx.workspaceRegistry.archivedSessionIds.includes(session.id)) throw Error('会话不在活动工作区。');
    const jobs = ctx.get('jobs')?.list(session.id) || [];
    if (jobs.some(job=>['running','stopping'].includes(job.status))) throw Error('当前仍有运行中的后台任务，未转移执行权。');
    await ctx.sessions.flush(session);
    const reader = await ctx.sessionPersistence.open(session.id,'read',{signal:exec.signal});
    let call, packet;
    try {
      const {events} = await reader.read(); call = events.at(-1);
      if (call?.data?.callId !== exec.callId || !singleCall(events,call,boundary) || (spec && !isDeepStrictEqual(eventSpec(call), spec))) throw Error('接力工具必须单独调用。');
      const lastUser = events.findLast(e => e.type === 'user/message' && e.data?.source?.kind === 'user');
      if (!lastUser || lastUser.data.content?.some(b=>b.type === 'text' && b.text === continuation)) throw Error('不能将自动接力任务立即转回。');
      const route = await workspaceRoute(root,role,project);
      if (spec && route.owner !== role) throw Error('只允许从原工作区安排执行位置。');
      packet = await pack(role,route,reader.header,reader.inheritedEventCount,false,events);
      packet.relayInputs = await collectInputs(root,route,project.path);
    } finally { await reader.close(); }
    const sandbox = ctx.get('sandboxPolicy')?.resolve({session}).mode;
    const approval = ctx.get('approval');
    if (!['read-only','workspace-write','danger-full-access'].includes(sandbox) || !approval) throw Error('无法核实源端权限。');
    const security = {sandbox,approval:approval.overrideOf(session) ?? approval.config.policy ?? 'ask'};
    const intent = {v:2,...(boundary ? {boundary} : {}),security,session:session.id,from:role,command:randomUUID().replaceAll('-',''),created:Date.now()};
    const value = spec && stoppedValue(intent.command, cwd, spec.timeoutMs);
    if (spec) {
      const output = ctx.tools.get(exec.name,agent,exec.toolSet)?.output;
      const rendered = output?.render(exec.arguments,value);
      if (rendered?.length !== 1 || rendered[0].type !== 'text' || rendered[0].text !== placedReceipt(intent.command)) throw Error('当前终端版本不支持接力回执；本机没有启动命令。');
    }
    const key = claimID(session.id,intent.command);
    packet.relayOutputs = await authorizeResults(root,role,project,packet.workspace,sandbox,session.id,key);
    const prefix = JSON.stringify({...packet,cloudIntent:intent}).slice(0,-1)+',"relayEnd":';
    if (Buffer.byteLength(prefix)+8192 > maxPacket) throw Error('会话超过接力包大小上限。');
    await mkdir(dir,{recursive:true,mode:0o700});
    const t = {intent,call,tail:[],tmp:join(dir,key+'.tmp'),ready:join(dir,key+'.json')};
    await writeFile(t.tmp,prefix,{mode:0o600,flag:'wx',flush:true});
    if (exec.signal.aborted || session.seq !== call.seq+1 || (agent.inbox.nextStep.length || agent.inbox.nextTurn.length)) { discard(t); throw Error('会话状态已变化，未转交。'); }
    pending.set(session.id,t);
    exec.concludeTurn();
    return spec ? value : receipt(intent.command);
  }
  ctx.tools.register({name:relayTool, parameters:noArgs, output:textOutput,
    description:'Yield the rest of the current user task to the paired host BEFORE starting the next operation. Call alone, not in parallel with any tool. No running process is migrated. Keep the same workspace and approvals; do not hand off a received handoff again.',
    execute:(_args,exec) => stage(exec)});

  // Around-dispatch runs after native pre-execute approval and guards. Only the
  // unmatched branch calls next(); after selecting the peer, no failure (even a
  // lost transfer acknowledgement) can fall through and run the source command.
  ctx.on('tools/execute', async (exec,next) => {
    const spec = commandSpec(exec.name,exec.arguments), agent = exec.agent;
    if (!spec || exec.parent || !agent?.session) return next();
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(agent.session.id));
    if (!project || !await placedOnPeer(root,role,project.id,spec,agent.session.id)) return next();
    const output = ctx.tools.get(exec.name,agent,exec.toolSet)?.output;
    if (!output?.schema?.oneOf?.some(s => s.properties?.kind?.const === 'foreground')) {
      throw Error('本机终端不支持接力回执；未启动命令。');
    }
    const cwd = await ctx.workingDirectory.ensure(agent,exec.signal);
    if (resolve(cwd) !== resolve(project.path)) throw Error('接力命令的当前目录不是配置的工作区根目录；两端均未启动。');
    const value = await stage(exec,spec,cwd);
    return {value,isError:false};
  });
}
