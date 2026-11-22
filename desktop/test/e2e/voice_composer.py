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
    for width in (320, 393, 820, 393):
        page.set_viewport_size({'width': width, 'height': 752})
        page.wait_for_function('''() => {
            const b=document.getElementById('dml-voice-button'), s=b?.nextElementSibling;
            if (!s) return false;
            const a=b.getBoundingClientRect(), r=s.getBoundingClientRect();
            return a.width>=36 && r.width>=38 && r.height>=38 && a.right<=r.left+1 && r.right<=innerWidth && Math.abs(a.y+a.height/2-r.y-r.height/2)<=3;
        }''')
    assert not page.locator('[data-sidebar-opener]').is_visible()
    print('Button is next to send at 320, 393 and 820 px.', flush=True)

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
    pad = page.get_by_role('button', name='按住 说话')
    pad.wait_for()
    assert not page.evaluate("messages.some(m=>m.type==='voice-start')")
    box = pad.bounding_box()
    page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)
    page.mouse.down()
    assert page.evaluate("messages.some(m=>m.type==='voice-start')")
    page.screenshot(path=fixture / f'voice-active-{name}.png')
    page.mouse.move(box['x'] + 5, box['y'])
    page.mouse.up()
    assert page.evaluate("messages.at(-1).type==='voice-cancel'")
    mic.tap()
    assert not pad.is_visible()
    x, y = down()
    page.evaluate("()=>__DSH_MOBILE_BRIDGE__.voiceEvent({id:messages.filter(m=>m.type==='voice-start').at(-1).id,status:'final',text:'should not insert early'})")
    assert 'should not insert early' not in editor.inner_text()
    page.mouse.move(x - 70, y)
    page.mouse.up()
    page.locator('#dml-voice-hud').wait_for(state='hidden')
    assert 'should not insert early' not in editor.inner_text()
    assert page.evaluate("messages.at(-1).type==='voice-cancel'")
    x, y = down()
    page.mouse.move(x + 50, y)
    page.mouse.up()
    transcript = page.get_by_role('textbox', name='识别结果')
    transcript.wait_for()
    assert transcript.input_value() == '测试 voice 日本語'
    transcript.fill('可编辑的文字')
    page.get_by_role('button', name='插入草稿').click()
    page.wait_for_function("document.querySelector('[data-composer-card] [contenteditable=true]').textContent.includes('可编辑的文字')")
    down()
    page.mouse.up()
    page.wait_for_function("document.querySelector('[data-composer-card] [contenteditable=true]').textContent.includes('测试 voice 日本語')")
    assert not page.evaluate("document.activeElement?.isContentEditable")
    page.screenshot(path=fixture / f'voice-{name}.png')
    print('Hold, late results, left cancel, right preview/edit, plain release and no keyboard focus passed.')
