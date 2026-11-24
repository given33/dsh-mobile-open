// One phone link for one computer: identity, paired phones, one-time codes,
// the TLS link server, and the state the desktop panel shows. Shared by the
// DSH plugin (plugin/host.mjs) and the standalone CLI (bin/dsh-mobile-link.mjs).
import { taskPush } from './task-push.mjs';
import { familyDevices } from './family.mjs';
import { wakeRoutes } from './wake.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentity, writePrivate } from './identity.mjs';
import { DeviceRegistry, PairingCodes } from './devices.mjs';
import { createLinkServer } from './link-server.mjs';
import { candidateHosts, pairLink, qrSvg, authority } from './pair-link.mjs';

/** "37XY 7YXS …": the first 8 bytes of the SPKI pin, the same text the phone shows. */
export function safetyCode(fingerprint) {
  const hex = Buffer.from(fingerprint, 'base64url').subarray(0, 8).toString('hex').toUpperCase();
  return hex.match(/.{1,4}/g)?.join(' ') ?? '';
}

const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } };

/**
 * @param {object} options
 * @param {string} options.stateDir - where the key, certificate and paired phones live.
 * @param {object} options.upstream - DSH access (in-process, loopback cookie, or replay).
 * @param {string} [options.name] - computer name shown on the phone.
 * @param {number} [options.port] - LAN port for phones.
 * @param {string} [options.host] - bind address; default all interfaces.
 * @param {boolean} [options.enabled] - force on/off; default: the last choice saved in the panel (off on first run).
 * @param {string[]} [options.extraHosts] - additional addresses to put in the QR code.
 * @param {string[]} [options.tunnels] - https URLs of the user's own tunnels.
 * @param {number} [options.codeTtlMs] - how long one QR code stays valid.
 */
export async function createLinkService({
  stateDir, upstream, officialWeb, focus, name, port = 3081, host, enabled, actions, terminal, extraHosts = [], tunnels = [], codeTtlMs, log = () => {}, appVersion = '',
}) {
  const identity = await loadIdentity(stateDir, { name });
  const devices = await new DeviceRegistry(stateDir).load();
  let familyTimer;
  if (await readJson(join(stateDir, 'family-policy.json'))) {
    let refreshing = false, failures = 0;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        devices.replaceFamily(await familyDevices(stateDir, identity));
        failures = 0;
      } catch (error) {
        // Missing policy/grants revoke immediately. Tolerate a short failed read,
        // but fail closed if a verifier file stays unreadable.
        if (++failures >= 3 || error.code === 'ENOENT') devices.replaceFamily([]);
      } finally { refreshing = false; }
    };
    await refresh();
    familyTimer = setInterval(refresh, 2000);
    familyTimer.unref();
  }
  const codes = new PairingCodes(codeTtlMs ? { ttlMs: codeTtlMs } : {});
  const settingsPath = join(stateDir, 'settings.json');
  const saved = (await readJson(settingsPath)) ?? {};
  const listeners = new Set();
  let wanted = enabled ?? saved.enabled === true;
  let allowActions = actions ?? saved.actions === true;
  let allowTerminal = terminal ?? saved.terminal === true;
  let settingWrites = Promise.resolve();
  let server = null, address = null, lastError = null, starting = null, closed = false;

  const notifications = await taskPush({stateDir, desktopId:identity.id, devices, live:()=>!!server && !closed && wanted});
  const changed = () => { for (const fn of listeners) { try { fn(); } catch {} } };
  const record = event => {
    log(event);
    if (['paired', 'connected', 'disconnected'].includes(event.type)) changed();
  };
  devices.onChange(changed);
  codes.onRotate(changed);

  async function start() {
    if (server || closed) return;
    if (starting) return starting;
    starting = (async () => {
      const link = createLinkServer({ notifications, identity, devices, codes, upstream, officialWeb, focus, stateDir, wake: () => wakeRoutes(stateDir), endpoints: () => endpoints().map(authority), log: record, appVersion, actions: () => allowActions, terminal: () => allowTerminal });
      try {
        address = await link.listen(port, host).catch(error => {
          if (host || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error?.code)) throw error;
          return link.listen(port, '0.0.0.0'); // IPv6 disabled on this computer
        });
        server = link; lastError = null;
      } catch (error) {
        lastError = error?.code === 'EADDRINUSE' ? { code: 'port-in-use', port } : { code: 'listen-failed', message: String(error?.message ?? error) };
        await link.close().catch(() => {});
      }
    })();
    try { await starting; } finally { starting = null; changed(); }
  }

  async function stop() {
    await starting;
    const link = server;
    server = null; address = null;
    if (link) await link.close().catch(() => {});
    changed();
  }

  function updateSetting(key, value, apply) {
    const update = async () => {
      if (closed) return;
      const next = { ...saved, [key]: value };
      await writePrivate(settingsPath, JSON.stringify(next, null, 2) + '\n');
      Object.assign(saved, next);
      await apply();
    };
    const done = settingWrites.then(update, update);
    settingWrites = done.catch(() => {});
    return done;
  }

  const setEnabled = on => updateSetting('enabled', !!on, async () => {
    wanted = !!on;
    if (wanted) await start(); else await stop();
  });

  const setActions = on => updateSetting('actions', !!on, () => {
    if (allowActions === !!on) return;
    allowActions = !!on;
    server?.disconnect(); // Refresh capabilities on all phones.
    changed();
  });

  const setTerminal = on => updateSetting('terminal', !!on, () => {
    if (allowTerminal === !!on) return;
    allowTerminal = !!on;
    server?.disconnect();
    changed();
  });

  function endpoints() {
    return address ? candidateHosts({ port: address.port, extra: extraHosts }) : [];
  }

  /** Everything the desktop panel (or the CLI) shows. The QR is only issued while listening. */
  let cachedQR;
  async function status() {
    const list = endpoints();
    const live = new Map((server?.connected() ?? []).map(c => [c.id, c.connections]));
    let pairing = null;
    if (server && list.length) {
      const { code, expiresAt } = codes.current();
      const link = pairLink({ id: identity.id, name: identity.name, fingerprint: identity.fingerprint, code, expiresAt, endpoints: list, tunnels });
      if (cachedQR?.link !== link) cachedQR = { link, svg: qrSvg(link) };
      pairing = { link, expiresAt, qrSvg: await cachedQR.svg };
    }
    return {
      version: 1,
      app: appVersion,
      enabled: wanted,
      actions: allowActions,
      terminal: allowTerminal,
      listening: !!server,
      port: address?.port ?? port,
      error: lastError,
      desktop: { id: identity.id, name: identity.name },
      safetyCode: safetyCode(identity.fingerprint),
      addresses: list.map(e => ({ address: authority(e), kind: e.kind, iface: e.iface })),
      pairing,
      devices: devices.list().map(d => ({ ...d, online: live.has(d.id) })),
      upstream: upstream.available?.() ?? true,
    };
  }

  if (wanted) await start();

  return {
    identity, devices, codes, notifications,
    start, stop, setEnabled, setActions, setTerminal, status,
    hasPhones: () => !!server?.connected().length,
    get listening() { return !!server; },
    endpoints,
    rotateCode: () => { codes.rotate(); },
    removeDevice: id => devices.remove(id),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() { closed = true; clearInterval(familyTimer); await notifications.close(); await settingWrites; await stop(); await upstream.dispose?.(); await devices.flush?.(); },
  };
}
