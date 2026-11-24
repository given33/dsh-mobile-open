import { eventSpec, placedReceipt } from './command-placement.mjs';
// A DSH model/tool result is not an external system's acknowledgement. Expose log
// references and statuses, not shell arguments, environment variables or raw output.
import { plannedRelease } from './git-release-tool.mjs';
import { releaseTool } from './git-release.mjs';
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
  const accepted = nativeAcceptance(events,inherited,request.data.source.rpcId,endIndex + 1);
  if (accepted?.messageId !== request.data.id) return null;

  const original = events.findLast(e => e.seq < call.seq && e.type === 'user/message' && human(e.data?.source));
  const completed = new Map();
  const steps = [];
  const releases = [];
  const pendingReleases = new Map();
  for (let i = Math.max(inherited, original?.seq ?? inherited); i < callIndex; i++) {
    const e = events[i], d = e.data;
    if (e.type === 'tool/call') {
      const entry = {callSeq:e.seq, name:d.name, turn:d.turn, step:d.step, result:'missing'};
      const key = JSON.stringify([d.turn,d.step,d.callId]);
      if (d.name === releaseTool) {
        // Only a successful planner call carries structured intent. Never parse
        // free-form shell lines or tool output as a deployment receipt.
        try {
          const spec = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
          pendingReleases.set(key,plannedRelease(spec,sessionId,d.callId));
        } catch { /* Invalid plan. */ }
      }
      steps.push(entry);
      completed.set(key,entry);
    } else if (e.type === 'tool/result') {
      const key = JSON.stringify([d.turn,d.step,d.message?.toolCallId]);
      const entry = completed.get(key);
      if (entry && typeof d.message?.isError === 'boolean') {
        entry.resultSeq = e.seq;
        entry.result = d.message.isError ? 'reported-error' : 'reported-success';
        if (!d.message.isError && pendingReleases.has(key)) releases.push(pendingReleases.get(key));
        pendingReleases.delete(key);
      }
    }
  }
  return {from:role === 'cloud' ? 'desktop' : 'cloud', to:role, originalRequestSeq:original?.seq ?? null,
    ...(shell ? {deferredCall:{...eventSpec(call),callSeq:call.seq,sourceExecution:'not-started'}} : {}),
    sourceEndSeq:events[endIndex].seq, acceptanceSeq:accepted.seq, requestId:request.data.source.rpcId,
    gitReleases:releases.slice(-16), omittedGitReleases:Math.max(0,releases.length-16),
    priorCalls:steps.slice(-32), omittedCalls:Math.max(0,steps.length - 32),
    missingResults:steps.filter(s => s.result === 'missing').length, externalEffects:'not-verified'};
}
