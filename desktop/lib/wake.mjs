// Separate, opt-in listener. Never accepts commands, executable paths, arguments,
// cwd, environment, or credentials from a URL. No dependency on a running DSH.
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeviceRegistry } from './devices.mjs';

export async function wakeConfig(dir) {
  try {
    const cfg = JSON.parse((await readFile(join(dir, 'wake.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (cfg.enabled !== true || !Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) return null;
    if (cfg.publicPort != null && (!Number.isInteger(cfg.publicPort) || cfg.publicPort < 1 || cfg.publicPort > 65535)) return null;
    return cfg;
  } catch { return null; }
}
export async function wakeRoutes(dir) {
  const cfg = await wakeConfig(dir);
  return cfg ? { port: cfg.port, publicPort: cfg.publicPort ?? null } : null;
}
export async function createWakeServer(dir, launch) {
  const key = await readFile(join(dir, 'link-key.pem')), cert = await readFile(join(dir, 'link-cert.pem'));
  let cooldown = 0;
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2', headersTimeout: 5000, requestTimeout: 6000, maxHeaderSize: 4096 }, async (req, res) => {
    const end = status => { res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': 0, Connection: 'close' }); res.end(); };
    if (req.url !== '/mobile/v1/wake' || req.method !== 'POST') return end(404);
    if (req.headers.origin || req.headers.cookie || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) return end(400);
    try {
      const match = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '');
      if (!match) return end(401);
      // Re-read each time: never accept a revoked phone or a disabled policy.
      const [cfg, devices, settings] = await Promise.all([wakeConfig(dir), new DeviceRegistry(dir).load(), readFile(join(dir,'settings.json'),'utf8')]);
      if (!devices.verify(match[1])) return end(401);
      if (!cfg || cfg.port !== server.address()?.port || JSON.parse(settings).enabled !== true) return end(403);
      if (Date.now() >= cooldown) {
        cooldown = Date.now() + 30_000;
        try { await launch(); } catch { cooldown = 0; return end(503); }
      }
      end(202);
    } catch { end(503); }
  });
  server.maxConnections = 24;
  server.setTimeout(6000, socket => socket.destroy());
  return server;
}
