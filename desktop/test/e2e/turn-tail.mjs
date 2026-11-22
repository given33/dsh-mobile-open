// Standalone integration with the exact CLI's Cordis Loader and upstream recorder.
// No model calls, tokens, desktop profile, or signed application changes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as tail from '../../plugin/text-turn-tail.mjs';
const req = createRequire(pathToFileURL(resolve(process.argv[2])));
const load = async name => import(pathToFileURL(req.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
const pkg = '@deepseek-ai/dsh-workspace-changes', recorder = await load(pkg);
const local = (await load('@deepseek-ai/dsh-subprocess-local')).default;
const root = new Context(), subprocessHost = new Context(), dir = await mkdtemp(join(tmpdir(),'dsh-tail-proof-'));
const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let otherStops = 0;
try {
  root.baseUrl = pathToFileURL(dir).href + '/';
  await root.plugin(Loader);
  root.provide('fs', {processPath: target => target});
  root.provide('pluginPackages', {packageOf: () => req(pkg+'/package.json')});
  await subprocessHost.plugin(local);
  const real = subprocessHost.get('subprocess');
  const modules = new Map([[pkg,recorder],['mobile-tail',tail]]);
  root.loader.internal = { version:'v2', async import(specifier) { return modules.get(specifier); } };
  // Use a scoped subprocess provider so the real recorder's Git discovery can
  // be held indefinitely without a sleep, while all Git operations stay real.
  root.provide('subprocess', {spawn: o => real.spawn(o), async resolveExecutable(...args) {
    entered.resolve(); await gate.promise; return real.resolveExecutable(...args);
  }});
  // Use the actual loader entry, identity, schema and dependency gate from YAML.
  await root.loader.create({ name:pkg, inject:['dshMobileTextTurnTail'] });
  await root.loader.create({name:'mobile-tail'}); await root.loader.await();
  assert(root.get('workspaceChanges'), 'official recorder must be active');
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'}); git('init','-q');
  const file = join(dir,'proof.txt'); await writeFile(file,'before\n'); git('add','proof.txt');
  const s={id:'proof',header:{cwd:dir},events:[],append(type,data){ const e={type,data,seq:this.events.length}; this.events.push(e); root.emit('session/event',this,e); return e; }};
  root.on('agent/turn-stopping', () => {otherStops++;});
  const start = turn => {s.append('turn/start',{turn});s.append('step/start',{turn,step:1});};
  const finishText = turn => {s.append('assistant/message',{turn,step:1,message:{content:[{type:'text',text:'OK'}]}});s.append('step/end',{turn,step:1});};
  const stopping = turn => root.serial('agent/turn-stopping',{agent:{session:s},turn,signal:new AbortController().signal});
  const deadline=async(p,msg)=>{let t;try{return await Promise.race([p,new Promise((_,rej)=>{t=setTimeout(()=>rej(Error(msg)),3000);})]);}finally{clearTimeout(t);}};
  start(1); finishText(1); await deadline(entered.promise,'real Git baseline never started');
  const t0 = performance.now(); await deadline(stopping(1),'text was held by Git baseline');
  console.log(`Text-only stop returned in ${(performance.now()-t0).toFixed(1)} ms with Git still blocked`);
  s.append('turn/end',{turn:1});start(2);
  const agent={session:s};let ran=false;
  const tool = root.waterfall('tools/pre-execute',{agent},async()=>{ran=true;await writeFile(file,'after\n');});
  await new Promise(r=>setImmediate(r)); assert.equal(ran,false,'file edit must wait for its baseline');
  gate.resolve();await tool;assert(ran);s.append('tool/result',{turn:2,step:1});finishText(2);await stopping(2);
  const diff=s.events.find(e=>e.type==='workspace/changes');assert(diff,'tool turn must retain real diff');
  assert.equal(root.workspaceChanges.summary(s.id,diff.seq).files[0].path,'proof.txt');
  assert.equal(otherStops,2); s.append('turn/end',{turn:2}); console.log('File edit produced its real change summary; other stop hook ran on both turns');
} finally { gate.resolve();await root.fiber.dispose();await subprocessHost.fiber.dispose();await rm(dir,{recursive:true,force:true}); }
