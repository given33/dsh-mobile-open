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
    page.add_init_script("""window.__DSH_NATIVE_PANEL_HUB__=1;window.__DSH_MOBILE_LAUNCH__={mode:'new'};
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
    chip.click()
    expected_clock = page.evaluate("t=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t)", timestamp*1000)
    expect(page.locator('#dml-weather-info strong')).to_contain_text(expected_clock)
    page.get_by_role('button',name='仅显示电脑时间').click()
    expect(page.locator('#dml-weather-info p')).to_contain_text('配对电脑时间')
    page.wait_for_function("document.querySelector('#dml-weather').dataset.scene!=='storm'")
    page.get_by_role('button',name='显示电脑所在地天气').click()
    expect(page.locator('#dml-weather-info p')).to_contain_text('暂不可用')
    assert page.evaluate('geoCalls') == 0
    assert {'mode':'clock'} in received
    page.locator('#dml-weather-info [data-close]').click()
    for title in ['插件','自动化任务']:
        page.evaluate('__DSH_MOBILE_BRIDGE__.toggleSidebar()')
        page.get_by_role('button', name=title, exact=True).first.click()
        page.wait_for_function("hubReports.at(-1)?.visible===true")
        expect(page.locator('[data-dml-hub-trigger]:visible')).to_have_count(0)
        page.evaluate("__DSH_MOBILE_BRIDGE__.openHub('tasks')")
        close=page.get_by_role('button',name='关闭工具箱');close.wait_for()
        page.wait_for_function("hubReports.at(-1)?.visible===false");close.click()
    page.evaluate('__DSH_MOBILE_BRIDGE__.newSession()')
    expect(page.locator('[data-dml-hub-trigger]:visible')).to_have_count(1)
    page.wait_for_function("hubReports.at(-1)?.visible===false")
    print(engine, 'PASS: centered card, animated whale, weather, panel navigation and return to conversation')
