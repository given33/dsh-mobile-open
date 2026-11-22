import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const LIMIT = 2500;

function rejectPath() {
  return Object.assign(new Error('手机只能浏览电脑用户目录下的本地文件夹；其他位置请手动输入路径。'), { code: 'directory-picker/outside-home' });
}

async function locateHomeDirectory(requested, home) {
  const realHome = await realpath(home);
  const path = requested === undefined ? home : requested;
  if (typeof path !== 'string' || !isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0') || path.length > 4096) {
    throw rejectPath();
  }
  const target = resolve(path);
  const rel = relative(resolve(home), target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw rejectPath();
  const parts = rel ? rel.split(sep) : [];
  let parent = realHome;
  const row = (name, path) => ({ name, path, hidden: name.startsWith('.') });
  const crumbs = [row(basename(home) || home, resolve(home))];
  for (const segment of parts) {
    // Windows alternate streams, trailing spaces and trailing dots must not
    // change which filesystem entry the containment checks refer to.
    if (process.platform === 'win32' && (segment.includes(':') || /[. ]$/.test(segment))) throw rejectPath();
    parent = join(parent, segment);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw rejectPath();
    crumbs.push(row(segment, join(crumbs.at(-1).path, segment)));
  }
  return { parent, target, crumbs, row };
}

/** Native-picker hosts have no browser listing. Offer only real subdirectories of the local home. */
export async function listHomeDirectories(requested, home = homedir()) {
  const { parent, target, crumbs, row } = await locateHomeDirectory(requested, home);
  const entries = [];
  const directory = await opendir(parent);
  let truncated = false;
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entries.length >= LIMIT) { truncated = true; break; }
    entries.push(row(entry.name, join(target, entry.name)));
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, home, crumbs, entries, truncated };
}

export async function createHomeDirectory(path, name, home = homedir()) {
  if (typeof path !== 'string' || typeof name !== 'string' || !name || name.length > 255 ||
      name === '.' || name === '..' || /[\\/:\0]/.test(name) ||
      (process.platform === 'win32' && (/[. ]$|[<>"|?*]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) {
    throw Object.assign(new Error('请输入一个有效的文件夹名称。'), { code: 'directory-picker/create-failed' });
  }
  const { parent, target } = await locateHomeDirectory(path, home);
  try { await mkdir(join(parent, name)); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('同名文件夹或文件已经存在。'), { code: 'directory-picker/exists' });
    throw Object.assign(new Error('电脑未能创建此文件夹。'), { code: 'directory-picker/create-failed' });
  }
  return join(target, name);
}

/** Preserve the official response except where Harness composes a desktop-only chooser. */
export async function directoryPickerFallback(body, upstream) {
  if (upstream.status !== 200) return upstream;
  let response;
  try { response = JSON.parse(upstream.body); } catch { return upstream; }
  if (response.result?.error?.code !== 'directory-picker/unavailable' ||
      response.result.error.details?.capability !== 'native') return upstream;
  const { method, payload: { args } } = JSON.parse(body);
  try {
    const value = method === 'directoryPicker/createDirectory'
      ? await createHomeDirectory(args.path, args.name)
      : await listHomeDirectories(args.path);
    response.result = { ok: true, value };
  } catch (error) {
    const typed = error.code?.startsWith('directory-picker/');
    response.result = { ok: false, error: { code: typed ? error.code : 'directory-picker/local-io',
      message: typed ? error.message : '无法访问这个文件夹，请返回起始目录，或手动输入路径。' } };
  }
  return { status: 200, body: Buffer.from(JSON.stringify(response)) };
}
