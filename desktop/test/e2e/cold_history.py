"""Cold-process restore against a disposable official Harness, with frame evidence.

Seed using Python 3.14: cold_history.py --seed <new empty fixture home>
Start official-fixture.mjs with that home; then using Playwright/Python 3.11:
cold_history.py <fixture output directory> [chromium|webkit]
No real profile, conversation, model, or credentials are used.
"""
import json, os, re, sys, time
from pathlib import Path
from urllib.parse import urlsplit

SID = "session-cold-history-fixture"
LATEST = "COLD LATEST RECORD 30"
repo = Path(__file__).resolve().parents[3]

def seed(home):
    from compression import zstd
    home = home.resolve()
    assert home != Path.home() / ".dsh" and not (home / "sessions").exists()
    workspace = home / "test-workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    key = "--" + re.sub(r"[:/\\]+", "-", str(workspace)) + "--"
    destination = home / "sessions" / key / SID
    destination.mkdir(parents=True)
    now = int(time.time()*1000)
    events = [dict(type="session", id=SID, cwd=str(workspace), createdAt=now,
                   version=4, isSeeded=False, delegationDepth=0, agentPreset="standard")]
    def add(kind, data):
        event = dict(type=kind, data=data, time=now+len(events), seq=len(events)-1)
        if kind in ("user/message", "assistant/message"):
            event["surfaceOp"] = "append"
        events.append(event)
    for turn in range(1,31):
        add("turn/start",dict(turn=turn))
        add("step/start",dict(turn=turn,step=1))
        add("user/message",dict(role="user",id=f"u{turn}",source=dict(kind="user"),
            content=[dict(type="text",text=f"History question {turn}")]))
        if turn==1:
            add("session/title",dict(title="Cold history fixture",messageSeqs=[],source=dict(kind="user")))
        add("assistant/message",dict(turn=turn,step=1,stream=[],message=dict(
            role="assistant",id=f"a{turn}",source=dict(kind="model",provider="fixture",model="fixture"),
            content=[dict(type="text",text=LATEST if turn==30 else f"History answer {turn}. "*12)])))
        add("step/end",dict(turn=turn,step=1))
        add("turn/end",dict(turn=turn,reason=dict(kind="completed")))
    (destination / "session.v4.jsonl.zstd").write_bytes(b"".join(
        zstd.compress((json.dumps(e)+"\n").encode()) for e in events))
    print("Seeded 30 completed fixture turns; no model requests.",flush=True)

if sys.argv[1]=="--seed":
    seed(Path(sys.argv[2]))
    sys.exit(0)

from playwright.sync_api import sync_playwright
from workspace_sync import connect

fixture = json.loads((Path(sys.argv[1]) / "host.json").read_text())
assert urlsplit(fixture["base"]).hostname == "127.0.0.1"
assert Path(fixture["workspace"]).resolve() == Path(fixture["home"]).resolve()/"test-workspace"
name = sys.argv[2] if len(sys.argv)>2 else "chromium"
assert name in ("chromium", "webkit")
out = Path(os.environ.get("DSH_QA_OUTPUT", str(repo/"build/qa-cold-history"))) / name
out.mkdir(parents=True, exist_ok=True)
native = re.search(r'private static let nativeNavigation = """(.*?)"""',
    (repo/"DSHMobile/App/OfficialWebView.swift").read_text(encoding="utf-8"),re.S)[1]

with sync_playwright() as pw:
    engine = getattr(pw,name)
    browser = engine.launch(executable_path=os.getenv(name.upper()+"_PATH"))
    phone, pc = connect(browser, fixture)
    for page in (phone,pc):
        dismiss = page.get_by_role("dialog").get_by_role("button",name="继续",exact=True)
        if dismiss.count(): dismiss.click()
    phone.wait_for_function("!!window.__DSH_MOBILE_CORDIS__?.openSession")
    phone.evaluate("id=>__DSH_MOBILE_BRIDGE__.openSession(id)",SID)
    phone.get_by_text(LATEST,exact=True).wait_for(timeout=30000)
    phone.wait_for_function("!!document.querySelector('[data-conversation-scroll]')")
    phone.evaluate("""id=>{
      localStorage.setItem('dml.lastSession',id);
      const sc=document.querySelector('[data-conversation-scroll]');sc.scrollTop=0;
    }""",SID)
    phone.wait_for_timeout(300)
    assert phone.evaluate("__DSH_MOBILE_BRIDGE__.captureVisualSnapshot(true)"),phone.evaluate("__DSH_MOBILE_BRIDGE__.snapshotStatus?.()")
    print(name+": "+str(phone.evaluate("__DSH_MOBILE_BRIDGE__.snapshotStatus?.()")),flush=True)
    phone.screenshot(path=str(out/"before-exit.png"))
    snapshot=phone.evaluate("JSON.parse(localStorage.getItem('dml.visualSnap.v1'))")
    assert snapshot["v"]==2
    # The snapshot must render without ANY app CSS. This catches the ugly
    # unstyled-text frames that state/route assertions alone cannot detect.
    proof=browser.new_context(viewport={"width":393,"height":745},locale="zh-CN",is_mobile=True,has_touch=True)
    frozen=proof.new_page()
    frozen.set_content('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:'+snapshot["bg"]+'"><div id="dml-snap-curtain">'+snapshot["html"]+'</div></body></html>')
    frozen.evaluate("""()=>{for(const s of document.querySelectorAll('[data-dml-snap-y],[data-dml-snap-x]')){
      s.scrollTop=Number(s.dataset.dmlSnapY||0);s.scrollLeft=Number(s.dataset.dmlSnapX||0);
    }}""")
    frozen.screenshot(path=str(out/"frozen-without-css.png"))
    font='el=>({family:getComputedStyle(el).fontFamily,size:getComputedStyle(el).fontSize})'
    assert phone.get_by_text('History question 7',exact=True).evaluate(font)==frozen.get_by_text('History question 7',exact=True).evaluate(font)
    from PIL import Image, ImageChops, ImageStat
    diff=ImageChops.difference(Image.open(out/"before-exit.png").convert('RGB'),Image.open(out/"frozen-without-css.png").convert('RGB'))
    error=sum(ImageStat.Stat(diff).mean)/3
    print(f"{name}: snapshot without app CSS, mean pixel error {error:.2f}/255",flush=True)
    assert error<4, "Static snapshot drifted from the actual exit viewport"
    proof.close()
    saved = phone.context.storage_state()
    base = phone.url
    browser.close()
    print(name+": first browser process closed with persisted conversation snapshot",flush=True)

    browser = engine.launch(executable_path=os.getenv(name.upper()+"_PATH"))
    ctx = browser.new_context(ignore_https_errors=True,is_mobile=True,has_touch=True,
        locale="zh-CN",viewport={"width":393,"height":745})
    ctx.add_cookies(saved["cookies"])
    origin = urlsplit(base)
    entries = next(o["localStorage"] for o in saved["origins"] if o["origin"]==origin.scheme+"://"+origin.netloc)
    ctx.add_init_script("for(const e of "+json.dumps(entries)+")localStorage.setItem(e.name,e.value);")
    ctx.add_init_script(native + "window.__DSH_MOBILE_LAUNCH__="+json.dumps({"mode":"resume","resume":SID})+";"+"""
      window.__qaEvents=[];window.__frames=[];
      window.webkit={messageHandlers:{dshMobile:{postMessage:m=>__qaEvents.push(m)}}};
      function sample(){
        const view=document.querySelector('[data-conversation-content]');
        const sc=document.querySelector('[data-conversation-scroll]');
        const covered=!!document.getElementById('dml-snap-curtain');
        const savedScroll=document.querySelector('#dml-snap-curtain [data-dml-snap-scroll]');
        const savedMarker=[...document.querySelectorAll('#dml-snap-curtain span')].find(e=>e.textContent==='History question 7');
        const visible=!!view&&getComputedStyle(view).visibility==='visible'&&!covered;
        __frames.push({time:performance.now(),covered,visible,
          id:visible?view.dataset.conversationSession:null,
          phase:visible?view.dataset.contentPhase:null,
          snapshotTop:savedScroll?.scrollTop, expectedSnapshotTop:savedScroll?.getAttribute('data-dml-snap-y'),
          snapshotMarkerY:savedMarker?.getBoundingClientRect().top,
          bottom:sc?sc.scrollHeight-sc.clientHeight-sc.scrollTop:null});
        if(__frames.length<600)requestAnimationFrame(sample);
      }requestAnimationFrame(sample);
    """)
    ctx.tracing.start(screenshots=True,snapshots=True)
    page = ctx.new_page()
    page.goto(base,wait_until="commit")
    page.wait_for_function("__qaEvents.some(e=>e.type==='launch-applied')",timeout=40000)
    page.get_by_text(LATEST,exact=True).wait_for()
    page.wait_for_timeout(500)
    frames=page.evaluate("__frames")
    (out/"frames.json").write_text(json.dumps(frames,indent=2),encoding="utf-8")
    page.screenshot(path=str(out/"latest.png"))
    ctx.tracing.stop(path=str(out/"trace.zip"))
    shown=[f for f in frames if f["visible"]]
    assert any(f["covered"] for f in frames), 'Saved snapshot must paint before live content'
    snapshots=[f for f in frames if f['covered'] and f.get('expectedSnapshotTop')]
    # Sampling runs before the first restore rAF in WebKit. All subsequent
    # sampled frames must keep the saved position, not an empty top spacer.
    assert len(snapshots)>1 and all(abs(f['snapshotTop']-float(f['expectedSnapshotTop']))<=1 for f in snapshots[1:]),snapshots
    assert shown and all(f["id"]==SID for f in shown), shown[:8]
    assert all(f["phase"] not in ("hero","settling") for f in shown),shown[:8]
    assert shown[0]["bottom"]<=2,shown[:8]
    assert page.get_by_text(LATEST,exact=True).evaluate("el=>{const b=el.getBoundingClientRect();return b.bottom>0&&b.top<innerHeight}")
    print(f"{name}: {len(frames)} frame samples; first live frame is the exit session at its latest record; no temporary/other conversation PASS",flush=True)
    browser.close()
