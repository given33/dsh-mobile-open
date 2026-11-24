import { setTimeout as delay } from 'node:timers/promises';
import { deploymentWatch } from './deployment-watch.mjs';
import { deploymentHelper, savedDeployments } from './deployment-ref.mjs';
import { ownerResultStatus, resultInstructions } from './relay-results.mjs';
import { access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { gitReleaseHelper } from './git-release-tool.mjs';
import { dispatchState } from './cloud-turn.mjs';
import { handoffEvidence } from './relay-evidence.mjs';

const programs = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3.11', 'python3', 'python', 'py', 'git', 'bash', 'pwsh', 'powershell',
  'make', 'cmake', 'gcc', 'g++', 'tar', 'unzip', 'rg', 'jq', 'go', 'cargo', 'rustc', 'dotnet', 'java'];
const manifests = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pyproject.toml',
  'requirements.txt', 'Cargo.toml', 'go.mod', 'CMakeLists.txt', 'Makefile', 'pom.xml', 'global.json'];
export const noArgs = {type:'object', properties:{}, additionalProperties:false};
export const textOutput = {schema:{type:'string'}, render:(_args,text) => [{type:'text',text}]};

// A lock file is evidence about the project, not permission to reinstall. In
// particular, npm ci removes an existing node_modules before it installs.
async function nodeSetup(cwd, files, foundOnPath) {
  if (!files.includes('package.json')) return null;
  const locks = files.filter(name => ['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'].includes(name));
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
  const foundOnPath = tools.filter(Boolean);
  return {role, platform:process.platform, arch:process.arch, cwd:resolve(cwd), hostNode:process.versions.node,
    gitReleaseHelper, nativeShellTools:shells, foundOnPath, notFound:programs.filter(p=>!tools.includes(p)),
    workspaceManifests, nodeSetup:await nodeSetup(cwd,workspaceManifests,foundOnPath)};
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
      const cwd = await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      const shells = ['bash','pwsh'].filter(n => !!ctx.tools.get(n,exec.agent,exec.toolSet));
      const info = await environment(cwd,role,shells);
      const session = exec.agent.session;
      info.scriptProgress = {nodeModule:new URL('../../tools/script-progress.mjs',import.meta.url).href,
        session:session.id, nativeTool:'relay_script_checkpoint', modelStateLimit:32*1024,
        maxStateBytes:256*1024, scope:'cooperative-replay-safe-compute'};
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(session.id,'read',{signal:exec.signal});
      try {
        const {events} = await reader.read();
        const references=savedDeployments(events,reader.inheritedEventCount,session.id);
        info.deploymentVerification = {helper:deploymentHelper, references, observations:await observer.forSession(session.id,references)};
        const handoff = handoffEvidence(events,reader.inheritedEventCount,session.id,role);
        // Passive sync can bring the very same accepted request back to its source.
        // Only the real receiver holds this local dispatch fence.
        info.handoff = handoff && await dispatchState(root,handoff.requestId) !== 'ready' ? handoff : null;
        info.returnedFiles = await ownerResultStatus(root,role,session.id);
        if (info.handoff) info.resultDelivery = await resultInstructions(root,session.id,handoff.requestId);
      } finally { await reader.close(); }
      exec.signal.throwIfAborted();
      return JSON.stringify(info);
    }});
}
