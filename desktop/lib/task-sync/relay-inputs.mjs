import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { open, link, lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './log.mjs';

const limit = 8 * 1024 * 1024;
const maxWire = 12 * 1024 * 1024;
const inputHelper = fileURLToPath(new URL('./project_inputs.py', import.meta.url));
const sensitive = /(credential|secret|password|token|private[-_]?key)|\.(env|pem|pfx|key|p12|kdbx)$/i;
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]) *(\.|$)/i;

export function namesAllowed(names) {
  if (!Array.isArray(names) || names.length > 256) return false;
  const paths = new Map();
  for (const name of names) {
    if (typeof name !== 'string' || name.length > 240 || name.normalize('NFKC') !== name) return false;
    const parts = name.split('/');
    if (parts.length > 12) return false;
    let path = '';
    for (const [index, part] of parts.entries()) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}$/u.test(part) || /[. ]$/.test(part) || reserved.test(part)
          || sensitive.test(part) || /^(node_modules|__pycache__|id_(rsa|dsa|ecdsa|ed25519))$/i.test(part)) return false;
      path += '/' + part;
      const key = path.toUpperCase();
      const directory = index < parts.length - 1;
      const old = paths.get(key);
      if (old && (!directory || !old.directory || old.path !== path)) return false;
      paths.set(key, {directory, path});
    }
  }
  return true;
}

// Retain the old, Python-free path for ordinary flat input packets. A nested
// tree needs native directory handles; never fall back to following path strings.
function useTree(names) {
  return names.length > 32 || names.some(name => name.includes('/'));
}

function projectInputs(action, folder, records, managedKey) {
  return projectHelper(inputHelper,action,folder,records,managedKey);
}
export function projectHelper(helper, action, folder, records, managedKey) {
  const win = process.platform === 'win32';
  const args = [...(win ? ['-3.11'] : []), '-I', helper, action, folder, ...(managedKey ? [managedKey] : [])];
  const payload = JSON.stringify(records);
  if (Buffer.byteLength(payload) > maxWire) throw Error('接力项目输入过大。');
  return new Promise((resolve, reject) => {
    const child = spawn(win ? 'py' : 'python3', args, {windowsHide:true, stdio:['pipe','pipe','pipe']});
    const output = [];
    let size = 0, diagnostic = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxWire) child.kill();
      else output.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (diagnostic.length < 600) diagnostic += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > maxWire) return reject(Error('接力文件处理失败：' + diagnostic.trim().slice(0,600)));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { reject(Error('接力文件响应无效。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
async function regularBytes(path, budget) {
  const before = await lstat(path,{bigint:true});
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(budget)) throw Error('接力输入不是受支持的独立普通文件或超出大小上限。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await handle.stat({bigint:true});
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.nlink !== 1n) throw Error('接力文件在打开时发生变化。');
    const bytes = Buffer.alloc(Number(current.size));
    let n = 0;
    while (n < bytes.length) {
      const r = await handle.read(bytes,n,bytes.length-n,n);
      if (!r.bytesRead) throw Error('接力文件发生变化。');
      n += r.bytesRead;
    }
    const after = await handle.stat({bigint:true});
    if (after.size !== current.size || after.ctimeNs !== current.ctimeNs) throw Error('接力文件发生变化。');
    return bytes;
  } finally { await handle.close(); }
}
export async function collectInputs(root,route,cwd) {
  let policy;
  try { policy = JSON.parse(await readFile(join(root,'relay-inputs.json'),'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // Owner-managed file *outside* the workspace: repository content and model arguments cannot opt in files.
  const names = policy[`${route.owner}:${route.key}`];
  if (names === undefined) return [];
  if (!namesAllowed(names)) throw Error('接力输入白名单无效。');
  const folder = await realpath(cwd), files = [];
  if (useTree(names)) return projectInputs('collect', folder, names.map(name => ({name})));
  let remaining = limit;
  for (const name of names) {
    const bytes = await regularBytes(join(folder,name),remaining);
    remaining -= bytes.length;
    files.push({name,digest:hash(bytes),bytes:bytes.toString('base64')});
  }
  return files;
}
export async function prepareInputs(root,role,route,cwd,files,canWrite) {
  if (!Array.isArray(files) || !namesAllowed(files.map(f=>f?.name))) throw Error('无效的接力输入。');
  if (!files.length) return;
  const folder = await realpath(cwd);
  const managing = role !== route.owner;
  if (managing) {
    const base = join(root,'workspaces');
    if (resolve(folder) !== resolve(await realpath(base),hash(route.owner+':'+route.key)) || dirname(resolve(cwd)) !== resolve(base)) throw Error('不是受管工作区，拒绝写入。');
  }
  let remaining = limit;
  if (useTree(files.map(file => file.name))) {
    const base = managing ? await realpath(root) : folder;
    const key = managing ? hash(route.owner + ':' + route.key) : undefined;
    await projectInputs(managing && canWrite ? 'prepare' : 'check', base, files, key);
    return;
  }
  const missing = [];
  for (const file of files) {
    if (typeof file.bytes !== 'string' || file.bytes.length > Math.ceil(remaining/3)*4) throw Error('接力输入过大。');
    const bytes = Buffer.from(file.bytes,'base64');
    if (bytes.length > remaining || bytes.toString('base64') !== file.bytes || hash(bytes) !== file.digest) throw Error('接力输入校验失败。');
    remaining -= bytes.length;
    const path = join(folder,file.name);
    try {
      if (hash(await regularBytes(path,limit)) !== file.digest) throw Error('接手端工作区已有不同版本的文件，未覆盖。');
    } catch (err) {
      if (err.code !== 'ENOENT' || !managing || !canWrite) throw err;
      missing.push({path,bytes});
    }
  }
  for (const {path,bytes} of missing) {
    const tmp = join(folder,'.dsh-relay-'+randomUUID());
    const h = await open(tmp,'wx',0o600);
    try {
      try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      // Publish a *complete* regular file without replacing a concurrently created file or link.
      await link(tmp,path);
    } finally { await unlink(tmp); }
  }
  if (missing.length && process.platform !== 'win32') {
    const dir = await open(folder,'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
}
