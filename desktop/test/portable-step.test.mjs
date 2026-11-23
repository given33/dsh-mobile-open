import assert from 'node:assert/strict';
import test from 'node:test';
import {portablePlan,registerPortableSteps} from '../lib/task-sync/portable-step.mjs';

const checksum = "(Get-FileHash -LiteralPath 'relay-inputs/my.bin' -Algorithm SHA256).Hash";
test('only complete, portable, foreground expressions qualify', () => {
  assert.deepEqual(portablePlan('pwsh',{command:'Start-Sleep -Seconds 3; '+checksum}),{op:'sha256-upper',ms:3000,file:'my.bin'});
  assert.deepEqual(portablePlan('bash',{command:"wc -c < 'relay-inputs/my.bin'"}),{op:'bytes',ms:0,file:'my.bin'});
  for (const args of [{command:checksum+'; Remove-Item x'}, {command:checksum,workdir:'C:\\'},
    {command:checksum,sandbox_permissions:'require_escalated'},{command:checksum,run_in_background:true},
    {command:checksum.replace('my.bin','../a.bin')},{command:'Start-Sleep -Seconds 123',timeoutMs:500},
    {command:'Start-Sleep -Seconds 2; Invoke-WebRequest https://localhost'}, {command:'Get-Process'}]) assert.equal(portablePlan('pwsh',args),undefined);
});

test('ordinary native dispatch waits for durable acknowledgement and does not bypass the real tool',async () => {
  const frames=[]; let run, invoked=0, reply='armed';
  const ctx={on:(_name,fn)=>{run=fn;},effect:()=>{},tools:{get:()=>({output:{schema:{oneOf:[{properties:{kind:{const:'foreground'}}}]}}})},workspaceRegistry:{list:()=>[{sessionIds:['s']}],archivedSessionIds:[]}};
  const channel={stop(){},async send(v){frames.push(v);return v==='hello-v1'?'ready-v1':typeof v==='string'?'ok':reply;}};
  registerPortableSteps(ctx,'fixture',()=>channel);
  const exec={agent:{session:{id:'s'}},name:'pwsh',callId:'c1',arguments:{command:"Write-Output 'hello'"},signal:new AbortController().signal};
  const result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'hello\r\n'}}};
  assert.equal(await run(exec,async()=>{invoked++;assert.equal(frames[1].op,'line');return result;}),result);
  assert.equal(frames[2],'completed');reply='duplicate';
  await assert.rejects(run(exec,()=>{invoked++;}));assert.equal(invoked,1);
  exec.arguments={command:'Get-Process'};assert.equal(await run(exec,()=>42),42);assert.equal(frames.length,5);
});
