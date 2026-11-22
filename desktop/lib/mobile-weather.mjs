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
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'dml-weather';
  const panel = document.createElement('dialog');
  panel.id = 'dml-weather-info'; panel.setAttribute('aria-label', '时间与当地天气');
  panel.innerHTML = '<strong></strong><p></p><small>天气数据：Open-Meteo。使用配对电脑的位置；手机不参与定位。</small><footer><button type="button" data-mode></button><button type="button" data-close>关闭</button></footer>';
  const names = {dawn:'清晨', morning:'上午', noon:'中午', afternoon:'下午', dusk:'傍晚', night:'夜间', sun:'晴', moon:'晴夜', partly:'局部多云', partlyNight:'夜间局部多云', cloud:'阴', fog:'雾', drizzle:'毛毛雨', ice:'冻雨', rain:'雨', snow:'雪', storm:'雷暴', hail:'雷暴伴冰雹'};
  const sun = '<g class="orbit" stroke="#e6a237"><circle cx="16" cy="16" r="5" fill="#ffd674"/><path d="M16 3v3m0 20v3M3 16h3m20 0h3M7 7l2 2m14 14 2 2M7 25l2-2M23 9l2-2"/></g>';
  const moon = '<path class="float" d="M22 22A11 11 0 0 1 12 6a10 10 0 1 0 10 16Z" fill="#bbbcfb" stroke="#9299d8"/><path class="shine" d="m23 5 .8 2.2L26 8l-2.2.8L23 11l-.8-2.2L20 8l2.2-.8Z" fill="#edc570" stroke="none"/>';
  const cloud = '<path class="float" d="M7 21a4 4 0 0 1-.5-8 6 6 0 0 1 11.6-1.7 4.3 4.3 0 0 1 6.7 3.6 3.2 3.2 0 0 1-.7 6Z" fill="#b9c8d8" stroke="#8198ad"/>';
  function icon(s) {
    let art;
    if (['night','moon'].includes(s)) art=moon;
    else if (s==='dawn' || s==='dusk') {
      const color=s==='dawn'?'#f3b874':'#e18e89';
      art='<g class="'+(s==='dawn'?'rise':'set')+'" stroke="'+color+'" fill="'+color+'"><path d="M23 21a7 7 0 0 0-14 0Z"/><path d="M16 10V7m-9 8-2-2m20 2 2-2"/></g><path d="M3 23h26m-20 4h14" stroke="#ba9b89"/>';
    }
    else if (s==='morning' || s==='afternoon') {
      art='<g transform="translate('+(s==='morning'?'0 1':'7 2')+') scale(.78)">'+sun+'</g><path class="float" d="M6 26q3-3 6 0t6 0t6 0" stroke="#b1c5cb"/>';
    }
    else if (s==='sun' || s==='noon') art=sun;
    else {
      const behind = s === 'partly' ? sun : s === 'partlyNight' ? moon : '';
      art = '<g transform="translate(9 -1) scale(.7)">'+behind+'</g>'+cloud;
      if (s === 'fog') art += '<path class="float" d="M3 24h18m-12 4h17" stroke="#99aebb"/>';
      if (['drizzle','rain','ice'].includes(s)) art += '<path class="fall" d="m10 22-2 4m9-4-2 4m9-4-2 4" stroke="'+(s==='ice'?'#8ec8df':'#5aaad8')+'" stroke-dasharray="'+(s==='drizzle'?'1 2':'4 1')+'"/>';
      if (s==='snow' || s==='hail') art += '<g class="fall" fill="#98cddd" stroke="none"><circle cx="9" cy="24" r="1.6"/><circle cx="16" cy="26" r="1.6"/><circle cx="23" cy="23" r="1.6"/></g>';
      if (s==='storm' || s==='hail') art += '<path class="shine" d="m18 17-6 8h4l-2 6 8-10h-5l3-4Z" fill="#efb847" stroke="none"/>';
    }
    return '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke-width="1.6" stroke-linecap="round">'+art+'</svg>';
  }
  let enabled = true, reading = null, error = '', next = 0, timer = 0, generation = 0, busy = false;
  let zone = globalThis.__DSH_MOBILE_SHELL__?.desktopTimeZone, clockOffset = 0;
  try { enabled = localStorage.getItem('dml.weather.desktop.v1') !== 'false'; } catch {}
  function draw() {
    const now = Date.now() + clockOffset;
    const opts = { timeZone: zone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    const clock = new Intl.DateTimeFormat('en-GB', opts).format(now);
    const hour = Number(clock.slice(0, 2));
    const age = now - (reading?.time ?? 0) * 1000;
    const fresh = reading && age >= -120000 && age < 30 * 60000;
    const period = hour < 5 ? 'night' : hour < 7 ? 'dawn' : hour < 11 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : hour < 20 ? 'dusk' : 'night';
    const scene = fresh ? sceneFor(reading.code, reading.day) : period;
    if (btn.dataset.scene !== scene) { btn.dataset.scene = scene; btn.innerHTML = icon(scene); }
    const title = (fresh ? names[scene] + ' · ' + Math.round(reading.temp) + '°C' : names[scene]) + ' · ' + clock;
    btn.title = title; btn.setAttribute('aria-label', title + '，电脑时间与天气');
    panel.querySelector('strong').textContent = title;
    panel.querySelector('p').textContent = fresh ? '电脑所在地 · 天气时刻 ' + new Intl.DateTimeFormat('en-GB', opts).format(reading.time * 1000)
      : error || (busy && enabled ? '正在查询电脑所在地天气…' : '按配对电脑时间显示');
    panel.querySelector('[data-mode]').textContent = enabled ? '仅显示电脑时间' : '显示电脑所在地天气';
  }
  async function refresh() {
    if (busy || document.hidden || !btn.isConnected || Date.now() < next) return;
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
    if (document.hidden || !btn.isConnected) return;
    draw(); void refresh(); timer = setTimeout(tick, 60000 - (Date.now() + clockOffset) % 60000 + 20);
  }
  panel.querySelector('[data-mode]').onclick = () => {
    enabled = !enabled;
    try { localStorage.setItem('dml.weather.desktop.v1', String(enabled)); } catch {}
    ++generation; busy = false; next = 0; reading = null; error = ''; tick();
  };
  panel.querySelector('[data-close]').onclick=()=>panel.close();
  btn.onclick=()=>{if(!panel.isConnected)document.body.append(panel);draw();panel.showModal();};
  document.addEventListener('visibilitychange',()=>{++generation;busy=false;reading=null;next=0;tick();});
  return {mount(){const seat=document.querySelector('#root [data-conversation-header-leading]'); if(seat && btn.parentElement!==seat){seat.append(btn);tick();}}};
}

export const WEATHER_CSS = `
#dml-weather {display:grid;place-items:center;width:30px;height:32px;flex:none;padding:0;border:0;border-radius:8px;background:none;cursor:pointer;}
#dml-weather svg {width:27px;height:27px;overflow:visible;}
#dml-weather .orbit {transform-origin:16px 16px;animation:dml-orbit 20s linear infinite;}
#dml-weather .float {animation:dml-drift 3.2s ease-in-out infinite alternate;}
#dml-weather .rise, #dml-weather .set {animation:dml-horizon 3s ease-in-out infinite alternate;} #dml-weather .set {animation-direction:alternate-reverse;}
@keyframes dml-horizon {to{transform:translateY(-2px)}}
#dml-weather .fall {animation:dml-fall 1.35s ease-in infinite;}
#dml-weather .shine {animation:dml-shine 2.8s ease-in-out infinite alternate;}
@keyframes dml-orbit {to{transform:rotate(360deg)}} @keyframes dml-drift {to{transform:translate(1.6px,-1px)}}
@keyframes dml-fall {from{opacity:.25;transform:translateY(-1px)}to{opacity:.9;transform:translateY(2px)}} @keyframes dml-shine {to{opacity:.23}}
@media(prefers-reduced-motion:reduce){#dml-weather svg *{animation:none!important}}
#dml-weather-info {border:1px solid var(--dsw-alias-border-secondary,#8885);border-radius:16px;padding:18px;max-width:min(82vw,320px);background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);}
#dml-weather-info::backdrop {background:#0005;} #dml-weather-info small {display:block;opacity:.72;} #dml-weather-info footer {display:flex;justify-content:flex-end;gap:12px;margin-top:16px;} #dml-weather-info button {font:inherit;color:inherit;border:0;border-radius:8px;padding:8px;background:var(--dsw-alias-interactive-bg-hover,#8882);}
`;
