"""Regression against desktop/tools/official-fixture.mjs, NOT a daily desktop.

Install playwright + chromium, then run this file with the fixture output directory.
CHROMIUM_PATH optionally selects an installed Playwright Chromium executable.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright


def connect(browser, host, **phone_options):
    desktop = host['base'].rstrip('/')
    mobile = f"https://127.0.0.1:{host['port']}"
    phone = browser.new_context(ignore_https_errors=True, is_mobile=True, has_touch=True,
                                locale='zh-CN', viewport={'width': 393, 'height': 745}, **phone_options)
    pc = browser.new_context(locale='zh-CN', viewport={'width': 1280, 'height': 850})
    name, value = host['cookie'].split('=', 1)
    pc.add_cookies([{'name': name, 'value': value, 'url': desktop}])
    code = pc.request.post(desktop + '/dsh-mobile-link/code', data={}).json()['pairing']['link']
    pair = phone.request.post(mobile + '/mobile/v1/pair', data={
        'code': parse_qs(urlsplit(code).query)['c'][0], 'device': {'id': 'phone-workspace-e2e', 'name': 'fixture'}})
    assert phone.request.post(mobile + '/mobile/v1/web-session', data={},
                              headers={'Authorization': 'Bearer ' + pair.json()['token']}).ok
    pages = [phone.new_page(), pc.new_page()]
    for page, url in zip(pages, [mobile, desktop]):
        page.goto(url, wait_until='domcontentloaded')
        page.locator('[data-composer-card]').first.wait_for(timeout=40000)
    return pages


def check(src, dst, directory):
    # Isolate each direction, so the host cannot recycle an existing empty session.
    workspace = src.evaluate('''async path => {
        const method='workspace/create'; const res=await fetch('/api/'+method, {method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',
          rpcId:'workspace-e2e',method,payload:{args:{request:{path}}}})});
        return (await res.json()).result.value.workspace.workspaceId
    }''', directory)
    tree = '[data-slot="sidebar.workspaces"] '
    group = f'{tree}[data-row-key="workspace:{workspace}"]'
    def expand():
        row = dst.locator(group)
        if row.get_attribute('aria-expanded') == 'false':
            row.evaluate('b => b.click()')
    expand()
    current = dst.locator(tree + '[data-row-key^="session:"][aria-selected="true"]')
    before = current.evaluate_all('(rows) => rows.map(x => x.dataset.rowKey)')
    with src.expect_response(lambda r: r.url.endswith('/api/session/create')) as creating:
        src.locator(group + ' button[aria-keyshortcuts]').evaluate('b => b.click()')
    sid = creating.value.json()['result']['value']['sessionId']
    # Find the section that owns this workspace header, not just any text match.
    section = dst.locator(group).locator('xpath=../..')
    row = section.locator(f'[data-row-key="session:{sid}"]')
    row.wait_for(state='attached', timeout=5000)
    assert row.count() == 1 and row.get_attribute('aria-selected') == 'false'
    assert current.evaluate_all('(rows) => rows.map(x => x.dataset.rowKey)') == before
    assert dst.locator('.dml-shared-drafts').count() == 0
    dst.reload(wait_until='domcontentloaded')
    expand()
    row.wait_for(state='attached', timeout=5000)
    row.evaluate('el => el.click()')
    dst.wait_for_function('id => document.querySelector(`[data-row-key="session:${id}"]`)?.getAttribute("aria-selected")==="true"', arg=sid)


if __name__ == '__main__':
    host = json.loads((Path(sys.argv[1]) / 'host.json').read_text())
    root = Path(host['workspace']).resolve()
    assert urlsplit(host['base']).hostname == '127.0.0.1' and root == Path(host['home']).resolve() / 'test-workspace'
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'), args=['--no-proxy-server'])
        mobile, desktop = connect(browser, host)
        for src, dst in [(mobile, desktop), (desktop, mobile)]:
            drawer = mobile.locator('[data-sidebar-drawer]')
            if drawer.get_attribute('data-sidebar-collapsed') is not None:
                mobile.evaluate('window.__DSH_MOBILE_BRIDGE__.toggleSidebar()')
            check(src, dst, tempfile.mkdtemp(prefix='shared-', dir=root))
        print('Both workspace directions, selection, reload and open passed.')
        browser.close()
