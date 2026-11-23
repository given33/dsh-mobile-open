"""Two native DSH hosts, no production profile/SSH key/model. Pass CLI and plugin.tgz paths.

The desktop creates the workspace and first turn. The second turn is admitted by the
cloud host, not started twice. Cut desktop/network during its model stream, then run
only the real transfer protocol and verify the result before restarting desktop DSH.
"""
import argparse
import base64
import gzip
import hashlib
import http.cookiejar
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from unittest.mock import patch

TRANSFER = Path(__file__).resolve().parents[2] / 'lib/task-sync/transfer.py'
spec = importlib.util.spec_from_file_location('transfer', TRANSFER)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


def wait(fn, timeout=75):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result:
                return result
        except (FileNotFoundError, PermissionError):
            pass
        time.sleep(.2)
    raise TimeoutError(fn)


class Host:
    def __init__(self, root, cli, package, provider):
        self.root = root
        self.sync = root / 'mobile-task-sync'
        root.mkdir()
        self.cli = str(cli)
        self.proc = None
        self.env = dict(os.environ, DSH_HOME=str(root), DEEPSEEK_API_KEY='fixture-only', DEEPSEEK_BASE_URL=provider)
        subprocess.run(['node', self.cli, 'plugin', '--profile', 'web', 'add', str(package)], cwd=root,
                       env=self.env, stdout=subprocess.DEVNULL, check=True)
        (root/'profiles/web/cordis.patch.yml').write_text(
            "- id: mobile-link\n  name: 'dsh-mobile-link'\n  config:\n    enabled: false\n    port: 0\n"
            f"    taskSync: {{role: {root.name}, sshHost: fixture.invalid, cloudTurns: true}}\n"
            f"- id: llm-deepseek\n  config:\n    baseURL: {provider}\n", encoding='utf-8')

    def start(self):
        self.log = (self.root/'qa.log').open('wb')
        self.proc = subprocess.Popen(['node', self.cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
                                     stdout=self.log, stderr=subprocess.STDOUT, cwd=self.root, env=self.env)
        link = wait(lambda: re.search(r'(http://127\.0\.0\.1:\d+/)\?token=[\w.%-]+',
                                      (self.root/'qa.log').read_text(encoding='utf-8', errors='replace')))
        self.base = link[1]
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.http.open(link[0], timeout=10).close()

    def stop(self):
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait(timeout=15)
            self.log.close()
            self.proc = None

    def rpc(self, name, request):
        body = dict(type='client-request', method=name, rpcId=uuid.uuid4().hex, payload=dict(args=request if name=='commands/execute' else dict(request=request)))
        response = self.http.open(urllib.request.Request(self.base+'api/'+name, data=json.dumps(body).encode(),
                                  headers={'Content-Type': 'application/json'}), timeout=12)
        with response:
            result = json.load(response)['result']
        assert result['ok'], (name, result.get('error'))
        return result['value']

    def page(self, sid):
        return json.dumps(self.rpc('session/page', {'address': {'kind': 'session', 'sessionId': sid}}))

    def prompt(self, sid, text):
        result = self.rpc('session/prompt', dict(sessionId=sid, requestId=str(uuid.uuid4()), mode='queue', content=[dict(type='text', text=text)]))
        assert result['accepted']

    def registry(self):
        return json.loads((self.root/'storages/workspace.json').read_bytes())['tables']['workspaces']


def exchange(desktop, cloud, mode):
    # Only the carrier changes; peer, validation, digests, fsync and mailbox paths are real.
    spawn = subprocess.Popen
    def loopback(argv, **kw):
        assert argv[0] == 'ssh' and 'StrictHostKeyChecking=yes' in argv
        return spawn([sys.executable, str(TRANSFER), '--peer', str(cloud.sync), 'catalog-v1', 'models-v1', 'turns-v1'], **kw)
    with patch.object(subprocess, 'Popen', side_effect=loopback), patch.object(sys, 'argv', [str(TRANSFER), mode, str(desktop.sync), 'fixture']):
        transfer.main()
    return True


def test(root, cli, package, cut):
    streaming, finish = threading.Event(), threading.Event()
    calls = []
    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            cloud = 'OFFLINE-CHALLENGE' in json.dumps(request.get('messages', []))
            calls.append(cloud)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            def emit(kind, **data):
                self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(dict(type=kind, **data))+'\n\n').encode())
                self.wfile.flush()
            emit('message_start', message=dict(id='qa',type='message',role='assistant',model=request['model'],content=[],usage=dict(input_tokens=4,output_tokens=0)))
            emit('content_block_start',index=0,content_block=dict(type='text',text=''))
            if cloud:
                emit('content_block_delta',index=0,delta=dict(type='text_delta',text='PROGRESS '))
                streaming.set()
                assert finish.wait(50)
            emit('content_block_delta',index=0,delta=dict(type='text_delta',text='DURABLE-FINAL' if cloud else 'LOCAL-RESULT'))
            emit('content_block_stop',index=0)
            emit('message_delta',delta=dict(stop_reason='end_turn',stop_sequence=None),usage=dict(output_tokens=2))
            emit('message_stop')

    server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = 'http://127.0.0.1:' + str(server.server_port)
    desktop, cloud = [Host(root/name, cli, package, url) for name in ('desktop', 'cloud')]
    try:
        desktop.start()
        cloud.start()
        workspace = desktop.root/'Test workspace'
        workspace.mkdir()
        wid = desktop.rpc('workspace/create', {'path': str(workspace)})['workspace']['workspaceId']
        sid = desktop.rpc('session/create', {'workspaceId': wid})['sessionId']
        desktop.prompt(sid, 'LOCAL-FIRST')
        wait(lambda: 'LOCAL-RESULT' in desktop.page(sid))
        wait(lambda: exchange(desktop, cloud, '--sync') and any(sid in row['sessionIds'] for row in cloud.registry().values()) and 'LOCAL-RESULT' in cloud.page(sid))
        body = json.dumps(dict(sessionId=sid,text='OFFLINE-CHALLENGE')).encode()
        request = urllib.request.Request(desktop.base+'dsh-mobile-link/cloud-run',data=body,headers={'Content-Type':'application/json'})
        with desktop.http.open(request, timeout=20) as response:
            command = json.load(response)
        assert command['result']['kind']=='success', command
        if cut == 'before-transfer':
            desktop.stop()
            # DSH has exited before its foreground SSH watcher ever saw this command.
            assert len(list((desktop.sync/'cloud-outgoing').glob('*.json'))) == 1
            exchange(desktop, cloud, '--mailbox')
            assert streaming.wait(35)
        else:
            wait(lambda: exchange(desktop, cloud, '--sync') and streaming.is_set())
            desktop.stop()
        finish.set()
        wait(lambda: 'DURABLE-FINAL' in cloud.page(sid))
        packet = hashlib.sha256(('cloud:'+sid).encode()).hexdigest()+'.json'
        def settled(folder):
            payload = json.loads((folder/packet).read_bytes())
            events = json.loads(gzip.decompress(base64.b64decode(payload['data'])))
            end = next((e for e in reversed(events) if e['type']=='turn/end'), None)
            return end and end['data']['reason']['kind']=='completed' and 'DURABLE-FINAL' in json.dumps(events[:end['seq']])
        # No transport was running while the model finished.
        wait(lambda: settled(cloud.sync/'outbox'))
        assert desktop.proc is None
        exchange(desktop, cloud, '--receive')
        assert settled(desktop.sync/'inbox')
        print('Cloud completed with desktop absent; native result received on disk with desktop still absent.', flush=True)
        desktop.start()
        wait(lambda: 'DURABLE-FINAL' in desktop.page(sid))
        assert sid in desktop.registry()[wid]['sessionIds']
        assert calls.count(True)==1, calls
        print('Same native workspace/session after restart; cloud challenge executed once.', flush=True)
    finally:
        finish.set()
        for host in (desktop, cloud): host.stop()
        server.shutdown()
        server.server_close()


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dsh_cli', type=Path)
    parser.add_argument('plugin_tgz', type=Path)
    parser.add_argument('--cut', choices=['before-transfer','after-accept'], default='after-accept')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='dsh-offline-', ignore_cleanup_errors=True) as tmp:
        test(Path(tmp), args.dsh_cli.resolve(strict=True), args.plugin_tgz.resolve(strict=True), args.cut)
