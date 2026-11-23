"""Two isolated native hosts and a scripted model: surrender a real tool turn, stop that host,
then require the peer to discover its OS, execute a native npm build, and finish another model round.
No production model key, workspace, deploy command or elevated shell is used.
"""
import argparse, base64, hashlib, http.server, json, os, tempfile, threading, uuid
from pathlib import Path
from offline_cloud_turn import Host, wait, exchange, transfer


def test(root, cli, package, origin, export=None, incoming=None):
    target = 'cloud' if origin == 'desktop' else 'desktop'
    reports, native_calls, source_advanced = [], [], []
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
                    else: tool = 'relay_remaining_task'
                elif '"foundOnPath"' not in history.replace('\\"','"'):
                    tool = 'relay_environment'
                elif 'RELAY-BUILD-OK-' + marker not in history:
                    tool = 'pwsh' if os.name == 'nt' else 'bash'
                    args = dict(command='npm run build',description='Run the fixture build')
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
            (workspace/'package.json').write_text(json.dumps({'scripts':{'build':'node build.cjs'}}))
            (workspace/'build.cjs').write_text("require('node:fs').appendFileSync('build-count','1'); console.log('RELAY-BUILD-OK-'+"+repr(marker)+");")
            (workspace/'not-shared.txt').write_text('private fixture')
            source.sync.mkdir(exist_ok=True)
            (source.sync/'relay-inputs.json').write_text(json.dumps({origin+':'+wid:['package.json','build.cjs']}))
            source.prompt(sid,'Continue the fixture build on the paired host.')
            job = wait(lambda:next((source.sync/'relay-outgoing').glob('*.json'),None),50)
            source.stop()
            assert not source_advanced and native_calls and all(r==origin for r in native_calls)
            assert not (workspace/'build-count').exists()
            if export:
                export.write_text(json.dumps(dict(marker=marker,wid=wid,sid=sid,job=job.name,
                        packet=base64.b64encode(job.read_bytes()).decode('ascii'))),encoding='utf8')
                print('Real %s DSH sealed its tool turn and exited.'%os.name,flush=True)
                return
        else:
            wid,sid = fixture['wid'],fixture['sid']
        dest = hosts[target]
        peer_work = dest.sync/'workspaces'/hashlib.sha256((origin+':'+wid).encode()).hexdigest()
        assert not (peer_work/'package.json').exists()
        if fixture: transfer.queue_turn(dest.sync,fixture['job'],fixture['packet'],origin,True)
        else: exchange(hosts['desktop'],hosts['cloud'],'--mailbox',relay=True)
        wait(lambda: reports and 'MODEL-FINAL-'+marker in dest.page(sid),70)
        assert not (peer_work/'not-shared.txt').exists()
        assert (peer_work/'build-count').read_text() == '1'
        assert native_calls.count(target)==3 and not source_advanced, native_calls
        print('%s -> %s (%s): original host stopped; peer made 3 native model requests, probed OS, ran npm build once and finished in original session.' % (origin,target,os.name),flush=True)
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
    mode=p.add_mutually_exclusive_group();mode.add_argument('--export-fixture',type=Path);mode.add_argument('--import-fixture',type=Path);a=p.parse_args()
    with tempfile.TemporaryDirectory(prefix='relay-native-',ignore_cleanup_errors=True) as d:
        test(Path(d),a.cli.resolve(),a.tgz.resolve(),a.origin,a.export_fixture,a.import_fixture)
