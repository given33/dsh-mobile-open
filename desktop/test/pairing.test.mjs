import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { loadIdentity, issueCertificate, fingerprintOfKey, RENEW_DAYS } from '../lib/identity.mjs';
import { DeviceRegistry, PairingCodes } from '../lib/devices.mjs';
import { candidateHosts, pairLink, qrSvg, authority } from '../lib/pair-link.mjs';

const tempDir = async t => { const dir = await mkdtemp(join(tmpdir(), 'dsh-link-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('identity is stable, certificate renews with the same pinned key', async t => {
  const dir = await tempDir(t);
  const a = await loadIdentity(dir, { name: '工作站\n' });
  assert.match(a.id, /^desk-[A-Za-z0-9_-]{16}$/);
  assert.equal(a.name, '工作站');
  assert.equal(a.fingerprint.length, 43);
  const b = await loadIdentity(dir);
  assert.equal(b.id, a.id); assert.equal(b.fingerprint, a.fingerprint); assert.equal(b.cert, a.cert); assert.equal(b.name, '工作站');
  const x = new X509Certificate(a.cert);
  assert.ok(x.verify(x.publicKey));
  assert.equal(x.subject, 'CN=DSH Mobile Link');
  const days = (new Date(x.validTo) - Date.now()) / 86400e3;
  assert.ok(days > 390 && days < 400, `validity ${days}`);
  const later = new Date(Date.now() + (400 - RENEW_DAYS + 5) * 86400e3);
  const c = await loadIdentity(dir, { now: later });
  assert.notEqual(c.cert, a.cert, 'certificate re-issued near expiry');
  assert.equal(c.fingerprint, a.fingerprint, 'pin survives renewal');
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'link-key.pem'))).mode & 0o077, 0);
});

test('TLS 1.3 handshake exposes the pinned SPKI hash', async t => {
  const dir = await tempDir(t);
  const id = await loadIdentity(dir);
  const server = https.createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.2' }, (q, r) => r.end('ok'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const seen = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false }, () => {
      const peer = s.getPeerX509Certificate();
      resolve({ spki: createHash('sha256').update(peer.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url'), version: s.getProtocol() });
      s.end();
    });
    s.on('error', reject);
  });
  assert.equal(seen.spki, id.fingerprint);
  assert.equal(seen.version, 'TLSv1.3');
  assert.equal(fingerprintOfKey(id.key), id.fingerprint);
  assert.ok(new X509Certificate(issueCertificate(id.key)).checkPrivateKey(await import('node:crypto').then(m => m.createPrivateKey(id.key))));
});

test('device registry stores only hashes, re-pair revokes, remove works', async t => {
  const dir = await tempDir(t);
  const reg = await new DeviceRegistry(dir).load();
  const events = []; reg.onChange(e => events.push(e.type));
  const first = await reg.add({ id: 'iphone-abcdef12', name: '我的 iPhone', model: 'iPhone17,1', system: 'iOS 18.5', app: '0.2.0' }, 1000);
  assert.equal(reg.verify(first.token)?.id, 'iphone-abcdef12');
  assert.equal(reg.verify('x'.repeat(43)), undefined);
  const raw = await readFile(join(dir, 'devices.json'), 'utf8');
  assert.ok(!raw.includes(first.token), 'token not stored in clear');
  assert.equal(reg.list()[0].tokenHash, undefined);
  const second = await reg.add({ id: 'iphone-abcdef12', name: '我的 iPhone' }, 2000);
  assert.equal(reg.verify(first.token), undefined, 'old token revoked by re-pair');
  assert.equal(reg.verify(second.token)?.id, 'iphone-abcdef12');
  const reloaded = await new DeviceRegistry(dir).load();
  assert.equal(reloaded.verify(second.token)?.name, '我的 iPhone');
  assert.equal(await reloaded.remove('iphone-abcdef12'), true);
  assert.equal(reloaded.verify(second.token), undefined);
  const odd = await reg.add({ id: '../../etc', name: '\u0007' }, 3000);
  assert.match(odd.device.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(odd.device.name, '手机');
  assert.deepEqual(events, ['paired', 'removed', 'paired', 'paired']);
});

test('pairing codes are single use, expire and lock after repeated failures', () => {
  let now = 0;
  const codes = new PairingCodes({ ttlMs: 1000, maxFailures: 3, failureWindowMs: 10_000, now: () => now });
  const a = codes.current();
  assert.equal(a.code.length, 24);
  assert.equal(codes.redeem(a.code), 'ok');
  assert.equal(codes.redeem(a.code), 'invalid', 'single use');
  const b = codes.current();
  assert.notEqual(b.code, a.code);
  now = 1500;
  assert.equal(codes.redeem(b.code), 'expired');
  const c = codes.current();
  assert.equal(codes.redeem('wrong-1'), 'invalid', 'second failure (the reused code was the first)');
  assert.equal(codes.redeem('wrong-2'), 'invalid', 'third failure locks and rotates');
  assert.equal(codes.redeem(codes.current().code), 'locked');
  assert.notEqual(codes.current().code, c.code, 'rotated after lockout');
  now = 20_000;
  assert.equal(codes.redeem(codes.current().code), 'ok', 'unlocks after the window');
});

test('candidate hosts skip virtual adapters and rank physical LAN first', () => {
  const interfaces = {
    '以太网': [{ family: 'IPv6', address: 'fe80::2', internal: false }, { family: 'IPv4', address: '192.168.50.12', internal: false }],
    'demo-vpn': [{ family: 'IPv4', address: '10.10.0.4', internal: false }],
    'WLAN': [{ family: 'IPv4', address: '192.168.51.18', internal: false }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.0.1', internal: false }],
    'Tailscale': [{ family: 'IPv4', address: '100.64.0.9', internal: false }, { family: 'IPv6', address: 'fd7a:115c:a1e0::1234', internal: false }],
    'lo': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Public': [{ family: 'IPv4', address: '203.0.113.25', internal: false }],
  };
  const hosts = candidateHosts({ interfaces, port: 3081 });
  assert.deepEqual(hosts.map(h => h.host), ['192.168.50.12', '192.168.51.18', '10.10.0.4', '100.64.0.9', 'fd7a:115c:a1e0::1234']);
  assert.deepEqual(candidateHosts({ interfaces, port: 3081, extra: ['desk.local'], limit: 2 }).map(h => h.host), ['desk.local', '192.168.50.12']);
});

test('pair link matches the Swift parser format and renders as a QR code', async () => {
  const link = pairLink({
    id: 'desk-7f3a91c2', name: '工作站 A&B', fingerprint: 'oNDVQLlkzc6EAbCdEfGhIjKlMnOpQrStUvWxYz01234', code: 'Zk3pQ9vL2mX8rT4wY6uB1nC5',
    expiresAt: 4102444800_000, endpoints: [{ host: '192.168.1.20', port: 3081 }, { host: 'fd7a:115c:a1e0::5', port: 3081 }],
  });
  assert.equal(link, 'dshmobile://pair?v=1&id=desk-7f3a91c2&n=%E5%B7%A5%E4%BD%9C%E7%AB%99%20A%26B&fp=oNDVQLlkzc6EAbCdEfGhIjKlMnOpQrStUvWxYz01234&c=Zk3pQ9vL2mX8rT4wY6uB1nC5&e=4102444800&h=192.168.1.20%3A3081&h=%5Bfd7a%3A115c%3Aa1e0%3A%3A5%5D%3A3081');
  const url = new URL(link);
  assert.equal(url.searchParams.get('n'), '工作站 A&B');
  assert.deepEqual(url.searchParams.getAll('h'), ['192.168.1.20:3081', '[fd7a:115c:a1e0::5]:3081']);
  assert.equal(authority({ host: '::1', port: 1 }), '[::1]:1');
  const svg = await qrSvg(link);
  assert.match(svg, /^<svg[^>]+viewBox/);
  assert.ok(link.length < 300, `link length ${link.length}`);
});

test('one QR can advertise standard HTTPS, legacy public port and local listener', () => {
  const endpoints = candidateHosts({
    interfaces: { eth0: [{ address: '192.168.1.20', family: 'IPv4' }] },
    port: 3443,
    extra: ['203.0.113.12:443', '203.0.113.12', '203.0.113.12:03443',
      '[2001:db8::10]:443', 'bad.example:65536', 'https://bad.example', 'bad.example:0'],
  });
  const link = pairLink({ id: 'desk-1234', name: 'Desktop', fingerprint: 'test', code: 'test', endpoints });
  assert.deepEqual(new URL(link).searchParams.getAll('h'), [
    '203.0.113.12:443', '203.0.113.12:3443', '[2001:db8::10]:443', '192.168.1.20:3443',
  ]);
});
