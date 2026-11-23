import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validID } from './log.mjs';

const helper = fileURLToPath(new URL('./script_progress.py', import.meta.url));
const digest = /^[0-9a-f]{64}$/;
const toolLimit = 32 * 1024;
const actions = ['load', 'quiet', 'save'];
function invoke(args, input, signal) {
  signal.throwIfAborted();
  const win = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(
      win ? 'py' : 'python3',
      [...(win ? ['-3.11'] : []), '-I', helper, ...args],
      { signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    const timer = setTimeout(() => child.kill(), 105000);
    child.stdout.on('data', (b) => {
      out += b;
      if (out.length > 400000) child.kill();
    });
    child.stderr.on('data', (b) => {
      if (err.length < 1000) err += b;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          Error(err.trim() || 'Checkpoint helper did not complete'),
        );
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(Error('Invalid checkpoint response'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function registerScriptCheckpoint(ctx, root, output) {
  ctx.tools.register({
    name: 'relay_script_checkpoint',
    output,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'job', 'recipe'],
      properties: {
        action: { type: 'string', enum: actions },
        job: { type: 'string' },
        recipe: { type: 'string' },
        rev: { type: 'integer', minimum: 1 },
        parent: { type: 'string' },
        state: { type: 'string', description: 'base64 build data, not code' },
        done: { type: 'boolean' },
        quietMs: { type: 'integer', minimum: 1000, maximum: 60000 },
        timeout: { type: 'integer', minimum: 1, maximum: 90 },
      },
    },
    description:
      'Read, wait for or save a cooperative deterministic script checkpoint in THIS session. quiet returns a paired checkpoint after the data and producer heartbeat stop advancing; it does not prove power loss. Never use this to authorize side effects. Use for native shells unable to access the script ledger. Max 32 KiB of explicit state. No command is executed from state.',
    async execute(a, exec) {
      const session = exec.agent?.session;
      if (
        !validID(session?.id) ||
        !validID(a.job) ||
        !digest.test(a.recipe) ||
        !actions.includes(a.action)
      )
        throw Error('Invalid script checkpoint identity');
      const args = [a.action, session.id, a.job, a.recipe, '--root', root];
      let input;
      if (a.action === 'save') {
        const sandbox = ctx.get('sandboxPolicy')?.resolve({ session })?.mode;
        if (!['workspace-write', 'danger-full-access'].includes(sandbox))
          throw Error('Read-only session cannot publish script state');
        if (
          typeof a.state !== 'string' ||
          a.state.length > 4 * Math.ceil(toolLimit / 3) ||
          !Number.isSafeInteger(a.rev) ||
          a.rev < 1 ||
          !digest.test(a.parent)
        )
          throw Error('Invalid checkpoint revision or size');
        input = Buffer.from(a.state, 'base64');
        if (input.length > toolLimit || input.toString('base64') !== a.state)
          throw Error('Invalid checkpoint bytes');
        args.push('--parent', a.parent, '--rev', String(a.rev));
        if (a.done) args.push('--done');
      } else if (a.action === 'quiet') {
        const duration = a.quietMs ?? 12000,
          timeout = a.timeout ?? 45;
        if (
          !Number.isSafeInteger(duration) ||
          duration < 1000 ||
          duration > 60000 ||
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > 90
        )
          throw Error('Invalid quiet interval');
        args.push('--quiet-ms', String(duration), '--timeout', String(timeout));
      }
      const info = await invoke(args, input, exec.signal);
      if (info.delivery === 'conflict')
        throw Error('Divergent checkpoint; do not replay');
      if (info.state && Buffer.byteLength(info.state, 'base64') > toolLimit)
        throw Error(
          'Checkpoint exceeds model tool limit; use the authorized script SDK',
        );
      return JSON.stringify({
        kind: 'script-progress/v1',
        job: a.job,
        recipe: a.recipe,
        ...info,
      });
    },
  });
}
