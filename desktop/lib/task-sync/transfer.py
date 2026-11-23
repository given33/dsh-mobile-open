"""Native DSH task exchange over a host-key-checked SSH connection. No remote shell input from a task."""
from contextlib import contextmanager
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

MAX = 32 * 1024 * 1024
NAME = re.compile(r'[0-9a-f]{64}\.json')

CATALOG = 'workspace-catalog.json'
MODELS = 'model-preferences.json'
MAX_CATALOG = 1024 * 1024


def regular(folder, name):
    if not isinstance(name, str) or (name not in (CATALOG, MODELS) and not NAME.fullmatch(name)):
        raise ValueError('Invalid packet name')
    p = folder / name
    if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX:
        raise ValueError('Not a bounded packet')
    return p

def file_stamp(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def manifest(folder, cache=None, catalogs=False, models=False):
    entries = {}
    for p in folder.glob('*.json'):
        if not NAME.fullmatch(p.name) and not (catalogs and p.name == CATALOG) and not (models and p.name == MODELS):
            continue
        if len(entries) >= 16384:
            raise ValueError('Too many sessions')
        st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX:
            raise ValueError('Not a bounded packet')
        previous = cache.get(p.name) if cache is not None else None
        if previous and previous[0] == file_stamp(st):
            entries[p.name] = previous
            continue
        # Packets are replaced atomically. Stamp the open file, not a path that
        # could be renamed between stat and read. Unchanged packets are not opened.
        with p.open('rb') as source:
            actual = os.fstat(source.fileno())
            if not stat.S_ISREG(actual.st_mode) or actual.st_size > MAX:
                raise ValueError('Not a bounded packet')
            entries[p.name] = (file_stamp(actual), hashlib.sha256(source.read(MAX + 1)).hexdigest())
    if cache is not None:
        cache.clear()
        cache.update(entries)
    return {name: entry[1] for name, entry in entries.items()}

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
    if not isinstance(name, str) or (name not in (CATALOG, MODELS) and not NAME.fullmatch(name)): raise ValueError('Invalid packet name')
    raw = base64.b64decode(data,validate=True)
    if len(raw)>MAX: raise ValueError('Packet too large')
    obj=json.loads(raw)
    if name == MODELS:
        if len(raw) > MAX_CATALOG or origin != 'desktop' or obj.get('owner') != 'desktop' or obj.get('v') != 1 or not isinstance(obj.get('sections'), dict):
            raise ValueError('Invalid model preferences')
    elif name == CATALOG:
        if len(raw) > MAX_CATALOG or obj.get('owner') != origin or obj.get('v') != 1 or not isinstance(obj.get('workspaces'), list):
            raise ValueError('Invalid workspace catalogue')
    else:
        if obj.get('v')!=2 or obj.get('origin')!=origin or not isinstance(obj.get('source'),str) or not re.fullmatch(r'[\w.-]{1,160}',obj['source'],re.ASCII): raise ValueError('Unexpected origin or source')
        if hashlib.sha256((origin+':'+obj['source']).encode()).hexdigest()+'.json'!=name: raise ValueError('Wrong packet identity')
    durable_replace(folder, name, raw)


def durable_replace(folder, name, raw):
    tmp=None
    try:
        with tempfile.NamedTemporaryFile(dir=folder,delete=False) as f:
            tmp=f.name; f.write(raw); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,folder/name)
        # Linux can acknowledge a durable directory entry only after fsync on the directory.
        if os.name == 'posix':
            directory = os.open(str(folder), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if tmp and os.path.exists(tmp):os.unlink(tmp)

def queue_turn(root, name, blob):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError('Invalid cloud turn name')
    raw = base64.b64decode(blob, validate=True)
    if len(raw) > MAX:
        raise ValueError('Oversized cloud turn')
    packet = json.loads(raw)
    intent = packet['cloudIntent']
    sid, command = intent['session'], intent['command']
    if (packet.get('v') != 2 or packet.get('origin') != 'desktop' or sid != packet.get('source') or
            not all(isinstance(k, str) and re.fullmatch(r'[\w.-]{1,160}', k, re.ASCII) for k in (sid, command)) or
            name != hashlib.sha256(('dsh-cloud-run/v1:'+sid+':'+command).encode()).hexdigest()+'.json'):
        raise ValueError('Invalid cloud turn')
    folder = root/'cloud-incoming'
    folder.mkdir(mode=0o700, exist_ok=True)
    if not (root/'cloud-claims'/name[:-5]).exists():
        durable_replace(folder, name, raw)


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

@contextmanager
def transport_slot(root):
    """The UI and background receiver share one OS lock, released even on termination."""
    with (root / 'transport.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                if error.errno not in (11, 13):
                    raise
                yield False
                return
        else:
            import fcntl
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
        yield True


def main():
    mode, root = sys.argv[1:3]; root = Path(root)
    outbox,inbox = root/'outbox',root/'inbox'
    for d in (outbox,inbox):d.mkdir(mode=0o700,parents=True,exist_ok=True)
    out_cache, in_cache = {}, {}
    if mode=='--peer':
        watching = 'watch-v1' in sys.argv[3:]
        catalogs = 'catalog-v1' in sys.argv[3:]
        models = 'models-v1' in sys.argv[3:]
        turns = 'turns-v1' in sys.argv[3:]
        def inventory():
            return [manifest(outbox, out_cache, catalogs), manifest(inbox, in_cache, catalogs, models)]
        previous = inventory()
        send(sys.stdout.buffer, previous + (['watch-v1'] if watching else []) + (['catalog-v1'] if catalogs else []) + (['models-v1'] if models else []) + (['turns-v1'] if turns else []))
        while True:
            cmd=receive(sys.stdin.buffer)
            if cmd==['end']:break
            if cmd == ['poll'] and watching:
                current = inventory()
                send(sys.stdout.buffer, None if current == previous else current)
                previous = current
            elif cmd[0]=='turn' and turns:
                queue_turn(root, cmd[1], cmd[2]); send(sys.stdout.buffer, True)
            elif cmd[0]=='family':
                accept_verifiers(root.parent/'mobile-link', cmd[1]); send(sys.stdout.buffer,True)
            elif cmd[0]=='get' and cmd[1] != MODELS:send(sys.stdout.buffer,read_packet(outbox,cmd[1]))
            elif cmd[0]=='put' and (cmd[1] != MODELS or models):store(inbox,cmd[1],cmd[2],'desktop');send(sys.stdout.buffer,True)
            else:raise ValueError('Unknown request')
        return
    if mode not in ('--sync', '--watch', '--receive', '--mailbox') or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', sys.argv[3]):
        raise ValueError('Invalid SSH alias or transfer mode')
    with transport_slot(root) as acquired:
        if acquired:
            exchange(mode, root, sys.argv[3])


def exchange(mode, root, host):
    outbox, inbox = root/'outbox', root/'inbox'
    out_cache, in_cache = {}, {}
    command = 'sudo -n -u dsh-cloud /usr/bin/python3 /opt/dsh-cloud/task-transfer.py --peer /var/lib/dsh-cloud/.dsh/mobile-task-sync'
    if mode == '--watch':
        command += ' watch-v1'
    command += ' catalog-v1 models-v1 turns-v1'
    with subprocess.Popen(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',host, command], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as p:
        try:
            initial = receive(p.stdout)
            watching = mode == '--watch' and 'watch-v1' in initial[2:]
            catalogs = 'catalog-v1' in initial[2:]
            models = 'models-v1' in initial[2:]
            offered, received = initial[:2]
            last_grant = None
            # Bound an orphaned helper's lifetime if the host process dies without teardown.
            # Healthy hosts reopen the connection; idle polls send no digest lists.
            deadline = time.monotonic() + 60
            while True:
                here = manifest(inbox, in_cache, catalogs)
                grant = None if mode in ('--receive', '--mailbox') else verifier_manifest(root.parent/'mobile-link')
                if grant is not None and grant != last_grant:
                    send(p.stdin, ['family', grant])
                    if receive(p.stdout) is not True:
                        raise ValueError('Family sync failed')
                    last_grant = grant
                for name, digest in offered.items():
                    if name == MODELS:
                        raise ValueError('Cloud cannot publish model preferences')
                    if here.get(name) != digest:
                        send(p.stdin, ['get', name])
                        store(inbox, name, receive(p.stdout), 'cloud')
                if mode != '--receive' and 'turns-v1' in initial[2:]:
                    for job in sorted((root/'cloud-outgoing').glob('*.json')):
                        send(p.stdin, ['turn', job.name, read_packet(job.parent, job.name)])
                        if receive(p.stdout) is not True:
                            raise ValueError('Cloud did not acknowledge turn')
                        job.unlink()  # Immutable, command-specific name; the peer has fsynced it.
                if mode in ('--receive', '--mailbox'):
                    break  # No pairing credentials, outbound work, model settings, or native DSH writer.
                for name, digest in manifest(outbox, out_cache, catalogs, models).items():
                    if received.get(name) != digest:
                        send(p.stdin, ['put', name, read_packet(outbox, name)])
                        if receive(p.stdout) is not True:
                            raise ValueError('Peer did not acknowledge packet')
                if not watching or time.monotonic() >= deadline:
                    break
                time.sleep(1.5)
                send(p.stdin, ['poll'])
                update = receive(p.stdout)
                if update is not None:
                    offered, received = update
            send(p.stdin,['end']);p.stdin.close()
            if p.wait(timeout=12):raise RuntimeError('SSH sync did not finish')
        finally:
            if p.poll() is None:p.kill()

if __name__=='__main__':main()
