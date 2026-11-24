import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopWeather } from '../lib/desktop-weather.mjs';
import { installWeather, weatherScene, WEATHER_CSS } from '../lib/mobile-weather.mjs';

const now = 1_800_000_000_000;
test('clock requests never acquire location; a denied desktop fix never contacts a provider', async () => {
  let attempts = 0;
  const weather = createDesktopWeather({ now: () => now, locate: () => { attempts++; throw Error('denied'); }, fetchWeather: assert.fail });
  assert.equal((await weather('clock')).now, now);
  assert.equal(attempts, 0);
  assert.equal((await weather('weather')).status, 'location-unavailable');
  assert.ok((await weather('weather')).zone);
  assert.equal(attempts, 1);
});

test('paired devices share the fix and fetch; coordinates are rounded and never returned to a phone', async () => {
  let clock = now, fixes = 0, fetches = 0;
  const weather = createDesktopWeather({ now: () => clock, locate: () => {
    fixes++; return { latitude: 35.67624, longitude: 139.65032 };
  }, fetchWeather: async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('latitude'), '35.68'); assert.equal(query.get('longitude'), '139.65');
    fetches++;
    return Response.json({current: {time: now / 1000, weather_code: 95, is_day: 0, temperature_2m: 17}});
  }});
  const [a,b] = await Promise.all([weather('weather'), weather('weather')]);
  assert.deepEqual(a,b); assert.equal(a.status,'ok'); assert.equal(a.day,false);
  assert.deepEqual(Object.keys(a).sort(), ['code','day','now','status','temp','time','zone']);
  assert.equal(fixes,1); assert.equal(fetches,1);
  clock += 31 * 60_000;
  assert.equal((await weather('weather')).status, 'weather-unavailable');
  assert.equal(fixes,2);
});

test('known WMO groups have distinct scenes, including night and hazardous precipitation', () => {
  for (const [code,scene] of [[0,'sun'],[2,'partly'],[3,'cloud'],[45,'fog'],[53,'drizzle'],[67,'ice'],[82,'rain'],[86,'snow'],[95,'storm'],[99,'hail']]) {
    assert.equal(weatherScene(code,true),scene);
  }
  assert.equal(weatherScene(0,false),'moon'); assert.equal(weatherScene(2,false),'partlyNight');
  assert.equal(weatherScene(999,false),null);
});

test('weather widget renders multi-layer gradient SVGs, temperature slot, and reduced-motion rules', () => {
  assert.match(WEATHER_CSS, /#dml-weather\[data-has-temp="true"\]/);
  assert.match(WEATHER_CSS, /header:has\(nav\)\s+#dml-weather\s+\.dml-w-temp\s*\{\s*display:\s*none\s*!important/);
  assert.match(WEATHER_CSS, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none\s*!important/);
  assert.match(installWeather.toString(), /dmlw-sun-aura/);
  assert.match(installWeather.toString(), /dmlw-bolt/);
});
