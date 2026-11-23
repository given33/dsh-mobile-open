import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { openRouteMemory, routedModelFetch } from '../lib/model-routing.mjs';

const run = promisify(execFile);
const systemLookup = `
$ErrorActionPreference='Stop'
$target=[Uri]$env:DSH_MODEL_ROUTE_TARGET
$proxy=[Net.WebRequest]::GetSystemWebProxy()
if (!$proxy.IsBypassed($target)) { $proxy.GetProxy($target).AbsoluteUri }`;

function windowsProxyLookup() {
  // When the launcher selected an environment policy (including NO_PROXY), never
  // second-guess a bypass with an OS proxy. Windows-only proxy apps without an
  // environment policy are queried per destination, with a short-lived cache.
  if (process.platform !== 'win32' || !process.env.SystemRoot ||
      ['http_proxy','https_proxy','all_proxy','no_proxy'].some(name => process.env[name])) return;
  const exe = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cache = new Map();
  return url => {
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\./.test(url.hostname)) return;
    const target = url.origin + url.pathname;
    const prior = cache.get(target);
    if (prior?.until > Date.now()) return prior.value;
    const value = run(exe, ['-NoLogo','-NoProfile','-NonInteractive','-Command',systemLookup], {
      windowsHide: true, timeout: 2200, maxBuffer: 4096,
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, DSH_MODEL_ROUTE_TARGET: target },
    }).then(({ stdout }) => {
      const server = URL.parse(stdout.trim());
      return server && ['http:', 'https:'].includes(server.protocol) && server.origin !== url.origin ? server.href : undefined;
    }, () => undefined);
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(target, { value, until: Date.now() + 60_000 });
    return value;
  };
}

export async function installModelRouting(ctx, stateDir) {
  // Resolve the actual launcher's module instance: its live proxy policy is not
  // shared by an independently bundled copy. Never install a global dispatcher.
  let resolveHost;
  for (const entry of [process.argv[1], import.meta.url]) {
    try {
      const policyPath = createRequire(entry).resolve('@deepseek-ai/dsh-http-proxy');
      resolveHost = { policyPath, transportPath: createRequire(policyPath).resolve('undici') };
      break;
    } catch { /* Older hosts without a per-destination API keep stock networking. */ }
  }
  if (!resolveHost) return;
  const [policy, transport, memory] = await Promise.all([
    import(pathToFileURL(resolveHost.policyPath)), import(pathToFileURL(resolveHost.transportPath)), openRouteMemory(stateDir),
  ]);
  const { Agent, Pool, ProxyAgent } = transport.default;
  const direct = new Agent({ connectTimeout: 3000, allowH2: false });
  const proxies = new Map();
  const original = globalThis.fetch;
  const fetchModel = routedModelFetch({ original, memory, direct, systemProxy: windowsProxyLookup(),
    hostProxy: url => policy.proxyRouteFor(url).proxy,
    proxyAgent(uri) {
      if (!proxies.has(uri)) {
        const agent = new ProxyAgent({ uri, connectTimeout: 3000, allowH2: false,
          clientFactory: (origin, opts) => new Pool(origin, { ...opts, headersTimeout: 3000 }),
        });
        proxies.set(uri, agent);
      }
      return proxies.get(uri);
    },
  });
  let active = true;
  // SDKs can retain fetch across plugin reloads. Disposed wrappers pass through.
  const wrapper = (input, init) => active ? fetchModel(input, init) : original(input, init);
  ctx.effect(() => {
    globalThis.fetch = wrapper;
    return async () => {
      active = false;
      if (globalThis.fetch === wrapper) globalThis.fetch = original;
      await Promise.allSettled([direct.close(), ...Array.from(proxies.values(), p => p.close()), memory.flush()]);
    };
  });
}
