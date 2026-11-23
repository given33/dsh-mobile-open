#!/usr/bin/env node
// Intended to run through the active DSH native shell and its existing approvals,
// never inside the privileged desktop host. No arbitrary command, URL or refspec.
import { spawnSync } from 'node:child_process';
import { releasePlan } from '../lib/task-sync/git-release.mjs';

const [action,remote,branch,operation,identity,base,desired,...extra] = process.argv.slice(2);
const identityRef = 'refs/dsh-relay/identity';
function git(args,input) {
  const p = spawnSync('git',['--no-replace-objects',...args],{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],
    windowsHide:true,timeout:90000,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  // Do not print remote URLs, credential-helper diagnostics or server-provided text.
  if (p.error || p.status !== 0) throw Error(`Git ${args.find(x => ['ls-remote','push','fetch','mktag','config','merge-base','cat-file','remote','rev-parse'].includes(x)) ?? 'operation'} failed; check the target before retrying`);
  return p.stdout.trimEnd();
}

function run() {
  if (!['prepare','status','finish'].includes(action) || extra.length) throw Error('Expected prepare|status|finish REMOTE BRANCH OPERATION IDENTITY BASE DESIRED');
  const plan = releasePlan({remote,branch,identity,base,desired},operation);
  const {descriptor,digest,branchRef,planRef,receiptRef} = plan;
  const policy = k => git(['config','--local','--get-all',`dshRelay.${remote}.${k}`]);
  if (policy('identity') !== identity || policy('branch') !== branch) throw Error('This repository is not enabled for this release target');
  const fetchUrl = git(['remote','get-url','--all',remote]);
  if (!fetchUrl || /[\r\n]/.test(fetchUrl) || fetchUrl !== git(['remote','get-url','--push','--all',remote])) throw Error('Release requires one shared fetch/push target');
  if (git(['rev-parse','--show-object-format']) !== (digest.length === 40 ? 'sha1' : 'sha256')) throw Error('Git object format mismatch');
  function status() {
    const refs = new Map();
    for (const line of git(['ls-remote','--refs',remote,identityRef,branchRef,planRef,receiptRef]).split('\n')) {
      const [id,name] = line.trimEnd().split('\t');
      if (name) refs.set(name,id);
    }
    if (refs.get(identityRef) !== identity) throw Error('Release target identity mismatch');
    const head = refs.get(branchRef) ?? null, prepared = refs.get(planRef), recorded = refs.get(receiptRef);
    let state;
    if ((prepared && prepared !== digest) || (recorded && (recorded !== digest || prepared !== digest))) state = 'conflict';
    else if (recorded) state = 'committed';
    else if (head === desired) state = 'unattributed'; // A different writer may have deployed it.
    else if (head !== base) state = 'head-changed';
    else state = prepared ? 'prepared' : 'not-prepared';
    return {state,operation,receiptObject:recorded ?? null,branchHead:head,branchMatchesDesired:head === desired};
  }
  let report = status();
  if (action === 'status' || report.state === 'committed' || (action === 'prepare' && report.state === 'prepared')) return report;
  const prep = action === 'prepare';
  if (report.state !== (prep ? 'not-prepared' : 'prepared')) throw Error('Git release not advanced: '+report.state);
  const verifyCommit = id => { if (git(['cat-file','-t',id]) !== 'commit') throw Error('Release requires commit objects'); };
  if (!prep) {
    // No checkout/reset or tracking ref updates. A fresh receiver needs none of the source files.
    git(['fetch','--no-tags','--no-prune','--no-write-fetch-head','--no-recurse-submodules','--refmap=',remote,planRef]);
    if (git(['cat-file','-p',digest]) !== descriptor.trimEnd()) throw Error('Fetched release plan does not match the original intent');
  }
  verifyCommit(base); verifyCommit(desired);
  if (!prep) {
    // Bind the original branch and base to the actual remote commit, not merely
    // the local spelling of a remote alias; branch updates still require its server guard.
    report = status();
    if (report.state === 'committed') return report;
    if (report.state !== 'prepared') throw Error('Git release not advanced: '+report.state);
  }
  git(['merge-base','--is-ancestor',base,desired]); // Never use a lease to push unrelated history.
  if (prep && git(['mktag'],descriptor) !== digest) throw Error('Invalid Git release plan object');
  const args = ['-c',`remote.${remote}.mirror=false`,'-c','push.followTags=false','push','--atomic','--recurse-submodules=no'];
  if (prep) args.push(`--force-with-lease=${planRef}:`,remote,`${digest}:${planRef}`);
  else args.push(`--force-with-lease=${branchRef}:${base}`,`--force-with-lease=${receiptRef}:`,remote,`${desired}:${branchRef}`,`${digest}:${receiptRef}`);
  // Even a successful client exit is not proof; a lost response may also mean success.
  try { git(args); } catch { /* Reconcile below, never issue another push here. */ }
  report = status();
  if (report.state !== 'committed' && !(prep && report.state === 'prepared')) throw Error('No matching target receipt: '+report.state);
  return report;
}
try { console.log(JSON.stringify(run())); }
catch (e) { console.error(e.message); process.exitCode = 1; }
