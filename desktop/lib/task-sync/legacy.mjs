// An old file may be listable in DSH even if its v3 → v4 migration refuses a
// malformed tool chain. Never invent a tool result or edit the source to make it pass.
import { readFile, mkdir, writeFile, link, unlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import { maxPacket, validID } from './log.mjs';

const filename = 'session.v3.jsonl.zstd';
// DSH stores each record in an independent Zstandard frame. Node releases differ
// in whether the one-shot decoder consumes concatenated frames (RFC 8878 §3.1).
export function headerFrameLength(bytes) {
  if (bytes.length < 6 || bytes.readUInt32LE(0) !== 0xfd2fb528) throw Error('Not a Zstandard session header');
  const flags = bytes[4], single = (flags & 32) !== 0;
  let offset = 5 + (single ? 0 : 1) + [0,1,2,4][flags & 3] + [single ? 1 : 0,2,4,8][flags >> 6];
  let last;
  do {
    const block = bytes.readUIntLE(offset,3), type = (block >> 1) & 3;
    if (type === 3) throw Error('Invalid Zstandard header block');
    offset += 3 + (type === 1 ? 1 : block >> 3);
    last = (block & 1) !== 0;
  } while (!last);
  if (flags & 4) offset += 4;
  if (offset > bytes.length || offset > 1024*1024) throw Error('Truncated or oversized session header');
  return offset;
}

export function relocateLegacy(bytes, meta, cwd) {
  const length = headerFrameLength(bytes);
  const buffer = zlib.zstdDecompressSync(bytes.subarray(0,length),{maxOutputLength:1024*1024});
  const original = JSON.parse(buffer.toString('utf8'));
  if (original.type !== 'session' || original.version !== 3 || original.id !== meta.id || original.createdAt !== meta.createdAt) throw Error('Mismatched historical session header');
  const header = zlib.zstdCompressSync(Buffer.from(JSON.stringify({...original,cwd})+'\n'));
  return Buffer.concat([header,bytes.subarray(length)]);
}

export async function readLegacy(record) {
  const path = record.location?.path;
  if (record.formatStatus !== 'migration-required' || !path || basename(path) !== filename || dirname(path).split(/[\\/]/).at(-1) !== record.header.id || (await stat(path)).size > maxPacket * 0.7) throw Error('Unsupported historical artifact');
  return (await readFile(path)).toString('base64');
}

export async function installLegacy(store, packet, project) {
  // Only the native JSONL/zstd backend understands this physical generation.
  // Publish to its project bucket with a no-replace hard link, never truncate a session file.
  const config = store.config;
  if (!config?.root || (config.compression && config.compression !== 'zstd') || !validID(packet.source)) throw Error('Historical session requires DSH JSONL storage');
  const root = await realpath(config.root);
  const slug = project.path.replace(/[\\/:]+/g,'-').replace(/[^\w.-]/g,c=>'~'+c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')).replace(/^-+/,'') || 'root';
  const folder = join(root,'--'+slug.slice(0,251)+'--',packet.source);
  const bytes = relocateLegacy(Buffer.from(packet.data,'base64'),packet.meta,project.path);
  await mkdir(folder,{recursive:true,mode:0o700});
  if (resolve(await realpath(folder)) !== resolve(folder)) throw Error('Unexpected historical storage symlink');
  const temp = join(folder,randomUUID()+'.tmp');
  try {
    await writeFile(temp,bytes,{flag:'wx',mode:0o600});
    await link(temp,join(folder,filename));
  } finally { await unlink(temp).catch(()=>{}); }
}
