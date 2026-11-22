import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const minute = 60_000;
// Use the paired PC's Windows Location service. Never use network identity as a
// substitute for permission, or interpolate anything from a phone into this script.
const locateScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Device
$watch = [System.Device.Location.GeoCoordinateWatcher]::new()
try {
  if (!$watch.TryStart($false, [TimeSpan]::FromSeconds(5))) { return }
  $until = [DateTime]::UtcNow.AddSeconds(3)
  do {
    $point = $watch.Position
    if ($watch.Permission -eq 'Granted' -and !$point.Location.IsUnknown -and [Math]::Abs(([DateTimeOffset]::UtcNow - $point.Timestamp).TotalMinutes) -lt 30) {
      @{ latitude = [Math]::Round($point.Location.Latitude, 2); longitude = [Math]::Round($point.Location.Longitude, 2) } | ConvertTo-Json -Compress
      return
    }
    if ($watch.Permission -eq 'Denied' -or $watch.Status -eq 'Disabled') { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $until)
} finally { $watch.Stop(); $watch.Dispose() }`;

export async function locateDesktop() {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const exe = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', locateScript], {
    windowsHide: true, timeout: 10_000, maxBuffer: 4096,
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}

export function createDesktopWeather({ locate = locateDesktop, fetchWeather = fetch, now = Date.now } = {}) {
  let pending, cached, expiry = 0;
  async function read() {
    let position;
    try { position = await locate(); } catch { /* No usable OS location. */ }
    const { latitude, longitude } = position ?? {};
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      return { status: 'location-unavailable' };
    }
    const query = new URLSearchParams({ latitude: latitude.toFixed(2), longitude: longitude.toFixed(2),
      current: 'temperature_2m,is_day,weather_code', timeformat: 'unixtime', timezone: 'auto', forecast_days: '1' });
    try {
      const response = await fetchWeather('https://api.open-meteo.com/v1/forecast?' + query, { signal: AbortSignal.timeout(6500), redirect: 'error' });
      if (response.ok) {
        const { current: w } = await response.json();
        const age = now() - w?.time * 1000;
        if (Number.isFinite(age) && age >= -2 * minute && age < 30 * minute && Number.isFinite(w.temperature_2m) && Number.isInteger(w.weather_code) && [0,1].includes(w.is_day)) {
          return { status: 'ok', time: w.time, temp: w.temperature_2m, code: w.weather_code, day: w.is_day === 1 };
        }
      }
    } catch { /* Never log or return the provider URL; it contains coordinates. */ }
    return { status: 'weather-unavailable' };
  }
  return async function desktopWeather(mode) {
    let result = { status: 'clock' };
    if (mode !== 'clock') {
      if (!cached || now() >= expiry) {
        pending ??= read().then(value => {
          cached = value;
          expiry = value.status === 'ok' ? Math.min(now() + 15 * minute, value.time * 1000 + 30 * minute) : now() + 5 * minute;
        }).finally(() => { pending = undefined; });
        await pending;
      }
      result = cached;
    }
    return { ...result, now: now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  };
}
