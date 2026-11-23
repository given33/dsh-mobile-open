import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submittedText, admitCloudTurn } from '../lib/task-sync/cloud-turn.mjs';

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
