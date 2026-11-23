// Per-request transport selection. The host owns its dispatcher, proxy policy and credentials.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const preferredLifetime = 30 * 86400_000;
const refused = new Set([401, 403, 407, 451]);
const preConnect = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_PRX_CONN']);
const transportLost = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

// Same origin and API prefix, not just the hostname: gateways often serve multiple tenants.
function modelTarget(input, init) {
  const request = typeof input === 'object' && input !== null ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (method !== 'POST' && method !== 'GET') return;
  const url = URL.parse(request?.url ?? input);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) return;
  const suffix = method === 'GET' ? /\/models\/?$/ : /\/(?:chat\/completions|messages|responses|models\/[^/]+:(?:streamGenerateContent|generateContent))\/?$/;
  const match = suffix.exec(url.pathname);
  if (!match) return;
  const headers = new Headers(init?.headers ?? request?.headers);
  if (!/^deepseek-harness\//i.test(headers.get('user-agent') ?? '')) return;
  const key = createHash('sha256').update(url.origin + url.pathname.slice(0, match.index)).digest('hex');
  const body = init?.body ?? request?.body;
  return { url, key, method, signal: init?.signal ?? request?.signal,
    replayable: body == null || typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer };
}

export async function openRouteMemory(dir) {
  const path = join(dir, 'model-network-rules.json');
  const rules = new Map();
  let pending = Promise.resolve();
  try {
    const rows = JSON.parse(await readFile(path, 'utf8'));
    for (const [key, rule] of Object.entries(rows)) {
      if (/^[0-9a-f]{64}$/.test(key) && ['direct','proxy'].includes(rule?.route) && rule.until > Date.now()) rules.set(key, rule);
    }
  } catch { /* First run or unavailable storage: routing still works in memory. */ }
  return {
    get(key) { const rule = rules.get(key); return rule?.until > Date.now() ? rule.route : undefined; },
    remember(key, route) {
      const old = rules.get(key);
      if (old?.route === route && old.until > Date.now() + preferredLifetime / 2) return;
      rules.delete(key);
      rules.set(key, { route, until: Date.now() + preferredLifetime });
      while (rules.size > 256) rules.delete(rules.keys().next().value);
      pending = pending.then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const temp = path + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, JSON.stringify(Object.fromEntries(rules)), { mode: 0o600 });
          await rename(temp, path);
        } finally { await rm(temp, {force:true}); }
      }).catch(() => {});
    },
    flush: () => pending,
  };
}

function networkFailure(error) {
  const detail = error?.cause ?? error;
  if (preConnect.has(detail?.code) || detail?.errors?.length && detail.errors.every(e => preConnect.has(e.code))) return 'connect';
  if (detail?.code === 'UND_ERR_ABORTED' && /^Proxy response \(\d+\) !== 200 when HTTP Tunneling$/.test(detail.message)) return 'connect';
  if (transportLost.has(detail?.code)) return 'ambiguous';
}

function successfulModelResponse(response) {
  return response.ok && /^(?:application\/(?:[\w.+-]*\+)?json|text\/event-stream|application\/x-ndjson)\b/i.test(response.headers.get('content-type') ?? '');
}

export function routedModelFetch({ original, hostProxy, systemProxy, direct, proxyAgent, memory, listingTimeoutMs = 3500 }) {
  const nextAttempts = new Map();
  return async function fetchWithModelRoutes(input, init) {
    // Explicit transports can carry mTLS, security restrictions, or a caller-owned mock.
    if (init?.dispatcher || init?.agent) return original(input, init);
    const target = modelTarget(input, init);
    if (!target) return original(input, init);
    const { key, url, method, signal, replayable } = target;
    const host = hostProxy(url);
    const lookupSystem = !host && systemProxy;
    if (!host && !lookupSystem) return original(input, init);
    signal?.throwIfAborted();
    // Resolve an OS-only proxy once per destination. A local Windows bypass or
    // absent proxy must leave even the model request completely untouched.
    const proxy = host || await lookupSystem(url);
    signal?.throwIfAborted();
    if (!proxy) return original(input, init);
    const hint = nextAttempts.get(key);
    nextAttempts.delete(key);
    const route = (hint?.until > Date.now() && hint.route) || memory.get(key) || 'proxy';
    // Limit only the listing's time to first headers. A long time to first
    // token for a paid generation is NOT proof of a dead route.
    const listing = method === 'GET' ? new AbortController() : undefined;
    const timer = listing && setTimeout(() => listing.abort(), listingTimeoutMs);
    const send = (r, deadline) => {
      signal?.throwIfAborted();
      // Never forward custom credential headers or replay the prompt at a redirected origin.
      const attemptSignal = deadline && signal ? AbortSignal.any([deadline, signal]) : deadline ?? signal;
      return original(input, { ...init, signal: attemptSignal, redirect: 'error', dispatcher: r === 'direct' ? direct : proxyAgent(proxy) });
    };
    const alternate = route === 'direct' ? 'proxy' : 'direct';
    let first, failure;
    try { first = await send(route, listing?.signal); } catch (error) { failure = error; }
    finally { if (timer) clearTimeout(timer); }
    signal?.throwIfAborted();
    const gatewayFailure = first && [502, 503, 504].includes(first.status);
    if (first && !refused.has(first.status) && !gatewayFailure) {
      if (successfulModelResponse(first)) memory.remember(key, route);
      return first;
    }
    if (failure && !listing?.signal.aborted && !networkFailure(failure)) throw failure;
    // A server may already be generating/billing. Never submit another POST on an
    // ambiguous disconnect, consume a one-shot upload twice, or race two generations.
    if (!replayable || (method === 'POST' && (gatewayFailure || networkFailure(failure) === 'ambiguous'))) {
      if (nextAttempts.size >= 256) nextAttempts.delete(nextAttempts.keys().next().value);
      nextAttempts.set(key, { route: alternate, until: Date.now() + 60_000 });
      if (failure) throw failure;
      return first;
    }
    let second;
    try { second = await send(alternate); } catch (error) {
      signal?.throwIfAborted();
      if (first) return first;
      throw error;
    }
    if (first && !second.ok && refused.has(first.status)) {
      void second.body?.cancel().catch(() => {});
      return first;
    }
    void first?.body?.cancel().catch(() => {});
    if (successfulModelResponse(second)) memory.remember(key, alternate);
    return second;
  };
}
