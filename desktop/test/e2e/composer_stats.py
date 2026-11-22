"""Check the stats dock in an isolated official fixture with a completed session.

Arguments: fixture output directory, seeded session ID. WEBKIT_PATH or
CHROMIUM_PATH may point to a local Playwright-compatible browser executable.
"""
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from workspace_sync import connect


def check(browser, host, sid):
    phone, _ = connect(browser, host)
    dismiss = phone.get_by_role('dialog').get_by_role('button', name='继续', exact=True)
    if dismiss.count():
        dismiss.click()
    phone.wait_for_function('!!window.__DSH_MOBILE_CORDIS__?.openSession')
    phone.evaluate('id => window.__DSH_MOBILE_BRIDGE__.openSession(id)', sid)
    dock = phone.locator('[data-composer-dock]').filter(has=phone.locator('[data-composer-stat="usage"]'))
    usage = dock.locator('[data-composer-stat="usage"] button')
    activity = dock.locator('[data-composer-stat="activity"]')
    usage.wait_for(timeout=15000)
    activity.wait_for(timeout=15000)
    selector = ':is([data-dsh-anchor-name^="--dsh-context-"], [style*="--dsh-context-"]) > button'
    meter = dock.locator(selector)
    assert phone.locator('[data-composer-card]').locator(selector).count() == 0
    assert meter.count() == 1 and '%' in meter.inner_text()
    def readings(a, u):
        for typ, pair in [('activity', a), ('usage', u)]:
            dock.locator(f'[data-composer-stat="{typ}"] svg + span').evaluate('''(label, [first,second]) => {
                const sep = label.querySelector('[aria-hidden]') || document.createElement('span');
                sep.setAttribute('aria-hidden','true'); sep.textContent = '·'; label.replaceChildren(first,sep,second);
            }''', pair)

    def settle():
        phone.evaluate('() => new Promise(done => requestAnimationFrame(()=>requestAnimationFrame(done)))')

    readings(('11 轮 297 步', '239 tok/s'), ('62.6M tok', '缓存命中 96%'))
    for width, height in [(320, 650), (360, 720), (393, 745), (393, 385), (430, 820), (768, 750)]:
        phone.set_viewport_size({'width': width, 'height': height})
        settle()
        a, u = activity.bounding_box(), usage.bounding_box()
        assert a and u and abs(a['y'] + a['height']/2 - u['y'] - u['height']/2) < 2, (a, u)
        assert 0 <= a['x'] and a['x'] + a['width'] <= u['x'] + 1 and u['x'] + u['width'] <= width
        card = phone.locator('[data-composer-card]').bounding_box()
        m = meter.bounding_box()
        # Centered official desktop single-row layout with balanced gaps between activity, usage, and context meter.
        assert a['x'] >= card['x'] - 2 and m['x'] + m['width'] <= card['x'] + card['width'] + 2, (a, m, card)
        gap_au = u['x'] - (a['x'] + a['width'])
        gap_um = m['x'] - (u['x'] + u['width'])
        assert gap_au >= 2 and gap_um >= 2 and abs(gap_au - gap_um) <= 6, (gap_au, gap_um, a, u, m)
        assert u['y'] - (card['y'] + card['height']) >= 5, (card, u)
        assert abs(m['y'] + m['height']/2 - u['y'] - u['height']/2) < 2 and meter.locator('svg').is_visible()
        # Test the actual rendered text width, not just DOM presence; ellipses can hide numbers.
        shown = dock.locator('[data-composer-stat] svg + span').evaluate_all('''labels => labels.map(el => {
            if (el.clientWidth) return [el.textContent, el.scrollWidth - el.clientWidth];
            const pill = el.parentElement, style = getComputedStyle(pill,'::after');
            if (style.content === 'none') return ['', Infinity];
            const text = pill.dataset.dmlShortReading;
            const clone = el.cloneNode(false); clone.textContent = text;
            clone.style.cssText = 'display:inline-block!important;position:absolute;width:max-content;visibility:hidden';
            pill.append(clone); const width = clone.getBoundingClientRect().width; clone.remove();
            const box = getComputedStyle(pill);
            return [text, width - pill.clientWidth + parseFloat(box.paddingLeft) + parseFloat(box.paddingRight)];
        })''')
        assert all(overflow <= 1 for _, overflow in shown), (width, shown)
        assert all(number in shown[0][0] for number in ['11', '297', '239']) and all(number in shown[1][0] for number in ['62.6M', '96%']), shown
        assert usage.get_attribute('aria-label')
        if width == 393 and height == 745 and os.getenv('STATS_SCREENSHOT'):
            dock.screenshot(path=os.environ['STATS_SCREENSHOT'])
    phone.set_viewport_size({'width': 320, 'height': 650})
    readings(('11456 turns', '32990 steps · 239 tok/s'), ('1962.6M tok', 'Cache hit 99.99%'))
    settle()
    assert dock.get_attribute('data-dml-stats-fit') == 'short'
    assert '99.99%' in usage.get_attribute('data-dml-short-reading')
    readings(('1轮', '2步'), ('1K', '99%'))
    settle()
    assert dock.get_attribute('data-dml-stats-fit') is None
    phone.set_viewport_size({'width': 393, 'height': 745})
    meter.click(timeout=4000)
    assert meter.get_attribute('aria-expanded') == 'true' and phone.get_by_role('dialog').is_visible()
    meter.click()
    usage.click(timeout=4000)
    phone.locator('[role="dialog"] [data-session-stats-usage]').wait_for(timeout=4000)
    print('Single row, five readings on left, right-aligned context ring and percentage, both dialogs and live refit verified.')


if __name__ == '__main__':
    fixture = json.loads((Path(sys.argv[1]) / 'host.json').read_text())
    assert urlsplit(fixture['base']).hostname == '127.0.0.1'
    assert Path(fixture['workspace']).resolve() == Path(fixture['home']).resolve() / 'test-workspace'
    with sync_playwright() as pw:
        webkit = os.getenv('WEBKIT_PATH')
        browser = pw.webkit.launch(executable_path=webkit) if webkit else pw.chromium.launch(
            executable_path=os.getenv('CHROMIUM_PATH'), args=['--no-proxy-server'])
        try:
            check(browser, fixture, sys.argv[2])
        finally:
            browser.close()
