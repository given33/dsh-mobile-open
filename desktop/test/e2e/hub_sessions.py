"""Fixed sheet geometry and session management against a disposable official Harness."""
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from workspace_sync import connect


def rpc(page, method, args):
    result = page.evaluate("""async ([method,args]) => {
      const res=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:'hub-e2e',method,payload:{args}})});
      return (await res.json()).result;
    }""", [method, args])
    assert result['ok'], result
    return result.get('value')


host = json.loads((Path(sys.argv[1]) / 'host.json').read_text())
workspace = Path(host['workspace']).resolve()
assert urlsplit(host['base']).hostname == '127.0.0.1' and workspace == Path(host['home']).resolve() / 'test-workspace'
with sync_playwright() as pw:
    browser = (pw.webkit.launch(executable_path=os.getenv('WEBKIT_PATH')) if os.getenv('WEBKIT_PATH')
               else pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'), args=['--no-proxy-server']))
    m, d = connect(browser, host)
    m.set_default_timeout(5000)
    m.on('pageerror', lambda error: print(f'WebView error: {error}', flush=True))
    # On a fresh Harness a blocking model onboarding dialog can appear. This
    # disposable fixture never makes model requests; the key is not real.
    rpc(d, 'credentials/set', {'ref': 'DEEPSEEK_API_KEY', 'value': 'synthetic-fixture-not-a-key'})
    for page in [m, d]:
        page.reload(wait_until='domcontentloaded')
        page.locator('[data-composer-card]').first.wait_for(timeout=40000)
    for page in [m, d]:
        onboarding = page.get_by_role('dialog').get_by_role('button', name='继续', exact=True)
        if onboarding.count() and onboarding.first.is_visible():
            onboarding.first.click()
    prefix = 'Hub E2E ' + uuid.uuid4().hex[:8]
    titles = [prefix + ' ' + suffix for suffix in ('Alpha', 'Bravo', 'Charlie')]
    ids, workspace_ids = [], []
    for title in titles:
        cwd = tempfile.mkdtemp(prefix='hub-', dir=workspace)
        wid = rpc(d, 'workspace/create', {'request': {'path': cwd}})['workspace']['workspaceId']
        sid = rpc(d, 'session/create', {'request': {'workspaceId': wid}})['sessionId']
        rpc(d, 'session/rename', {'request': {'sessionId': sid, 'title': title}})
        ids.append(sid)
        workspace_ids.append(wid)
    def desktop_row(sid):
        return d.locator(f'[data-slot="sidebar.workspaces"] [data-row-key="session:{sid}"]')
    for wid, sid in zip(workspace_ids, ids):
        row = d.locator(f'[data-row-key="workspace:{wid}"]')
        if row.get_attribute('aria-expanded') == 'false':
            row.evaluate('b => b.click()')
        expect(desktop_row(sid)).to_have_count(1)
    drawer = m.locator('[data-sidebar-drawer]')
    if drawer.get_attribute('data-sidebar-collapsed') is not None:
        m.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    expect(m.get_by_role('button', name='管理会话', exact=True)).to_have_count(0)
    m.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    trigger = m.get_by_role('button', name='移动端工具箱', exact=True)
    # Sample before Playwright's visibility/stability waits could mask a slide-in.
    frames = trigger.evaluate("""async button => {
        button.click();
        const frames = [];
        for (let i = 0; i < 6; i++) {
            await new Promise(requestAnimationFrame);
            const dialog = document.querySelector('.dml-hub-backdrop:modal');
            const sheet = dialog.querySelector('.dml-hub-sheet');
            frames.push([sheet.getBoundingClientRect().top, getComputedStyle(sheet).animationName,
                         getComputedStyle(dialog, '::backdrop').backgroundColor]);
        }
        return frames;
    }""")
    assert all(frame == frames[0] for frame in frames) and frames[0][1] == 'none', frames
    hub = m.get_by_role('dialog', name='移动端工具箱')
    expect(hub).to_be_visible()
    m.emulate_media(reduced_motion='reduce')
    sheet = hub.locator('.dml-hub-sheet')
    for width, height in [(320, 640), (393, 745), (820, 900)]:
        m.set_viewport_size({'width': width, 'height': height})
        rects = []
        for name in ['任务', '指令', 'Git', '工具']:
            hub.get_by_role('tab', name=name, exact=True).click()
            rects.append(sheet.bounding_box())
        assert all(r == rects[0] for r in rects), rects
        assert abs(rects[0]['height'] - min(0.76 * height, 680)) < 1, rects[0]
        assert abs(rects[0]['width'] - min(width, 560)) < 1, rects[0]
    m.set_viewport_size({'width': 393, 'height': 745})
    hub.get_by_role('tab', name='任务').click()
    search = hub.get_by_role('searchbox')
    search.fill(prefix)
    first = hub.get_by_role('button', name='进入会话：' + titles[0], exact=True)
    expect(first.locator('time')).to_contain_text('更新于')
    first.click()
    m.wait_for_function('id=>__DSH_MOBILE_CORDIS__.getCurrentSessionId()===id', arg=ids[0])
    expect(m.get_by_role('button', name='返回会话列表', exact=True)).to_have_count(0)
    trigger.click()
    expect(search).to_have_value(prefix)
    archive = hub.get_by_role('button', name='归档会话：' + titles[2], exact=True)
    assert archive.evaluate('b=>b.getBoundingClientRect().left>=b.parentElement.getBoundingClientRect().right-1')
    label_x = archive.evaluate("b=>b.parentElement.querySelector('.dml-hub-item-title').getBoundingClientRect().left")
    archive.evaluate('b=>b.parentElement.scrollLeft=b.parentElement.scrollWidth')
    assert abs(archive.evaluate("b=>b.parentElement.querySelector('.dml-hub-item-title').getBoundingClientRect().left") - label_x) <= 1
    assert archive.evaluate('b=>b.getBoundingClientRect().right<=b.parentElement.getBoundingClientRect().right+1')
    archive.click()
    expect(hub.locator('.dml-hub-hint[role=status]')).to_contain_text('已归档 1 个会话')
    expect(hub.get_by_role('button', name='进入会话：' + titles[2], exact=True)).to_have_count(0)
    hub.get_by_role('button', name='多选', exact=True).click()
    for title in titles[:2]:
        hub.get_by_role('checkbox', name='选择会话：' + title, exact=True).check()
    hub.get_by_role('button', name='归档所选 (2)', exact=True).click()
    expect(hub.locator('.dml-hub-hint[role=status]')).to_contain_text('已归档 2 个会话')
    hub.get_by_role('button', name='查看已归档', exact=True).click()
    for title in titles:
        expect(hub.get_by_role('button', name='恢复会话：' + title, exact=True)).to_be_visible()
    for sid in ids:
        expect(desktop_row(sid)).to_have_count(0)
    hub.get_by_role('button', name='多选', exact=True).click()
    hub.get_by_role('button', name='全选筛选结果', exact=True).click()
    hub.get_by_role('button', name='恢复所选 (3)', exact=True).click()
    expect(hub.locator('.dml-hub-hint[role=status]')).to_contain_text('已恢复 3 个会话')
    for sid in ids:
        expect(desktop_row(sid)).to_have_count(1)
    hub.get_by_role('button', name='关闭工具箱').click()
    if drawer.get_attribute('data-sidebar-collapsed') is not None:
        m.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    group = drawer.locator(f'[data-row-key="workspace:{workspace_ids[1]}"]')
    if group.get_attribute('aria-expanded') == 'false':
        group.click()
    drawer.locator(f'[data-row-key="session:{ids[1]}"]').click()
    m.wait_for_function('id=>__DSH_MOBILE_CORDIS__.getCurrentSessionId()===id', arg=ids[1])
    if drawer.get_attribute('data-sidebar-collapsed') is None:
        m.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    m.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    expect(drawer).not_to_have_attribute('data-sidebar-collapsed', 'true')
    print('Four fixed-size tabs at three viewport sizes; sidebar and search roundtrips; timestamps; single and batch archive; batch restore; desktop sync PASS', flush=True)
    browser.close()
