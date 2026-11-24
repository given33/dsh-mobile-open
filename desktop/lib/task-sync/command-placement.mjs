import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash, validID } from './log.mjs';
import { join } from 'node:path';

// Placement is an operator choice outside the project; repository files, prompts,
// and tool output cannot route a command. Do not infer safety by parsing a shell.
export function commandSpec(name, args) {
  if (!['pwsh','bash'].includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (Object.keys(args).some(k => !['command','description','timeoutMs','run_in_background'].includes(k))) return null;
  if (args.run_in_background !== undefined && args.run_in_background !== false) return null;
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') || Buffer.byteLength(args.command) > 8192) return null;
  if (args.description !== undefined && typeof args.description !== 'string') return null;
  if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0)) return null;
  return {shell:name, command:args.command, ...(args.timeoutMs !== undefined ? {timeoutMs:args.timeoutMs} : {})};
}

export function eventSpec(call) {
  try {
    const args = call?.data?.arguments;
    return commandSpec(call?.data?.name, typeof args === 'string' ? JSON.parse(args) : args);
  } catch { return null; }
}

async function readSetting(path, limit) {
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw Error('接力执行位置配置不是有效的普通文件。');
    const buf = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buf.length) {
      const {bytesRead} = await file.read(buf, size, buf.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw Error('接力执行位置配置过大。');
    return buf.toString('utf8', 0, size).replace(/^\uFEFF/, '');
  } finally { await file.close(); }
}

function sessionFile(root, role, workspaceID, sessionID) {
  return join(root, 'shell-placement', hash(JSON.stringify([role, workspaceID, sessionID])));
}

export async function placedOnPeer(root, role, workspaceID, spec, sessionID) {
  if (sessionID) {
    const setting = await readSetting(sessionFile(root, role, workspaceID, sessionID), 16);
    if (setting === 'peer') return true;
    if (setting === 'local') return false;
    if (setting !== null) throw Error('无法核实本会话的执行位置。');
  }
  const config = await readSetting(join(root, 'relay-placement.json'), 128 * 1024);
  if (config === null) return false;
  const list = JSON.parse(config)[`${role}:${workspaceID}`]?.[spec.shell];
  if (list === undefined) return false;
  if (!Array.isArray(list) || list.length > 256 || list.some(c => typeof c !== 'string' || !c.trim())) throw Error('接力执行位置配置无效。');
  return list.includes(spec.command);
}

// Called only by the authenticated owner panel, never as a model tool or on log import.
export async function sessionPlacement(root, role, workspaceID, sessionID, value) {
  if (!validID(sessionID) || !validID(workspaceID)) throw Error('无效的会话或工作区。');
  const path = sessionFile(root, role, workspaceID, sessionID);
  if (value === undefined) {
    const stored = await readSetting(path, 16);
    if (stored !== null && !['local', 'peer'].includes(stored)) throw Error('无法核实本会话的执行位置。');
    return stored ?? 'default';
  }
  if (value === 'default') {
    try { await unlink(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  } else {
    if (!['peer', 'local'].includes(value)) throw Error('无效的终端执行位置。');
    await mkdir(join(root, 'shell-placement'), {recursive:true, mode:0o700});
    const tmp = path + '.' + randomUUID();
    try {
      await writeFile(tmp, value, {flag:'wx', mode:0o600, flush:true});
      await rename(tmp, path);
    } finally { await unlink(tmp).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
  }
  return value;
}

export const stoppedMarker = nonce => `DSH-PLACEMENT/1 ${nonce} · 本机未启动命令，已登记给配对设备`;
// This is a native foreground stop with no exit code and no stdout, not a
// fabricated successful shell run. Both 0.2.3-alpha.2 shell renderers expose it.
export const placedReceipt = nonce => `(no output)\n[stopped: ${stoppedMarker(nonce)}]\n[exit code: null]`;
export function stoppedValue(nonce, cwd, timeoutMs) {
  return {kind:'foreground', cwd, exitCode:null, signal:null, timedOut:false, aborted:false,
    stopped:stoppedMarker(nonce), timeoutMs:timeoutMs ?? 0,
    stdout:{text:'',truncated:false}, stderr:{text:'',truncated:false}};
}
