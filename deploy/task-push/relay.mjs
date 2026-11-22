import { createHmac, sign, timingSafeEqual } from 'node:crypto';
import http2 from 'node:http2';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const id = (s) => typeof s === 'string' && /^[\w-]{1,128}$/.test(s);
export function valid(m) {
  const s = m?.state;
  return (
    id(m?.desktopId) &&
    id(m.eventId) &&
    id(m.kind) &&
    id(s?.phase) &&
    id(s.sessionId) &&
    Number.isSafeInteger(s.turn) &&
    s.turn >= 0 &&
    Number.isSafeInteger(s.step) &&
    s.step >= 0 &&
    Number.isSafeInteger(s.updatedAt) &&
    typeof s.terminal === 'boolean' &&
    [m.title, s.label, s.detail].every((x) => typeof x === 'string' && x.length <= 64) &&
    (['update', 'start', 'end'].includes(m.method)
      ? typeof m.token === 'string' && /^(?:[a-f0-9]{2}){16,256}$/.test(m.token)
      : m.method === 'bark' && id(m.token))
  );
}
export function payload(m, t = Math.floor(Date.now() / 1000)) {
  const { sessionId, turn, step, phase, label, detail, terminal, updatedAt } = m.state;
  if (m.method === 'bark' && m.kind === 'test')
    return { device_key: m.token, title: 'DSH · 推送测试', body: 'Bark 通知通道已接通。', group: 'DSH' };
  if (m.method === 'bark')
    return {
      device_key: m.token,
      title: 'DSH · ' + m.title,
      body: `第 ${turn} 轮 · 第 ${step} 步` + (detail ? ' · ' + detail : ''),
      group: 'DSH-' + m.desktopId + '-' + sessionId,
      level: ['question', 'approval', 'error', 'blocked'].includes(m.kind) ? 'timeSensitive' : 'active',
      url: `dshmobile://task/${m.desktopId}/${sessionId}`,
    };
  const aps = {
    timestamp: t,
    event: m.method,
    'content-state': { turn, step, phase, label, detail, terminal, updatedAt },
  };
  if (m.method === 'start')
    Object.assign(aps, {
      'attributes-type': 'DSHTaskAttributes',
      attributes: { desktopId: m.desktopId, sessionId, turn },
      alert: { title: 'DSH 任务开始', body: `第 ${turn} 轮` },
      'input-push-token': 1,
    });
  if (m.method === 'end') aps['dismissal-date'] = phase === 'completed' ? t - 1 : t + 300;
  else aps['stale-date'] = t + 180;
  return { aps };
}
export function providers(env) {
  let jwt = '',
    issued = 0;
  const last = new Map();
  return async (m) => {
    if (m.method === 'bark') {
      const r = await fetch(new URL('/push', env.BARK_ORIGIN || 'http://bark:8080'), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(m)),
      });
      if (!r.ok || (await r.json()).code !== 200) throw Error('Bark failed');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!jwt || now - issued > 2700) {
      const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const body =
        enc({ alg: 'ES256', kid: env.APNS_KEY_ID }) + '.' + enc({ iss: env.APNS_TEAM_ID, iat: now });
      jwt =
        body +
        '.' +
        sign('sha256', Buffer.from(body), {
          key: readFileSync(env.APNS_KEY_FILE || '/run/secrets/apns.p8'),
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
      issued = now;
    }
    // APNs compares whole-second timestamps. Serialize successive updates for the same
    // activity across a second boundary so an end cannot lose to a progress update.
    const stamp = Math.max(Math.floor(Date.now() / 1000), (last.get(m.token) || 0) + 1);
    last.delete(m.token);
    last.set(m.token, stamp);
    if (last.size > 4096) last.delete(last.keys().next().value);
    if (stamp * 1000 > Date.now()) await new Promise((r) => setTimeout(r, stamp * 1000 - Date.now()));
    const client = http2.connect(
      env.APNS_SANDBOX === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
    );
    try {
      await new Promise((resolve, reject) => {
        client.once('error', reject);
        client.setTimeout(6000, () => client.destroy(new Error('timeout')));
        const req = client.request({
          ':method': 'POST',
          ':path': '/3/device/' + m.token,
          authorization: 'bearer ' + jwt,
          'apns-topic': (env.APNS_BUNDLE_ID || 'app.dshmobile.client') + '.push-type.liveactivity',
          'apns-push-type': 'liveactivity',
          'apns-priority':
            m.method === 'update' && ['step', 'tool', 'result', 'compact'].includes(m.kind) ? '5' : '10',
          'apns-expiration': String(now + (m.method === 'start' ? 90 : 300)),
        });
        req.on('response', (h) => (h[':status'] === 200 ? resolve() : reject(new Error('APNs failed'))));
        req.on('error', reject);
        req.resume();
        req.end(JSON.stringify(payload(m, stamp)));
      });
    } finally {
      client.destroy();
    }
  };
}
export function receiver(secret, deliver) {
  if (!secret || secret.length < 32)
    throw Error('Configure a private relay secret of at least 32 characters');
  const nonces = new Map(),
    seen = new Map(),
    active = new Map();
  function prune(map, now) {
    for (const [k, t] of map) {
      if (t > now) break;
      map.delete(k);
    }
  }
  return createServer({ requestTimeout: 12000, headersTimeout: 10000 }, async (req, res) => {
    const end = (n) => {
      res.writeHead(n, { 'cache-control': 'no-store' });
      res.end();
    };
    if (req.method !== 'POST' || req.url !== '/v1/event') return end(404);
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        if ((size += c.length) > 8192) return end(413);
        chunks.push(c);
      }
      const b = Buffer.concat(chunks),
        t = req.headers['x-dsh-time'],
        n = req.headers['x-dsh-nonce'],
        h = req.headers['x-dsh-signature'],
        now = Date.now();
      prune(nonces, now);
      prune(seen, now);
      if (
        !/^\d{13}$/.test(t) ||
        Math.abs(now - Number(t)) > 60000 ||
        !id(n) ||
        !/^\w{64}$/.test(h) ||
        !timingSafeEqual(
          Buffer.from(
            createHmac('sha256', secret)
              .update(t + '.' + n + '.')
              .update(b)
              .digest('hex'),
          ),
          Buffer.from(h),
        ) ||
        nonces.has(n)
      )
        return end(401);
      if (nonces.size >= 20000 || seen.size >= 40000) return end(429);
      nonces.set(n, now + 120000);
      const m = JSON.parse(b);
      if (!valid(m)) return end(400);
      const key = m.eventId;
      if (seen.has(key)) return end(200);
      const prior = active.get(key);
      if (prior) {
        try {
          await prior;
          return end(200);
        } catch {
          return end(502);
        }
      }
      const delivery = Promise.resolve().then(() => deliver(m));
      active.set(key, delivery);
      try {
        await delivery;
        seen.set(key, Date.now() + 300000);
        return end(200);
      } catch {
        return end(502);
      } finally {
        active.delete(key);
      }
    } catch {
      return end(400);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  receiver(readFileSync(env.SECRET_FILE || '/run/secrets/relay', 'utf8').trim(), providers(env)).listen(
    8081,
    '0.0.0.0',
  );
}
