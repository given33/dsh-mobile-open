import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hash } from '../lib/task-sync/log.mjs';
import { sealSource, sourceReady, sourceState, registerSourceSteps } from '../lib/task-sync/source-state.mjs';

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
