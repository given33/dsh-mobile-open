import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { digest, fileKey, importedEvents, maxBytes, transcript, validate } from './transcript.mjs';

export const name='dsh-shared-sessions';
export const inject=['sessionPersistence','workspaceRegistry'];
const run = promisify(execFile);
const transfer=fileURLToPath(new URL('./transfer.py',import.meta.url));
const mirrorPrefix='session-dshmirror-';

// Never overwrite or replay an existing local turn. If the user independently
// continued the imported copy, materialize subsequent source history as a branch.
export async function importCopy(store, project, cache, packet, signal) {
  const base=mirrorPrefix+fileKey(packet).slice(0,32);
  let id=base;
  for (let attempt=0; attempt<12; attempt++) {
    const expected=importedEvents(packet,id);
    const existing=await store.stat(id,{signal});
    if(existing && resolve(existing.header.cwd)!==resolve(project.path)) throw Error('Mirror belongs to another workspace');
    const header=existing?.header ?? {version:4,id,cwd:project.path,createdAt:packet.created,isSeeded:false};
    const open=access=>store.open(id,access,{signal});
    const prefixMatches=old=>old.every((e,i)=>e.type==='session/title' && expected[i]?.type==='session/title' || isDeepStrictEqual(e,expected[i]));
    if(existing){
      const reader=await open('read'); let old;
      try {old=(await reader.read()).events;} finally {await reader.close();}
      if(!prefixMatches(old)) { id=base+'-'+digest(id+':'+old.findIndex((e,i)=>!isDeepStrictEqual(e,expected[i]))).slice(0,12); continue; }
      if(old.length===expected.length) {if(!project.sessionIds.includes(id)) await project.attachSession(id);return id;}
    }
    const writer=existing ? await open('write') : await store.create(header,{signal});
    try {
      const old=existing ? (await writer.read()).events : [];
      if(!prefixMatches(old)) throw Error('Concurrent local edit; retry');
      await writer.append(expected.slice(old.length),{signal}); await writer.flush({signal});
    } finally {await writer.close();}
    cache?.coldSnapshot(header,0,expected);
    if(!project.sessionIds.includes(id)) await project.attachSession(id);
    return id;
  }
  throw Error('Too many divergent branches; existing sessions preserved');
}

export function apply(ctx, config={}) {
  if(!['cloud','desktop'].includes(config.role) || !config.workspace) return;
  const role=config.role, peer=role==='desktop'?'cloud':'desktop', workspace=resolve(config.workspace);
  const root=join(process.env.DSH_HOME || join(homedir(),'.dsh'),'shared-sessions');
  const sourceDir=workspace, mirrorDir=join(dirname(workspace),peer==='cloud'?'来自阿里云的任务':'来自电脑的任务');
  const outbox=join(root,'outbox'), inbox=join(root,'inbox');
  const exportsSeen=new Map(), importsSeen=new Map();
  const ctrl=new AbortController(); let busy=false, uid=0;
  let lastError='';
  const report=e=>{const msg=String(e.code||e.message).slice(0,160);if(msg!==lastError){console.warn('[dsh-shared-sessions]',msg);lastError=msg;}};
  async function tick() {
    if(busy || ctrl.signal.aborted)return;busy=true;
    try {
      for(const path of [outbox,inbox,sourceDir,mirrorDir])await mkdir(path,{recursive:true,mode:0o700});
      const registry=ctx.workspaceRegistry, store=ctx.sessionPersistence;
      const getProject=async (path,label)=>registry.list().find(x=>resolve(x.path)===path) ?? await registry.create(path,label);
      const source=await getProject(sourceDir,'三端共享任务'), target=await getProject(mirrorDir,peer==='cloud'?'来自阿里云的任务':'来自电脑的任务');
      for(const sid of source.sessionIds){
        if(sid.startsWith(mirrorPrefix))continue;
        try {
          const rec=await store.stat(sid,{signal:ctrl.signal}); if(!rec || resolve(rec.header.cwd)!==workspace)continue;
          const rev=JSON.stringify(rec.revision);if(exportsSeen.get(sid)===rev)continue;
          const reader=await store.open(sid,'read',{signal:ctrl.signal}); let p;
          try{p=transcript(role,reader.header,(await reader.read()).events);}finally{await reader.close();}
          if(p){validate(p,role);const json=JSON.stringify(p);if(Buffer.byteLength(json)>maxBytes)throw Error('Shared transcript exceeds 8 MiB');
            const path=join(outbox,fileKey(p)+'.json'), tmp=path+'.'+process.pid+'.'+(++uid)+'.tmp';await writeFile(tmp,json,{mode:0o600});await rename(tmp,path);
          }exportsSeen.set(sid,rev);
        }catch(e){report(e);}
      }
      if(role==='desktop' && config.sshHost){
        if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.sshHost))throw Error('Invalid SSH alias');
        await run('py',['-3.11',transfer,'--sync',root,config.sshHost],{windowsHide:true,timeout:90000,signal:ctrl.signal});
      }
      for(const f of await readdir(inbox)){
        if(!/^[0-9a-f]{64}\.json$/.test(f))continue;
        try{const path=join(inbox,f),s=await stat(path);if(s.size>maxBytes)throw Error('Oversize shared transcript');
          const mark=s.mtimeMs+':'+s.size;if(importsSeen.get(f)===mark)continue;
          const p=JSON.parse(await readFile(path,'utf8'));validate(p,peer);if(fileKey(p)+'.json'!==f)throw Error('Shared transcript identity mismatch');
          await importCopy(store,target,ctx.get?.('sessionProjectionCache'),p,ctrl.signal);importsSeen.set(f,mark);
        }catch(e){report(e);}
      }
    } catch(e){if(!ctrl.signal.aborted)report(e);}finally{busy=false;}
  }
  ctx.effect(()=>{const once=setTimeout(tick,1000), interval=setInterval(tick,30000);return ()=>{clearTimeout(once);clearInterval(interval);ctrl.abort();};});
}
