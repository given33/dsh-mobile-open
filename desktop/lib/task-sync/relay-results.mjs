import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchState } from './cloud-turn.mjs';
import { hash } from './log.mjs';
import { nativeAcceptance } from './relay-evidence.mjs';
import { namesAllowed, projectHelper } from './relay-inputs.mjs';

const helper = fileURLToPath(new URL('./result_delivery.py', import.meta.url));
const outputFile = /\.(?:txt|md|csv|json|pdf|png|jpe?g|webp|xlsx|docx)$/i;
const safePart = /^[a-z\d][a-z\d._-]{0,63}$/i;
const planDir = (root, sid) => join(root, 'result-plans', hash(sid));
const planPath = (root, sid, key) => join(planDir(root, sid), key + '.json');

function validNames(names) {
  if (!namesAllowed(names) || !names.length || names.length > 16) return false;
  return names.every(name => {
    const parts = name.split('/');
    return name.length <= 160 && parts.length >= 2 && parts.length <= 6 && ['reports','artifacts','dist'].includes(parts[0]) &&
      parts.every(part => safePart.test(part)) && outputFile.test(parts.at(-1));
  });
}

export async function authorizeResults(root, role, project, route, mode, sid, key) {
  if (route.owner !== role || mode === 'read-only') return;
  let policy;
  try { policy = JSON.parse(await readFile(join(root, 'relay-outputs.json'), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  const routeName = `${role}:${route.key}`, names = policy[routeName];
  if (names === undefined) return;
  if (!validNames(names)) throw Error('工作区回传文件清单无效。');
  await projectHelper(helper, 'grant', root, {owner: role, route: routeName, folder: project.path, session: hash(sid), names}, key);
  return names;
}

export async function ownerResultStatus(root, role, sid) {
  try { await stat(join(root, 'result-mailbox.sqlite')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return projectHelper(helper, 'session-status', root, {owner: role}, hash(sid));
}

export async function rememberResultPlan(root, packet, key, sourceLength, canWrite) {
  const names = packet.relayOutputs;
  if (names === undefined) return;
  if (!validNames(names) || !canWrite || packet.workspace.owner !== packet.origin) throw Error('Cannot return artifacts for this handoff');
  const plan = {names, owner: packet.origin, route: packet.origin + ':' + packet.workspace.key, sourceLength};
  const dir = planDir(root, packet.source);
  await mkdir(dir, {recursive: true, mode: 0o700});
  const tmp = join(dir, randomUUID() + '.tmp');
  try {
    await writeFile(tmp, JSON.stringify(plan), {flag: 'wx', mode: 0o600, flush: true});
    await rename(tmp, planPath(root, packet.source, key));
  } finally { await unlink(tmp).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
  if (process.platform !== 'win32') {
    const fd = await open(dir, 'r');
    try { await fd.sync(); } finally { await fd.close(); }
  }
}

export async function resultInstructions(root, sid, key) {
  let plan;
  try { plan = JSON.parse(await readFile(planPath(root, sid, key), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  return {
    directory: 'dsh-returns/' + key, files: plan.names,
    instruction: 'For each requested result actually produced in this turn, copy its final bytes to <directory>/<relative filename> within this workspace using the approved native shell. Do not fabricate missing files. A successfully completed turn publishes the full set. File delivery is not a receipt for an external deployment.',
  };
}

export function terminalResult(events, inherited, sourceLength, key) {
  const accepted = nativeAcceptance(events, inherited, key, sourceLength);
  if (!accepted) return null;
  const request = events.find(e => e.seq >= accepted.seq && e.type === 'user/message' && e.data?.id === accepted.messageId && e.data.source?.rpcId === key);
  if (!request) return null;
  const start = events.slice(sourceLength, request.seq + 1).findLast(e => e.type === 'turn/start');
  const end = events.find(e => e.seq > request.seq && e.type === 'turn/end');
  if (!end) return null;
  if (!start || end.data.turn !== start.data.turn || end.data.reason?.kind !== 'completed') return 'skip';
  // Native DSH also emits user/message for injected environment context; this is
  // not a second human request. A real intervening prompt invalidates attribution.
  const steered = events.some(e => e.seq > request.seq && e.seq < end.seq && e.type === 'user/message' && ['user','retry'].includes(e.data?.source?.kind));
  return steered ? 'skip' : 'capture';
}

export async function finishResultPlans(root, sid, events, inherited, role) {
  const dir = planDir(root, sid);
  let entries;
  try { entries = await readdir(dir); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  for (const name of entries) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const key = name.slice(0,-5), path = join(dir, name);
    const plan = JSON.parse(await readFile(path, 'utf8'));
    if (plan.owner === role || await dispatchState(root, key) === 'ready') continue;
    const state = terminalResult(events, inherited, plan.sourceLength, key);
    if (!state) continue;
    await projectHelper(helper, state, root, plan, key);
    await unlink(path);
  }
}
