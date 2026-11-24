import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDeployment, deploymentTool, readTicket, savedDeployments } from '../lib/task-sync/deployment-ref.mjs';
import { inspectDeployment } from '../tools/relay-deployment-status.mjs';

const identity={repository:'example/app',repositoryId:'123',environment:'staging',sha:'a'.repeat(40),deploymentActor:'11',statusActor:'12'};
const known={...identity,deploymentId:'33'};
const bound=spec=>bindDeployment(spec,'chat','call1');
const repoPath='/repos/example/app', url='https://api.github.com'+repoPath;
const deployment=(spec={})=>({id:33,environment:'staging',sha:identity.sha,task:'deploy',creator:{id:11},repository_url:url,...spec});
const status=(id,state,spec={})=>({id,state,created_at:new Date(1700000000000+id*1000).toISOString(),environment:'staging',creator:{id:12},deployment_url:url+'/deployments/33',...spec});
function api(overrides={}) {
  const paths=[];
  const routes={
    [repoPath]:{id:123,full_name:'example/app'},
    [repoPath+'/deployments']:[deployment({payload:{dshRelayOperation:bound(identity).operation}})],
    [repoPath+'/deployments/33']:deployment({payload:{dshRelayOperation:bound(identity).operation}}),
    [repoPath+'/deployments/33/statuses']:[status(90,'success'),status(10,'pending')],
    ...overrides,
  };
  const read=async (path,params={})=>{
    paths.push(path);
    assert.ok(Object.hasOwn(routes,path));
    const v=routes[path];
    if (typeof v==='function') return v(params);
    return {value:v,next:false};
  };
  return {paths,read};
}

test('the exact provider deployment and publisher status are distinct from git, current production health and replay permission',async()=>{
  for (const [provider,normalized] of Object.entries({success:'reported-success',error:'reported-error',failure:'reported-failure',in_progress:'in-progress',pending:'pending',queued:'queued',inactive:'inactive'})) {
    const a=api({[repoPath+'/deployments/33/statuses']:[status(10,'success'),status(99,provider)]});
    const r=await inspectDeployment(bound(known).ticket,a.read);
    assert.equal(r.state,normalized); assert.equal(r.statusId,'99'); assert.equal(r.retryDeployment,false);
    assert.deepEqual(a.paths,[repoPath,repoPath+'/deployments/33',repoPath+'/deployments/33/statuses']);
  }
  for (const [path,value] of [
    [repoPath,{id:555,full_name:'example/app'}], [repoPath,{id:123,full_name:'other/repo'}],
    [repoPath+'/deployments/33',deployment({id:34})], [repoPath+'/deployments/33',deployment({sha:'f'.repeat(40)})],
    [repoPath+'/deployments/33',deployment({environment:'production'})], [repoPath+'/deployments/33',deployment({creator:{id:99}})],
    [repoPath+'/deployments/33',deployment({task:'other'})], [repoPath+'/deployments/33',deployment({repository_url:url+'2'})],
    [repoPath+'/deployments/33/statuses',[status(80,'success'),status(90,'success',{creator:{id:99}})]],
    [repoPath+'/deployments/33/statuses',[status(90,'success',{environment:'elsewhere'})]],
    [repoPath+'/deployments/33/statuses',[status(90,'success',{deployment_url:url+'/deployments/34'})]],
    [repoPath+'/deployments/33/statuses',[]],[repoPath+'/deployments/33/statuses',()=>{throw Error('http-404')}],
    [repoPath+'/deployments/33/statuses',()=>{throw Error('sensitive server output')}],
  ]) {
    const r=await inspectDeployment(bound(known).ticket,api({[path]:value}).read);
    assert.equal(r.state,'unconfirmed'); assert.equal(r.retryDeployment,false);
    assert.ok(!JSON.stringify(r).includes('sensitive server output'));
  }
});

test('after a lost creation response, a matching commit alone never selects a deployment',async()=>{
  const ref=bound(identity), path=repoPath+'/deployments', tag={dshRelayOperation:ref.operation};
  const select = rows=>inspectDeployment(ref.ticket,api({[path]:rows}).read);
  const unique=await select(params=>{
    assert.equal(params.sha,identity.sha); assert.equal(params.environment,'staging');
    return params.page===1 ? {value:[deployment({id:10})],next:true} : {value:[deployment({payload:JSON.stringify(tag)})],next:false};
  });
  assert.equal(unique.deploymentId,'33'); assert.equal(unique.state,'reported-success');
  for (const rows of [[],[deployment()], [deployment({payload:{dshRelayOperation:'different'}})],
    [deployment({payload:tag}),deployment({id:34,payload:tag})], [deployment({creator:{id:9},payload:tag})],
    params=>({value:[deployment({id:params.page,payload:tag})],next:true})]) {
    const r=await select(rows); assert.equal(r.state,'unconfirmed'); assert.equal(r.retryDeployment,false);
  }
  const changed=await inspectDeployment(ref.ticket,api({[path+'/33']:deployment({payload:{}})}).read);
  assert.equal(changed.reason,'deployment-identity-mismatch');
});

test('recover references only from matching native source calls and results, not shell output or inherited text',()=>{
  const ref=bound(known),call={seq:1,type:'tool/call',data:{turn:1,step:1,callId:'call1',name:deploymentTool,arguments:JSON.stringify(known)}};
  const result={seq:2,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',isError:false,toolCallId:'call1',content:[{type:'text',text:JSON.stringify(ref)}]}}};
  const events=[{seq:0,type:'user/message',data:{}},call,result];
  assert.deepEqual(savedDeployments(events,0,'chat'),[{...ref,sourceCallSeq:1}]);
  assert.deepEqual(savedDeployments(events,2,'chat'),[]);assert.deepEqual(savedDeployments(events,0,'other-chat'),[]);
  for(const change of [es=>es[1].data.name='bash',es=>es[2].data.step=2,es=>es[2].data.message.isError=true,es=>es[2].data.message.content[0].text='echo '+JSON.stringify(ref)]) {
    const modified=structuredClone(events);change(modified);assert.deepEqual(savedDeployments(modified,0,'chat'),[]);
  }
  for(const spec of [{...known,repository:'example/../app'},{...known,repository:'example/app?secret=x'}, {...known,sha:'main'}, {...known,repositoryId:'001'}, {...known,environment:'e\n'}, {...known,token:'do-not-copy'}]) assert.throws(()=>bound(spec));
  assert.throws(()=>readTicket(ref.ticket+'=='));
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentWatch } from '../lib/task-sync/deployment-watch.mjs';

test('the session cannot trigger host network; scoped watches stop exposing observations immediately on removal and expiry', async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-provider-watch-'));
  t.after(()=>rm(root,{force:true,recursive:true}));
  let reads=0,now=1_700_000_000_000;
  const ref=bound(known), policy=join(root,'deployment-watch.json');
  const watcher=deploymentWatch(root,async(ticket,_,signal)=>{
    assert.deepEqual(readTicket(ticket).identity,known);
    assert.equal(signal.aborted,false); reads++;
    return {state:'in-progress',statusId:'999',deploymentId:'33'};
  },()=>now);
  const mine=()=>watcher.forSession('chat',[ref]);
  assert.deepEqual(await mine(),[]);await watcher.tick();assert.equal(reads,0);
  await writeFile(policy,JSON.stringify([{sessionId:'chat',target:known}]));
  assert.equal((await mine())[0].reason,'awaiting-owner-observation');assert.equal(reads,0);
  await watcher.tick(); await watcher.tick();assert.equal(reads,1);
  assert.deepEqual(await watcher.forSession('other',[ref]),[]);
  assert.deepEqual(await watcher.forSession('chat',[bound({...known,deploymentId:'35'})]),[]);
  assert.equal((await mine())[0].referenceOperation,ref.operation);
  assert.equal((await mine())[0].retryDeployment,false);
  now+=300001;assert.equal((await mine())[0].reason,'awaiting-owner-observation');assert.equal(reads,1);
  await watcher.tick();assert.equal(reads,2);
  await writeFile(policy,'[]');assert.deepEqual(await mine(),[]);
  await writeFile(policy,'{invalid');await watcher.tick();assert.equal(reads,2);
  await writeFile(policy,JSON.stringify([{sessionId:'chat',target:identity}]));await watcher.tick();assert.equal(reads,2);
  watcher.stop();await watcher.tick();assert.deepEqual(await mine(),[]);
});
