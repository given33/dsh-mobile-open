import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceState, registerSourceCommands } from '../lib/task-sync/source-state.mjs';
import { taskSync } from '../lib/task-sync/host.mjs';
import { committedLength, comparePrefix, hash, pack, unpack, packetName } from '../lib/task-sync/log.mjs';

const events = ['turn/start','user/message','assistant/message','turn/end'].map((type,seq) => ({seq,type,time:seq,data:{}}));
const header = {id:'session-ordinary-1',version:4,isSeeded:false,createdAt:10};
const route = {owner:'desktop',key:'workspace-a',title:'项目'};
test('wire keeps native IDs and history and cannot select a filesystem path from a peer', async () => {
  const p = await pack('desktop',route,{...header,cwd:'C:/private/project'},0,false,events);
  assert.equal(p.meta.cwd,undefined);
  const name = packetName('desktop',header.id);
  assert.deepEqual(await unpack(p,'desktop',name),events);
  await assert.rejects(unpack({...p,workspace:{...route,key:'../escape'}},'desktop',name));
  await assert.rejects(unpack(p,'cloud',name));
  assert.equal(committedLength([...events,{type:'turn/start'},{type:'tool/call'}]),4);
  assert.throws(() => comparePrefix(events,[{type:'turn/start',seq:0,data:{other:true}}]),/Divergent/);
});

test('two ordinary workspaces with the same title import separately and continuation appends to the same session', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-host-sync-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const rows = new Map(), projects = [];
  const registry = {list:() => projects, archivedSessionIds:[], async create(path,title) {
    const p = {path,title,id:'w-'+projects.length,sessionIds:[],async attachSession(id){this.sessionIds.push(id);}};
    projects.push(p); return p;
  }};
  const handle = row => ({header:row.header,inheritedEventCount:0,read:async()=>({events:row.events.slice()}),append:async e=>row.events.push(...e),flush:async()=>{},close:async()=>{}});
  const store = {stat:async id=>rows.has(id)?{header:rows.get(id).header,revision:rows.get(id).events.length}:null, async create(meta){const row={header:meta,events:[]};rows.set(meta.id,row);return handle(row);},open:async id=>handle(rows.get(id))};
  const tick = taskSync({workspaceRegistry:registry,sessionPersistence:store,effect(){},on(){}},{role:'cloud'},root);
  const put = async (meta,space,log) => {
    await writeFile(join(root,'inbox',packetName('desktop',meta.id)),JSON.stringify(await pack('desktop',space,meta,0,false,log)));
  };
  await mkdir(join(root,'inbox'));
  await put(header,route,events);
  await put({...header,id:'session-other'},{...route,key:'workspace-b'},events);
  await tick(); assert.equal(projects.length,2); assert.equal(rows.size,2);
  const extra = events.map(e=>({...e,seq:e.seq+4,time:e.time+10}));
  await put(header,route,[...events,...extra.slice(0,3)]); await tick();
  assert.deepEqual(rows.get(header.id).events,events);
  await put(header,route,[...events,...extra]); await tick();
  assert.deepEqual(rows.get(header.id).events,[...events,...extra]); assert.equal(projects.length,2);
  await tick(); assert.deepEqual(projects[0].sessionIds.length,1);
});

test('preserves refused v3 tool history byte-for-byte after the location header', async () => {
  const z = await import('node:zlib');
  const {relocateLegacy,headerFrameLength} = await import('../lib/task-sync/legacy.mjs');
  const original = {...header,type:'session',version:3,cwd:'C:/fixture'};
  const frame = value => z.zstdCompressSync(Buffer.from(JSON.stringify(value)+'\n'));
  const tail = frame({type:'tool/call',data:{id:'unresolved-test'}});
  const source = Buffer.concat([frame(original),tail]);
  const copy = relocateLegacy(source,header,'/cloud/test');
  const cut = headerFrameLength(copy);
  const buffer = z.zstdDecompressSync(copy.subarray(0,cut));
  assert.deepEqual(copy.subarray(cut),tail);
  assert.deepEqual(JSON.parse(buffer.toString()),{...original,cwd:'/cloud/test'});
  assert.throws(()=>relocateLegacy(source,{...header,id:'another'},'/cloud/test'));
});

test('unfinished input stays in the checkpoint, not in the standby agent queue', () => {
  const queue = (target, inserted, removedCount = 0) => ({type:'agent/inbox/spliced',data:{target, start:0, inserted, removedCount}});
  const prompt = {id:'input-01'};
  const open = [...events, queue('next-turn',[prompt]), {type:'turn/start'}, queue('next-turn',[],1), {type:'tool/call'}];
  assert.equal(committedLength(open.slice(0,5)), events.length);
  assert.equal(committedLength(open), events.length);
  const done = [...open,{type:'tool/result'}, {type:'turn/end'}];
  assert.equal(committedLength(done), done.length);
  const stillQueued = [...open, queue('next-turn',[prompt]), {type:'turn/end'}];
  assert.equal(committedLength(stillQueued), events.length);
  assert.equal(committedLength([...stillQueued,queue('next-turn',[],1)]),stillQueued.length+1);
  assert.throws(() => committedLength([queue('next-step',[],1)]), /Invalid pending/);
});

test('a live tool checkpoint is published without turn/end; it is not a standby execution result', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-live-boundary-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const id=header.id, out=join(root,'outbox',packetName('cloud',id));
  const {readFile} = await import('node:fs/promises');
  const {setTimeout: sleep} = await import('node:timers/promises');
  const project={id:'local-cloud',title:'QA',path:join(root,'local-cloud'),sessionIds:[id]};
  const live=events.slice();
  let onEvent;
  const sync=taskSync({
    workspaceRegistry:{list:()=>[project],archivedSessionIds:[]},
    sessionPersistence:{stat:async()=>({header,revision:live.length}),open:async()=>({
      header,inheritedEventCount:0,read:async()=>({events:live.slice()}),close:async()=>{},
    })},
    effect(){},on(name,cb){ if(name==='session/event') onEvent=cb; },
  },{role:'cloud'},root);
  await sync();
  live.push({type:'turn/start',seq:4,time:4,data:{turn:2}}, {type:'tool/call',seq:5,time:5,data:{callId:'qa',turn:2,step:1}});
  onEvent({id},live.at(-1));
  const deadline=Date.now()+4000;
  let mirrored;
  do {
    await sleep(80);
    mirrored=await unpack(JSON.parse(await readFile(out,'utf8')),'cloud',packetName('cloud',id));
  } while(mirrored.length!==live.length && Date.now()<deadline);
  assert.deepEqual(mirrored,live);
  assert.equal(committedLength(mirrored),4);
});

test('paired hosts share empty native workspaces, preserve session identity in both directions and retire only designated buckets', async t => {
  const {readFile, readdir, copyFile} = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-relay-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  function host(role) {
    const dir = join(root, role), projects = new Map(), rows = new Map();
    const archived = new Set(), pinned = new Set();
    let index = 0;
    const registry = {
      list: () => [...projects.values()], delete: async id => projects.delete(id),
      get archivedSessionIds() { return [...archived]; }, get pinnedSessionIds() { return [...pinned]; },
      archiveSession: async id => { archived.add(id); pinned.delete(id); }, unarchiveSession: async id => archived.delete(id),
      pinSession: async id => pinned.add(id), unpinSession: async id => pinned.delete(id),
      async create(path, title) {
        const id = `${role}-${++index}`;
        const project = {id, path, title, sessionIds: [], async setTitle(value) { this.title = value; },
          async attachSession(sid) { if (!this.sessionIds.includes(sid)) this.sessionIds.push(sid); }};
        projects.set(id, project); return project;
      },
    };
    const handle = row => ({header:row.header, inheritedEventCount:0, read:async()=>({events:[...row.events]}),
      append:async data=>row.events.push(...data),flush:async()=>{},close:async()=>{}});
    const store = {stat:async id=> rows.has(id) ? {header:rows.get(id).header, revision:rows.get(id).events.length} : null,
      async create(header) { const row={header, events:[]}; assert.ok(!rows.has(header.id)); rows.set(header.id,row); return handle(row); },
      open:async id=>handle(rows.get(id))};
    const tick = taskSync({workspaceRegistry:registry, sessionPersistence:store, effect(){}, on(){}}, {role,sshHost:'fixture'}, dir);
    return {dir, registry, rows, tick};
  }
  const pc=host('desktop'), cloud=host('cloud');
  async function deliver(from, to) {
    await from.tick();
    await mkdir(join(to.dir,'inbox'),{recursive:true});
    for (const f of await readdir(join(from.dir,'outbox'))) await copyFile(join(from.dir,'outbox',f),join(to.dir,'inbox',f));
    await to.tick();
  }
  const project=await pc.registry.create(join(root,'normal'), '原项目');
  const old=await pc.registry.create(join(root,'legacy'), '来自电脑的任务');
  const legitimate=await pc.registry.create(join(root,'unrelated'), old.title);
  await deliver(pc,cloud);
  const replica = cloud.registry.list().find(p=>p.title === project.title);
  assert.ok(replica); assert.equal(cloud.registry.list().length,3);
  const retirement = JSON.stringify({desktop:[old.id],cloud:[]});
  for (const h of [pc,cloud]) await writeFile(join(h.dir,'retired-workspaces.json'),retirement);
  await project.setTitle('新名称'); await deliver(pc,cloud);
  assert.equal(replica.title,project.title); assert.equal(cloud.registry.list().length,2);
  assert.ok(pc.registry.list().includes(legitimate));
  await replica.setTitle('从云端原地改名'); await deliver(cloud,pc); await deliver(pc,cloud);
  assert.equal(project.title,'从云端原地改名'); assert.equal(replica.title,project.title);
  assert.equal(pc.registry.list().length,2); assert.equal(cloud.registry.list().length,2);
  // Even an older session packet left in transit cannot recreate the retired shelf.
  const stale = await pack('desktop',{owner:'desktop',key:old.id,title:old.title},header,0,false,events);
  await writeFile(join(cloud.dir,'inbox',packetName('desktop',header.id)), JSON.stringify(stale)); await cloud.tick();
  assert.equal(cloud.registry.list().length,2); assert.equal(cloud.rows.size,0);
  pc.rows.set(header.id,{header:{...header,cwd:project.path},events:[...events]}); await project.attachSession(header.id);
  await deliver(pc,cloud); assert.deepEqual(replica.sessionIds,[header.id]);
  // No source host is running while the standby appends the next confirmed round.
  const next=events.map(e=>({...e,seq:e.seq+4,time:e.time+10})); cloud.rows.get(header.id).events.push(...next);
  await cloud.registry.pinSession(header.id); await deliver(cloud,pc);
  assert.deepEqual(pc.rows.get(header.id).events,[...events,...next]); assert.deepEqual(pc.registry.pinnedSessionIds,[header.id]);
  await pc.registry.archiveSession(header.id); await deliver(pc,cloud); assert.deepEqual(cloud.registry.archivedSessionIds,[header.id]);
  await cloud.registry.unarchiveSession(header.id); await deliver(cloud,pc); assert.deepEqual(pc.registry.archivedSessionIds,[]);
  assert.deepEqual(project.sessionIds,[header.id]); assert.ok(await readFile(join(cloud.dir,'outbox','workspace-catalog.json'),'utf8'));
  // Refuse to retire real history even if an operator accidentally supplied its ID.
  await writeFile(join(pc.dir,'retired-workspaces.json'), JSON.stringify({desktop:[project.id],cloud:[]})); await pc.tick();
  assert.ok(pc.registry.list().includes(project)); assert.equal(pc.rows.get(header.id).events.length,8);
});

test('catalogue auto-enrols owned projects only, caches skipped paths, and respects off across restarts', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-source-catalog-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const make = (id,path) => ({id,path,title:id,sessionIds:[]});
  const owned = make('active',join(root,'app')), retired = make('old',join(root,'old'));
  const foreign = make('replica',join(root,'workspaces',hash('cloud:remote')));
  for (const p of [owned,retired,foreign]) await mkdir(p.path,{recursive:true});
  for (const p of [retired,foreign]) await writeFile(join(p.path,'package.json'),'{}');
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'routes',hash('cloud:remote')+'.json'),JSON.stringify({owner:'cloud',key:'remote'}));
  await writeFile(join(root,'retired-workspaces.json'),JSON.stringify({desktop:['old'],cloud:[]}));
  const projects = [owned,retired,foreign];
  const ctx = {workspaceRegistry:{list:()=>projects,delete:async id=>projects.splice(projects.findIndex(p=>p.id===id),1)},effect(){},on(){}};
  const start = options => taskSync(ctx,{role:'desktop',sshHost:'fixture',turnRelay:true,...options},root);
  const tick = start({}), route = {owner:'desktop',key:'active'};
  await tick();
  assert.equal(await sourceState(root,{owner:'desktop',key:'old'}),null);
  assert.equal(await sourceState(root,{owner:'cloud',key:'remote'}),null);
  await writeFile(join(owned.path,'package.json'),'{}'); await tick();
  assert.equal(await sourceState(root,route),null); // skipped path is cached
  owned.path = join(root,'moved'); await mkdir(owned.path); await mkdir(join(owned.path,'.git'));
  for (const options of [{autoSourceShare:false},{turnRelay:false}]) {
    await start(options)(); assert.equal(await sourceState(root,route),null);
  }
  await tick(); assert.equal((await sourceState(root,route)).auto,true);
  let command;
  registerSourceCommands({commands:{register:d=>{command=d.handler;}},workspaceRegistry:{list:()=>[{...owned,sessionIds:['s']}]},
    invocation:{peer:{principal:{kind:'owner'}}}},'desktop',root,async()=>route);
  await command({agent:{session:{id:'s'}},rawInput:'--off'});
  await tick(); await start({})();
  assert.equal(await sourceState(root,route),null);
  assert.deepEqual(JSON.parse(await readFile(join(root,'source-grants',hash('desktop:active')+'.disabled'))).previousScopes,['*']);
});
