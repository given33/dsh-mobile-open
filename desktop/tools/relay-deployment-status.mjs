#!/usr/bin/env node
// Run via the native shell, never inside the privileged plugin host. Only read
// GitHub's fixed API origin; never follow an API-supplied URL, fetch logs, or POST.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readTicket } from '../lib/task-sync/deployment-ref.mjs';

const origin = 'https://api.github.com';
const limit = 2 * 1024 * 1024;
const maxPages = 5;
const validId = id => Number.isSafeInteger(id) && id > 0;
const sameURL = (actual,expected) => typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();

function githubReader(identity, signal) {
  const headers = {'Accept':'application/vnd.github+json','User-Agent':'dsh-mobile-link/relay-status','X-GitHub-Api-Version':'2022-11-28'};
  if (process.env.DSH_RELAY_GITHUB_READ_TOKEN && process.env.DSH_RELAY_GITHUB_REPOSITORY_ID === identity.repositoryId) {
    headers.Authorization = 'Bearer '+process.env.DSH_RELAY_GITHUB_READ_TOKEN;
  }
  return async (path, params={}) => {
    const url = new URL(origin + path);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
    const res = await fetch(url,{method:'GET',headers,signal,redirect:'error',cache:'no-store'});
    if (!res.ok) { await res.body?.cancel(); throw Error('http-'+res.status); }
    const chunks=[]; let size=0;
    for await (const chunk of res.body) {
      if ((size += chunk.length) > limit) throw Error('response-too-large');
      chunks.push(chunk);
    }
    return {value:JSON.parse(Buffer.concat(chunks).toString('utf8')),next:/;\s*rel="next"/.test(res.headers.get('link') ?? '')};
  };
}

async function list(read, path, params={}) {
  const rows=[];
  for (let page=1;page<=maxPages;page++) {
    const {value,next} = await read(path,{...params,per_page:100,page});
    if (!Array.isArray(value) || value.length>100 || value.some(row=>!validId(row?.id))) throw Error('invalid-records');
    rows.push(...value);
    if (!next) {
      if (new Set(rows.map(row=>row.id)).size !== rows.length) throw Error('listing-changed');
      return rows;
    }
  }
  throw Error('incomplete-list');
}

function correlation(deployment) {
  let p = deployment.payload;
  if (typeof p === 'string') {
    try { p=JSON.parse(p); } catch { return undefined; }
  }
  return p?.dshRelayOperation;
}

export async function inspectDeployment(ticket, reader, signal) {
  const {identity,operation} = readTicket(ticket);
  const repoPath='/repos/'+identity.repository, url=origin+repoPath;
  const read=reader ?? githubReader(identity,AbortSignal.any([AbortSignal.timeout(20000),...(signal ? [signal] : [])]));
  // "retryDeployment" is deliberately false in every state, even for a 404 or
  // reported failure: neither proves a remote side effect can be repeated safely.
  const result=(state,details={})=>({provider:'github-deployments',operation,repositoryId:identity.repositoryId,
    environment:identity.environment,sha:identity.sha,state,retryDeployment:false,observedAt:new Date().toISOString(),...details});
  const unknown=reason=>result('unconfirmed',{reason});
  const matches = d => d?.sha===identity.sha && d.environment===identity.environment && d.task==='deploy' &&
    String(d.creator?.id)===identity.deploymentActor && sameURL(d.repository_url,url);
  try {
    const {value:repo} = await read(repoPath);
    if (String(repo?.id)!==identity.repositoryId || repo.full_name?.toLowerCase()!==identity.repository.toLowerCase()) return unknown('repository-identity-mismatch');
    let id=identity.deploymentId;
    if (!id) {
      const candidates=await list(read,repoPath+'/deployments',{environment:identity.environment,sha:identity.sha,task:'deploy'});
      const marked=candidates.filter(d=>correlation(d)===operation);
      if (marked.length!==1) return unknown(marked.length ? 'ambiguous-operation' : 'no-operation-receipt');
      if (!matches(marked[0])) return unknown('operation-identity-mismatch');
      id=String(marked[0].id);
    }
    const path=repoPath+'/deployments/'+id;
    const {value:d}=await read(path);
    if (String(d?.id)!==id || !matches(d) || (!identity.deploymentId && correlation(d)!==operation)) return unknown('deployment-identity-mismatch');
    const statuses=await list(read,path+'/statuses');
    if (!statuses.length) return result('unconfirmed',{deploymentId:id,reason:'no-status'});
    if (statuses.some(s=>!sameURL(s.deployment_url,origin+path) || !Number.isFinite(Date.parse(s.created_at)))) return unknown('invalid-status-record');
    statuses.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at) || b.id-a.id);
    const s=statuses[0];
    if (String(s.creator?.id)!==identity.statusActor || s.environment!==identity.environment) return unknown('latest-status-identity-mismatch');
    const state={success:'reported-success',failure:'reported-failure',error:'reported-error',inactive:'inactive',pending:'pending',queued:'queued',in_progress:'in-progress'};
    if (!Object.hasOwn(state,s.state)) return unknown('unrecognized-status');
    return result(state[s.state],{deploymentId:id,statusId:String(s.id),statusCreatedAt:s.created_at});
  } catch (err) {
    const code=err instanceof Error ? err.message : '';
    return unknown(/^(http-\d{3}|incomplete-list|invalid-records|listing-changed|response-too-large)$/.test(code) ? code : 'read-failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length!==3) throw Error();
    console.log(JSON.stringify(await inspectDeployment(process.argv[2])));
  } catch { console.error('Invalid deployment reference. Expected one ticket from relay_deployment_ref.'); process.exitCode=2; }
}
