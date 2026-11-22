"""The mobile WebView uses the official host-task RPCs, not the native legacy adapter."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from workspace_sync import connect


def call(page, method, args):
    return page.evaluate('''async ([method,args])=>{
      const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});
      return {status:r.status, body:await r.json()};
    }''', [method, args])


def rpc(page, method, args):
    result = call(page, method, args)
    assert result['status'] == 200 and result['body']['result']['ok'], (method, result)
    return result['body']['result']['value']


if __name__ == '__main__':
    host = json.loads((Path(sys.argv[1])/'host.json').read_text())
    assert urlsplit(host['base']).hostname == '127.0.0.1'
    assert Path(host['workspace']).resolve() == Path(host['home']).resolve()/'test-workspace'
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'))
        phone, desktop = connect(browser, host, user_agent=pw.devices['Pixel 7']['user_agent'])
        target = {'kind': 'new'}
        request = dict(title='Official WebView schedule integration', prompt='Never send this fixture',
                       timing={'kind': 'every', 'every_seconds': 86400}, target=target)
        task = rpc(phone, 'schedule/create', {'request': request})
        id = task['id']
        address = {'id': id}
        assert task['target']['kind'] == 'new' and 'sessionId' not in task
        rows = rpc(phone, 'schedule/list', {'request': {'limit': 100}})['items']
        assert any(r['id'] == id for r in rows)
        assert rpc(desktop, 'schedule/view', {'request': address})['title'] == request['title']
        assert rpc(phone, 'schedule/history', {'request': {**address, 'limit': 20}})['records'] == []
        paused = rpc(phone, 'schedule/edit', {'request': {**address, 'action': 'update',
                     'expectedUpdatedAt': task['updatedAt'], 'patch': {'active': False}}})
        assert paused['status'] == 'paused'
        panel = desktop.request.post(host['base'].rstrip('/') + '/dsh-mobile-link/actions', data={'enabled': False})
        assert panel.ok
        assert rpc(phone, 'schedule/view', {'request': address})['status'] == 'paused'
        denied = call(phone, 'schedule/edit', {'request': {**address, 'action': 'delete'}})
        assert denied['status'] == 403
        assert desktop.request.post(host['base'].rstrip('/') + '/dsh-mobile-link/actions', data={'enabled': True}).ok
        assert rpc(phone, 'schedule/edit', {'request': {**address, 'action': 'delete'}})['deleted']
        print('Official mobile schedule create/list/view/history/pause/delete and read-only enforcement PASS')
        browser.close()
