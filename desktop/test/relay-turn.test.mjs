import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, link, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../lib/task-sync/log.mjs';
import { collectInputs, prepareInputs } from '../lib/task-sync/relay-inputs.mjs';
import { validTail, compatiblePolicy,receipt } from '../lib/task-sync/relay-boundary.mjs';

test('only a successful single handoff step may release its next model round', () => {
  const intent = {command:'nonce'};
  const call = {seq:8,type:'tool/call',data:{callId:'tool1',turn:1,step:2}};
  const result = {type:'tool/result',seq:9,data:{turn:1,step:2,message:{role:'tool',isError:false,toolCallId:'tool1',content:[{type:'text',text:receipt('nonce')}]}}};
  const receiptEvent = {type:'session-log-deepseek/delivery-accepted',seq:10};
  const step = {type:'step/end',seq:11,data:{turn:1,step:2}};
  const end = {type:'turn/end',seq:12,data:{turn:1,reason:{kind:'completed'}}};
  assert.ok(validTail(intent,call,[result,receiptEvent,step,end]));
  for (const type of ['user/message','agent/inbox/spliced','tool/call','step/start']) {
    assert.equal(validTail(intent,call,[result,{seq:10,type},step,end]),false);
  }
  assert.equal(validTail({command:'wrong'},call,[result,receiptEvent,step,end]),false);
  assert.equal(validTail(intent,call,[result,receiptEvent,step,{...end,data:{turn:1,reason:{kind:'aborted'}}}]),false);
});

test('handoff must not widen source permissions or override a stricter destination', () => {
  const ctx = {get:name=>name==='sandboxPolicy'?{defaultMode:'workspace-write'}:{config:{policy:'ask'}}};
  const src = {sandbox:'workspace-write',approval:'ask'};
  assert.ok(compatiblePolicy(ctx,src,[]));
  assert.equal(compatiblePolicy(ctx,{...src,sandbox:'read-only'},[]),false);
  assert.equal(compatiblePolicy(ctx,src,[{type:'sandbox/mode',data:{mode:'danger-full-access'}}]),false);
  assert.equal(compatiblePolicy(ctx,src,[{type:'approval/policy',data:{policy:'never'}}]),false);
});

test('opted-in files cross once; paths, hard links, changed files and owner directories are protected',async t=>{
  const root = await mkdtemp(join(tmpdir(),'relay-inputs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const route={owner:'desktop',key:'sample'}, source = join(root,'source');
  const replica=join(root,'workspaces',hash('desktop:sample'));
  await mkdir(source); await mkdir(replica,{recursive:true});
  const cfg=join(root,'relay-inputs.json'), input=join(source,'package.json');
  const policy = names=>writeFile(cfg,JSON.stringify({'desktop:sample':names}));
  await writeFile(input,'{}'); await writeFile(join(source,'.env'),'NEVER-SEND');
  assert.deepEqual(await collectInputs(root,route,source),[]);
  for (const name of ['../package.json','.env','CON.txt']) {
    await policy([name]); await assert.rejects(collectInputs(root,route,source));
  }
  await link(input,join(source,'alias.json')); await policy(['alias.json']);
  await assert.rejects(collectInputs(root,route,source)); await rm(join(source,'alias.json'));
  await policy(['package.json']); const files = await collectInputs(root,route,source);
  assert.equal(files.length,1); await assert.rejects(prepareInputs(root,'cloud',route,replica,files,false));
  await assert.rejects(prepareInputs(root,'cloud',route,source,files,true));
  await prepareInputs(root,'cloud',route,replica,files,true);
  await prepareInputs(root,'cloud',route,replica,files,true);
  await assert.rejects(prepareInputs(root,'cloud',route,replica,[{...files[0],digest:hash('different')}],true));
  await writeFile(join(replica,'package.json'),'changed');
  await assert.rejects(prepareInputs(root,'cloud',route,replica,files,true));
  assert.equal(await readFile(join(replica,'package.json'),'utf8'),'changed');
  await rm(input); await assert.rejects(prepareInputs(root,'desktop',route,source,files,true));
});

test('project inputs preserve the tree and do not copy neighbouring files or overwrite conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-project-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const route = { owner:'desktop', key:'project' };
  const src = join(root, 'source');
  const replica = join(root, 'workspaces', hash('desktop:project'));
  await mkdir(join(src,'src','页面'), { recursive:true });
  await mkdir(replica, { recursive:true });
  const filename = 'src/页面/首页.txt';
  await writeFile(join(src, filename), '你好');
  await writeFile(join(src, 'src', 'private.pem'), 'not selected');
  const cfg = names => writeFile(join(root,'relay-inputs.json'), JSON.stringify({'desktop:project':names}));
  await cfg([filename]);
  const files = await collectInputs(root, route, src);
  assert.deepEqual(files.map(f=>f.name), [filename]);
  await assert.rejects(prepareInputs(root,'cloud',route,replica,files,false));
  await prepareInputs(root,'cloud',route,replica,files,true);
  await prepareInputs(root,'cloud',route,replica,files,false);
  assert.equal(await readFile(join(replica,filename),'utf8'), '你好');
  await assert.rejects(readFile(join(replica,'src','private.pem')), {code:'ENOENT'});
  await writeFile(join(replica,filename), '他端的修改');
  await assert.rejects(prepareInputs(root,'cloud',route,replica,[{...files[0],name:'other/new.txt'},...files],true));
  await assert.rejects(readFile(join(replica,'other','new.txt')), {code:'ENOENT'});
  assert.equal(await readFile(join(replica,filename),'utf8'), '他端的修改');
  for (const names of [['src/../hidden'],['Src/a','src/b'],['src/a','src/A'],['src','src/a'],['src/A','src'],
    ['src/.git/config'],['src/key.pem'],['node_modules/foo/x'],['src/CON.txt'],['src/file:extra'],['src\\wrong.txt']]) {
    await cfg(names);
    await assert.rejects(collectInputs(root,route,src),/白名单/);
    await assert.rejects(prepareInputs(root,'cloud',route,replica,names.map(name=>({...files[0],name})),true),/无效/);
  }
  const elsewhere = join(root,'elsewhere'); await mkdir(elsewhere);
  await symlink(elsewhere, join(replica,'redirect'), process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareInputs(root,'cloud',route,replica,[{...files[0],name:'redirect/new.txt'}],true));
  await assert.rejects(readFile(join(elsewhere,'new.txt')), {code:'ENOENT'});
  await symlink(elsewhere, join(src,'redirect'), process.platform==='win32'?'junction':'dir');
  await writeFile(join(elsewhere,'clip.txt'),'not project data'); await cfg(['redirect/clip.txt']);
  await assert.rejects(collectInputs(root,route,src));
});

test('dependency guidance never prescribes npm ci over an existing tree or an ambiguous lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-node-env-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const { environment } = await import('../lib/task-sync/relay-environment.mjs');
  const probe = async () => (await environment(root,'cloud',['bash'],root)).nodeSetup;
  const bin = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await writeFile(bin, '', {mode:0o700});
  await writeFile(join(root,'package.json'),'{}'); await writeFile(join(root,'package-lock.json'),'{}');
  assert.equal((await probe()).freshInstall,'npm ci --ignore-scripts --no-fund --no-audit');
  await mkdir(join(root,'node_modules'));
  const present = await probe();
  assert.equal(present.modules,'present-unverified'); assert.equal(present.freshInstall,undefined);
  assert.equal(present.verify,'npm ls --depth=0');
  await writeFile(join(root,'pnpm-lock.yaml'),''); assert.equal((await probe()).verify,undefined);
});
