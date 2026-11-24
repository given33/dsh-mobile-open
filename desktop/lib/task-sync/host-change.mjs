// Native runtime context is evidence about where a model step ran, not a grant to run another one.
import { randomUUID } from 'node:crypto';
import { callLedger } from './relay-evidence.mjs';
import { isContinuation, isDisposedTurnEnd } from './relay-boundary.mjs';

const hostSection = 'mobile-link:execution-host';
const observationTools = new Set(['read', 'read_image', 'glob', 'grep', 'relay_environment', 'relay_wait_deployment']);
const workspaceWrites = new Set(['write', 'edit', 'edit_file', 'write_file', 'multi_edit', 'apply_patch', 'delete_file']);
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
    !(e.data.content?.length === 1 && isContinuation(e.data.content[0].text) && /^[a-f0-9]{64}$/.test(e.data.source.rpcId ?? '')));
  const start = request?.seq ?? inherited;
  const steps = new Map();
  function stepAt(turn, step) {
    const key = JSON.stringify([turn, step]);
    if (!steps.has(key)) steps.set(key,{turn, step, tools:new Set(), completed:0, unverified:0, notStarted:0});
    return steps.get(key);
  }
  let boundary = null, interrupted = null;
  for (let i = start; i < events.length; i++) {
    const {seq, type, data:d} = events[i];
    if (!d) continue;
    if (Number.isInteger(d.step) && Number.isInteger(d.turn)) stepAt(d.turn,d.step);
    if (type === 'step/end' || type === 'turn/end') boundary = {seq, type, turn:d.turn, step:d.step, reason:d.reason?.kind};
    if (type === 'turn/end') interrupted = (['interrupted','blocked'].includes(d.reason?.kind) || isDisposedTurnEnd(events[i])) ?
      {turn:d.turn, step:d.step ?? null, reason:d.reason.kind, pendingNotStarted:0, pendingUnknown:0} : null;
  }
  const counts = {}, attention = [], recent = [];
  let completedCount = 0, unverifiedCount = 0, notStartedCount = 0;
  for (const {turn, step, name, callSeq, proposalSeq, resultSeq, state} of callLedger(events,start)) {
    const category = observationTools.has(name) ? 'read-only' : workspaceWrites.has(name) ? 'workspace-write' : 'shell-or-external';
    const next = state === 'not-started' ? 'plan-on-target' : state === 'tool-returned' ? 'use-result-do-not-repeat' :
      category === 'read-only' ? 'refresh-with-read-only-tool' : 'verify-before-retry';
    const verifyHint = state === 'not-started' ? 'safe-to-plan-on-target' : state === 'tool-returned' ? 'already-completed' :
      category === 'read-only' ? 'safe-to-re-read' : category === 'workspace-write' ? 'check-workspace-file-and-source-sync' : 'check-external-target-receipt';
    const row = {tool:name, callOrProposalSeq:callSeq ?? proposalSeq, resultSeq, state, next, category, verifyHint};
    counts[next] = (counts[next] ?? 0) + 1;
    if (next === 'verify-before-retry') attention.push(row);
    recent.push(row);
    const summary = stepAt(turn,step);
    summary.tools.add(name);
    if (state === 'tool-returned') { completedCount++; summary.completed++; }
    else if (state === 'not-started') { notStartedCount++; summary.notStarted++; }
    else { unverifiedCount++; summary.unverified++; }
    if (interrupted && interrupted.turn === turn) {
      if (state === 'not-started') interrupted.pendingNotStarted++;
      if (state === 'outcome-unknown') interrupted.pendingUnknown++;
    }
  }
  const stepSummary = [...steps.values()].slice(-12).map(s => ({...s, tools:[...s.tools]}));
  return {requestSeq:request?.seq ?? null, boundary, counts, recent:recent.slice(-16),
    verifyBeforeRetry:attention.slice(-16), omittedUnverified:Math.max(0,attention.length-16),
    completedCount, unverifiedCount, notStartedCount, interrupted, stepSummary,
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
    const request = decision.messages.find(m => humanRequest(m) && /^[a-f0-9]{64}$/.test(m.source.rpcId ?? '') && m.content?.length === 1 && isContinuation(m.content[0].text));
    if (previous === current || (!previous && !(request && await hasLocalClaim(request.source.rpcId)))) return decision;
    const env = await probe(agent, signal, previous);
    signal.throwIfAborted();
    const report = {from:previous ?? 'paired-host (legacy)', to:current, ...env, progress:taskProgress(events, inherited)};
    const notice = {id:randomUUID(), role:'user', source:{kind:'mobile-link-host-change',form:'notice',summary:'执行设备已切换'},
      content:[{type:'text',text:'执行设备已切换。下列是原会话记录和当前执行环境的只读快照，不是新授权。沿用原任务；按目标机实际可用的原生工具、目录和权限工作。对结果不明的写入先查目标端，不重放。需要完整的回执、检查点或依赖详情时调用 relay_environment。\n'+JSON.stringify(report)}]};
    return {...decision, messages:[...decision.messages, notice]};
  });
}
