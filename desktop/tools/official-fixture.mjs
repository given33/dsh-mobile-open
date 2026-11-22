#!/usr/bin/env node
// Isolated official Harness for browser/iPhone regression tests. Never opens
// a daily desktop profile, uses a real model, or logs pairing credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exchangeLaunchURL } from '../lib/upstream-http.mjs';

const { values } = parseArgs({ options: {
  cli: { type: 'string' }, bundle: { type: 'string' },
  output: { type: 'string' }, home: { type: 'string' },
} });
for (const key of ['cli', 'bundle', 'output']) {
  if (!values[key]) throw new Error('--' + key + ' is required');
}
const home = values.home ? resolve(values.home) : await mkdtemp(join(tmpdir(), 'dsh-official-ui-'));
const output = resolve(values.output);
await mkdir(home, { recursive: true });
await mkdir(output, { recursive: true });
const env = { ...process.env, DSH_HOME: home };
const cli = resolve(values.cli);
const bundle = resolve(values.bundle);
const workspace = join(home, 'test-workspace');
await mkdir(workspace, { recursive: true });
const install = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', bundle], {
  env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
});
assert.equal(install.status, 0, install.stderr || install.stdout || 'Plugin installation failed');
await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'),
  `- id: mobile-link\n  name: 'dsh-mobile-link'\n  config:\n    port: 0\n    extraHosts:\n      - '127.0.0.1'\n`, 'utf8');
const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
let rejectLaunch;
const launch = new Promise((resolve, reject) => {
  rejectLaunch = reject;
  const observe = chunk => {
    log += chunk.toString();
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w.-]+/);
    if (match) resolve(match[0]);
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  child.once('error', reject);
  child.once('exit', code => reject(new Error('Official Harness exited: ' + code)));
});
const timer = setTimeout(() => rejectLaunch(new Error('Official Harness startup timed out')), 90_000);
timer.unref();
const redact = value => value.replace(/(dshmobile:\/\/pair)[^\s]+/g, '$1[redacted]').replace(/([?&]token=)[^\s&"']+/g, '$1[redacted]');
const stop = () => { if (!child.killed) child.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
try {
  const auth = await exchangeLaunchURL(await launch);
  clearTimeout(timer);
  const panel = async (path, value) => {
    const response = await fetch(new URL('dsh-mobile-link/' + path, auth.base), {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    assert.equal(response.status, 200, 'panel ' + path);
    return response.json();
  };
  let status = await panel('enabled', { enabled: true });
  await panel('actions', { enabled: true });
  // This fixture has no real sessions or credentials.
  await panel('terminal', { enabled: true });
  const save = async () => {
    status = await panel('status');
    assert(status.pairing?.link && status.listening);
    await writeFile(join(output, 'pair.txt'), status.pairing.link + '\n', { mode: 0o600 });
    await writeFile(join(output, 'host.json'), JSON.stringify({
      base: auth.base.href, cookie: auth.cookie, port: status.port, home, workspace,
    }), { mode: 0o600 });
  };
  await save();
  console.log('Official Harness fixture is ready on an isolated profile.');
  const refresh = setInterval(() => save().catch(error => console.error(error.message)), 30_000);
  child.once('exit', () => { clearInterval(refresh); process.exitCode = 1; });
  await new Promise(resolve => child.once('exit', resolve));
} catch (error) {
  stop();
  console.error(error.message);
  console.error(redact(log).slice(-5000));
  process.exitCode = 1;
}
