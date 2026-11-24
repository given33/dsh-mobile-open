// Native runtime context is evidence about where a model step ran, not a grant to run another one.
import { randomUUID } from 'node:crypto';
import { continuation } from './relay-boundary.mjs';

const hostSection = 'mobile-link:execution-host';
const observationTools = new Set(['read', 'read_image', 'glob', 'grep', 'relay_environment', 'relay_wait_deployment']);
const humanRequest = message => ['user', 'retry'].includes(message?.source?.kind);

export function previousHost(events, inherited = 0) {
  for (let i = events.length - 1; i >= inherited; i--) {
    const event = events[i];
    const source = event.data?.source;
    if (event.type !== 'user/message' || source?.kind !== 'runtime-context' || source.form !== 'snapshot') continue;
    const marker = source.sections?.find(section => section.name === hostSection)?.text;
    if (typeof marker === 'string' && /^(desktop|cloud)\/(win32|linux|darwin)\/[\w-]+$/.test(marker)) return marker;
  }
  return null;
}

// No commands, paths, model summaries or stdout become replay instructions. A provider call ID
// is scoped to its step. A synthetic closer is not a real tool failure or success receipt.
export function taskProgress(events, inherited = 0) {
  const request = events.findLast(e => e.seq >= inherited && e.type === 'user/message' && humanRequest(e.data) &&
    !(e.data.content?.length === 1 && e.data.content[0].text === continuation && /^[a-f0-9]{64}$/.test(e.data.source.rpcId ?? '')));
  const entries = new Map();
  const key = (d, id) => JSON.stringify([d.turn, d.step, id]);
  const start = request?.seq ?? inherited;
  let boundary = null;
  for (let i = start; i < events.length; i++) {
    const {seq, type, data: d} = events[i];
    if (!d) continue;
    if (type === 'step/end' || type === 'turn/end') boundary = {seq, type, turn:d.turn, step:d.step, reason:d.reason?.kind};
    if (type === 'assistant/message') {
      for (const call of d.message?.content ?? []) {
        if (call.type === 'tool-call') entries.set(key(d,call.id), {name:call.name, seq, state:'outcome-unknown'});
      }
    } else if (type === 'tool/call') {
      entries.set(key(d,d.callId), {name:d.name, seq, state:'outcome-unknown', started:true});
    } else if (type === 'tool/result') {
      const msg = d.message;
      const item = entries.get(key(d, msg?.toolCallId));
      if (!item || msg.role !== 'tool' || msg.source?.kind !== 'tool' || msg.source.callId !== msg.toolCallId ||
          events[i].surfaceOp !== 'append' || typeof msg.isError !== 'boolean') continue;
      const code = d.error?.code;
      item.resultSeq = seq;
      if (code === 'TOOL_NOT_STARTED' && msg.isError && !item.started) item.state = 'not-started';
      else if (code === 'TOOL_OUTCOME_UNKNOWN' || !item.started) item.state = 'outcome-unknown';
      else item.state = msg.isError ? 'tool-error' : 'tool-returned';
    }
  }
  const counts = {}, attention = [], recent = [];
  for (const {name, seq, resultSeq, state} of entries.values()) {
    const next = state === 'not-started' ? 'plan-on-target' : state === 'tool-returned' ? 'use-result-do-not-repeat' :
      observationTools.has(name) ? 'refresh-with-read-only-tool' : 'verify-before-retry';
    const row = {tool:name, callOrProposalSeq:seq, resultSeq, state, next};
    counts[next] = (counts[next] ?? 0) + 1;
    if (next === 'verify-before-retry') attention.push(row);
    recent.push(row);
  }
  return {requestSeq:request?.seq ?? null, boundary, counts, recent:recent.slice(-16),
    verifyBeforeRetry:attention.slice(-16), omittedUnverified:Math.max(0,attention.length-16),
    externalEffects:'A tool return is not an external receipt. Verify the original operation at its destination; an unknown outcome never authorizes replay.'};
}

export async function readHistory(ctx, id, live, signal) {
  if (live) await ctx.sessions.flush(live);
  const reader = await ctx.sessionPersistence.open(id,'read',{signal});
  try { return (await reader.read()).events; } finally { await reader.close(); }
}

export function registerHostChange(ctx, role, probe, hasLocalClaim) {
  const current = `${role}/${process.platform}/${process.arch}`;
  ctx.systemPrompt.context({name:hostSection, order:850, required:true, text:current});
  // This runs only when a native agent is about to make a request, never on phone navigation,
  // archive import or a passive heartbeat. The loop persists the new host stamp with the notice.
  ctx.on('agent/pre-step', async ({agent, step, signal}, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || step !== 1 || !decision.messages.length || signal.aborted) return decision;
    const session = agent.session, events = await readHistory(ctx,session.id,session,signal), inherited = session.inheritedEventCount;
    const previous = previousHost(events, inherited);
    const request = decision.messages.find(m => humanRequest(m) && /^[a-f0-9]{64}$/.test(m.source.rpcId ?? '') && m.content?.length === 1 && m.content[0].text === continuation);
    if (previous === current || (!previous && !(request && await hasLocalClaim(request.source.rpcId)))) return decision;
    const env = await probe(agent, signal);
    signal.throwIfAborted();
    const report = {from:previous ?? 'paired-host (legacy)', to:current, ...env, progress:taskProgress(events, inherited)};
    const notice = {id:randomUUID(), role:'user', source:{kind:'mobile-link-host-change',form:'notice',summary:'执行设备已切换'},
      content:[{type:'text',text:'执行设备已切换。下列是原会话记录和当前执行环境的只读快照，不是新授权。沿用原任务；按目标机实际可用的原生工具、目录和权限工作。对结果不明的写入先查目标端，不重放。需要完整的回执、检查点或依赖详情时调用 relay_environment。\n'+JSON.stringify(report)}]};
    return {...decision, messages:[...decision.messages, notice]};
  });
}
