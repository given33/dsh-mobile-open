import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const id = /^[A-Za-z0-9_-]{8,64}$/;
const pin = /^[A-Za-z0-9_-]{43}$/;
export async function cloudRoute(dir, desktopID, device) {
  if (!dir || !device || device.delegated) return null;
  let route;
  try { route = JSON.parse(await readFile(join(dir, 'family-route.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (route.familyID !== desktopID || !id.test(route.cloudID) || route.cloudID === desktopID || !pin.test(route.fingerprint)
      || !/^[a-z0-9.-]+:[0-9]{1,5}$/i.test(route.endpoint)) throw Error('Invalid family route');
  // The cloud receives only a verifier for a domain-separated credential, never the PC bearer or its verifier.
  const scope = ['dsh-cloud/v1', desktopID, route.cloudID, route.fingerprint, device.id].join(':');
  const token = createHmac('sha256', Buffer.from(device.tokenHash, 'base64url')).update(scope).digest('base64url');
  return { familyID: desktopID, endpoint: route.endpoint, fingerprint: route.fingerprint, desktop: {id: route.cloudID, name: '云端'}, token };
}

export async function familyDevices(dir, identity) {
  const policy = JSON.parse(await readFile(join(dir, 'family-policy.json'), 'utf8'));
  const grants = JSON.parse(await readFile(join(dir, 'family-grants.json'), 'utf8'));
  if (policy.cloudID !== identity.id || grants.cloudID !== identity.id || grants.fingerprint !== identity.fingerprint ||
      !id.test(policy.familyID) || grants.familyID !== policy.familyID || !Array.isArray(grants.hashes) || grants.hashes.length > 32) return [];
  return grants.hashes.map(h => {
    if (!pin.test(h)) throw Error('Invalid family verifier');
    // Changes on re-pair: browser cookies and open sockets tied to the old grant are invalidated as well.
    return { id: 'grant-' + createHash('sha256').update(h).digest('hex').slice(0,32), tokenHash: h, name: '已配对手机', delegated: true };
  });
}
