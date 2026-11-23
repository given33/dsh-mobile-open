#!/usr/bin/env node
// Receiver-side reference-transaction hook, for an explicitly opted-in release
// branch. Call this module from the server's hook; never install over existing hooks.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { releasePlan } from '../lib/task-sync/git-release.mjs';

function reject() { throw Error('Invalid DSH release ref transaction'); }
function git(args,mayBeAbsent=false) {
  const p = spawnSync('git',['--no-replace-objects',...args],{encoding:'utf8',timeout:10000,maxBuffer:8192});
  if (mayBeAbsent && !p.error && p.status === 1) return null;
  if (p.error || p.status !== 0) reject();
  return p.stdout.trimEnd();
}
function objectAt(ref) { return git(['rev-parse','--verify','--quiet',ref],true); }
function guard(lines) {
  if (!lines.includes(' refs/')) return;
  if (git(['rev-parse','--is-bare-repository']) !== 'true') reject();
  const branch = git(['config','--local','--get-all','dshRelay.protectedBranch']);
  const ref = 'refs/heads/' + branch, identityRef = 'refs/dsh-relay/identity';
  const rows = lines.trimEnd().split('\n').map(line => line.split(' '));
  const relevant = rows.filter(([, , name]) => name === ref || name?.startsWith('refs/dsh-relay/'));
  if (!relevant.length) return;
  const planned = relevant.filter(r => /^refs\/dsh-relay\/plans\/[0-9a-f]{64}$/.test(r[2]));
  const records = relevant.filter(r => /^refs\/dsh-relay\/receipts\/[0-9a-f]{64}$/.test(r[2]));
  const head = relevant.find(r => r[2] === ref);
  const prepping = planned.length === 1 && relevant.length === 1;
  if (!prepping && !(records.length === 1 && head && relevant.length === 2)) reject();
  const [old,oid,name] = (prepping ? planned : records)[0];
  if (!/^0+$/.test(old) || objectAt(name) !== null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) reject();
  if (git(['cat-file','-t',oid]) !== 'tag' || Number(git(['cat-file','-s',oid])) > 2048) reject();
  const text = git(['cat-file','-p',oid]);
  const data = JSON.parse(text.split('\n\n')[1]);
  const identity = objectAt(identityRef), operation = name.split('/').pop();
  if (data.branch !== branch || !identity || data.identity !== identity || operation !== data.operation) reject();
  const plan = releasePlan({...data,remote:'target'},operation);
  if (plan.digest !== oid || text !== plan.descriptor.trimEnd() || objectAt(ref) !== data.base) reject();
  if (git(['cat-file','-t',data.desired]) !== 'commit' || git(['cat-file','-t',data.base]) !== 'commit') reject();
  git(['merge-base','--is-ancestor',data.base,data.desired]);
  if (!prepping && (objectAt(plan.planRef) !== oid || head[0] !== data.base || head[1] !== data.desired)) reject();
}
try {
  const lines = readFileSync(0,'utf8');
  if (process.argv[2] === 'prepared') guard(lines);
} catch { console.error('DSH refused an unpaired, stale or mutable release transaction'); process.exitCode = 1; }
