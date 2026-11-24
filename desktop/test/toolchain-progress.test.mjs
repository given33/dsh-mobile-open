import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeInterruptedTurn } from '../lib/task-sync/auto-failover.mjs';
import { registerHostChange, taskProgress } from '../lib/task-sync/host-change.mjs';
import { autoFailoverContinuation, continuation, receipt, relayTool } from '../lib/task-sync/relay-boundary.mjs';
import { claimID, handoffEvidence } from '../lib/task-sync/relay-evidence.mjs';
import { adaptToolchain, environment, hostChangeProbe, registerEnvironment } from '../lib/task-sync/relay-environment.mjs';

const key = 'a'.repeat(64), privateText = 'must-not-appear-in-metadata';
const p = {turn:1, step:2};
const append = (events,type,data,extra) => events.push({seq:events.length, time:123, type, data, ...extra});
const stamp = host => ({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'mobile-link:execution-host',text:host}]}});
function proposal(events, position, names) {
  append(events,'assistant/message',{...position,message:{content:names.map(name => ({type:'tool-call',id:name,name,arguments:privateText}))}});
}
function start(events, position, name) {
  append(events,'tool/call',{...position, name, callId:name, arguments:privateText});
}
function result(events, position, name, isError, text=privateText) {
  append(events,'tool/result',{...position, message:{role:'tool',source:{kind:'tool',callId:name},toolCallId:name,isError,content:[{type:'text',text}] }},{surfaceOp:'append'});
}
function interruptedHistory(host='desktop/win32/x64') {
  const events = [];
  append(events,'turn/start',{turn:1});
  append(events,'user/message',{id:'original',source:{kind:'user'},content:[{type:'text',text:privateText}]});
  append(events,'user/message',stamp(host));
  append(events,'step/start',p);
  proposal(events,p,['read','edit_file','bash','grep','write','apply_patch']);
  for (const name of ['read','edit_file','bash','grep','apply_patch']) start(events,p,name);
  result(events,p,'read',false);
  result(events,p,'edit_file',true);
  return [...events,...closeInterruptedTurn(events).closers];
}
function accept(events,text=autoFailoverContinuation,rpcId=key) {
  const message={id:'accepted',source:{kind:'user',rpcId},content:[{type:'text',text}]};
  append(events,'agent/inbox/spliced',{inserted:[message]});
  append(events,'turn/start',{turn:2});
  append(events,'user/message',message);
  return message;
}

test('real interrupted closers preserve resultSeq and distinguish reads, writes, external effects and unstarted calls', () => {
  const events=interruptedHistory(); accept(events);
  const report=taskProgress(events);
  assert.equal(report.requestSeq,1);
  const expected=[
    ['read','tool-returned','use-result-do-not-repeat','already-completed','read-only'],
    ['edit_file','tool-error','verify-before-retry','check-workspace-file-and-source-sync','workspace-write'],
    ['bash','outcome-unknown','verify-before-retry','check-external-target-receipt','shell-or-external'],
    ['grep','outcome-unknown','refresh-with-read-only-tool','safe-to-re-read','read-only'],
    ['write','not-started','plan-on-target','safe-to-plan-on-target','workspace-write'],
    ['apply_patch','outcome-unknown','verify-before-retry','check-workspace-file-and-source-sync','workspace-write'],
  ];
  assert.deepEqual(report.recent.map(r=>[r.tool,r.state,r.next,r.verifyHint,r.category]),expected);
  for (const row of report.recent) assert.equal(events[row.resultSeq].data.message.source.callId,row.tool);
  assert.deepEqual([report.completedCount,report.unverifiedCount,report.notStartedCount],[1,4,1]);
  assert.deepEqual(report.stepSummary,[{...p,tools:expected.map(r=>r[0]),completed:1,unverified:4,notStarted:1}]);
  assert.deepEqual(report.interrupted,{turn:1,step:null,reason:'interrupted',pendingNotStarted:1,pendingUnknown:3});
  assert.equal(JSON.stringify(report).includes(privateText),false);
  append(events,'turn/end',{turn:2,reason:{kind:'completed'}});
  assert.equal(taskProgress(events).interrupted,null);
});

test('synthetic receipts must match native append, source, block id, error flag and known code', () => {
  for (const corrupt of [e=>e.surfaceOp='replace',e=>e.data.message.source.kind='user',e=>e.data.message.content[0].toolCallId='other',
    e=>e.data.message.content[0].isError=false,e=>e.data.error.code='OTHER',e=>e.data.message.role='assistant',e=>e.data.step++]) {
    const events=interruptedHistory();
    corrupt(events.find(e=>e.data.error?.code==='TOOL_NOT_STARTED'));
    const item=taskProgress(events).recent.find(r=>r.tool==='write');
    assert.equal(item.resultSeq,undefined); assert.equal(item.next,'verify-before-retry');
  }
});

test('step summaries are bounded without hiding totals or merging reused provider ids', () => {
  const events=[];
  for (let step=1;step<=20;step++) {
    const position={turn:3,step}; append(events,'step/start',position); proposal(events,position,['write']);
  }
  const report=taskProgress(events);
  assert.deepEqual(report.stepSummary.map(s=>s.step),Array.from({length:12},(_,i)=>i+9));
  assert.equal(report.unverifiedCount,20); assert.equal(report.verifyBeforeRetry.length,16); assert.equal(report.omittedUnverified,4);
});

test('Windows to Linux mapping uses only detected tools and lock-specific stack diagnostics', () => {
  const env={platform:'linux',nativeShellTools:['bash'],foundOnPath:['pwsh','python','python3','python3.11','rg','npm','node','cargo','gcc','cmake','java'],
    workspaceManifests:['package.json','pnpm-lock.yaml','pyproject.toml','Cargo.toml','go.mod','CMakeLists.txt','Makefile','pom.xml','global.json'],privateText};
  const r=adaptToolchain('desktop/win32/x64',env,null);
  assert.equal(r.transition,'win32->linux'); assert.equal(r.preferredShell,'bash'); assert.equal(r.pythonCommand,'python3.11');
  assert.deepEqual(r.availableShells,['bash','pwsh']); assert.equal(r.pwshOnPath,true); assert.equal(r.pathSeparator,'/');
  assert.deepEqual(r.commandEquivalents.map(m=>m.to),['bash','python3.11','rg','rg','npm']);
  assert.deepEqual(Object.fromEntries(r.projectStacks.map(s=>[s.stack,s.missingTools])),
    {node:['pnpm'],python:[],rust:['rustc'],go:['go'],'c/c++':['make'],java:['mvn'],'.net':['dotnet']});
  assert.deepEqual(r.projectStacks[0].availableTools,['node']); assert.deepEqual(r.projectStacks[0].manifests,['package.json','pnpm-lock.yaml']);
  assert.deepEqual([r.sourceSyncSummary.enrolled,r.sourceSyncSummary.ready],[false,false]); assert.match(r.sourceSyncSummary.guidance,/未登记/);
  assert.equal(JSON.stringify(r).includes(privateText),false);
});

test('Linux to Windows, same platform, fallback shell and legacy host do not invent tools or source sync', () => {
  const env={platform:'win32',nativeShellTools:['bash','pwsh'],foundOnPath:['py','python','python3','yarn'],workspaceManifests:['yarn.lock']};
  const sync={ready:false,seq:5,peerStored:4,received:3,conflicts:['src/one.js'],extra:privateText};
  const r=adaptToolchain('cloud/linux/x64',env,sync);
  assert.equal(r.transition,'linux->win32'); assert.equal(r.preferredShell,'pwsh'); assert.equal(r.pythonCommand,'py'); assert.equal(r.pathSeparator,'\\');
  assert.deepEqual(r.commandEquivalents.map(m=>m.to),['pwsh','py','pwsh','pwsh']);
  assert.deepEqual(r.sourceSyncSummary,{enrolled:true,ready:false,seq:5,peerStored:4,received:3,conflicts:['src/one.js']});
  assert.equal(JSON.stringify(r).includes(privateText),false);
  const same=adaptToolchain('desktop/win32/arm64',env,{...sync,ready:true});
  assert.equal(same.transition,'same-platform'); assert.deepEqual(same.commandEquivalents,[]); assert.equal(same.sourceSyncSummary.ready,true);
  const legacy=adaptToolchain('paired-host (legacy)',{platform:'linux',nativeShellTools:['pwsh']});
  assert.equal(legacy.transition,'unknown->linux'); assert.deepEqual(legacy.commandEquivalents,[]); assert.equal(legacy.preferredShell,'pwsh');
  const empty=adaptToolchain('cloud/linux/x64',{platform:'win32',foundOnPath:['find']});
  assert.equal(empty.preferredShell,null); assert.equal(empty.pythonCommand,null); assert.deepEqual(empty.commandEquivalents,[]);
});

test('takeover evidence separates synthetic outcomes, missing receipts and native acceptance for both boundaries', () => {
  for (const manual of [false,true]) {
    const events=interruptedHistory();
    if (manual) {
      // A settled later turn can follow an earlier interrupted turn in the same task.
      append(events,'turn/start',{turn:2}); append(events,'step/start',{turn:2,step:1});
      append(events,'step/end',{turn:2,step:1}); append(events,'turn/end',{turn:2,reason:{kind:'blocked'}});
    }
    const end=events.at(-1).seq;
    accept(events,manual ? continuation : autoFailoverContinuation);
    const h=handoffEvidence(events,0,'chat','cloud');
    assert.equal(h.boundary,manual?'device-switch':'auto-failover'); assert.equal(h.sourceEndSeq,end);
    assert.equal(h.acceptanceSeq,end+1); assert.equal(h.originalRequestSeq,1); assert.equal(h.missingResults,0);
    assert.deepEqual([h.requestId,h.from,h.to,h.externalEffects],[key,'desktop','cloud','not-verified']);
    assert.equal(h.priorCalls.find(x=>x.name==='write').result,'not-started');
    assert.equal(h.priorCalls.find(x=>x.name==='bash').result,'outcome-unknown');
    assert.equal(h.priorCalls.find(x=>x.name==='read').result,'reported-success');
    assert.equal(JSON.stringify(h).includes(privateText),false);
    events.find(e=>e.data.error?.code==='TOOL_NOT_STARTED').surfaceOp='replace';
    assert.equal(handoffEvidence(events,0,'chat','cloud').missingResults,1);
    assert.equal(handoffEvidence(events,end+1,'chat','cloud'),null);
    events.at(-1).data.content=[{type:'text',text:'ordinary user request'}];
    assert.equal(handoffEvidence(events,0,'chat','cloud'),null);
  }
  const fork=interruptedHistory(); const msg=accept(fork); fork[0]={seq:0,type:'agent/inbox/spliced',data:{inserted:[msg]}};
  assert.equal(handoffEvidence(fork,1,'chat','cloud'),null);
});

test('cooperative relay still requires the exact nonce receipt and accepted claim', () => {
  const events=interruptedHistory(); const position={turn:2,step:1}, nonce='c'.repeat(32);
  proposal(events,position,[relayTool]); start(events,position,relayTool); result(events,position,relayTool,false,receipt(nonce));
  append(events,'step/end',position); append(events,'turn/end',{turn:2,reason:{kind:'completed'}});
  accept(events,continuation,claimID('chat',nonce));
  assert.equal(handoffEvidence(events,0,'chat','cloud').priorCalls.length,6);
  events.at(-1).data.source.rpcId=key; assert.equal(handoffEvidence(events,0,'chat','cloud'),null);
});

test('first target step and relay_environment share the source snapshot; passive replicas have no local handoff', async t => {
  const root=await mkdtemp(join(tmpdir(),'toolchain-progress-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const source=process.platform==='win32'?'linux':'win32', events=interruptedHistory(`desktop/${source}/x64`);
  const request=accept(events), signal=new AbortController().signal, agent={session:{id:'chat',inheritedEventCount:0}};
  const tools=new Map(); let preStep;
  const ctx={workingDirectory:{ensure:async()=>root},tools:{get:name=>name==='bash',register:t=>tools.set(t.name,t)},
    sessions:{flush(){}},sessionPersistence:{open:async()=>({inheritedEventCount:0,read:async()=>({events}),close(){}})},
    systemPrompt:{context(){}},on(_name,fn){preStep=fn;},effect(){},get:()=>({list:()=>[]})};
  await writeFile(join(root,'package.json'),privateText); await writeFile(join(root,'app.csproj'),privateText);
  const probe=hostChangeProbe(ctx,'cloud',root); registerHostChange(ctx,'cloud',probe,async()=>false);
  registerEnvironment(ctx,'cloud',root);
  const next=async()=>({kind:'enter',messages:[request]});
  assert.equal((await preStep({agent,signal,step:2},next)).messages.length,1);
  const notice=(await preStep({agent,signal,step:1},next)).messages.at(-1);
  assert.equal(notice.source.kind,'mobile-link-host-change');
  const snapshot=JSON.parse(notice.content[0].text.split('\n').at(-1));
  assert.equal(snapshot.cwd,root); assert.deepEqual(snapshot.nativeShellTools,['bash']); assert.equal(snapshot.nodeSetup.modules,'absent');
  assert.equal(snapshot.toolchain.transition,`${source}->${process.platform}`); assert.equal(snapshot.progress.notStartedCount,1);
  assert.equal(notice.content[0].text.includes(privateText),false);
  append(events,'user/message',stamp(`cloud/${process.platform}/${process.arch}`));
  assert.equal((await preStep({agent,signal,step:1},next)).messages.length,1);
  const inspect=async()=>JSON.parse(await tools.get('relay_environment').execute({},{agent,signal}));
  assert.equal((await inspect()).handoff,null);
  await mkdir(join(root,'cloud-claims')); await writeFile(join(root,'cloud-claims',key),'claimed\naccepted\n');
  const local=await inspect(); assert.equal(local.handoff.boundary,'auto-failover');
  assert.deepEqual(local.taskProgress,snapshot.progress); assert.deepEqual(local.toolchain,snapshot.toolchain);
  assert.equal(local.toolchain.sourceSyncSummary.enrolled,false);
  assert.deepEqual(local.toolchain.projectStacks.find(s=>s.stack==='.net').manifests,['*.csproj']);
  assert.deepEqual((await environment(root,'cloud',[],root)).foundOnPath,[]);
});
