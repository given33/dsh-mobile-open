"""Mobile home geometry, whale playback, native hub ownership, desktop-sourced weather and fallback."""
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from workspace_sync import connect

fixture = Path(sys.argv[1])
host = json.loads((fixture / 'host.json').read_text())
assert urlsplit(host['base']).hostname == '127.0.0.1'
assert Path(host['workspace']).resolve() == Path(host['home']).resolve() / 'test-workspace'
engine = sys.argv[2]
with sync_playwright() as pw:
    browser = getattr(pw, engine).launch(executable_path=os.getenv(engine.upper() + '_PATH'))
    page, desktop = connect(browser, host)
    page.set_default_timeout(8000)
    setup = desktop.request.post(host['base'] + 'api/credentials/set', headers={'Cookie': host['cookie']}, data={
        'type': 'client-request', 'rpcId': 'home-fixture', 'method': 'credentials/set',
        'payload': {'args': {'ref': 'DEEPSEEK_API_KEY', 'value': 'synthetic-fixture-not-a-key'}}})
    assert setup.ok and setup.json()['result']['ok']
    received = []
    timestamp = 1763964000  # A known instant; deliberately different from the phone's clock.
    def mock_weather(route):
        request = route.request.post_data_json
        received.append(request)
        assert request in ({'mode': 'clock'}, {'mode': 'weather'})
        payload = {'now': timestamp * 1000, 'zone': 'Asia/Tokyo', 'status': 'clock'}
        if request['mode'] == 'weather':
            count = sum(item == {'mode': 'weather'} for item in received)
            payload.update(status='ok', code=95, day=False, time=timestamp - (7200 if count > 1 else 0), temp=18)
        route.fulfill(json=payload)
    page.route('**/mobile/v1/weather', mock_weather)
    page.add_init_script("""window.__DSH_NATIVE_PANEL_HUB__=1;window.__DSH_NATIVE_VOICE__=1;window.__DSH_MOBILE_LAUNCH__={mode:'new'};
        window.geoCalls=0;Object.defineProperty(navigator,'geolocation',{get(){window.geoCalls++;throw Error('phone location accessed')}});
        window.hubReports=[];window.webkit={messageHandlers:{dshMobile:{postMessage(m){if(m.type==='secondary-hub') hubReports.push(m)}}}};""")
    page.reload(wait_until='domcontentloaded')
    chip = page.locator('#dml-weather')
    chip.wait_for()
    preview = page.get_by_role('dialog').get_by_role('button', name='继续', exact=True)
    if preview.count(): preview.first.click()
    page.get_by_text('预览版说明', exact=True).wait_for(state='hidden')
    onboarding = page.get_by_role('dialog').filter(has_text='开始使用')
    try: onboarding.wait_for(timeout=2800)
    except Exception: pass
    if onboarding.is_visible():
        onboarding.locator('button').first.click()
        onboarding.wait_for(state='hidden')
    for width,height in [(320,568),(393,745),(820,900),(393,745)]:
        page.set_viewport_size({'width':width,'height':height})
        page.wait_for_function("""() => {const box=s=>document.querySelector(s)?.getBoundingClientRect(); const c=box('[data-composer-card]'), v=box('[data-conversation-scroll]');return c && v && Math.abs(c.y+c.height/2-v.y-v.height/2)<2;}""")
        mic = page.get_by_role('button', name='语音输入', exact=True)
        expect(mic).to_have_count(1)
        expect(mic).to_be_visible()
        mic.evaluate("""m => {const next=m.nextElementSibling, a=m.getBoundingClientRect(), b=next.getBoundingClientRect();
          if (!(next.type==='submit' || /发送|send/i.test(next.ariaLabel || next.title)) || a.width<36 || a.right>b.left+1 || b.right>innerWidth+1 || Math.abs(a.y+a.height/2-b.y-b.height/2)>3) throw Error('mic not immediately left of send');}""")
    # Capture actual changing frames from the official canvas, not just its presence.
    canvas=page.locator('canvas[data-home-whale]');canvas.wait_for()
    page.wait_for_function("performance.getEntriesByType('resource').some(r=>r.name.includes('breach-atlas'))")
    page.evaluate("document.querySelector('canvas[data-home-whale]').dispatchEvent(new MouseEvent('click',{bubbles:true}))")
    page.wait_for_function("""() => {const c=document.querySelector('canvas[data-home-whale]');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let sum=0;for(let i=3;i<p.length;i+=16)sum+=p[i];if(!sum)return false;const prev=window.pixelSum;window.pixelSum=sum;return prev && sum!==prev;}""")
    page.screenshot(path=fixture / ('home-'+engine+'.png'))
    page.emulate_media(reduced_motion='reduce')
    assert chip.locator('svg [class]').first.evaluate("e=>getComputedStyle(e).animationName")=='none'
    page.emulate_media(reduced_motion='no-preference')
    expect(chip).to_have_attribute('data-scene', 'storm')
    assert received == [{'mode':'weather'}]
    expected_clock = page.evaluate("t=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t)", timestamp*1000)
    assert expected_clock in chip.get_attribute('aria-label')
    assert chip.get_attribute('role') == 'img' and chip.get_attribute('title') is None
    assert chip.evaluate('e => e.tabIndex') == -1
    chip.tap()
    expect(page.locator('dialog[open], #dml-weather-info')).to_have_count(0)
    assert received == [{'mode':'weather'}]
    page.evaluate("__DSH_MOBILE_BRIDGE__.openHub('tools')")
    pref = page.get_by_role('checkbox',name='显示电脑所在地天气（Open-Meteo）')
    pref.uncheck()
    page.wait_for_function("document.querySelector('#dml-weather').dataset.scene!=='storm'")
    pref.check()
    page.wait_for_function("document.querySelector('#dml-weather').getAttribute('aria-label').includes('暂不可用')")
    page.get_by_role('button',name='关闭工具箱').click()
    assert page.evaluate('geoCalls') == 0
    assert {'mode':'clock'} in received
    for title in ['插件','自动化任务']:
        page.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
        page.get_by_role('button', name=title, exact=True).first.click()
        page.wait_for_function("hubReports.at(-1)?.visible===true")
        heading = page.locator('[data-global-panel] h1').first
        heading.wait_for()
        offset = heading.evaluate("e=>e.getBoundingClientRect().top-e.closest('[data-global-panel]').getBoundingClientRect().top")
        assert 8 <= offset <= 24, (title, offset)

        expect(page.locator('[data-dml-hub-trigger]:visible')).to_have_count(0)
        page.evaluate("__DSH_MOBILE_BRIDGE__.openHub('tasks')")
        close=page.get_by_role('button',name='关闭工具箱');close.wait_for()
        page.wait_for_function("hubReports.at(-1)?.visible===false");close.click()
    page.evaluate('__DSH_MOBILE_BRIDGE__.newSession()')
    expect(page.locator('[data-dml-hub-trigger]:visible')).to_have_count(1)
    page.wait_for_function("hubReports.at(-1)?.visible===false")
    # Pass the cold_history.py seed ID to also check the actual text run, not
    # the padded breadcrumb box. Blank sessions deliberately have no title.
    if len(sys.argv) > 3:
        page.evaluate('sid => __DSH_MOBILE_BRIDGE__.openSession(sid)', sys.argv[3])
        crumb = page.locator('header nav [class$="_crumbCurrent"]').first
        crumb.wait_for(timeout=30000)
        for width in [320, 393, 430]:
            page.set_viewport_size({'width':width,'height':745})
            x = crumb.evaluate("e=>{const r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().left}")
            assert abs(x - 60) <= 1, (engine, width, x)
            # The desktop menu has a fixed width. On a phone, compare actual
            # text ink (not its flex container) to the inset before the icon.
            page.locator('[class$="_viewsMoreAnchor"] button[aria-haspopup="menu"]').click()
            browse = page.get_by_role('menuitem', name='浏览更多插件', exact=True)
            browse.wait_for()
            left, right = browse.evaluate("""row => {
                const menu = row.closest('[role="menu"]').getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(row.querySelector('[class$="_itemLabel"]'));
                return [row.querySelector('svg').getBoundingClientRect().left - menu.left,
                        menu.right - range.getBoundingClientRect().right];
            }""")
            assert 0 < left and abs(left - right) <= 1, (engine, width, left, right)
            page.keyboard.press('Escape')
            browse.wait_for(state='hidden')
        page.screenshot(path=fixture / ('conversation-title-'+engine+'.png'))
    print(engine, 'PASS: centered card, animated whale, weather, panel navigation and return to conversation')
