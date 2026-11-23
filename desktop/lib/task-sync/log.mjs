import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify, isDeepStrictEqual } from 'node:util';

const compress = promisify(gzip), expand = promisify(gunzip);
const maxLog = 192 * 1024 * 1024;
export const maxPacket = 32 * 1024 * 1024;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const validID = id => typeof id === 'string' && /^[\w-][\w.-]{0,159}$/.test(id) && !id.includes('..');
export const packetName = (role, id) => hash(role + ':' + id) + '.json';

// The standby log may be opened by a real agent. A queued prompt is live work
// even before turn/start (or after turn/end if another prompt was queued).
// Keep that suffix in the checkpoint packet, not in the standby's runnable inbox.
export function committedLength(events) {
  let closed = 0, inTurn = false;
  const pending = new Map([['next-turn', 0], ['next-step', 0]]);
  for (const [i, event] of events.entries()) {
    if (event.type === 'turn/start') inTurn = true;
    if (event.type === 'turn/end') inTurn = false;
    if (event.type === 'agent/inbox/spliced') {
      const {target, start, removedCount = 0, inserted} = event.data ?? {};
      const size = pending.get(target);
      if (size === undefined || !Number.isSafeInteger(start) || start < 0 || start > size ||
          !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > size ||
          !Array.isArray(inserted)) throw Error('Invalid pending task queue');
      pending.set(target, size - removedCount + inserted.length);
    }
    if (!inTurn && !pending.get('next-turn') && !pending.get('next-step')) closed = i + 1;
  }
  return closed;
}

export async function pack(origin, workspace, header, inherited, archived, events) {
  const { cwd, ...meta } = header; // Never use another machine's path as a local filesystem destination.
  const bytes = Buffer.from(JSON.stringify(events));
  if (bytes.length > maxLog) throw Error('Session exceeds uncompressed log limit');
  const data = (await compress(bytes, {level: 3})).toString('base64');
  const packet = {v:2, origin, source:header.id, workspace, meta, inherited, archived, data};
  if (Buffer.byteLength(JSON.stringify(packet)) > maxPacket) throw Error('Session exceeds transport limit');
  return packet;
}

export async function unpack(packet, peer, name) {
  const {meta, workspace, inherited, source} = packet;
  if (packet.v !== 2 || packet.origin !== peer || !validID(source) || meta?.id !== source ||
      packetName(peer, source) !== name || !Number.isSafeInteger(meta.createdAt) || meta.createdAt < 0 ||
      typeof meta.isSeeded !== 'boolean' || !Number.isSafeInteger(inherited) || inherited < 0 ||
      typeof packet.archived !== 'boolean' || !['desktop','cloud'].includes(workspace?.owner) ||
      !validID(workspace.key) || typeof workspace.title !== 'string' || workspace.title.length > 256 ||
      typeof packet.data !== 'string' || packet.data.length > maxPacket) throw Error('Invalid task envelope');
  if (packet.encoding === 'legacy-v3-zstd') return null;
  if (packet.encoding !== undefined) throw Error('Unknown task encoding');
  const raw = await expand(Buffer.from(packet.data, 'base64'), {maxOutputLength:maxLog});
  const events = JSON.parse(raw);
  if (!Array.isArray(events) || inherited > events.length || events.some((e,i) => !e || e.seq !== i || typeof e.type !== 'string')) throw Error('Invalid task log');
  if (packet.commandEnd !== undefined) {
    const end = packet.commandEnd;
    if (peer !== 'desktop' || !packet.cloudIntent || end?.seq !== events.length || end.type !== 'command/done' ||
        !Number.isSafeInteger(end.time) || end.data?.kind !== 'success' ||
        events.at(-1)?.type !== 'command/run' || events.at(-1).data.commandId !== end.data.commandId ||
        packet.cloudIntent.command !== end.data.commandId) throw Error('Invalid protected task boundary');
    events.push(end);
  }
  return events;
}

// Never splice two concurrent histories together. Recheck after acquiring the native writer.
export function comparePrefix(local, remote) {
  for (let i = 0, n = Math.min(local.length, remote.length); i < n; i++) {
    if (!isDeepStrictEqual(local[i], remote[i])) throw Error('Divergent task histories; both originals retained');
  }
  return remote.length - local.length;
}
