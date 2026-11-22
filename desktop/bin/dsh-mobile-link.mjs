#!/usr/bin/env node
// Standalone phone link for a DSH web host on this computer (`dsh web`), for
// setups that do not install the plugin. Prints a pairing QR code; the phone
// pins this computer's key and then follows the host's sessions. --actions also enables phone actions.
//
//   dsh-mobile-link --launch "http://127.0.0.1:<port>/?token=…" [--port 3081] [--name 工作站]
//   DSH_LAUNCH_URL=… dsh-mobile-link
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { createLinkService } from '../lib/link-service.mjs';
import { exchangeLaunchURL, httpUpstream } from '../lib/upstream-http.mjs';
import { qrTerminal } from '../lib/pair-link.mjs';

const { values } = parseArgs({ options: {
  launch: { type: 'string' }, port: { type: 'string', default: '3081' }, host: { type: 'string' },
  actions: { type: 'boolean' }, terminal: { type: 'boolean' }, name: { type: 'string' }, state: { type: 'string' }, 'public-host': { type: 'string', multiple: true, default: [] },
  tunnel: { type: 'string', multiple: true, default: [] }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: dsh-mobile-link --launch <DSH launch URL> [--port 3081] [--host <bind address>] [--name <shown on the phone>] [--actions] [--terminal]\n'
    + '       [--public-host <extra address in the QR>]... [--tunnel <https URL of your own tunnel>]... [--state <dir>]');
  process.exit(0);
}

const stateDir = values.state || process.env.DSH_MOBILE_HOME || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'mobile-link');
let launch = values.launch || process.env.DSH_LAUNCH_URL;
if (!launch) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  launch = (await rl.question('粘贴 dsh web 的启动地址（含 ?token=）：')).trim();
  rl.close();
}
delete process.env.DSH_LAUNCH_URL;

const say = text => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
try {
  const auth = await exchangeLaunchURL(launch);
  const link = await createLinkService({
    stateDir, upstream: httpUpstream(auth), name: values.name, port: Number(values.port), host: values.host,
    enabled: true, actions: values.actions === true, terminal: values.terminal === true, extraHosts: values['public-host'], tunnels: values.tunnel,
    log: e => {
      if (e.type === 'paired') say(`已配对：${e.device.name}（${e.address}）`);
      else if (e.type === 'connected') say(`手机已连接：${e.device.name}`);
      else if (e.type === 'disconnected') say(`手机已断开：${e.device.name}`);
      else if (e.type === 'pair-rejected') say(`拒绝了一次配对（${e.reason}，来自 ${e.address}）`);
      else if (e.type === 'error') say(`出错：${e.where} ${e.message ?? ''}`);
    },
  });
  const first = await link.status();
  if (first.error) throw Object.assign(new Error(first.error.message ?? first.error.code), { code: first.error.code === 'port-in-use' ? 'EADDRINUSE' : undefined });

  let shownFor = '';
  const show = async () => {
    const s = await link.status();
    if (!s.pairing) { say('没有找到局域网地址。请连接网络，或用 --public-host 指定手机能访问的地址。'); return; }
    if (s.pairing.link === shownFor) return;
    shownFor = s.pairing.link;
    const minutes = Math.round((s.pairing.expiresAt - Date.now()) / 60000);
    console.log(`\n用 DSH Mobile 扫描下方二维码（${minutes} 分钟内有效，过期自动刷新）：\n`);
    console.log(await qrTerminal(s.pairing.link));
    console.log(`电脑：${s.desktop.name}    地址：${s.addresses.map(a => a.address).join('  ')}`);
    console.log(`安全码：${s.safetyCode}（手机首次连接时显示的安全码应与此一致）`);
    console.log(`扫不了码时，可在手机上粘贴：\n${s.pairing.link}\n`);
  };
  link.onChange(() => { show().catch(() => {}); });
  // An expired code is replaced on the next read; this keeps the printed one fresh.
  setInterval(() => { show().catch(() => {}); }, 5000).unref();
  await show();
  const paired = first.devices;
  if (paired.length) say(`已配对的手机：${paired.map(d => d.name).join('、')}（无需重新扫码）`);
  if (process.platform === 'win32') say('若 Windows 防火墙询问，请只允许「专用网络」。');
  const stop = async () => { await link.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(error?.code === 'EADDRINUSE' ? `端口 ${values.port} 已被占用，请用 --port 换一个。` : error?.message ?? String(error));
  process.exit(1);
}
