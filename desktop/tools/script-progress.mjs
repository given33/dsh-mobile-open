// Cooperative checkpoints for a replay-safe Node build. No callbacks, command lines,
// credentials or executable code are accepted from the other host by this library.
import { spawn, spawnSync } from 'node:child_process';
export { recipeHash, computationSlice } from './computation-slice.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const helper = fileURLToPath(
  new URL('../lib/task-sync/script_progress.py', import.meta.url),
);
const maxBytes = 256 * 1024;
export class ScriptProgress {
  constructor({ session, job, recipe, root }) {
    this.args = [session, job, recipe];
    this.options = root ? ['--root', root] : [];
  }

  run(action, more = [], input) {
    const win = process.platform === 'win32';
    const args = [
      ...(win ? ['-3.11'] : []),
      '-I',
      helper,
      action,
      ...this.args,
      ...this.options,
      ...more,
    ];
    const p = spawnSync(win ? 'py' : 'python3', args, {
      input,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
      timeout: action === 'wait' ? 315000 : 15000,
    });
    if (p.error || p.status !== 0)
      throw Error(
        p.stderr?.trim() || p.error?.message || 'Checkpoint helper failed',
      );
    const result = JSON.parse(p.stdout);
    if (result.delivery === 'conflict')
      throw Error(
        'Two script executions produced different states. Stop and inspect; do not replay.',
      );
    return result;
  }

  async startProducer() {
    const win = process.platform === 'win32';
    const args = [
      ...(win ? ['-3.11'] : []),
      '-I',
      helper,
      'pulse',
      ...this.args,
      ...this.options,
    ];
    const proc = spawn(win ? 'py' : 'python3', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let exited = false;
    const finished = new Promise((resolve) => {
      proc.once('close', () => {
        exited = true;
        resolve();
      });
    });
    proc.stdin.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('Checkpoint heartbeat startup timed out')),
          12000,
        );
        proc.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        proc.once('close', () => {
          clearTimeout(timer);
          reject(Error('Checkpoint heartbeat unavailable'));
        });
        let text = '';
        proc.stdout.on('data', (part) => {
          text += part.toString();
          if (text.includes('\n')) {
            clearTimeout(timer);
            text.trim() === 'ready'
              ? resolve()
              : reject(Error('Invalid heartbeat response'));
          }
        });
      });
    } catch (e) {
      proc.stdin.end();
      throw e;
    }
    return async () => {
      if (!exited) proc.stdin.end();
      await finished;
    };
  }

  load() {
    const view = this.run('load');
    if (view.state !== null) view.state = Buffer.from(view.state, 'base64');
    return view;
  }

  save(previous, bytes, { done = false } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
      throw Error('Expected at most 256 KiB of explicit build state');
    return this.run(
      'save',
      [
        '--parent',
        previous.digest,
        '--rev',
        String(previous.rev + 1),
        ...(done ? ['--done'] : []),
      ],
      bytes,
    );
  }

  waitPaired(checkpoint, seconds = 30) {
    return this.run('wait', [
      '--parent',
      checkpoint.digest,
      '--timeout',
      String(seconds),
    ]);
  }

  // For a standby ALREADY started by an authorized operator/native shell. Silence
  // is NOT proof of death. Only use for deterministic, isolated computation that
  // is safe to perform twice. Network partitions never authorize external effects.
  async waitForQuietReplica({
    quietMs = 12000,
    timeoutMs = 300000,
    signal,
  } = {}) {
    if (!(quietMs >= 1000 && timeoutMs >= quietMs && timeoutMs <= 3600000))
      throw Error('Invalid standby timeouts');
    let last, changedAt;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() <= deadline) {
      signal?.throwIfAborted();
      const view = this.load();
      if (view.rev && view.delivery === 'paired') {
        if (view.done) return view;
        const stamp = [
          view.digest,
          view.peerPulse?.token,
          view.peerPulse?.seq,
        ].join(':');
        if (stamp !== last) {
          last = stamp;
          changedAt = performance.now();
        }
        if (performance.now() - changedAt >= quietMs) return view;
      } else {
        last = undefined;
      }
      await delay(300, undefined, { signal });
    }
    throw Error(
      'No confirmed, quiet peer checkpoint before timeout; script not started',
    );
  }
}
