import { eventSpec, placedReceipt } from './command-placement.mjs';
// A DSH model/tool result is not an external system's acknowledgement. Expose log
// references and statuses, not shell arguments, environment variables or raw output.
import { plannedRelease } from './git-release-tool.mjs';
import { releaseTool } from './git-release.mjs';
import { hash } from './log.mjs';
import { isContinuation, isDisposedTurnEnd, receipt, relayTool, singleCall, validTail } from './relay-boundary.mjs';

export const claimID = (sid, command) => hash('dsh-cloud-run/v1:' + sid + ':' + command);
const human = source => source?.kind === 'user' || source?.kind === 'retry';

// A fork can reinsert an inherited message: remember its first occurrence, just
// as the native session controller does. Never infer acceptance from message text.
export function nativeAcceptance(events, inherited, requestId, minSeq = inherited) {
  const seen = new Set();
  for (const event of events) {
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted :
      event.type === 'user/message' ? [event.data] : [];
    for (const message of messages ?? []) {
      if (typeof message.id !== 'string' || seen.has(message.id)) continue;
      seen.add(message.id);
      if (event.seq >= Math.max(inherited, minSeq) && human(message.source) && message.source.rpcId === requestId) {
        return {seq:event.seq, messageId:message.id};
      }
    }
  }
  return null;
}

// Read native receipts and the harness's synthetic interrupted-call closers. Neither
// model prose nor a nested tool-result in an ordinary user message is evidence.
function toolReceipt(event) {
  const {message:m, error} = event.data;
  const id = m?.source?.callId;
  if (event.surfaceOp !== 'append' || m?.source?.kind !== 'tool' || typeof id !== 'string') return null;
  const code = error?.code;
  if (m.role === 'tool' && m.toolCallId === id && typeof m.isError === 'boolean') return {id, code, isError:m.isError};
  if (m.role === 'user' && ['TOOL_NOT_STARTED','TOOL_OUTCOME_UNKNOWN'].includes(code) &&
      Array.isArray(m.content) && m.content.some(b => b?.type === 'tool-result' && b.toolCallId === id && b.isError === true)) {
    return {id, code, isError:true};
  }
  return null;
}

// Keys are scoped to the native step, not just the provider's reusable call id.
export function callLedger(events, start, end = events.length) {
  const entries = new Map();
  for (let i = start; i < end; i++) {
    const e = events[i], d = e.data;
    if (!d) continue;
    const {turn, step} = d;
    const key = id => JSON.stringify([turn, step, id]);
    if (e.type === 'assistant/message') {
      for (const b of d.message?.content ?? []) {
        if (b.type === 'tool-call' && !entries.has(key(b.id))) entries.set(key(b.id),
          {turn, step, name:b.name, proposalSeq:e.seq, state:'outcome-unknown'});
      }
    } else if (e.type === 'tool/call') {
      entries.set(key(d.callId), {turn, step, name:d.name, callSeq:e.seq, state:'outcome-unknown'});
    } else if (e.type === 'tool/result') {
      const r = toolReceipt(e), entry = r && entries.get(key(r.id));
      if (!entry || entry.resultSeq !== undefined) continue;
      entry.resultSeq = e.seq;
      if (r.code === 'TOOL_NOT_STARTED' && r.isError && entry.callSeq === undefined) entry.state = 'not-started';
      else if (r.code === 'TOOL_OUTCOME_UNKNOWN' || r.code === 'TOOL_NOT_STARTED' || entry.callSeq === undefined) entry.state = 'outcome-unknown';
      else entry.state = r.isError ? 'tool-error' : 'tool-returned';
    }
  }
  return entries.values();
}

function cooperativeBoundary(events, inherited, sessionId, request) {
  const callIndex = events.findLastIndex(e => e.seq < request.seq && e.type === 'tool/call' && [relayTool,'pwsh','bash'].includes(e.data.name));
  if (callIndex < inherited) return null;
  const call = events[callIndex];
  const endIndex = events.findIndex((e,i) => i > callIndex && e.type === 'turn/end');
  if (endIndex < 0 || endIndex >= request.seq || endIndex - callIndex > 16) return null;
  const tail = events.slice(callIndex + 1, endIndex + 1);
  const token = tail.find(e => e.type === 'tool/result')?.data?.message?.content?.[0]?.text;
  const shell = call.data.name !== relayTool;
  const nonce = (shell ? /DSH-PLACEMENT\/1 ([0-9a-f]{32})/ : /^DSH-RELAY\/1 ([0-9a-f]{32})$/).exec(token)?.[1];
  const boundary = shell ? 'before-shell' : undefined;
  if (!nonce || (shell ? placedReceipt(nonce) : receipt(nonce)) !== token || claimID(sessionId,nonce) !== request.data.source.rpcId ||
      !singleCall(events.slice(0,callIndex + 1),call,boundary) || !validTail({command:nonce,boundary},call,tail)) return null;
  return {endIndex, stop:callIndex, ...(shell ? {deferredCall:{...eventSpec(call),callSeq:call.seq,sourceExecution:'not-started'}} : {})};
}

export function handoffEvidence(events, inherited, sessionId, role) {
  const request = events.findLast(e => e.type === 'user/message' && human(e.data?.source));
  if (!request || request.seq < inherited || !/^[0-9a-f]{64}$/.test(request.data.source.rpcId ?? '')) return null;
  let handoff = cooperativeBoundary(events,inherited,sessionId,request);
  if (!handoff) {
    const content = request.data.content;
    if (content?.length !== 1 || content[0]?.type !== 'text' || !isContinuation(content[0].text)) return null;
    const endIndex = events.findLastIndex(e => e.seq < request.seq && e.type === 'turn/end');
    if (endIndex < inherited) return null;
    const reason = events[endIndex].data.reason?.kind;
    if (reason !== 'blocked' && reason !== 'interrupted' && !isDisposedTurnEnd(events[endIndex])) return null;
    if (events.slice(endIndex+1,request.seq).some(e => e.type === 'user/message' && human(e.data?.source))) return null;
    handoff = {endIndex, stop:endIndex, boundary:reason === 'blocked' ? 'device-switch' : 'auto-failover'};
  }
  const {endIndex, stop, ...details} = handoff;
  const accepted = nativeAcceptance(events,inherited,request.data.source.rpcId,endIndex + 1);
  if (!accepted || accepted.messageId !== request.data.id) return null;
  const original = events.findLast(e => e.seq < stop && e.type === 'user/message' && human(e.data?.source) &&
    (!details.boundary || (e.seq >= inherited && !(e.data.content?.length === 1 && isContinuation(e.data.content[0].text) && /^[a-f0-9]{64}$/.test(e.data.source.rpcId ?? '')))));
  const steps = [], releases = [];
  for (const {turn, step, name, callSeq, proposalSeq, resultSeq, state} of callLedger(events,Math.max(inherited,original?.seq ?? inherited),stop)) {
    // The cooperative boundary call is deliberately excluded; its single proposal
    // immediately precedes that call and is not a separate missing source result.
    if (!details.boundary && callSeq === undefined && resultSeq === undefined &&
        turn === events[stop].data.turn && step === events[stop].data.step && name === events[stop].data.name) continue;
    const result = resultSeq === undefined ? 'missing' : state === 'tool-returned' ? 'reported-success' : state === 'tool-error' ? 'reported-error' : state;
    steps.push({turn, step, name, ...(callSeq === undefined ? {proposalSeq} : {callSeq}), result, resultSeq});
    if (name === releaseTool && state === 'tool-returned') {
      const d = events[callSeq].data;
      try {
        const spec = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
        releases.push(plannedRelease(spec,sessionId,d.callId));
      } catch { /* Invalid plan. */ }
    }
  }
  return {from:role === 'cloud' ? 'desktop' : 'cloud', to:role, originalRequestSeq:original?.seq ?? null, ...details,
    sourceEndSeq:events[endIndex].seq, acceptanceSeq:accepted.seq, requestId:request.data.source.rpcId,
    gitReleases:releases.slice(-16), omittedGitReleases:Math.max(0,releases.length-16),
    priorCalls:steps.slice(-32), omittedCalls:Math.max(0,steps.length - 32),
    missingResults:steps.filter(s => s.result === 'missing').length, externalEffects:'not-verified'};
}
