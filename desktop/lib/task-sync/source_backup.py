"""Private Git restore points for already authorized, applied source. Never contacts a remote."""
import hashlib
import os
import subprocess
import tempfile
import time
import shutil


def backup(root, key, journal, epoch, seq, allowed):
    repo = root / 'source-backups' / (key + '.git')
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')

    def git(*args, stream=None, check=True):
        return subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, '--git-dir=' + str(repo), *args],
                              cwd=root, env=env, stdin=stream or subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=35, check=check)

    with journal.locked():
        fence = journal.fence()
        if not fence['ready'] or fence['peerEpoch'] != epoch or fence['received'] < seq:
            return fence
        repo.parent.mkdir(mode=0o700, exist_ok=True)
        if not (repo / 'HEAD').exists():
            repo.mkdir(mode=0o700, exist_ok=True)
            git('init', '--bare', '--template=', '--initial-branch=checkpoints')
        rows = list(journal.db.execute('SELECT path,id FROM disk ORDER BY path'))
        names = [p for p, _ in rows if allowed(p,journal.scopes)]
        ignored = journal.ignored(names)
        fingerprint = hashlib.sha256()
        # An isolated stream imports literal journal bytes: no working tree checkout, attributes,
        # clean filters, hooks, user identity, upstream remote or network credentials.
        with tempfile.TemporaryFile(dir=repo.parent) as stream:
            for path, version in rows:
                if not allowed(path,journal.scopes) or path in ignored:
                    continue
                data = journal.data(version)
                if data is None:
                    continue
                name = path.encode('utf8')
                fingerprint.update(name + b'\0' + hashlib.sha256(data).digest())
                stream.write(b'M 100644 inline ' + name + b'\ndata ' + str(len(data)).encode() + b'\n' + data + b'\n')
            stamp = 'DSH source ' + fingerprint.hexdigest()
            previous = git('rev-parse','--verify','--quiet','refs/heads/checkpoints',check=False)
            if previous.returncode not in (0,1):
                raise ValueError('Cannot inspect Git backup')
            parent = previous.stdout.strip()
            if not parent or git('show','-s','--format=%s',parent.decode()).stdout.strip() != stamp.encode():
                with tempfile.TemporaryFile(dir=repo.parent) as packet:
                    packet.write(('commit refs/heads/checkpoints\ncommitter DSH <checkpoint@localhost> '
                                  + str(int(time.time())) + ' +0000\ndata ' + str(len(stamp)) + '\n' + stamp + '\n').encode())
                    if parent:
                        packet.write(b'from ' + parent + b'\n')
                    packet.write(b'deleteall\n'); stream.seek(0); shutil.copyfileobj(stream,packet)
                    packet.write(b'\ndone\n'); packet.seek(0)
                    git('fast-import','--quiet','--done',stream=packet)
            fence['gitCommit'] = git('rev-parse','--verify','refs/heads/checkpoints').stdout.strip().decode()
            return fence
