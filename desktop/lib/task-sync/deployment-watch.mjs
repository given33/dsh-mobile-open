// The model can read an existing observation but cannot add a target, cause a
// network request, choose an address, or enable credentials. This works even if
// the native shell is isolated from the plugin's code and host network.
import { join } from 'node:path';
import { bindDeployment, deploymentIdentity } from './deployment-ref.mjs';
import { inspectDeployment } from '../../tools/relay-deployment-status.mjs';
import { validID } from './log.mjs';
import { readSetting } from './command-placement.mjs';

const minute=60_000;
const identityKey=(sid,spec)=>JSON.stringify([sid,deploymentIdentity(spec)]);

function configured(text) {
  const targets=new Map();
  if (text===null) return targets;
  const entries=JSON.parse(text);
  if (!Array.isArray(entries) || entries.length>8) throw Error('Invalid deployment watch list');
  for (const row of entries) {
    if (!validID(row?.sessionId) || !row.target?.deploymentId) throw Error('An owner watch needs a session and exact deployment ID');
    const spec=deploymentIdentity(row.target);
    targets.set(identityKey(row.sessionId,spec),bindDeployment(spec,row.sessionId,'owner-watch').ticket);
  }
  return targets;
}

export function deploymentWatch(root, inspect=inspectDeployment, clock=Date.now) {
  const policy=join(root,'deployment-watch.json'), cache=new Map();
  let running=false, stopped=false, allowed=new Map();
  const controller=new AbortController();
  return {
    stop() { stopped=true; controller.abort(); allowed.clear(); cache.clear(); },
    async tick() {
      if (running || stopped) return;
      running=true;
      try {
        let targets;
        try { targets=configured(await readSetting(policy,32*1024)); }
        catch { targets=new Map(); }
        if (stopped) return;
        allowed=targets;
        for (const key of cache.keys()) if (!targets.has(key)) cache.delete(key);
        // Limit outstanding provider requests; terminal receipts change rarely.
        // Revalidate successes too: GitHub can later mark a deployment inactive.
        for (const [key,ticket] of targets) {
          if ((cache.get(key)?.next ?? 0)>clock()) continue;
          let result;
          try { result=await inspect(ticket,undefined,controller.signal); }
          catch { result={state:'unconfirmed',reason:'read-failed',retryDeployment:false}; }
          if (stopped) return;
          const {state,reason,statusId,statusCreatedAt,deploymentId}=result;
          let ttl = ['pending','queued','in-progress'].includes(state) ? 5*minute : 30*minute;
          if (state==='unconfirmed') ttl=['http-403','http-429'].includes(reason) ? 65*minute : 10*minute;
          const at=clock();
          cache.set(key,{next:at+ttl,observation:{state,reason,statusId,statusCreatedAt,deploymentId,
            retryDeployment:false,observedAt:new Date(at).toISOString(),recheckAfter:new Date(at+ttl).toISOString()}});
        }
      } finally { running=false; }
    },
    async forSession(sid,refs) {
      if (!refs.length || stopped) return [];
      // Revocation must take effect on the next read, even between poll ticks.
      let current;
      try { current=configured(await readSetting(policy,32*1024)); } catch { return []; }
      const records=[];
      for (const ref of refs) {
        const d = ref.deploymentId && readIdentity(ref);
        if (!d) continue;
        const key=identityKey(sid,d), entry=cache.get(key);
        if (!current.has(key)) continue;
        if (allowed.has(key) && entry && entry.next>clock()) records.push({referenceOperation:ref.operation,...entry.observation});
        else records.push({referenceOperation:ref.operation,state:'unconfirmed',reason:'awaiting-owner-observation',retryDeployment:false});
      }
      return records;
    },
  };
}
function readIdentity(ref) {
  const {provider,operation,ticket,sourceCallSeq,...spec}=ref;
  return deploymentIdentity(spec);
}
