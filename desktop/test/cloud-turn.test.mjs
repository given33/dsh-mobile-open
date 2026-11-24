import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimID, registerCloudRun, submittedText, admitCloudTurn, dispatchState, reconcileDispatch } from '../lib/task-sync/cloud-turn.mjs';

const sid = 'active-session';
const intent = {v:1, session:sid, command:'cmd-1', created:Date.now()};
const history = [
  {type:'command/run', data:{name:'cloud-run', commandId:'cmd-1', source:{kind:'user'}, args:' summarize ' }},
  {type:'command/done', data:{commandId:'cmd-1', kind:'success'}},
];

test('a passive history, expired ticket, cancellation, and subsequent local work do not grant execution', () => {
  assert.equal(submittedText(intent,sid,history),'summarize');
  for (const bad of [undefined, {...intent,command:'cmd-2'}, {...intent,created:0}, {...intent,session:'other'}]) {
    assert.equal(submittedText(bad,sid,history),undefined);
  }
  assert.equal(submittedText(intent,sid,[...history,{type:'turn/start'}]),undefined);
  assert.equal(submittedText(intent,sid,[history[0],{...history[1],data:{commandId:'cmd-1',kind:'error'}}]),undefined);
});

test('owner command stages a prefix and publishes only after the matching native completion', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-stage-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  let handler, onEvent;
  const signal = new AbortController().signal, commandId = intent.command;
  const session = {id:sid,seq:1}, project = {id:'ws',title:'Work',path:root,sessionIds:[sid]};
  registerCloudRun({invocation:{peer:{principal:{kind:'owner'}}},
    on:(_,fn)=>{onEvent=fn;}, commands:{register:def=>{handler=def.handler;}},
    workspaceRegistry:{list:()=>[project],archivedSessionIds:[]}, sessions:{flush:async()=>{}},
    sessionPersistence:{open:async()=>({header:{id:sid},inheritedEventCount:0,
      read:async()=>({events:[{seq:0,...history[0]}]}),close:async()=>{}})},
  },root);
  const result = await handler({agent:{session,status:'idle',inbox:{nextStep:[],nextTurn:[]}},
    rawInput:'summarize',commandId,signal});
  assert.equal(result.kind,'success');
  const dir = join(root,'cloud-outgoing'), staged = await readdir(dir);
  assert.equal(staged.length,1); assert.match(staged[0],/^[a-f0-9]{64}\.tmp$/);
  const done = {seq:1,...history[1]};
  onEvent(session,{...done,data:{...done.data,commandId:'other'}});
  assert.deepEqual(await readdir(dir),staged);
  onEvent(session,done);
  const ready = claimID(sid,commandId)+'.json';
  assert.deepEqual(await readdir(dir),[ready]);
  assert.deepEqual(JSON.parse(await readFile(join(dir,ready),'utf8')).commandEnd,done);
});

test('simultaneous deliveries and a lost acceptance reply cannot execute the same native turn twice', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-claim-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  let calls = 0;
  const ctx = {workspaceRegistry:{archivedSessionIds:[]}, get:() => ({prompt:async request => {
    assert.equal(request.sessionId,sid);
    assert.equal(request.content[0].text,'summarize');
    calls++;
    throw Error('reply lost after submission');
  }})};
  const packet = {source:sid, cloudIntent:intent};
  const deliver = (p=packet) => admitCloudTurn(ctx,root,p,history,new AbortController().signal);
  await deliver({...packet,archived:true});
  await deliver({source:sid});
  assert.equal(calls,0);
  const attempts = await Promise.allSettled([deliver(),deliver()]);
  assert.equal(attempts.filter(r => r.status==='rejected').length,1);
  await deliver();
  assert.equal(calls,1);
});


test('a cancelled reservation can be taken after restart; a lost reply requires a matching native receipt', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-restart-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const packet = {source:sid,cloudIntent:intent};
  const key = claimID(sid,intent.command);
  let launches = 0;
  const ctx = {workspaceRegistry:{archivedSessionIds:[]}, get:() => ({prompt:async () => {
    launches++;
    throw Error('lost reply');
  }})};
  await assert.rejects(admitCloudTurn(ctx,root,packet,history,AbortSignal.abort()));
  assert.equal(await dispatchState(root,key),'ready');
  assert.equal(launches,0);
  const signal = new AbortController().signal;
  await assert.rejects(admitCloudTurn(ctx,root,packet,history,signal),/lost reply/);
  const message = {id:'queued-by-dsh',source:{kind:'user',rpcId:key}};
  const consumed = {seq:4,type:'user/message',data:message};
  const queued = {seq:3,type:'agent/inbox/spliced',data:{inserted:[message]}};
  for (const records of [[],[{...consumed,data:{...message,source:{kind:'user',rpcId:'foreign'}}}],
    [{...consumed,data:{...message,source:{kind:'runtime-context',rpcId:key}}}],
    [{...queued,seq:0},consumed], [{...consumed,seq:2}]]) {
    assert.equal(await reconcileDispatch(root,key,records,1,3),'uncertain');
  }
  assert.equal(await admitCloudTurn(ctx,root,packet,history,signal),'uncertain');
  assert.equal(await reconcileDispatch(root,key,[queued,consumed],1,3),'accepted');
  assert.equal(await admitCloudTurn(ctx,root,packet,history,signal),'accepted');
  assert.equal(launches,1);
});
