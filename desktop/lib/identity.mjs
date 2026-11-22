// Desktop identity for the phone link: a stable id, a display name, a P-256 key
// and a self-signed TLS certificate for that key. The QR code carries the
// SHA-256 of the key's SubjectPublicKeyInfo; the phone pins that value, so the
// certificate can be renewed without re-pairing and no CA or hostname check is
// involved.
import { generateKeyPairSync, sign, createHash, randomBytes, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

const der = {
  len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n) { bytes.unshift(n & 0xff); n >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  },
  tlv(tag, ...parts) { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), der.len(body.length), body]); },
  seq(...parts) { return der.tlv(0x30, ...parts); },
  int(buf) { return der.tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf); },
  name(cn) { return der.seq(der.tlv(0x31, der.seq(Buffer.from('0603550403', 'hex'), der.tlv(0x0c, Buffer.from(cn, 'utf8'))))); },
  time(d) {
    const text = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    return d.getUTCFullYear() < 2050 ? der.tlv(0x17, Buffer.from(text.slice(2))) : der.tlv(0x18, Buffer.from(text));
  },
};
const ECDSA_SHA256 = der.seq(Buffer.from('06082a8648ce3d040302', 'hex'));
const DAY = 86400e3;
/** Certificates are re-issued (same key) when fewer days than this remain. */
export const RENEW_DAYS = 45;
export const VALID_DAYS = 397;

/** base64url SHA-256 of the DER SubjectPublicKeyInfo: the value the phone pins. */
export function fingerprintOfKey(key) {
  const pub = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('base64url');
}

/** Self-signed certificate for an existing P-256 key pair. Pure node:crypto. */
export function issueCertificate(privateKey, { commonName = 'DSH Mobile Link', now = new Date(), days = VALID_DAYS } = {}) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const publicKey = createPublicKey(key);
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 0x01;
  const tbs = der.seq(
    der.tlv(0xa0, der.int(Buffer.from([2]))), der.int(serial), ECDSA_SHA256, der.name(commonName),
    der.seq(der.time(new Date(now.getTime() - DAY)), der.time(new Date(now.getTime() + days * DAY))),
    der.name(commonName), publicKey.export({ type: 'spki', format: 'der' }));
  const cert = der.seq(tbs, ECDSA_SHA256, der.tlv(0x03, Buffer.from([0]), sign('sha256', tbs, key)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function createKey() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
}

export async function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const cleanName = value => (value ?? '').toString().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);

function needsCertificate(cert, key, now) {
  try {
    const x = new X509Certificate(cert);
    if (!x.checkPrivateKey(createPrivateKey(key))) return true;
    return new Date(x.validTo).getTime() - now.getTime() < RENEW_DAYS * DAY;
  } catch { return true; }
}

/**
 * Load or create the identity under `dir`: identity.json (id, name),
 * link-key.pem (never rotated; losing it means re-pairing) and link-cert.pem
 * (re-issued from the same key when it nears expiry).
 */
export async function loadIdentity(dir, { name, now = new Date() } = {}) {
  await mkdir(dir, { recursive: true });
  const metaPath = join(dir, 'identity.json'), certPath = join(dir, 'link-cert.pem'), keyPath = join(dir, 'link-key.pem');
  let info = {};
  try { info = JSON.parse(await readFile(metaPath, 'utf8')); } catch {}
  let changed = false;
  if (typeof info.id !== 'string' || !ID.test(info.id)) { info.id = `desk-${randomBytes(12).toString('base64url')}`; changed = true; }
  const wanted = cleanName(name) || cleanName(info.name) || cleanName(hostname()) || '我的电脑';
  if (info.name !== wanted) { info.name = wanted; changed = true; }
  let key;
  try {
    key = await readFile(keyPath, 'utf8');
    const k = createPrivateKey(key);
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('unsupported key');
  } catch {
    key = createKey();
    await writePrivate(keyPath, key);
  }
  let cert = '';
  try { cert = await readFile(certPath, 'utf8'); } catch {}
  if (needsCertificate(cert, key, now)) {
    cert = issueCertificate(key, { now });
    await writePrivate(certPath, cert);
  }
  if (changed) await writePrivate(metaPath, JSON.stringify({ id: info.id, name: info.name }, null, 2) + '\n');
  return { id: info.id, name: info.name, cert, key, fingerprint: fingerprintOfKey(key) };
}
