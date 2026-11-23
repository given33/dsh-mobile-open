import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { dispatchState } from './cloud-turn.mjs';
import { handoffEvidence } from './relay-evidence.mjs';

const programs = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3.11', 'python3', 'python', 'py', 'git', 'bash', 'pwsh', 'powershell',
  'make', 'cmake', 'gcc', 'g++', 'tar', 'unzip', 'rg', 'jq', 'go', 'cargo', 'rustc', 'dotnet', 'java'];
const manifests = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml',
  'requirements.txt', 'Cargo.toml', 'go.mod', 'CMakeLists.txt', 'Makefile', 'pom.xml', 'global.json'];
export const noArgs = {type:'object', properties:{}, additionalProperties:false};
export const textOutput = {schema:{type:'string'}, render:(_args,text) => [{type:'text',text}]};

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
    try { if ((await stat(join(cwd,name))).isFile()) return name; } catch { /* Absent or private. */ }
  }));
  return {role, platform:process.platform, arch:process.arch, cwd:resolve(cwd), hostNode:process.versions.node,
    nativeShellTools:shells, foundOnPath:tools.filter(Boolean), notFound:programs.filter(p=>!tools.includes(p)),
    workspaceManifests:files.filter(Boolean)};
}

export function registerEnvironment(ctx,role,root) {
  ctx.tools.register({name:'relay_environment', parameters:noArgs, output:textOutput,
    description:'Inspect the current execution host, native DSH shells, PATH tools and project manifests after switching devices. Read source tool result references for this handoff. Missing results or shell success do not prove external effects; verify the target before retrying. Does not run or install anything.',
    async execute(_args,exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      const shells = ['bash','pwsh'].filter(n => !!ctx.tools.get(n,exec.agent,exec.toolSet));
      const info = await environment(cwd,role,shells);
      const session = exec.agent.session;
      await ctx.sessions.flush(session);
      const reader = await ctx.sessionPersistence.open(session.id,'read',{signal:exec.signal});
      try {
        const {events} = await reader.read();
        const handoff = handoffEvidence(events,reader.inheritedEventCount,session.id,role);
        // Passive sync can bring the very same accepted request back to its source.
        // Only the real receiver holds this local dispatch fence.
        info.handoff = handoff && await dispatchState(root,handoff.requestId) !== 'ready' ? handoff : null;
      } finally { await reader.close(); }
      exec.signal.throwIfAborted();
      return JSON.stringify(info);
    }});
}
