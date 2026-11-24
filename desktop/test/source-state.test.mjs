import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hash } from '../lib/task-sync/log.mjs';
import { createAutoSource, sealSource, sourceReady, sourceState, registerSourceCommands, registerSourceSteps } from '../lib/task-sync/source-state.mjs';

const run = promisify(execFile);
const win = process.platform === 'win32';
const helper = fileURLToPath(new URL('../lib/task-sync/source_sync.py',import.meta.url));
const python = (...args) => run(win?'py':'python3',[...(win?['-3.11']:[]),...args]);

test('an enrolled task cannot dispatch before source receipt, after epoch change, or on conflict', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dsh-source-fence-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const a=join(dir,'desktop'),b=join(dir,'cloud'),src=join(dir,'a'),dst=join(dir,'b');
  const route={owner:'desktop',key:'project'},id=hash('desktop:project');
  for (const [root,project] of [[a,src],[b,dst]]) {
    await mkdir(join(project,'src'),{recursive:true});
    await python(helper,'bind',root,id,project,'src');
  }
  await writeFile(join(src,'src','demo.js'),'one');
  let middleware;
  registerSourceSteps({on:(_,fn)=>{middleware=fn;},workspaceRegistry:{list:()=>[{sessionIds:['s']}] }},'cloud',a,async()=>route);
  const value=await middleware({agent:{session:{id:'s'}},callId:'c'},async()=>{await writeFile(join(src,'src','demo.js'),'two');return 'result';});
  assert.equal(value,'result');
  const packet={workspace:route};await sealSource(a,packet);
  assert.ok(packet.sourceFence.seq>=4);assert.equal(await sourceReady(b,packet),false);
  assert.equal(await sourceReady(b,{workspace:route}),false);
  const transfer=async()=>python('-c',`import sys;from pathlib import Path;sys.path.insert(0,str(Path(sys.argv[1]).parent));from source_sync import Journal;a=Journal(Path(sys.argv[2]),sys.argv[4]);b=Journal(Path(sys.argv[3]),sys.argv[4]);b.scan();b.accept(a.fence()['epoch'],a.page(b.fence()['received']));b.scan()`,helper,a,b,id);
  await transfer();assert.equal(await sourceReady(b,packet),true);
  assert.equal(await sourceReady(b,{...packet,sourceFence:{...packet.sourceFence,epoch:'0'.repeat(32)}}),false);
  await writeFile(join(src,'src','demo.js'),'left');await writeFile(join(dst,'src','demo.js'),'right');await sealSource(a,packet);await transfer();
  assert.equal(await sourceReady(b,packet),false);assert.deepEqual((await sourceState(b,route)).conflicts,['src/demo.js']);
});

async function localWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(),'dsh-source-steps-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const project = {path:join(root,'app'), sessionIds:['s']}, route = {owner:'desktop',key:'project'};
  await mkdir(project.path);
  await writeFile(join(project.path,'package.json'),'{}');
  const agent = {session:{id:'s'}}, principal = {kind:'owner'};
  let tool, command;
  const ctx = {
    on:(_,fn) => { tool = fn; }, commands:{register:def => { command = def.handler; }},
    workspaceRegistry:{list:() => [project]}, invocation:{peer:{principal}}
  };
  const ensure = createAutoSource(root,{role:'desktop',turnRelay:true});
  registerSourceSteps(ctx,'desktop',root,async()=>route,ensure);
  registerSourceCommands(ctx,'desktop',root,async()=>route);
  return {root, project, route, principal, run:(id,next,signal) => tool({agent,callId:id,signal},next),
    command:rawInput => command({agent,rawInput}), marker:join(root,'source-grants',hash('desktop:project')+'.disabled')};
}

test('source-share preserves the original scope across off, permission checks and explicit resume', async t => {
  const w = await localWorkspace(t);
  assert.match((await w.command('')).text,/未自动纳入/);
  w.principal.kind = 'guest';
  assert.equal((await w.command('--off')).kind,'error');
  w.principal.kind = 'owner';
  assert.match((await w.command('--off')).text,/已关闭/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(w.marker))),['disabledAt']);
  assert.match((await w.command('tests src')).text,/手动同步/);
  assert.match((await w.command('--off')).text,/已关闭/);
  const off = await readFile(w.marker,'utf8');
  assert.deepEqual(JSON.parse(off).previousScopes,['src','tests']);
  const denied = await w.command('--project');
  assert.equal(denied.kind,'error'); assert.match(denied.text,/原范围（src、tests）/);
  assert.equal(await readFile(w.marker,'utf8'),off);
  assert.match((await w.command('src tests tests')).text,/手动同步/);
  assert.equal((await sourceState(w.root,w.route)).auto,false);
});

test('first offline tool auto-binds without waiting; an explicit bind upgrades to strict manual gating', async t => {
  const w = await localWorkspace(t);
  const warnings = t.mock.method(console,'warn',()=>{});
  assert.equal(await w.run('first',async()=>{
    assert.equal((await sourceState(w.root,w.route)).auto,true);
    await writeFile(join(w.project.path,'first.js'),'saved'); return 'executed';
  },AbortSignal.timeout(8000)),'executed');
  assert.match((await w.command('')).text,/自动同步/);
  assert.match(warnings.mock.calls[0].arguments[0],/Peer offline/);
  const packet = {workspace:w.route}; await sealSource(w.root,packet);
  assert.ok(packet.sourceFence.seq >= 4);
  assert.equal(await sourceReady(join(w.root,'offline-peer'),packet),false);
  assert.match((await w.command('--project')).text,/手动同步/);
  let called = false;
  // Move the clock through the actual confirmation deadline without sleeping 20s.
  let clock = Date.now(); t.mock.method(Date,'now',()=>clock += 10001);
  await assert.rejects(w.run('strict',()=>{called=true;}),/云端未确认：本步工具没有执行/);
  assert.equal(called,false);
});

test('recent peer observation waits for acknowledgement; only automatic grants fall back on timeout', async t => {
  const w = await localWorkspace(t);
  await mkdir(join(w.root,'failover'));
  let clock = Date.now();
  await writeFile(join(w.root,'failover','peer-observed.json'),JSON.stringify({lastSeenAt:clock}));
  t.mock.method(Date,'now',()=>clock += 5001);
  const warnings = t.mock.method(console,'warn',()=>{});
  assert.equal(await w.run('online',()=>42),42);
  assert.equal(warnings.mock.callCount(),1);
  assert.match(warnings.mock.calls[0].arguments[0],/acknowledgement timed out/);
});
