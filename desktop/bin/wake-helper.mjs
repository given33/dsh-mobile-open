// Started by the local Windows opt-in installer, never by a remote command.
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createWakeServer, wakeConfig } from '../lib/wake.mjs';
if (process.platform !== 'win32') throw Error('Windows only');
const dir = process.argv[2];
const cfg = await wakeConfig(dir);
if (!cfg) process.exit(0);
const app = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const server = await createWakeServer(dir, () => new Promise((resolve, reject) => {
  const child = spawn(app, [], { shell: false, detached: true, stdio: 'ignore', cwd: process.env.LOCALAPPDATA });
  child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
}));
server.listen(cfg.port, cfg.bind || '127.0.0.1');
