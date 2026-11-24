import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandSpec, placedOnPeer, placedReceipt, sessionPlacement } from '../lib/task-sync/command-placement.mjs';
import { verifiedRelay } from '../lib/task-sync/relay-boundary.mjs';
import { registerTurnRelay } from '../lib/task-sync/relay-turn.mjs';

async function state(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-placement-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  return root;
}

test('foreground routing respects exact workspace rules and an owner choice scoped to one host, project and session', async t => {
  const root = await state(t);
  const native = command => commandSpec('pwsh', {command});
  const check = (command, sid='chat') => placedOnPeer(root,'desktop','project',native(command),sid);
  assert.equal(await check('npm run build'),false);
  await writeFile(join(root,'relay-placement.json'),JSON.stringify({'desktop:project':{pwsh:['npm run build']}}));
  assert.equal(await check('npm run build'),true);
  assert.equal(await check('npm run build && echo more'),false);
  await sessionPlacement(root,'desktop','project','chat','peer');
  assert.equal(await check('node custom.cjs'),true);
  assert.equal(await check('node custom.cjs','other'),false);
  for (const [role,project] of [['cloud','project'],['desktop','another']]) {
    assert.equal(await placedOnPeer(root,role,project,native('node custom.cjs'),'chat'),false);
  }
  await sessionPlacement(root,'desktop','project','chat','local');
  assert.equal(await check('npm run build'),false);
  await sessionPlacement(root,'desktop','project','chat','default');
  assert.equal(await check('npm run build'),true);
  assert.equal(await check('node custom.cjs'),false);
  for (const arg of [{run_in_background:true},{workdir:'elsewhere'},{sandbox_permissions:'another'},{timeoutMs:-1}]) {
    assert.equal(commandSpec('pwsh',{command:'npm run build',...arg}),null);
  }
});

test('selected execution position never falls through to a local shell if its runtime cannot seal the command', async t => {
  const root = await state(t);
  let middleware;
  registerTurnRelay({effect(){},on(name,fn){ if (name==='tools/execute') middleware=fn; },
    tools:{register(){},get(){return {}}},workspaceRegistry:{list:()=>[{id:'project',sessionIds:['chat']}]}
  },'desktop',root);
  const exec = {name:'pwsh', arguments:{command:'build'}, agent:{session:{id:'chat'}}};
  let calls = 0;
  const next = () => ++calls;
  assert.equal(await middleware(exec,next),1);
  await sessionPlacement(root,'desktop','project','chat','peer');
  await assert.rejects(middleware(exec,next), /未启动/);
  assert.equal(calls,1);
});

test('a shell output, modified model call, unfinished or concurrent turn cannot authorize execution on the peer', () => {
  const id='1'.repeat(32), tool={type:'tool-call',id:'x',name:'bash',arguments:'{"command":"npm run build"}'};
  const meta={turn:1,step:1};
  const events=[
    {type:'assistant/message',data:{...meta,message:{content:[tool]}}},
    {type:'tool/call',data:{...meta,name:'bash',callId:'x',arguments:tool.arguments}},
    {type:'tool/result',data:{...meta,message:{role:'tool',isError:false,toolCallId:'x',content:[{type:'text',text:placedReceipt(id)}]}}},
    {type:'step/end',data:meta}, {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ].map((e,seq)=>({...e,seq}));
  const packet={origin:'desktop',source:'chat',workspace:{owner:'desktop'},inherited:0,relayEnd:events.slice(2),
    cloudIntent:{v:2,command:id,created:Date.now(),session:'chat',from:'desktop',boundary:'before-shell'}};
  assert.ok(verifiedRelay(packet,events));
  for (const mutation of [e=>e[0].data.message.content.push(tool), e=>e[0].data.message.content[0].arguments='{"command":"other"}',
    e=>e[2].data.message.content[0].text='ordinary stdout '+placedReceipt(id), e=>e[2].data.message.isError=true,
    e=>e[4].data.reason.kind='aborted', e=>e[2].data.message.toolCallId='other']) {
    const changed=structuredClone(events); mutation(changed);
    assert.equal(verifiedRelay({...packet,relayEnd:changed.slice(2)},changed),false);
  }
  assert.equal(verifiedRelay({...packet,cloudIntent:{...packet.cloudIntent,boundary:'unknown'}},events),false);
  assert.equal(verifiedRelay({...packet,workspace:{owner:'cloud'}},events),false);
});
