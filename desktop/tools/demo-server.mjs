#!/usr/bin/env node
// Serve a recorded fixture through the real link server (TLS, pairing, token
// checks, read-only policy). Prints the pairing link; with --link-file also
// writes it there, for simulator UI tests.
//
//   node tools/demo-server.mjs --fixture test/fixtures/simulator.json [--port 3081] [--host 127.0.0.1] [--speed 1] [--link-file link.txt]
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadIdentity } from '../lib/identity.mjs';
import { DeviceRegistry, PairingCodes } from '../lib/devices.mjs';
import { createLinkServer } from '../lib/link-server.mjs';
import { replayUpstream } from '../lib/upstream-replay.mjs';
import { pairLink, qrTerminal } from '../lib/pair-link.mjs';

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, port: { type: 'string', default: '3081' }, host: { type: 'string', default: '127.0.0.1' },
  actions: { type: 'boolean' }, speed: { type: 'string', default: '1' }, 'link-file': { type: 'string' }, name: { type: 'string', default: '演示电脑' },
  state: { type: 'string' }, ttl: { type: 'string', default: '600' },
} });
if (!values.fixture) { console.error('--fixture <file> is required'); process.exit(2); }

const fixture = JSON.parse(await readFile(values.fixture, 'utf8'));
const dir = values.state ?? await mkdtemp(join(tmpdir(), 'dsh-demo-'));
const identity = await loadIdentity(dir, { name: values.name });
const devices = await new DeviceRegistry(dir).load();
const codes = new PairingCodes({ ttlMs: Number(values.ttl) * 1000 });
const speed = values.speed === 'max' ? Infinity : Number(values.speed);
const link = createLinkServer({ identity, devices, codes, upstream: replayUpstream(fixture, { speed }), actions: () => values.actions === true, log: e => console.log(JSON.stringify(e)) });
const address = await link.listen(Number(values.port), values.host);

const show = async () => {
  const { code, expiresAt } = codes.current();
  const text = pairLink({ id: identity.id, name: identity.name, fingerprint: identity.fingerprint, code, expiresAt, endpoints: [{ host: values.host, port: address.port }] });
  if (values['link-file']) await writeFile(values['link-file'], text + '\n');
  console.log(`\nDSH Mobile demo link on ${values.host}:${address.port}\n${text}\n`);
  if (process.stdout.isTTY) console.log(await qrTerminal(text));
};
codes.onRotate(() => { show().catch(() => {}); });
await show();
// Expired codes are replaced on the next check; this keeps the printed link fresh.
setInterval(() => codes.current(), 5000).unref();
const stop = async () => { await link.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
