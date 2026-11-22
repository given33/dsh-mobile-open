import { lstat, open, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { getCachedOfficeDocument, readOfficeDocument } from './mobile-office.mjs';

const FILE_LIMIT = 16 * 1024 * 1024;
const OFFICE_LIMIT = 64 * 1024 * 1024;
const GIT_LIMIT = 2 * 1024 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
const requiredString = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

function relativeParts(path) {
  if (!requiredString(path, 4096) || /[\\:\0]/.test(path) || path.startsWith('/')) {
    throw failure('mobileFiles/path', '请选择工作区内的相对路径。');
  }
  const parts = path.split('/');
  if (parts.some(part => part === '.' || part === '..' || !part || (process.platform === 'win32' && /[. ]$/.test(part)))) {
    throw failure('mobileFiles/path', '路径超出了工作区。');
  }
  return parts;
}

export async function workspaceFile(root, path) {
  const parts = relativeParts(path);
  const base = await realpath(root);
  let target = base;
  for (const [index, part] of parts.entries()) {
    target = resolve(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !(index === parts.length - 1 ? info.isFile() : info.isDirectory())) {
      throw failure('mobileFiles/type', '只支持工作区内的普通文件。');
    }
  }
  const canonical = await realpath(target);
  const suffix = relative(base, canonical);
  if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) {
    throw failure('mobileFiles/path', '路径超出了工作区。');
  }
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw failure('mobileFiles/size', '单个文件最多 16 MiB。');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { name: basename(target), bytes: offset, data: data.subarray(0, offset).toString('base64') };
  } finally { await handle.close(); }
}

function runGit(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' });
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let length = 0, errorText = '', overflow = false;
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(failure('mobileGit/timeout', 'Git 操作超时，请重试。'));
    }, 12000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > GIT_LIMIT) { overflow = true; child.kill(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (errorText.length < 4096) errorText += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); reject(failure('mobileGit/unavailable', '无法启动电脑上的 Git。')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (overflow) reject(failure('mobileGit/size', 'Git 输出超过 2 MiB，请缩小变更范围。'));
      else if (code !== 0) reject(failure('mobileGit/refused', /not a git repository/i.test(errorText) ? '当前工作区不在 Git 仓库中。' : 'Git 未能读取此工作区。'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export function parseGitStatus(output) {
  const values = output.split('\0');
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (item.length < 4 || item[2] !== ' ') continue;
    const status = item.slice(0, 2);
    const path = item.slice(3);
    const previous = /[RC]/.test(status) ? values[++i] : undefined;
    rows.push({ path, index: status[0], worktree: status[1], ...(previous ? { previous } : {}) });
  }
  return rows;
}

export async function gitChanges(root) {
  const prefix = (await runGit(root, ['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
  const rows = parseGitStatus(await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']));
  return rows.filter(row => row.path.startsWith(prefix)).map(({ previous, ...row }) => ({
    ...row, path: row.path.slice(prefix.length),
    ...(previous?.startsWith(prefix) ? { previous: previous.slice(prefix.length) } : {}),
  }));
}

export async function gitDiff(root, path, staged) {
  const parts = relativeParts(path);
  const safe = parts.join('/');
  return runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative',
    ...(staged ? ['--cached'] : []), '--', safe]);
}

export async function workspaceOffice(root, path) {
  if (!requiredString(path, 4096) || /\0/.test(path)) {
    throw failure('mobileOffice/path', '无效的文档路径。');
  }
  const base = await realpath(root);
  let relPath = path.replace(/\\/g, '/');
  if (isAbsolute(path)) {
    // A host can report either the configured root or its canonical path
    // (for example /var vs /private/var on macOS). Match the lexical root
    // first, then resolve each child beneath the canonical root below.
    const absolute = resolve(path);
    const rel = [resolve(root), base].map(parent => relative(parent, absolute))
      .find(suffix => suffix && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix));
    if (!rel) throw failure('mobileOffice/path', '路径超出了工作区。');
    relPath = rel.split(sep).join('/');
  } else {
    relPath = relPath.replace(/^(?:\.\/)+/, '');
  }
  let parts;
  try { parts = relativeParts(relPath); } catch (e) { throw failure('mobileOffice/path', e.message); }
  let target = base;
  for (const [index, part] of parts.entries()) {
    target = resolve(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !(index === parts.length - 1 ? info.isFile() : info.isDirectory())) {
      throw failure('mobileOffice/type', '只支持工作区内的普通文件。');
    }
  }
  const canonical = await realpath(target);
  const suffix = relative(base, canonical);
  if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) {
    throw failure('mobileOffice/path', '路径超出了工作区。');
  }
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > OFFICE_LIMIT) throw failure('mobileOffice/size', '单个文档最多 64 MiB，请切换原版式或下载。');
    const version = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const cached = getCachedOfficeDocument(canonical, version);
    if (cached) return cached;
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    try {
      return readOfficeDocument({ buffer: data.subarray(0, offset), filePath: canonical, version, cacheKey: canonical });
    } catch (error) {
      throw failure('mobileOffice/parse', error?.message || '无法读取此文档原文');
    }
  } finally { await handle.close(); }
}

export function mobileHostActions(ctx) {
  async function sessionHeader(id) {
    if (!requiredString(id, 128)) throw failure('mobile/session', '缺少会话。');
    const live = ctx.get?.('sessions')?.get(id)?.header;
    const stored = live === undefined ? await ctx.get?.('sessionPersistence')?.stat(id) : undefined;
    const found = live ?? stored?.header ?? stored;
    if (!found) throw failure('mobile/session', '电脑上找不到此会话。');
    return found;
  }
  async function workspaceRoot(id) {
    const header = await sessionHeader(id);
    const path = header.cwd;
    if (typeof path !== 'string' || !isAbsolute(path)) throw failure('mobileFiles/unavailable', '此会话没有可用的本地工作目录。');
    if (process.platform === 'win32' && /^[/\\]{2}/.test(path)) throw failure('mobileFiles/unavailable', '此工作区不在本地磁盘。');
    return path;
  }
  return {
    async 'mobileSchedule/create'({ request }) {
      const { sessionId, ...fields } = request ?? {};
      await sessionHeader(sessionId);
      if (!requiredString(fields.title, 120) || !requiredString(fields.prompt, 64_000)) {
        throw failure('mobileSchedule/input', '请填写任务名称和投递内容。');
      }
      const schedule = ctx.get?.('schedule');
      if (!schedule) throw failure('mobileSchedule/unavailable', '电脑尚未启用定时任务服务。');
      const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'];
      const supplied = selectors.filter(key => Object.hasOwn(fields, key));
      if (supplied.length !== 1) throw failure('mobileSchedule/input', '请选择一个触发规则。');
      const selector = supplied[0];
      return schedule.create(sessionId, { title: fields.title.trim(), prompt: fields.prompt.trim(), [selector]: fields[selector] });
    },
    async 'mobileFiles/download'({ sessionId, path }) { return workspaceFile(await workspaceRoot(sessionId), path); },
    async 'mobileOffice/read'({ sessionId, path }) {
      if (!requiredString(path, 4096) || /\0/.test(path)) throw failure('mobileOffice/path', '无效的文档路径。');
      const root = await workspaceRoot(sessionId);
      const files = ctx.get?.('workspaceFiles');
      const hostFs = ctx.get?.('fs');
      if (typeof files?.stat === 'function' && typeof files?.readBytes === 'function'
          && typeof hostFs?.resolve === 'function' && typeof hostFs?.readBytes === 'function') {
        const scope = { sessionId, workspaceRoot: root };
        const signal = AbortSignal.timeout(20_000);
        const authorized = await files.readBytes(scope, path, { range: { offset: 0, length: 1 } }, signal);
        const source = await files.stat(scope, path, signal);
        if (authorized.absolutePath !== source.absolutePath || authorized.version !== source.version) {
          throw failure('mobileOffice/changed', '文件刚刚发生变更，请重试。');
        }
        const cached = getCachedOfficeDocument(source.absolutePath, source.version);
        if (cached) return cached;
        const target = await hostFs.resolve(source.absolutePath, { signal });
        const bytes = await hostFs.readBytes(target, signal, OFFICE_LIMIT).catch(cause => {
          if (cause?.code === 'FS_TOO_LARGE') throw failure('mobileOffice/size', '单个文档最多 64 MiB，请切换原版式或下载。');
          throw cause;
        });
        try {
          return readOfficeDocument({
            buffer: bytes,
            filePath: source.absolutePath,
            version: source.version ?? '',
            cacheKey: source.absolutePath,
          });
        } catch (error) {
          throw failure('mobileOffice/parse', error?.message || '无法读取此文档原文');
        }
      }
      return workspaceOffice(root, path);
    },
    async 'mobileGit/status'({ sessionId }) { return gitChanges(await workspaceRoot(sessionId)); },
    async 'mobileGit/diff'({ sessionId, path, staged }) { return gitDiff(await workspaceRoot(sessionId), path, staged === true); },
    async 'mobileHost/status'() {
      const cpuList = cpus();
      const list = ctx.get?.('sessions')?.list?.getSnapshot?.();
      const activeSessions = list?.ids && list?.byId
        ? list.ids.filter(id => {
            const row = list.byId[id];
            return row && !row.blank && row.origin !== 'subagent';
          }).length
        : null;
      return {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        cpuCount: cpuList.length,
        cpuModel: cpuList[0]?.model ?? '',
        loadAvg: loadavg().map(n => Math.round(n * 100) / 100),
        memTotalBytes: totalmem(),
        memFreeBytes: freemem(),
        uptimeSec: Math.floor(uptime()),
        processUptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        activeSessions,
      };
    },
  };
}
