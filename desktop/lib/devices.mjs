// Paired phones and one-time pairing codes.
// Tokens are 256-bit random values; only their SHA-256 is stored on disk.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanName, writePrivate } from './identity.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_DEVICES = 32;

export class DeviceRegistry {
  #family = new Map(); #blocked = new Set();
  #path; #devices = new Map(); #listeners = new Set();
  constructor(dir) { this.#path = join(dir, 'devices.json'); }

  async load() {
    try {
      const list = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#blocked = new Set(Array.isArray(list?.blocked) ? list.blocked : []);
      for (const d of Array.isArray(list?.devices) ? list.devices : []) {
        if (DEVICE_ID.test(d?.id) && typeof d.tokenHash === 'string') this.#devices.set(d.id, d);
      }
    } catch {}
    return this;
  }

  replaceFamily(records) {
    const next = new Map(records.filter(d => !this.#blocked.has(d.id)).map(d => [d.id, d]));
    const prior = this.#family;
    this.#family = next;
    for (const id of prior.keys()) if (!next.has(id)) this.#emit({type: 'removed', id});
  }

  /** Public view, newest first, without token hashes. */
  list() {
    return [...this.#devices.values(), ...this.#family.values()]
      .map(({ tokenHash, ...rest }) => rest)
      .sort((a, b) => (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt));
  }

  /** Device record for a bearer token, or undefined. */
  verify(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return undefined;
    const want = Buffer.from(hash(token));
    for (const device of [...this.#devices.values(), ...this.#family.values()]) {
      const have = Buffer.from(device.tokenHash);
      if (have.length === want.length && timingSafeEqual(have, want)) return device;
    }
    return undefined;
  }

  /** Register (or re-register) a phone and return its new token. Re-pairing revokes the old token. */
  async add(info, now = Date.now()) {
    const id = DEVICE_ID.test(info?.id) ? info.id : randomBytes(12).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const record = {
      id, name: cleanName(info?.name) || '手机', model: cleanName(info?.model), system: cleanName(info?.system), app: cleanName(info?.app),
      pairedAt: now, lastSeenAt: now, lastAddress: '', tokenHash: hash(token),
    };
    const replaced = this.#devices.delete(id);
    this.#devices.set(id, record);
    if (replaced) this.#emit({ type: 'removed', id });
    while (this.#devices.size > MAX_DEVICES) {
      const oldest = [...this.#devices.values()].sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0))[0];
      this.#devices.delete(oldest.id);
      this.#emit({ type: 'removed', id: oldest.id });
    }
    await this.#save();
    this.#emit({ type: 'paired', device: this.list().find(d => d.id === id) });
    return { device: record, token };
  }

  async remove(id) {
    if (this.#family.delete(id)) this.#blocked.add(id);
    else if (!this.#devices.delete(id)) return false;
    await this.#save();
    this.#emit({ type: 'removed', id });
    return true;
  }

  /** Record a successful connection. Saved lazily: at most once a minute per device. */
  async touch(id, address, now = Date.now()) {
    const d = this.#devices.get(id);
    if (!d) return;
    const stale = now - (d.lastSeenAt ?? 0) > 60e3 || d.lastAddress !== address;
    d.lastSeenAt = now; d.lastAddress = address ?? '';
    if (stale) await this.#save();
  }

  onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  /** Wait for queued writes, e.g. before shutdown. */
  flush() { return this.#writing; }
  #emit(event) { for (const fn of this.#listeners) { try { fn(event); } catch {} } }
  #writing = Promise.resolve();
  /** Writes are serialized so an older snapshot never lands after a newer one. */
  #save() {
    const run = () => writePrivate(this.#path, JSON.stringify({ version: 1, blocked: [...this.#blocked], devices: [...this.#devices.values()] }, null, 2) + '\n');
    this.#writing = this.#writing.then(run, run);
    return this.#writing;
  }
}

/**
 * The code shown in the QR. One code is valid at a time; it expires after
 * `ttlMs`, is single use, and is replaced after too many wrong attempts.
 */
export class PairingCodes {
  #code = ''; #expiresAt = 0; #failures = []; #listeners = new Set();
  constructor({ ttlMs = 5 * 60e3, maxFailures = 10, failureWindowMs = 60e3, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, maxFailures, failureWindowMs, now });
  }

  /** Current offer, rotating when expired. */
  current() {
    if (!this.#code || this.now() >= this.#expiresAt) this.rotate();
    return { code: this.#code, expiresAt: this.#expiresAt };
  }

  rotate() {
    this.#code = randomBytes(18).toString('base64url');
    this.#expiresAt = this.now() + this.ttlMs;
    for (const fn of this.#listeners) { try { fn(this.current()); } catch {} }
  }

  /** 'ok' consumes the code; otherwise 'expired' | 'invalid' | 'locked'. */
  redeem(code) {
    const now = this.now();
    this.#failures = this.#failures.filter(t => now - t < this.failureWindowMs);
    if (this.#failures.length >= this.maxFailures) return 'locked';
    if (!this.#code || now >= this.#expiresAt) {
      this.rotate();
      return typeof code === 'string' && code.length > 0 ? 'expired' : 'invalid';
    }
    const want = Buffer.from(this.#code), have = Buffer.from(typeof code === 'string' ? code : '');
    if (have.length === want.length && timingSafeEqual(have, want)) { this.rotate(); return 'ok'; }
    this.#failures.push(now);
    if (this.#failures.length >= this.maxFailures) this.rotate();
    return 'invalid';
  }

  onRotate(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
}
