// This module is safe to bundle as an explicit build input. It does not access the host ledger.
import { createHash } from 'node:crypto';

export function recipeHash(parts) {
  // Include the script version/bytes, build settings and input digest(s) in the
  // same order on both machines. Never bind to absolute Windows or Linux paths.
  const hash = createHash('sha256').update('dsh-script-recipe/v1:');
  for (const value of parts) {
    const bytes = Buffer.from(value);
    hash.update(String(bytes.length)).update(':').update(bytes);
  }
  return hash.digest('hex');
}

// In a restrictive native shell, pass the output of relay_script_checkpoint(load
// or quiet) as data. This adapter has no filesystem/DB/network access. The caller
// must publish `result()` with the native save tool before calling it durable.
export function computationSlice(seed, { job, recipe }) {
  const modelLimit = 32 * 1024;
  const validHeader =
    seed?.kind === 'script-progress/v1' &&
    seed.job === job &&
    seed.recipe === recipe &&
    /^[0-9a-f]{64}$/.test(seed.digest) &&
    Number.isSafeInteger(seed.rev) &&
    seed.rev >= 0 &&
    typeof seed.done === 'boolean';
  if (!validHeader) throw Error('Checkpoint does not match this build');
  let state = null;
  if (seed.rev === 0) {
    if (
      seed.delivery !== 'none' ||
      seed.state !== null ||
      seed.done ||
      seed.digest !== '0'.repeat(64)
    ) {
      throw Error('Invalid initial checkpoint');
    }
  } else {
    if (
      !['local', 'paired'].includes(seed.delivery) ||
      typeof seed.state !== 'string' ||
      seed.state.length > 4 * Math.ceil(modelLimit / 3)
    )
      throw Error('Invalid checkpoint data');
    state = Buffer.from(seed.state, 'base64');
    if (
      state.byteLength > modelLimit ||
      state.toString('base64') !== seed.state
    )
      throw Error('Invalid checkpoint bytes');
  }
  return {
    state,
    done: seed.done,
    result(bytes, { done = false } = {}) {
      if (
        seed.done ||
        typeof done !== 'boolean' ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > modelLimit
      ) {
        throw Error('Invalid computation slice');
      }
      return {
        action: 'save',
        job,
        recipe,
        parent: seed.digest,
        rev: seed.rev + 1,
        state: Buffer.from(bytes).toString('base64'),
        done,
      };
    },
  };
}
