import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSnapshot, applyModelSnapshot} from '../lib/task-sync/models.mjs';

function fixture(model) {
  return [
    {ns:'unrelated',value:{password:'not for export'}},
    {ns:'llm-deepseek',value:{models:[{id:'default'}]}},
    {ns:'llm-deepseek-account',value:{modelOverrides:{}}},
    {ns:'llm-pi-ai',value:{providers:{demo:{api:'anthropic-messages',apiKeyEnv:'DEMO_API_KEY',baseURL:'https://example.invalid/v1',models:[{id:model}],headers:{Authorization:'not for export'}}}}},
    {ns:'agent-default-model',value:{provider:'demo',model,reasoningEffort:'high'}}
  ].map(r => ({...r,revision:9}));
}

test('desktop model changes precede the default, are idempotent, and never export private headers',async() => {
  const snapshot = modelSnapshot(fixture('next'));
  assert.ok(!JSON.stringify(snapshot).includes('not for export'));
  const cloud = fixture('old');
  const ops = [];
  const settings = {describe(options){assert.ok(options.redactSecrets);return cloud;},async mutate(ns,edits,revision){
    const row = cloud.find(r=>r.ns===ns);
    assert.equal(row.revision++,revision); ops.push(ns);
    for (const {path,value,op} of edits) {
      const target = path.slice(0,-1).reduce((obj,key)=>obj[key],row.value);
      if (op==='set') target[path.at(-1)] = structuredClone(value); else delete target[path.at(-1)];
    }
  }};
  await applyModelSnapshot(settings,JSON.parse(JSON.stringify(snapshot)));
  await applyModelSnapshot(settings,snapshot);
  assert.deepEqual(ops,['llm-pi-ai','agent-default-model']);
  assert.equal(cloud.find(r=>r.ns==='llm-pi-ai').value.providers.demo.headers.Authorization,'not for export');
  const desktop = fixture('next'); desktop.find(r=>r.ns==='llm-pi-ai').value.providers={};
  await assert.rejects(applyModelSnapshot(settings,modelSnapshot(desktop)),/private headers/);
  delete cloud.find(r=>r.ns==='llm-pi-ai').value.providers.demo.headers;
  await applyModelSnapshot(settings,modelSnapshot(desktop));
  assert.deepEqual(cloud.find(r=>r.ns==='llm-pi-ai').value.providers,{});
});

test('rejects credential-bearing URLs, injected settings and config expressions before writing',async()=>{
  const rows=fixture('safe'); const route=rows.find(r=>r.ns==='llm-pi-ai').value.providers.demo;
  for (const url of ['https://user:pw@example.invalid','https://example.invalid?key=abc','file:///etc/hosts']) {
    route.baseURL=url; assert.throws(()=>modelSnapshot(rows),/non-portable/);
  }
  route.baseURL='https://example.invalid';
  route.models=[{id:'safe',compat:{__jsExpr:'unexpected'}}]; assert.throws(()=>modelSnapshot(rows));
  const injected=modelSnapshot(fixture('safe')); injected.sections['llm-pi-ai'].providers.demo.headers={Authorization:'secret'};
  await assert.rejects(applyModelSnapshot({describe(){throw Error('must not run');}},injected),/non-portable/);
});
