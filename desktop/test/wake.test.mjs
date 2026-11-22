import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadIdentity } from '../lib/identity.mjs';
import { DeviceRegistry } from '../lib/devices.mjs';
import { createWakeServer, wakeRoutes } from '../lib/wake.mjs';

test('wake is a distinct opt-in fixed launch; live policy, cooldown and revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dsh-wake-')); await loadIdentity(dir);
  const devices = await new DeviceRegistry(dir).load(); const {token,device} = await devices.add({});
  let launches = 0; const server = await createWakeServer(dir, () => { launches++; });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const {port}=server.address();
  t.after(async () => { await new Promise(r=>server.close(r)); await rm(dir,{recursive:true,force:true}); });
  const set = (name,value) => writeFile(join(dir,name+'.json'), JSON.stringify(value));
  const request = (headers={}, path='/mobile/v1/wake', body='') => new Promise((resolve,reject) => {
    const req=https.request({host:'127.0.0.1',port,path,method:'POST',agent:false,rejectUnauthorized:false,headers:{'Content-Length':Buffer.byteLength(body),...headers}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end(body);
  });
  const auth={Authorization:'Bearer '+token}; await set('settings',{enabled:true});
  assert.equal(await wakeRoutes(dir),null); assert.equal(await request(auth),403);
  await set('wake',{enabled:true,port}); assert.deepEqual(await wakeRoutes(dir),{port,publicPort:null});
  assert.equal(await request(),401); assert.equal(await request(auth,'/other'),404);
  assert.equal(await request(auth,undefined,'{}'),400); assert.equal(launches,0);
  assert.equal(await request(auth),202); assert.equal(await request(auth),202); assert.equal(launches,1);
  await set('settings',{enabled:false}); assert.equal(await request(auth),403);
  await set('settings',{enabled:true}); await devices.remove(device.id); assert.equal(await request(auth),401);
  assert.equal(launches,1);
});
