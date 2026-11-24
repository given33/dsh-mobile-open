import test from 'node:test';
import assert from 'node:assert/strict';
import { closeInterruptedTurn, failoverCommand, registerAutoFailover } from '../lib/task-sync/auto-failover.mjs';
import { mkdtemp, rm, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitCloudTurn, claimID } from '../lib/task-sync/cloud-turn.mjs';
import { pack, packetName, unpack, hash } from '../lib/task-sync/log.mjs';
import { autoFailoverContinuation, verifiedRelay } from '../lib/task-sync/relay-boundary.mjs';
import { registerDeviceSwitch } from '../lib/task-sync/device-switch.mjs';
import { taskSync } from '../lib/task-sync/host.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { apply, PANEL_PATH } from '../plugin/host.mjs';
import https from 'node:https';
import { Readable } from 'node:stream';

const turn = 2, step = 7, time = 1700000000100;
const calls = (...ids) => ({step, message:{content:ids.map(id => ({type:'tool-call', id}))}});
const log = (...rows) => rows.map(([type,data],seq) => ({seq, time:time+seq, type, data}));

test('repair preserves durable tool results and closes only outstanding calls in proposal order', () => {
  const events = log(['turn/start',{turn}], ['step/start',{step}],
    ['assistant/message',calls('done','new','unknown')], ['tool/call',{callId:'done'}],
    ['tool/result',{message:{source:{callId:'done'}}}], ['tool/call',{callId:'unknown'}]);
  const original = structuredClone(events);
  const {openTurn, openStep, pendingCalls, closers} = closeInterruptedTurn(events);
  assert.deepEqual(events, original);
  assert.deepEqual([openTurn,openStep,...pendingCalls], [2,7,['new',{step}],['unknown',{step,callSeq:5}]]);
  const result = (id, seq, name, code, text) => ({type:'tool/result', seq, time:time+5,
    data:{turn,step,message:{id:`interrupted-tool-result-${id}-${seq}`,role:'user',source:{kind:'tool',callId:id},
      content:[{type:'tool-result',toolCallId:id,isError:true,content:[{type:'text',text}]}]},error:{name,code}},surfaceOp:'append'});
  assert.deepEqual(closers, [result('new',6,'ToolNotStartedError','TOOL_NOT_STARTED',
    'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'),
    {...result('unknown',7,'ToolOutcomeUnknownError','TOOL_OUTCOME_UNKNOWN',
      'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'),sourceEventSeqs:[5]},
    {type:'step/end',seq:8,time:time+5,data:{turn,step}},
    {type:'turn/end',seq:9,time:time+5,data:{turn,reason:{kind:'interrupted'}}}]);
  assert.deepEqual(closeInterruptedTurn([...events,...closers]).closers, []);
});

test('balanced logs stay unchanged and closed steps do not leak pending calls into later steps', () => {
  assert.deepEqual(closeInterruptedTurn([]), {closers:[],openTurn:null,openStep:null,pendingCalls:new Map()});
  const events = log(['turn/start',{turn:0}], ['step/start',{step}], ['assistant/message',calls('old')], ['step/end',{step}]);
  assert.deepEqual(closeInterruptedTurn(events).closers,[{type:'turn/end',seq:4,time:time+3,data:{turn:0,reason:{kind:'interrupted'}}}]);
});

test('failover command identifies an exact interruption independent of host, clock and trigger', () => {
  const command = failoverCommand('session-a',2,13);
  assert.equal(command,'4177855daed9d568ce7ccf85dc005b9f');
  for (const change of [['session-b',2,13],['session-a',3,13],['session-a',2,14]]) {
    assert.notEqual(failoverCommand(...change),command);
  }
});


for (const origin of ['desktop','cloud']) test(`${origin}: canonical interrupted suffix dispatches one continuation per claim`, async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-failover-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const sid = 'chat', name = packetName(origin,sid), now = Date.now();
  const events = log(['turn/start',{turn}], ['step/start',{step}], ['assistant/message',calls('write')], ['tool/call',{callId:'write'}])
    .map(e => ({...e,time:now}));
  const packet = await pack(origin,{owner:origin,key:'w',title:'W'},{id:sid,isSeeded:false,createdAt:now},0,false,events);
  packet.cloudIntent = {v:2,from:origin,session:sid,turn,baseSeq:events.length,trigger:'shutdown',boundary:'auto-failover',
    created:now,command:failoverCommand(sid,turn,events.length),security:{sandbox:'read-only',approval:'ask'}};
  packet.failoverClosers = closeInterruptedTurn(events).closers;
  const history = await unpack(packet,origin,name);
  assert.ok(verifiedRelay(packet,history));
  assert.equal(history[4].data.error.code,'TOOL_OUTCOME_UNKNOWN');
  const prompts = [], ctx = {workspaceRegistry:{archivedSessionIds:[]},get(key) {
    if (key === 'sessionController') return {prompt(args) {prompts.push(args);return {accepted:true};}};
  }};
  for (let i=0; i<2; i++) assert.equal(await admitCloudTurn(ctx,root,packet,history,new AbortController().signal,true),'accepted');
  assert.deepEqual(prompts.map(p=>p.content[0].text),[autoFailoverContinuation]);
  const forged = structuredClone(packet);
  forged.failoverClosers[0].data.error.code = 'TOOL_NOT_STARTED';
  assert.equal(verifiedRelay(forged,await unpack(forged,origin,name)),false);
  for (const diff of [{trigger:'mailbox'},{baseSeq:0},{turn:turn+1}]) {
    assert.equal(verifiedRelay({...packet,cloudIntent:{...packet.cloudIntent,...diff}},history),false);
  }
  await assert.rejects(unpack({...packet,cloudIntent:undefined},origin,name),/failover/);
  await assert.rejects(unpack({...packet,failoverClosers:packet.failoverClosers.slice(1)},origin,name),/suffix/);
});

test('status exposes failover capabilities without changing the iOS protocol version', async () => {
  const state = {state:'fenced',activeCommand:null,peerOnline:false,peerLastSeenMs:21000,armed:true,trigger:'timeout'};
  const {status} = registerDeviceSwitch({on(){}},'cloud','unused',{sessionStatus(id){ assert.equal(id,'chat'); return state; }});
  assert.deepEqual(await status({}),{role:'cloud',protocol:1,autoFailover:true,failoverProtocol:1});
  assert.deepEqual(await status({sessionId:'chat'}),{role:'cloud',protocol:1,...state});
});


const sid = 'chat', policy = {sandbox:'read-only',approval:'ask'};
async function pair(t, origin) {
  const dir = await mkdtemp(join(tmpdir(),'failover-engine-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const events = log(['turn/start',{turn}],['step/start',{turn,step}],['assistant/message',calls('unfinished')],['tool/call',{turn,step,callId:'unfinished'}])
    .map(e => ({...e,time:Date.now()}));
  const header = {id:sid,createdAt:Date.now(),isSeeded:false};
  function host(role) {
    const root = join(dir,role), listeners = new Map(), prompts = [], projects = [], rows = new Map(), agents = new Map();
    const handle = row => ({header:row.header,inheritedEventCount:0,read:async()=>({events:structuredClone(row.events)}),
      append:async suffix=>row.events.push(...suffix),flush:async()=>{},close:async()=>{}});
    const store = {open:async id=>handle(rows.get(id)),stat:async id=>rows.has(id)?{header:rows.get(id).header,revision:rows.get(id).events.length}:null,
      create:async h=>{assert.ok(!rows.has(h.id));const row={header:h,events:[]};rows.set(h.id,row);return handle(row);}};
    const registry = {list:()=>projects,archivedSessionIds:[],async create(path,title) {
      const project={id:'project',sessionIds:[],path,title,async attachSession(id){this.sessionIds.push(id);}};
      projects.push(project);return project;
    }};
    const services={agents,sessions:{get:id=>agents.get(id)?.session,flush:async()=>{}},sessionController:{prompt:async p=>{prompts.push(p);return {accepted:true};}},
      sandboxPolicy:{defaultMode:'read-only',resolve:()=>({mode:'read-only'})},approval:{config:{policy:'ask'},overrideOf:()=>undefined}};
    const ctx={...services,sessionPersistence:store,workspaceRegistry:registry,get:k=>services[k],effect(){},
      on:(name,fn)=>listeners.set(name,[...(listeners.get(name)??[]),fn])};
    const config={role,sshHost:'fixture',turnRelay:true,spawnShutdownSync:false};
    const controller=registerAutoFailover(ctx,role,root,config), tick=taskSync(ctx,config,root,controller);
    const json=async name=>JSON.parse(await readFile(join(root,'failover',name+'.json'),'utf8'));
    async function observe(obj) {await mkdir(join(root,'failover'),{recursive:true});await writeFile(join(root,'failover','peer-observed.json'),JSON.stringify(obj));}
    function preStep() {return listeners.get('agent/pre-step')[0]({agent:agents.get(sid),turn,step},async()=>({kind:'enter'}));}
    return {root,role,registry,agents,rows,prompts,config,ctx,controller,tick,json,observe,preStep};
  }
  const a=host(origin), b=host(origin==='desktop'?'cloud':'desktop');
  const project=await a.registry.create(join(dir,'src'),'Project');await project.attachSession(sid);
  a.rows.set(sid,{header:{...header,cwd:project.path},events});a.agents.set(sid,{status:'running',session:{id:sid,seq:events.length}});
  assert.deepEqual(await a.preStep(),{kind:'enter'});
  await a.tick();
  const name=packetName(origin,sid);
  await mkdir(join(b.root,'inbox'),{recursive:true});await copyFile(join(a.root,'outbox',name),join(b.root,'inbox',name));
  const offer=(await a.json('local-state')).active[sid], epoch=a.controller.epoch;
  const receipt = at => ({v:1,lastSeenAt:Date.now()-18,ackOffer:{[sid]:{epoch,turn}},leaseGrants:{[sid]:{epoch,turn,renewedAt:at,armed:false,renewalId:'a'.repeat(32)}}});
  const observation = (at,armed) => ({v:1,peerEpoch:epoch,lastSeenAt:Date.now()-18,surrenders:{},active:{[sid]:{...offer,peerArmed:armed,leaseRenewedAt:at}}});
  return {a,b,events,project,receipt,observation,name,dir};
}

for (const origin of ['desktop','cloud']) {
  test(`${origin}: offline/phase 1, then 21 mailbox pings fence at 12s before one takeover at 20s`,async t=>{
    const start=Date.now();let now=start;t.mock.method(Date,'now',()=>now);
    const {a,b,events,receipt,observation}=await pair(t,origin);
    await a.observe({...receipt(start),leaseGrants:{}});
    assert.deepEqual(await a.preStep(),{kind:'enter'});assert.equal((await a.controller.sessionStatus(sid)).armed,false);
    await b.observe(observation(start-30000,false));await b.tick();assert.equal(b.prompts.length,0);
    await a.observe(receipt(start));assert.deepEqual(await a.preStep(),{kind:'enter'});assert.equal((await a.controller.sessionStatus(sid)).armed,true);
    for(let i=1;i<=21;i++) {
      now=start+1000*i;
      await a.observe(receipt(start));await b.observe(observation(start,true));
      const decision=await a.preStep();await b.tick(false);
      assert.equal(decision.kind,i<12?'enter':'reject');assert.equal(b.prompts.length,i<20?0:1);
    }
    assert.deepEqual((await a.controller.sessionStatus(sid)),{state:'fenced',activeCommand:null,armed:true,peerOnline:true,peerLastSeenMs:18});
    assert.equal((await b.controller.sessionStatus(sid)).state,'accepted');
    assert.deepEqual(b.rows.get(sid).events,[...events,...closeInterruptedTurn(events).closers]);
    assert.equal(b.prompts[0].content[0].text,autoFailoverContinuation);
    await a.observe(receipt(now));assert.equal((await a.preStep()).kind,'reject','no resurrection after reconnect');
  });
  test(`${origin}: a 13s late first receipt arms and immediately fences`,async t=>{
    const {a,receipt}=await pair(t,origin);await a.observe(receipt(Date.now()-13000));
    assert.equal((await a.preStep()).kind,'reject');assert.equal((await a.json('local-state')).active[sid].fenced,true);
  });
  for (const via of ['sealed packet','surrender']) test(`${origin}: graceful shutdown via ${via} does not wait or replay`,async t=>{
    const {a,b,events,observation}=await pair(t,origin);
    const first=a.controller.prepareShutdown();assert.equal(first,a.controller.prepareShutdown());await first;
    assert.equal((await a.preStep()).kind,'reject');assert.equal((await a.controller.sessionStatus(sid)).state,'surrendered');
    const surrenders=(await a.json('local-state')).surrenders, cmd=failoverCommand(sid,turn,events.length), filename=claimID(sid,cmd)+'.json';
    assert.equal(surrenders[sid].command,cmd);assert.deepEqual(await readdir(join(a.root,'relay-outgoing')),[filename]);
    if (via==='sealed packet') {
      await mkdir(join(b.root,'relay-incoming'));await copyFile(join(a.root,'relay-outgoing',filename),join(b.root,'relay-incoming',filename));
    } else await b.observe({...observation(Date.now(),false),surrenders});
    await b.tick();await b.tick(false);assert.equal(b.prompts.length,1);
    assert.deepEqual(b.rows.get(sid).events,[...events,...closeInterruptedTurn(events).closers]);
  });
}
test('archived, busy, incompatible policy, and divergent native histories cannot be overwritten or dispatched',async t=>{
  const {b,events,observation}=await pair(t,'desktop'),seen=observation(Date.now()-30000,true);
  await b.observe(seen);b.registry.archivedSessionIds.push(sid);await b.tick();b.registry.archivedSessionIds.pop();
  b.agents.set(sid,{status:'running'});await b.tick();b.agents.delete(sid);assert.equal(b.rows.size,0);
  seen.active[sid].security={...policy,approval:'never'};await b.observe(seen);await b.tick();assert.equal(b.rows.size,0);
  seen.active[sid].security=policy;await b.observe(seen);
  await writeFile(join(b.root,'routes',hash('desktop:project')+'.json'),JSON.stringify({owner:'desktop',key:'project',title:'Project'}));
  const project=await b.registry.create(join(b.root,'workspaces',hash('desktop:project')),'Project');
  const divergent=[{...events[0],data:{turn:100}}];b.rows.set(sid,{header:{id:sid,createdAt:JSON.parse(await readFile(join(b.root,'inbox',packetName('desktop',sid)))).meta.createdAt,cwd:project.path},events:divergent});
  await b.tick();assert.deepEqual(b.rows.get(sid).events,divergent);assert.equal(b.prompts.length,0);assert.equal((await readdir(join(b.root,'crash-tails'))).length,1);
});

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../lib/task-sync/source_sync.py',import.meta.url));
const python = (...args) => process.platform === 'win32' ? run('py',['-3.11','-B',...args]) : run('python3',['-B',...args]);
test('bound automatic takeover waits for latest revision and conflict resolution; cloud archives Git before prompt',async t=>{
  const {a,b,project,dir,observation}=await pair(t,'desktop');
  const key=hash('desktop:project'), target=join(b.root,'workspaces',key), seen=observation(Date.now()-21000,true);
  for(const [root,path] of [[a.root,project.path],[b.root,target]]) {
    await mkdir(join(path,'src'),{recursive:true});await python(helper,'bind',root,key,path,'src');
  }
  await writeFile(join(project.path,'src','one.txt'),'from source');
  const fence=JSON.parse((await python(helper,'fence',a.root,key)).stdout);
  seen.active[sid].sourceFence={epoch:fence.epoch,seq:fence.seq};await b.observe(seen);
  await b.tick();assert.equal(b.prompts.length,0);assert.equal(b.rows.size,0);
  await writeFile(join(target,'src','one.txt'),'divergent target');
  await python('-c',`import sys;from pathlib import Path;sys.path.insert(0,str(Path(sys.argv[1]).parent));from source_sync import Journal;a=Journal(Path(sys.argv[2]),sys.argv[4]);b=Journal(Path(sys.argv[3]),sys.argv[4]);b.scan();b.accept(a.fence()['epoch'],a.page(b.fence()['received']));b.scan()`,helper,a.root,b.root,key);
  const conflict=JSON.parse((await python(helper,'fence',b.root,key)).stdout);assert.deepEqual(conflict.conflicts,['src/one.txt']);
  await b.tick();assert.equal(b.prompts.length,0);assert.equal(b.rows.size,0);
  const heads=JSON.parse((await python(helper,'export',b.root,key,'src/one.txt',join(dir,'heads'))).stdout);
  await python(helper,'resolve',b.root,key,'src/one.txt',...heads);
  await b.tick();assert.equal(b.prompts.length,1);
  const git=await run('git',['--git-dir='+join(b.root,'source-backups',key+'.git'),'show','refs/heads/checkpoints:src/one.txt']);
  assert.equal(git.stdout,'divergent target');
});


test('production plugin installs the controller and serves mobileRelay/status over the paired link',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'failover-plugin-')), clean=[], signal=new AbortController().signal;
  let panel;
  const ctx={connection:{createPeer:opts=>({...opts,signal}),createSharedFetchHandler:()=>({})},typertGateway:{wireStream:{open(){}}},
    webServer:{register(route){panel=route;return ()=>{};}},get(){},on(){},agents:new Map(),sessions:{},sessionPersistence:{},
    workspaceRegistry:{list:()=>[],archivedSessionIds:[]},
    inject(names,fn){if (names.every(n=>!!this[n]))fn(this);},effect(fn){const dispose=fn();if(dispose)clean.push(dispose);}};
  t.after(async()=>{for(const fn of clean.reverse())await fn();await rm(dir,{recursive:true,force:true});});
  apply(ctx,{stateDir:join(dir,'mobile-link'),enabled:true,host:'127.0.0.1',port:0,modelRouting:false,taskSync:{role:'cloud',turnRelay:true}});
  const req=Object.assign(Readable.from([]),{method:'GET',url:PANEL_PATH+'/status',headers:{}});
  let status;
  await panel.handler(req,{writeHead(code){assert.equal(code,200);},end(body){status=JSON.parse(body);}}, {principal:{kind:'owner'},signal});
  const post=(path,body,token)=>new Promise((ok,fail)=>{
    const req=https.request({host:'127.0.0.1',port:status.port,path,method:'POST',rejectUnauthorized:false,
      headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})}}, res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{assert.equal(res.statusCode,200);ok(JSON.parse(text));}catch(err){fail(err);}});
    });req.on('error',fail);req.end(JSON.stringify(body));
  });
  const {token}=await post('/mobile/v1/pair',{code:new URL(status.pairing.link).searchParams.get('c'),device:{id:'failover-test-device',name:'Test'}});
  const rpc=async args=>(await post('/api/mobileRelay/status',{type:'client-request',rpcId:'test',method:'mobileRelay/status',payload:{args}},token)).result.value;
  assert.deepEqual(await rpc({}),{role:'cloud',protocol:1,autoFailover:true,failoverProtocol:1});
  assert.deepEqual(await rpc({sessionId:sid}),{role:'cloud',protocol:1,state:'idle',armed:false,activeCommand:null,peerOnline:false,peerLastSeenMs:null});
});

// Real pipe framing, capability negotiation, atomic observations and native import.
// Only the ssh process launcher and the desktop's clock are substituted.
test('cloud host crash with reachable SSH: stale --peer cannot renew either lease; desktop takes over',async t=>{
  const {a:cloud,b:desktop}=await pair(t,'cloud');
  const script=fileURLToPath(new URL('../lib/task-sync/transfer.py',import.meta.url));
  const exchange=(offset=0)=>python('-c',`import sys,subprocess,time
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(sys.argv[1]).parent));import transfer
f,pc,cloud,delta=sys.argv[1:]; spawn=subprocess.Popen; now=time.time()
with patch.object(sys,'argv',[f,'--sync',pc,'fixture']), patch.object(subprocess,'Popen',side_effect=lambda args,**kw:spawn([sys.executable,'-B',f,'--peer',cloud,'failover-v1'],**kw)), patch.object(time,'time',return_value=now+int(delta)):
 transfer.main()`,script,desktop.root,cloud.root,String(offset));
  // The live replies contain the reverse offer, then its phase-2 arm commit.
  desktop.controller.refresh();await exchange();await exchange();assert.equal((await cloud.preStep()).kind,'enter');
  assert.equal((await cloud.controller.sessionStatus(sid)).armed,true);await exchange();
  const before=await desktop.json('peer-observed'), grant=(await cloud.json('peer-observed')).leaseGrants[sid];
  assert.ok(before.active[sid].peerArmed);const at=before.active[sid].leaseRenewedAt;
  const local=await cloud.json('local-state');local.updatedAt-=30000;
  await writeFile(join(cloud.root,'failover','local-state.json'),JSON.stringify(local));
  await exchange(21);const after=await desktop.json('peer-observed');
  assert.equal(after.lastSeenAt,before.lastSeenAt);assert.equal(after.active[sid].leaseRenewedAt,at);
  assert.deepEqual((await cloud.json('peer-observed')).leaseGrants[sid],grant);
  t.mock.method(Date,'now',()=>at+19999);await desktop.tick();assert.equal(desktop.prompts.length,0);
  Date.now.mock.mockImplementation(()=>at+20000);await desktop.tick(false);await desktop.tick(false);assert.equal(desktop.prompts.length,1);
});

test('21 actual --mailbox rounds with a live cloud: desktop lastSeen age 18ms never extends step admission',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const {a:desktop,b:cloud}=await pair(t,'desktop');
  const script=fileURLToPath(new URL('../lib/task-sync/transfer.py',import.meta.url));
  const exchange=(mode,at)=>python('-c',`import sys,subprocess,time
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(sys.argv[1]).parent));import transfer
f,pc,cloud,mode,stamp=sys.argv[1:];spawn=subprocess.Popen
peer="import sys,runpy,time; stamp=int(sys.argv.pop()); time.time=lambda:stamp/1000; sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')"
with patch.object(sys,'argv',[f,mode,pc,'fixture']), patch.object(subprocess,'Popen',side_effect=lambda args,**kw:spawn([sys.executable,'-B','-c',peer,f,'--peer',cloud,'failover-v1',stamp],**kw)), patch.object(time,'time',return_value=int(stamp)/1000):
 transfer.main()`,script,desktop.root,cloud.root,mode,String(at));
  cloud.controller.refresh();await exchange('--sync',now);assert.equal((await desktop.preStep()).kind,'enter');
  await exchange('--sync',now);const base=(await desktop.json('peer-observed')).leaseGrants[sid];assert.equal(base.armed,true);
  const start=base.renewedAt;
  for(let i=1;i<=21;i++) {
    now=start+i*1000-18;cloud.controller.refresh();await exchange('--mailbox',now);
    now+=18;const s=await desktop.controller.sessionStatus(sid);
    assert.equal(s.peerLastSeenMs,18);assert.deepEqual((await desktop.json('peer-observed')).leaseGrants[sid],base);
    assert.equal((await desktop.preStep()).kind,i<12?'enter':'reject');await cloud.tick(false);assert.equal(cloud.prompts.length,i<20?0:1);
  }
});

test('status distinguishes a pending protected prompt from native acceptance; unsafe interval is rejected',async t=>{
  const {a,b,observation}=await pair(t,'desktop');
  assert.throws(()=>registerAutoFailover(a.ctx,a.role,a.root,{sourceFenceMs:12000,takeoverDelayMs:14000}),/lease intervals/);
  await b.observe(observation(Date.now()-21000,true));
  const service=b.ctx.get('sessionController'), submit=service.prompt;
  service.prompt=async prompt=>{
    const status=await b.controller.sessionStatus(sid);
    assert.equal(status.state,'auto-taking-over');assert.equal(claimID(sid,status.activeCommand),prompt.requestId);
    return submit(prompt);
  };
  await b.tick();assert.equal(b.prompts.length,1);assert.equal((await b.controller.sessionStatus(sid)).state,'accepted');
});
