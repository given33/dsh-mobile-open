#!/usr/bin/env python3
"""Provision an opt-in, empty, unprivileged bare release *sandbox*. No existing repository is modified."""
import argparse
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import tempfile


def git(path,*args,input=None):
    return subprocess.check_output(['git','-C',str(path),*args],input=input,text=True).strip()


def provision(destination,guard,branch):
    destination=destination.absolute();guard=guard.resolve(strict=True)
    node=shutil.which('node')
    if not node or os.name!='posix':raise ValueError('Requires POSIX, Node and Git on the receiver')
    if not branch or git(destination.parent,'check-ref-format','--branch',branch)!=branch:raise ValueError('Invalid branch')
    # mkdir without exist_ok: never install hooks on a user's pre-existing repo.
    destination.mkdir(mode=0o700)
    git(destination,'init','--bare','-q')
    identity=git(destination,'hash-object','-w','--stdin',input='DSH release identity '+secrets.token_hex(32)+'\n')
    git(destination,'update-ref','refs/dsh-relay/identity',identity)
    with tempfile.TemporaryDirectory(prefix='dsh-release-seed-') as d:
        work=Path(d); git(work,'init','-q'); git(work,'-c','user.name=DSH Sandbox','-c','user.email=sandbox@invalid',
            'commit','-qm','Initialize empty release branch','--allow-empty');base=git(work,'rev-parse','HEAD')
        git(work,'push','-q',str(destination),base+':refs/heads/'+branch)
    git(destination,'symbolic-ref','HEAD','refs/heads/'+branch)
    git(destination,'config','dshRelay.protectedBranch',branch)
    hooks=destination/'dsh-hooks';hooks.mkdir(mode=0o700);hook=hooks/'reference-transaction'
    hook.write_text('#!/bin/sh\nexec '+shlex.quote(node)+' '+shlex.quote(str(guard))+' "$1"\n',encoding='utf8');hook.chmod(0o700)
    git(destination,'config','core.hooksPath',str(hooks))
    # The initially empty branch has no deploy hook, post-receive hook or external credentials.
    return identity,base


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('destination',type=Path);ap.add_argument('installed_guard',type=Path)
    ap.add_argument('--branch',default='release');a=ap.parse_args();print(*provision(a.destination,a.installed_guard,a.branch),sep='\n')
