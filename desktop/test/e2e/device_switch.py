"""A real phone-link RPC during a native model turn; two disposable DSH profiles, no external model."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
import uuid
from offline_cloud_turn import Host, wait, exchange
from source_sync import authorize


def phone(host):
    def post(path, body, opener, headers=None):
        req = urllib.request.Request(path, data=json.dumps(body).encode(), headers={'Content-Type':'application/json', **(headers or {})})
        with opener.open(req, timeout=6) as response:
            return json.load(response)
    state = post(host.base+'dsh-mobile-link/code', {}, host.http)
    code = urllib.parse.parse_qs(urllib.parse.urlsplit(state['pairing']['link']).query)['c'][0]
    base = 'https://127.0.0.1:' + str(state['port'])
    # Trust only this disposable loopback fixture's certificate.
    ctx = ssl.create_default_context(cadata=ssl.get_server_certificate(('127.0.0.1',state['port'])))
    ctx.check_hostname = False
    channel = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
    token = post(base+'/mobile/v1/pair',{'code':code,'device':{'id':'fixture-phone','name':'Fixture'}},channel)['token']
    def rpc(name, args):
        method = 'mobileRelay/' + name
        result = post(base+'/api/'+method,{'type':'client-request','method':method,'rpcId':uuid.uuid4().hex,'payload':{'args':args}},channel,{'Authorization':'Bearer '+token})['result']
        assert result['ok'], result.get('error'); return result['value']
    return rpc


def test(root,cli,tgz):
    calls = {'desktop':0,'cloud':0}; entered = threading.Event(); release = threading.Event(); reports=[]; resume_cloud=threading.Event()
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            role=self.path.split('/')[1]; tool=None; args={}; text='fixture'; tools={t['name'] for t in req.get('tools',[])}
            if 'relay_environment' in tools:
                calls[role]+=1; history=json.dumps(req['messages'],ensure_ascii=False)
                if role=='desktop' and calls[role]==1:
                    entered.set(); release.wait(30); tool='pwsh' if os.name=='nt' else 'bash'
                    args={'command':'''node -e "require('fs').appendFileSync('step.txt','A')"''','description':'Write once on source'}
                elif role=='cloud' and calls[role]==1:
                    assert resume_cloud.wait(60); reports.append(history); tool='relay_environment'
                elif role=='cloud' and calls[role]==2:
                    reports.append(history); tool='pwsh' if os.name=='nt' else 'bash'
                    args={'command':'''node -e "const fs=require('fs');if(fs.readFileSync('step.txt','utf8')!=='A')process.exit(1);fs.appendFileSync('step.txt','B')"''','description':'Continue the original file on target'}
                else: text='fixture finished'
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            def emit(kind, **fields):
                self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(dict(type=kind,**fields))+'\n\n').encode()); self.wfile.flush()
            emit('message_start',message=dict(id='qa',type='message',role='assistant',model=req['model'],content=[],usage=dict(input_tokens=5,output_tokens=0)))
            if tool:
                emit('content_block_start',index=0,content_block=dict(type='tool_use',id=uuid.uuid4().hex,name=tool,input={}))
                emit('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=json.dumps(args)))
            else:
                emit('content_block_start',index=0,content_block=dict(type='text',text='')); emit('content_block_delta',index=0,delta=dict(type='text_delta',text=text))
            emit('content_block_stop',index=0); emit('message_delta',delta=dict(stop_reason='tool_use' if tool else 'end_turn',stop_sequence=None),usage=dict(output_tokens=5)); emit('message_stop')
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model); threading.Thread(target=server.serve_forever,daemon=True).start()
    hosts=[]
    try:
        for role in ('desktop','cloud'):
            h=Host(root/role,cli,tgz,'http://127.0.0.1:'+str(server.server_port)+'/'+role); hosts.append(h)
            cfg=h.root/'profiles/web/cordis.patch.yml'; cfg.write_text(cfg.read_text().replace('enabled: false','enabled: true\n    host: 127.0.0.1\n    actions: true').replace('cloudTurns: true','cloudTurns: true, turnRelay: true'),encoding='utf8'); h.start()
        source,target=hosts; a,b=map(phone,hosts)
        assert b('status',{})=={'role':'cloud','protocol':1,'autoFailover':True,'failoverProtocol':1}
        workspace=source.root/'project'; workspace.mkdir(); wid=source.rpc('workspace/create',{'path':str(workspace)})['workspace']['workspaceId']; sid=source.rpc('session/create',{'workspaceId':wid})['sessionId']
        key=hashlib.sha256(('desktop:'+wid).encode()).hexdigest(); authorize(source.sync,key,workspace,['step.txt'])
        def replicated_scope():
            exchange(source,target,'--sync',relay=True,sources=True)
            return (target.sync/'source-grants'/(key+'.json')).exists()
        wait(replicated_scope,60)
        args={'sessionId':sid,'target':'cloud','expectedRunning':True,'command':uuid.uuid4().hex}
        source.prompt(sid,'Make the two fixture edits, then report.'); assert entered.wait(30)
        result=a('request',args); assert result['state']=='requested',result
        assert a('request',dict(args,command=uuid.uuid4().hex))['command']==result['command']; release.set()
        def delivered():
            exchange(source,target,'--sync',relay=True,sources=True)
            record=a('status',args); assert record['state']!='failed',record
            return b('status',args)['state']=='accepted'
        wait(delivered,90); source.stop(); resume_cloud.set()
        replica=target.sync/'workspaces'/key
        wait(lambda:(replica/'step.txt').read_bytes()==b'AB'); wait(lambda:calls['cloud']>=3)
        assert calls['desktop']==1 and (workspace/'step.txt').read_bytes()==b'A'
        repo=target.sync/'source-backups'/(key+'.git'); assert b'A' in [subprocess.check_output(['git','--git-dir='+str(repo),'show',rev.decode()+':step.txt'],stderr=subprocess.DEVNULL) for rev in subprocess.check_output(['git','--git-dir='+str(repo),'log','--format=%H','--','step.txt']).splitlines()]
        assert '执行设备已切换' in reports[0] and 'taskProgress' in reports[1]
        assert b('status',args)['state']=='accepted'; print('PASS: two taps, one native transfer, source A -> cloud AB, offline source, Git receipt and environment notice')
    finally:
        release.set(); resume_cloud.set()
        for h in hosts: h.stop()
        server.shutdown();server.server_close()


if __name__=='__main__':
    if len(sys.argv)>3:
        root=Path(sys.argv[3]).resolve(); root.mkdir(); test(root,Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve())
    else:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d: test(Path(d),Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve())
