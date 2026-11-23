import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { open, realpath, lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { hash, validID } from './log.mjs';

const maxInput = 1024 * 1024;
const plainName = '([A-Za-z0-9_-]{1,64}\\.[A-Za-z0-9]{1,10})';
const hashPwsh = new RegExp(`^\\(Get-FileHash -LiteralPath 'relay-inputs/${plainName}' -Algorithm SHA256\\)\\.Hash$`, 'i');
const hashBash = new RegExp(`^sha256sum -- 'relay-inputs/${plainName}'$`);
const sizePwsh = new RegExp(`^\\(Get-Item -LiteralPath 'relay-inputs/${plainName}'\\)\\.Length$`, 'i');
const sizeBash = new RegExp(`^wc -c < 'relay-inputs/${plainName}'$`);
const remoteWorker = 'sudo -n -u dsh-cloud /usr/bin/python3 /opt/dsh-cloud/portable_worker.py --step /var/lib/dsh-cloud/.dsh/mobile-task-sync';

// Parse the entire expression. No shell expansion, guessed path substitution, or model-generated translation.
export function portablePlan(name, args) {
  if (!['pwsh', 'bash'].includes(name) || !args || typeof args.command !== 'string' ||
      (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0)) ||
      (args.description !== undefined && typeof args.description !== 'string') || args.command.length > 1024 || /[\r\n\0]/.test(args.command) || args.run_in_background ||
      Object.keys(args).some(k => !['command','description','timeoutMs','run_in_background'].includes(k))) return;
  let text = args.command.trim(), ms = 0;
  const isPwsh = name === 'pwsh';
  const delay = isPwsh ? /^Start-Sleep -Seconds (\d{1,4})(?:\s*;\s*|$)/i : /^sleep (\d{1,4})(?:\s*;\s*|$)/;
  const pause = delay.exec(text);
  if (pause) {
    ms = Number(pause[1]) * 1000;
    if (ms > 3600000 || (args.timeoutMs ?? 10000) < ms + 1000) return;
    text = text.slice(pause[0].length);
    if (!text) return {ms, op:'wait'};
  }
  const line = (isPwsh ? /^Write-Output '([^'\p{C}]{1,100})'$/iu : /^printf '%s\\n' '([^'\p{C}]{1,100})'$/u).exec(text);
  if (line) return {ms, op:'line', line:line[1]};
  const size = (isPwsh ? sizePwsh : sizeBash).exec(text);
  if (size && !/^(con|prn|aux|nul|(?:com|lpt)\d)\./i.test(size[1])) return {ms, op:'bytes', file:size[1]};
  const file = (isPwsh ? hashPwsh : hashBash).exec(text);
  if (file && !/^(con|prn|aux|nul|(?:com|lpt)\d)\./i.test(file[1])) return {ms, op:isPwsh?'sha256-upper':'sha256-lower', file:file[1]};
}

async function snapshot(cwd, file) {
  const base = await realpath(cwd), path = join(base,'relay-inputs',file);
  const entry = await lstat(path);
  if (!entry.isFile() || entry.nlink !== 1 || (await lstat(join(base,'relay-inputs'))).isSymbolicLink() ||
      await realpath(path) !== path) throw Error('接力输入不是工作区内的普通文件');
  const fd = await open(path,'r');
  try {
    const st = await fd.stat({bigint:true});
    if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(maxInput)) throw Error('接力输入须为 1 MiB 以内的普通文件');
    const bytes = Buffer.alloc(Number(st.size));
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await fd.read(bytes, offset, bytes.length-offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await lstat(path,{bigint:true});
    if (offset !== bytes.length || after.ino !== st.ino || after.dev !== st.dev || after.ctimeNs !== st.ctimeNs ||
        after.size !== st.size || await realpath(path) !== path) throw Error('接力输入在读取时发生变化');
    return bytes;
  } finally { await fd.close(); }
}

export function stepChannel(host) {
  if (!/^[a-z0-9][\w.-]*$/i.test(host)) throw Error('Invalid paired host');
  const child = spawn('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=4',host,remoteWorker],
    {stdio:['pipe','pipe','ignore'],windowsHide:true});
  const lines = createInterface({input:child.stdout});
  let pending, closed = false;
  function stop() {
    if (closed) return;
    closed = true;
    pending?.reject(Error('接力连接已断开'));
    lines.close(); child.stdin.destroy(); child.kill();
  }
  lines.on('line',line => {
    try { const reply = JSON.parse(line); if (!pending || typeof reply!=='string') return stop(); pending.resolve(reply); }
    catch { stop(); }
  });
  child.once('error',stop);child.once('close',stop);child.stdin.on('error',stop);
  return {stop, async send(message) {
    if (closed || pending) throw Error('接力连接不可用');
    const timer = setTimeout(stop,6000);
    try {
      return await new Promise((resolve,reject) => {
        pending = {resolve,reject}; child.stdin.write(JSON.stringify(message)+'\n');
      });
    } finally { pending = undefined; clearTimeout(timer); }
  }};
}

export function registerPortableSteps(ctx, host, connect = stepChannel) {
  const channels = new Set();
  let offlineUntil = 0;
  ctx.effect(() => () => { for (const ch of channels) ch.stop(); });
  ctx.on('tools/execute', async (exec,next) => {
    const session = exec.agent?.session, plan = portablePlan(exec.name,exec.arguments);
    if (Date.now() < offlineUntil || !plan || exec.parent || !validID(exec.callId) || !validID(session?.id)) return next();
    // Persistent PTYs can change directory, functions and aliases; they are not clean shells.
    const schema = ctx.tools.get(exec.name, exec.agent, exec.toolSet)?.output?.schema;
    if (!schema?.oneOf?.some(s => s.properties?.kind?.const === 'foreground')) return next();
    const project = ctx.workspaceRegistry.list().find(p => p.sessionIds.includes(session.id));
    if (!project || ctx.workspaceRegistry.archivedSessionIds.includes(session.id)) return next();
    let input = Buffer.from(plan.line ?? '');
    if (plan.file) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      if (resolve(cwd)!==resolve(project.path)) return next();
      try { input = await snapshot(cwd,plan.file); } catch { return next(); } // Never upload an unapproved input.
    }
    const ch = connect(host); channels.add(ch);
    const ticket = {session:session.id, call:exec.callId, attempt:randomUUID().replaceAll('-',''),
      ms:plan.ms, op:plan.op, input:input.toString('base64')};
    let timer, pulse;
    try {
      // No command or input has crossed the wire yet. An unavailable standby must not
      // prevent local-only execution, whereas a lost admission ACK is genuinely ambiguous.
      try {
        if (await ch.send('hello-v1')!=='ready-v1') throw Error('Unknown step protocol');
      } catch {
        offlineUntil = Date.now()+10000;
        ch.stop(); exec.signal.throwIfAborted();
        return next();
      }
      if (await ch.send(ticket)!=='armed') throw Error('云端未接受本次接力登记；未启动新的本地进程');
      if (exec.signal.aborted) { await ch.send('cancelled'); exec.signal.throwIfAborted(); }
      timer = setInterval(() => {
        if (!pulse) pulse = ch.send('pulse').then(r => { if(r!=='ok') ch.stop(); },ch.stop).finally(() => {pulse=undefined;});
      }, 2500);
      let result, action;
      try {
        result = await next();
        const v = result?.value;
        if (exec.signal.aborted || v?.aborted) action='cancelled';
        else if (result?.isError) action='failed';
        else if (v?.kind!=='foreground' || v.timedOut || v.exitCode!==0 || v.sandbox?.denied || v.stopped) action='unconfirmed';
        else {
          const expected = plan.op==='bytes' ? String(input.length) : plan.file ? createHash('sha256').update(input).digest('hex') : plan.line ?? '';
          const stdout = (v.stdout?.text ?? '').replace(/\r?\n$/, '');
          const actual = plan.op==='sha256-lower' ? expected+'  relay-inputs/'+plan.file : plan.op==='sha256-upper' ? expected.toUpperCase() : expected;
          action = actual===(plan.op==='bytes' ? stdout.trim() : stdout) ? 'completed' : 'unconfirmed';
        }
      } finally {
        clearInterval(timer); await pulse;
        // Only the cloud ledger accepts a final receipt. A dead standby cannot invalidate
        // a real local tool result. The standby never advances the native model loop.
        await ch.send(action ?? (exec.signal.aborted?'cancelled':'failed')).catch(() => undefined);
      }
      return result;
    } finally { clearInterval(timer);channels.delete(ch);ch.stop(); }
  });
}

export function registerStepReceipts(ctx, role, root) {
  ctx.commands.register({definitionId:'dsh-mobile-link/relay-status',name:'relay-status', description:'查看本会话的跨设备终端步骤回执',
    async handler({agent}) {
      const sid = agent?.session?.id;
      if (!validID(sid)) return {kind:'error',text:'无有效会话'};
      let rows = [];
      if (role==='cloud') {
        const worker = fileURLToPath(new URL('./portable_worker.py',import.meta.url));
        const {stdout} = await promisify(execFile)('python3',[worker,'--status',root,sid],{timeout:5000});
        rows = JSON.parse(stdout);
      } else {
        const dir = join(root,'step-results',hash(sid));
        const files = await readdir(dir).catch(e => { if(e.code==='ENOENT') return []; throw e; });
        for (const f of files.filter(f=>/^\d+\.json$/.test(f)).sort((a,b)=>parseInt(b)-parseInt(a)).slice(0,10)) {
          rows.push(JSON.parse(await readFile(join(dir,f),'utf8')));
        }
      }
      const states = {completed:'已完成',cancelled:'已取消',failed:'执行失败',unconfirmed:'未确认'};
      return {kind:'success',text:rows.map(r=>`${r.owner==='cloud'?'云端':'电脑'} · ${states[r.status]} · ${r.call}${r.result?'\n'+r.result:''}`).join('\n\n') || '本会话暂无终端接力回执。'};
    }});
}
