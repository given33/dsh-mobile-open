// Catalogue entries identify a project, never a path on the other machine.
import { readFile, stat } from 'node:fs/promises';
import { validID } from './log.mjs';

export const catalogName = 'workspace-catalog.json';
export const maxCatalog = 1024 * 1024;

export async function optionalJson(file) {
  try {
    if ((await stat(file)).size > maxCatalog) throw Error('Oversized workspace metadata');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export function catalogRoutes(data, owner) {
  if (data?.v !== 1 || data.owner !== owner || !Array.isArray(data.workspaces) || data.workspaces.length > 4096) {
    throw Error('Invalid workspace catalogue');
  }
  const keys = new Set();
  return data.workspaces.map(({key, title}) => {
    if (!validID(key) || keys.has(key) || typeof title !== 'string' || !title.trim() || title.length > 256) {
      throw Error('Invalid workspace catalogue entry');
    }
    keys.add(key);
    return {owner, key, title};
  });
}

// Operator-selected identities from a discontinued deployment. Never match titles:
// a normal user project may have exactly the same display name as an old bucket.
export function retiredRoutes(data) {
  const keys = new Set();
  if (data === null) return keys;
  for (const role of ['desktop', 'cloud']) {
    const ids = data[role];
    if (!Array.isArray(ids) || ids.length > 4096 || !ids.every(validID)) throw Error('Invalid retired workspace IDs');
    for (const id of ids) keys.add(role + ':' + id);
  }
  return keys;
}

// An untouched DSH composer can already have these initial settings on disk.
// Anything else (including a queued prompt, title, tool, or unknown event) is user history.
const initialSettings = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
export async function mayUnregister(ctx, project, signal) {
  for (const id of project.sessionIds) {
    if (ctx.get?.('sessions')?.get(id)) return false;
    const reader = await ctx.sessionPersistence.open(id, 'read', {signal});
    try {
      if ((await reader.read()).events.some(event => !initialSettings.has(event.type))) return false;
    } finally { await reader.close(); }
  }
  return true;
}

// A route is a logical workspace ID, independent of which host edited its name.
export function titleRevisions(catalogue) {
  const list = catalogue?.titles ?? [];
  if (!Array.isArray(list) || list.length > 8192) throw Error('Invalid shared workspace titles');
  const titles = new Map();
  for (const rev of list) {
    if (!['desktop','cloud'].includes(rev?.owner) || !validID(rev.key) || !['desktop','cloud'].includes(rev.actor) ||
        !Number.isSafeInteger(rev.clock) || rev.clock < 1 || rev.clock >= Number.MAX_SAFE_INTEGER ||
        typeof rev.title !== 'string' || !rev.title.trim() || rev.title.length > 256) throw Error('Invalid shared workspace title');
    const key = `${rev.owner}:${rev.key}`;
    if (titles.has(key)) throw Error('Duplicate shared workspace title');
    titles.set(key,rev);
  }
  return titles;
}
