import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../lib/task-sync/log.mjs';
import { registerDeviceSwitch } from '../lib/task-sync/device-switch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskProgress, previousHost } from '../lib/task-sync/host-change.mjs';
import { verifiedRelay } from '../lib/task-sync/relay-boundary.mjs';

function history() {
  const position = {turn:1,step:1}, id = 'write-1';
  return [
    ['turn/start',{turn:1}], ['step/start',position],
    ['assistant/message',{...position,message:{content:[{type:'tool-call',id,name:'write'}]}}],
    ['tool/call',{...position,name:'write',callId:id}],
    ['tool/result',{...position,message:{role:'tool',source:{kind:'tool',callId:id},toolCallId:id,isError:false}}],
    ['step/end',position], ['turn/end',{turn:1,reason:{kind:'blocked'}}],
  ].map(([type,data],seq)=>({type,data,seq,...(type === 'tool/result' ? {surfaceOp:'append'} : {})}));
}

test('a proposed or unconfirmed side effect is not replayable; a normal return is not a deployment receipt', () => {
  const events = history();
  assert.equal(taskProgress(events).recent[0].next,'use-result-do-not-repeat');
  for (const prefix of [events.slice(0,3),events.slice(0,4)]) assert.equal(taskProgress(prefix).recent[0].next,'verify-before-retry');
  events[4].data.message.isError=true; events[4].data.error={code:'TOOL_OUTCOME_UNKNOWN'};
  assert.equal(taskProgress(events).recent[0].next,'verify-before-retry');
  events[4].data.error.code='TOOL_NOT_STARTED'; delete events[3].data.callId;
  assert.equal(taskProgress(events).recent[0].next,'plan-on-target');
});

test('manual takeover requires native settled batch plus exact blocked end and source fence', () => {
  const events=history(), packet={source:'s',origin:'desktop',inherited:0,sourceFence:{epoch:'a'.repeat(32),seq:2},
    cloudIntent:{v:2,from:'desktop',session:'s',boundary:'device-switch',created:Date.now(),command:'0'.repeat(32)},relayEnd:events.slice(-1)};
  assert.ok(verifiedRelay(packet,events));
  assert.equal(verifiedRelay({...packet,sourceFence:null},events),false);
  events[6].data.reason.kind='completed'; assert.equal(verifiedRelay(packet,events),false);
  events[6].data.reason.kind='blocked'; events[4].surfaceOp='replace'; assert.equal(verifiedRelay(packet,events),false);
});

test('host identity comes from a native snapshot, not text delivered by a user or a tool', () => {
  const event={type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'mobile-link:execution-host',text:'desktop/win32/x64'}]}}};
  assert.equal(previousHost([event]),'desktop/win32/x64');
  assert.equal(previousHost([event],1),null);
  event.data.source.kind='user'; assert.equal(previousHost([event]),null);
});

test('device status identifies the answering host with or without a switch record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'switch-status-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const {status} = registerDeviceSwitch({on() {}}, 'cloud', root);
  const args = {sessionId:'chat', command:'c'.repeat(32)};
  const host = {role:'cloud', protocol:1};
  assert.deepEqual(await status({}), host);
  assert.deepEqual(await status(args), {...host, state:'ready'});
  const record = {...args, state:'yielded', turn:2};
  await mkdir(join(root, 'device-switches'));
  await writeFile(join(root, 'device-switches', hash(args.sessionId)+'.json'), JSON.stringify(record));
  assert.deepEqual(await status(args), {...record, ...host});
  await assert.rejects(status({...args, command:'invalid'}));
});
