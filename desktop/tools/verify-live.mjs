import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { exchangeLaunchURL } from '../lib/upstream-http.mjs';

if (process.argv.length !== 4) {
  console.error('Usage: node desktop/tools/verify-live.mjs <Harness bin.js> <dsh-mobile-link.tgz>');
  process.exit(2);
}
const cli = resolve(process.argv[2]);
const bundle = resolve(process.argv[3]);
const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
assert.equal(version.status, 0, version.stderr || String(version.error));
const harnessVersion = version.stdout.trim().match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?$/)?.[0];
assert.ok(harnessVersion, 'Could not determine the Harness version');
const home = await mkdtemp(join(tmpdir(), 'dsh-mobile-live-'));
const env = { ...process.env, DSH_HOME: home };
const workspace = join(home, 'smoke-workspace');
const packageDir = join(home, 'mobile-install-example');
const packageName = 'dsh-mobile-install-smoke';
await mkdir(packageDir);
await writeFile(join(packageDir, 'package.json'), JSON.stringify({
  name: packageName, version: '1.0.0', type: 'module', exports: { '.': './host.mjs' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}));
await writeFile(join(packageDir, 'host.mjs'), 'export function apply() {}\n');
await writeFile(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: mobile-install-smoke\n      name: dsh-mobile-install-smoke\n');
const examplePath = fileURLToPath(new URL('../examples/native-panel/', import.meta.url));
for (const spec of [bundle, examplePath, `@deepseek-ai/dsh-experimental-plugin-market-bundle@${harnessVersion}`]) {
  const install = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', spec], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90_000,
  });
  assert.equal(install.status, 0, install.stderr || install.stdout || String(install.error));
}
await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'),
  "- id: mobile-link\n  name: 'dsh-mobile-link'\n  config:\n    port: 0\n    host: '127.0.0.1'\n    extraHosts: ['127.0.0.1']\n", 'utf8');
await mkdir(workspace, { recursive: true });
const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let stop;
const deadline = new Promise((_, reject) => { stop = setTimeout(() => reject(new Error('isolated host timed out')), 200000); });
try {
  const launch = await Promise.race([deadline, new Promise((resolve, reject) => {
    const scan = chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w.-]+/);
      if (match) resolve(match[0]);
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', code => reject(new Error('isolated host exited: ' + code)));
    child.on('error', reject);
  })]);
  const auth = await exchangeLaunchURL(launch);
  const anonymousPanel = await fetch(new URL('dsh-mobile-link/status', auth.base), { redirect: 'manual' });
  assert.equal(anonymousPanel.status, 401, 'unauthenticated desktop panel must not expose pairing status');
  async function panel(path, value) {
    const res = await fetch(new URL('dsh-mobile-link/' + path, auth.base), {
      method: value === undefined ? 'GET' : 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    assert.equal(res.status, 200, 'panel ' + path);
    return res.json();
  }
  const status = await panel('enabled', { enabled: true });
  assert.equal(status.listening, true, 'test phone link failed to start');
  await panel('actions', { enabled: true });
  const offer = new URL(status.pairing.link);
  const port = status.port;
  let token;
  function phone(path, value, raw = false) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, path, method: value === undefined ? 'GET' : 'POST',
        agent: false, rejectUnauthorized: false, headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          'Content-Type': raw ? 'application/octet-stream' : 'application/json',
        } }, res => {
        let body = '';
        res.on('data', b => { body += b; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, value: JSON.parse(body) }); }
          catch { reject(new Error(path + ' invalid JSON: ' + res.statusCode + ' ' + body.slice(0, 100))); }
        });
      });
      req.on('socket', socket => socket.once('secureConnect', () => {
        const fp = createHash('sha256').update(socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
        if (fp !== offer.searchParams.get('fp')) req.destroy(new Error('certificate pin mismatch'));
      }));
      req.on('error', reject);
      req.setTimeout(path.includes('pluginManager/') ? 100000 : 8000, () => req.destroy(new Error('request timed out: ' + path)));
      req.end(raw || value === undefined ? value : JSON.stringify(value));
    });
  }
  const paired = await phone('/mobile/v1/pair', { code: offer.searchParams.get('c'), device: { id: 'native-smoke-phone', name: 'Native smoke test' } });
  assert.equal(paired.status, 200);
  token = paired.value.token;
  assert.equal((await phone('/mobile/v1/session')).value.actions, true);
  async function rpc(method, args) {
    const res = await phone('/api/' + method, { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } });
    assert.equal(res.status, 200, 'rpc status: ' + method);
    assert.equal(res.value.result?.ok, true, 'rpc ' + method + ': ' + JSON.stringify(res.value.result?.error));
    return res.value.result.value;
  }
  const directories = await rpc('directoryPicker/list', {});
  assert.ok(directories.path && Array.isArray(directories.entries));
  const search = await rpc('session/search', { request: { query: 'isolated-unlikely-hit' } });
  assert.ok(Array.isArray(search.items));
  const catalog = await rpc('session/modelCatalog', {});
  assert.ok(Array.isArray(catalog.groups));
  const { workspace: ws } = await rpc('workspace/create', { request: { path: workspace } });
  const { sessionId } = await rpc('session/create', { request: { workspaceId: ws.workspaceId } });
  assert.ok(sessionId);
  const git = (...args) => {
    const child = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr ?? 'git failed');
  };
  git('init', '-q');
  await writeFile(join(workspace, 'verification.txt'), 'before\n');
  git('add', '--', 'verification.txt');
  await writeFile(join(workspace, 'verification.txt'), 'after\n');
  const tree = await rpc('workspaceFiles/list', { workspaceFileScopeId: sessionId, path: '.' });
  assert.ok(JSON.stringify(tree).includes('verification.txt'), 'workspace tree');
  const downloaded = await rpc('mobileFiles/download', { sessionId, path: 'verification.txt' });
  assert.equal(Buffer.from(downloaded.data, 'base64').toString(), 'after\n');
  assert.deepEqual((await rpc('mobileGit/status', { sessionId })).find(row => row.path === 'verification.txt'),
    { path: 'verification.txt', index: 'A', worktree: 'M' });
  assert.match(await rpc('mobileGit/diff', { sessionId, path: 'verification.txt' }), /\+after/);
  assert.match(await rpc('mobileGit/diff', { sessionId, path: 'verification.txt', staged: true }), /\+before/);
  assert.ok(Array.isArray((await rpc('settings/describe', {})).namespaces));
  const ref = 'DSH_MOBILE_SMOKE_CREDENTIAL';
  const secret = 'synthetic-fixture-value';
  const credential = async () => (await rpc('credentials/describe', { refs: [ref] }))[ref];
  assert.equal((await credential()).configured, false);
  await rpc('credentials/set', { ref, value: secret });
  assert.equal((await credential()).configured, true);
  assert.ok(!JSON.stringify(await credential()).includes(secret));
  await rpc('credentials/unset', { ref });
  assert.equal((await credential()).configured, false);
  assert.ok(Array.isArray(await rpc('llm/listConfigurableProviders', {})));
  assert.ok(Array.isArray(await rpc('pluginManager/listBundles', {})));
  assert.ok(Array.isArray(await rpc('pluginManager/listPlugins', {})));
  const inspect = await rpc('pluginManager/inspect', { spec: packageDir });
  assert.equal(inspect.status, 'accepted', JSON.stringify(inspect));
  assert.equal(inspect.name, packageName);
  const installed = await rpc('pluginManager/installBundle', {
    spec: packageDir, options: { enabled: false, saveExact: true, requestId: crypto.randomUUID() },
  });
  assert.ok(['applied', 'restart-required'].includes(installed.application), JSON.stringify(installed));
  assert.ok((await rpc('pluginManager/listBundles', {})).some(row => row.name === packageName && row.installed));
  const removed = await rpc('pluginManager/removeBundle', { name: packageName });
  assert.ok(['applied', 'restart-required'].includes(removed.application), JSON.stringify(removed));
  assert.ok(!(await rpc('pluginManager/listBundles', {})).some(row => row.name === packageName && row.installed));
  assert.ok(Array.isArray(await rpc('pluginMarket/listIndexes', {})));
  await rpc('pluginMarket/setIndexes', { urls: [] });
  assert.deepEqual(await rpc('pluginMarket/listIndexes', {}), []);
  const exampleID = 'dsh-mobile-panel-example:note';
  const panels = await rpc('mobilePanels/list', {});
  assert.ok(panels.some(x => x.id === exampleID));
  assert.ok(panels.some(x => x.id === 'dsh-mobile-link:connection'));
  const panelView = await rpc('mobilePanels/read', { id: exampleID });
  assert.equal(panelView.fields[0].value, '初始值');
  assert.equal((await rpc('mobilePanels/perform', {
    id: exampleID, action: 'save', expectedRevision: panelView.revision, values: { note: '手机写入' },
  })).message, '已保存。');
  assert.equal((await rpc('mobilePanels/read', { id: exampleID })).fields[0].value, '手机写入');
  assert.ok(Array.isArray((await rpc('permissionPresets/catalog', {})).options));
  const directory = await rpc('directoryPicker/createDirectory', { path: workspace, name: 'new-folder' });
  assert.equal(directory, join(workspace, 'new-folder'));
  const presetList = await rpc('agentPresets/list', {});
  assert.ok(presetList.presets.length);
  assert.ok((await rpc('agentPresets/read', { agentPreset: presetList.presets[0].id })).content);
  const createdSchedule = await rpc('mobileSchedule/create', {
    request: { sessionId, title: 'Isolated schedule verification', prompt: 'Do not deliver this test', after_seconds: 86400 },
  });
  assert.ok(createdSchedule.id, 'schedule created');
  const listedSchedule = (await rpc('schedule/list', { request: { sessionId } })).find(x => x.id === createdSchedule.id);
  assert.ok(listedSchedule);
  const keys = new Set(['id', 'title', 'prompt', 'kind', 'scheduledAt', 'afterSeconds', 'everySeconds', 'time', 'timeZone', 'weekdays', 'expression']);
  const expected = Object.fromEntries(Object.entries(listedSchedule).filter(([key]) => keys.has(key)));
  assert.equal((await rpc('schedule/history', { request: { sessionId, id: createdSchedule.id, limit: 20 } })).records.length, 0);
  assert.equal((await rpc('schedule/update', { request: { sessionId, id: createdSchedule.id, expected: {}, title: 'stale edit' } })).updated, false);
  const updated = await rpc('schedule/update', {
    request: { sessionId, id: createdSchedule.id, expected, title: 'Updated test schedule',
      change: { kind: 'every', every_seconds: 86400 } },
  });
  assert.equal(updated.updated, true, JSON.stringify(updated));
  assert.equal(updated.record.kind, 'every');
  assert.equal((await rpc('schedule/delete', { request: { sessionId: 'different-session', id: createdSchedule.id } })).deleted, false);
  assert.equal((await rpc('schedule/delete', { request: { sessionId, id: createdSchedule.id } })).deleted, true);
  const renamed = await rpc('session/rename', { request: { sessionId, title: 'Native smoke verification' } });
  assert.equal(renamed.title, 'Native smoke verification');
  const list = await rpc('session/list', { _request: {} });
  assert.ok(list.items.some(item => item.sessionId === sessionId), 'renamed session appears in list');
  const uploaded = await phone('/api/session/uploadFileBinary?sessionId=' + encodeURIComponent(sessionId) + '&name=verification.txt', Buffer.from('isolated test file'), true);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
  assert.ok(uploaded.value.ok && uploaded.value.value.receiptId);
  const goals = await rpc('goals/get', { agentId: sessionId });
  assert.ok(goals == null);
  const createdGoal = await rpc('goals/create', { agentId: sessionId, request: { objective: 'Verify the native goal interface in isolation', maxGoalRounds: 2 } });
  assert.ok(createdGoal.ref.id);
  const pausedGoal = await rpc('goals/pause', { agentId: sessionId, ref: createdGoal.ref });
  assert.equal(pausedGoal.phase, 'paused');
  const editedGoal = await rpc('goals/edit', { agentId: sessionId, ref: { id: pausedGoal.id, revision: pausedGoal.revision }, request: { objective: 'Updated isolated goal' } });
  assert.equal(editedGoal.objective, 'Updated isolated goal');
  await rpc('goals/clear', { agentId: sessionId, ref: { id: editedGoal.id, revision: editedGoal.revision } });
  assert.ok((await rpc('goals/get', { agentId: sessionId })) == null);
  assert.ok(Array.isArray(await rpc('schedule/catalog', {})));
  assert.ok(Array.isArray(await rpc('schedule/list', { request: { sessionId } })));
  const socket = new WebSocket('wss://127.0.0.1:' + port + '/api/remote.mux', {
    rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + token },
  });
  try {
    const wait = new Promise((resolve, reject) => {
      const frames = new Set();
      socket.on('error', reject);
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes);
        if (frame.type === 'error') reject(new Error('stream error: ' + JSON.stringify(frame.error)));
        if (frame.value?.type === 'ready' || frame.value?.type === 'snapshot' || frame.value?.type === 'baseline') frames.add(frame.streamId);
        if (frames.size === 4) resolve();
      });
    });
    await once(socket, 'open');
    for (const [streamId, endpoint, args] of [
      ['event', '$events', {}], ['control', 'session/control', {}], ['workspace', 'workspace/follow', {}],
      ['chat', 'session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 100, assistantStream: true } }],
    ]) socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    await Promise.race([wait, deadline]);
  } finally { socket.terminate(); }
  await panel('terminal', { enabled: true });
  assert.equal((await phone('/mobile/v1/session')).value.terminal, true);
  const shells = await rpc('terminal/shells', { agentId: sessionId });
  const shell = shells.find(x => /cmd(?:\.exe)?$/i.test(x.path)) ?? shells[0];
  assert.ok(shell, 'at least one host shell');
  const id = crypto.randomUUID();
  const terminal = await rpc('terminal/create', { agentId: sessionId, request: { id, cols: 80, rows: 24, shellPath: shell.path } });
  assert.equal(terminal.state, 'running', JSON.stringify(terminal));
  const connection = new WebSocket('wss://127.0.0.1:' + port + '/api/remote.mux', {
    rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + token },
  });
  try {
    const write = frame => connection.send(JSON.stringify({ streamId: 'terminal', ...frame }));
    const wait = new Promise((resolve, reject) => {
      let acked = false, rendered = '';
      connection.on('error', reject);
      connection.on('message', bytes => {
        const frame = JSON.parse(bytes);
        if (frame.type === 'error') return reject(new Error(JSON.stringify(frame.error)));
        const value = frame.value;
        if (value?.type === 'snapshot') {
          assert.equal(value.writable, true);
          write({ type: 'item', value: { type: 'resize', sequence: 1, cols: 84, rows: 26 } });
          write({ type: 'item', value: { type: 'write', sequence: 2, data: 'echo DSH_MOBILE_TERMINAL_OK\r' } });
        }
        if (value?.type === 'ack' && value.sequence === 2 && !value.refusal) acked = true;
        if (value?.type === 'output') rendered += value.data;
        if (acked && /DSH_MOBILE_TERMINAL_OK/.test(rendered)) resolve();
      });
    });
    await once(connection, 'open');
    write({ type: 'open', endpoint: 'terminal/attach', payload: { args: { agentId: sessionId, id } } });
    await Promise.race([wait, deadline]);
  } finally {
    connection.terminate();
    await rpc('terminal/close', { agentId: sessionId, id });
  }
  console.log(`PASS: isolated official Harness ${harnessVersion}, plugin panel, TLS pair, model catalog, directory picker, search, workspace/session creation, rename, binary upload, goal create/pause/edit/clear, file tree and binary read, staged/unstaged Git diff, configuration, redacted credentials, plugin inspect/install/remove and market, native plugin write, permission and agent presets, schedule creation/recurrence/deletion, four observer streams, real PTY input/output/resize`);
} catch (error) {
  console.error(error.stack || error.message);
  console.error(output.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').split(/\r?\n/).slice(-18).join('\n'));
  process.exitCode = 1;
} finally {
  clearTimeout(stop);
  child.kill();
}
