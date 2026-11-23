import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskSync } from '../lib/task-sync/host.mjs';
import { committedLength, comparePrefix, pack, unpack, packetName } from '../lib/task-sync/log.mjs';

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
