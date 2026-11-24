import { previousHost, taskProgress } from './host-change.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deploymentWatch } from './deployment-watch.mjs';
import { deploymentHelper, savedDeployments } from './deployment-ref.mjs';
import { ownerResultStatus, resultInstructions } from './relay-results.mjs';
import { access, lstat, opendir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { gitReleaseHelper } from './git-release-tool.mjs';
import { dispatchState, workspaceRoute } from './cloud-turn.mjs';
import { sourceState } from './source-state.mjs';
import { handoffEvidence } from './relay-evidence.mjs';

const programs = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3.11', 'python3', 'python', 'py', 'git', 'bash', 'pwsh', 'powershell',
  'make', 'cmake', 'gcc', 'g++', 'tar', 'unzip', 'rg', 'jq', 'go', 'cargo', 'rustc', 'dotnet', 'java', 'mvn', 'bun', 'find', 'grep'];
const manifests = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pyproject.toml',
  'requirements.txt', 'Cargo.toml', 'go.mod', 'CMakeLists.txt', 'Makefile', 'pom.xml', 'global.json'];
export const noArgs = {type:'object', properties:{}, additionalProperties:false};
export const textOutput = {schema:{type:'string'}, render:(_args,text) => [{type:'text',text}]};

const nodeLocks = new Map([['package-lock.json','npm'], ['npm-shrinkwrap.json','npm'], ['pnpm-lock.yaml','pnpm'],
  ['yarn.lock','yarn'], ['bun.lock','bun'], ['bun.lockb','bun']]);
const dotnetSuffixes = ['.sln','.slnx','.csproj','.fsproj','.vbproj'];

export function adaptToolchain(fromHost, envInfo, sourceSync) {
  const fromPlatform = /^(?:desktop|cloud)\/(win32|linux|darwin)\/[\w-]+$/.exec(fromHost)?.[1] ?? 'unknown';
  const toPlatform = envInfo.platform;
  const win = toPlatform === 'win32';
  const native = envInfo.nativeShellTools ?? [], path = new Set(envInfo.foundOnPath);
  const files = envInfo.workspaceManifests ?? [];
  const preferredShell = native.includes(win ? 'pwsh' : 'bash') ? (win ? 'pwsh' : 'bash') : native[0] ?? null;
  const availableShells = [...new Set([...native,...['bash','pwsh','powershell'].filter(t => path.has(t))])];
  const pythonNames = win ? ['py','python','python3','python3.11'] : ['python3.11','python3','python'];
  const pythonCommand = pythonNames.find(t => path.has(t)) ?? null;
  const projectStacks = [];
  const add = (stack, markers, tools) => {
    const manifests = files.filter(f => markers.includes(f));
    if (manifests.length) projectStacks.push({stack, manifests, availableTools:tools.filter(t => path.has(t)), missingTools:tools.filter(t => !path.has(t))});
  };
  const managers = [...new Set(files.map(f => nodeLocks.get(f)).filter(Boolean))];
  add('node',['package.json',...nodeLocks.keys()],['node',...(managers.length ? managers : ['npm'])]);
  add('python',['pyproject.toml','requirements.txt'],[pythonCommand ?? pythonNames[0]]);
  add('rust',['Cargo.toml'],['cargo','rustc']);
  add('go',['go.mod'],['go']);
  add('c/c++',['CMakeLists.txt','Makefile'],[...(files.includes('CMakeLists.txt') ? ['cmake'] : []), ...(files.includes('Makefile') ? ['make'] : [])]);
  add('java',['pom.xml'],['java','mvn']);
  add('.net',['global.json',...files.filter(f => dotnetSuffixes.some(ext => f.toLowerCase().endsWith(ext)))],['dotnet']);

  // Static vocabulary only. These describe equivalent read-only checks, never a
  // translation of a command from the transcript or permission to execute it.
  const commandEquivalents = [];
  if (fromPlatform !== 'unknown' && fromPlatform !== toPlatform) {
    const fromWin = fromPlatform === 'win32';
    const addMapping = (operation, from, to, args = []) => {
      if (to && (native.includes(to) || path.has(to))) commandEquivalents.push({operation, from, to, args});
    };
    addMapping('shell',fromWin ? 'pwsh' : 'bash',preferredShell);
    addMapping('python-version',fromWin ? 'py' : 'python3',pythonCommand,['--version']);
    const powershell = availableShells.find(t => t === 'pwsh' || t === 'powershell');
    if (path.has('rg')) {
      addMapping('find-files',fromWin ? 'Get-ChildItem' : 'find','rg',['--files']);
      addMapping('search-text',fromWin ? 'Select-String' : 'grep','rg');
    } else if (win && powershell) {
      addMapping('find-files','find',powershell,['-NoProfile','-Command','Get-ChildItem']);
      addMapping('search-text','grep',powershell,['-NoProfile','-Command','Select-String']);
    } else if (!win) {
      addMapping('find-files',fromWin ? 'Get-ChildItem' : 'find','find');
      addMapping('search-text',fromWin ? 'Select-String' : 'grep','grep');
    }
    addMapping('npm-version','npm','npm',['--version']);
  }
  const sourceSyncSummary = sourceSync == null ? {enrolled:false, ready:false,
    guidance:'当前工作区未登记源码共享，仅接力会话上下文；不要假设目标机已有源端未同步的本地文件改动。'} :
    {enrolled:true, ready:!!sourceSync.ready, seq:sourceSync.seq, peerStored:sourceSync.peerStored,
      received:sourceSync.received, conflicts:sourceSync.conflicts ?? []};
  return {fromPlatform, toPlatform, transition:fromPlatform === toPlatform ? 'same-platform' : `${fromPlatform}->${toPlatform}`,
    preferredShell, availableShells, pwshOnPath:path.has('pwsh'), pathSeparator:win ? '\\' : '/', pythonCommand,
    commandEquivalents, projectStacks, sourceSyncSummary};
}

// A lock file is evidence about the project, not permission to reinstall. In
// particular, npm ci removes an existing node_modules before it installs.
async function nodeSetup(cwd, files, foundOnPath) {
  if (!files.includes('package.json')) return null;
  const locks = files.filter(name => nodeLocks.has(name));
  let modules;
  try {
    const entry = await lstat(join(cwd,'node_modules'));
    modules = entry.isDirectory() ? 'present-unverified' : 'not-a-plain-directory';
  } catch (err) {
    modules = err.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  const setup = {locks, modules};
  if (locks.length === 1 && ['package-lock.json','npm-shrinkwrap.json'].includes(locks[0]) && foundOnPath.includes('npm')) {
    setup.verify = 'npm ls --depth=0';
    if (modules === 'absent') setup.freshInstall = 'npm ci --ignore-scripts --no-fund --no-audit';
  }
  return setup;
}

// Observe the service account's actual search path. Never invoke an executable just to discover it,
// run a project's install hooks, read manifest contents or include the host environment in a packet.
export async function environment(cwd, role, shells, searchPath = process.env.PATH || '') {
  const dirs = [...new Set(searchPath.split(delimiter).filter(p => isAbsolute(p)))];
  const win = process.platform === 'win32';
  const extensions = win ? ['.exe','.cmd','.bat','.com'] : [''];
  const tools = await Promise.all(programs.map(async name => {
    for (const dir of dirs) for (const extension of extensions) {
      const file = join(dir,name + extension);
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, win ? constants.F_OK : constants.X_OK);
        return name;
      } catch { /* Not an available command in this directory. */ }
    }
  }));
  const files = await Promise.all(manifests.map(async name => {
    try { if ((await lstat(join(cwd,name))).isFile()) return name; } catch { /* Absent or private. */ }
  }));
  const workspaceManifests = files.filter(Boolean);
  // A .NET project often has no global.json. Report only fixed marker patterns,
  // not arbitrary directory entries, and do not follow symlinks or read contents.
  const dotnet = new Set();
  try {
    for await (const entry of await opendir(cwd)) {
      if (!entry.isFile()) continue;
      const ext = dotnetSuffixes.find(suffix => entry.name.toLowerCase().endsWith(suffix));
      if (ext) dotnet.add('*' + ext);
    }
  } catch (err) { if (!['EACCES','EPERM','ENOENT','ENOTDIR'].includes(err.code)) throw err; }
  workspaceManifests.push(...[...dotnet].sort());
  const foundOnPath = tools.filter(Boolean);
  return {role, platform:process.platform, arch:process.arch, cwd:resolve(cwd), hostNode:process.versions.node,
    gitReleaseHelper, nativeShellTools:shells, foundOnPath, notFound:programs.filter(p=>!tools.includes(p)),
    workspaceManifests, nodeSetup:await nodeSetup(cwd,workspaceManifests,foundOnPath)};
}

async function workspaceEnvironment(ctx,role,root,agent,signal,toolSet) {
  const cwd = await ctx.workingDirectory.ensure(agent,signal);
  const shells = ['bash','pwsh'].filter(name => !!ctx.tools.get(name,agent,toolSet));
  const info = await environment(cwd,role,shells);
  const project = ctx.get?.('workspaceRegistry')?.list().find(p => p.sessionIds.includes(agent.session.id));
  if (project) info.sourceSync = await sourceState(root,await workspaceRoute(root,role,project));
  return info;
}

export function hostChangeProbe(ctx,role,root) {
  return async (agent,signal,previous) => {
    const info = await workspaceEnvironment(ctx,role,root,agent,signal);
    return {cwd:info.cwd, nativeShellTools:info.nativeShellTools, nodeSetup:info.nodeSetup,
      toolchain:adaptToolchain(previous,info,info.sourceSync)};
  };
}

export function registerEnvironment(ctx,role,root) {
  const observer=deploymentWatch(root);
  ctx.effect(() => {
    void observer.tick();
    const timer=setInterval(()=>void observer.tick(),30_000);
    timer.unref?.();
    return () => { clearInterval(timer); observer.stop(); };
  });
  ctx.tools.register({name:'relay_wait_deployment',output:textOutput,
    parameters:{type:'object',required:['operation'],additionalProperties:false,properties:{operation:{type:'string'},
      previousStatusId:{type:'string'},timeoutSeconds:{type:'integer',minimum:1,maximum:60}}},
    description:'Wait for a first or changed owner-monitored GitHub deployment receipt in THIS session. Use the original reference operation; no network or rollout is triggered by the tool. A timeout is not a failed deployment or permission to submit again.',
    async execute(args,exec) {
      const timeout=args.timeoutSeconds ?? 15;
      if (!/^[a-f0-9]{64}$/.test(args.operation) || !Number.isInteger(timeout) || timeout<1 || timeout>60 ||
          (args.previousStatusId!==undefined && !/^[1-9]\d{0,15}$/.test(args.previousStatusId))) throw Error('Invalid deployment wait');
      const session=exec.agent.session;
      await ctx.sessions.flush(session);
      const reader=await ctx.sessionPersistence.open(session.id,'read',{signal:exec.signal});
      let ref;
      try { ref=savedDeployments((await reader.read()).events,reader.inheritedEventCount,session.id).find(r=>r.operation===args.operation); }
      finally { await reader.close(); }
      if (!ref) throw Error('No matching native deployment reference in this session');
      const deadline=performance.now()+timeout*1000;
      while (true) {
        exec.signal.throwIfAborted();
        const [receipt]=await observer.forSession(session.id,[ref]);
        if (!receipt) return JSON.stringify({deploymentObservation:ref.operation,state:'unconfirmed',reason:'no-owner-watch',retryDeployment:false});
        if (receipt.reason!=='awaiting-owner-observation' && (!args.previousStatusId || receipt.statusId!==args.previousStatusId)) return JSON.stringify({deploymentObservation:ref.operation,...receipt});
        const remaining=deadline-performance.now();
        if (remaining<=0) return JSON.stringify({deploymentObservation:ref.operation,...receipt,waitTimedOut:true});
        await delay(Math.min(remaining,1000),undefined,{signal:exec.signal});
      }
    },
  });
  ctx.tools.register({name:'relay_environment', parameters:noArgs, output:textOutput,
    description:'Inspect the current execution host, native DSH shells, PATH tools and project manifests after switching devices. Read source tool result references for this handoff. Missing results or shell success do not prove external effects; verify the target before retrying. Does not run or install anything.',
    async execute(_args,exec) {
      const session = exec.agent.session;
      const info = await workspaceEnvironment(ctx,role,root,exec.agent,exec.signal,exec.toolSet);
      info.scriptProgress = {nodeModule:new URL('../../tools/script-progress.mjs',import.meta.url).href,
        session:session.id, nativeTool:'relay_script_checkpoint', modelStateLimit:32*1024,
        maxStateBytes:256*1024, scope:'cooperative-replay-safe-compute'};
      info.pythonCheckpoints = {
        checker: fileURLToPath(new URL('./python_state.py', import.meta.url)),
        runner: fileURLToPath(new URL('./paired_python.py', import.meta.url)),
        ledgerRoot: root, session: session.id, interpreter: 'CPython 3.11',
        scope: 'opt-in deterministic Python; run check before execution; no OS process or external effects',
        modes: {primary:'peer ACK before each batch', standby:'pre-authorized pure compute after a quiet paired checkpoint'},
        sandboxFallback: 'Use an authorized project copy of the checker in slice mode with relay_script_checkpoint; never grant access to the host ledger to bypass sandbox policy.'
      };
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(session.id,'read',{signal:exec.signal});
      try {
        const {events} = await reader.read();
        info.taskProgress = taskProgress(events,reader.inheritedEventCount);
        const references=savedDeployments(events,reader.inheritedEventCount,session.id);
        info.deploymentVerification = {helper:deploymentHelper, references, observations:await observer.forSession(session.id,references)};
        const handoff = handoffEvidence(events,reader.inheritedEventCount,session.id,role);
        // Passive sync can bring the very same accepted request back to its source.
        // Only the real receiver holds this local dispatch fence.
        info.handoff = handoff && await dispatchState(root,handoff.requestId) !== 'ready' ? handoff : null;
        // After the first target step the newest runtime snapshot is already local.
        // For an accepted local handoff, use the snapshot before its source boundary.
        const sourceEvents = info.handoff ? events.slice(0,info.handoff.sourceEndSeq+1) : events;
        info.toolchain = adaptToolchain(previousHost(sourceEvents,reader.inheritedEventCount),info,info.sourceSync ?? null);
        info.returnedFiles = await ownerResultStatus(root,role,session.id);
        if (info.handoff) info.resultDelivery = await resultInstructions(root,session.id,handoff.requestId);
      } finally { await reader.close(); }
      exec.signal.throwIfAborted();
      return JSON.stringify(info);
    }});
}
