// Conversation header chip. Location is resolved only by the paired desktop.
export function weatherScene(code, day) {
  if (code === 0 || code === 1) return day ? 'sun' : 'moon';
  if (code === 2) return day ? 'partly' : 'partlyNight';
  if (code === 3) return 'cloud';
  if ([45,48].includes(code)) return 'fog';
  if ([51,53,55].includes(code)) return 'drizzle';
  if ([56,57,66,67].includes(code)) return 'ice';
  if ([61,63,65,80,81,82].includes(code)) return 'rain';
  if ([71,73,75,77,85,86].includes(code)) return 'snow';
  if (code === 95) return 'storm';
  if ([96,99].includes(code)) return 'hail';
  return null;
}

export function installWeather(sceneFor) {
  const indicator = document.createElement('span');
  indicator.id = 'dml-weather';
  indicator.setAttribute('role', 'img');
  const names = {dawn:'清晨', morning:'上午', noon:'中午', afternoon:'下午', dusk:'傍晚', night:'夜间', sun:'晴', moon:'晴夜', partly:'局部多云', partlyNight:'夜间局部多云', cloud:'阴', fog:'雾', drizzle:'毛毛雨', ice:'冻雨', rain:'雨', snow:'雪', storm:'雷暴', hail:'雷暴伴冰雹'};
  const defs = '<defs>' +
    '<radialGradient id="dmlw-sun-aura" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffd54f" stop-opacity="0.55"/><stop offset="65%" stop-color="#ffb300" stop-opacity="0.16"/><stop offset="100%" stop-color="#ffb300" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="dmlw-sun" cx="38%" cy="35%" r="65%"><stop offset="0%" stop-color="#fff4b8"/><stop offset="55%" stop-color="#ffca45"/><stop offset="100%" stop-color="#ef9216"/></radialGradient>' +
    '<linearGradient id="dmlw-moon" x1="20%" y1="10%" x2="85%" y2="90%"><stop offset="0%" stop-color="#eef0ff"/><stop offset="55%" stop-color="#b8bdf8"/><stop offset="100%" stop-color="#848ce0"/></linearGradient>' +
    '<linearGradient id="dmlw-cloud-a" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#e9f1f9"/><stop offset="100%" stop-color="#b4c6da"/></linearGradient>' +
    '<linearGradient id="dmlw-cloud-b" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#cddbeb"/><stop offset="100%" stop-color="#8ea4bc"/></linearGradient>' +
    '<linearGradient id="dmlw-cloud-storm" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#9fb0c4"/><stop offset="100%" stop-color="#5d7087"/></linearGradient>' +
    '<linearGradient id="dmlw-bolt" x1="30%" y1="0%" x2="70%" y2="100%"><stop offset="0%" stop-color="#fff3a1"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient>' +
    '<linearGradient id="dmlw-dawn" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#fde08d"/><stop offset="100%" stop-color="#f59e42"/></linearGradient>' +
    '<linearGradient id="dmlw-dusk" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#fdbb74"/><stop offset="100%" stop-color="#e0676f"/></linearGradient>' +
  '</defs>';
  const sunCore = '<circle class="w-aura" cx="16" cy="16" r="13.5" fill="url(#dmlw-sun-aura)" stroke="none"/>' +
    '<g class="w-spin" stroke="#f0a629" stroke-width="1.65"><path d="M16 3.2v2.4M16 26.4v2.4M3.2 16h2.4M26.4 16h2.4M7 7l1.7 1.7M23.3 23.3L25 25M7 25l1.7-1.7M23.3 8.7L25 7"/></g>' +
    '<circle class="w-core" cx="16" cy="16" r="5.6" fill="url(#dmlw-sun)" stroke="#e5951a" stroke-width="0.9"/>';
  const moonArt = '<circle class="w-aura" cx="15" cy="17" r="12.5" fill="#9ca3ff" fill-opacity="0.16" stroke="none"/>' +
    '<path class="w-float" d="M21.8 21.8A10.4 10.4 0 0 1 12.2 6.6a9.6 9.6 0 1 0 9.6 15.2Z" fill="url(#dmlw-moon)" stroke="#8890dc" stroke-width="0.9"/>' +
    '<path class="w-twinkle-1" d="m23.4 4.8.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" fill="#ffd978" stroke="none"/>' +
    '<circle class="w-twinkle-2" cx="26.5" cy="14" r="1.15" fill="#d9ddff" stroke="none"/>' +
    '<circle class="w-twinkle-3" cx="8.2" cy="7.5" r="0.95" fill="#ffe699" stroke="none"/>';
  const cloudBack = '<path class="w-drift-back" d="M12.5 18.5a3.2 3.2 0 0 1-.4-6.3 4.6 4.6 0 0 1 8.9-1.2 3.4 3.4 0 0 1 5.1 2.8 2.6 2.6 0 0 1-.6 4.7Z" fill="url(#dmlw-cloud-b)" stroke="#7d94ab" stroke-width="0.7" opacity="0.82"/>';
  const cloudFront = '<path class="w-drift-front" d="M6.8 21.4a3.9 3.9 0 0 1-.5-7.7 5.7 5.7 0 0 1 11-1.6 4.1 4.1 0 0 1 6.4 3.4 3.1 3.1 0 0 1-.7 5.9Z" fill="url(#dmlw-cloud-a)" stroke="#8ca4bc" stroke-width="0.9"/>';
  const cloudStorm = '<path class="w-drift-front" d="M6.8 20.6a3.9 3.9 0 0 1-.5-7.7 5.7 5.7 0 0 1 11-1.6 4.1 4.1 0 0 1 6.4 3.4 3.1 3.1 0 0 1-.7 5.9Z" fill="url(#dmlw-cloud-storm)" stroke="#52647a" stroke-width="0.9"/>';
  function icon(s) {
    let art = '';
    if (['night','moon'].includes(s)) art = moonArt;
    else if (s === 'dawn' || s === 'dusk') {
      const grad = s === 'dawn' ? 'url(#dmlw-dawn)' : 'url(#dmlw-dusk)';
      const stroke = s === 'dawn' ? '#eb9338' : '#d65e69';
      art = '<ellipse class="w-aura" cx="16" cy="21" rx="12" ry="6" fill="' + stroke + '" fill-opacity="0.24" stroke="none"/>' +
        '<g class="' + (s === 'dawn' ? 'w-rise' : 'w-set') + '" stroke="' + stroke + '" fill="' + grad + '"><path d="M23.2 21.5a7.2 7.2 0 0 0-14.4 0Z" stroke-width="1"/><path d="M16 10.5V7.5M8.2 14.5l-2-1.8M23.8 14.5l2-1.8" stroke-width="1.6"/></g>' +
        '<path class="w-horizon" d="M3.5 22.8h25" stroke="' + stroke + '" stroke-width="1.6" stroke-opacity="0.85"/><path d="M8.5 26.2h15" stroke="' + stroke + '" stroke-width="1.4" stroke-opacity="0.45"/>';
    } else if (s === 'morning' || s === 'afternoon') {
      art = '<g transform="translate(' + (s === 'morning' ? '-1 -1' : '3 0') + ') scale(.84)">' + sunCore + '</g>' +
        '<path class="w-drift-front" d="M9.5 25a2.6 2.6 0 0 1-.3-5.1 3.9 3.9 0 0 1 7.4-1.1 2.9 2.9 0 0 1 4.4 2.4 2.2 2.2 0 0 1-.5 3.8Z" fill="url(#dmlw-cloud-a)" fill-opacity="0.88" stroke="#90a9c1" stroke-width="0.8"/>';
    } else if (s === 'sun' || s === 'noon') {
      art = sunCore;
    } else {
      const behind = s === 'partly' ? '<g transform="translate(8.5 -1.5) scale(.68)">' + sunCore + '</g>'
        : s === 'partlyNight' ? '<g transform="translate(9 -1.5) scale(.68)">' + moonArt + '</g>' : '';
      const hasStorm = s === 'storm' || s === 'hail';
      const hasRain = ['drizzle','rain','ice','storm'].includes(s);
      art = behind + (hasStorm ? cloudStorm : cloudBack + cloudFront);
      if (hasStorm) art += '<ellipse class="w-storm-glow" cx="15" cy="18" rx="8" ry="3.2" fill="#ffe082" fill-opacity="0.28" stroke="none"/>';
      if (s === 'fog') {
        art += '<path class="w-fog-1" d="M4.5 24h16" stroke="#8ea7b8" stroke-width="1.8"/><path class="w-fog-2" d="M10.5 27.2h17" stroke="#9eb6c7" stroke-width="1.8"/>';
      }
      if (hasRain) {
        const rainStroke = s === 'ice' ? '#7dd3fc' : '#4ea8de';
        const dash = s === 'drizzle' ? '1.2 2.2' : '4 1.6';
        art += '<path class="w-rain-1" d="m9.6 22.8-1.8 4.4" stroke="' + rainStroke + '" stroke-width="1.7" stroke-dasharray="' + dash + '"/>' +
          '<path class="w-rain-2" d="m15.6 23.2-1.8 4.6" stroke="' + rainStroke + '" stroke-width="1.7" stroke-dasharray="' + dash + '"/>' +
          '<path class="w-rain-3" d="m21.6 22.4-1.8 4.4" stroke="' + rainStroke + '" stroke-width="1.7" stroke-dasharray="' + dash + '"/>';
      }
      if (s === 'snow' || s === 'hail') {
        const snowFill = s === 'hail' ? '#bae6fd' : '#e0f2fe';
        const snowStroke = s === 'hail' ? '#38bdf8' : '#7dd3fc';
        art += '<circle class="w-snow-1" cx="9.2" cy="24.2" r="1.5" fill="' + snowFill + '" stroke="' + snowStroke + '" stroke-width="0.7"/>' +
          '<circle class="w-snow-2" cx="15.5" cy="25.6" r="1.7" fill="' + snowFill + '" stroke="' + snowStroke + '" stroke-width="0.7"/>' +
          '<circle class="w-snow-3" cx="21.5" cy="23.8" r="1.4" fill="' + snowFill + '" stroke="' + snowStroke + '" stroke-width="0.7"/>';
      }
      if (hasStorm) {
        art += '<path class="w-flash" d="m17.5 16.5-5.2 7.2h3.6l-1.8 5.4 6.8-8.2h-4.1l2.5-4.4Z" fill="url(#dmlw-bolt)" stroke="#d97706" stroke-width="0.5"/>';
      }
    }
    return '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + defs + art + '</svg>';
  }
  const iconSlot = document.createElement('span');
  iconSlot.className = 'dml-w-icon';
  iconSlot.setAttribute('aria-hidden', 'true');
  const tempSlot = document.createElement('span');
  tempSlot.className = 'dml-w-temp';
  tempSlot.setAttribute('aria-hidden', 'true');
  indicator.append(iconSlot, tempSlot);

  let enabled = true, reading = null, error = '', next = 0, timer = 0, generation = 0, busy = false, tapTimer = 0;
  let zone = globalThis.__DSH_MOBILE_SHELL__?.desktopTimeZone, clockOffset = 0;
  try { enabled = localStorage.getItem('dml.weather.desktop.v1') !== 'false'; } catch {}
  indicator.addEventListener('pointerdown', () => {
    clearTimeout(tapTimer);
    indicator.removeAttribute('data-tapped');
    void indicator.offsetWidth;
    indicator.setAttribute('data-tapped', 'true');
    tapTimer = setTimeout(() => indicator.removeAttribute('data-tapped'), 320);
  }, { passive: true });
  function draw() {
    const now = Date.now() + clockOffset;
    const opts = { timeZone: zone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    const clock = new Intl.DateTimeFormat('en-GB', opts).format(now);
    const hour = Number(clock.slice(0, 2));
    const age = now - (reading?.time ?? 0) * 1000;
    const fresh = reading && age >= -120000 && age < 30 * 60000;
    const period = hour < 5 ? 'night' : hour < 7 ? 'dawn' : hour < 11 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : hour < 20 ? 'dusk' : 'night';
    const scene = fresh ? sceneFor(reading.code, reading.day) : period;
    if (indicator.dataset.scene !== scene) {
      const hadScene = !!indicator.dataset.scene;
      indicator.dataset.scene = scene;
      iconSlot.innerHTML = icon(scene);
      if (hadScene) {
        indicator.setAttribute('data-swap', 'true');
        setTimeout(() => indicator.removeAttribute('data-swap'), 320);
      }
    }
    const tempText = fresh ? Math.round(reading.temp) + '°' : '';
    if (tempSlot.textContent !== tempText) tempSlot.textContent = tempText;
    if (tempText) indicator.setAttribute('data-has-temp', 'true');
    else indicator.removeAttribute('data-has-temp');
    const title = (fresh ? names[scene] + ' · ' + Math.round(reading.temp) + '°C' : names[scene]) + ' · ' + clock;
    const detail = fresh ? '电脑所在地天气，Open-Meteo' : error || '按配对电脑时间显示';
    indicator.setAttribute('aria-label', title + '，' + detail);
  }
  async function refresh() {
    if (busy || document.hidden || !indicator.isConnected || Date.now() < next) return;
    const run = ++generation;
    busy = true; error = ''; draw();
    try {
      const response = await fetch('/mobile/v1/weather', { method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: enabled ? 'weather' : 'clock'}), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error();
      const data = await response.json();
      if (run !== generation) return;
      if (!Number.isFinite(data.now) || !data.zone) throw Error();
      new Intl.DateTimeFormat('en-GB', {timeZone: data.zone});
      zone = data.zone; clockOffset = data.now - Date.now();
      const age = data.now - data.time * 1000;
      if (enabled && (data.status !== 'ok' || !sceneFor(data.code, data.day) || !Number.isFinite(data.temp) || !(age >= -120000 && age < 30 * 60000))) {
        error = data.status === 'location-unavailable' ? '电脑未提供位置，仅显示电脑时间' : '天气暂不可用，仅显示电脑时间';
        throw Error();
      }
      reading = enabled ? data : null; next = Date.now() + 15 * 60000;
    } catch {
      if (run !== generation) return;
      reading = null;
      error ||= enabled ? '天气暂不可用，仅显示电脑时间' : '按配对电脑时区显示';
      next = Date.now() + 5 * 60000;
    } finally { if (run === generation) { busy = false; draw(); } }
  }
  function tick() {
    clearTimeout(timer);
    if (document.hidden || !indicator.isConnected) return;
    draw(); void refresh(); timer = setTimeout(tick, 60000 - (Date.now() + clockOffset) % 60000 + 20);
  }
  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    ++generation; busy = false; next = 0; reading = null; error = ''; tick();
  }
  document.addEventListener('visibilitychange',()=>{++generation;busy=false;reading=null;next=0;tick();});
  return {setEnabled, mount(){const seat=document.querySelector('#root [data-conversation-header-leading]'); if(seat && indicator.parentElement!==seat){seat.append(indicator);tick();}}};
}

export const WEATHER_CSS = `
#dml-weather {
  display:inline-flex; align-items:center; justify-content:center; gap:4px;
  min-width:32px; height:32px; flex:none; padding:0 4px; box-sizing:border-box;
  border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 138, 0.16));
  background:linear-gradient(145deg, rgba(128, 148, 180, 0.12), rgba(128, 148, 180, 0.04));
  box-shadow:inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 1px 4px rgba(0, 0, 0, 0.04);
  cursor:default; user-select:none; -webkit-user-select:none;
  transition: transform 220ms cubic-bezier(0.22, 1.12, 0.36, 1), background 300ms ease, border-color 300ms ease;
}
#dml-weather[data-has-temp="true"] { padding:0 8px 0 5px; border-radius:999px; }
#dml-weather .dml-w-icon { display:inline-grid; place-items:center; width:24px; height:24px; flex:none; }
#dml-weather .dml-w-temp {
  font-size:12px; font-weight:650; line-height:1; letter-spacing:-0.02em;
  font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary, inherit);
}
#dml-weather .dml-w-temp:empty { display:none; }
/* Preserve exact 32px leading slot alignment in conversation view so breadcrumb text lines up with the native header. */
header:has(nav) #dml-weather { width:32px; min-width:32px; padding:0; border-radius:9px; }
header:has(nav) #dml-weather .dml-w-temp { display:none !important; }

#dml-weather:is([data-scene="sun"], [data-scene="noon"], [data-scene="morning"], [data-scene="afternoon"]) {
  background:linear-gradient(145deg, rgba(255, 198, 72, 0.22), rgba(255, 152, 48, 0.08));
  border-color:rgba(245, 166, 35, 0.28);
}
#dml-weather:is([data-scene="dawn"], [data-scene="dusk"]) {
  background:linear-gradient(145deg, rgba(244, 134, 108, 0.22), rgba(251, 188, 102, 0.09));
  border-color:rgba(240, 130, 102, 0.28);
}
#dml-weather:is([data-scene="moon"], [data-scene="night"], [data-scene="partlyNight"]) {
  background:linear-gradient(145deg, rgba(124, 134, 240, 0.20), rgba(78, 86, 168, 0.08));
  border-color:rgba(138, 148, 242, 0.28);
}
#dml-weather:is([data-scene="rain"], [data-scene="drizzle"], [data-scene="ice"], [data-scene="snow"]) {
  background:linear-gradient(145deg, rgba(78, 168, 222, 0.20), rgba(56, 128, 184, 0.07));
  border-color:rgba(86, 174, 230, 0.28);
}
#dml-weather:is([data-scene="storm"], [data-scene="hail"]) {
  background:linear-gradient(145deg, rgba(112, 126, 162, 0.24), rgba(245, 158, 11, 0.12));
  border-color:rgba(148, 163, 196, 0.30);
}
#dml-weather[data-swap="true"] .dml-w-icon { animation: dmlw-swap 300ms cubic-bezier(0.22, 1.12, 0.36, 1); }
#dml-weather[data-tapped="true"] { transform: scale(0.92); }
#dml-weather svg { width:24px; height:24px; overflow:visible; }

#dml-weather .w-spin { transform-origin:16px 16px; animation: dmlw-spin 24s linear infinite; }
#dml-weather .w-aura { transform-origin:16px 16px; animation: dmlw-aura 3.6s ease-in-out infinite alternate; }
#dml-weather .w-float { animation: dmlw-float 3.4s ease-in-out infinite alternate; }
#dml-weather .w-drift-front { animation: dmlw-drift-a 3.8s ease-in-out infinite alternate; }
#dml-weather .w-drift-back { animation: dmlw-drift-b 4.4s ease-in-out infinite alternate; }
#dml-weather .w-rise, #dml-weather .w-set { animation: dmlw-horizon 3.2s ease-in-out infinite alternate; }
#dml-weather .w-set { animation-direction: alternate-reverse; }
#dml-weather .w-horizon { animation: dmlw-aura 2.8s ease-in-out infinite alternate; }
#dml-weather .w-twinkle-1 { transform-origin:23.4px 7.5px; animation: dmlw-twinkle 2.4s ease-in-out infinite alternate; }
#dml-weather .w-twinkle-2 { animation: dmlw-twinkle 2.9s ease-in-out 0.6s infinite alternate; }
#dml-weather .w-twinkle-3 { animation: dmlw-twinkle 3.2s ease-in-out 1.2s infinite alternate; }
#dml-weather .w-fog-1 { animation: dmlw-fog 3.2s ease-in-out infinite alternate; }
#dml-weather .w-fog-2 { animation: dmlw-fog 3.6s ease-in-out 0.9s infinite alternate-reverse; }
#dml-weather .w-rain-1 { animation: dmlw-rain 1.1s linear infinite; }
#dml-weather .w-rain-2 { animation: dmlw-rain 1.1s linear 0.36s infinite; }
#dml-weather .w-rain-3 { animation: dmlw-rain 1.1s linear 0.72s infinite; }
#dml-weather .w-snow-1 { animation: dmlw-snow 2.2s ease-in-out infinite; }
#dml-weather .w-snow-2 { animation: dmlw-snow 2.4s ease-in-out 0.7s infinite; }
#dml-weather .w-snow-3 { animation: dmlw-snow 2.1s ease-in-out 1.3s infinite; }
#dml-weather .w-flash { animation: dmlw-flash 2.6s ease-in-out infinite; }
#dml-weather .w-storm-glow { animation: dmlw-flash 2.6s ease-in-out infinite; }

@keyframes dmlw-spin { to { transform: rotate(360deg); } }
@keyframes dmlw-aura { from { opacity: 0.72; transform: scale(0.95); } to { opacity: 1; transform: scale(1.06); } }
@keyframes dmlw-float { from { transform: translate3d(0, 0.5px, 0); } to { transform: translate3d(0, -1.6px, 0); } }
@keyframes dmlw-drift-a { from { transform: translate3d(-1px, 0, 0); } to { transform: translate3d(1.6px, -0.8px, 0); } }
@keyframes dmlw-drift-b { from { transform: translate3d(1.2px, 0, 0); } to { transform: translate3d(-1.2px, 0.6px, 0); } }
@keyframes dmlw-horizon { from { transform: translate3d(0, 1px, 0); } to { transform: translate3d(0, -1.8px, 0); } }
@keyframes dmlw-twinkle { from { opacity: 0.25; transform: scale(0.75); } to { opacity: 1; transform: scale(1.1); } }
@keyframes dmlw-fog { from { opacity: 0.45; transform: translate3d(-1.8px, 0, 0); } to { opacity: 0.95; transform: translate3d(1.8px, 0, 0); } }
@keyframes dmlw-rain { 0% { opacity: 0; transform: translate3d(1px, -2.5px, 0); } 25% { opacity: 0.95; } 100% { opacity: 0; transform: translate3d(-1.5px, 3.5px, 0); } }
@keyframes dmlw-snow { 0% { opacity: 0; transform: translate3d(-1px, -2.5px, 0); } 25% { opacity: 0.95; } 50% { transform: translate3d(1.5px, 1px, 0); } 100% { opacity: 0; transform: translate3d(-1px, 4.5px, 0); } }
@keyframes dmlw-flash { 0%, 62%, 74%, 100% { opacity: 0.35; } 66%, 78% { opacity: 1; } 70% { opacity: 0.2; } }
@keyframes dmlw-swap { 0% { opacity: 0.2; transform: scale(0.78) rotate(-8deg); } 100% { opacity: 1; transform: scale(1) rotate(0deg); } }
@media (prefers-reduced-motion: reduce) {
  #dml-weather, #dml-weather *, #dml-weather svg * { transition: none !important; animation: none !important; }
}
`;
