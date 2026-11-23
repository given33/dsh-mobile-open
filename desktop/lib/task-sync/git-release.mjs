import { createHash } from 'node:crypto';

export const releaseTool = 'relay_git_release_plan';
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const branchName = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,159}$/;
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function validateRelease({remote,branch,base,desired,identity}) {
  if (!identifier.test(remote ?? '') || !branchName.test(branch ?? '') || branch.includes('..') ||
      branch.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock')) ||
      ![base,desired,identity].every(x => typeof x === 'string' && objectId.test(x) && !/^0+$/.test(x) && x.length === base.length) || base === desired) {
    throw Error('Invalid Git release specification: use a named remote, a branch and full object IDs');
  }
}

export function releaseOperation(session,callId) {
  return createHash('sha256').update(JSON.stringify(['dsh-git-release/1',session,callId])).digest('hex');
}

// An annotated tag retains the desired commit and its trees on the server, even
// when the source disappears before the release branch is updated. Both machines
// can independently recompute the exact Git object ID without trusting tag text.
export function releasePlan(spec,operation) {
  validateRelease(spec);
  if (!/^[0-9a-f]{64}$/.test(operation)) throw Error('Invalid Git release operation ID');
  const {identity,branch,base,desired} = spec;
  const descriptor = `object ${desired}\ntype commit\ntag dsh-relay-v1\ntagger DSH Relay <relay@invalid> 1 +0000\n\n` +
    JSON.stringify({version:1,identity,operation,branch,base,desired}) + '\n';
  const digest = createHash(base.length === 40 ? 'sha1' : 'sha256')
    .update(`tag ${Buffer.byteLength(descriptor)}\0`).update(descriptor).digest('hex');
  return {descriptor,digest,branchRef:'refs/heads/'+branch,planRef:'refs/dsh-relay/plans/'+operation,
    receiptRef:'refs/dsh-relay/receipts/'+operation};
}
