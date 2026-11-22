// Serve the host installation's official DSH web entry and live plugin graph.
// Supports both DSH 0.2.2+ (`webServer.readResource(request, peer)` + per-Peer
// `renderIndex(html, peer)`) and DSH 0.2.1-rc.3 (`distRoot` + `clientModules`).
// No copied UI, forked application state, host login token or launch URL.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { injectMobileShell } from './mobile-shell.mjs';

const gzipAsset = promisify(gzip);
const brotliAsset = promisify(brotliCompress);
const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } };
const acceptsEncoding = (header, encoding) => String(header ?? '').split(',').some(part =>
  new RegExp(`^\\s*${encoding}\\s*(?:;\\s*q=(?:1(?:\\.0{0,3})?|0\\.(?=\\d*[1-9])\\d{1,3}))?\\s*$`, 'i').test(part));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function resolveOfficialDist({ resourcesPath = process.resourcesPath ?? join(dirname(process.execPath), 'resources'), entryPath = process.argv[1] } = {}) {
  // Electron transparently resolves its own ASAR paths for the in-process plugin.
  const candidates = [];
  if (resourcesPath) candidates.push(join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'));
  for (const base of [entryPath, import.meta.url]) {
    if (!base) continue;
    try {
      const req = createRequire(base);
      candidates.push(join(dirname(req.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist'));
    } catch {}
  }
  return candidates.find(root => existsSync(join(root, 'index.html')));
}

/** Only callers that already verified the paired device may use this handler. */
export function createOfficialWeb({ webServer, clientModules, connection, distRoot = resolveOfficialDist() }) {
  const getClientModules = () => (typeof clientModules === 'function' ? clientModules() : clientModules);
  const hasReadResource = typeof webServer?.readResource === 'function';
  const hasLegacyDist = () => !!distRoot && typeof webServer?.renderIndex === 'function' && typeof getClientModules()?.fetchBundle === 'function';
  const isUsable = () => hasReadResource || hasLegacyDist();
  const root = distRoot && resolve(distRoot);
  const cache = new Map();
  let cacheBytes = 0;

  const response = (status, body = '', type = 'text/plain; charset=utf-8') => ({
    status,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
    body: Buffer.from(body),
  });

  function resolvePeer(peer) {
    return peer ?? connection?.browserPeer ?? { principal: { kind: 'owner' } };
  }

  async function legacyResource(path, request, peer, shellMeta) {
    const cm = getClientModules();
    if (path.startsWith('/plugins/') && typeof cm?.fetchBundle === 'function') {
      const fetched = await cm.fetchBundle(new Request('https://dsh.invalid' + request.url, { method: 'GET' }));
      return { status: fetched.status, headers: Object.fromEntries(fetched.headers), body: Buffer.from(await fetched.arrayBuffer()) };
    }
    if (!root) return response(404);
    const target = resolve(root, '.' + path);
    if (target !== root && !target.startsWith(root + sep)) return response(403);
    if (target === root || path === '/index.html') {
      const raw = await readFile(join(root, 'index.html'), 'utf8');
      const rendered = webServer.renderIndex(raw, resolvePeer(peer));
      return response(200, injectMobileShell(rendered, shellMeta), TYPES['.html']);
    }
    // Never expose arbitrary host files. Paths must stay inside official dist.
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) return response(404);
      const body = await readFile(target);
      return {
        status: 200,
        headers: {
          'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
          'cache-control': path.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, max-age=300',
        },
        body,
      };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return response(404);
      throw error;
    }
  }

  async function resource(path, request, peer, shellMeta) {
    // Reject path traversal before delegating to any resource handler.
    if (root && !path.startsWith('/plugins/')) {
      const check = resolve(root, '.' + path);
      if (check !== root && !check.startsWith(root + sep)) return response(403);
    }
    if (hasReadResource) {
      const headers = new Headers();
      if (request.headers?.['if-none-match']) headers.set('if-none-match', String(request.headers['if-none-match']));
      const fetched = await webServer.readResource(
        new Request('https://dsh.invalid' + request.url, { method: 'GET', headers }),
        resolvePeer(peer),
      );
      if (fetched.status !== 404 || !hasLegacyDist()) {
        const resHeaders = Object.fromEntries(fetched.headers);
        delete resHeaders['content-encoding'];
        delete resHeaders['content-length'];
        const buf = Buffer.from(await fetched.arrayBuffer());
        const isIndex = (path === '/' || path === '/index.html')
          && fetched.status === 200
          && /text\/html/i.test(resHeaders['content-type'] ?? '');
        if (isIndex) {
          resHeaders['cache-control'] = 'no-store';
          return {
            status: 200,
            headers: resHeaders,
            body: Buffer.from(injectMobileShell(buf.toString('utf8'), shellMeta)),
          };
        }
        return { status: fetched.status, headers: resHeaders, body: buf };
      }
    }
    return legacyResource(path, request, peer, shellMeta);
  }

  let warmedForHtml = '';
  const isCacheableResource = (path, rawUrl) => (
    path.startsWith('/assets/') || (path.startsWith('/plugins/') && /[?&](?:rev|v)=/i.test(rawUrl ?? ''))
  );
  function prewarmLinkedAssets(html, peer, preferBr) {
    if (!html || html === warmedForHtml) return;
    warmedForHtml = html;
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)=["']((?:\.\/|\/)?(?:assets|plugins)\/[^"'#]+)["']/gi)) {
      const decoded = m[1].replace(/&amp;/gi, '&').replace(/^\.\//, '/');
      const normalized = decoded.startsWith('/') ? decoded : '/' + decoded;
      if (!normalized.includes('..') && isCacheableResource(normalized.split('?')[0], normalized)) {
        urls.add(normalized);
      }
      if (urls.size >= 16) break;
    }
    for (const assetUrl of urls) {
      if (cache.has(assetUrl)) continue;
      void resource(assetUrl.split('?')[0], { url: assetUrl, headers: {} }, peer, undefined).then(item => {
        if (!item || item.status !== 200) return;
        item.headers['x-content-type-options'] = 'nosniff';
        item.headers['referrer-policy'] = 'same-origin';
        item.headers['etag'] = 'W/"' + createHash('sha256').update(item.body).digest('base64url') + '"';
        item.headers.vary = 'Accept-Encoding';
        item.headers['cache-control'] = 'private, max-age=31536000, immutable';
        while (cache.size && (cache.size >= 160 || cacheBytes + item.body.length > 64 * 1024 * 1024)) {
          const key = cache.keys().next().value;
          cacheBytes -= cache.get(key).body.length;
          cache.delete(key);
        }
        cacheBytes += item.body.length;
        cache.set(assetUrl, item);
        if (item.body.length > 1024 && /javascript|text\/|json|svg/.test(item.headers['content-type'] ?? '')) {
          if (preferBr) {
            item.br ??= brotliAsset(item.body, BROTLI_OPTS).catch(err => { delete item.br; throw err; });
            item.br.catch(() => {});
          } else {
            item.gzip ??= gzipAsset(item.body, { level: 5 }).catch(err => { delete item.gzip; throw err; });
            item.gzip.catch(() => {});
          }
        }
      }, () => {});
    }
  }

  return {
    available: () => isUsable(),
    async fetch(request, { peer, shellMeta } = {}) {
      if (!isUsable()) return response(503, 'Official DSH web resources are unavailable. Update the desktop connection plugin.');
      if (!['GET', 'HEAD'].includes(request.method)) return response(405);
      let path;
      try { path = decodeURIComponent(new URL(request.url, 'https://dsh.invalid').pathname); } catch { return response(400); }
      if (path.includes('\\') || path.includes('\0')) return response(400);
      if (path.startsWith('/api/') || path.startsWith('/mobile/') || path.startsWith('/dsh-mobile-link')) return response(404);
      const cacheKey = String(request.url ?? path).replace(/^\.\//, '/');
      const cacheable = isCacheableResource(path, cacheKey);
      let item = cacheable && cache.get(cacheKey);
      if (!item) {
        item = await resource(path, request, peer, shellMeta);
        item.headers['x-content-type-options'] = 'nosniff';
        item.headers['referrer-policy'] = 'same-origin';
        if (item.status === 200) {
          item.headers['etag'] = 'W/"' + createHash('sha256').update(item.body).digest('base64url') + '"';
          item.headers.vary = 'Accept-Encoding';
          if (cacheable && !/no-store/i.test(item.headers['cache-control'] ?? '')) {
            item.headers['cache-control'] = 'private, max-age=31536000, immutable';
          } else if (path.startsWith('/plugins/') && !/no-store/i.test(item.headers['cache-control'] ?? '')) {
            item.headers['cache-control'] = 'private, no-cache';
          }
        }
        if (cacheable && item.status === 200) {
          while (cache.size && (cache.size >= 160 || cacheBytes + item.body.length > 64 * 1024 * 1024)) {
            const key = cache.keys().next().value;
            cacheBytes -= cache.get(key).body.length;
            cache.delete(key);
          }
          cacheBytes += item.body.length;
          cache.set(cacheKey, item);
        }
      }
      const acceptEncoding = request.headers?.['accept-encoding'] ?? '';
      const useBr = acceptsEncoding(acceptEncoding, 'br');
      const useGzip = !useBr && acceptsEncoding(acceptEncoding, 'gzip');
      if ((path === '/' || path === '/index.html') && item.status === 200) {
        prewarmLinkedAssets(item.body.toString('utf8'), peer, useBr);
      }
      const headers = { ...item.headers };
      if (request.headers?.['if-none-match'] === headers.etag && item.status === 200) {
        return { status: 304, headers, body: Buffer.alloc(0) };
      }
      let body = item.body;
      if ((useBr || useGzip) && body.length > 1024 && /javascript|text\/|json|svg/.test(headers['content-type'] ?? '')) {
        // Keep the host event loop free while cold-loading the official plugin bundle.
        if (useBr) {
          item.br ??= brotliAsset(body, BROTLI_OPTS).catch(error => { delete item.br; throw error; });
          body = await item.br;
          headers['content-encoding'] = 'br';
        } else {
          item.gzip ??= gzipAsset(body, { level: 5 }).catch(error => { delete item.gzip; throw error; });
          body = await item.gzip;
          headers['content-encoding'] = 'gzip';
        }
        headers.vary = 'Accept-Encoding';
      }
      headers['content-length'] = body.length;
      return { status: item.status, headers, body: request.method === 'HEAD' ? Buffer.alloc(0) : body };
    },
  };
}
