"""Native DSH task exchange over a host-key-checked SSH connection. No remote shell input from a task."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

MAX = 32 * 1024 * 1024
NAME = re.compile(r'[0-9a-f]{64}\.json')

def regular(folder, name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError('Invalid packet name')
    p = folder / name
    if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX:
        raise ValueError('Not a bounded packet')
    return p

def manifest(folder):
    found = {}
    for p in folder.glob('*.json'):
        if NAME.fullmatch(p.name):
            found[p.name] = hashlib.sha256(regular(folder, p.name).read_bytes()).hexdigest()
    if len(found) > 16384:
        raise ValueError('Too many sessions')
    return found

def receive(src):
    line = src.readline(MAX * 2 + 1)
    if not line.endswith(b'\n') or len(line)>MAX*2:
        raise ValueError('Truncated or oversized packet')
    return json.loads(line)

def send(dst, obj):
    dst.write(json.dumps(obj,separators=(',', ':')).encode('ascii') + b'\n'); dst.flush()

def read_packet(folder, name):
    return base64.b64encode(regular(folder,name).read_bytes()).decode('ascii')

def store(folder, name, data, origin):
    if not NAME.fullmatch(name): raise ValueError('Invalid packet name')
    raw = base64.b64decode(data,validate=True)
    if len(raw)>MAX: raise ValueError('Packet too large')
    obj=json.loads(raw)
    if obj.get('v')!=2 or obj.get('origin')!=origin or not isinstance(obj.get('source'),str) or not re.fullmatch(r'[\w.-]{1,160}',obj['source'],re.ASCII): raise ValueError('Unexpected origin or source')
    if hashlib.sha256((origin+':'+obj['source']).encode()).hexdigest()+'.json'!=name: raise ValueError('Wrong packet identity')
    tmp=None
    try:
        with tempfile.NamedTemporaryFile(dir=folder,delete=False) as f:
            tmp=f.name; f.write(raw); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,folder/name)
    finally:
        if tmp and os.path.exists(tmp):os.unlink(tmp)

def verifier_manifest(link):
    route_file = link / 'family-route.json'
    if not route_file.exists():
        return None
    route = json.loads(route_file.read_text(encoding='utf-8-sig'))
    identity = json.loads((link / 'identity.json').read_text(encoding='utf-8'))
    if route['familyID'] != identity['id']:
        raise ValueError('Unexpected desktop identity')
    rows = json.loads((link / 'devices.json').read_text(encoding='utf-8'))['devices']
    encode = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')
    hashes = []
    for row in rows:
        scope = ':'.join(['dsh-cloud/v1', route['familyID'], route['cloudID'], route['fingerprint'], row['id']])
        key = base64.urlsafe_b64decode(row['tokenHash'] + '=')
        token = encode(hmac.digest(key, scope.encode('ascii'), 'sha256'))
        hashes.append(encode(hashlib.sha256(token.encode('ascii')).digest()))
    return dict(((k, route[k]) for k in ('familyID', 'cloudID', 'fingerprint')), hashes=hashes)


def accept_verifiers(link, grant):
    policy = json.loads((link / 'family-policy.json').read_text(encoding='utf-8'))
    if any(grant.get(k) != policy.get(k) for k in ('familyID', 'cloudID', 'fingerprint')):
        raise ValueError('Wrong family identity')
    hashes = grant.get('hashes')
    if not isinstance(hashes, list) or len(hashes) > 32 or any(not re.fullmatch(r'[A-Za-z0-9_-]{43}', h) for h in hashes):
        raise ValueError('Invalid grants')
    data = json.dumps(dict(policy, hashes=hashes), sort_keys=True).encode('utf-8')
    dest = link / 'family-grants.json'
    if dest.exists() and dest.read_bytes() == data:
        return
    with tempfile.NamedTemporaryFile(dir=link, delete=False) as tmp:
        tmp.write(data)
    os.replace(tmp.name, dest)

def main():
    mode, root = sys.argv[1:3]; root = Path(root)
    outbox,inbox = root/'outbox',root/'inbox'
    for d in (outbox,inbox):d.mkdir(mode=0o700,parents=True,exist_ok=True)
    if mode=='--peer':
        send(sys.stdout.buffer,[manifest(outbox),manifest(inbox)])
        while True:
            cmd=receive(sys.stdin.buffer)
            if cmd==['end']:break
            if cmd[0]=='family':
                accept_verifiers(root.parent/'mobile-link', cmd[1]); send(sys.stdout.buffer,True)
            elif cmd[0]=='get':send(sys.stdout.buffer,read_packet(outbox,cmd[1]))
            elif cmd[0]=='put':store(inbox,cmd[1],cmd[2],'desktop');send(sys.stdout.buffer,True)
            else:raise ValueError('Unknown request')
        return
    if mode!='--sync' or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',sys.argv[3]):raise ValueError('Invalid SSH alias')
    with subprocess.Popen(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',sys.argv[3],'sudo -n -u dsh-cloud /usr/bin/python3 /opt/dsh-cloud/task-transfer.py --peer /var/lib/dsh-cloud/.dsh/mobile-task-sync'],stdin=subprocess.PIPE,stdout=subprocess.PIPE) as p:
        try:
            offered,received=receive(p.stdout); here=manifest(inbox)
            grant = verifier_manifest(root.parent/'mobile-link')
            if grant is not None:
                send(p.stdin, ['family', grant])
                if receive(p.stdout) is not True: raise ValueError('Family sync failed')
            for name,h in offered.items():
                if here.get(name)==h:continue
                send(p.stdin,['get',name]);store(inbox,name,receive(p.stdout),'cloud')
            for name,h in manifest(outbox).items():
                if received.get(name)==h:continue
                send(p.stdin,['put',name,read_packet(outbox,name)]);assert receive(p.stdout) is True
            send(p.stdin,['end']);p.stdin.close()
            if p.wait(timeout=12):raise RuntimeError('SSH sync did not finish')
        finally:
            if p.poll() is None:p.kill()

if __name__=='__main__':main()
