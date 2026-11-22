"""Verify voice input against a disposable official fixture with a mocked native recognizer."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright


fixture = Path(sys.argv[1])
h = json.loads((fixture / 'host.json').read_text(encoding='utf8'))
assert urlsplit(h['base']).hostname == '127.0.0.1'
base = 'https://127.0.0.1:' + str(h['port'])
with sync_playwright() as pw:
    name = sys.argv[2] if len(sys.argv) > 2 else 'webkit'
    browser = getattr(pw, name).launch(executable_path=os.getenv(name.upper() + '_PATH'))
    phone = browser.new_context(ignore_https_errors=True, locale='zh-CN',
                                viewport={'width': 393, 'height': 752}, is_mobile=True, has_touch=True)
    assert Path(h['workspace']).resolve() == Path(h['home']).resolve() / 'test-workspace'
    # Enable the built-in model catalog only on this disposable test profile; never call a model.
    rpc = 'credentials/set'
    setup = phone.request.post(h['base'] + 'api/' + rpc, headers={'Cookie': h['cookie']}, data={
        'type': 'client-request', 'rpcId': 'voice-fixture', 'method': rpc,
        'payload': {'args': {'ref': 'DEEPSEEK_API_KEY', 'value': 'synthetic-fixture-not-a-key'}},
    })
    assert setup.ok and setup.json()['result']['ok']
    pair = phone.request.post(h['base'] + 'dsh-mobile-link/code', headers={'Cookie': h['cookie']}, data={}).json()
    code = parse_qs(urlsplit(pair['pairing']['link']).query)['c'][0]
    token = phone.request.post(base + '/mobile/v1/pair', data={'code': code, 'device': {'id': 'voice-qa-' + name, 'name': 'Voice test'}}).json()['token']
    assert phone.request.post(base + '/mobile/v1/web-session', headers={'Authorization': 'Bearer ' + token}, data={}).ok
    phone.add_init_script('''
        window.__DSH_NATIVE_VOICE__=1;window.__DSH_MOBILE_LAUNCH__={mode:'new'};
        window.messages=[];
        window.webkit={messageHandlers:{dshMobile:{postMessage:m=>{
          messages.push(m);
          if(m.type==='voice-start') __DSH_MOBILE_BRIDGE__.voiceEvent({id:m.id,status:'recording'});
          if(m.type==='voice-stop') __DSH_MOBILE_BRIDGE__.voiceEvent({id:m.id,status:'final',text:'测试 voice 日本語'});
        }}}};
    ''')
    page = phone.new_page()
    page.on('pageerror', lambda error: print('Page error:', error, flush=True))
    page.goto(base)
    page.wait_for_function("messages.some(m=>m.type==='launch-applied')", timeout=30000)
    dialog = page.get_by_role('dialog').get_by_role('button', name='继续', exact=True)
    if dialog.count():
        dialog.first.click(timeout=5000)
    mic = page.locator('#dml-voice-button')
    card = page.locator('[data-composer-card]').first
    page.get_by_text('预览版说明', exact=True).wait_for(state='hidden', timeout=8000)
    onboarding = page.get_by_role('dialog').filter(has_text='开始使用')
    try:
        onboarding.wait_for(timeout=2800)
    except Exception:
        pass
    if onboarding.is_visible():
        onboarding.locator('button').first.click()
        onboarding.wait_for(state='hidden')
    mic.wait_for(timeout=12000)
    model = card.locator('[data-slot="conversation.input.model"] button').first
    effort = model.locator('[class$="_triggerEffort"]')
    effort.wait_for(state='attached', timeout=15000)
    model.tap()
    setting = page.get_by_role('menuitem').filter(has_text='推理等级')
    setting.wait_for()
    assert effort.text_content() in setting.inner_text()
    page.keyboard.press('Escape')
    setting.wait_for(state='hidden')

    def check_toolbar(width):
        page.set_viewport_size({'width': width, 'height': 752})
        page.wait_for_function('''() => {
            const b=document.getElementById('dml-voice-button'), s=b?.nextElementSibling;
            if (!s) return false;
            const a=b.getBoundingClientRect(), r=s.getBoundingClientRect();
            return a.width>=36 && r.width>=38 && r.height>=38 && a.right<=r.left+1 && r.right<=innerWidth && Math.abs(a.y+a.height/2-r.y-r.height/2)<=3;
        }''')
        label = model.locator('[class$="_triggerLabel"]')
        assert label.is_visible() and label.bounding_box()['width'] > 24
        assert not effort.is_visible(), (width, model.inner_text())
        label_box = label.bounding_box()
        assert label_box['x'] + label_box['width'] <= mic.bounding_box()['x'] + 1
        if width >= 393 and label.inner_text() == 'DeepSeek-V4.1-Flash':
            assert label.evaluate('el => el.scrollWidth <= el.clientWidth + 1')

    widths = (320, 360, 375, 393, 430, 820, 393)
    for width in widths:
        check_toolbar(width)
    assert not page.locator('[data-sidebar-opener]').is_visible()

    def down():
        box = mic.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        try:
            page.locator('#dml-voice-hud').wait_for(state='visible', timeout=3000)
        except Exception:
            print(page.evaluate('''([x,y]) => ({hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,180),
                    hidden:document.hidden, messages:messages.filter(m=>m.type.startsWith('voice-'))})''', [x, y]), flush=True)
            page.screenshot(path=fixture / f'voice-failed-{name}.png')
            raise
        return x, y

    editor = card.locator('[contenteditable=true]').first
    mic.tap()
    inline = page.get_by_role('button', name='结束听写')
    inline.wait_for()
    assert editor.is_visible() and page.evaluate('document.activeElement.isContentEditable')
    assert page.locator('#dml-voice-hold').count() == 0
    assert page.evaluate("messages.some(m=>m.type==='voice-start')")
    for width in widths:
        check_toolbar(width)
    page.screenshot(path=fixture / f'voice-toolbar-{name}.png')
    inline.tap()
    page.wait_for_function("document.activeElement.isContentEditable && document.activeElement.textContent.includes('测试 voice 日本語')")
    assert not inline.is_visible()
    check_toolbar(393)
    # Long press: no secondary editor. Meter responds to native volume, then settles to silence.
    before = editor.inner_text()
    x, y = down()
    hud = page.locator('#dml-voice-hud')
    cancel = hud.locator('[data-target=cancel]')
    bubble = hud.locator('.dml-voice-bubble')
    assert bubble.bounding_box()['y'] > hud.bounding_box()['height'] * .55
    assert bubble.bounding_box()['y'] + bubble.bounding_box()['height'] < cancel.bounding_box()['y']
    assert page.get_by_text('预览文字', exact=True).count() == 0
    assert page.get_by_role('textbox', name='识别结果').count() == 0
    page.evaluate("""() => {window.level = n=>__DSH_MOBILE_BRIDGE__.voiceEvent({id:messages.filter(m=>m.type==='voice-start').at(-1).id,status:'level',level:n}); level(.05)}""")
    middle = hud.locator('i').nth(6)
    quiet = middle.evaluate('e=>e.style.transform')
    page.evaluate('level(.9)')
    assert quiet != middle.evaluate('e=>e.style.transform')
    page.wait_for_function("document.querySelector('.dml-voice-wave i:nth-child(7)').getBoundingClientRect().height > 22")
    page.wait_for_function("document.querySelector('.dml-voice-wave i:nth-child(7)').getBoundingClientRect().height < 5")
    page.evaluate('[.25,.4,.66,.54,.8,.68,.94].forEach(level)')
    page.wait_for_function("document.querySelector('.dml-voice-wave i:nth-child(7)').getBoundingClientRect().height > 22")
    page.screenshot(path=fixture / f'voice-hold-{name}.png')
    pending = "() => __DSH_MOBILE_BRIDGE__.voiceEvent({id:messages.filter(m=>m.type==='voice-start').at(-1).id,status:'final',text:'不应插入'})"
    page.evaluate(pending)
    target = cancel.bounding_box()
    cx, cy = target['x'] + target['width']/2, target['y'] + target['height']/2
    page.mouse.move(cx, cy)
    assert cancel.inner_text() == '松开取消'
    page.mouse.up(); hud.wait_for(state='hidden')
    assert editor.inner_text() == before
    assert page.evaluate("messages.at(-1).type==='voice-cancel'")
    x, y = down()
    page.mouse.move(cx, cy); page.mouse.move(x + 45, y)
    assert cancel.inner_text() == '滑到此处取消'
    page.mouse.up()
    page.wait_for_function("t=>document.querySelector('[data-composer-card] [contenteditable=true]').textContent !== t", arg=before)
    assert editor.inner_text().count('测试 voice 日本語') == before.count('测试 voice 日本語') + 1
    assert not page.evaluate("document.activeElement?.isContentEditable")
    assert not page.locator('#dml-voice-panel').is_visible()
    page.screenshot(path=fixture / f'voice-{name}.png')
    print('PASS: inline dictation, hold-to-draft, native-level meter, bottom cancel, slide out to keep, no preview editor.')
