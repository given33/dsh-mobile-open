// Upstream that talks to a DSH web host over loopback HTTP, the way the
// desktop web UI does: the launch URL's one-time token is exchanged for the
// host's dsh-auth-* session cookie, which stays in this process's memory.
import { WebSocket } from 'ws';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Exchange a launch URL (http://127.0.0.1:port/?token=…) for the session cookie. */
export async function exchangeLaunchURL(launchURL, { timeoutMs = 10e3 } = {}) {
  const url = new URL(launchURL);
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) throw new Error('The Harness address must be a loopback URL on this computer.');
  if (!url.searchParams.get('token')) throw new Error('Use the Harness launch URL that includes ?token=.');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const cookie = response.headers.getSetCookie().filter(c => c.startsWith('dsh-auth-')).map(c => c.split(';')[0]).join('; ');
  if (!cookie || response.status >= 400) throw new Error('Harness refused the launch token. Use the URL of the Harness process that is running now.');
  url.search = ''; url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { base: url, cookie };
}

/**
 * @param {{ base: URL, cookie: string }} auth
 * @returns the upstream interface used by createLinkServer.
 */
export function httpUpstream({ base, cookie }, { rpcTimeoutMs = 20e3 } = {}) {
  let healthy = true;
  return {
    available: () => healthy,
    async rpc(method, body) {
      try {
        const res = await fetch(new URL(`api/${method}`, base), {
          method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(rpcTimeoutMs),
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        });
        healthy = res.status !== 401;
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
      } catch (error) { healthy = false; throw error; }
    },
    async upload({ sessionId, name, mediaType, body }) {
      const url = new URL('api/session/uploadFileBinary', base);
      url.searchParams.set('sessionId', sessionId);
      if (name) url.searchParams.set('name', name);
      if (mediaType) url.searchParams.set('mediaType', mediaType);
      const res = await fetch(url, { method: 'POST', body, duplex: 'half', redirect: 'manual', signal: AbortSignal.timeout(20 * 60e3),
        headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' } });
      healthy = res.status !== 401;
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    },
    mux() {
      const target = new URL('api/remote.mux', base);
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(target, { headers: { Cookie: cookie }, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 10e3, perMessageDeflate: false });
      return new Promise((resolve, reject) => {
        ws.once('open', () => {
          healthy = true;
          resolve({
            send: text => ws.send(text),
            close: () => ws.close(),
            on(event, fn) {
              if (event === 'message') ws.on('message', (data, isBinary) => fn(data, isBinary));
              else if (event === 'close') ws.on('close', () => fn());
            },
          });
        });
        ws.on('error', error => { healthy = false; reject(error); });
        ws.once('unexpected-response', (req, res) => {
          healthy = res.statusCode !== 401;
          res.resume();
          reject(new Error(`Harness answered ${res.statusCode}`));
          req.destroy();
        });
      });
    },
  };
}
