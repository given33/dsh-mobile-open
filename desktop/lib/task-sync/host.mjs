import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { committedLength, comparePrefix, hash, maxPacket, pack, packetName, unpack } from './log.mjs';

import { catalogName, catalogRoutes, titleRevisions, maxCatalog, mayUnregister, optionalJson, retiredRoutes } from './catalog.mjs';
import { checkMembership, isNewer, readMembership, setMembership } from './membership.mjs';
import { installLegacy, readLegacy } from './legacy.mjs';

import { modelFile, modelSnapshot, applyModelSnapshot } from './models.mjs';

const run = promisify(execFile);
const transfer = fileURLToPath(new URL('./transfer.py', import.meta.url));
const options = signal => ({signal});
async function atomic(path, data) {
  const tmp = path + '.' + process.pid + '.tmp';
  await writeFile(tmp, data, {mode:0o600,flush:true});
  await rename(tmp, path);
}

// Settings changes are independent of session persistence. A provider write conflict or
// an older peer must never hold up the workspace catalogue or task checkpoints.
export function syncModels(ctx, role, root) {
  if (!['desktop','cloud'].includes(role)) return;
  const dir = join(root, role === 'desktop' ? 'outbox' : 'inbox');
  let dirty = true, busy = false, stopped = false, last, checked = 0, warned = false;
  ctx.on('settings/document-updated', ns => {
    if (['llm-pi-ai','llm-deepseek','llm-deepseek-account','agent-default-model'].includes(ns)) dirty = true;
  });
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const expired = Date.now() - checked >= 60000;
      if (role === 'desktop') {
        if (!dirty && !expired) return;
        dirty = false;
        const data = JSON.stringify(modelSnapshot(ctx.settings.describe({redactSecrets:true})));
        if (data !== last) {
          await mkdir(dir,{recursive:true,mode:0o700});
          await atomic(join(dir,modelFile),data);
          last = data;
        }
      } else {
        const path = join(dir,modelFile);
        const info = await stat(path,{bigint:true});
        const mark = `${info.ino}:${info.mtimeNs}:${info.size}`;
        if (!dirty && !expired && last === mark) return;
        dirty = false;
        await applyModelSnapshot(ctx.settings,await optionalJson(path));
        last = mark;
      }
      checked = Date.now();
      warned = false;
    } catch (error) {
      // Never include a source URL, profile, model settings, or a native error containing them.
      if (error.code !== 'ENOENT' && !warned) {
        console.warn('[dsh-mobile-link/model-sync] Model settings not applied; retrying');
        warned = true;
      }
    } finally { busy = false; }
  }
  ctx.effect(() => {
    const first = setTimeout(tick,500), interval = setInterval(tick,2000);
    return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
  });
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
  let retired = new Set(), peerTitles = new Map(), lastCatalog;
  const isRetired = route => retired.has(route.owner + ':' + route.key);
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
    const title = peerTitles.get(route.key) ?? route.title;
    if (found) return found;
    await mkdir(path,{recursive:true,mode:0o700});
    await atomic(join(root,'routes',key+'.json'),JSON.stringify(route));
    return registry.create(path,title);
  }
  const titles = new Map();
  async function updateCatalog() {
    const incoming = await optionalJson(join(inbox,catalogName));
    const routes = incoming ? catalogRoutes(incoming,peer) : [];
    const otherTitles = titleRevisions(incoming);
    peerTitles = new Map(routes.map(r => [r.key,r.title]));
    for (const route of routes) if (!isRetired(route)) await destination(route);

    const local = [], revisions = [];
    for (const project of registry.list()) {
      const route = await describe(project);
      if (isRetired(route)) {
        if (await mayUnregister(ctx, project, signal)) await registry.delete(project.id);
        else report(new Error('Retired workspace has an open session or user history; registration preserved'));
        continue;
      }
      const {owner,key} = route, identity = `${owner}:${key}`;
      const file = join(root,'titles',hash(identity)+'.json');
      const previous = titles.get(identity) ?? await optionalJson(file);
      let next = previous;
      if (!next || next.title !== route.title) {
        next = {owner,key,title:route.title,clock:(previous?.clock ?? 0) + 1,actor:previous ? role : owner};
      }
      const remote = otherTitles.get(identity);
      if (remote && (isNewer(remote,next) || (!previous && owner === peer))) next = remote;
      else if (!remote && owner === peer && peerTitles.has(key) && !Array.isArray(incoming?.titles)) {
        // A pre-revision peer only publishes its own authoritative titles.
        next = {...next,title:peerTitles.get(key)};
      }
      if (next.title !== route.title) await project.setTitle(next.title);
      if (!previous || previous.title !== next.title || previous.clock !== next.clock || previous.actor !== next.actor) {
        await atomic(file,JSON.stringify(next));
      }
      titles.set(identity,next);
      revisions.push(next);
      if (owner === role) local.push({key,title:next.title});
    }
    const inventory = JSON.stringify({v:1,owner:role,workspaces:local,titles:revisions});
    if (local.length > 4096 || revisions.length > 8192 || Buffer.byteLength(inventory) > maxCatalog) throw Error('Oversized workspace catalogue');
    if (inventory !== lastCatalog) {
      await atomic(join(outbox,catalogName),inventory);
      lastCatalog = inventory;
    }
  }
  const memberships = new Map();
  const membershipPath = id => join(root, 'memberships', hash(id) + '.json');
  async function saveMembership(id, value) {
    await atomic(membershipPath(id), JSON.stringify(value));
    memberships.set(id, value);
    return value;
  }
  async function localMembership(id, create) {
    if (!memberships.has(id)) {
      const saved = await optionalJson(membershipPath(id));
      memberships.set(id, saved && checkMembership(saved));
    }
    const previous = memberships.get(id);
    const state = readMembership(registry, id);
    if (!previous && !create) return null;
    if (previous?.state === state) return previous;
    return saveMembership(id, {clock: (previous?.clock ?? 0) + 1, actor: role, state});
  }
  async function importMembership(packet, existing) {
    const value = packet.membership;
    if (!value) {
      if (!existing && packet.archived) await registry.archiveSession(packet.source);
      return;
    }
    const current = await localMembership(packet.source, false);
    if (isNewer(value, current)) {
      await setMembership(registry, packet.source, value.state);
      await saveMembership(packet.source, value);
    }
  }
  async function publish(project, id) {
    const record = await store.stat(id,options(signal));
    if (!record) return;
    const membership = await localMembership(id, true), archived = membership.state === 'archived';
    const rev = JSON.stringify([record.revision, project.title, membership]);
    if (sent.get(id) === rev) return;
    const workspace = await describe(project);
    if (isRetired(workspace)) return;
    let packet, reader;
    try {
      reader = await store.open(id,'read',options(signal));
      packet = await pack(role, workspace, reader.header, reader.inheritedEventCount, archived, (await reader.read()).events);
    } catch (error) {
      if (error.name !== 'SessionFormatUnsupportedError' || record.formatStatus !== 'migration-required') throw error;
      const {cwd, ...meta} = record.header;
      packet = {v:2,origin:role,source:id,workspace,meta,inherited:0,archived,encoding:'legacy-v3-zstd',data:await readLegacy(record)};
    } finally { if (reader) await reader.close(); }
    packet.membership = membership;
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
    if (packet.membership !== undefined) {
      checkMembership(packet.membership);
      if ((packet.membership.state === 'archived') !== packet.archived) throw Error('Inconsistent task membership');
    }
    if (isRetired(packet.workspace)) { seen.set(name,mark); return; }
    const length = events ? committedLength(events) : 0;
    // A first turn is still in flight, not an empty finished session.
    if (!length && events?.length) { seen.set(name,mark); return; }
    const project = await destination(packet.workspace), header = {...packet.meta,cwd:project.path};
    const existing = await store.stat(id,options(signal));
    if (existing && (existing.header.createdAt !== header.createdAt || resolve(existing.header.cwd || '.') !== resolve(project.path))) throw Error('Session identity conflict; originals retained');
    if (!events) {
      if (!existing) await installLegacy(store,packet,project);
      if (!project.sessionIds.includes(id)) await project.attachSession(id);
      await importMembership(packet, existing);
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
    await importMembership(packet, existing);
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
      for (const dir of [inbox,outbox,join(root,'routes'),join(root,'memberships'),join(root,'titles')]) await mkdir(dir,{recursive:true,mode:0o700});
      if (scanAll) {
        retired = retiredRoutes(await optionalJson(join(root, 'retired-workspaces.json')));
        try { await updateCatalog(); } catch (error) { report(error); }
      }
      // Read packets already delivered even when the peer has since lost power.
      await receiveInbox();
      for (const project of registry.list()) for (const id of project.sessionIds) {
        signal.throwIfAborted();
        if (!scanAll && !changed.has(id)) continue;
        try { await publish(project,id); } catch(e) { report(e); }
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
