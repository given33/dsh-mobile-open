"""Browser regression for the shipped shell. No desktop profile or model access.
CHROMIUM_PATH / WEBKIT_PATH may select installed browser binaries.
"""
import json, os, subprocess, faulthandler
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[3]
faulthandler.dump_traceback_later(90, exit=True)
assets = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    """const m=await import(process.argv[1]); console.log(JSON.stringify({
      html:m.injectMobileShell('<html><head><meta charset="utf-8"></head><body><div id="root"><section data-conversation-content data-conversation-session="temporary" data-content-phase="hero"><div data-composer-card>NEW CHAT PLACEHOLDER</div></section></div></body></html>'),
      css:m.MOBILE_SHELL_CSS,js:m.MOBILE_SHELL_JS,policy:m.RECONNECT_POLICY
    }));""",
    (repo / "desktop/lib/mobile-shell.mjs").as_uri()
], text=True, encoding="utf-8"))

# [elapsed milliseconds since mux start, automatic bridge method, calls, cumulative forces].
# npm test also checks these same expected totals against the shipped policy.
RECONNECT_TIMELINE = [
    [0, "wakeCheck", 10, 0],
    [1600, "wakeCheck", 1, 0],
    [1600, "credentialsChanged", 1, 0],
    [11500, "wakeCheck", 1, 0],
    [12100, "wakeCheck", 10, 1],
    [13700, "wakeCheck", 1, 1],
    [13700, "credentialsChanged", 1, 1],
    [17200, "wakeCheck", 1, 2]
]

with sync_playwright() as pw:
    for engine, env in [(pw.chromium, "CHROMIUM_PATH"), (pw.webkit, "WEBKIT_PATH")]:
        if os.getenv("SHELL_TEST_ENGINE") and os.environ["SHELL_TEST_ENGINE"] != engine.name:
            continue
        with engine.launch(executable_path=os.environ.get(env)) as browser:
            ctx = browser.new_context(viewport={"width":393,"height":780},has_touch=True)
            ctx.add_init_script("""
              window.__events=[];window.__calls=0;window.__reconnects=0;
              window.__DSH_MOBILE_LAUNCH__={resume:'history',mode:'resume'};
              window.webkit={messageHandlers:{dshMobile:{postMessage:m=>__events.push(m)}}};
              localStorage.setItem('dml.lastSession','history');
              localStorage.setItem('dml.visualSnap.v1',JSON.stringify({
                v:2,ts:Date.now(),sessionId:'history',bg:'#151517',fg:'#fff',
                html:'<div data-dml-snap-content style="padding:40px">SAVED HISTORY</div>'
              }));
              window.WebSocket=class extends EventTarget { readyState=0; };
              window.__pokes=0;
              window.fetch=path=>{__calls++;if(String(path).includes('poke=1'))__pokes++;return new Promise(()=>{});};
              window.__DSH_MOBILE_CORDIS__={reconnect:()=>{__reconnects++;return true;}};
            """)
            def route(r):
                path = r.request.url.split("?")[0]
                if path.endswith("shell.css"): r.fulfill(body=assets["css"].encode("utf-8"),content_type="text/css; charset=utf-8")
                elif path.endswith("shell.js"): r.fulfill(body=assets["js"].encode("utf-8"),content_type="text/javascript; charset=utf-8")
                else: r.fulfill(body=assets["html"].encode("utf-8"),content_type="text/html; charset=utf-8")
            ctx.route("https://shell.test/**", route)
            page=ctx.new_page()
            errors=[]
            page.on("pageerror",lambda e: errors.append(str(e)))
            page.clock.install()
            page.goto("https://shell.test/")
            page.wait_for_function("!!window.__DSH_MOBILE_BRIDGE__")
            page.evaluate("window.__DSH_MOBILE_ROUTE_STATE__={intent:true,saved:'history'}")
            page.clock.fast_forward(30000)
            assert page.locator("#dml-snap-curtain").is_visible()
            assert not page.locator("#root").is_visible()
            assert not page.evaluate("__events.some(e=>e.type==='launch-applied')")
            # The real view must paint behind the saved snapshot before it is removed.
            painted=page.evaluate("""async()=>{
              document.querySelector('[data-conversation-content]').dataset.conversationSession='history';
              document.querySelector('[data-conversation-content]').innerHTML='<div data-conversation-scroll style="height:200px;overflow:auto"><div style="height:2000px">History</div><p>LATEST RECORD</p></div><div data-composer-card></div>';
              const b=__DSH_MOBILE_BRIDGE__;
              window.__paintFrames=[];
              function sample(){
                const s=document.querySelector('[data-conversation-scroll]');
                if(s)__paintFrames.push({cover:!!document.getElementById('dml-snap-curtain'),bottom:s.scrollHeight-s.clientHeight-s.scrollTop});
                if(__paintFrames.length<30)requestAnimationFrame(sample);
              }
              requestAnimationFrame(sample);
              let done=false;b.onLaunchHydrated(()=>done=true,{latest:true});
              const underneath=getComputedStyle(document.getElementById('root')).visibility;
              const curtainStillPresent=!!document.getElementById('dml-snap-curtain');
              await new Promise(requestAnimationFrame);
              return {underneath,curtainStillPresent,done};
            }""")
            assert painted["underneath"]=="visible" and painted["curtainStillPresent"]
            page.clock.run_for(80)
            assert page.locator("#dml-snap-curtain").count()==0
            paint_frames=page.evaluate("__paintFrames")
            assert any(not f["cover"] for f in paint_frames)
            assert all(f["bottom"]<=1 for f in paint_frames if not f["cover"]), paint_frames
            print(engine.name+": first uncovered frame already shows latest record",flush=True)
            # Start a fresh transport handshake after the paint fixture advanced the clock.
            page.evaluate("new WebSocket('wss://shell.test/api/remote.mux'); void 0")
            previous = 0
            for elapsed, method, repeats, expected in RECONNECT_TIMELINE:
                if elapsed > previous:
                    page.clock.fast_forward(elapsed - previous)
                probes, forces = page.evaluate("""([method, repeats])=>{
                  const before=__pokes;
                  for(let i=0;i<repeats;i++) __DSH_MOBILE_BRIDGE__[method]();
                  return [__pokes-before, __reconnects];
                }""", [method, repeats])
                if repeats > 1:
                    assert probes == 1, (elapsed, probes)
                assert forces == expected, (elapsed, method, forces, expected)
                previous = elapsed
            print(engine.name+": verified wake storm, handshake grace and minimum force gap PASS",flush=True)
            page.clock.fast_forward(assets["policy"]["minForceReconnectGapMs"])
            lifecycle=page.evaluate("""()=>{
              const events = (target, ...types) => types.forEach(name=>target.dispatchEvent(new Event(name)));
              const start = [__calls, __reconnects];
              events(window,'pageshow');
              let state = 'hidden';
              Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>state});
              events(document,'visibilitychange','freeze');
              events(window,'pagehide','offline','online','pageshow');
              __DSH_MOBILE_BRIDGE__.wakeCheck();
              const hidden = [__calls-start[0], __reconnects-start[1]];
              state = 'visible';
              events(document,'visibilitychange','resume');
              events(window,'pageshow','online');
              __DSH_MOBILE_BRIDGE__.wakeCheck();
              delete document.visibilityState;
              return {hidden, resumed:[__calls-start[0], __reconnects-start[1]]};
            }""")
            assert lifecycle=={"hidden":[0,0],"resumed":[1,1]}, lifecycle
            page.evaluate("""()=>{
              __DSH_MOBILE_ROUTE_STATE__.intent=false;
              window.mountReading=(id,height)=>{
                document.getElementById('root').innerHTML=`<section data-conversation-content data-conversation-session="${id}"><div data-conversation-scroll style="height:200px;overflow:auto"><div style="height:${height}px">Message</div></div></section>`;
                __DSH_MOBILE_CORDIS__.getCurrentSessionId=()=>id;
                __DSH_MOBILE_BRIDGE__.reportSelection();
              };
              window.setReading=top=>{const e=document.querySelector('[data-conversation-scroll]');e.scrollTop=top;e.dispatchEvent(new Event('scroll'));};
              mountReading('a',2000);
            }""")
            page.clock.run_for(90)
            page.evaluate("setReading(420); mountReading('b', 2000)")
            page.clock.run_for(90)
            page.evaluate("setReading(1800); mountReading('a', 2400)")
            page.clock.run_for(90)
            top = "document.querySelector('[data-conversation-scroll]').scrollTop"
            assert page.evaluate(top)==420, page.evaluate(top)
            page.evaluate("mountReading('b', 2600)")
            page.clock.run_for(90)
            assert page.evaluate(top)==2400, page.evaluate(top)
            print(engine.name+": single true lifecycle resume and per-session scroll restoration PASS",flush=True)
            page.evaluate("setReading(1000)")
            page.clock.run_for(90)
            fallback = page.locator('.dsh-scroll-bottom')
            up = page.locator('.dsh-scroll-top')
            assert fallback.is_visible() and up.is_visible()
            page.evaluate('''()=>{
              document.querySelector('[data-conversation-content]').insertAdjacentHTML('beforeend',
                '<div class="x_toBottomSlot"><button aria-label="最下部へ戻る">↓</button></div>');
            }''')
            official = page.locator('.x_toBottomSlot button')
            official.evaluate("b => b.onclick = () => { window.followed = true; setReading(2400) }")
            assert not official.is_visible() and up.is_visible() and fallback.is_visible()
            page.evaluate('''()=>{
              const dialog = document.createElement('dialog'); dialog.className='dml-hub-backdrop';
              document.body.append(dialog); dialog.showModal();
            }''')
            assert not official.is_visible() and not up.is_visible() and not fallback.is_visible()
            page.evaluate("document.querySelector('dialog').close()")
            assert not official.is_visible() and up.is_visible() and fallback.is_visible()
            fallback.click()
            assert page.evaluate("window.followed")
            page.evaluate("document.querySelector('.x_toBottomSlot').remove(); setReading(2400)")
            page.clock.run_for(90)
            assert not fallback.is_visible() and up.is_visible()
            page.evaluate('setReading(0)')
            page.clock.run_for(90)
            assert fallback.is_visible() and not up.is_visible()
            print(engine.name+": scroll directions, custom-only button and host follow-tail and modal isolation PASS",flush=True)
            # Modal image preview isolates the background and supports Escape.
            page.evaluate("""()=>{
              const root=document.getElementById('root');root.innerHTML='<div data-conversation-scroll><img alt="sample" width="100" height="100"></div>';
              root.querySelector('img').src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';
            }""")
            page.locator("#root img").click()
            assert page.locator('.dsh-lightbox[role="dialog"]').count()==1
            assert page.locator("#root").get_attribute("inert") is not None
            assert page.evaluate("document.activeElement.textContent")=="关闭", page.evaluate("document.activeElement.outerHTML")
            page.keyboard.press("Escape")
            page.clock.run_for(250)
            assert page.locator(".dsh-lightbox").count()==0
            assert page.locator("#root").get_attribute("inert") is None
            # Cosmetic motion follows the system preference.
            page.emulate_media(reduced_motion="reduce")
            assert page.evaluate("getComputedStyle(document.querySelector('.dsh-scroll-bottom')).transitionDuration")=="0s"
            assert not errors, errors
            print(engine.name+": delayed restoration, snapshot paint, wake coalescing, modal focus and reduced motion PASS",flush=True)
            # Persist storage, destroy the browser process, then relaunch with an
            # older snapshot from a DIFFERENT conversation. It must never appear.
            page.evaluate("""()=>{
              const old=JSON.parse(localStorage.getItem('dml.visualSnap.v1'));
              old.sessionId='other';old.html='<div>WRONG OLD CONVERSATION</div>';
              localStorage.setItem('dml.visualSnap.v1',JSON.stringify(old));
            }""")
            saved=ctx.storage_state()
            print(engine.name+": persisted storage; destroying browser",flush=True)
            ctx.close()
            browser.close()
            print(engine.name+": launching a new browser process",flush=True)
            with engine.launch(executable_path=os.environ.get(env)) as restarted:
                print(engine.name+": browser restarted",flush=True)
                # WebKit's storage_state importer navigates each origin BEFORE
                # context routes exist. Restore localStorage in our intercepted
                # document, not via a real network request to the fixture domain.
                cold=restarted.new_context(viewport={"width":393,"height":780})
                entries=next(o["localStorage"] for o in saved["origins"] if o["origin"]=="https://shell.test")
                cold.add_init_script("for(const e of "+json.dumps(entries)+")localStorage.setItem(e.name,e.value);")
                print(engine.name+": restored storage context",flush=True)
                cold.add_init_script("""
                  window.__events=[];
                  window.__DSH_MOBILE_LAUNCH__={resume:'history',mode:'resume'};
                  window.webkit={messageHandlers:{dshMobile:{postMessage:m=>__events.push(m)}}};
                  window.fetch=()=>new Promise(()=>{});
                  window.__frames=[];
                  function sample(){
                    const root=document.getElementById('root');
                    const curtain=document.getElementById('dml-snap-curtain');
                    __frames.push(curtain?.textContent || (root&&getComputedStyle(root).visibility==='visible'?root.textContent:'covered'));
                    if(__frames.length<400)requestAnimationFrame(sample);
                  }
                  requestAnimationFrame(sample);
                """)
                cold.route("https://shell.test/**",route)
                pg=cold.new_page()
                print(engine.name+": loading cold document",flush=True)
                pg.goto("https://shell.test/",wait_until="commit")
                pg.wait_for_function("!!window.__DSH_MOBILE_BRIDGE__")
                print(engine.name+": cold bridge ready",flush=True)
                assert pg.locator("#dml-snap-curtain").count()==0
                assert not pg.locator("#root").is_visible()
                pg.evaluate("""()=>{
                  document.querySelector('[data-conversation-content]').dataset.conversationSession='history';
                  document.querySelector('[data-conversation-content]').innerHTML='<div data-conversation-scroll>LATEST RECORD</div><div data-composer-card></div>';
                  __DSH_MOBILE_BRIDGE__.onLaunchHydrated(()=>{}, {latest:true});
                }""")
                pg.wait_for_function("__frames.includes('LATEST RECORD')")
                assert set(pg.evaluate("__frames")).issubset({"covered","LATEST RECORD"})
                artifacts=Path(os.environ.get("DSH_QA_OUTPUT",str(repo/"build/qa-cold-start"))).resolve()
                artifacts.mkdir(parents=True,exist_ok=True)
                (artifacts/(engine.name+"-frames.json")).write_text(json.dumps(pg.evaluate("__frames")),encoding="utf-8")
                pg.screenshot(path=str(artifacts/(engine.name+"-latest.png")))
                print(engine.name+": browser process destroyed and restarted; no wrong conversation in any sampled frame PASS",flush=True)
faulthandler.cancel_dump_traceback_later()
