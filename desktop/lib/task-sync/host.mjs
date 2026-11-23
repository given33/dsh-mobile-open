import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { committedLength, comparePrefix, hash, maxPacket, pack, packetName, unpack } from './log.mjs';

import { installLegacy, readLegacy } from './legacy.mjs';

const run = promisify(execFile);
const transfer = fileURLToPath(new URL('./transfer.py', import.meta.url));
const options = signal => ({signal});
async function atomic(path, data) {
  const tmp = path + '.' + process.pid + '.tmp';
  await writeFile(tmp, data, {mode:0o600,flush:true});
  await rename(tmp, path);
}

export function taskSync(ctx, config, root) {
  const {role, sshHost} = config;
  if (!['cloud','desktop'].includes(role) || (role === 'desktop' && !/^[a-z0-9][\w.-]*$/i.test(sshHost || ''))) throw Error('Invalid task sync configuration');
  const peer = role === 'desktop' ? 'cloud' : 'desktop';
  const inbox = join(root,'inbox'), outbox = join(root,'outbox');
  const spaces = join(root,'workspaces');
  const seen = new Map(), sent = new Map(), errors = new Set();
  const ctrl = new AbortController();
  const {signal} = ctrl, store = ctx.sessionPersistence, registry = ctx.workspaceRegistry;
  let busy = false, fullRequested = false, timer;
  const dirty = new Set();
  function report(error) {
    const message = error.code || error.message;
    if (!signal.aborted && !errors.has(message)) { errors.add(message); console.warn('[dsh-mobile-link/task-sync]',message); }
  }
  // A hash-named directory is allocated only for a foreign workspace. A new task
  // started there keeps the original workspace identity when it travels back.
  async function describe(project) {
    if (dirname(resolve(project.path)) === resolve(spaces)) {
      const key = basename(project.path);
      const saved = JSON.parse(await readFile(join(root,'routes',key+'.json'),'utf8'));
      return {...saved,title:project.title.slice(0,256)};
    }
    return {owner:role,key:project.id,title:project.title.slice(0,256)};
  }
  async function destination(route) {
    if (route.owner === role) {
      const owned = registry.list().find(w => w.id === route.key);
      if (!owned) throw Error('Original workspace is no longer registered');
      return owned;
    }
    const key = hash(route.owner+':'+route.key), path = join(spaces,key);
    const found = registry.list().find(w => resolve(w.path) === resolve(path));
    if (found) return found;
    await mkdir(path,{recursive:true,mode:0o700});
    await atomic(join(root,'routes',key+'.json'),JSON.stringify(route));
    return registry.create(path,route.title);
  }
  async function publish(project, id, archived) {
    const record = await store.stat(id,options(signal));
    if (!record) return;
    const rev = JSON.stringify([record.revision,project.title,archived]);
    if (sent.get(id) === rev) return;
    const workspace = await describe(project);
    let packet, reader;
    try {
      reader = await store.open(id,'read',options(signal));
      packet = await pack(role, workspace, reader.header, reader.inheritedEventCount, archived, (await reader.read()).events);
    } catch (error) {
      if (error.name !== 'SessionFormatUnsupportedError' || record.formatStatus !== 'migration-required') throw error;
      const {cwd, ...meta} = record.header;
      packet = {v:2,origin:role,source:id,workspace,meta,inherited:0,archived,encoding:'legacy-v3-zstd',data:await readLegacy(record)};
    } finally { if (reader) await reader.close(); }
    await atomic(join(outbox,packetName(role,id)),JSON.stringify(packet));
    sent.set(id,rev);
  }
  async function receive(name) {
    const path = join(inbox,name), info = await stat(path, {bigint:true});
    if (info.size > maxPacket) throw Error('Oversized task envelope');
    const mark = `${info.ino}:${info.size}:${info.mtimeNs}`;
    if (seen.get(name) === mark) return;
    const packet = JSON.parse(await readFile(path,'utf8'));
    const events = await unpack(packet,peer,name), id = packet.source;
    const length = events ? committedLength(events) : 0;
    // A first turn is still in flight, not an empty finished session.
    if (!length && events?.length) { seen.set(name,mark); return; }
    const project = await destination(packet.workspace), header = {...packet.meta,cwd:project.path};
    const existing = await store.stat(id,options(signal));
    if (existing && (existing.header.createdAt !== header.createdAt || resolve(existing.header.cwd || '.') !== resolve(project.path))) throw Error('Session identity conflict; originals retained');
    if (!events) {
      if (!existing) await installLegacy(store,packet,project);
      if (!project.sessionIds.includes(id)) await project.attachSession(id);
      if (!existing && packet.archived) await registry.archiveSession(id);
      seen.set(name,mark);
      return;
    }
    const history = events.slice(0,length);
    if (packet.inherited > history.length) return;
    let missing = history.length;
    if (existing) {
      const reader = await store.open(id,'read',options(signal));
      try { missing = comparePrefix((await reader.read()).events,history); } finally { await reader.close(); }
    }
    if (!existing || missing > 0) {
      if (ctx.get?.('sessions')?.get(id)) return; // An open native runtime owns this writer.
      const writer = existing ? await store.open(id,'write',options(signal)) : await store.create(header,{signal,inheritedEventCount:packet.inherited});
      try {
        const old = (await writer.read()).events;
        if (comparePrefix(old,history) > 0) await writer.append(history.slice(old.length),options(signal));
        await writer.flush(options(signal));
      } finally { await writer.close(); }
      ctx.get?.('sessionProjectionCache')?.coldSnapshot(header,packet.inherited,history);
    }
    if (!project.sessionIds.includes(id)) await project.attachSession(id);
    if (!existing && packet.archived) await registry.archiveSession(id);
    seen.set(name,mark);
  }
  async function receiveInbox() {
    for (const name of await readdir(inbox)) {
      signal.throwIfAborted();
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try { await receive(name); } catch (error) { report(error); }
    }
  }
  async function tick(full = true) {
    if (signal.aborted) return;
    fullRequested ||= full;
    if (busy) return;
    busy = true;
    const scanAll = fullRequested;
    fullRequested = false;
    const changed = new Set(dirty);
    dirty.clear();
    try {
      for (const dir of [inbox,outbox,join(root,'routes')]) await mkdir(dir,{recursive:true,mode:0o700});
      // Read packets already delivered even when the peer has since lost power.
      await receiveInbox();
      const archived = new Set(registry.archivedSessionIds);
      for (const project of registry.list()) for (const id of project.sessionIds) {
        signal.throwIfAborted();
        if (!scanAll && !changed.has(id)) continue;
        try { await publish(project,id,archived.has(id)); } catch(e) { report(e); }
      }
    } catch(e) { report(e); } finally {
      busy = false;
      if (dirty.size || fullRequested) schedule();
    }
  }
  function schedule() {
    if (timer || signal.aborted) return;
    // Throttle, don't debounce: a busy tool stream must not postpone shipping indefinitely.
    timer = setTimeout(() => { timer = undefined; void tick(false); }, 450);
  }
  async function watchPeer() {
    // The transport owns no DSH writer. Local checkpoints keep advancing during SSH outages.
    while (!signal.aborted) {
      try {
        await run('py',['-3.11',transfer,'--watch',root,sshHost],{windowsHide:true,timeout:240000,signal});
      } catch { if (!signal.aborted) report(new Error('Task sync SSH unavailable')); }
      if (signal.aborted) break;
      try { await delay(2000, undefined, {signal}); } catch { break; }
    }
  }
  ctx.effect(() => {
    const first = setTimeout(() => tick(),400), interval = setInterval(() => tick(),12000);
    // Imported packets can arrive between full registry scans on either host.
    const polling = setInterval(() => tick(false),1500);
    if (role === 'desktop') void watchPeer();
    return () => { clearTimeout(first); clearInterval(interval); clearInterval(polling); clearTimeout(timer); ctrl.abort(); };
  });
  const boundaries = new Set(['agent/inbox/spliced','turn/start','user/message','step/end','tool/call','tool/result','turn/end']);
  ctx.on('session/event', (session,event) => {
    if (!boundaries.has(event.type)) return;
    dirty.add(session.id);
    schedule();
  });
  return tick;
}
