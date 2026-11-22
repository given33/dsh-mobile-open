// Candidate addresses and the dshmobile://pair link carried by the QR code.
// The format is parsed by Core/Sources/DSHCore/Pairing.swift (PairingOffer).
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import QRCode from 'qrcode';

export const PAIR_VERSION = 1;

// Host-only adapters a phone cannot reach.
const VIRTUAL = /(vethernet|wsl|hyper-?v|default switch|vmware|vmnet|virtualbox|vboxnet|docker|br-[0-9a-f]{6,}|^veth|podman|npcap|loopback|utun|awdl|llw|bridge100|anpi)/i;
const PHYSICAL = /(wi-?fi|wlan|wireless|无线|以太网|ethernet|^en\d|^eth\d|^wl)/i;
const TAILSCALE = /tailscale|^ts\d|^utun.*tail/i;

function classify(address, family) {
  if (family === 'IPv4' || family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan';
    if (a === 127 || (a === 169 && b === 254)) return undefined;
    return 'other';
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  if (lower.startsWith('fe80:') || lower === '::1') return undefined; // link-local needs a zone id
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'lan';
  return 'other';
}

// A configured address may use a different public port than the desktop.
// Unbracketed IPv6 is a bare host; use [IPv6]:port for an explicit port.
function manualEndpoint(value, defaultPort) {
  if (typeof value !== 'string') return;
  const input = value.trim();
  const parts = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(input) ?? /^([^:]+):(\d{1,5})$/.exec(input);
  const host = (parts?.[1] ?? input).toLowerCase();
  const port = parts?.[2] === undefined ? defaultPort : Number(parts[2]);
  if (host.includes(':') ? isIP(host) !== 6 : !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host)) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  return { host, port, kind: 'manual', iface: 'manual', rank: -1 };
}

/**
 * Addresses worth putting in the QR code, best first: physical LAN adapters,
 * then other private adapters, then Tailscale, then anything else. At most
 * `limit` entries so the QR stays easy to scan.
 */
export function candidateHosts({ interfaces = networkInterfaces(), port, extra = [], limit = 5, includePublic = false } = {}) {
  const rows = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      const kind = classify(i.address, i.family);
      if (!kind || (kind === 'other' && !includePublic)) continue;
      const tailscale = TAILSCALE.test(name) || kind === 'tailnet';
      if (VIRTUAL.test(name) && !tailscale) continue;
      const v6 = !(i.family === 'IPv4' || i.family === 4);
      const rank = tailscale ? 3 : kind === 'lan' ? (PHYSICAL.test(name) ? 0 : 1) + (v6 ? 2 : 0) : 5;
      rows.push({ host: i.address, kind: tailscale ? 'tailnet' : kind, iface: name, rank });
    }
  }
  const seen = new Set(), out = [];
  const manual = extra.map(value => manualEndpoint(value, port)).filter(Boolean);
  for (const r of [...manual, ...rows].sort((a, b) => a.rank - b.rank)) {
    const endpoint = { host: r.host, port: r.port ?? port, kind: r.kind, iface: r.iface };
    const key = authority(endpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(endpoint);
  }
  return out.slice(0, limit);
}

export const authority = ({ host, port }) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

/** RFC 3986 component encoding; spaces become %20 (URLComponents does not read '+'). */
const enc = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function pairLink({ id, name, fingerprint, code, expiresAt, endpoints, tunnels = [] }) {
  const parts = [`v=${PAIR_VERSION}`, `id=${enc(id)}`, `n=${enc(name)}`, `fp=${enc(fingerprint)}`, `c=${enc(code)}`];
  if (expiresAt) parts.push(`e=${Math.floor(expiresAt / 1000)}`);
  for (const e of endpoints) parts.push(`h=${enc(authority(e))}`);
  for (const t of tunnels) parts.push(`u=${enc(t)}`);
  return `dshmobile://pair?${parts.join('&')}`;
}

export async function qrSvg(text, { dark = '#111111', light = '#ffffff', margin = 2 } = {}) {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin, color: { dark, light } });
}

export async function qrTerminal(text) {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

export async function qrDataURL(text, { width = 320 } = {}) {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width });
}
