"""Render the ConversationRoot > ChatView > SessionPanel clipping chain, with the shipped shell.
Set CHROMIUM_PATH for Edge, WEBKIT_PATH for WebKit, and DSH_QA_OUTPUT to retain PNGs and geometry.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
PAGE = r"""<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>铂金理论</title><style>
*{box-sizing:border-box}html,body{margin:0;color-scheme:dark;background:#18191c;color:#e5e6ea;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
.an3WzG_root{height:100dvh;display:flex;flex-direction:column;position:relative}.an3WzG_root[data-phase=active]{overflow:hidden}.an3WzG_header{flex:none;border-bottom:1px solid #393a40;background:#1e1f23;z-index:10}.toolbar{height:48px;display:flex;align-items:center;padding:0 12px;gap:6px}.toolbar strong{font-weight:600;font-size:15px;flex:1}.tool{width:34px;height:34px;border-radius:8px;padding:0;display:grid;place-items:center}.tool svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.tool[aria-expanded=true]{background:#373a42}.tools{display:flex;gap:6px;position:absolute;left:202px;top:10px}.tabs{height:35px;display:flex;align-items:stretch;gap:14px;padding-left:16px;color:#a3a5ad;font-size:13px}.tabs span{display:grid;place-items:center;padding:0 3px}.tabs .selected{color:#eef0f5;border-bottom:2px solid #a8b5e7}
[data-conversation-content]{flex:1;min-height:0;display:flex;flex-direction:column}[data-conversation-scroll]{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch}.chat-root{overflow:visible clip;display:flex;flex-direction:column;position:relative;min-height:100%}[data-chat-aside]{position:sticky;top:0;z-index:9;height:0;pointer-events:none}
._2ImnHa_panel{position:absolute;right:10px;top:12px;width:min(280px,calc(100% - 20px));max-height:500px;overflow-y:auto;pointer-events:auto;border:0;border-radius:12px;padding:6px 8px;background:#2b2c31;color:#ededf0;box-shadow:0 9px 30px #0007,0 0 0 1px #ffffff12}._2ImnHa_section{padding:4px 0 6px}._2ImnHa_head{display:flex;align-items:center;min-height:24px;padding:0 6px}._2ImnHa_title{color:#b8bac3;margin:0;font-size:12px;font-weight:500}[data-session-panel-row]{display:flex;align-items:center;min-height:34px;padding:0 5px;gap:8px;border-radius:6px}[data-row-part=body]{flex:1}.path{color:#b7b9c2;font-size:12px}.more{border-radius:5px;width:28px;height:26px;line-height:14px;background:#37383f}
.JGoLlq_portal{position:fixed;z-index:1000;width:172px;padding:4px;background:#34363c;color:#f5f5f7;border:1px solid #55575e;border-radius:9px;box-shadow:0 5px 18px #0006}.JGoLlq_portal button{text-align:left;width:100%;padding:5px 9px;font-size:13px}.JGoLlq_portal button+button{border-top:1px solid #494b51}
article{padding:62px 19px 24px;color:#c9cbd3}article p{margin:10px 0 24px}.subtle{color:#90939d;font-size:12px}.bubble{margin:0 0 24px auto;background:#30323a;width:fit-content;padding:9px 13px;border-radius:15px}footer{margin:12px 14px 21px;border:1px solid #42444c;border-radius:15px;padding:12px 14px;color:#93959e;font-size:13px}.footer-tools{margin-top:15px;display:flex;justify-content:space-between}
</style></head><body data-ds-dark-theme><div id="root"><div class="an3WzG_root" data-phase="active"><header class="an3WzG_header"><div class="toolbar"><span>☰</span><strong>铂金理论</strong><div class="tools"><button class="tool" aria-label="工具箱"><svg viewBox="0 0 24 24"><path d="M4 8h16v11H4zM9 8V5h6v3M4 12h16"/></svg></button><button id="dsh-session-panel-toggle-chat" class="tool" data-session-panel-toggle aria-label="列表" aria-expanded="false" aria-controls="dsh-session-panel-chat"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM13 5v14M16 9h1M16 12h1"/></svg></button></div></div><div class="tabs"><span class="selected">对话</span><span>轨迹</span></div></header>
<div data-conversation-content data-conversation-session="chat" data-content-phase="active"><div data-conversation-scroll><div class="chat-root V4vHZW_root"><div data-chat-aside class="V4vHZW_asideSlot"></div><article><div class="bubble">看一下当前工作目录。</div><small class="subtle">DeepSeek Harness</small><p>工作区已连接。可以在环境面板中查看项目目录。</p></article></div></div></div><footer>发送消息…<div class="footer-tools"><span>＋</span><span>↑</span></div></footer></div></div>
<template id="panel-template"><aside class="_2ImnHa_panel" id="dsh-session-panel-chat" data-session-panel="overlay"><section class="_2ImnHa_section" data-session-panel-section="environment"><div class="_2ImnHa_head"><h2 class="_2ImnHa_title">环境</h2></div><div data-session-panel-row data-session-panel-project><span aria-hidden="true">▱</span><span data-row-part="body">铂金理论 <span class="path">· D:\</span></span><button data-row-part="menu" class="more" aria-label="目录操作">···</button></div></section></aside></template>
<script>
const toggle=document.querySelector('[data-session-panel-toggle]'),slot=document.querySelector('[data-chat-aside]');
toggle.onclick=()=>{toggle.setAttribute('aria-expanded','true');setTimeout(()=>slot.replaceChildren(document.querySelector('template').content.cloneNode(true)),25);};
document.addEventListener('click', e=>{if(!e.target.closest('.more'))return;
 const menu=document.createElement('div');menu.className='JGoLlq_portal';menu.setAttribute('role','menu');menu.setAttribute('data-anchor-side','top');menu.setAttribute('data-anchor-align','end');menu.innerHTML='<button role="menuitem">复制目录路径</button><button role="menuitem">查看工作区</button>';document.body.append(menu);});
</script></body></html>"""


def verify(engine, executable, out):
    assets = json.loads(
        subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                """
      import fs from 'node:fs';const m=await import(process.argv[1]);
      console.log(JSON.stringify({html:m.injectMobileShell(fs.readFileSync(0,'utf8')),css:m.MOBILE_SHELL_CSS,js:m.MOBILE_SHELL_JS}));""",
                (REPO / "desktop/lib/mobile-shell.mjs").as_uri(),
            ],
            input=PAGE.encode(),
        )
    )
    with engine.launch(executable_path=executable) as browser:
        page = browser.new_page(
            viewport={"width": 393, "height": 852},
            device_scale_factor=1,
            color_scheme="dark",
            locale="zh-CN",
        )
        page.add_init_script("""const observe=MutationObserver.prototype.observe;window.rootSubtreeObservers=0;
          MutationObserver.prototype.observe=function(target,opts){if(target.id==='root'&&opts.subtree)rootSubtreeObservers++;
          return observe.call(this,target,opts)}""")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route(req):
            path = req.request.url.split("?")[0]
            for name, mime in [("css", "text/css"), ("js", "text/javascript")]:
                if path.endswith("shell." + name):
                    req.fulfill(
                        body=assets[name].encode(),
                        content_type=mime + "; charset=utf-8",
                    )
                    return
            if path.endswith("/mobile/v1/sync"):
                req.fulfill(json={"actions": True, "terminal": False})
                return
            req.fulfill(
                body=assets["html"].encode(), content_type="text/html; charset=utf-8"
            )

        page.route("https://shell.test/**", route)
        page.goto("https://shell.test/")
        page.get_by_role("button", name="列表").click()
        panel = page.locator("aside")
        page.wait_for_selector("aside:popover-open")
        metrics = page.evaluate("""()=>{
          const panel=document.querySelector('aside'), toggle=document.querySelector('[data-session-panel-toggle]');
          const rect=el=>el.getBoundingClientRect().toJSON(), p=rect(panel), t=rect(toggle),v={width:innerWidth,height:innerHeight};
          const hit=(x,y)=>panel.contains(document.elementFromPoint(x,y));
          const points=[[p.left+12,p.top+2],[p.right-12,p.top+2],[p.left+12,p.bottom-2],[p.right-12,p.bottom-2]];
          const ancestors=['[data-phase]','[data-conversation-content]','[data-conversation-scroll]','.chat-root','[data-chat-aside]'].map(s=>{
            const el=panel.closest(s),c=getComputedStyle(el);return {selector:s,rect:rect(el),overflowX:c.overflowX,overflowY:c.overflowY,position:c.position,zIndex:c.zIndex};});
          const title=document.querySelector('h2'),h=rect(title);return {viewport:v,toggle:t,panel:p,ancestors,
            popoverOpen:panel.matches(':popover-open'),origin:getComputedStyle(panel).transformOrigin,
            cornerRadius:getComputedStyle(panel).borderRadius,topCornersAndBottomCornersHit:points.map(([x,y])=>hit(x,y)),
            titleHit:title.contains(document.elementFromPoint(h.x+h.width/2,h.y+h.height/2)),
            outOfViewport:p.x<0||p.y<0||p.right>v.width||p.bottom>v.height,
            clippedByScroll:!hit(p.x+p.width/2,p.y+3),sameParent:panel.parentElement.matches('[data-chat-aside]')};}""")
        p, t = metrics["panel"], metrics["toggle"]
        assert p["top"] == t["bottom"] + 6 and p["left"] == max(
            10,
            min(round(t["x"] + t["width"] / 2 - p["width"] / 2), 393 - 10 - p["width"]),
        ), metrics
        assert (
            metrics["sameParent"]
            and metrics["popoverOpen"]
            and metrics["titleHit"]
            and all(metrics["topCornersAndBottomCornersHit"])
        ), metrics
        assert (
            not metrics["outOfViewport"]
            and not metrics["clippedByScroll"]
            and p["y"] < metrics["ancestors"][2]["rect"]["y"]
        )
        page.screenshot(path=out / "session-panel-fixed.png")
        page.get_by_role("button", name="目录操作").click()
        menu = page.locator("body > [role=menu]")
        page.wait_for_selector("body > [role=menu]:popover-open")
        menu.evaluate(
            "async el=>{await Promise.all(el.getAnimations().map(a=>a.finished))}"
        )
        metrics["menu"] = (
            menu.evaluate("""el=>{const m=el.getBoundingClientRect(),p=document.querySelector('aside').getBoundingClientRect();
          const x=(Math.max(p.left,m.left)+Math.min(p.right,m.right))/2,y=(Math.max(p.top,m.top)+Math.min(p.bottom,m.bottom))/2;
          return {rect:m.toJSON(),popoverOpen:el.matches(':popover-open'),overlap:x>=m.left&&x<=m.right&&x>=p.left&&x<=p.right&&y>=p.top&&y<=p.bottom&&y>=m.top&&y<=m.bottom,
          overlapPoint:{x,y},frontmost:el.contains(document.elementFromPoint(x,y))};}""")
        )
        assert metrics["menu"]["overlap"] and metrics["menu"]["frontmost"], metrics[
            "menu"
        ]
        page.screenshot(path=out / "session-panel-with-context-menu.png")
        # A later body portal must also win the hit test against its parent menu.
        menu.evaluate("""el=>{el.setAttribute('data-dsh-anchor-name','--fixture-sub');
          const sub=document.createElement('div');sub.className='JGoLlq_portal';sub.setAttribute('data-dsh-submenu-parent','--fixture-sub');
          sub.setAttribute('data-submenu-layout','page');sub.textContent='子菜单';document.body.append(sub)}""")
        sub = page.locator("[data-dsh-submenu-parent]")
        page.wait_for_selector("[data-dsh-submenu-parent]:popover-open")
        sub.evaluate(
            "async el=>{await Promise.all(el.getAnimations().map(a=>a.finished))}"
        )
        metrics["submenuFrontmost"] = (
            sub.evaluate("""el=>{const s=el.getBoundingClientRect(),m=document.querySelector('[role=menu]').getBoundingClientRect();
          const x=Math.max(s.left,m.left)+8,y=Math.max(s.top,m.top)+8;
          return x<Math.min(s.right,m.right)&&y<Math.min(s.bottom,m.bottom)&&el.contains(document.elementFromPoint(x,y))}""")
        )
        assert metrics["submenuFrontmost"]
        sub.evaluate("el=>el.remove()")
        menu.evaluate("el=>el.style.visibility='hidden'")
        page.wait_for_function(
            "!document.querySelector('[role=menu]').hasAttribute('popover')"
        )
        menu.evaluate("el=>el.style.visibility=''")
        page.wait_for_selector("[role=menu]:popover-open")
        menu.evaluate("el=>el.hidden=true")
        page.wait_for_function(
            "!document.querySelector('[role=menu]').hasAttribute('popover') && !document.documentElement.hasAttribute('data-dml-popup-open')"
        )
        menu.evaluate("el=>el.hidden=false")
        page.wait_for_selector("[role=menu]:popover-open")
        menu.evaluate("el=>{window.removedMenu=el;el.remove()}")
        page.wait_for_function("!removedMenu.hasAttribute('popover')")
        panel.evaluate("el=>{window.samePanel=el;el.dataset.sessionPanel='docked'}")
        page.wait_for_function("!samePanel.hasAttribute('data-dml-anchored')")
        metrics["docked"] = panel.evaluate(
            "el=>({sameNode:el===samePanel,sameParent:el.parentElement.matches('[data-chat-aside]'),open:el.matches(':popover-open'),popover:el.hasAttribute('popover'),anchored:el.hasAttribute('data-dml-anchored'),variables:[...el.style].filter(s=>s.startsWith('--dml-panel-')),position:getComputedStyle(el).position})"
        )
        assert metrics["docked"] == {
            "sameNode": True,
            "sameParent": True,
            "open": False,
            "popover": False,
            "anchored": False,
            "variables": [],
            "position": "absolute",
        }
        panel.evaluate("el=>el.dataset.sessionPanel='overlay'")
        page.wait_for_selector("aside:popover-open")
        page.locator("[data-session-panel-toggle]").evaluate(
            "el=>el.setAttribute('aria-expanded','false')"
        )
        page.wait_for_function("!samePanel.hasAttribute('popover')")
        page.get_by_role("button", name="列表").click()
        page.wait_for_function(
            "document.querySelector('aside:popover-open') && document.querySelector('aside:popover-open') !== samePanel"
        )
        panel.evaluate(
            "el=>{window.detachedPanel=el;el.closest('[data-conversation-content]').remove()}"
        )
        page.wait_for_function(
            "!detachedPanel.hasAttribute('popover') && !detachedPanel.hasAttribute('data-dml-anchored')"
        )
        metrics["unmountedPanelReleased"] = True
        metrics["rootSubtreeObservers"] = page.evaluate("rootSubtreeObservers")
        assert metrics["rootSubtreeObservers"] == 0
        assert not errors, errors
        metrics.update(
            browser=browser.version,
            engine=engine.name,
            hiddenMenuReleased=True,
            removedMenuReleased=True,
            collapsedPanelReleased=True,
            pageErrors=errors,
        )
        (out / "session-panel-geometry.json").write_text(
            json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            f"{engine.name} {browser.version}: panel ({p['x']}, {p['y']}) {p['width']}x{p['height']}, title + four edge hits, menu overlap, release/dock PASS"
        )


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temp, sync_playwright() as pw:
        output = Path(os.environ.get("DSH_QA_OUTPUT", temp))
        output.mkdir(parents=True, exist_ok=True)
        engine = os.environ.get("SHELL_TEST_ENGINE", "chromium")
        verify(
            getattr(pw, engine),
            os.environ.get("CHROMIUM_PATH" if engine == "chromium" else "WEBKIT_PATH"),
            output,
        )
