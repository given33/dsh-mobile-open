"""Crash/graceful failover between two native DSH profiles, with a loopback carrier/model.

Usage: py -3.11 auto_failover.py <installed DSH bin.js> <packed plugin.tgz>
No test writes leases, packets, native events or clocks. Only the carrier is replaced.
"""
import argparse
import base64
from collections import Counter
from contextlib import ExitStack
import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

from device_switch import phone
from offline_cloud_turn import Host, exchange, transfer, wait
from source_sync import authorize

FENCE_MS, DELAY_MS = 2500, 5000
SHELL = 'pwsh' if os.name == 'nt' else 'bash'


def state(host, file):
    return json.loads((host.sync / 'failover' / (file + '.json')).read_bytes())


def history(host, folder, origin, sid):
    key = hashlib.sha256(f'{origin}:{sid}'.encode()).hexdigest()
    packet = json.loads((host.sync / folder / (key + '.json')).read_bytes())
    return packet, json.loads(gzip.decompress(base64.b64decode(packet['data'])))


def conversation_cut_ready(peer_events, page):
    # The main model request is blocked, but first-prompt titling has its own
    # request. Both its delivery receipt and final provider title must have landed.
    if not any(e['type'] == 'session-log-deepseek/delivery-accepted' for e in peer_events):
        return False
    if not any(e['type'] == 'session/title' and e['data']['source']['kind'] == 'provider' for e in peer_events):
        return False
    return (not page['hasMore'] and page['cursor'] == len(peer_events) - 1 and
            [record['event'] for record in page['records']] == peer_events)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, (dict, list)):
        for item in value.values() if isinstance(value, dict) else value:
            yield from strings(item)


def send_sse(handler, model, tool=None, call_id=None, args=None, text='fixture'):
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream')
    handler.end_headers()

    def emit(kind, **fields):
        msg = json.dumps(dict(type=kind, **fields))
        handler.wfile.write(f'event: {kind}\ndata: {msg}\n\n'.encode())
        handler.wfile.flush()

    emit('message_start', message=dict(id='qa', type='message', role='assistant', model=model,
         content=[], usage=dict(input_tokens=5, output_tokens=0)))
    if tool:
        block = dict(type='tool_use', id=call_id, name=tool, input={})
        delta = dict(type='input_json_delta', partial_json=json.dumps(args or {}))
    else:
        block = dict(type='text', text='')
        delta = dict(type='text_delta', text=text)
    emit('content_block_start', index=0, content_block=block)
    emit('content_block_delta', index=0, delta=delta)
    emit('content_block_stop', index=0)
    emit('message_delta', delta=dict(stop_reason='tool_use' if tool else 'end_turn', stop_sequence=None),
         usage=dict(output_tokens=5))
    emit('message_stop')


class Model:
    def __init__(self, case):
        self.case = case
        self.source = 'cloud' if case == 'C' else 'desktop'
        self.coding = case in ('A', 'C')
        self.first, self.last, self.file = ('C', 'D', 'reverse.txt') if case == 'C' else ('A', 'B', 'step.txt')
        self.final = 'FIXTURE-FINAL-' + case
        self.calls = Counter()
        self.requests = []
        self.entered, self.release = threading.Event(), threading.Event()
        self.error = None

    def reply(self, role, req):
        if not any(t['name'] == 'relay_environment' for t in req.get('tools', [])):
            return dict(text='fixture metadata')
        self.calls[role] += 1
        n = self.calls[role]
        if role == self.source:
            self.entered.set()
            if not self.coding and n == 1:
                if not self.release.wait(90):
                    raise TimeoutError('Source conversation never interrupted')
                return dict(text='UNEXPECTED-SOURCE-COMPLETION')
            if self.coding and n == 1:
                cmd = f'''node -e "require('fs').appendFileSync('{self.file}','{self.first}')"'''
                return self.shell('sourcewrite', cmd)
            if self.coding and n == 2:
                # A finite, side-effect-free second operation. Cut only after its native
                # tool/call has arrived in the peer's checkpoint, without a tool/result.
                return self.shell('sourcepending', 'Start-Sleep -Seconds 15' if os.name == 'nt' else 'sleep 15')
        else:
            self.requests.append((time.time(), req['messages']))
            if n == 1:
                return dict(tool='relay_environment', call_id='environment')
            if n == 2 and self.coding:
                cmd = (f'''node -e "const f=require('fs'),p='{self.file}';'''
                       f'''if(f.readFileSync(p,'utf8')!=='{self.first}')process.exit(1);'''
                       f'''f.appendFileSync(p,'{self.last}')"''')
                return self.shell('targetwrite', cmd)
            if n == (3 if self.coding else 2):
                return dict(text=self.final)
        raise AssertionError(f'Unexpected execution on {role}, request {n}')

    @staticmethod
    def shell(call_id, cmd):
        return dict(tool=SHELL, call_id=call_id, args=dict(command=cmd, description=call_id))

    def serve(self, stack):
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_POST(self):
                try:
                    req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    answer = fixture.reply(self.path.split('/')[1], req)
                    send_sse(self, req['model'], **answer)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # Expected for the interrupted conversation's HTTP request.
                except Exception as exc:
                    fixture.error = exc
                    self.send_error(500)

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.server_close)
        stack.callback(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}'

    def verify_reports(self):
        # Inspect actual messages sent to the model, not its system prompt or fixture output.
        marker = '执行设备已切换。'
        text = next(s for s in strings(self.requests[0][1]) if marker in s and '{' in s.split(marker, 1)[1])
        report, _ = json.JSONDecoder().raw_decode(text[text.index('{', text.index(marker)):])
        assert report['toolchain'] and report['to'].startswith(('desktop/' if self.source == 'cloud' else 'cloud/'))
        env_block = next(block for m in self.requests[1][1] for block in m.get('content', [])
                         if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') == 'environment')
        env = next(json.loads(s) for s in strings(env_block['content']) if s.lstrip().startswith('{'))
        assert env['handoff']['boundary'] == 'auto-failover', env['handoff']
        assert env['toolchain']['sourceSyncSummary']['enrolled'] is self.coding
        for progress in (report['progress'], env['taskProgress']):
            if self.coding:
                assert [r['next'] for r in progress['recent'] if r['tool'] == SHELL] == [
                    'use-result-do-not-repeat', 'verify-before-retry'], progress['recent']


def graceful_start(host):
    if os.name != 'nt':
        return host.start()
    # Isolate Ctrl+C in a new hidden console. Never broadcast to the test runner's console.
    launch = subprocess.Popen
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = subprocess.SW_HIDE
    with patch.object(subprocess, 'Popen', side_effect=lambda *a, **kw: launch(
            *a, **kw, creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=si)):
        host.start()


def interrupt(host):
    if os.name != 'nt':
        host.proc.send_signal(signal.SIGINT)
        return
    helper = '''import ctypes, sys, time
k = ctypes.windll.kernel32
k.FreeConsole()  # CREATE_NO_WINDOW may still attach a private console.
assert k.AttachConsole(int(sys.argv[1])), ctypes.WinError()
assert k.SetConsoleCtrlHandler(None, True), ctypes.WinError()
assert k.GenerateConsoleCtrlEvent(0, 0), ctypes.WinError()
time.sleep(.1)
'''
    subprocess.run([sys.executable, '-c', helper, str(host.proc.pid)], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=3)


def scenario(root, cli, tgz, case):
    model = Model(case)
    with ExitStack() as stack:
        url = model.serve(stack)
        # DSH's independent SSH watcher must not open SSH (or race the carrier under test).
        # Gate only its --watch invocation at interpreter startup, not transfer.main/--peer.
        guard = root / 'guard'
        guard.mkdir()
        (guard / 'sitecustomize.py').write_text("import os, sys\nif os.path.basename(sys.argv[0]) == 'transfer.py' and sys.argv[1:2] == ['--watch']:\n    os._exit(1)\n")
        hosts = {}
        for role in ('desktop', 'cloud'):
            h = hosts[role] = Host(root / role, cli, tgz, url + '/' + role)
            h.env.update(PYTHONPATH=str(guard), PYTHONDONTWRITEBYTECODE='1')
            config = h.root / 'profiles/web/cordis.patch.yml'
            config.write_text(config.read_text(encoding='utf-8').replace('enabled: false',
                'enabled: true\n    host: 127.0.0.1\n    actions: true').replace('fixture.invalid', '127.0.0.1').replace('cloudTurns: true',
                f'cloudTurns: true, turnRelay: true, sourceFenceMs: {FENCE_MS}, takeoverDelayMs: {DELAY_MS}, spawnShutdownSync: false'), encoding='utf-8')
            stack.callback(h.stop)
            if case == 'B' and role == 'desktop':
                graceful_start(h)
            else:
                h.start()
        stack.callback(model.release.set)
        desktop, cloud = hosts.values()
        source = hosts[model.source]
        target = desktop if source is cloud else cloud
        dest = target.root.name
        controls = {h: phone(h) for h in hosts.values()}

        def sync(mode='--sync'):
            if model.error:
                raise model.error
            return exchange(desktop, cloud, mode, relay=True, sources=True, failover=True)

        workspace = desktop.root / 'project'
        workspace.mkdir()
        wid = desktop.rpc('workspace/create', {'path': str(workspace)})['workspace']['workspaceId']
        key = hashlib.sha256(('desktop:' + wid).encode()).hexdigest()
        replica = cloud.sync / 'workspaces' / key
        if model.coding:
            authorize(desktop.sync, key, workspace, [model.file])
        source_wid = wid
        if source is cloud:
            # The cloud owns C's first native turn. Opening the same fresh session
            # independently on both hosts would create two different seed histories.
            def cloud_workspace():
                sync()
                return next((i for i, row in cloud.registry().items() if Path(row['path']) == replica), None)
            source_wid = wait(cloud_workspace)
        sid = source.rpc('session/create', {'workspaceId': source_wid})['sessionId']
        wait(lambda: sync() and any(sid in row['sessionIds'] for row in target.registry().values()) and
             (not model.coding or (cloud.sync / 'source-grants' / (key + '.json')).is_file()))
        for h, rpc in controls.items():
            cap = rpc('status', {})
            assert cap['protocol'] == 1 and cap['autoFailover'] is True and cap['role'] == h.root.name, cap
        source.prompt(sid, 'Complete the two fixture edits in order.' if model.coding else 'Finish the fixture conversation.')

        def before_cut():
            sync()
            local = state(source, 'local-state')['active'].get(sid, {})
            peer = state(target, 'peer-observed')['active'].get(sid, {})
            if not local.get('armed') or not peer.get('peerArmed') or not model.entered.is_set():
                return False
            assert not local.get('fenced') and local['epoch'] == peer['epoch']
            packet, events = history(target, 'inbox', model.source, sid)
            if packet.get('failoverEpoch') != local['epoch'] or not any(e['type'] == 'step/start' for e in events):
                return False
            if model.coding:
                if not packet.get('sourceFence') or not all((p / model.file).read_bytes() == model.first.encode() for p in (workspace, replica)):
                    return False
                calls = [e['data']['callId'] for e in events if e['type'] == 'tool/call']
                results = [e['data']['message'] for e in events if e['type'] == 'tool/result']
                if calls != ['sourcewrite', 'sourcepending']:
                    return False
                assert len(results) == 1 and results[0]['source']['callId'] == 'sourcewrite' and not results[0]['isError']
            if case == 'D':
                page = source.rpc('session/page', {'address': {'kind': 'session', 'sessionId': sid}})
                if not conversation_cut_ready(events, page):
                    return False
            return peer

        seen = wait(before_cut)
        live = controls[source]('status', {'sessionId': sid})
        assert live['state'] == 'running' and live['armed'] and live['protocol'] == 1, live
        last_seen = state(target, 'peer-observed')['lastSeenAt']
        if case == 'B':
            interrupt(desktop)
            wait(lambda: desktop.proc.poll() is not None, timeout=DELAY_MS / 1000)
            surrendered = state(desktop, 'local-state')['surrenders'][sid]
            sealed = json.loads((desktop.sync / 'relay-outgoing' / (claim_id(sid, surrendered['command']) + '.json')).read_bytes())
            assert sealed['cloudIntent']['trigger'] == 'shutdown' and sealed['failoverClosers'] == []
            prefix = json.loads(gzip.decompress(base64.b64decode(sealed['data'])))
            assert surrendered['baseSeq'] == len(prefix)
            native_log, = (desktop.root / 'sessions').glob(f'*/{sid}/session*.jsonl*')
            native_prefix = native_log.read_bytes()
            assert native_prefix
            original_ids = desktop.registry()[wid]['sessionIds']
        source.stop()  # A/C/D: immediate hard kill. B: only reap the already exited process.
        model.release.set()
        assert source.proc is None

        def finished():
            if source is cloud:
                sync()  # SSH remains reachable, even after the cloud DSH heartbeat goes stale.
            elif case == 'B':
                sync('--mailbox')  # Deliver the real shutdown packet, not a synthesized timeout.
            if model.error:
                raise model.error
            _, events = history(target, 'outbox', dest, sid)
            ends = [e['data']['reason'] for e in events if e['type'] == 'turn/end']
            first_end = {'kind': 'aborted', 'reason': {'kind': 'disposed'}} if case == 'B' else {'kind': 'interrupted'}
            if ends[-2:] == [first_end, {'kind': 'completed'}] and any(model.final == s for s in strings(events)):
                return events
            return False

        done = wait(finished)
        model.verify_reports()
        elapsed = model.requests[0][0] * 1000 - seen['leaseRenewedAt']
        if case == 'B':
            assert 0 <= elapsed < DELAY_MS, f'Not an immediate shutdown takeover: {elapsed:.0f}ms'
        else:
            assert elapsed >= DELAY_MS, f'Premature timeout: {elapsed:.0f}ms'
        if case == 'C':
            observed = state(desktop, 'peer-observed')
            assert observed['lastSeenAt'] > last_seen, 'No exchanges while the stopped host heartbeat was still fresh'
            assert model.requests[0][0] * 1000 - observed['active'][sid]['leaseRenewedAt'] >= DELAY_MS
            assert transfer.failover_frame(cloud.sync, 'cloud')['hostAlive'] is False
            sync()
            stale = state(desktop, 'peer-observed')
            assert stale['lastSeenAt'] == observed['lastSeenAt']
            assert stale['active'][sid]['leaseRenewedAt'] == observed['active'][sid]['leaseRenewedAt']
        accepted = controls[target]('status', {'sessionId': sid})
        assert accepted['protocol'] == 1 and accepted['state'] == 'accepted' and accepted['activeCommand'], accepted
        if case == 'B':
            assert accepted['activeCommand'] == surrendered['command']
            assert done[:len(prefix)] == prefix
        assert sum(e['type'] == 'user/message' and e['data'].get('source', {}).get('rpcId') ==
                   claim_id(sid, accepted['activeCommand']) for e in done) == 1
        if model.coding:
            assert [e['data']['callId'] for e in done if e['type'] == 'tool/call'] == [
                'sourcewrite', 'sourcepending', 'environment', 'targetwrite']
            assert (workspace if dest == 'desktop' else replica).joinpath(model.file).read_text() == model.first + model.last
        if case == 'A':
            repo = cloud.sync / 'source-backups' / (key + '.git')
            git = ['git', '--git-dir=' + str(repo)]
            assert subprocess.check_output(git + ['rev-parse', '--is-bare-repository']).strip() == b'true'
            revs = subprocess.check_output(git + ['log', '--format=%H', '--', model.file]).decode().splitlines()
            assert any(subprocess.check_output(git + ['show', rev + ':' + model.file]) == b'A' for rev in revs)
        if source is desktop:
            def received():
                sync('--mailbox')
                assert state(cloud, 'peer-observed')['lastSeenAt'] == last_seen
                return history(desktop, 'inbox', 'cloud', sid)[1] == done and (not model.coding or
                        (workspace / model.file).read_bytes() == b'AB')
            wait(received)
            assert desktop.proc is None
            desktop.start()
            wait(lambda: model.final in desktop.page(sid))
            assert sid in desktop.registry()[wid]['sessionIds']
            if case == 'D':
                page = desktop.rpc('session/page', {'address': {'kind': 'session', 'sessionId': sid}})
                assert not page['hasMore'] and [r['event'] for r in page['records']][:len(done)] == done
            if case == 'B':
                wait(lambda: history(desktop, 'outbox', 'desktop', sid)[1][:len(done)] == done)
                assert desktop.registry()[wid]['sessionIds'] == original_ids
                assert native_log.read_bytes().startswith(native_prefix), 'Native desktop log prefix was rewritten'
        # Leave the same checkpoint available across several real receiver ticks.
        for _ in range(3):
            sync()
            time.sleep(.4)
        if model.error:
            raise model.error
        assert model.calls == {model.source: 2 if model.coding else 1, dest: 3 if model.coding else 2}, model.calls
        print(f'PASS {case}: {model.source}->{dest}, source/peer armed, takeover after {elapsed:.0f}ms, '
              f'{accepted["state"]}, one native continuation; ' + (model.first + model.last if model.coding else 'no source grant'), flush=True)


def claim_id(sid, command):
    return hashlib.sha256(f'dsh-cloud-run/v1:{sid}:{command}'.encode()).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dsh_cli', type=Path)
    parser.add_argument('plugin_tgz', type=Path)
    parser.add_argument('--case', choices=list('ABCD'), action='append')
    args = parser.parse_args()
    for case in args.case or 'ABCD':
        with tempfile.TemporaryDirectory(prefix='dsh-f-', dir=Path.home()) as tmp:
            root = Path(tmp)
            with patch.dict(os.environ, {'DSH_HOME': str(root / 'bootstrap'), 'npm_config_offline': 'true',
                            'npm_config_cache': str(root / 'npm-cache'), 'npm_config_store_dir': str(root / 'store'),
                            'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}):
                scenario(root, args.dsh_cli.resolve(strict=True), args.plugin_tgz.resolve(strict=True), case)
