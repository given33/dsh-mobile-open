"""Opt-in power-cut test: disposable desktop DSH, mock model, already paired Linux step worker.
No production desktop agent, provider, workspace or real user file is accessed.
"""
import argparse
import base64
import hashlib
import http.server
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import uuid
import psutil
from offline_cloud_turn import Host, wait


def exercise(cli, package, peer):
    assert re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]*',peer)
    marker='qa-'+uuid.uuid4().hex[:12]+'.bin'
    cmd=f"Start-Sleep -Seconds 18; (Get-FileHash -LiteralPath 'relay-inputs/{marker}' -Algorithm SHA256).Hash"
    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def do_POST(self):
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            available=[x['name'] for x in req.get('tools',[])]
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            def emit(kind,**fields):
                self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(dict(type=kind,**fields))+'\n\n').encode());self.wfile.flush()
            emit('message_start',message=dict(id='fixture',type='message',role='assistant',model=req['model'],content=[],usage=dict(input_tokens=6,output_tokens=0)))
            if 'pwsh' in available and not any('tool_result' in str(m) for m in req['messages']):
                emit('content_block_start',index=0,content_block=dict(type='tool_use',id='fixture-step',name='pwsh',input={}))
                emit('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=json.dumps(dict(command=cmd,description='校验测试文件',timeoutMs=40000))))
                reason='tool_use'
            else:
                emit('content_block_start',index=0,content_block=dict(type='text',text=''));emit('content_block_delta',index=0,delta=dict(type='text_delta',text='fixture ended'));reason='end_turn'
                # Title generation also uses this mock model without any shell tools.
            emit('content_block_stop',index=0);emit('message_delta',delta=dict(stop_reason=reason,stop_sequence=None),usage=dict(output_tokens=3));emit('message_stop')
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='dsh-step-cut-',ignore_cleanup_errors=True) as tmp:
            host=Host(Path(tmp)/'desktop',cli,package,'http://127.0.0.1:'+str(server.server_port))
            config=host.root/'profiles/web/cordis.patch.yml';s=config.read_text('utf8').replace('sshHost: fixture.invalid','sshHost: fixture.invalid, portableSteps: true');config.write_text(s,encoding='utf8')
            # Only the portable channel can reach the paired worker. The regular watcher must NEVER
            # exchange this test profile's catalogue, model preferences or history with a real host.
            preload=host.root/'fixture-carrier.cjs'
            preload.write_text("const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(bin==='ssh' && args?.at(-2)==='fixture.invalid' && args.at(-1).startsWith('sudo -n -u dsh-cloud /usr/bin/python3 /opt/dsh-cloud/portable_worker.py --step ')) args=[...args.slice(0,-2),"+json.dumps(peer)+",args.at(-1)];return spawn.call(this,bin,args,...rest)};require('node:module').syncBuiltinESMExports();",encoding='utf8')
            host.env['NODE_OPTIONS']=host.env.get('NODE_OPTIONS','')+' --require="'+preload.as_posix()+'"'
            try:
                host.start();work=host.root/'QA workspace';inputs=work/'relay-inputs';inputs.mkdir(parents=True);sample=uuid.uuid4().bytes*13;(inputs/marker).write_bytes(sample)
                wid=host.rpc('workspace/create',{'path':str(work)})['workspace']['workspaceId'];sid=host.rpc('session/create',{'workspaceId':wid})['sessionId'];assert re.fullmatch('[a-zA-Z0-9_.-]+',sid)
                host.prompt(sid,'Run the fixture file digest.')
                def native_child():
                    for proc in psutil.Process(host.proc.pid).children(recursive=True):
                        try:
                            if proc.name().lower() not in ('pwsh.exe','powershell.exe'):continue
                            argv=proc.cmdline();command=' '.join(argv)
                            if len(argv)>1 and argv[-2].lower()=='-encodedcommand': command=base64.b64decode(argv[-1]).decode('utf-16-le')
                            if marker in command and 'Start-Sleep' in command:return proc
                        except psutil.Error:pass
                shell=wait(native_child,35);time.sleep(1);assert shell.is_running()
                # Only terminate the disposable host and its child processes, never the actual desktop.
                children=psutil.Process(host.proc.pid).children(recursive=True);host.stop()
                for proc in children:
                    try:proc.kill()
                    except psutil.NoSuchProcess:pass
                expected=hashlib.sha256(sample).hexdigest().upper()
                def received():
                    raw=subprocess.check_output(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',peer,'sudo -n -u dsh-cloud /usr/bin/python3 /opt/dsh-cloud/portable_worker.py --status /var/lib/dsh-cloud/.dsh/mobile-task-sync '+sid]);rows=json.loads(raw)
                    return len(rows)==1 and rows[0]['owner']=='cloud' and rows[0]['result']==expected
                wait(received,55);print('Verified: native desktop PowerShell was running at the cut; independent Linux worker finished SHA-256 on the original bytes.',flush=True)
            except Exception:
                for line in (host.root/'qa.log').read_text(encoding='utf8',errors='replace').splitlines():
                    if 'Error:' in line and 'token' not in line: print('Fixture error:',line[:160])
                if host.proc and 'sid' in locals():
                    view=host.page(sid);print('Fixture diagnostic:', view[-2200:],flush=True)
                raise
            finally:host.stop()
    finally:server.shutdown();server.server_close()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('cli',type=Path);p.add_argument('tgz',type=Path);p.add_argument('--paired-host',required=True);a=p.parse_args();exercise(a.cli.resolve(),a.tgz.resolve(),a.paired_host)
