"""Exercise the real Harness touch composer against desktop/tools/official-fixture.mjs.

python touch_composer.py <fixture-output-dir> [playwright-browser: chromium|webkit]
CHROMIUM_PATH / WEBKIT_PATH optionally select an installed browser executable.
No model is called. Only create a workspace under the isolated fixture home.
"""
import json
import os
import sys
from pathlib import Path
from tempfile import mkdtemp
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from workspace_sync import connect


def exercise(phone, host):
    workspace = mkdtemp(prefix='touch-', dir=host['workspace'])
    wid = phone.evaluate('''async path => {const method='workspace/create';
        const res=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:'touch-test',method,payload:{args:{request:{path}}}})});
        return (await res.json()).result.value.workspace.workspaceId}''', workspace)
    # Workspace controls may be behind onboarding; use the host-owned navigation.
    group = phone.locator(f'[data-row-key="workspace:{wid}"] button[aria-keyshortcuts]')
    with phone.expect_response(lambda r:r.url.endswith('/api/session/create')):
        group.evaluate('b=>b.click()')
    for _ in range(5):
        dialog = phone.get_by_role('dialog').last
        if not dialog.count(): break
        close = dialog.locator('button[aria-label="关闭"]')
        (close if close.count() else dialog.locator('button').first).evaluate('b=>b.click()')
        phone.wait_for_timeout(100)
    if phone.locator('[data-sidebar-drawer]').get_attribute('data-sidebar-collapsed') is None:
        phone.evaluate('window.__DSH_MOBILE_BRIDGE__.toggleSidebar()')
    card = phone.locator('[data-composer-card]').first
    plus = card.locator('button[aria-haspopup=listbox]:has(~ input[type=file])')
    editor = card.locator('[contenteditable=true]')
    rows = phone.locator('[data-trigger-menu] [role=option]')
    for name in ('goal', 'plan'):
        phone.evaluate("window.editorFocus=0;document.addEventListener('focusin',e=>{if(e.target.isContentEditable)editorFocus++},{capture:true,once:true})")
        plus.tap(); rows.first.wait_for()
        assert phone.evaluate('!document.activeElement.isContentEditable && !editorFocus')
        assert phone.evaluate('''()=>['touchmove','selectstart','contextmenu'].every(k=>
            !document.body.dispatchEvent(new Event(k,{cancelable:true,bubbles:true})))''')
        rows.filter(has_text=name).first.tap()
        chip = editor.locator('[data-composer-command]'); chip.wait_for()
        phone.keyboard.type('Argument')
        plus.tap()
        phone.locator('[data-dml-cancel]').tap()
        expect(chip).to_have_count(0,timeout=2000)
        expect(editor).to_have_text('Argument',timeout=2000)
        editor.click(); editor.press('ControlOrMeta+A'); editor.press('Backspace')
        expect(editor).to_have_text('',timeout=2000)
        plus.tap(); rows.filter(has_text=name).first.tap(); chip.wait_for()
        phone.keyboard.press('Backspace'); expect(chip).to_have_count(0,timeout=2000)
    plus.tap(); rows.filter(has_text='compact').first.tap()
    assert editor.inner_text().strip() == '/compact' and not rows.count()
    print('Touch launcher, background isolation, command argument caret, cancellation, backspace and staged compact passed.')


if __name__ == '__main__':
    host = json.loads((Path(sys.argv[1])/'host.json').read_text())
    assert urlsplit(host['base']).hostname == '127.0.0.1' and Path(host['workspace']).resolve() == Path(host['home']).resolve()/'test-workspace'
    engine = sys.argv[2] if len(sys.argv)>2 else 'chromium'
    assert engine in ('chromium','webkit')
    with sync_playwright() as pw:
        browser=getattr(pw,engine).launch(executable_path=os.getenv(engine.upper()+'_PATH'))
        try: exercise(connect(browser,host)[0],host)
        finally: browser.close()
