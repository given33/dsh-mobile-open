"""Use only the disposable official Harness fixture. Argument: directory with host.json.
Set CHROMIUM_PATH for a local Chromium installation. Does not touch the daily profile."""

from pathlib import Path
import json, sys, time, os, urllib.parse as u
from playwright.sync_api import sync_playwright

h = json.loads((Path(sys.argv[1]) / "host.json").read_text())
assert (
    u.urlsplit(h["base"]).hostname == "127.0.0.1"
    and Path(h["workspace"]).resolve() == Path(h["home"]).resolve() / "test-workspace"
)
base = "https://127.0.0.1:" + str(h["port"])
desktop = h["base"].rstrip("/")
pw = sync_playwright().start()
b = (
    pw.webkit.launch(executable_path=os.getenv("WEBKIT_PATH"))
    if os.getenv("WEBKIT_PATH")
    else pw.chromium.launch(
        executable_path=os.getenv("CHROMIUM_PATH"), args=["--no-proxy-server"]
    )
)
mc = b.new_context(
    ignore_https_errors=True,
    locale="zh-CN",
    viewport={"width": 393, "height": 745},
    is_mobile=True,
    has_touch=True,
)
dc = b.new_context(locale="zh-CN", viewport={"width": 1280, "height": 850})
api = mc.request
name, val = h["cookie"].split("=", 1)
dc.add_cookies([{"name": name, "value": val, "url": desktop}])
code = u.parse_qs(
    u.urlsplit(
        api.post(
            desktop + "/dsh-mobile-link/code", headers={"Cookie": h["cookie"]}, data={}
        ).json()["pairing"]["link"]
    ).query
)["c"][0]
tok = api.post(
    base + "/mobile/v1/pair",
    data={"code": code, "device": {"id": "phone-workspace-probe", "name": "test"}},
).json()["token"]
assert api.post(
    base + "/mobile/v1/web-session", headers={"Authorization": "Bearer " + tok}, data={}
).ok
import re

source = (
    Path(__file__).resolve().parents[3] / "DSHMobile/App/OfficialWebView.swift"
).read_text(encoding="utf8")
native = re.search(r'private static let nativeNavigation = """(.*?)"""', source, re.S)[
    1
]
mc.add_init_script(
    ("" if os.getenv("LEGACY_PHONE") else native)
    + """
window.__qaEvents=[];window.__DSH_MOBILE_LAUNCH__={mode:'new'};window.webkit={messageHandlers:{dshMobile:{postMessage:m=>__qaEvents.push(m)}}};
window.__firstVisibleSession=new Promise(done=>{function sample(){const view=document.querySelector('[data-conversation-content]');if(view && getComputedStyle(view).visibility==='visible' && view.getClientRects().length)done(view.dataset.conversationSession || null);else requestAnimationFrame(sample)}requestAnimationFrame(sample)});
window.__qaInstance=crypto.randomUUID();window.__qaSockets=[];const Ws=window.WebSocket;window.WebSocket=class extends Ws { constructor(...args){super(...args);if(String(args[0]).includes('remote.mux'))__qaSockets.push(this)} };
"""
)
m = mc.new_page()
d = dc.new_page()
for page, url in [(m, base), (d, desktop)]:
    print("loading page", flush=True)
    page.on("pageerror", lambda e: print("js", str(e)[:150], flush=True))
    page.goto(url, wait_until="commit")
    page.locator("[data-composer-card]").first.wait_for(timeout=40000)


def rpc(page, method, args):
    r = page.evaluate(
        """async ([method,args])=>{const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'probe',method,payload:{args}})});return (await r.json()).result}""",
        [method, args],
    )
    assert r["ok"], r
    return r["value"]


for page in [m, d]:
    dismiss = page.get_by_role("dialog").get_by_role("button", name="继续", exact=True)
    if dismiss.count():
        try:
            dismiss.first.click(timeout=5000)
        except Exception:
            if dismiss.count():
                raise


m.wait_for_function("__qaEvents.some(e=>e.type==='launch-applied')", timeout=25000)
# Both slots must really exist; absent or all-hidden buttons do not count.
left = m.locator("[data-sidebar-opener]")
assert left.count() == 1 and not left.is_visible()
print("inner opener present and hidden", flush=True)
drawer = m.locator("[data-sidebar-drawer]")
st = drawer.get_attribute("data-sidebar-collapsed")
m.evaluate("__DSH_MOBILE_BRIDGE__.toggleSidebar()")
m.wait_for_function(
    's=>document.querySelector("[data-sidebar-drawer]").getAttribute("data-sidebar-collapsed")!==s',
    arg=st,
)
m.evaluate("__DSH_MOBILE_BRIDGE__.toggleSidebar()")
m.wait_for_function(
    's=>document.querySelector("[data-sidebar-drawer]").getAttribute("data-sidebar-collapsed")===s',
    arg=st,
)
print(
    "native action opens and closes actual drawer; right files button visible",
    flush=True,
)
# Create one real workspace chat before simulating the reported interruption.
import tempfile

target = tempfile.mkdtemp(dir=h["workspace"])
wid = rpc(m, "workspace/create", {"request": {"path": target}})["workspace"][
    "workspaceId"
]
grp = m.locator('[data-row-key="workspace:' + wid + '"] button[aria-keyshortcuts]')
grp.first.wait_for(state="attached")
with m.expect_response(lambda r: r.url.endswith("/api/session/create")) as creating:
    grp.first.evaluate("b=>b.click()")
sid = creating.value.json()["result"]["value"]["sessionId"]
m.wait_for_function("id=>__DSH_MOBILE_CORDIS__.getCurrentSessionId()===id", arg=sid)
box = m.locator("[data-composer-card] [contenteditable=true]").first
m.locator("[data-sidebar-right-expand], [data-sidebar-right-toggle]").first.wait_for(
    state="attached", timeout=12000
)
assert any(
    x.is_visible()
    for x in m.locator("[data-sidebar-right-expand], [data-sidebar-right-toggle]").all()
)
box.fill("恢复验证 · 未发送")
instance = m.evaluate("__qaInstance")
created = []
m.on(
    "request",
    lambda r: (
        created.append(
            r.post_data_json.get("payload", {})
            .get("args", {})
            .get("request", {})
            .get("sessionId")
        )
        if r.url.endswith("/api/session/create")
        else None
    ),
)
n = m.evaluate("__qaSockets.length")
assert n > 0
# Native obtains another HttpOnly cookie while the mux is healthy, then notify in place.
assert api.post(
    base + "/mobile/v1/web-session", headers={"Authorization": "Bearer " + tok}, data={}
).ok
m.evaluate(
    "__DSH_MOBILE_BRIDGE__.credentialsChanged(); __DSH_MOBILE_BRIDGE__.reconnect()"
)
m.wait_for_timeout(500)
assert m.evaluate("__qaSockets.length") == n
# Close the actual mux (not a DOM mock). Harness must reattach, no navigation or extra chat.
m.evaluate("__qaSockets.at(-1).close()")
m.wait_for_function(
    'n=>__qaSockets.length>n && __DSH_MOBILE_BRIDGE__.snapshot().wsState==="connected"',
    arg=n,
    timeout=20000,
)
m.wait_for_timeout(1500)
assert m.evaluate("__qaInstance") == instance
assert m.evaluate("__DSH_MOBILE_CORDIS__.getCurrentSessionId()") == sid
assert box.inner_text() == "恢复验证 · 未发送"
assert created == [], created
print(
    "healthy credential rotation: no new socket; real mux reconnected: same document, session and unsent text, zero session/create",
    flush=True,
)
# An older signed phone bootstraps another document with mode=new. It should route
# straight to the saved ID. Harness may restore an existing blank by calling\n# session/create with its exact ID; this must not allocate another chat.
m.reload(wait_until="commit")
m.wait_for_function(
    'id=>__qaEvents.some(e=>e.type==="launch-applied"&&e.sessionId===id)',
    arg=sid,
    timeout=30000,
)
assert all(target == sid for target in created), created
assert m.evaluate('__firstVisibleSession') == sid, 'a temporary session flashed before the saved one'
print(
    "legacy cold document restores same ID; no extra session (Harness may rebind a blank by its existing ID)",
    flush=True,
)
if os.getenv("CHECK_TASK_HUB"):
    # Render synthetic rows in the real Cordis slot; never create tasks just to test pagination.
    m.evaluate("""()=>{
      const cordis=__DSH_MOBILE_CORDIS__;
      const history=Array.from({length:65},(_,i)=>({id:'test-'+i,title:'Sample '+i,workspaceName:'Test space'}));
      cordis.listSessions=()=>[
        {id:'approval',title:'Approval fixture',workspaceName:'Test space',pendingInteraction:true},
        {id:'run',title:'Running fixture',workspaceName:'Test space',running:true},
        ...history,
      ];
      __DSH_MOBILE_BRIDGE__.openHub('tasks');
    }""")
    hub = m.get_by_role("dialog", name="移动端工具箱")
    hub.wait_for()
    groups = hub.locator(".dml-hub-task-group")
    assert groups.count() == 3
    assert groups.nth(0).get_by_text("Approval fixture").is_visible()
    assert groups.nth(1).get_by_text("Running fixture").is_visible()
    history = groups.nth(2)
    assert history.locator(".dml-hub-item").count() == 24
    history.get_by_role("button", name="显示更多历史会话（41）").click()
    assert history.locator(".dml-hub-item").count() == 48
    hub.get_by_role("searchbox", name="搜索会话标题或工作区").fill("space SAMPLE 64")
    assert hub.get_by_role("button", name="Sample 64 Test space").is_visible()
    assert groups.count() == 1
    hub.get_by_role("searchbox").fill("")
    for width in (320, 393, 820):
        m.set_viewport_size({"width": width, "height": 745})
        assert hub.evaluate("e=>e.scrollWidth<=e.clientWidth+1"), width
    if os.getenv("TASK_HUB_SCREENSHOT"):
        m.set_viewport_size({"width": 393, "height": 745})
        hub.locator(".dml-hub-sheet").screenshot(path=os.environ["TASK_HUB_SCREENSHOT"], animations="disabled")
    m.keyboard.press("Escape")
    hub.wait_for(state="hidden")
    print("Task Hub on real Harness: groups, 24-row pagination, search beyond the first page and widths 320/393/820 PASS", flush=True)
b.close()
pw.stop()
