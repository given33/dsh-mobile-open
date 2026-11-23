"""Two isolated native hosts and a scripted model: surrender a real tool turn, stop that host,
then require the peer to discover its OS, execute a native npm build, and finish another model round.
No production model key, workspace, deploy command or elevated shell is used.
"""
import argparse, base64, hashlib, http.server, io, json, os, shutil, subprocess, tarfile, tempfile, threading, time, uuid
from pathlib import Path
from offline_cloud_turn import Host, wait, exchange, transfer


def create_project(workspace, marker):
    # An ordinary offline npm project: no relay SDK imports, custom checkpoint API,
    # registry token or network. Only explicitly listed inputs travel to the peer.
    package = {"name":"relay-fixture", "version":"1.0.0", "private":True,
               "dependencies":{"relay-local-lib":"file:vendor/packages/lib.tgz"},
               "scripts":{"build":"node scripts/build.cjs", "checkpoint":"node checkpoint.cjs"}}
    for folder in ['scripts', 'src/data', 'vendor/packages']:
        (workspace / folder).mkdir(parents=True)
    (workspace/'package.json').write_text(json.dumps(package), encoding='utf8')
    (workspace/'src/data/marker.json').write_text(json.dumps(marker), encoding='utf8')
    (workspace/'scripts/build.cjs').write_text(
        "const fs = require('node:fs'); const format = require('relay-local-lib');\n"
        "const marker = require('../src/data/marker.json');\n"
        "if (fs.readFileSync(require.resolve('relay-local-lib/chunks/1599.txt'),'utf8') !== '1599') throw Error('partial install');\n"
        "fs.appendFileSync('build-count', '1'); console.log(format(marker));\n", encoding='utf8')
    (workspace/'checkpoint.cjs').write_text("require('node:fs').appendFileSync('source-count','1'); console.log('RELAY-CHECKPOINT-' + " + repr(marker) + ');', encoding='utf8')
    artifact = workspace/'vendor/packages/lib.tgz'
    dependency = {"name":"relay-local-lib", "version":"1.0.0", "main":"index.cjs",
                  "scripts":{"postinstall":"node postinstall.cjs"}}
    with tarfile.open(artifact, 'w:gz') as tar:
        for name, text in [('package.json', json.dumps(dependency)),
                           ('index.cjs', "module.exports = marker => 'RELAY-BUILD-OK-' + marker;"),
                           ('postinstall.cjs', "require('fs').writeFileSync('hook-ran','not allowed');")]:
            data = text.encode(); entry = tarfile.TarInfo('package/'+name); entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
        # Enough entries to observe and kill the real npm process in the middle of
        # extraction, rather than merely killing a shell before/after npm ran.
        for index in range(1600):
            data = str(index).encode(); entry = tarfile.TarInfo(f'package/chunks/{index}.txt'); entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    subprocess.run([npm,'install','--package-lock-only','--ignore-scripts','--no-fund','--no-audit','--offline','--cache','.fixture-cache'],
                   cwd=workspace, check=True, stdout=subprocess.DEVNULL, timeout=40)
    return ['package.json','package-lock.json','scripts/build.cjs','src/data/marker.json','vendor/packages/lib.tgz']


def cut_install(workspace):
    # Invoke npm's real Node entrypoint (not a shell wrapper); the only PID killed
    # is the child we just started for this isolated fixture. No install hooks run.
    npm = Path(shutil.which('npm.cmd' if os.name == 'nt' else 'npm'))
    cli = npm.parent/'node_modules/npm/bin/npm-cli.js' if os.name == 'nt' else npm.resolve()
    assert cli.is_file() and cli.name == 'npm-cli.js', cli
    args = ['node',str(cli),'ci','--ignore-scripts','--no-audit','--no-fund','--offline','--cache','.fixture-cache']
    installed = workspace/'node_modules/relay-local-lib'
    with (workspace/'install.log').open('wb') as log, subprocess.Popen(args,cwd=workspace,stdout=log,stderr=subprocess.STDOUT) as proc:
        try:
            deadline = time.monotonic()+35
            while proc.poll() is None and time.monotonic()<deadline:
                if (installed/'index.cjs').is_file() and not (installed/'chunks/1599.txt').exists():
                    proc.kill(); assert proc.wait(timeout=10) != 0
                    assert not (installed/'chunks/1599.txt').exists() and not (workspace/'node_modules/.package-lock.json').exists()
                    print('Source npm killed after package extraction began, before the last file or install receipt existed.',flush=True)
                    return
                time.sleep(.002)
            raise AssertionError('Did not observe an in-progress source install')
        finally:
            if proc.poll() is None: proc.kill(); proc.wait(timeout=10)


def test(root, cli, package, origin, export=None, incoming=None, paired_cut=False):
    target = 'cloud' if origin == 'desktop' else 'desktop'
    reports, native_calls, source_advanced, evidence = [], [], [], []
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            tools = {t['name'] for t in req.get('tools', [])}
            role = self.path.split('/')[1]
            text, tool, args = 'Fixture', None, {}
            if 'relay_remaining_task' in tools:
                history = json.dumps(req['messages'], ensure_ascii=False)
                native_calls.append(role)
                if role == origin:
                    if 'DSH-RELAY/1' in history:
                        source_advanced.append(True); text = 'UNEXPECTED-SOURCE-CONTINUATION'
                    elif 'RELAY-CHECKPOINT-' + marker not in history:
                        tool = 'pwsh' if os.name == 'nt' else 'bash'
                        args = dict(command='npm run checkpoint',description='Record the fixture checkpoint')
                    elif 'planObject' not in history:
                        tool = 'relay_git_release_plan'
                        args = dict(remote='origin',branch='release',identity='1'*40,base='2'*40,desired='3'*40)
                    else: tool = 'relay_remaining_task'
                elif '"foundOnPath"' not in history.replace('\\"','"'):
                    tool = 'relay_environment'
                elif 'RELAY-BUILD-OK-' + marker not in history:
                    for message in req['messages']:
                        for block in message.get('content', []):
                            if not isinstance(block, dict) or block.get('type') != 'tool_result': continue
                            content = block.get('content', [])
                            for part in content if isinstance(content,list) else [content]:
                                raw = part.get('text','') if isinstance(part,dict) else part
                                try: result = json.loads(raw)
                                except (ValueError, TypeError): continue
                                if isinstance(result, dict) and result.get('handoff'): evidence.append(result)
                    tool = 'pwsh' if os.name == 'nt' else 'bash'
                    setup = evidence[-1]['nodeSetup']
                    assert setup['modules']=='absent' and setup['locks']==['package-lock.json']
                    install = setup['freshInstall'] + ' --offline --cache .fixture-cache'
                    if install not in history:
                        args = dict(command=install,description='Install the locked dependency from the project tarball')
                    elif setup['verify'] + ' relay-local-lib' not in history:
                        args = dict(command=setup['verify']+' relay-local-lib',description='Verify the receiver installation')
                    elif 'relay-local-lib@1.0.0' in history and 'Run the fixture build' not in history:
                        args = dict(command='npm run build',description='Run the fixture build')
                    else:
                        tool = None; text = 'FIXTURE-ERROR'; reports.append(text)
                        print('Fixture tool failed:', str(req['messages'][-1])[-1100:],flush=True)
                else:
                    text = 'MODEL-FINAL-' + marker
                    reports.append(text)
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            def emit(kind, **fields):
                self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(dict(type=kind,**fields))+'\n\n').encode()); self.wfile.flush()
            emit('message_start',message=dict(id='qa',type='message',role='assistant',model=req['model'],content=[],usage=dict(input_tokens=5,output_tokens=0)))
            if tool:
                emit('content_block_start',index=0,content_block=dict(type='tool_use',id=uuid.uuid4().hex,name=tool,input={}))
                emit('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=json.dumps(args)))
            else:
                emit('content_block_start',index=0,content_block=dict(type='text',text=''))
                emit('content_block_delta',index=0,delta=dict(type='text_delta',text=text))
            emit('content_block_stop',index=0);emit('message_delta',delta=dict(stop_reason='tool_use' if tool else 'end_turn',stop_sequence=None),usage=dict(output_tokens=5));emit('message_stop')
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    fixture = json.loads(incoming.read_bytes()) if incoming else None
    marker = fixture['marker'] if fixture else uuid.uuid4().hex
    assert len(marker)==32 and all(c in '0123456789abcdef' for c in marker)
    hosts = {}
    try:
        roles = (target,) if fixture else (origin,) if export else (origin,target)
        for r in roles:
            host = Host(root/r,cli,package,'http://127.0.0.1:'+str(server.server_port)+'/'+r)
            cfg = host.root/'profiles/web/cordis.patch.yml'
            cfg.write_text(cfg.read_text('utf8').replace('cloudTurns: true','cloudTurns: true, turnRelay: true'),encoding='utf8')
            hosts[r] = host; host.start()
        if not fixture:
            source = hosts[origin]
            workspace = source.root/'Source workspace'; workspace.mkdir()
            wid = source.rpc('workspace/create',{'path':str(workspace)})['workspace']['workspaceId']
            sid = source.rpc('session/create',{'workspaceId':wid})['sessionId']
            inputs = create_project(workspace, marker)
            (workspace/'not-shared.txt').write_text('private fixture')
            source.sync.mkdir(exist_ok=True)
            (source.sync/'relay-inputs.json').write_text(json.dumps({origin+':'+wid:inputs}))
            source.prompt(sid,'Continue the fixture build on the paired host.')
            job = wait(lambda:next((source.sync/'relay-outgoing').glob('*.json'),None),50)
            job_contents = job.read_bytes()
            if not paired_cut: source.stop()
            assert not source_advanced and native_calls and all(r==origin for r in native_calls)
            assert not (workspace/'build-count').exists() and (workspace/'source-count').read_text() == '1'
            if export:
                payload = json.dumps(dict(marker=marker,wid=wid,sid=sid,job=job.name,
                        packet=base64.b64encode(job_contents).decode('ascii'))).encode('utf8')
                temp = export.with_suffix('.tmp'); temp.write_bytes(payload); temp.replace(export)
                if paired_cut:
                    receipt = export.with_suffix('.paired')
                    wait(lambda: receipt.is_file() and receipt.read_text('ascii').strip()==hashlib.sha256(payload).hexdigest(),90)
                    cut_install(workspace)
                    source.stop()
                print('Real %s DSH sealed its tool turn and exited.'%os.name,flush=True)
                return
        else:
            wid,sid = fixture['wid'],fixture['sid']
        dest = hosts[target]
        peer_work = dest.sync/'workspaces'/hashlib.sha256((origin+':'+wid).encode()).hexdigest()
        assert not (peer_work/'package.json').exists()
        if fixture: transfer.queue_turn(dest.sync,fixture['job'],fixture['packet'],origin,True)
        else: exchange(hosts['desktop'],hosts['cloud'],'--mailbox',relay=True)
        wait(lambda: reports,75)
        assert reports[-1]=='MODEL-FINAL-'+marker, reports
        wait(lambda: reports[-1] in dest.page(sid))
        assert (peer_work/'node_modules/relay-local-lib/index.cjs').is_file()
        assert not (peer_work/'node_modules/relay-local-lib/hook-ran').exists()
        assert not (peer_work/'not-shared.txt').exists()
        assert (peer_work/'build-count').read_text() == '1'
        assert not (peer_work/'source-count').exists() and not (peer_work/'checkpoint.cjs').exists()
        assert evidence and evidence[0]['platform'] == ('win32' if os.name == 'nt' else 'linux'), 'missing host evidence'
        h = evidence[0]['handoff']
        assert len(h['gitReleases']) == 1 and h['gitReleases'][0]['desired'] == '3'*40 and len(h['gitReleases'][0]['operation']) == 64
        assert h['from'] == origin and h['to'] == target and h['externalEffects'] == 'not-verified'
        assert any(s['name'] in ('pwsh','bash') and s['result'] == 'reported-success' for s in h['priorCalls'])
        jobname = fixture['job'] if fixture else job.name
        assert h['requestId'] + '.json' == jobname
        # Simulate power loss after native acceptance but before writing the local ack.
        # Restore only a disposable inbox file and fence. Do not send a second prompt.
        fence = dest.sync/'cloud-claims'/h['requestId']
        assert wait(lambda: b'accepted' in fence.read_bytes())
        wait(lambda: not (dest.sync/'relay-incoming'/jobname).exists())
        raw = base64.b64decode(fixture['packet']) if fixture else job_contents
        fence.write_bytes(b'claimed\n')
        transfer.durable_replace(dest.sync/'relay-incoming', jobname, raw)
        wait(lambda: b'accepted' in fence.read_bytes() and not (dest.sync/'relay-incoming'/jobname).exists(),30)
        assert (peer_work/'build-count').read_text() == '1'
        assert native_calls.count(target)==5 and not source_advanced, native_calls
        print('%s -> %s (%s): original host stopped; peer made 5 native model requests, installed the offline locked dependency without hooks, verified it, ran the unmodified npm build once and finished in original session.' % (origin,target,os.name),flush=True)
    except BaseException:
        print('model requests:',native_calls[-12:],flush=True)
        if 'sid' in locals():
            for h in hosts.values():
                if h.proc:
                    try:
                        page=json.loads(h.page(sid)); print('Fixture result errors:',[x['event']['data']['message']['content'] for x in page.get('items',[]) if x.get('event',{}).get('type')=='tool/result' and x['event']['data']['message'].get('isError')][-2:])
                    except Exception: pass
                if (h.root/'qa.log').exists():
                    for line in (h.root/'qa.log').read_text('utf8',errors='replace').splitlines():
                        if ('Error' in line or 'task-sync]' in line) and 'token' not in line: print(line[:220])
        raise
    finally:
        for h in hosts.values(): h.stop()
        server.shutdown();server.server_close()

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('cli',type=Path);p.add_argument('tgz',type=Path)
    p.add_argument('--origin',choices=['desktop','cloud'],default='desktop')
    p.add_argument('--paired-cut', action='store_true', help='Wait for an out-of-band fixture-copy digest before killing an actual npm install')
    mode=p.add_mutually_exclusive_group();mode.add_argument('--export-fixture',type=Path);mode.add_argument('--import-fixture',type=Path);a=p.parse_args()
    with tempfile.TemporaryDirectory(prefix='relay-native-',ignore_cleanup_errors=True) as d:
        test(Path(d),a.cli.resolve(),a.tgz.resolve(),a.origin,a.export_fixture,a.import_fixture,a.paired_cut)
