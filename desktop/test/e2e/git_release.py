"""Exercise a real Git receive-pack and write-once receipts in disposable repositories.
--serve hosts the same fixture via loopback smart HTTP for paired-host fault tests.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import re
import tempfile
import threading
import time
import urllib.parse
import uuid

TOOLS = Path(__file__).resolve().parents[2] / 'tools'
HELPER = TOOLS / 'relay-git-release.mjs'
GUARD = TOOLS / 'relay-git-guard.mjs'
NODE = shutil.which('node')


def git(where, *args, input=None, ok=True):
    p = subprocess.run(['git', '-C', str(where), *args], input=input, capture_output=True, text=True, check=ok)
    return p.stdout.strip() if ok else p.returncode


def repo(path):
    path.mkdir(); git(path,'init','-q'); git(path,'config','user.name','Fixture'); git(path,'config','user.email','fixture@invalid')


def initialize(root):
    target = root/'target.git'; target.mkdir(); git(target,'init','--bare','-q')
    local = root/'seed'; repo(local)
    for value in ['base','desired','later']:
        (local/'content').write_text(value); git(local,'add','content'); git(local,'commit','-qm',value)
    base,desired,later = git(local,'rev-list','--reverse','HEAD').splitlines()
    identity = git(target,'hash-object','-w','--stdin',input='DSH QA '+uuid.uuid4().hex)
    git(target,'update-ref','refs/dsh-relay/identity',identity)
    git(local,'push','-q',str(target),base+':refs/heads/release',later+':refs/heads/source')
    git(target,'config','dshRelay.protectedBranch','release'); git(target,'config','http.receivepack','true')
    hooks = root/'fixture-hooks'; hooks.mkdir(); git(target,'config','core.hooksPath',str(hooks))
    guard = hooks/'reference-transaction'
    guard.write_text('#!/bin/sh\nexec '+shlex.quote(Path(NODE).as_posix())+' '+shlex.quote(GUARD.as_posix())+' "$1"\n',encoding='utf8'); guard.chmod(0o755)
    post = hooks/'post-receive'
    post.write_text('''#!/bin/sh
while read old new ref; do
  if test "$ref" = refs/heads/release; then
    echo "$new" >> release-updates
    if test -f hold-reply; then
      i=0; while test -f hold-reply && test $i -lt 60; do sleep 1; i=$((i+1)); done
    fi
  fi
done
''',encoding='utf8');post.chmod(0o755)
    return {'identity':identity,'base':base,'desired':desired,'later':later,'operation':hashlib.sha256(os.urandom(16)).hexdigest()}


def client(root, remote, spec, source=False):
    repo(root);git(root,'remote','add','origin',remote)
    git(root,'config','--local','dshRelay.origin.identity',spec['identity']);git(root,'config','--local','dshRelay.origin.branch','release')
    if source: git(root,'fetch','-q','origin','refs/heads/source')
    return root


def cmd(action,s):
    return [NODE,str(HELPER),action,'origin','release',s['operation'],s['identity'],s['base'],s['desired']]


def step(repo,action,s):
    r=subprocess.run(cmd(action,s),cwd=repo,capture_output=True,text=True,timeout=100)
    assert not r.returncode,(action,r.stderr);return json.loads(r.stdout)


def local_test(root):
    s=initialize(root); target=root/'target.git'; remote=str(target)
    a=client(root/'pc',remote,s,True); b=client(root/'standby',remote,s)
    assert step(a,'status',s)['state']=='not-prepared'
    assert step(a,'prepare',s)['state']=='prepared'
    assert not (target/'release-updates').exists()
    # A plain write or receipt-only transaction must not impersonate a deployment.
    assert git(a,'push','origin',s['desired']+':refs/heads/release',ok=False)!=0
    tag=git(target,'rev-parse','refs/dsh-relay/plans/'+s['operation'])
    assert git(a,'push','origin',tag+':refs/dsh-relay/receipts/'+s['operation'],ok=False)!=0
    assert git(a,'push','origin',':refs/dsh-relay/plans/'+s['operation'],ok=False)!=0
    assert git(b,'cat-file','-e',s['desired'],ok=False)!=0 # no local code available
    (target/'hold-reply').touch(); p=subprocess.Popen(cmd('finish',s),cwd=b,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(320):
            if (target/'release-updates').exists():break
            if p.poll() is not None:raise AssertionError('sender exited before receipt')
            time.sleep(.1)
        assert (target/'release-updates').exists() and p.poll() is None
        p.kill(); p.wait(timeout=5) # lost sender, target has already performed the transaction
    finally: (target/'hold-reply').unlink(missing_ok=True)
    assert step(a,'status',s)['state']=='committed' and step(a,'finish',s)['state']=='committed'
    assert (target/'release-updates').read_text().splitlines()==[s['desired']]
    s2=dict(s,operation=hashlib.sha256(b'later').hexdigest(),base=s['desired'],desired=s['later'])
    step(a,'prepare',s2);step(a,'finish',s2)
    assert not step(b,'finish',s)['branchMatchesDesired']
    assert step(b,'status',dict(s,desired=s['later']))['state']=='conflict'
    assert (target/'release-updates').read_text().splitlines()==[s['desired'],s['later']]
    print('PASS: killed sender with response pending; fresh standby fetched plan; Git recorded each release exactly once; replay/receipt-only/branch-only writes refused.',flush=True)


def serve(root):
    # Disposable, unprivileged fixture. No external bind or arbitrary HTTP path.
    spec = initialize(root); target = root/'target.git'
    backend = Path(subprocess.check_output(['git','--exec-path'],text=True).strip())/'git-http-backend'
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def git_request(self):
            uri = urllib.parse.urlsplit(self.path)
            if uri.path not in ('/target.git/info/refs','/target.git/git-upload-pack','/target.git/git-receive-pack'):
                self.send_error(404);return
            size=int(self.headers.get('Content-Length',0))
            if not 0 <= size <= 4*1024*1024 or 'Transfer-Encoding' in self.headers:
                self.send_error(413);return
            body=self.rfile.read(size)
            env=dict(os.environ,GIT_PROJECT_ROOT=str(root),GIT_HTTP_EXPORT_ALL='1',PATH_INFO=uri.path,
                    QUERY_STRING=uri.query,REQUEST_METHOD=self.command,CONTENT_TYPE=self.headers.get('Content-Type',''),
                    CONTENT_LENGTH=str(size),REMOTE_USER='fixture',REMOTE_ADDR='127.0.0.1')
            out=subprocess.run([str(backend)],input=body,env=env,capture_output=True,timeout=90,check=True).stdout
            headers,_,data=out.partition(b'\r\n\r\n');self.send_response(200)
            for header in headers.decode('ascii').splitlines():
                k,v=header.split(':',1);self.send_header(k,v.strip())
            self.end_headers()
            try:self.wfile.write(data)
            except (ConnectionResetError,BrokenPipeError):pass
        do_GET=do_POST=git_request
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    print(json.dumps(dict(spec,port=server.server_port)),flush=True)
    try:
        for line in sys.stdin:
            msg=json.loads(line)
            if msg=='hold':(target/'hold-reply').touch(); out=True
            elif msg=='release':(target/'hold-reply').unlink(missing_ok=True);out=True
            elif msg=='inspect':out=(target/'release-updates').read_text().splitlines() if (target/'release-updates').exists() else []
            elif isinstance(msg,dict) and set(msg)=={'recover'}:
                name=msg['recover'];assert re.fullmatch('[a-zA-Z0-9_-]{1,50}',name)
                cloud=client(root/name,str(target),spec);out=step(cloud,'finish',spec)
            elif msg=='end':break
            else:raise ValueError('bad fixture request')
            print(json.dumps(out),flush=True)
    finally:
        (target/'hold-reply').unlink(missing_ok=True);server.shutdown();server.server_close()


if __name__=='__main__' and sys.argv[1:]==['--serve']:
    with tempfile.TemporaryDirectory(prefix='dsh-release-fixture-') as tmp:serve(Path(tmp))
elif __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='dsh-release-fixture-',ignore_cleanup_errors=True) as tmp: local_test(Path(tmp))
