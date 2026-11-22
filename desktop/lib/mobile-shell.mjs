// Mobile-only ergonomic layer injected exclusively into the official DSH page
// served over the paired phone link. Never alters desktop Electron or DSH's
// native visual design tokens, typography, icons, or workflow components.

import { createHash } from 'node:crypto';
import { createChatSessionScrollMemory, createWebRemoteControlLifecycleRecovery, groupMobileTasks } from './zcode-webview.mjs';

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />';
let cachedShellHashes = null;
function shellHashes() {
  if (!cachedShellHashes) {
    cachedShellHashes = {
      css: createHash('sha256').update(MOBILE_SHELL_CSS).digest('base64url').slice(0, 10),
      js: createHash('sha256').update(MOBILE_SHELL_JS).digest('base64url').slice(0, 10),
    };
  }
  return cachedShellHashes;
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// The desktop PDF renderer runs in both realms; older iOS lacks ES upsert and
// Promise.withResolvers. Only fill missing methods, including in its dedicated worker.
function previewCompatibility() {
  for (const Type of [Map, WeakMap]) {
    const proto = Type.prototype, has = proto.has, get = proto.get, set = proto.set;
    for (const [name, computed] of [['getOrInsert', false], ['getOrInsertComputed', true]]) {
      if (proto[name]) continue;
      Object.defineProperty(proto, name, { configurable: true, writable: true, value(key, value) {
        if (computed && typeof value !== 'function') throw new TypeError('Expected a callback');
        if (has.call(this, key)) return get.call(this, key);
        const next = computed ? value(key === 0 ? 0 : key) : value;
        set.call(this, key, next); return next;
      } });
    }
  }
  if (!Promise.withResolvers) Object.defineProperty(Promise, 'withResolvers', {
    configurable: true, writable: true, value() {
      let resolve, reject;
      const promise = new this((a, b) => { resolve = a; reject = b; });
      return { promise, resolve, reject };
    },
  });
}
export const PREVIEW_COMPAT_JS = `(() => {
  const compat = ${previewCompatibility.toString()};
  const needed = !Map.prototype.getOrInsertComputed || !WeakMap.prototype.getOrInsertComputed || !Promise.withResolvers;
  compat();
  if (!needed || typeof Worker !== 'function') return;
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      if (options?.name !== 'dsh-pdf' || options.type !== 'module' || !String(url).startsWith('blob:' + location.origin + '/')) {
        super(url, options); return;
      }
      const boot = '(' + compat.toString() + ')(); await import(' + JSON.stringify(String(url)) + ');';
      const local = URL.createObjectURL(new Blob([boot], {type:'text/javascript'}));
      try { super(local, options); } finally { URL.revokeObjectURL(local); }
    }
  };
})();`;

// Synchronous pre-boot script injected at the start of <head> BEFORE any
// <script type="module"> runs. Intercepts CSS Anchor Positioning properties
// (el.style.anchorName, el.style.positionAnchor, and CSS custom properties
// --dsh-model-anchor / --dsh-submenu-parent) so iOS WKWebView never drops them
// and every portaled DSH popup can be placed accurately relative to its trigger.
export const MOBILE_ANCHOR_PREBOOT_JS = `(() => {
  'use strict';
  if (globalThis.__DSH_MOBILE_ANCHORS__) return;
  const styleToEl = new WeakMap();
  const anchors = new Map();
  const varAnchors = new Map();
  const popups = new Map();
  const elAnchorName = new WeakMap();
  const elModelVar = new WeakMap();

  const api = {
    anchors,
    varAnchors,
    popups,
    onPopupChange: null,
  };
  globalThis.__DSH_MOBILE_ANCHORS__ = api;

  function addSet(map, key, el) {
    if (!key) return;
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(el);
  }

  function removeSet(map, key, el) {
    if (!key) return;
    const set = map.get(key);
    if (!set) return;
    set.delete(el);
    if (set.size === 0) map.delete(key);
  }

  function recordAnchorName(el, raw) {
    const val = raw == null ? '' : String(raw).trim();
    const prev = elAnchorName.get(el);
    if (prev && prev !== val) removeSet(anchors, prev, el);
    if (val && val !== 'none') {
      elAnchorName.set(el, val);
      addSet(anchors, val, el);
      if (el.getAttribute('data-dsh-anchor-name') !== val) {
        el.setAttribute('data-dsh-anchor-name', val);
      }
    } else {
      elAnchorName.delete(el);
      if (el.hasAttribute('data-dsh-anchor-name')) {
        el.removeAttribute('data-dsh-anchor-name');
      }
    }
  }

  function recordPopupAnchor(el, kind, raw) {
    const val = raw == null ? '' : String(raw).trim();
    const attr = kind === 'submenu' ? 'data-dsh-submenu-parent' : 'data-dsh-position-anchor';
    if (val && val !== 'auto' && val !== 'none') {
      popups.set(el, { anchor: val, kind });
      if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
      if (typeof api.onPopupChange === 'function') api.onPopupChange(el);
    } else {
      const existing = popups.get(el);
      if (existing && existing.kind === kind) popups.delete(el);
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
  }

  function recordModelAnchorVar(el, raw) {
    const val = raw == null ? '' : String(raw).trim();
    const prev = elModelVar.get(el);
    if (prev && prev !== val) removeSet(varAnchors, prev, el);
    if (val && val !== 'none') {
      elModelVar.set(el, val);
      addSet(varAnchors, val, el);
      if (el.getAttribute('data-dsh-model-anchor') !== val) {
        el.setAttribute('data-dsh-model-anchor', val);
      }
      if (typeof api.onPopupChange === 'function') api.onPopupChange(el);
    } else {
      elModelVar.delete(el);
      if (el.hasAttribute('data-dsh-model-anchor')) {
        el.removeAttribute('data-dsh-model-anchor');
      }
    }
  }

  const wrappedProtos = new Set();
  function wrapStyleGetter(startProto) {
    let proto = startProto;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'style')) {
      proto = Object.getPrototypeOf(proto);
    }
    if (!proto || wrappedProtos.has(proto)) return;
    const desc = Object.getOwnPropertyDescriptor(proto, 'style');
    if (!desc || typeof desc.get !== 'function' || desc.configurable === false) return;
    wrappedProtos.add(proto);
    Object.defineProperty(proto, 'style', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const decl = desc.get.call(this);
        if (decl && this instanceof Element) styleToEl.set(decl, this);
        return decl;
      },
      set: desc.set,
    });
  }

  try {
    if (typeof HTMLElement !== 'undefined') wrapStyleGetter(HTMLElement.prototype);
    if (typeof SVGElement !== 'undefined') wrapStyleGetter(SVGElement.prototype);
    if (typeof CSSStyleDeclaration !== 'undefined') {
      const cProto = CSSStyleDeclaration.prototype;
      const nativeAnchorDesc = Object.getOwnPropertyDescriptor(cProto, 'anchorName');
      Object.defineProperty(cProto, 'anchorName', {
        configurable: true,
        enumerable: true,
        get() {
          const el = styleToEl.get(this);
          if (el) return elAnchorName.get(el) || el.getAttribute('data-dsh-anchor-name') || '';
          return nativeAnchorDesc?.get ? nativeAnchorDesc.get.call(this) : '';
        },
        set(v) {
          const el = styleToEl.get(this);
          if (el) recordAnchorName(el, v);
        },
      });

      const nativePosDesc = Object.getOwnPropertyDescriptor(cProto, 'positionAnchor');
      Object.defineProperty(cProto, 'positionAnchor', {
        configurable: true,
        enumerable: true,
        get() {
          const el = styleToEl.get(this);
          if (el) return popups.get(el)?.anchor || el.getAttribute('data-dsh-position-anchor') || '';
          return nativePosDesc?.get ? nativePosDesc.get.call(this) : '';
        },
        set(v) {
          const el = styleToEl.get(this);
          if (el) recordPopupAnchor(el, 'positionAnchor', v);
        },
      });

      const origSetProp = cProto.setProperty;
      if (typeof origSetProp === 'function') {
        cProto.setProperty = function(name, value, priority) {
          const el = styleToEl.get(this);
          if (el) {
            if (name === 'anchor-name') {
              recordAnchorName(el, value);
              return;
            }
            if (name === 'position-anchor') {
              recordPopupAnchor(el, 'positionAnchor', value);
              return;
            }
            if (name === '--dsh-model-anchor') {
              recordModelAnchorVar(el, value);
            } else if (name === '--dsh-submenu-parent') {
              recordPopupAnchor(el, 'submenu', value);
            }
          }
          return origSetProp.call(this, name, value, priority);
        };
      }

      const origRemoveProp = cProto.removeProperty;
      if (typeof origRemoveProp === 'function') {
        cProto.removeProperty = function(name) {
          const el = styleToEl.get(this);
          if (el) {
            if (name === 'anchor-name') recordAnchorName(el, '');
            else if (name === 'position-anchor') recordPopupAnchor(el, 'positionAnchor', '');
            else if (name === '--dsh-model-anchor') recordModelAnchorVar(el, '');
            else if (name === '--dsh-submenu-parent') recordPopupAnchor(el, 'submenu', '');
          }
          return origRemoveProp.call(this, name);
        };
      }
    }
  } catch {}
})();`;

// Serialized into preboot for hosts without a Cordis route owner. Time alone
// cannot confirm a painted conversation during cellular recovery.
function hasLegacyRoutePaint(wanted, reveal) {
  if (document.hidden) return false;
  const view = [...document.querySelectorAll('[data-conversation-content]')].find(el => el.getClientRects().length);
  const id = view?.dataset.conversationSession;
  const phase = view?.dataset.contentPhase || view?.closest('[data-phase]')?.dataset.phase;
  if (!id || (wanted && id !== wanted) || phase === 'settling' || !view.querySelector('[data-composer-card]')) return false;
  const blank = phase === 'hero';
  if (blank && wanted && globalThis.__DSH_MOBILE_CORDIS__?.isCurrentSessionBlank?.() !== true) return false;
  if (!blank && !view.querySelector('[data-chat-turn], [data-message-bubble], [data-chat-flow] > *')) return false;
  const done = () => globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'launch-applied', sessionId: id, isBlank: blank });
  if (typeof globalThis.__DSH_MOBILE_BRIDGE__?.onLaunchHydrated === 'function') globalThis.__DSH_MOBILE_BRIDGE__.onLaunchHydrated(done);
  else { reveal(); done(); }
  return true;
}

export function injectMobileShell(html, meta = {}) {
  const payload = {
    active: true,
    version: typeof meta.version === 'string' ? meta.version : '',
    desktopName: typeof meta.desktopName === 'string' ? meta.desktopName : '',
    readOnly: meta.readOnly === true,
    terminal: meta.terminal === true,
  };
  let out = html;
  // Normalize viewport for iOS WKWebView safe areas, keyboard resizing, and no input zoom.
  if (/<meta\s+[^>]*name=["']viewport["'][^>]*>/i.test(out)) {
    out = out.replace(/<meta\s+[^>]*name=["']viewport["'][^>]*>/i, VIEWPORT_META);
  } else {
    out = out.replace(/<head(?:\s[^>]*)?>/i, open => open + VIEWPORT_META);
  }
  // Ensure root-relative <base href="/"> so /assets, /plugins and /api resolve cleanly.
  if (/<base\s+[^>]*>/i.test(out)) {
    out = out.replace(/<base\s+[^>]*>/i, '<base href="/">');
  } else {
    out = out.replace(/<head(?:\s[^>]*)?>/i, open => open + '<base href="/">');
  }
  // Inject synchronous pre-boot script right inside <head> before any module script runs.
  // Paints saved theme/AMOLED background at byte 0 and mounts a zero-collision visual snapshot
  // curtain from localStorage so background reload never flashes white or the gray DSH logo.
  const hashes = shellHashes();
  const preloadTags = `<link rel="preload" as="style" href="/mobile/v1/shell.css?v=${hashes.css}"><link rel="preload" as="script" href="/mobile/v1/shell.js?v=${hashes.js}">`;
  const prebootStyle = `<style id="dml-preboot-style">html[data-dml-routing]{color-scheme:light dark;background:#fff}html[data-dml-routing] #root{visibility:hidden!important}@media(prefers-color-scheme:dark){html[data-dml-routing]{background:#151517}}html[data-dml-routing="dark"]{color-scheme:dark;background:#151517}html[data-dml-routing="light"]{color-scheme:light;background:#fff}html[data-dml-amoled="true"][data-dml-routing="dark"]{background:#000}#dml-snap-curtain{position:fixed;inset:0;z-index:2147483000;overflow:hidden;pointer-events:none;contain:strict}#dml-snap-curtain [data-dml-snap-scroll]{margin-right:0!important;scrollbar-gutter:auto!important}</style>`;
  const prebootJs = `(()=>{const d=document.documentElement;if(!d)return;let t='auto',bg='',amoled=false;try{t=localStorage.getItem('dml.surface')||'auto';bg=localStorage.getItem('dml.bg')||'';amoled=localStorage.getItem('dml.pref.amoled')==='true'}catch{}if(amoled)d.setAttribute('data-dml-amoled','true');const r=globalThis.__DSH_MOBILE_LAUNCH__;if(r?.surface&&r.surface!=='auto')t=r.surface;if(r?.bg)bg=r.bg;if(amoled&&t==='dark')bg='#000000';if(bg)d.style.backgroundColor=bg;const clearSnap=()=>{try{document.getElementById('dml-snap-curtain')?.remove?.()}catch{}d.removeAttribute('data-dml-snap-cover');d.removeAttribute('data-dml-routing');if(d.style)d.style.backgroundColor='';if(globalThis.__DSH_MOBILE_ROUTE_STATE__)globalThis.__DSH_MOBILE_ROUTE_STATE__.intent=false};globalThis.__DSH_MOBILE_CLEAR_SNAP__=clearSnap;if(r||globalThis.webkit?.messageHandlers?.dshMobile){d.setAttribute('data-dml-routing',t);let wanted=r?.resume||'',snap=null;try{wanted||=localStorage.getItem('dml.lastSession')||'';const raw=localStorage.getItem('dml.visualSnap.v1');if(raw){const p=JSON.parse(raw);if(p&&p.v===2&&typeof p.html==='string'&&p.html.length>40&&Date.now()-Number(p.ts||0)<86400e3&&(!wanted||wanted===p.sessionId))snap=p}}catch{}if(snap){if(snap.htmlTheme&&!d.getAttribute('data-theme'))d.setAttribute('data-theme',snap.htmlTheme);if(snap.htmlScheme&&!d.getAttribute('data-color-scheme'))d.setAttribute('data-color-scheme',snap.htmlScheme);if(snap.htmlClass&&!d.className)d.className=snap.htmlClass;if(amoled&&snap.dark)d.style.backgroundColor='#000000';else if(snap.bg)d.style.backgroundColor=snap.bg;d.setAttribute('data-dml-snap-cover','true');const mountSnap=()=>{if(!document.body||!d.hasAttribute('data-dml-snap-cover')||document.getElementById('dml-snap-curtain'))return false;const el=document.createElement('div');el.id='dml-snap-curtain';el.setAttribute('aria-hidden','true');el.setAttribute('inert','');el.style.background=(amoled&&snap.dark)?'#000000':(snap.bg||bg||(t==='dark'?'#151517':'#ffffff'));if(snap.fg)el.style.color=snap.fg;el.innerHTML=snap.html;document.body.appendChild(el);const restoreScroll=()=>{if(!el.isConnected)return;for(const sc of el.querySelectorAll('[data-dml-snap-y],[data-dml-snap-x]')){void sc.scrollHeight;if(sc.hasAttribute('data-dml-snap-y'))sc.scrollTop=Number(sc.getAttribute('data-dml-snap-y'));if(sc.hasAttribute('data-dml-snap-x'))sc.scrollLeft=Number(sc.getAttribute('data-dml-snap-x'))}};restoreScroll();if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{restoreScroll();requestAnimationFrame(restoreScroll)});return true};if(!mountSnap()&&typeof MutationObserver==='function'){const o=new MutationObserver(()=>{if(mountSnap()||!d.hasAttribute('data-dml-snap-cover'))o.disconnect()});o.observe(document,{childList:true,subtree:true});if(typeof setTimeout==='function')setTimeout(()=>o.disconnect(),3000)}}if(typeof setTimeout==='function'){setTimeout(function checkLegacy(){if(!d.hasAttribute('data-dml-routing')||globalThis.__DSH_MOBILE_ROUTE_STATE__)return;if(!(${hasLegacyRoutePaint.toString()})(wanted,clearSnap))setTimeout(checkLegacy,2000)},8500)}}})();`;
  const prebootTag = `${prebootStyle}${preloadTags}<script>globalThis.__DSH_MOBILE_SHELL__=${safeJson(payload)};${prebootJs}${PREVIEW_COMPAT_JS}${MOBILE_ANCHOR_PREBOOT_JS}</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(out)) {
    out = out.replace(/<head(?:\s[^>]*)?>/i, open => open + prebootTag);
  } else {
    out = prebootTag + out;
  }
  // Place content-hashed stylesheet and deferred runtime at the end of <head> so
  // shell.css wins cascade and WKWebView serves both from immutable disk cache (0ms).
  const tailTag = `<link rel="stylesheet" href="/mobile/v1/shell.css?v=${hashes.css}">`
    + `<script defer src="/mobile/v1/shell.js?v=${hashes.js}"></script>`;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, () => tailTag + '</head>');
  } else {
    out += tailTag;
  }
  return out;
}

export const MOBILE_SHELL_CSS = `/* DSH Mobile shell: preserves 100% native DSH styling while polishing iOS layout, popups, and 120Hz smoothness. */
:root, html, body {
  /* Replace expensive 40px Gaussian backdrop blurs on iOS WKWebView with opaque elevated surfaces for 120Hz smoothness. */
  --dsw-mask-blur: none !important;
  --dsw-menu-backdrop-filter: none !important;
  --dsw-menu-surface-fill: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #28292e) 97%, transparent) !important;
  --dsw-specific-menu: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #28292e) 97%, transparent) !important;
}

html, body, #root {
  height: 100%;
  max-width: 100vw;
  margin: 0;
  padding: 0 !important;
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}

#root { height: var(--dsh-mobile-vh, 100%); }

body {
  padding-left: env(safe-area-inset-left, 0px) !important;
  padding-right: env(safe-area-inset-right, 0px) !important;
}

/* Remove extra scrollbar gutter margin on mobile overlay scrollbars, keep opaque backing, and enable momentum touch scrolling. */
[data-conversation-content],
[data-conversation-scroll] {
  background: var(--dsw-alias-bg-base, inherit);
}
[data-conversation-scroll] {
  margin-right: 0 !important;
  scrollbar-gutter: auto !important;
  -webkit-overflow-scrolling: touch;
}
/* Skip offscreen turn rasterization during keyboard animations & 120Hz scrolling; keep active last turn eager. */
[data-conversation-scroll] [data-chat-turn]:not(:last-child) {
  content-visibility: auto;
  contain-intrinsic-size: auto 96px;
}
[data-composer-card] {
  contain: layout style;
  position: relative;
}
[data-conversation-scroll] pre,
[data-conversation-scroll] [data-code-block],
[data-conversation-scroll] table {
  overscroll-behavior-x: contain;
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
}
[data-conversation-scroll] img {
  max-width: 100%;
  height: auto;
}

/* Keep new-session hero vertically centered like official desktop DSH;
   active conversations keep the composer docked cleanly at the bottom. */
[data-content-phase="hero"] [data-conversation-scroll],
[data-phase="hero"] [data-conversation-scroll] {
  justify-content: center !important;
}
[data-content-phase="hero"] [data-composer-seat],
[data-phase="hero"] [data-composer-seat] {
  flex: 0 0 auto !important;
  padding-bottom: 4vh !important;
}
/* Harmonious constant vertical rhythm across input card, bottom stats dock, and iOS Home Indicator in active chat.
   Never mutate padding-bottom on keyboard toggle so keyboard open/close triggers zero flex-column reflow. */
[data-composer-seat] [data-slot="conversation.composer.bar"] > div,
[data-composer-seat] div:has(> [data-composer-card]) {
  padding-bottom: 0 !important;
}
[data-composer-seat] {
  background: var(--dsw-alias-bg-base, inherit);
  padding-bottom: clamp(10px, calc(env(safe-area-inset-bottom, 0px) * 0.42), 14px) !important;
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
/* Native 120Hz GPU-composited keyboard animation (zero #root height reflow, zero layout transition lag). */
html[data-dml-native-kb="true"] [data-composer-seat] {
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px)), 0);
  transition: transform var(--dml-kb-dur, 250ms) cubic-bezier(0.32, 0.72, 0, 1);
}
html[data-dml-native-kb="true"] [data-content-phase="hero"] [data-composer-seat],
html[data-dml-native-kb="true"] [data-phase="hero"] [data-composer-seat] {
  transform: translate3d(0, calc(-1 * var(--dml-kb-hero, calc(var(--dml-kb, 0px) * 0.45))), 0);
}
html[data-dml-native-kb="true"] [data-content-phase="active"] [data-conversation-scroll] > :first-child:not([data-composer-seat]) {
  padding-bottom: var(--dml-kb-pad, 0px);
}
html[data-dml-native-kb="true"] [data-sidebar-drawer] > [data-sidebar-mask] + div,
html[data-dml-native-kb="true"] [data-shortcut-modal] {
  padding-bottom: calc(10px + var(--dml-kb, 0px)) !important;
}
@media (max-width: 600px) {
  [data-conversation-content] { --dsh-composer-side-clearance: 10px !important; }
}
/* Official desktop DSH centered single-row statistics dock with uniform spacing (never two rows, never lopsided gaps). */
#root [data-composer-dock] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%);
  min-width: 0;
  min-height: 24px;
  margin-top: 7px;
  padding: 0 2px;
  column-gap: 12px;
  row-gap: 0;
}
#root [data-composer-dock]:empty,
#root [data-composer-dock]:not(:has(button, [data-composer-stat])) {
  display: none !important;
  margin-top: 0 !important;
  min-height: 0 !important;
  padding: 0 !important;
}
#root [data-composer-dock] > * {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}
#root [data-composer-dock] > :is([data-dsh-anchor-name^="--dsh-context-"], [style*="--dsh-context-"]) {
  flex: 0 0 auto;
}
#root [data-composer-dock] :is([data-composer-stat] button, [data-composer-stat] > span, [data-dsh-anchor-name^="--dsh-context-"] button, [style*="--dsh-context-"] button) {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  min-height: 24px;
  padding: 2px 5px;
  gap: 4px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
#root [data-composer-dock] [data-composer-stat] svg + span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
#root [data-composer-dock] [data-composer-stat] svg + span > [aria-hidden] {
  margin-inline: 4px;
}
/* Progressive uniform tightening only when long readings would overflow the single row. */
#root [data-composer-dock][data-dml-stats-fit="tight"] {
  column-gap: 8px;
}
#root [data-composer-dock][data-dml-stats-fit="tight"] :is([data-composer-stat] button, [data-composer-stat] > span, [data-dsh-anchor-name^="--dsh-context-"] button, [style*="--dsh-context-"] button) {
  padding: 2px 3px;
  gap: 3px;
  font-size: 11.5px;
}
#root [data-composer-dock][data-dml-stats-fit="tight"] [data-composer-stat] svg + span > [aria-hidden] {
  margin-inline: 3px;
}
#root [data-composer-dock][data-dml-stats-fit="text"],
#root [data-composer-dock][data-dml-stats-fit="short"] {
  column-gap: 6px;
}
#root [data-composer-dock][data-dml-stats-fit="text"] :is([data-composer-stat] button, [data-composer-stat] > span, [data-dsh-anchor-name^="--dsh-context-"] button, [style*="--dsh-context-"] button),
#root [data-composer-dock][data-dml-stats-fit="short"] :is([data-composer-stat] button, [data-composer-stat] > span, [data-dsh-anchor-name^="--dsh-context-"] button, [style*="--dsh-context-"] button) {
  padding: 2px 2px;
  gap: 3px;
  font-size: 11.5px;
}
#root [data-composer-dock][data-dml-stats-fit="text"] [data-composer-stat] :is(button, span) > svg,
#root [data-composer-dock][data-dml-stats-fit="short"] [data-composer-stat] :is(button, span) > svg {
  display: none;
}
#root [data-composer-dock][data-dml-stats-fit="short"] [data-dml-short-reading] > svg + span {
  display: none;
}
#root [data-composer-dock][data-dml-stats-fit="short"] [data-dml-short-reading]::after {
  content: attr(data-dml-short-reading);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 3. Ensure the slash-command (/) and @-mention overlay menu always has generous height above the bottom composer. */
[data-trigger-menu] {
  -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
  max-height: var(--dsh-overlay-avail-h, min(360px, calc(var(--dsh-mobile-vh, 100dvh) - 140px))) !important;
}

[data-trigger-menu] [data-dml-cancel] { min-height:44px; flex-shrink:0; padding:8px 12px; text-align:start; color:var(--dsw-alias-label-primary,inherit); background:none; border:0; }
[data-trigger-menu] [role=listbox] { overscroll-behavior:contain; touch-action:pan-y; }
body:has([data-trigger-menu]) { -webkit-user-select:none; user-select:none; }
[data-composer-card] button[aria-haspopup=listbox]:has(~ input[type=file]) { min-width:40px; min-height:40px; touch-action:manipulation; }
/* 4. Neutralize broken WebKit CSS Anchor Positioning insets on portaled popups so our JS anchor engine controls top/left/max-height cleanly. */
body > [data-dsh-position-anchor],
body > [data-dsh-model-anchor],
body > [data-dsh-submenu-parent],
[data-dsh-positioned="true"] {
  position-anchor: auto !important;
  position-area: none !important;
  position-try-fallbacks: none !important;
  align-self: auto !important;
  justify-self: auto !important;
  margin: 0 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* 5. 120Hz GPU-accelerated sidebar drawer & mask transitions without backdrop-filter frame drops. */
[data-sidebar-mask] {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  background: rgba(0, 0, 0, 0.44) !important;
  will-change: opacity;
  transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1) !important;
}

[data-sidebar-drawer] > [data-sidebar-mask] + div {
  will-change: transform;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  -webkit-overflow-scrolling: touch;
  contain: layout style;
  padding-bottom: 10px !important;
  box-sizing: border-box !important;
  transition-duration: 220ms !important;
  transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1) !important;
}

/* Only native clients already have a navigation button above the web content. */
html[data-dml-native-nav] [data-sidebar-opener] { display:none !important; }
html[data-dml-native-nav] [data-slot="shell.leading"]:has([data-sidebar-opener]):not(:has(button:not([data-sidebar-opener]))) { display:none !important; }
.dml-reader {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: clamp(14px, 3.6vw, 28px);
  user-select: text;
  -webkit-user-select: text;
  font-size: 15px;
  line-height: 1.68;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
}
.dml-reader-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dml-reader-note {
  display: block;
  margin-bottom: 12px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--dsw-alias-label-tertiary, #8e8e93);
}
.dml-reader-trunc { margin-top: 14px; margin-bottom: 0; }
.dml-reader p, .dml-reader h2, .dml-reader h3, .dml-reader h4 {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.dml-reader p { margin: 0.58em 0; }
.dml-reader h2 { font-size: 1.24em; font-weight: 650; line-height: 1.4; margin: 1.05em 0 0.45em; }
.dml-reader h3 { font-size: 1.1em; font-weight: 620; line-height: 1.42; margin: 0.95em 0 0.4em; }
.dml-reader h4 { font-size: 1.02em; font-weight: 600; line-height: 1.45; margin: 0.8em 0 0.35em; }
.dml-reader [data-kind="li"] {
  position: relative;
  padding-left: 1.15em;
  margin: 0.42em 0;
}
.dml-reader [data-kind="li"]::before {
  content: "•";
  position: absolute;
  left: 0.25em;
  color: var(--dsw-alias-label-tertiary, #8e8e93);
}
.dml-reader-slide {
  display: inline-block;
  margin: 1.15em 0 0.45em;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.14));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
}
.dml-reader-table-wrap {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 0.85em 0;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
}
.dml-reader-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  line-height: 1.5;
}
.dml-reader-table th, .dml-reader-table td {
  padding: 7px 10px;
  text-align: start;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-width: 260px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.16));
}
.dml-reader-table th:last-child, .dml-reader-table td:last-child { border-right: 0; }
.dml-reader-table tbody tr:last-child td { border-bottom: 0; }
.dml-reader-table th {
  font-weight: 600;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12));
}
.dml-reader-more { margin-top: 14px; text-align: center; }
.dml-reader-btn {
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  cursor: pointer;
}
.dml-reader [data-kind=row] { border-bottom:1px solid #8885; padding-block:.3em; }
/* Hide desktop-only pairing chrome inside the mobile client itself. */
[data-dsh-mobile-hide],
.dml-footer-button {
  display: none !important;
}

@media (hover: none) and (pointer: coarse) {
  button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"] {
    touch-action: manipulation;
  }

  /* Hide desktop hover tooltips on touch screens so they never stick or float after taps. */
  [role="tooltip"] {
    display: none !important;
  }

  /* Prevent iOS WKWebView auto-zoom when focusing inputs with small font sizes. */
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  textarea,
  select,
  [contenteditable="true"] {
    font-size: max(16px, 1em);
  }

}

/* Subtle native-style toast for mobile shell notices (e.g. read-only mode), lifted above keyboard on GPU. */
.dsh-mobile-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translate3d(-50%, calc(-1 * var(--dml-kb, 0px) + 12px), 0);
  z-index: 9999;
  max-width: min(340px, calc(100vw - 32px));
  padding: 9px 14px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-toast, #353638);
  color: #fff;
  font-family: var(--dsw-font-family, system-ui);
  font-size: 13px;
  line-height: 18px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  transition: opacity 0.18s ease, transform var(--dml-kb-dur, 250ms) cubic-bezier(0.32, 0.72, 0, 1);
}
.dsh-mobile-toast[data-visible="true"] {
  opacity: 1;
  transform: translate3d(-50%, calc(-1 * var(--dml-kb, 0px)), 0);
}

/* Floating scroll-to-bottom button for long mobile conversations, GPU-tracked above composer & keyboard (no blur/layout animation). */
.dsh-scroll-bottom {
  position: fixed;
  right: 16px;
  bottom: calc(var(--dml-seat-h, 112px) + 12px);
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.28));
  background: var(--dsw-specific-card, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2329);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  z-index: 40;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px) + 8px), 0) scale(0.92);
  transition: opacity 180ms ease, transform var(--dml-kb-dur, 220ms) cubic-bezier(0.32, 0.72, 0, 1);
}
@media (prefers-color-scheme: dark) {
  .dsh-scroll-bottom {
    background: var(--dsw-specific-card, #28292e);
    color: var(--dsw-alias-label-primary, #f2f2f7);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.42);
  }
}
.dsh-scroll-bottom[data-visible="true"] {
  opacity: 1;
  pointer-events: auto;
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px)), 0) scale(1);
}
.dsh-scroll-bottom:active {
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px)), 0) scale(0.92);
}
[data-content-phase="hero"] .dsh-scroll-bottom,
[data-phase="hero"] .dsh-scroll-bottom,
[data-content-phase="hero"] .dsh-scroll-top,
[data-phase="hero"] .dsh-scroll-top {
  opacity: 0 !important;
  pointer-events: none !important;
}

.dsh-scroll-bottom[data-running="true"]::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 999px;
  border: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  opacity: 0.55;
  animation: dml-pulse 1.5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}
@keyframes dml-pulse {
  0% { transform: scale(0.92); opacity: 0.7; }
  100% { transform: scale(1.24); opacity: 0; }
}

.dsh-scroll-top {
  position: fixed;
  right: 16px;
  bottom: calc(var(--dml-seat-h, 112px) + 56px);
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.28));
  background: var(--dsw-specific-card, #ffffff);
  color: var(--dsw-alias-label-secondary, #4e5359);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  z-index: 40;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px) + 8px), 0) scale(0.92);
  transition: opacity 180ms ease, transform var(--dml-kb-dur, 220ms) cubic-bezier(0.32, 0.72, 0, 1);
}
@media (prefers-color-scheme: dark) {
  .dsh-scroll-top {
    background: var(--dsw-specific-card, #28292e);
    color: var(--dsw-alias-label-primary, #e5e5ea);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.42);
  }
}
.dsh-scroll-top[data-visible="true"] {
  opacity: 1;
  pointer-events: auto;
  transform: translate3d(0, calc(-1 * var(--dml-kb, 0px)), 0) scale(1);
}
.dsh-scroll-top:active { transform: translate3d(0, calc(-1 * var(--dml-kb, 0px)), 0) scale(0.92); }

/* Streaming reading position pill ("新内容 ↓") adapted from zcode-remote, zero React DOM mutation. */
.dml-readline {
  position: fixed;
  left: 50%;
  bottom: calc(var(--dml-seat-h, 112px) + 14px);
  z-index: 39;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 45%, transparent);
  background: var(--dsw-specific-card, #28292e);
  color: var(--dsw-alias-state-business-primary, #60a5fa);
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  transform: translate3d(-50%, calc(-1 * var(--dml-kb, 0px) + 8px), 0);
  transition: opacity 180ms ease, transform var(--dml-kb-dur, 220ms) cubic-bezier(0.32, 0.72, 0, 1);
}
.dml-readline[data-visible="true"] {
  opacity: 1;
  pointer-events: auto;
  transform: translate3d(-50%, calc(-1 * var(--dml-kb, 0px)), 0);
}

/* Expandable fullscreen composer toggle & expanded editor layout (adapted from zcode-remote). */
#dml-composer-expand {
  position: absolute;
  top: 7px;
  right: 8px;
  z-index: 6;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8e8e93);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  opacity: 0.72;
  touch-action: manipulation;
}
#dml-composer-expand:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 138, 0.16));
  opacity: 1;
}
[data-composer-card] :has(> [contenteditable="true"]) {
  padding-right: 30px !important;
  box-sizing: border-box;
}
[data-composer-card] [contenteditable="true"] {
  padding-right: 4px !important;
}
[data-composer-card] [contenteditable="true"] + div,
[data-composer-card] div:has(> [contenteditable="true"]) > div:not([contenteditable]) {
  padding-right: 30px !important;
  box-sizing: border-box;
}
html[data-dml-composer-full="true"] [data-composer-card] [contenteditable="true"] {
  min-height: min(34dvh, 260px) !important;
  max-height: min(50dvh, 420px) !important;
  overflow-y: auto !important;
  -webkit-overflow-scrolling: touch;
}
html[data-dml-composer-full="true"] #dml-composer-expand {
  color: var(--dsw-alias-state-business-primary, #4176e6);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent);
  opacity: 1;
}
html[data-dml-popup-open="true"] #dml-composer-expand {
  z-index: 1;
  pointer-events: none;
}

/* AMOLED Pure Black Mode (adapted from zcode-remote) for OLED power savings in dark theme. */
@media (prefers-color-scheme: dark) {
  html[data-dml-amoled="true"],
  html[data-dml-amoled="true"] :is(body, #root, [data-theme], [data-color-scheme], [data-conversation-content], [data-conversation-scroll], [data-composer-seat]) {
    --dsw-alias-bg-base: #000000 !important;
    --dsw-specific-sidebar-fill: #050507 !important;
    --dsw-alias-bg-layer-1: #0a0a0c !important;
    --dsw-alias-bg-layer-2: #121216 !important;
    --dsw-specific-card: #0e0e11 !important;
    --dsw-specific-menu: #121216 !important;
    --dsw-menu-surface-fill: #121216 !important;
  }
  html[data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]) {
    background-color: #000000 !important;
  }
}
html.dark[data-dml-amoled="true"],
html[data-theme="dark"][data-dml-amoled="true"],
html[data-color-scheme="dark"][data-dml-amoled="true"],
html[data-dml-amoled="true"] :is(body.dark, [data-theme="dark"], [data-color-scheme="dark"]),
html.dark[data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]),
html[data-theme="dark"][data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]),
html[data-color-scheme="dark"][data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]) {
  --dsw-alias-bg-base: #000000 !important;
  --dsw-specific-sidebar-fill: #050507 !important;
  --dsw-alias-bg-layer-1: #0a0a0c !important;
  --dsw-alias-bg-layer-2: #121216 !important;
  --dsw-specific-card: #0e0e11 !important;
  --dsw-specific-menu: #121216 !important;
  --dsw-menu-surface-fill: #121216 !important;
}
html.dark[data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]),
html[data-theme="dark"][data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]),
html[data-color-scheme="dark"][data-dml-amoled="true"] :is(body, #root, [data-conversation-content], [data-conversation-scroll], [data-composer-seat]) {
  background-color: #000000 !important;
}

/* Turn Navigator scroll-jump highlight pulse. */
.dml-turn-highlight {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 72%, transparent) !important;
  outline-offset: 4px;
  border-radius: 10px;
}
.dml-hub-turns {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dml-hub-turn-num {
  flex: none;
  min-width: 24px;
  height: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 16%, transparent);
  color: var(--dsw-alias-state-business-primary, #4176e6);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

/* Reading & display preferences applied from Mobile Hub Tools tab. */
html[data-dml-font-scale] [data-conversation-scroll] {
  font-size: calc(1em * var(--dml-font-scale, 1));
}
html[data-dml-code-wrap="true"] [data-conversation-scroll] pre,
html[data-dml-code-wrap="true"] [data-conversation-scroll] pre code {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

/* Pro Mobile Office Reader toolbar, progress bar, outline TOC & search highlights. */
.dml-reader-bar {
  position: sticky;
  top: calc(-1 * clamp(14px, 3.6vw, 28px));
  z-index: 5;
  margin: calc(-1 * clamp(14px, 3.6vw, 28px)) calc(-1 * clamp(14px, 3.6vw, 28px)) 10px;
  padding: 8px 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.94));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.18));
}
html.dark .dml-reader-bar,
html[data-theme="dark"] .dml-reader-bar,
html[data-color-scheme="dark"] .dml-reader-bar {
  background: var(--dsw-alias-bg-layer-1, rgba(28, 28, 32, 0.94));
}
.dml-reader-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
  transition: width 100ms linear;
}
.dml-reader-chip {
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.25));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.1));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}
.dml-reader-chip[data-active="true"] {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: #fff;
  border-color: transparent;
}
.dml-reader-chip:disabled { opacity: 0.4; }
.dml-reader-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
}
.dml-reader-search input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 138, 0.3));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 16px;
}
.dml-reader-count {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #8e8e93);
  font-variant-numeric: tabular-nums;
}
.dml-reader-toc {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
  padding: 6px;
  margin-bottom: 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.2));
}
.dml-reader-toc-item {
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 18px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.dml-reader-toc-item[data-level="h2"] { padding-left: 18px; opacity: 0.9; }
.dml-reader-toc-item[data-level="h3"] { padding-left: 28px; opacity: 0.8; font-size: 12px; }
.dml-mark {
  background: rgba(250, 204, 21, 0.38);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}
.dml-mark[data-active="true"] {
  background: rgba(245, 158, 11, 0.82);
  color: #111;
}

/* Fullscreen pinch-zoom Image Lightbox for mobile chat attachments & charts. */
.dsh-lightbox {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: rgba(10, 10, 14, 0.96);
  display: flex;
  flex-direction: column;
  opacity: 0;
  transition: opacity 180ms ease;
  touch-action: none;
}
.dsh-lightbox[data-open="true"] { opacity: 1; }
.dsh-lightbox-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: max(12px, env(safe-area-inset-top, 12px)) 14px 10px;
  z-index: 2;
}
.dsh-lightbox-btn {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}
.dsh-lightbox-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 12px;
}
.dsh-lightbox-stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  user-select: none;
  -webkit-user-select: none;
}

/* Mobile Quick Hub trigger, floating attention/draft pills, and bottom sheet. */
.dml-hub-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
.dml-hub-trigger:active { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 138, 0.14)); }
.dml-hub-trigger-floating {
  position: fixed;
  top: 10px;
  right: 52px;
  z-index: 35;
  pointer-events: auto;
}
.dml-hub-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-1, #fff);
}
.dml-hub-dot[data-kind="approval"] {
  background: #f59e0b;
  animation: dml-pulse 1.4s ease infinite;
}
.dml-floating-pills {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: 8px;
  z-index: 45;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: calc(100vw - 24px);
  pointer-events: none;
}
.dml-approval-pill,
.dml-draft-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.dml-approval-pill {
  background: rgba(245, 158, 11, 0.96);
  color: #111;
  cursor: pointer;
}
.dml-draft-pill {
  background: var(--dsw-specific-card, rgba(40, 41, 46, 0.94));
  color: #fff;
}
.dml-draft-restore, .dml-draft-close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.dml-draft-close { font-size: 15px; opacity: 0.78; padding-left: 4px; }

.dml-hub-backdrop {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
}
.dml-hub-backdrop[open] {
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.dml-hub-backdrop::backdrop {
  background: rgba(0, 0, 0, 0.42);
  animation: dml-hub-fade 150ms ease-out;
}
.dml-hub-sheet {
  width: min(560px, 100vw);
  max-height: 82dvh;
  display: flex;
  flex-direction: column;
  border-radius: 20px 20px 0 0;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #111);
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.22);
  overflow: hidden;
  padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
  animation: dml-hub-enter 200ms cubic-bezier(.22,.61,.36,1);
}
@keyframes dml-hub-fade { from { background-color: transparent; } }
@keyframes dml-hub-enter { from { transform: translateY(100%); } }
@media (prefers-reduced-motion: reduce) {
  .dml-hub-backdrop::backdrop, .dml-hub-sheet { animation: none; }
}
@media (prefers-color-scheme: dark) {
  .dml-hub-sheet {
    background: var(--dsw-alias-bg-layer-1, #1c1c20);
    color: var(--dsw-alias-label-primary, #f2f2f7);
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.52);
  }
}
.dml-hub-head {
  padding: 8px 14px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.18));
}
.dml-hub-handle {
  width: 36px;
  height: 4px;
  margin: 0 auto 10px;
  border-radius: 999px;
  background: rgba(128, 128, 138, 0.36);
}
.dml-hub-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dml-hub-tab {
  flex: 1 1 0;
  padding: 7px 6px;
  border-radius: 10px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8e8e93);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.dml-hub-tab[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 138, 0.16));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
}
.dml-hub-close {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: 0;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.14));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.dml-hub-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 12px 14px;
}
.dml-hub-section { display: flex; flex-direction: column; gap: 10px; }
.dml-hub-task-group { display: grid; gap: 6px; }
.dml-hub-task-heading {
  margin: 4px 0 0;
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #73747a);
}
.dml-hub-more { justify-self: start; min-height: 44px; }
.dml-hub-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dml-hub-pill-btn {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.24));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.1));
  color: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.dml-hub-primary-btn {
  padding: 8px 14px;
  border-radius: 10px;
  border: 0;
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.dml-hub-primary-btn:disabled { opacity: 0.45; }
.dml-hub-input, .dml-hub-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 11px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 138, 0.28));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.08));
  color: inherit;
  font-size: 16px;
}
.dml-hub-list { display: flex; flex-direction: column; gap: 6px; }
.dml-hub-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.16));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.07));
  color: inherit;
  cursor: pointer;
}
.dml-hub-item[data-current="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}
.dml-hub-item-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dml-hub-item-title { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dml-hub-item-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8e8e93); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dml-hub-tag { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8e8e93); }
.dml-hub-item-meta { display: flex; align-items: center; gap: 4px; flex-none: 0; }
.dml-hub-badge {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(128, 128, 138, 0.16);
}
.dml-hub-badge[data-kind="running"] { background: rgba(34, 197, 94, 0.18); color: #22c55e; }
.dml-hub-badge[data-kind="approval"] { background: rgba(245, 158, 11, 0.22); color: #f59e0b; }
.dml-hub-badge[data-kind="current"] { background: rgba(65, 118, 230, 0.18); color: #4176e6; }
.dml-hub-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dml-hub-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8e8e93); }
.dml-hub-empty { padding: 18px 8px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8e8e93); }
.dml-hub-snippet-row { display: flex; align-items: stretch; gap: 6px; }
.dml-hub-snippet-btn {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.16));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.07));
  color: inherit;
  cursor: pointer;
}
.dml-hub-del {
  flex: none;
  padding: 0 11px;
  border-radius: 10px;
  border: 0;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  font-size: 12px;
  cursor: pointer;
}
.dml-hub-card {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.16));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 138, 0.06));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dml-hub-card-title { font-size: 13px; font-weight: 600; }
.dml-hub-pref-row, .dml-hub-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.dml-hub-seg { display: flex; gap: 4px; }
.dml-hub-seg-btn {
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.24));
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dml-hub-seg-btn[data-active="true"] {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: #fff;
  border-color: transparent;
}
.dml-hub-stat-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 5px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dml-git-code {
  flex: none;
  width: 20px;
  text-align: center;
  font-family: var(--ds-font-family-code, monospace);
  font-size: 12px;
  font-weight: 700;
  color: #eab308;
}
.dml-git-code[data-code="A"], .dml-git-code[data-code="?"] { color: #22c55e; }
.dml-git-code[data-code="D"] { color: #ef4444; }
.dml-git-path { font-family: var(--ds-font-family-code, monospace); font-size: 12.5px; }
.dml-git-filename {
  margin-top: 8px;
  font-family: var(--ds-font-family-code, monospace);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #8e8e93);
  word-break: break-all;
}
.dml-git-diff {
  margin: 6px 0 0;
  padding: 10px;
  max-height: 46dvh;
  overflow: auto;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  border-radius: 10px;
  background: #141418;
  color: #e2e2e8;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 17px;
}
.dml-diff-line[data-kind="add"] { display: inline-block; min-width: 100%; background: rgba(34, 197, 94, 0.16); color: #86efac; }
.dml-diff-line[data-kind="del"] { display: inline-block; min-width: 100%; background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
.dml-diff-line[data-kind="hunk"] { display: inline-block; min-width: 100%; color: #93c5fd; }
@media (prefers-reduced-motion: reduce) {
  [data-composer-seat], [data-sidebar-mask], [data-sidebar-drawer] > [data-sidebar-mask] + div,
  .dsh-scroll-top, .dsh-scroll-bottom, .dsh-scroll-bottom::after, .dml-readline,
  .dml-turn-highlight, .dsh-lightbox, .dsh-lightbox img, .dsh-mobile-toast, .dml-hub-overlay {
    transition-duration: 0s !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
}
`;

export const MOBILE_SHELL_JS = `(() => {
  'use strict';
  if (globalThis.__DSH_MOBILE_SHELL_INSTALLED__) return;
  globalThis.__DSH_MOBILE_SHELL_INSTALLED__ = true;

  const shell = globalThis.__DSH_MOBILE_SHELL__ || {};
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const scrollBehavior = () => reducedMotion() ? 'auto' : 'smooth';
  if(globalThis.__DSH_MOBILE_LAUNCH__ || globalThis.webkit?.messageHandlers?.dshMobile) document.documentElement.setAttribute('data-dml-native-nav','');
  const anchorApi = globalThis.__DSH_MOBILE_ANCHORS__ || {
    anchors: new Map(),
    varAnchors: new Map(),
    popups: new Map(),
  };

  let followDesktop = false;
  let lastFollowedId = null;
  let lastThemeKey = '';
  let lastUiKey = '';
  let wsState = 'connecting';
  let desktopFocus = null;
  let toastTimer = null;
  let uiRaf = 0;
  let popupRaf = 0;
  let lastPointerTarget = null;
  let lastPointerCoords = { x: 180, y: 320 };

  const post = (payload) => {
    try {
      globalThis.webkit?.messageHandlers?.dshMobile?.postMessage(payload);
    } catch {}
  };

  function haptic(style = 'light') {
    post({ type: 'haptic', style });
  }

  function clearSnapCurtain() {
    if (typeof globalThis.__DSH_MOBILE_CLEAR_SNAP__ === 'function') {
      globalThis.__DSH_MOBILE_CLEAR_SNAP__();
      return;
    }
    try { document.getElementById('dml-snap-curtain')?.remove?.(); } catch {}
    const r = document.documentElement;
    if (!r) return;
    r.removeAttribute('data-dml-snap-cover');
    r.removeAttribute('data-dml-routing');
    if (r.style?.backgroundColor) r.style.backgroundColor = '';
    if (globalThis.__DSH_MOBILE_ROUTE_STATE__) globalThis.__DSH_MOBILE_ROUTE_STATE__.intent = false;
  }

  function revealRoot() {
    const r = document.documentElement;
    if (!r?.hasAttribute?.('data-dml-routing') && !r?.hasAttribute?.('data-dml-snap-cover')) return;
    clearSnapCurtain();
  }

  function onLaunchHydrated(done, options = {}) {
    const r = document.documentElement;
    const hasCurtain = !!(r?.hasAttribute?.('data-dml-snap-cover') || document.getElementById?.('dml-snap-curtain'));
    const settleScroll = () => {
      if (options.latest !== true) return;
      const scroller = document.querySelector('[data-conversation-scroll]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    };
    settleScroll();
    if (r?.hasAttribute?.('data-dml-routing')) {
      r.removeAttribute('data-dml-routing');
      if (r.style?.backgroundColor) r.style.backgroundColor = '';
    }
    const finish = () => {
      settleScroll();
      try { document.getElementById('dml-snap-curtain')?.remove?.(); } catch {}
      r?.removeAttribute?.('data-dml-snap-cover');
      if (typeof done === 'function') done();
      scheduleVisualSnapshot();
    };
    if (typeof requestAnimationFrame === 'function') {
      if (hasCurtain || options.latest === true) {
        // Let #root paint real pixels behind #dml-snap-curtain for 2 frames, then cut in 1 instant frame.
        requestAnimationFrame(() => { settleScroll(); requestAnimationFrame(finish); });
      } else {
        requestAnimationFrame(finish);
      }
    } else {
      finish();
    }
  }

  const SNAP_STRIP_SEL = 'script, iframe, video, audio, object, embed, canvas, noscript, style, #dml-composer-expand, .dml-readline';
  const SNAP_RENAME_ATTRS = [
    ['data-conversation-content', 'data-dml-snap-content'],
    ['data-conversation-session', 'data-dml-snap-session'],
    ['data-content-phase', 'data-dml-snap-phase'],
    ['data-phase', 'data-dml-snap-phase'],
    ['data-composer-card', 'data-dml-snap-card'],
    ['data-composer-seat', 'data-dml-snap-seat'],
    ['data-conversation-scroll', 'data-dml-snap-scroll'],
    ['data-sidebar-drawer', 'data-dml-snap-drawer'],
    ['data-sidebar-opener', 'data-dml-snap-opener'],
    ['data-trigger-menu', 'data-dml-snap-trigger-menu'],
    ['data-dml-hub-trigger', 'data-dml-snap-hub-trigger'],
  ];
  let snapTimer = 0;
  let lastInputAt = 0;
  let lastSnapshotAt = 0;
  let snapshotStatus = { state: 'empty' };

  // A resume curtain must not depend on a stylesheet that is still downloading.
  // Freeze only the visible tree; off-screen turns keep their measured space,
  // rather than deleting earlier turns and corrupting the saved scroll offset.
  const SNAP_STYLE_PROPS = ('display position inset z-index float clear box-sizing width height min-width min-height max-width max-height '
    + 'margin padding border border-radius outline background color opacity box-shadow overflow overflow-x overflow-y '
    + 'flex flex-direction flex-wrap align-items align-self align-content justify-content justify-items justify-self gap order '
    + 'grid-template-columns grid-template-rows grid-column grid-row '
    + 'font-family font-size font-weight font-style line-height letter-spacing word-spacing text-align text-indent '
    + 'text-decoration text-transform white-space word-break overflow-wrap vertical-align text-overflow '
    + 'transform transform-origin object-fit object-position aspect-ratio fill stroke stroke-width visibility '
    + 'list-style-type list-style-position -webkit-text-fill-color -webkit-line-clamp -webkit-box-orient').split(' ');
  function freezeSnapshotTree(source) {
    let count = 0;
    const styles = new Map();
    function copy(node) {
      if (node.nodeType === 3) return node.cloneNode(false);
      if (node.nodeType !== 1 || node.matches(SNAP_STRIP_SEL)) return null;
      if (++count > 800) throw new Error('Snapshot exceeds visible-node budget');
      const clone = node.cloneNode(false), cs = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      clone.removeAttribute('class');
      clone.removeAttribute('style');
      const rule = SNAP_STYLE_PROPS.map(prop => {
        const value = cs.getPropertyValue(prop);
        return value ? prop + ':' + value + '!important;' : '';
      }).join('');
      if (!styles.has(rule)) styles.set(rule, 'dml-s' + styles.size);
      clone.setAttribute('class', styles.get(rule));
      clone.setAttribute('data-dml-snap-frozen', '');
      // SVG geometry is expressed through presentation attributes (notably d).
      // CSS all: initial would erase it and leave empty icon buttons.
      if (node.namespaceURI === 'http://www.w3.org/2000/svg') clone.setAttribute('data-dml-snap-svg', '');
      if (cs.display === 'none') return clone;
      const outside = rect.width && rect.height && (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth);
      if (outside && node !== source) {
        clone.style.setProperty('height', rect.height + 'px', 'important');
        clone.style.setProperty('visibility', 'hidden', 'important');
        return clone;
      }
      if (node.scrollTop) clone.setAttribute('data-dml-snap-y', String(node.scrollTop));
      if (node.scrollLeft) clone.setAttribute('data-dml-snap-x', String(node.scrollLeft));
      if (node.localName === 'use') {
        const href = node.getAttribute('href') || node.getAttribute('xlink:href');
        const symbol = href?.startsWith('#') && document.getElementById(href.slice(1));
        if (symbol) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          for (const attr of symbol.attributes) {
            if (attr.name !== 'id' && attr.name !== 'class') svg.setAttribute(attr.name, attr.value);
          }
          svg.setAttribute('viewBox', symbol.getAttribute('viewBox') || '0 0 16 16');
          svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
          for (const child of symbol.childNodes) svg.appendChild(child.cloneNode(true));
          return svg;
        }
      }
      for (const child of node.childNodes) { const copied = copy(child); if (copied) clone.appendChild(copied); }
      return clone;
    }
    const root = copy(source);
    const reset = '#dml-snap-curtain [data-dml-snap-frozen]:not([data-dml-snap-svg]){all:initial;animation:none!important;transition:none!important;pointer-events:none!important}';
    const css = reset + [...styles].map(([rule, cls]) => '#dml-snap-curtain .' + cls + '{' + rule + '}').join('');
    return { root, css };
  }

  function sanitizeSnapNode(rootClone) {
    for (const bad of [...rootClone.querySelectorAll(SNAP_STRIP_SEL)]) bad.remove();
    const walk = [rootClone, ...rootClone.querySelectorAll('*')];
    for (const el of walk) {
      if (el.hasAttribute('id')) el.removeAttribute('id');
      if (el.hasAttribute('contenteditable')) el.removeAttribute('contenteditable');
      if (el.hasAttribute('tabindex')) el.removeAttribute('tabindex');
      for (const [from, to] of SNAP_RENAME_ATTRS) {
        if (el.hasAttribute(from)) {
          el.setAttribute(to, el.getAttribute(from) || '');
          el.removeAttribute(from);
        }
      }
      if (el.attributes) {
        for (const attr of [...el.attributes]) {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
          // Styles are self-contained; live application selectors must never
          // start reflowing the static image when their CSS finally arrives.
          if (attr.name.startsWith('data-') && !attr.name.startsWith('data-dml-snap-')) el.removeAttribute(attr.name);
        }
      }
    }
  }

  function captureVisualSnapshot(force = false) {
    const started = performance.now();
    try {
      const docEl = document.documentElement;
      if (!docEl || !globalThis.localStorage) return false;
      if (docEl.hasAttribute('data-dml-routing') || docEl.hasAttribute('data-dml-snap-cover')) return false;
      if (document.body?.hasAttribute('data-dsh-keyboard-open')) return false;
      if (!force && (Date.now() - lastInputAt < 1000 || Date.now() - lastSnapshotAt < 10000)) return false;
      const cordis = globalThis.__DSH_MOBILE_CORDIS__;
      const sessionId = cordis?.getCurrentSessionId?.() ?? null;
      const isBlank = !!cordis?.isCurrentSessionBlank?.();
      if (!sessionId || isBlank) return false;
      const content = [...(document.querySelectorAll?.('[data-conversation-content]') ?? [])]
        .find(el => typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true);
      if (!content || typeof content.cloneNode !== 'function') return false;
      if (content.dataset.conversationSession !== sessionId || content.dataset.contentPhase === 'settling') return false;
      const hasTurns = !!content.querySelector?.('[data-chat-turn], [data-message-bubble], [data-chat-flow] > *');
      if (!hasTurns) return false;
      const scroller = content.querySelector?.('[data-conversation-scroll]');
      const scrollTop = scroller ? Math.round(scroller.scrollTop || 0) : 0;
      const source = document.getElementById('root') || content;
      const frozen = freezeSnapshotTree(source), clone = frozen.root;
      sanitizeSnapNode(clone);
      const bounds = source.getBoundingClientRect();
      for (const [key,value] of Object.entries({position:'absolute',top:bounds.top+'px',left:bounds.left+'px',
        width:bounds.width+'px',height:bounds.height+'px',margin:'0'})) clone.style.setProperty(key,value,'important');
      const html = '<style>' + frozen.css.split('<').join(String.fromCharCode(92) + '3c ') + '</style>' + (clone.outerHTML || '');
      if (!html || html.length > 1500000) throw new Error('Snapshot exceeds byte budget: ' + html.length);
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(docEl) : null;
      const bodyCs = document.body && typeof getComputedStyle === 'function' ? getComputedStyle(document.body) : cs;
      const rawBg = (cs?.getPropertyValue?.('--dsw-alias-bg-base')?.trim() || bodyCs?.backgroundColor || '').trim();
      const dark = parseDark(rawBg);
      const amoled = docEl.getAttribute('data-dml-amoled') === 'true';
      const bg = (dark && amoled) ? '#000000' : (rawBg || (dark ? '#151517' : '#ffffff'));
      const fg = (cs?.getPropertyValue?.('--dsw-alias-label-primary')?.trim() || bodyCs?.color || '').trim();
      globalThis.localStorage.setItem('dml.visualSnap.v1', JSON.stringify({
        v: 2,
        width: innerWidth,
        height: innerHeight,
        ts: Date.now(),
        sessionId,
        scrollTop,
        bg,
        fg,
        dark,
        htmlClass: docEl.className || '',
        htmlTheme: docEl.getAttribute('data-theme') || '',
        htmlScheme: docEl.getAttribute('data-color-scheme') || '',
        html,
      }));
      snapshotStatus = { state: 'saved', bytes: html.length, durationMs: performance.now() - started };
      lastSnapshotAt = Date.now();
      return true;
    } catch (error) {
      snapshotStatus = { state: 'skipped', reason: String(error?.message || 'Snapshot unavailable'), durationMs: performance.now() - started };
      return false;
    }
  }

  function scheduleVisualSnapshot() {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapTimer = 0;
      if (document.visibilityState === 'hidden') return;
      captureVisualSnapshot(false);
    }, 1600);
  }

  function applyDisplayPrefs() {
    const html = document.documentElement;
    if (!html) return;
    try {
      const scale = globalThis.localStorage?.getItem('dml.pref.fontScale');
      if (scale && ['90', '110', '120'].includes(scale)) {
        html.setAttribute('data-dml-font-scale', scale);
        html.style?.setProperty?.('--dml-font-scale', String(Number(scale) / 100));
      } else {
        html.removeAttribute('data-dml-font-scale');
        html.style?.removeProperty?.('--dml-font-scale');
      }
      if (globalThis.localStorage?.getItem('dml.pref.codeWrap') === 'true') {
        html.setAttribute('data-dml-code-wrap', 'true');
      } else {
        html.removeAttribute('data-dml-code-wrap');
      }
      if (globalThis.localStorage?.getItem('dml.pref.amoled') === 'true') {
        html.setAttribute('data-dml-amoled', 'true');
      } else {
        html.removeAttribute('data-dml-amoled');
      }
    } catch {}
    if (typeof reportTheme === 'function') {
      lastThemeKey = '';
      try { reportTheme(); } catch {}
    }
  }
  applyDisplayPrefs();

  let scrollBtn = null;
  let scrollTopBtn = null;
  let readLineBtn = null;
  let observedScrollEl = null;
  let observedScrollSession = '';
  let scrollRestore = null;
  const scrollMemory = (${createChatSessionScrollMemory.toString()})();
  let scrollBtnRaf = 0;
  function getScrollSession(el) {
    if (!el || document.documentElement.hasAttribute('data-dml-routing') || globalThis.__DSH_MOBILE_ROUTE_STATE__?.intent) return '';
    const view = el.closest?.('[data-conversation-session]');
    const id = view?.getAttribute('data-conversation-session');
    if (!id || view.matches('[data-content-phase="hero"], [data-phase="hero"]')) return '';
    const selected = globalThis.__DSH_MOBILE_CORDIS__?.getCurrentSessionId?.();
    return !selected || id === selected ? id : '';
  }
  function onReadingScroll() {
    if (!scrollRestore && observedScrollSession && getScrollSession(observedScrollEl) === observedScrollSession) {
      scrollMemory.save(observedScrollSession, observedScrollEl);
    }
    lastInputAt = Date.now();
    scheduleVisualSnapshot();
    scheduleScrollBottom();
  }
  function cancelScrollRestore() { scrollRestore = null; }
  function bindScrollEl() {
    const el = document.querySelector('[data-conversation-scroll]');
    if (el !== observedScrollEl) {
      for (const type of ['scroll', 'touchstart', 'wheel', 'pointerdown']) {
        const handler = type === 'scroll' ? onReadingScroll : cancelScrollRestore;
        observedScrollEl?.removeEventListener(type, handler);
        el?.addEventListener(type, handler, { passive: true });
      }
      observedScrollSession = '';
      cancelScrollRestore();
      observedScrollEl = el;
    }
    const id = getScrollSession(el);
    if (id === observedScrollSession) return el;
    observedScrollSession = id;
    cancelScrollRestore();
    const saved = id && scrollMemory.read(id);
    if (!saved) return el;

    const restore = scrollRestore = {};
    const apply = (framesLeft) => {
      if (scrollRestore !== restore) return;
      if (!el.isConnected || getScrollSession(el) !== id) { cancelScrollRestore(); return; }
      const top = scrollMemory.resolve(saved, el);
      if (el.clientHeight > 0 && el.scrollTop !== top) el.scrollTop = top;
      // Harness can set a default scroll position on its next layout pass.
      if (framesLeft) requestAnimationFrame(() => apply(framesLeft - 1));
      else cancelScrollRestore();
    };
    apply(2);
    return el;
  }
  function updateScrollBottom() {
    scrollBtnRaf = 0;
    if (!scrollBtn && !scrollTopBtn && !readLineBtn) return;
    const el = bindScrollEl();
    const hidden = !el || isDrawerOpen() || el.closest?.('[data-content-phase="hero"], [data-phase="hero"]');
    if (hidden) {
      scrollBtn?.removeAttribute('data-visible');
      scrollTopBtn?.removeAttribute('data-visible');
      readLineBtn?.removeAttribute('data-visible');
      return;
    }
    const seat = document.querySelector('[data-composer-seat]');
    if (seat && typeof seat.offsetHeight === 'number' && seat.offsetHeight > 40) {
      document.documentElement.style.setProperty('--dml-seat-h', Math.round(seat.offsetHeight) + 'px');
    }
    const running = !!globalThis.__DSH_MOBILE_CORDIS__?.isCurrentSessionRunning?.();
    if (scrollBtn) {
      if (running) scrollBtn.setAttribute('data-running', 'true');
      else scrollBtn.removeAttribute('data-running');
    }
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (scrollBtn) {
      if (dist > 180) scrollBtn.setAttribute('data-visible', 'true');
      else scrollBtn.removeAttribute('data-visible');
    }
    if (scrollTopBtn) {
      if (el.scrollTop > 720) scrollTopBtn.setAttribute('data-visible', 'true');
      else scrollTopBtn.removeAttribute('data-visible');
    }
    if (readLineBtn) {
      if (running && dist > 240) readLineBtn.setAttribute('data-visible', 'true');
      else readLineBtn.removeAttribute('data-visible');
    }
  }
  function scheduleScrollBottom() {
    if ((!scrollBtn && !scrollTopBtn && !readLineBtn) || scrollBtnRaf) return;
    scrollBtnRaf = requestAnimationFrame(updateScrollBottom);
  }
  function scrollToTop() {
    const el = bindScrollEl();
    if (!el) return false;
    cancelScrollRestore();
    haptic('light');
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: scrollBehavior() });
    else el.scrollTop = 0;
    return true;
  }
  function scrollToBottom() {
    const el = bindScrollEl();
    if (!el) return false;
    cancelScrollRestore();
    haptic('light');
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    return true;
  }
  function installScrollBottom() {
    if (scrollBtn || !document.body || typeof document.createElement !== 'function') return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dsh-scroll-bottom';
    btn.setAttribute('aria-label', '回到底部');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
    btn.addEventListener('click', scrollToBottom);
    document.body.appendChild(btn);
    scrollBtn = btn;

    const topBtn = document.createElement('button');
    topBtn.type = 'button';
    topBtn.className = 'dsh-scroll-top';
    topBtn.setAttribute('aria-label', '回到顶部');
    topBtn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
    topBtn.addEventListener('click', scrollToTop);
    document.body.appendChild(topBtn);
    scrollTopBtn = topBtn;

    const lineBtn = document.createElement('button');
    lineBtn.type = 'button';
    lineBtn.className = 'dml-readline';
    lineBtn.setAttribute('aria-label', '跳到最新流式回复');
    lineBtn.textContent = '新内容 ↓';
    lineBtn.addEventListener('click', scrollToBottom);
    document.body.appendChild(lineBtn);
    readLineBtn = lineBtn;
    scheduleScrollBottom();
  }

  // Expandable fullscreen composer + send-and-settle (adapted from zcode-remote).
  const EXPAND_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 3.5H16.5V7.5"/><path d="M7.5 16.5H3.5V12.5"/><path d="M16.5 3.5L11.5 8.5"/><path d="M3.5 16.5L8.5 11.5"/></svg>';
  const COLLAPSE_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 7.5H12.5V3.5"/><path d="M3.5 12.5H7.5V16.5"/><path d="M12.5 7.5L16.5 3.5"/><path d="M7.5 12.5L3.5 16.5"/></svg>';
  function setComposerFull(full) {
    const html = document.documentElement;
    if (!html) return false;
    const next = !!full;
    if (next) html.setAttribute('data-dml-composer-full', 'true');
    else html.removeAttribute('data-dml-composer-full');
    const btn = document.getElementById('dml-composer-expand');
    if (btn) {
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      btn.setAttribute('aria-label', next ? '收起全屏输入' : '展开全屏输入');
      btn.innerHTML = next ? COLLAPSE_SVG : EXPAND_SVG;
    }
    return next;
  }
  function toggleComposerExpand() {
    const cur = document.documentElement?.getAttribute?.('data-dml-composer-full') === 'true';
    haptic('light');
    return setComposerFull(!cur);
  }
  function ensureComposerExpandButton() {
    if (typeof document.createElement !== 'function') return;
    const card = document.querySelector('[data-composer-card]');
    if (!card || card.querySelector('#dml-composer-expand')) return;
    const btn = document.createElement('button');
    btn.id = 'dml-composer-expand';
    btn.type = 'button';
    const isFull = document.documentElement?.getAttribute?.('data-dml-composer-full') === 'true';
    btn.setAttribute('aria-pressed', isFull ? 'true' : 'false');
    btn.setAttribute('aria-label', isFull ? '收起全屏输入' : '展开全屏输入');
    btn.title = '展开/收起输入框';
    btn.innerHTML = isFull ? COLLAPSE_SVG : EXPAND_SVG;
    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, { passive: true });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleComposerExpand();
    });
    card.appendChild(btn);
  }
  function installComposerEnhance() {
    ensureComposerExpandButton();
    if (globalThis.__dshComposerEnhanceInstalled) return;
    globalThis.__dshComposerEnhanceInstalled = true;
    const coarseTouch = !!globalThis.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
    document.addEventListener('click', (e) => {
      const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
      const btn = target?.closest?.('[data-composer-card] button');
      if (!btn || btn.id === 'dml-composer-expand' || btn.disabled) return;
      const aria = (btn.getAttribute('aria-label') || btn.title || '').toLowerCase();
      const isSubmit = btn.type === 'submit' || /发送|send|submit/i.test(aria);
      if (!isSubmit) return;
      if (document.documentElement?.getAttribute?.('data-dml-composer-full') === 'true') {
        setComposerFull(false);
      }
      if (coarseTouch && document.activeElement?.closest?.('[data-composer-card]')) {
        const ae = document.activeElement;
        requestAnimationFrame(() => { try { ae?.blur?.(); } catch {} });
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target?.closest?.('[data-composer-card] [contenteditable="true"]')) {
        if (document.documentElement?.getAttribute?.('data-dml-composer-full') === 'true') {
          setComposerFull(false);
        }
      }
    }, true);
  }

  // Conversation Turn Navigator (adapted from zcode-remote): list user prompts & jump directly.
  function queryUserTurnElements() {
    const scroller = document.querySelector('[data-conversation-scroll]');
    if (!scroller) return [];
    const bubbles = [...scroller.querySelectorAll('[data-message-bubble]')];
    if (bubbles.length) return bubbles;
    return [...scroller.querySelectorAll('[data-chat-turn]')];
  }
  function listConversationTurns() {
    const nodes = queryUserTurnElements();
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const raw = (nodes[i].textContent || '').replace(/\\s+/g, ' ').trim();
      if (!raw) continue;
      out.push({ index: i, text: raw.length > 72 ? raw.slice(0, 72) + '…' : raw });
    }
    return out;
  }
  function scrollToTurn(index) {
    const nodes = queryUserTurnElements();
    const el = nodes[Number(index)];
    if (!el) return false;
    haptic('light');
    try { el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); } catch {}
    el.classList.add('dml-turn-highlight');
    setTimeout(() => el.classList.remove('dml-turn-highlight'), 1400);
    return true;
  }

  function installLightbox() {
    if (!document.body || typeof document.createElement !== 'function' || globalThis.__dshLightboxInstalled) return;
    globalThis.__dshLightboxInstalled = true;
    let overlay = null;
    function openLightbox(src, alt) {
      if (!src || overlay) return;
      const root = document.createElement('div');
      root.className = 'dsh-lightbox';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', alt || '图片预览');
      const background = document.getElementById('root');
      const wasInert = background?.hasAttribute('inert');
      const previousFocus = document.activeElement;
      background?.setAttribute('inert', '');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', alt || '图片预览');
      const bar = document.createElement('div');
      bar.className = 'dsh-lightbox-bar';
      const save = document.createElement('a');
      save.className = 'dsh-lightbox-btn';
      save.href = src;
      save.download = (alt && alt.replace(/[^\\w.-]+/g, '_')) || 'image.png';
      save.textContent = '保存';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'dsh-lightbox-btn';
      close.textContent = '关闭';
      bar.appendChild(save);
      bar.appendChild(close);
      const stage = document.createElement('div');
      stage.className = 'dsh-lightbox-stage';
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt || '';
      stage.appendChild(img);
      root.appendChild(bar);
      root.appendChild(stage);
      let scale = 1, tx = 0, ty = 0, lastTap = 0, pinchDist = 0, pinchScale = 1, panStart = null;
      const renderTransform = (animate = false) => {
        img.style.transition = animate && !reducedMotion() ? 'transform 180ms cubic-bezier(0.22,1,0.36,1)' : 'none';
        img.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + scale + ')';
      };
      const closeBox = () => {
        if (!overlay) return;
        const cur = overlay;
        overlay = null;
        cur.removeAttribute('data-open');
        document.removeEventListener('keydown', onKey, true);
        if (!wasInert) background?.removeAttribute('inert');
        if (previousFocus?.matches?.('button, a[href]') && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        setTimeout(() => cur.remove?.(), reducedMotion() ? 0 : 180);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBox(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === close ? save : close).focus({ preventScroll: true });
        }
      };
      document.addEventListener('keydown', onKey, true);
      close.addEventListener('click', closeBox);
      stage.addEventListener('click', (e) => {
        if (e.target === stage) closeBox();
      });
      img.addEventListener('touchend', (e) => {
        if (e.touches?.length === 0 && e.changedTouches?.length === 1 && !panStart?.moved) {
          const now = Date.now();
          if (now - lastTap < 280) {
            scale = scale > 1.2 ? 1 : 2.2;
            tx = 0; ty = 0;
            renderTransform(true);
            lastTap = 0;
            return;
          }
          lastTap = now;
        }
        if (panStart && scale <= 1.05 && ty > 75) closeBox();
        else if (scale <= 1.05) { tx = 0; ty = 0; renderTransform(true); }
        panStart = null;
        pinchDist = 0;
      });
      stage.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          const [a, b] = e.touches;
          pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          pinchScale = scale;
          panStart = null;
        } else if (e.touches.length === 1) {
          const t = e.touches[0];
          panStart = { x: t.clientX, y: t.clientY, sx: tx, sy: ty, moved: false };
        }
      }, { passive: true });
      stage.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinchDist > 0) {
          const [a, b] = e.touches;
          const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          scale = Math.max(1, Math.min(4, pinchScale * (dist / pinchDist)));
          renderTransform(false);
        } else if (e.touches.length === 1 && panStart) {
          const t = e.touches[0];
          const dx = t.clientX - panStart.x, dy = t.clientY - panStart.y;
          if (Math.hypot(dx, dy) > 4) panStart.moved = true;
          tx = panStart.sx + dx;
          ty = panStart.sy + dy;
          renderTransform(false);
        }
      }, { passive: true });
      document.body.appendChild(root);
      overlay = root;
      close.focus({ preventScroll: true });
      requestAnimationFrame(() => root.setAttribute('data-open', 'true'));
      haptic('light');
    }
    document.addEventListener('click', (e) => {
      const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
      if (!target || typeof target.closest !== 'function') return;
      const img = target.tagName === 'IMG' ? target : target.closest('img');
      if (!img || !img.closest('[data-conversation-scroll]')) return;
      if (img.closest('button, a, [data-avatar], .dsh-lightbox')) return;
      const rect = img.getBoundingClientRect?.();
      if (!rect || rect.width < 48 || rect.height < 48) return;
      e.preventDefault();
      openLightbox(img.currentSrc || img.src, img.alt || '');
    }, true);
  }

  function showToast(message) {
    if (!message || !document.body) return;
    let el = document.querySelector('.dsh-mobile-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'dsh-mobile-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.visible = 'false'; }, 2800);
  }

  // Record last tapped control as a fallback anchor if any unindexed popup mounts.
  document.addEventListener('pointerdown', (e) => {
    if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
      lastPointerCoords = { x: e.clientX, y: e.clientY };
    }
    if (e.target instanceof Element) {
      const btn = e.target.closest('button, [role="button"], [aria-haspopup], a');
      lastPointerTarget = btn || e.target;
    }
  }, { capture: true, passive: true });

  // 1. Observe DSH's actual active theme & computed surface colors so the native iOS bar blends seamlessly.
  function parseDark(bg) {
    const html = document.documentElement;
    const explicit = html.dataset.theme || html.getAttribute('data-color-scheme') || '';
    if (/dark/i.test(explicit) || html.classList.contains('dark')) return true;
    if (/light/i.test(explicit) || html.classList.contains('light')) return false;
    const m = /rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i.exec(bg || '');
    if (m) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  function reportTheme() {
    const style = getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? getComputedStyle(document.body) : style;
    const rawBg = (style.getPropertyValue('--dsw-alias-bg-base').trim() || bodyStyle.backgroundColor || '').trim();
    const rawSidebar = (style.getPropertyValue('--dsw-specific-sidebar-fill').trim() || rawBg).trim();
    const dark = parseDark(rawBg || bodyStyle.backgroundColor);
    const amoled = document.documentElement?.getAttribute?.('data-dml-amoled') === 'true';
    const bgBase = (dark && amoled) ? '#000000' : rawBg;
    const sidebarFill = (dark && amoled) ? '#050507' : rawSidebar;
    const key = dark + '|' + bgBase + '|' + sidebarFill;
    if (key === lastThemeKey) return;
    lastThemeKey = key;
    if (bgBase && bgBase !== 'transparent' && !/^rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)$/i.test(bgBase)) {
      try {
        localStorage.setItem('dml.surface', dark ? 'dark' : 'light');
        localStorage.setItem('dml.bg', bgBase);
      } catch {}
    }
    post({ type: 'theme', dark, bgBase, sidebarFill });
  }

  // 2. Observe UI state (sidebar drawer open/closed, document title, current session id).
  let observedDrawerFrame = null;
  const drawerAttrObserver = new MutationObserver(() => { scheduleReportUi(); });

  function ensureDrawerObserver() {
    const frame = document.querySelector('[data-sidebar-drawer]');
    if (frame && frame !== observedDrawerFrame) {
      observedDrawerFrame = frame;
      drawerAttrObserver.disconnect();
      drawerAttrObserver.observe(frame, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed', 'data-sidebar-drawer'],
      });
    }
    return frame;
  }

  function isDrawerOpen() {
    const frame = ensureDrawerObserver();
    if (!frame) return false;
    return !frame.hasAttribute('data-sidebar-collapsed');
  }

  let lastReportedSessionId = null;
  function reportUi() {
    uiRaf = 0;
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    const currentSessionId = cordis?.getCurrentSessionId?.() ?? null;
    const currentSessionBlank = cordis?.isCurrentSessionBlank?.() ?? false;
    const taskRunning = !!cordis?.isCurrentSessionRunning?.();
    const pendingCount = cordis?.getPendingApprovals?.()?.length ?? 0;
    const drawerOpen = isDrawerOpen();
    ensureComposerExpandButton();
    if (currentSessionId !== lastReportedSessionId) {
      lastReportedSessionId = currentSessionId;
      if (document.documentElement?.getAttribute?.('data-dml-composer-full') === 'true') {
        setComposerFull(false);
      }
      if (currentSessionId && !currentSessionBlank) scheduleVisualSnapshot();
    }
    scheduleScrollBottom();
    const title = (document.title || '').replace(/\\s*[-—·|]\\s*DeepSeek Harness$/i, '').trim();
    const key = drawerOpen + '|' + taskRunning + '|' + pendingCount + '|' + title + '|' + (currentSessionId || '') + '|' + currentSessionBlank;
    if (key === lastUiKey) return;
    lastUiKey = key;
    post({ type: 'ui', drawerOpen, taskRunning, pendingCount, title, currentSessionId, currentSessionBlank });
  }

  function scheduleReportUi() {
    if (uiRaf) return;
    uiRaf = requestAnimationFrame(reportUi);
  }

  // 3. Universal CSS Anchor Positioning Engine for all DSH portaled popups/menus/dialogs.
  const activePopups = new Set();
  const popupResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target instanceof HTMLElement && entry.target.isConnected) {
            positionPopup(entry.target);
          }
        }
      })
    : null;

  function findTriggerInSet(map, key, popup) {
    if (!key) return null;
    const set = map.get(key);
    if (!set) return null;
    let found = null;
    for (const candidate of set) {
      if (!candidate || !candidate.isConnected) {
        set.delete(candidate);
        continue;
      }
      if (candidate !== popup && !popup.contains(candidate)) {
        found = candidate;
      }
    }
    if (set.size === 0) map.delete(key);
    return found;
  }

  function resolvePopupBinding(popup) {
    const meta = anchorApi.popups.get(popup);
    if (meta && meta.anchor) {
      const trigger = findTriggerInSet(anchorApi.anchors, meta.anchor, popup)
        || document.querySelector(\`[data-dsh-anchor-name="\${CSS.escape(meta.anchor)}"]\`);
      return { kind: meta.kind, anchorName: meta.anchor, trigger };
    }
    const posAttr = popup.getAttribute('data-dsh-position-anchor');
    if (posAttr) {
      const trigger = findTriggerInSet(anchorApi.anchors, posAttr, popup)
        || document.querySelector(\`[data-dsh-anchor-name="\${CSS.escape(posAttr)}"]\`);
      return { kind: 'positionAnchor', anchorName: posAttr, trigger };
    }
    const subAttr = popup.getAttribute('data-dsh-submenu-parent');
    if (subAttr || popup.hasAttribute('data-submenu-layout')) {
      const name = subAttr || popup.style.getPropertyValue('--dsh-submenu-parent').trim();
      const trigger = (name && (findTriggerInSet(anchorApi.anchors, name, popup)
        || document.querySelector(\`[data-dsh-anchor-name="\${CSS.escape(name)}"]\`))) || null;
      return { kind: 'submenu', anchorName: name || '--dsh-submenu-parent', trigger };
    }
    const modelAttr = popup.getAttribute('data-dsh-model-anchor')
      || popup.style.getPropertyValue('--dsh-model-anchor').trim();
    if (modelAttr) {
      const trigger = findTriggerInSet(anchorApi.varAnchors, modelAttr, popup);
      return { kind: 'model', anchorName: modelAttr, trigger };
    }
    if (popup.hasAttribute('data-anchor-side') || popup.hasAttribute('data-context-menu') || popup.hasAttribute('data-subagent-panel') || popup.hasAttribute('data-install-registry')) {
      return { kind: 'positionAnchor', anchorName: '--dsh-fallback', trigger: lastPointerTarget };
    }
    return null;
  }

  function isPortalPopupCandidate(el) {
    if (!(el instanceof HTMLElement) || el.id === 'root' || el.classList.contains('dsh-mobile-toast')) return false;
    if (el.hasAttribute('data-dsh-position-anchor') || el.hasAttribute('data-dsh-submenu-parent') || el.hasAttribute('data-dsh-model-anchor')) return true;
    if (el.hasAttribute('data-anchor-side') || el.hasAttribute('data-submenu-layout') || el.hasAttribute('data-context-menu')) return true;
    if (el.hasAttribute('data-subagent-panel') || el.hasAttribute('data-install-registry')) return true;
    return anchorApi.popups.has(el);
  }

  function inferPlacementPolicy(popup, binding) {
    const name = binding.anchorName || '';
    if (binding.kind === 'submenu' || popup.hasAttribute('data-submenu-layout')) {
      return {
        mode: 'submenu',
        layout: popup.getAttribute('data-submenu-layout') || 'side',
        gap: 4,
      };
    }
    if (binding.kind === 'model' || name.startsWith('--dsh-model-')) {
      return { mode: 'anchored', side: 'top', align: 'end', gap: 8, matchWidth: false };
    }
    if (popup.hasAttribute('data-anchor-side') || name.startsWith('--dsh-menu-')) {
      return {
        mode: 'anchored',
        side: popup.getAttribute('data-anchor-side') || 'bottom',
        align: popup.getAttribute('data-anchor-align') || 'start',
        gap: 4,
        matchWidth: popup.hasAttribute('data-match-anchor-width'),
      };
    }
    if (name.startsWith('--dsh-context-') || name.startsWith('--dsh-stat-')) {
      return { mode: 'anchored', side: 'top', align: 'start', gap: 8, matchWidth: false };
    }
    if (name.startsWith('--dsh-approval-warning-')) {
      return { mode: 'anchored', side: 'top', align: 'end', gap: 8, matchWidth: false };
    }
    if (name.startsWith('--dsh-jobs-') || name.startsWith('--dsh-font-notice-')) {
      return { mode: 'anchored', side: 'bottom', align: 'end', gap: 6, matchWidth: false };
    }
    if (name.startsWith('--dsh-task-menu-')) {
      const alignEnd = /alignEnd/i.test(popup.className);
      return { mode: 'anchored', side: 'bottom', align: alignEnd ? 'end' : 'start', gap: 4, matchWidth: false };
    }
    return {
      mode: 'anchored',
      side: popup.getAttribute('data-anchor-side') || 'bottom',
      align: popup.getAttribute('data-anchor-align') || 'start',
      gap: 5,
      matchWidth: popup.hasAttribute('data-match-anchor-width'),
    };
  }

  function getTriggerRect(trigger) {
    if (trigger instanceof Element && trigger.isConnected) {
      const r = trigger.getBoundingClientRect();
      // ContextMenu uses a 0x0 fixed span at (x, y); normal triggers have non-zero size.
      if (r.width > 0 || r.height > 0 || r.left > 0 || r.top > 0) return r;
      if (trigger.parentElement) {
        const pr = trigger.parentElement.getBoundingClientRect();
        if (pr.width > 0 || pr.height > 0) return pr;
      }
    }
    if (lastPointerTarget instanceof Element && lastPointerTarget.isConnected) {
      const lr = lastPointerTarget.getBoundingClientRect();
      if (lr.width > 0 || lr.height > 0) return lr;
    }
    const { x, y } = lastPointerCoords;
    return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  }

  function positionPopup(popup) {
    if (!(popup instanceof HTMLElement) || !popup.isConnected) return;
    // Never treat inside-#root triggers as popups unless they are fixed overlays.
    const rootEl = document.getElementById('root');
    if (rootEl && rootEl.contains(popup) && getComputedStyle(popup).position !== 'fixed') return;

    const binding = resolvePopupBinding(popup);
    if (!binding) return;

    const vv = globalThis.visualViewport;
    const vw = Math.round(vv ? vv.width : (globalThis.innerWidth || 390));
    const rawVh = Math.round(vv ? vv.height : (globalThis.innerHeight || 780));
    const vh = Math.max(200, rawVh - (nativeKbMode ? nativeKbInset : 0));
    const pad = 10;
    const topMin = 10;
    const maxAvailW = Math.max(180, vw - pad * 2);

    const policy = inferPlacementPolicy(popup, binding);
    const anchorRect = getTriggerRect(binding.trigger);

    popup.setAttribute('data-dsh-positioned', 'true');
    // Reset opposing constraints so intrinsic size is measured accurately.
    popup.style.setProperty('right', 'auto', 'important');
    popup.style.setProperty('bottom', 'auto', 'important');
    popup.style.setProperty('max-width', maxAvailW + 'px', 'important');
    if (policy.matchWidth && anchorRect.width > 0) {
      popup.style.setProperty('min-width', Math.min(Math.round(anchorRect.width), maxAvailW) + 'px', 'important');
    }

    const rect = popup.getBoundingClientRect();
    const w = Math.min(Math.max(rect.width || popup.offsetWidth || 200, 120), maxAvailW);
    const rawH = Math.max(rect.height || popup.offsetHeight || 160, 48);

    let x = pad;
    let y = topMin;
    let maxH = Math.max(140, vh - topMin - pad);

    if (policy.mode === 'submenu') {
      const rowOffset = parseFloat(getComputedStyle(popup).getPropertyValue('--dsh-submenu-row-offset')) || 0;
      if (policy.layout === 'page' || vw < 520) {
        // On narrow mobile screens, overlay or slightly inset from the parent menu so it never clips off-right.
        const minW = Math.min(Math.max(Math.round(anchorRect.width), 180), maxAvailW);
        popup.style.setProperty('min-width', minW + 'px', 'important');
        const measuredW = Math.min(Math.max(w, minW), maxAvailW);
        x = Math.max(pad, Math.min(Math.round(anchorRect.left + 12), vw - pad - measuredW));
        const desiredTop = Math.round(anchorRect.top + (policy.layout === 'side' ? Math.min(rowOffset, 120) : 0));
        maxH = Math.max(140, vh - topMin - pad);
        const clampedH = Math.min(rawH, maxH);
        y = Math.max(topMin, Math.min(desiredTop, vh - pad - clampedH));
      } else {
        const rightX = Math.round(anchorRect.right + policy.gap);
        const leftX = Math.round(anchorRect.left - policy.gap - w);
        x = (rightX + w <= vw - pad) ? rightX : Math.max(pad, leftX);
        const desiredTop = Math.round(anchorRect.top + rowOffset);
        const clampedH = Math.min(rawH, maxH);
        y = Math.max(topMin, Math.min(desiredTop, vh - pad - clampedH));
      }
    } else if (policy.side === 'right') {
      const rightX = Math.round(anchorRect.right + policy.gap);
      const leftX = Math.round(anchorRect.left - policy.gap - w);
      if (rightX + w <= vw - pad) {
        x = rightX;
        const clampedH = Math.min(rawH, maxH);
        y = Math.max(topMin, Math.min(Math.round(anchorRect.top), vh - pad - clampedH));
      } else if (leftX >= pad) {
        x = leftX;
        const clampedH = Math.min(rawH, maxH);
        y = Math.max(topMin, Math.min(Math.round(anchorRect.top), vh - pad - clampedH));
      } else {
        // Fallback below/above trigger when horizontal space is tight on phone portrait.
        x = Math.max(pad, Math.min(Math.round(anchorRect.left), vw - pad - w));
        const spaceBelow = vh - pad - (anchorRect.bottom + policy.gap);
        const spaceAbove = anchorRect.top - policy.gap - topMin;
        if (rawH <= spaceBelow || spaceBelow >= spaceAbove) {
          y = Math.max(topMin, Math.round(anchorRect.bottom + policy.gap));
          maxH = Math.max(130, vh - pad - y);
        } else {
          maxH = Math.max(130, Math.round(spaceAbove));
          const usedH = Math.min(rawH, maxH);
          y = Math.max(topMin, Math.round(anchorRect.top - policy.gap - usedH));
        }
      }
    } else {
      // Standard 'top' or 'bottom' anchored popup with smart auto-flip.
      const spaceAbove = Math.round(anchorRect.top - policy.gap - topMin);
      const spaceBelow = Math.round(vh - pad - (anchorRect.bottom + policy.gap));
      const preferTop = policy.side === 'top';
      const placeTop = preferTop
        ? (rawH <= spaceAbove || spaceAbove >= Math.max(spaceBelow, 120))
        : (rawH > spaceBelow && spaceAbove > spaceBelow && spaceAbove >= 120);

      if (placeTop) {
        maxH = Math.max(120, Math.min(460, spaceAbove));
        const usedH = Math.min(rawH, maxH);
        y = Math.max(topMin, Math.round(anchorRect.top - policy.gap - usedH));
      } else {
        y = Math.max(topMin, Math.round(anchorRect.bottom + policy.gap));
        maxH = Math.max(120, Math.min(480, vh - pad - y));
        const usedH = Math.min(rawH, maxH);
        if (y + usedH > vh - pad) {
          y = Math.max(topMin, vh - pad - usedH);
        }
      }

      const desiredX = policy.align === 'end'
        ? Math.round(anchorRect.right - w)
        : Math.round(anchorRect.left);
      x = Math.max(pad, Math.min(desiredX, vw - pad - w));
    }

    popup.style.setProperty('left', Math.round(x) + 'px', 'important');
    popup.style.setProperty('top', Math.round(y) + 'px', 'important');
    popup.style.setProperty('max-height', Math.round(maxH) + 'px', 'important');
  }

  function syncPopupOpenAttr() {
    const html = document.documentElement;
    if (!html) return;
    if (activePopups.size > 0) html.setAttribute('data-dml-popup-open', 'true');
    else html.removeAttribute('data-dml-popup-open');
  }

  function registerPopupNode(node) {
    if (!(node instanceof HTMLElement)) return;
    const candidates = [];
    if (isPortalPopupCandidate(node)) candidates.push(node);
    if (node.id !== 'root' && node.children.length > 0) {
      const nested = node.querySelectorAll(
        '[data-dsh-position-anchor], [data-dsh-submenu-parent], [data-dsh-model-anchor], [data-anchor-side], [data-submenu-layout], [data-context-menu], [data-subagent-panel], [data-install-registry]'
      );
      for (const el of nested) {
        if (el instanceof HTMLElement) candidates.push(el);
      }
    }
    for (const popup of candidates) {
      activePopups.add(popup);
      popupResizeObserver?.observe(popup);
      positionPopup(popup);
      requestAnimationFrame(() => {
        if (popup.isConnected) positionPopup(popup);
      });
    }
    syncPopupOpenAttr();
  }

  function repositionAllPopups() {
    popupRaf = 0;
    for (const popup of activePopups) {
      if (!popup.isConnected) {
        activePopups.delete(popup);
        popupResizeObserver?.unobserve(popup);
        continue;
      }
      positionPopup(popup);
    }
    syncPopupOpenAttr();
  }

  function scheduleRepositionPopups() {
    if (activePopups.size === 0 || popupRaf) return;
    popupRaf = requestAnimationFrame(repositionAllPopups);
  }

  anchorApi.onPopupChange = (el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.isConnected && document.body && !document.getElementById('root')?.contains(el)) {
      registerPopupNode(el);
    } else {
      queueMicrotask(() => {
        if (el.isConnected && !document.getElementById('root')?.contains(el)) {
          registerPopupNode(el);
        }
      });
    }
  };

  // 4. Keep slash-command (/) and @-mention overlay height generous above the bottom-docked composer.
  let overlayRaf = 0, lastOverlay, lastOverlayHeight;
  function syncOverlayHeight() {
    const overlay = document.querySelector('[data-trigger-menu]');
    if (!overlay) { lastOverlay = undefined; return; }
    const card = overlay.closest?.('[data-composer-card]') || document.querySelector('[data-composer-card]');
    const rawVh = Math.round(globalThis.visualViewport?.height || globalThis.innerHeight || 760);
    const vh = Math.max(200, rawVh - (nativeKbMode ? nativeKbInset : 0));
    const rect = card?.getBoundingClientRect();
    const top = rect ? rect.top : 0;
    const estimatedTop = nativeKbMode && nativeKbInset > 0 && rect
      ? Math.min(top, rawVh - nativeKbInset - Math.max(80, rect.height) - 10)
      : top;
    const scrollTopEdge = card?.closest?.('[data-conversation-scroll]')?.getBoundingClientRect().top || 0;
    const visibleTop = Math.max(globalThis.visualViewport?.offsetTop || 0, scrollTopEdge);
    const avail = Math.max(1, Math.min(480, vh - 8, Math.floor(estimatedTop - visibleTop - 8)));
    if (overlay !== lastOverlay || avail !== lastOverlayHeight) {
      overlay.style.setProperty('--dsh-overlay-avail-h', avail + 'px');
      lastOverlay = overlay; lastOverlayHeight = avail;
    }
  }
  function scheduleOverlayHeight() {
    if (!overlayRaf) overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; syncOverlayHeight(); });
  }

  // 5. Passively observe DSH's /api/remote.mux WebSocket to report live sync state to Swift.
  let latestMux;
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    const setWsState = (next) => {
      if (wsState === next) return;
      wsState = next;
      post({ type: 'ws', state: next });
    };
    const WrappedWebSocket = function(url, protocols) {
      const ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      try {
        const href = String(url || '');
        if (href.includes('/api/remote.mux')) {
          latestMux = ws;
          const report = state => { if (ws === latestMux) setWsState(state); };
          report('connecting');
          // TCP/WSS open is not a usable Harness generation. Cordis confirms
          // ready after subscriptions are installed, including on reconnect.
          ws.addEventListener('open', () => report('connecting'));
          ws.addEventListener('close', () => report('disconnected'));
          ws.addEventListener('error', () => report('disconnected'));
        }
      } catch {}
      return ws;
    };
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    globalThis.WebSocket = WrappedWebSocket;
  }

  // 6. Native 120Hz GPU keyboard animation (zero #root height reflow, zero tile flash)
  //    plus zero-thrash layout mode when paired with an older IPA that resizes WKWebView.
  let nativeKbMode = false, nativeKbInset = 0, lastHeroLift = 0, kbPadTimer = 0, kbSettleTimer = 0;
  let kbScrollOwner = null, kbScrollShift = 0, kbExpectedTop = 0;

  function setKeyboard(insetPx, durationMs = 250) {
    const docEl = document.documentElement;
    const root = document.getElementById('root');
    if (!docEl || !document.body) return null;
    const next = Number.isFinite(Number(insetPx)) ? Math.max(0, Math.round(Number(insetPx))) : 0;
    const dur = reducedMotion() ? 0 : Math.max(0, Math.min(600, Math.round(Number(durationMs) || 0)));
    const prev = nativeKbInset;

    if (!nativeKbMode) {
      nativeKbMode = true;
      docEl.setAttribute('data-dml-native-kb', 'true');
      if (root && lastHeight) {
        root.style.removeProperty('height');
        lastHeight = 0;
      }
    }

    clearTimeout(kbPadTimer);
    clearTimeout(kbSettleTimer);

    const activeChat = document.querySelector('[data-content-phase="active"] [data-conversation-scroll]');
    const preMaxScroll = activeChat ? Math.max(0, activeChat.scrollHeight - activeChat.clientHeight) : 0;
    const preTop = activeChat ? activeChat.scrollTop : 0;
    const nearBottom = activeChat ? (preMaxScroll - preTop <= 140) : false;
    // Undo only the scrolling we performed. A reader who moved away owns their
    // position, even if the keyboard is still open or the conversation changed.
    if (activeChat !== kbScrollOwner || Math.abs(preTop - kbExpectedTop) > 2) {
      kbScrollOwner = activeChat;
      kbScrollShift = 0;
    }
    const adjustScroll = delta => {
      activeChat.scrollTop = Math.max(0, preTop + delta);
      kbScrollShift += activeChat.scrollTop - preTop;
      kbExpectedTop = activeChat.scrollTop;
    };
    const heroSeat = document.querySelector('[data-content-phase="hero"] [data-composer-seat], [data-phase="hero"] [data-composer-seat]');
    const heroBottom = next > 2 && heroSeat ? heroSeat.getBoundingClientRect().bottom : 0;

    nativeKbInset = next;
    docEl.style.setProperty('--dml-kb', next + 'px');
    docEl.style.setProperty('--dml-kb-dur', dur + 'ms');

    if (next > 2 && heroSeat) {
      const restingBottom = heroBottom + lastHeroLift;
      const availBottom = (globalThis.innerHeight || 780) - next - 12;
      const needed = Math.max(0, Math.ceil(restingBottom - availBottom));
      const heroLift = Math.min(next, Math.max(Math.round(next * 0.45), needed));
      lastHeroLift = heroLift;
      docEl.style.setProperty('--dml-kb-hero', heroLift + 'px');
    } else {
      lastHeroLift = 0;
      docEl.style.setProperty('--dml-kb-hero', '0px');
    }

    if (next > 2) {
      document.body.setAttribute('data-dsh-keyboard-open', 'true');
      lastOpen = true;
      docEl.style.setProperty('--dml-kb-pad', next + 'px');
      if (activeChat && next > prev) {
        const delta = next - prev;
        if (preMaxScroll > 8 && nearBottom) {
          adjustScroll(delta);
        } else if (preMaxScroll <= 8) {
          const viewArea = activeChat.firstElementChild;
          const seat = document.querySelector('[data-composer-seat]');
          const seatH = seat ? seat.getBoundingClientRect().height : 120;
          const lastMsg = viewArea?.lastElementChild;
          if (lastMsg && lastMsg !== seat) {
            const availBottom = (globalThis.innerHeight || 780) - next - seatH - 8;
            const overlap = Math.ceil(lastMsg.getBoundingClientRect().bottom - availBottom);
            if (overlap > 4) adjustScroll(overlap);
          }
        }
      }
      if (activeChat && next < prev && kbScrollShift > 0) {
        adjustScroll(-Math.min(prev - next, kbScrollShift));
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && !focused.closest?.('[data-composer-seat]')) {
        const rect = focused.getBoundingClientRect();
        const availBottom = (globalThis.innerHeight || 780) - next - 20;
        if (rect.bottom > availBottom) {
          try { focused.scrollIntoView({ block: 'center', behavior: scrollBehavior() }); } catch {}
        }
      }
    } else {
      document.body.removeAttribute('data-dsh-keyboard-open');
      lastOpen = false;
      if (activeChat && prev > 0) {
        docEl.style.setProperty('--dml-kb-pad', '0px');
        if (kbScrollShift > 0) activeChat.scrollTop = Math.max(0, preTop - kbScrollShift);
        kbScrollShift = 0;
        kbExpectedTop = activeChat.scrollTop;
      } else {
        kbPadTimer = setTimeout(() => {
          if (nativeKbInset === 0) docEl.style.setProperty('--dml-kb-pad', '0px');
        }, dur + 20);
      }
    }

    if (lastOverlay?.isConnected) scheduleOverlayHeight();
    scheduleRepositionPopups();
    if (dur > 0) {
      kbSettleTimer = setTimeout(() => {
        if (lastOverlay?.isConnected) scheduleOverlayHeight();
        scheduleRepositionPopups();
      }, dur + 30);
    }
    return { inset: next, duration: dur };
  }

  // Fallback for older IPAs where SwiftUI resizes WKWebView with the keyboard.
  // Never force layout reflows, height thrashing, or CSS flip transforms when SwiftUI already resized the viewport.
  let restingHeight = 0, restingWidth = 0, viewportRaf = 0, lastHeight, lastOpen;
  function syncViewport() {
    if (nativeKbMode) return;
    const vv = globalThis.visualViewport, root = document.getElementById('root');
    if (!vv || !root || !document.body) return;
    const height = Math.round(vv.height), layout = globalThis.innerHeight;
    if (height <= 100 || !layout || document.hidden) return;
    if (restingWidth !== globalThis.innerWidth || !restingHeight) {
      restingWidth = globalThis.innerWidth; restingHeight = layout;
    }
    const editable = document.activeElement?.matches?.('input, textarea, [contenteditable="true"]');
    const bottom = Math.min(layout, Math.round(height + Math.max(0, vv.offsetTop || 0)));
    if (!editable && !lastOpen) restingHeight = layout;
    const loss = Math.max(0, restingHeight - bottom);
    const open = (editable ? loss > 2 : lastOpen && loss > 96) && (!vv.scale || vv.scale === 1);
    const override = open && (layout - bottom > 80) ? bottom : 0;
    if (override !== lastHeight) {
      if (override) root.style.setProperty('height', override + 'px');
      else if (lastHeight) root.style.removeProperty('height');
      lastHeight = override;
    }
    if (!!open !== lastOpen) {
      if (open) document.body.setAttribute('data-dsh-keyboard-open', 'true');
      else document.body.removeAttribute('data-dsh-keyboard-open');
      lastOpen = !!open;
    }
    if (lastOverlay?.isConnected) scheduleOverlayHeight();
    scheduleRepositionPopups();
  }
  function scheduleViewport() {
    if (!viewportRaf) viewportRaf = requestAnimationFrame(() => { viewportRaf = 0; syncViewport(); });
  }
  const maybeOverlayHeight = () => {
    if (lastOverlay?.isConnected || document.querySelector('[data-trigger-menu]')) scheduleOverlayHeight();
  };
  const onComposerInput = (e) => {
    lastInputAt = Date.now();
    // Avoid full-document querySelector('[data-trigger-menu]') on every ordinary keystroke.
    const ch = typeof e?.data === 'string' ? e.data : '';
    if (lastOverlay?.isConnected || ch.includes('/') || ch.includes('@')) {
      scheduleOverlayHeight();
    }
  };
  globalThis.visualViewport?.addEventListener('resize', scheduleViewport, { passive: true });
  globalThis.visualViewport?.addEventListener('scroll', () => { if (lastOpen && lastHeight) scheduleViewport(); scheduleRepositionPopups(); }, { passive: true });
  globalThis.visualViewport?.addEventListener('scrollend', scheduleViewport, { passive: true });
  globalThis.addEventListener('resize', scheduleViewport, { passive: true });
  globalThis.addEventListener('scroll', () => { scheduleRepositionPopups(); scheduleScrollBottom(); }, { capture: true, passive: true });
  document.addEventListener('focusin', () => { scheduleViewport(); ensureComposerExpandButton(); }, { passive: true });
  document.addEventListener('focusout', () => { scheduleViewport(); scheduleVisualSnapshot(); }, { passive: true });
  document.addEventListener('pointerup', maybeOverlayHeight, { passive:true, capture:true });
  document.addEventListener('input', onComposerInput, { passive: true });

  // 7. Left-edge swipe gesture to open DSH's native sidebar drawer, and swipe-left to close it.
  function toggleSidebar() {
    revealRoot();
    const settings = document.querySelector('[data-shortcut-modal="settings"]');
    if (settings) {
      const close = settings.querySelector('[data-slot="settings.close"]')?.closest('button');
      if (close) {
        close.click();
        requestAnimationFrame(() => { if (!isDrawerOpen()) toggleDrawer(); });
        return true;
      }
    }
    return toggleDrawer();
  }
  function toggleDrawer() {
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (typeof cordis?.toggleSidebar === 'function') {
      if (cordis.toggleSidebar() === false) return false;
      setTimeout(scheduleReportUi, 60);
      return true;
    }
    const open = isDrawerOpen();
    const target = open
      ? (document.querySelector('[data-sidebar-mask]') || document.querySelector('[data-sidebar-toggle]'))
      : (document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]'));
    if (target instanceof HTMLElement) {
      target.click();
      setTimeout(scheduleReportUi, 60);
      return true;
    }
    return false;
  }

  function hasHorizontalScrollParent(node) {
    let el = node instanceof Element ? node : null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  let touchStart = null;
  let rightTouchStart = null;
  let chatTouchStart = null;
  function isInteractiveTarget(node) {
    return !!(node && typeof node.closest === 'function' && node.closest('a, button, input, textarea, select, summary, [role="button"], [role="menuitem"], [contenteditable], .dsh-scroll-bottom, .dsh-scroll-top'));
  }
  function isKeyboardActive() {
    if (document.body?.hasAttribute?.('data-dsh-keyboard-open')) return true;
    const ae = document.activeElement;
    return !!(ae && typeof ae.closest === 'function' && ae.closest('[data-composer-seat]'));
  }
  document.addEventListener('touchstart', (e) => {
    if (document.querySelector('[data-trigger-menu]') || document.querySelector('.dml-hub-backdrop') || e.touches.length !== 1) {
      touchStart = null;
      rightTouchStart = null;
      chatTouchStart = null;
      return;
    }
    const t = e.touches[0];
    const open = isDrawerOpen();
    const targetEl = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
    const vw = globalThis.innerWidth || 393;
    if (!open && t.clientX > 34 && t.clientX < vw - 34 && !isInteractiveTarget(targetEl)) {
      const inScroll = !!(targetEl && typeof targetEl.closest === 'function' && targetEl.closest('[data-conversation-scroll]'));
      const inSeat = !!(targetEl && typeof targetEl.closest === 'function' && targetEl.closest('[data-composer-seat]'));
      if ((inScroll || inSeat) && isKeyboardActive()) {
        chatTouchStart = { x: t.clientX, y: t.clientY, time: Date.now(), inScroll, inSeat };
      } else {
        chatTouchStart = null;
      }
    } else {
      chatTouchStart = null;
    }
    if (!open && t.clientX >= vw - 34 && !hasHorizontalScrollParent(targetEl)) {
      rightTouchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
    } else {
      rightTouchStart = null;
    }
    if (!open && t.clientX > 34) { touchStart = null; return; }
    if (!open && hasHorizontalScrollParent(e.target)) { touchStart = null; return; }
    touchStart = { x: t.clientX, y: t.clientY, open, time: Date.now() };
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (chatTouchStart && e.changedTouches.length) {
      const ct = e.changedTouches[0];
      const cdx = ct.clientX - chatTouchStart.x;
      const cdy = ct.clientY - chatTouchStart.y;
      const celapsed = Date.now() - chatTouchStart.time;
      const cs = chatTouchStart;
      chatTouchStart = null;
      const hasSelection = !!(globalThis.getSelection?.()?.toString?.());
      if (!hasSelection && isKeyboardActive()) {
        const ae = document.activeElement;
        const tappedScroll = cs.inScroll && celapsed < 320 && Math.abs(cdx) < 10 && Math.abs(cdy) < 10;
        const swipedDownComposer = cs.inSeat && celapsed < 550 && cdy > 40 && Math.abs(cdy) > Math.abs(cdx) * 1.4;
        const scrollEl = cs.inScroll ? document.querySelector('[data-conversation-scroll]') : null;
        const atBottomOrShort = !scrollEl || (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= 8);
        const swipedDownAtBottom = cs.inScroll && atBottomOrShort && celapsed < 550 && cdy > 44 && Math.abs(cdy) > Math.abs(cdx) * 1.5;
        if ((tappedScroll || swipedDownComposer || swipedDownAtBottom) && typeof ae?.blur === 'function') {
          ae.blur();
        }
      }
    }
    if (rightTouchStart && e.changedTouches.length) {
      const rt = e.changedTouches[0];
      const rdx = rt.clientX - rightTouchStart.x;
      const rdy = rt.clientY - rightTouchStart.y;
      const relapsed = Date.now() - rightTouchStart.time;
      rightTouchStart = null;
      if (relapsed <= 650 && rdx < -44 && Math.abs(rdx) > Math.abs(rdy) * 1.35) {
        if (toggleRightPanel()) haptic('light');
      }
    }
    if (!touchStart || !e.changedTouches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const elapsed = Date.now() - touchStart.time;
    const start = touchStart;
    touchStart = null;
    if (elapsed > 650 || Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    if (!start.open && dx > 44) { if (toggleSidebar()) haptic('light'); }
    else if (start.open && dx < -44) { if (toggleSidebar()) haptic('light'); }
  }, { passive: true });

  // 8. Programmatic navigation + reconnect + follow-desktop sync.
  function toggleRightPanel() {
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (typeof cordis?.toggleRightPanel === 'function') return !!cordis.toggleRightPanel();
    const btn = [...(document.querySelectorAll?.('[data-sidebar-right-toggle], [data-sidebar-right-expand], [data-conversation-header-corner] button') ?? [])]
      .find(el => {
        if (el.disabled || el.closest?.('[inert], [hidden]')) return false;
        const r = el.getBoundingClientRect?.();
        return r && r.width > 2 && r.height > 2 && r.right > 0 && r.left < (globalThis.innerWidth || 9999);
      });
    if (typeof HTMLElement === 'function' && btn instanceof HTMLElement) { btn.click(); return true; }
    return false;
  }

  function insertDraft(text, opts) {
    return !!globalThis.__DSH_MOBILE_CORDIS__?.insertDraft?.(text, opts);
  }

  function openHub(tab = 'tasks') {
    revealRoot();
    return !!globalThis.__DSH_MOBILE_CORDIS__?.openHub?.(tab);
  }

  function onTaskEvent(evt) {
    try {
      if (globalThis.localStorage?.getItem('dml.pref.taskAlerts') === 'false') return;
    } catch {}
    if (!evt) return;
    if (evt.kind === 'completed') {
      haptic('success');
      showToast('任务已完成：' + (evt.title || '会话'));
    } else if (evt.kind === 'approval') {
      haptic('warning');
    }
  }
  function openSession(sessionId) {
    revealRoot();
    if (!sessionId || typeof sessionId !== 'string') return false;
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (typeof cordis?.openSession === 'function') {
      if (cordis.openSession(sessionId) === false) return false;
      setTimeout(scheduleReportUi, 100);
      return true;
    }
    return false;
  }

  function newSession() {
    revealRoot();
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (typeof cordis?.newSession === 'function') {
      if (cordis.newSession() === false) return false;
      setTimeout(scheduleReportUi, 100);
      return true;
    }
    const btn = document.querySelector('[data-sidebar-new-session], button[aria-label*="新会话"], button[aria-label*="New"]');
    if (typeof HTMLElement === 'function' && btn instanceof HTMLElement) {
      btn.click();
      setTimeout(scheduleReportUi, 100);
      return true;
    }
    return false;
  }

  let reconnectUntil = 0;
  function reconnect(force = false) {
    // Reaffirm a genuinely open, subscribed mux instead of tearing it down unless forced
    // (e.g. server confirmed wsAlive === false on a half-open cellular NAT socket).
    if (!force && wsState === 'connected' && latestMux?.readyState === 1) {
      post({ type: 'ws', state: 'connected' });
      return true;
    }
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (typeof cordis?.reconnect === 'function') {
      if (Date.now() < reconnectUntil) return true;
      reconnectUntil = Date.now() + 1500;
      if (cordis.reconnect() === false) { reconnectUntil = 0; return false; }
      return true;
    }
    return false;
  }

  let syncCursor = '', syncRequest = null, syncTimer, pendingPoke = false;
  let lastSyncReset = 0, activePoke = false;
  let lifecycle;
  function followFocus() {
    const id = desktopFocus?.sessionId;
    if (!id) { lastFollowedId = null; return; }
    if (document.hidden || document.documentElement.hasAttribute('data-dml-routing') || globalThis.__DSH_MOBILE_ROUTE_STATE__?.intent) {lastFollowedId=id;return;}
    if (!followDesktop || lastFollowedId === id) return;
    const cordis = globalThis.__DSH_MOBILE_CORDIS__;
    if (cordis?.getCurrentSessionId?.() === id || openSession(id)) lastFollowedId = id;
  }
  async function pollSync() {
    if (syncRequest || lifecycle?.isSuspended() || document.visibilityState === 'hidden') return;
    const controller = new AbortController();
    syncRequest = controller;
    const watchdog = setTimeout(() => controller.abort(), 27000);
    const shouldPoke = pendingPoke;
    activePoke = shouldPoke;
    pendingPoke = false;
    let delay = 1200;
    try {
      const qs = [];
      if (syncCursor) qs.push('since=' + encodeURIComponent(syncCursor));
      if (shouldPoke) qs.push('poke=1');
      const url = '/mobile/v1/sync' + (qs.length ? '?' + qs.join('&') : '');
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (syncRequest !== controller) return;
      if (res.status === 401) { delay = -1; post({ type: 'auth-expired' }); return; }
      if (!res.ok) return;
      const data = await res.json();
      if (syncRequest !== controller) return;
      // Instant half-open zombie socket detection: if the desktop has zero live mux sockets
      // for this device while our browser socket still claims OPEN, reconnect immediately.
      if (shouldPoke && data.wsAlive === false && latestMux?.readyState === 1) {
        reconnect(true);
      }
      const cursor = typeof data.cursor === 'string' ? data.cursor : '';
      delay = cursor ? 0 : 5000; // Older servers return an immediate snapshot only.
      if (cursor && cursor === syncCursor) return;
      syncCursor = cursor;
      shell.readOnly = !data.actions;
      shell.terminal = !!data.terminal;
      desktopFocus = data.desktopFocus || null;
      post({ type: 'sync', actions: !!data.actions, terminal: !!data.terminal,
        upstream: data.upstream !== false, desktopFocus });
      followFocus();
    } catch {} finally {
      clearTimeout(watchdog);
      if (syncRequest === controller) {
        syncRequest = null;
        if (delay >= 0 && document.visibilityState !== 'hidden') syncTimer = setTimeout(pollSync, delay);
      }
    }
  }
  function resetSync(poke = false) {
    if (lifecycle?.isSuspended() || document.visibilityState === 'hidden') return;
    // pageshow, visibilitychange, network and native wake events can arrive
    // together. Keep the already-running probe instead of cancelling it.
    if (syncRequest && Date.now() - lastSyncReset < 500 && (!poke || activePoke)) return;
    lastSyncReset = Date.now();
    clearTimeout(syncTimer);
    syncRequest?.abort(); syncRequest = null; syncCursor = '';
    if (poke) pendingPoke = true;
    void pollSync();
  }
  function wakeForeground() {
    // Cancel any exponential WebSocket backoff immediately when returning to foreground.
    if (wsState !== 'connected' || (latestMux && latestMux.readyState >= 2)) {
      reconnect(true);
    }
    resetSync(true);
    syncViewport();
    reportTheme();
    scheduleReportUi();
  }

  function wakeCheck() {
    if (lifecycle?.isSuspended() || document.visibilityState === 'hidden') return;
    if (wsState !== 'connected' || (latestMux && latestMux.readyState >= 2)) {
      reconnect(true);
    }
    resetSync(true);
    syncViewport();
    reportTheme();
    scheduleReportUi();
  }

  globalThis.__DSH_MOBILE_BRIDGE__ = {
    toggleSidebar,
    toggleRightPanel,
    openSession,
    newSession,
    insertDraft,
    openHub,
    scrollToTop,
    scrollToBottom,
    listConversationTurns,
    scrollToTurn,
    toggleComposerExpand,
    setComposerFull,
    captureVisualSnapshot,
    snapshotStatus: () => snapshotStatus,
    scheduleVisualSnapshot,
    onLaunchHydrated,
    reconnect,
    wakeCheck,
    setKeyboard,
    applyDisplayPrefs,
    onTaskEvent,
    groupMobileTasks: ${groupMobileTasks.toString()},
    credentialsChanged() { resetSync(); reconnectUntil = 0; if(wsState !== 'connected') reconnect(); },
    reportUi: scheduleReportUi,
    reportSelection: scheduleReportUi,
    setLogicalConnection(state) { wsState = state; if(state === 'connected') reconnectUntil = 0; },
    repositionPopups: repositionAllPopups,
    refreshCommandMenu: scheduleOverlayHeight,
    followFocus,
    setFollowDesktop(enabled) {
      followDesktop = !!enabled;
      lastFollowedId = null;
      followFocus();
      return followDesktop;
    },
    showToast,
    snapshot() {
      return {
        wsState,
        drawerOpen: isDrawerOpen(),
        desktopFocus,
        currentSessionId: globalThis.__DSH_MOBILE_CORDIS__?.getCurrentSessionId?.() ?? null,
        readOnly: !!shell.readOnly,
        terminal: !!shell.terminal,
        activePopups: activePopups.size,
      };
    },
  };

  // Start lightweight observers once DOM is ready (no subtree:true on document.body!).
  const start = () => {
    applyDisplayPrefs();
    reportTheme();
    reportUi();
    syncViewport();
    scheduleOverlayHeight();
    installScrollBottom();
    installComposerEnhance();
    installLightbox();

    const attrObserver = new MutationObserver(() => {
      reportTheme();
      scheduleReportUi();
    });
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-dml-amoled'],
    });

    if (document.body) {
      // Only watch direct children of document.body (childList: true, subtree: false)
      // to catch portaled popups/menus with zero streaming-chat mutation overhead.
      const bodyPortalObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLElement && node.id !== 'root' && node.id !== 'dml-snap-curtain') {
              registerPopupNode(node);
            }
          }
          for (const node of m.removedNodes) {
            if (node instanceof HTMLElement) {
              activePopups.delete(node);
              popupResizeObserver?.unobserve(node);
            }
          }
        }
        syncPopupOpenAttr();
      });
      bodyPortalObserver.observe(document.body, { childList: true, subtree: false });
      for (const child of document.body.children) {
        if (child instanceof HTMLElement && child.id !== 'root' && child.id !== 'dml-snap-curtain') {
          registerPopupNode(child);
        }
      }
    }

    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(scheduleReportUi).observe(titleEl, { childList: true });

    // Lazily attach drawer observer once React mounts [data-sidebar-drawer].
    if (!ensureDrawerObserver() && document.getElementById('root')) {
      const bootObserver = new MutationObserver(() => {
        scheduleViewport();
        ensureComposerExpandButton();
        if (ensureDrawerObserver()) {
          bootObserver.disconnect();
          scheduleReportUi();
        }
      });
      bootObserver.observe(document.getElementById('root'), { childList: true, subtree: true });
      setTimeout(() => bootObserver.disconnect(), 8000);
    }

    lifecycle = (${createWebRemoteControlLifecycleRecovery.toString()})({
      documentTarget: document, windowTarget: globalThis,
      onSuspend() {
        captureVisualSnapshot(true);
        clearTimeout(syncTimer);
        lastSyncReset = 0;
        const request = syncRequest;
        syncRequest = null;
        request?.abort();
      },
      onRecover: wakeForeground,
    });
    void pollSync();
    post({ type: 'ready', version: shell.version || '' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
`;
