import { fileURLToPath } from 'node:url';
import { hash, validID } from './log.mjs';

export const deploymentTool = 'relay_deployment_ref';
export const deploymentHelper = fileURLToPath(new URL('../../tools/relay-deployment-status.mjs', import.meta.url));
const text = {type:'string'};
const fields = ['repository','repositoryId','environment','sha','deploymentActor','statusActor'];
const decimalID = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));

export function deploymentIdentity(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(k=>!fields.includes(k) && k!=='deploymentId') ||
      typeof input.repository !== 'string' || !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d][a-z\d._-]{0,99}$/i.test(input.repository) ||
      typeof input.environment !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}$/u.test(input.environment) ||
      typeof input.sha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sha) || /^0+$/.test(input.sha) ||
      ![input.repositoryId,input.deploymentActor,input.statusActor].every(decimalID) ||
      (input.deploymentId !== undefined && !decimalID(input.deploymentId))) throw Error('Invalid GitHub deployment reference');
  return Object.fromEntries([...fields,...(input.deploymentId ? ['deploymentId'] : [])].map(k=>[k,input[k]]));
}

export function bindDeployment(input, sessionId, callId) {
  if (!validID(sessionId) || !validID(callId)) throw Error('Invalid deployment reference origin');
  const identity = deploymentIdentity(input);
  const operation = hash(JSON.stringify(['dsh-deployment/v1',sessionId,callId,identity]));
  const ticket = Buffer.from(JSON.stringify({v:1,operation,identity})).toString('base64url');
  return {provider:'github-deployments',...identity,operation,ticket};
}

export function readTicket(ticket) {
  if (typeof ticket !== 'string' || !/^[\w-]{1,2048}$/.test(ticket)) throw Error('Invalid verification ticket');
  const raw = Buffer.from(ticket,'base64url');
  if (raw.toString('base64url') !== ticket) throw Error('Invalid verification ticket encoding');
  const data = JSON.parse(raw);
  if (data?.v !== 1 || typeof data.operation !== 'string' || !/^[0-9a-f]{64}$/.test(data.operation)) throw Error('Invalid verification ticket version or operation');
  return {identity:deploymentIdentity(data.identity),operation:data.operation};
}

// A successful *reference* records what to inspect; it never claims the deployment happened.
// Match native call and result, not copied JSON in a user message, model answer or shell output.
export function savedDeployments(events, inherited, sessionId) {
  const refs = [], pending = new Map();
  for (let i = inherited; i < events.length; i++) {
    const e = events[i], d = e.data;
    if (e.type === 'tool/call' && d.name === deploymentTool) {
      try {
        const spec = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
        const ref = bindDeployment(spec,sessionId,d.callId);
        pending.set(JSON.stringify([d.turn,d.step,d.callId]),{ref,callSeq:e.seq});
      } catch { /* Not an accepted tool input. */ }
    } else if (e.type === 'tool/result' && pending.size) {
      const msg = d.message, key = JSON.stringify([d.turn,d.step,msg?.toolCallId]);
      const saved = pending.get(key);
      if (!saved) continue;
      pending.delete(key);
      if (msg.role === 'tool' && msg.isError === false && msg.content?.length === 1 && msg.content[0].type === 'text' &&
          msg.content[0].text === JSON.stringify(saved.ref)) {
        refs.push({...saved.ref,sourceCallSeq:saved.callSeq});
        if (refs.length > 12) refs.shift();
      }
    } else if (e.type === 'turn/end') pending.clear();
  }
  return refs;
}

export function registerDeploymentRef(ctx, output) {
  ctx.tools.register({name:deploymentTool, output,
    parameters:{type:'object',properties:Object.fromEntries([...fields,'deploymentId'].map(k=>[k,text])),required:fields,additionalProperties:false},
    description:'Record a read-only GitHub Deployment reference for the original authorized task. Supply the exact repository slug and numeric repository ID, commit SHA, environment and expected deployment/status creator account IDs from the authorized target, not guesses. Prefer a known deploymentId. Without an ID, an already-authorized rollout must include payload.dshRelayOperation=operation to be discoverable if its creation response is lost. This records a target; never creates, submits or retries a deployment.',
    async execute(args,exec) {
      if (exec.parent) throw Error('Record a deployment reference as a direct tool call');
      return JSON.stringify(bindDeployment(args,exec.agent?.session?.id,exec.callId));
    },
  });
}
