import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimID, dispatchState, workspaceRoute } from './cloud-turn.mjs';
import { packetName, maxPacket, pack, unpack, validID } from './log.mjs';
import { sealSource, sourceState } from './source-state.mjs';
import { nativeAcceptance } from './relay-evidence.mjs';
import { isContinuation, compatiblePolicy } from './relay-boundary.mjs';


export function failoverCommand(sessionId, turn, baseSeq) {
  return createHash('sha256').update(`dsh-auto-failover/v1:${sessionId}:${turn}:${baseSeq}`).digest('hex').slice(0, 32);
}

const notStarted = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.';
const unknown = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

// Keep the serialized suffix identical to DSH interruptedTurnClosers. In particular,
// a proposed tool call is not evidence that the tool started or that it failed.
export function closeInterruptedTurn(events) {
  let openTurn = null, openStep = null;
  const pendingCalls = new Map();
  for (const {type, data, seq} of events) {
    switch (type) {
      case 'turn/start':
      case 'turn/end':
        openTurn = type === 'turn/start' ? data.turn : null;
        openStep = null;
        pendingCalls.clear();
        break;
      case 'step/start': openStep = data.step; break;
      case 'step/end':
        openStep = null;
        pendingCalls.clear();
        break;
      case 'assistant/message':
        for (const block of data.message.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, {step:data.step});
        }
        break;
      case 'tool/call': {
        const entry = pendingCalls.get(data.callId);
        if (entry) entry.callSeq = seq;
        break;
      }
      case 'tool/result': pendingCalls.delete(data.message.source.callId); break;
    }
  }

  const closers = [];
  if (openTurn !== null) {
    const {seq:lastSeq, time} = events.at(-1);
    let seq = lastSeq + 1;
    for (const [callId, {step, callSeq}] of pendingCalls) {
      const started = callSeq !== undefined;
      const message = {
        id:`interrupted-tool-result-${callId}-${seq}`, role:'user', source:{kind:'tool', callId},
        content:[{type:'tool-result', toolCallId:callId, isError:true, content:[{type:'text', text:started ? unknown : notStarted}]}],
      };
      const error = started ? {name:'ToolOutcomeUnknownError', code:'TOOL_OUTCOME_UNKNOWN'} :
        {name:'ToolNotStartedError', code:'TOOL_NOT_STARTED'};
      closers.push({type:'tool/result', seq:seq++, time, data:{turn:openTurn, step, message, error}, surfaceOp:'append',
        ...(started ? {sourceEventSeqs:[callSeq]} : {})});
    }
    if (openStep !== null) closers.push({type:'step/end', seq:seq++, time, data:{turn:openTurn, step:openStep}});
    closers.push({type:'turn/end', seq, time, data:{turn:openTurn, reason:{kind:'interrupted'}}});
  }
  return {closers, openTurn, openStep, pendingCalls};
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function durableJson(path, value) {
  const dir = dirname(path), tmp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dir, {recursive:true, mode:0o700});
  try {
    writeFileSync(tmp, JSON.stringify(value), {mode:0o600, flush:true});
    renameSync(tmp, path);
  } finally { rmSync(tmp,{force:true}); }
  if (process.platform !== 'win32') {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

const matches = (row, epoch, turn) => !!epoch && row?.epoch === epoch && row.turn === turn;
function sealIntent(packet, events, turn, epoch, trigger, security) {
  packet.failoverClosers = closeInterruptedTurn(events).closers;
  const baseSeq = events.length, session = packet.source;
  packet.cloudIntent = {v:2, boundary:'auto-failover', from:packet.origin, epoch, session, turn, baseSeq, trigger, security,
    command:failoverCommand(session, turn, baseSeq), created:Date.now()};
  return packet;
}

export function registerAutoFailover(ctx, role, root, config = {}) {
  const {sourceFenceMs = 12000, takeoverDelayMs = 20000} = config;
  if (!['desktop','cloud'].includes(role) || !Number.isSafeInteger(sourceFenceMs) || sourceFenceMs <= 0 ||
      !Number.isSafeInteger(takeoverDelayMs) || takeoverDelayMs <= sourceFenceMs + 2000) throw Error('Invalid failover lease intervals');
  const epoch = randomUUID().replaceAll('-', ''), peer = role === 'desktop' ? 'cloud' : 'desktop';
  const path = join(root,'failover','local-state.json'), observed = () => readState(join(root,'failover','peer-observed.json'));
  const previous = readState(path), active = Object.create(null), surrenders = Object.assign(Object.create(null), previous.surrenders);
  const returns = Object.assign(Object.create(null), previous.returns);
  const holds = Object.assign(Object.create(null), previous.holds), claims = Object.assign(Object.create(null), previous.claims);
  // A host restart is not a return of ownership for a turn armed in the old incarnation.
  for (const [sid,row] of Object.entries(previous.active ?? {})) if (row.armed) holds[sid] = row.turn;
  const save = () => durableJson(path, {v:1,role,epoch,updatedAt:Date.now(),active,surrenders,holds,claims,returns});
  const unavailable = sid => {
    const agent = ctx.agents.get(sid);
    return ctx.workspaceRegistry.archivedSessionIds.includes(sid) || (agent &&
      (agent.status !== 'idle' || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length));
  };
  let stopping = false, shutdown, evaluating = false, sampling = false;
  async function discoverRunning() {
    // The plugin can attach in the middle of a native step (before any new event).
    for (const agent of ctx.agents.list?.() ?? []) {
      const session = agent.session, sid = session.id;
      if (agent.status !== 'running' || active[sid] || holds[sid] !== undefined || surrenders[sid]) continue;
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(sid,'read',{});
      try {
        const {events} = await reader.read(), {openTurn,openStep} = closeInterruptedTurn(events);
        if (Number.isSafeInteger(openTurn) && !active[sid] && agent.status === 'running' &&
            ctx.agents.get(sid) === agent && session.seq === events.length) track(session,openTurn,openStep);
      } finally { await reader.close(); }
    }
  }
  async function sampleSource() {
    if (stopping || sampling) return;
    sampling = true;
    try {
      await discoverRunning();
      for (const [sid,row] of Object.entries(active)) {
        if (row.fenced || stopping) continue;
        const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(sid));
        if (!project) continue;
        // Source revisions can advance without a new native session event.
        let state;
        try { state = await sourceState(root,await workspaceRoute(root,role,project)); }
        catch (error) { if (!stopping && active[sid] === row) { row.sourceBlocked = true; save(); } throw error; }
        if (active[sid] !== row || stopping) continue;
        if (state && (!row.sourceFence || row.sourceFence.epoch !== state.epoch || state.seq >= row.sourceFence.seq)) {
          row.sourceFence = {epoch:state.epoch,seq:state.seq}; row.sourceBlocked = !state.ready; save();
        }
      }
    } finally { sampling = false; }
  }

  function renew(sid, row, seen) {
    if (row.fenced) return;
    const grant = seen.leaseGrants?.[sid], now = Date.now();
    const valid = matches(grant,epoch,row.turn) && /^[0-9a-f]{16,32}$/.test(grant.renewalId) && Number.isSafeInteger(grant.renewedAt);
    if (!row.armed) {
      if (!valid || !matches(seen.ackOffer?.[sid],epoch,row.turn)) return;
      row.armed = true;
    }
    // Do not resurrect an expired armed turn if the event loop was suspended
    // through an entire lease and an independent transport has since reconnected.
    if (!valid || grant.renewedAt > now || now - grant.renewedAt >= sourceFenceMs ||
        (row.confirmedAt !== undefined && grant.renewedAt - row.confirmedAt >= sourceFenceMs)) {
      row.fenced = true; holds[sid] = row.turn;
    } else row.confirmedAt = grant.renewedAt;
  }
  function refresh() {
    if (stopping) return;
    const seen = observed();
    for (const [sid,row] of Object.entries(active)) renew(sid,row,seen);
    save();
  }
  function track(session, turn, step) {
    const sid = session.id;
    if (!validID(sid) || !Number.isSafeInteger(turn) || turn < 0) return;
    const row = active[sid]?.turn === turn ? active[sid] : (active[sid] = {epoch,turn,armed:false,sourceFenceMs});
    row.seq = session.seq; row.step = step ?? row.step ?? null;
    const approval = ctx.get('approval'), sandbox = ctx.get('sandboxPolicy')?.resolve({session})?.mode;
    row.security = sandbox && approval ? {sandbox,approval:approval.overrideOf(session) ?? approval.config.policy ?? 'ask'} : null;
    return row;
  }
  ctx.on('agent/pre-step', async ({agent,turn,step,messages = []}, next) => {
    const sid = agent.session.id;
    if (holds[sid] !== undefined || surrenders[sid]) {
      // A later turn number (including a new local prompt) is not a return of ownership.
      const returned = step === 1 && messages.find(m => m.source?.kind === 'user' && /^[a-f0-9]{64}$/.test(m.source.rpcId ?? '') && isContinuation(m.content?.[0]?.text));
      if (!returned || returns[sid] !== returned.source.rpcId || await dispatchState(root,returned.source.rpcId) === 'ready') return {kind:'reject'};
      delete surrenders[sid]; delete holds[sid]; delete active[sid]; delete returns[sid]; save();
    }
    const allowed = () => {
      if (stopping || holds[sid] === turn || surrenders[sid]?.turn === turn) return false;
      const row = track(agent.session,turn,step);
      if (!row) return false;
      renew(sid,row,observed()); save(); return !row.fenced;
    };
    if (!allowed()) return {kind:'reject'};
    const decision = await next();
    return decision?.kind === 'enter' && !allowed() ? {kind:'reject'} : decision;
  });
  ctx.on('session/event',(session,event) => {
    if (stopping || !validID(session.id)) return;
    const row = active[session.id];
    if (event.type === 'turn/end' && row?.turn === event.data.turn && !row.fenced) {
      delete active[session.id]; save();
    } else if (event.type === 'turn/start' && holds[session.id] === undefined && !surrenders[session.id] && ctx.agents.get(session.id)?.status === 'running') {
      track(session,event.data.turn,null); save();
    } else if (row) { row.seq = event.seq + 1; if (event.type === 'step/start') row.step = event.data.step; }
  });
  // Bind the source fence to the very checkpoint sent to the standby, not to
  // an earlier sample of the same workspace. Never reuse a fence on error.
  async function checkpoint(packet, events) {
    const row = active[packet.source];
    // A blocked native turn/end from our own fence must not replace the last
    // runnable open checkpoint on the standby when the network comes back.
    if (row?.fenced && events.findLast(e => e.type === 'turn/end')?.data?.turn === row.turn) return false;
    if (!row || closeInterruptedTurn(events).openTurn !== row.turn) return;
    try { await sealSource(root,packet); }
    catch (error) { row.sourceBlocked = true; save(); throw error; }
    row.sourceBlocked = false;
    if (active[packet.source] !== row || stopping) return;
    if (!row.sourceFence || !packet.sourceFence || row.sourceFence.epoch !== packet.sourceFence.epoch || row.sourceFence.seq <= packet.sourceFence.seq) row.sourceFence = packet.sourceFence;
    packet.failoverEpoch = epoch; save();
  }
  async function surrender(sid,row,seen) {
    renew(sid,row,seen);
    if (row.fenced || !row.security || ctx.workspaceRegistry.archivedSessionIds.includes(sid)) return;
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(sid));
    if (!project) return;
    const session = ctx.agents.get(sid)?.session;
    if (session) await ctx.sessions.flush(session);
    const reader = await ctx.sessionPersistence.open(sid,'read',{});
    try {
      const {events} = await reader.read();
      if (closeInterruptedTurn(events).openTurn !== row.turn) return;
      const packet = await pack(role,await workspaceRoute(root,role,project),reader.header,reader.inheritedEventCount,false,events);
      await sealSource(root,packet);
      renew(sid,row,observed());
      if (row.fenced) return;
      sealIntent(packet,events,row.turn,epoch,'shutdown',row.security);
      const key = claimID(sid,packet.cloudIntent.command);
      if (Buffer.byteLength(JSON.stringify(packet)) > maxPacket) throw Error('Oversized shutdown relay');
      surrenders[sid] = {...row,sourceBlocked:false,sourceFence:packet.sourceFence,command:packet.cloudIntent.command,baseSeq:events.length}; save();
      durableJson(join(root,'relay-outgoing',key+'.json'),packet);
    } finally { await reader.close(); }
  }
  async function sealShutdown() {
    await discoverRunning();
    const seen = observed(), failures = [];
    for (const [sid,row] of Object.entries(active)) {
      try { await surrender(sid,row,seen); }
      catch (error) { failures.push(error); }
    }
    save();
    if (role === 'desktop' && config.spawnShutdownSync !== false && /^[a-z0-9][\w.-]*$/i.test(config.sshHost ?? '')) {
      const win = process.platform === 'win32';
      const child = spawn(win ? 'py' : 'python3',[...(win ? ['-3.11'] : []), fileURLToPath(new URL('./transfer.py',import.meta.url)),
        '--mailbox',root,config.sshHost],{detached:true,stdio:'ignore',windowsHide:true});
      child.on('error', () => console.warn('[dsh-mobile-link/failover] Shutdown mailbox unavailable')); child.unref();
    }
    if (failures.length) throw new AggregateError(failures,'Shutdown checkpoint incomplete');
  }
  function prepareShutdown() { stopping = true; return shutdown ??= sealShutdown(); }
  ctx.effect(() => {
    refresh();
    const timer = setInterval(() => {
      try { refresh(); } catch { console.warn('[dsh-mobile-link/failover] Cannot refresh lease state'); }
      void sampleSource().catch(() => console.warn('[dsh-mobile-link/failover] Cannot refresh source revision'));
    },1000);
    timer.unref();
    const signals = ['SIGTERM','SIGINT'];
    const onSignal = sig => {
      const sole = process.listenerCount(sig) === 1;
      prepareShutdown().catch(() => console.warn('[dsh-mobile-link/failover] Shutdown checkpoint incomplete')).finally(() => {
        if (sole) { process.off(sig,onSignal); process.kill(process.pid,sig); }
      });
    };
    for (const sig of signals) process.on(sig,onSignal);
    return () => { clearInterval(timer); for (const sig of signals) process.off(sig,onSignal); return prepareShutdown(); };
  });

  function triggerFor(seen, sid, turn, packet) {
    const match = row => matches(row,seen.peerEpoch,turn) && (!packet || packet.failoverEpoch === row.epoch);
    const give = seen.surrenders?.[sid], row = seen.active?.[sid];
    if (match(give)) return 'shutdown';
    if (match(row) && row.peerArmed === true && takeoverDelayMs > (row.sourceFenceMs ?? sourceFenceMs) + 2000 && Number.isSafeInteger(row.leaseRenewedAt) && Date.now()-row.leaseRenewedAt >= takeoverDelayMs) return 'timeout';
  }
  async function evaluateSession(sid,seen,receiveRelayFn) {
    if (!validID(sid) || unavailable(sid)) return;
    const name = packetName(peer,sid), path = join(root,'inbox',name);
    // Avoid decompressing every live session on every polling tick.
    if (![seen.surrenders?.[sid],seen.active?.[sid]].some(row => row && triggerFor(seen,sid,row.turn))) return;
    let packet;
    try { if ((await stat(path)).size > maxPacket) return; packet = JSON.parse(await readFile(path,'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    if (packet.archived || packet.failoverEpoch !== seen.peerEpoch || packet.cloudIntent || packet.failoverClosers) return;
    const events = await unpack(packet,peer,name);
    if (!events) return;
    const turn = closeInterruptedTurn(events).openTurn;
    if (!Number.isSafeInteger(turn)) return;
    const trigger = triggerFor(seen,sid,turn,packet);
    if (!trigger) return;
    const evidence = trigger === 'timeout' ? seen.active[sid] : seen.surrenders[sid];
    if (evidence.sourceBlocked) return;
    if (trigger === 'shutdown' && evidence.baseSeq !== undefined && evidence.baseSeq !== events.length) return;
    const security = evidence.security ?? {sandbox:events.findLast(e => e.type === 'sandbox/mode')?.data?.mode ?? 'read-only',
      approval:events.findLast(e => e.type === 'approval/policy')?.data?.policy ?? 'ask'};
    if (!compatiblePolicy(ctx,security,events)) return;
    if (evidence.sourceFence) {
      if (packet.sourceFence && packet.sourceFence.epoch !== evidence.sourceFence.epoch) return;
      if (!packet.sourceFence || evidence.sourceFence.seq > packet.sourceFence.seq) packet.sourceFence = evidence.sourceFence;
    }
    sealIntent(packet,events,turn,seen.peerEpoch,trigger,security);
    if (!await canReceive(packet)) return;
    await receiveRelayFn(packet, () => {
      if (stopping || unavailable(sid)) return false;
      const current = observed();
      const source = trigger === 'timeout' ? current.active?.[sid] : current.surrenders?.[sid];
      return triggerFor(current,sid,turn,packet) === trigger && !source?.sourceBlocked &&
        (!source.sourceFence || (source.sourceFence.epoch === packet.sourceFence?.epoch && source.sourceFence.seq <= packet.sourceFence.seq)) &&
        compatiblePolicy(ctx,source.security ?? security,events);
    });
  }
  async function evaluateTakeover(receiveRelayFn) {
    if (evaluating || stopping) return;
    evaluating = true;
    try {
      const seen = observed();
      let failure;
      for (const sid of new Set([...Object.keys(seen.surrenders ?? {}),...Object.keys(seen.active ?? {})])) {
        try { await evaluateSession(sid,seen,receiveRelayFn); }
        catch (error) { failure ??= error; } // One divergent session does not starve other workspaces.
      }
      if (failure) throw failure;
    } finally { evaluating = false; }
  }
  async function canReceive(packet) {
    const {source:sid,cloudIntent:{command}} = packet;
    return !stopping && !unavailable(sid) && await dispatchState(root,claimID(sid,command)) === 'ready';
  }
  const accepted = async packet => await dispatchState(root,claimID(packet.source,packet.cloudIntent.command)) === 'accepted';
  function observeHistory(sid,events,inherited) {
    const row = surrenders[sid];
    if (!row?.command) return;
    const receipt = nativeAcceptance(events,inherited,claimID(sid,row.command),row.baseSeq);
    if (receipt && !row.accepted) { row.accepted = true; save(); }
    const delivered = receipt && events.find(e => e.seq >= receipt.seq && e.type === 'user/message' && e.data?.id === receipt.messageId);
    if (delivered && events.slice(delivered.seq+1).some(e => e.type === 'turn/end')) {
      delete surrenders[sid]; delete holds[sid]; delete active[sid]; delete returns[sid]; save();
    }
  }
  function authorizeReturn(packet) {
    const sid = packet.source;
    if (surrenders[sid] || holds[sid] !== undefined) {
      returns[sid] = claimID(sid,packet.cloudIntent.command); save();
    }
  }
  function markClaim(packet) { claims[packet.source] = packet.cloudIntent.command; save(); }
  function archiveTail(packet,localLength) {
    const intent = packet.cloudIntent;
    durableJson(join(root,'crash-tails',claimID(packet.source,intent.command)+'.json'),{session:packet.source,localLength,...intent});
  }
  async function sessionStatus(sid) {
    const seen = observed(), row = active[sid], activeCommand = claims[sid] ?? surrenders[sid]?.command ?? null;
    if (row && !stopping) { renew(sid,row,seen); save(); }
    const age = seen.lastSeenAt ? Date.now()-seen.lastSeenAt : null;
    let state = 'idle';
    if (surrenders[sid] && (!row || row.turn === surrenders[sid].turn)) state = surrenders[sid].accepted ? 'accepted' : 'surrendered';
    else if (row?.fenced || (!row && holds[sid] !== undefined)) state = 'fenced';
    else if (row) state = 'running';
    else if (claims[sid]) state = await dispatchState(root,claimID(sid,claims[sid])) === 'accepted' ? 'accepted' : 'auto-taking-over';
    return {state,activeCommand,armed:!!row?.armed,peerOnline:age !== null && age >= 0 && age < takeoverDelayMs,peerLastSeenMs:age};
  }
  return {epoch,refresh,checkpoint,evaluateTakeover,canReceive,accepted,markClaim,authorizeReturn,observeHistory,archiveTail,prepareShutdown,sessionStatus};
}
