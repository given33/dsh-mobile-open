// A DSH model/tool result is not an external system's acknowledgement. Expose log
// references and statuses, not shell arguments, environment variables or raw output.
import { hash } from './log.mjs';
import { receipt, relayTool, singleCall, validTail } from './relay-boundary.mjs';

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

export function handoffEvidence(events, inherited, sessionId, role) {
  const request = events.findLast(e => e.type === 'user/message' && human(e.data?.source));
  if (!request || request.seq < inherited || !/^[0-9a-f]{64}$/.test(request.data.source.rpcId ?? '')) return null;
  const callIndex = events.findLastIndex(e => e.seq < request.seq && e.type === 'tool/call' && e.data.name === relayTool);
  if (callIndex < inherited) return null;
  const call = events[callIndex];
  const endIndex = events.findIndex((e,i) => i > callIndex && e.type === 'turn/end');
  if (endIndex < 0 || endIndex >= request.seq || endIndex - callIndex > 16) return null;
  const tail = events.slice(callIndex + 1, endIndex + 1);
  const token = tail.find(e => e.type === 'tool/result')?.data?.message?.content?.[0]?.text;
  const nonce = /^DSH-RELAY\/1 ([0-9a-f]{32})$/.exec(token)?.[1];
  if (!nonce || receipt(nonce) !== token || claimID(sessionId,nonce) !== request.data.source.rpcId ||
      !singleCall(events.slice(0,callIndex + 1),call) || !validTail({command:nonce},call,tail)) return null;
  const accepted = nativeAcceptance(events,inherited,request.data.source.rpcId,endIndex + 1);
  if (accepted?.messageId !== request.data.id) return null;

  const original = events.findLast(e => e.seq < call.seq && e.type === 'user/message' && human(e.data?.source));
  const completed = new Map();
  const steps = [];
  for (let i = Math.max(inherited, original?.seq ?? inherited); i < callIndex; i++) {
    const e = events[i], d = e.data;
    if (e.type === 'tool/call') {
      const entry = {callSeq:e.seq, name:d.name, turn:d.turn, step:d.step, result:'missing'};
      steps.push(entry);
      completed.set(JSON.stringify([d.turn,d.step,d.callId]),entry);
    } else if (e.type === 'tool/result') {
      const entry = completed.get(JSON.stringify([d.turn,d.step,d.message?.toolCallId]));
      if (entry && typeof d.message?.isError === 'boolean') {
        entry.resultSeq = e.seq;
        entry.result = d.message.isError ? 'reported-error' : 'reported-success';
      }
    }
  }
  return {from:role === 'cloud' ? 'desktop' : 'cloud', to:role, originalRequestSeq:original?.seq ?? null,
    sourceEndSeq:events[endIndex].seq, acceptanceSeq:accepted.seq, requestId:request.data.source.rpcId,
    priorCalls:steps.slice(-32), omittedCalls:Math.max(0,steps.length - 32),
    missingResults:steps.filter(s => s.result === 'missing').length, externalEffects:'not-verified'};
}
