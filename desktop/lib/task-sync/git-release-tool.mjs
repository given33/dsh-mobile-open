import { fileURLToPath } from 'node:url';
import { releaseOperation, releasePlan, releaseTool } from './git-release.mjs';
import { validID } from './log.mjs';

const keys = ['remote','branch','identity','base','desired'];
export const gitReleaseHelper = fileURLToPath(new URL('../../tools/relay-git-release.mjs',import.meta.url));
export function plannedRelease(spec,session,callId) {
  if (!validID(session) || !validID(callId) || !spec || keys.some(k=>typeof spec[k] !== 'string')) throw Error('Invalid release intent');
  const operation = releaseOperation(session,callId);
  const plan = releasePlan(spec,operation);
  return {operation,remote:spec.remote,branch:spec.branch,identity:spec.identity,base:spec.base,desired:spec.desired,planObject:plan.digest};
}
export function registerGitReleasePlan(ctx,output) {
  ctx.tools.register({name:releaseTool,output,
    parameters:{type:'object',properties:Object.fromEntries(keys.map(k=>[k,{type:'string'}])),required:keys,additionalProperties:false},
    description:'Record a stable Git release intent for an already authorized, operator-enabled release branch. No read, push or deployment is performed. Use full object IDs and the pinned target identity. Never mint a new operation to retry a prior plan.',
    async execute(spec,exec) {
      if (exec.parent) throw Error('Record the release plan as a direct native tool call');
      const intent = plannedRelease(spec,exec.agent?.session?.id,exec.callId);
      return JSON.stringify({...intent,helper:gitReleaseHelper,argumentOrder:['action','remote','branch','operation','identity','base','desired']});
    }});
}
