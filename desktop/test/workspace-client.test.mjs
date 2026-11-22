import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8');
test('restore the last phone selection even when a different session is running', async () => {
  let plugin, selected='temporary'; const frames=[], opened=[], visible=[];
  const store=read=>({getSnapshot:read,subscribe:()=>()=>{}});
  const env={window:{__ModuleLoader__:{load:m=>{plugin=m.factory(()=>({}));}}},
    __DSH_MOBILE_SHELL__:{active:true}, __DSH_MOBILE_LAUNCH__:{mode:'resume',resume:'history'},
    requestAnimationFrame:fn=>frames.push(fn), setInterval:()=>1,
    document:{documentElement:{lang:'en',removeAttribute:()=>visible.push(selected)},addEventListener(){},
      querySelectorAll:()=>[{dataset:{conversationSession:selected},getClientRects:()=>[{}],querySelector:()=>({})}]}};
  const ids=['other','temporary','history'];
  const rows=()=>Object.fromEntries(ids.map(id=>[id,{id,running:id==='other',blank:id==='temporary',retainedBy:{mainView:+(selected===id)}}]));
  vm.runInNewContext(client,env);
  plugin.apply({slots:{inject(){},subscribe:()=>()=>{},entries:()=>[]},inject(deps,fn){if(deps.includes('uiWorkspace'))fn(this)},effect:fn=>fn(),
    sessions:{list:store(()=>({phase:'ready',ids,byId:rows()})),binding:()=>null},workspaces:{list:store(()=>({phase:'ready',items:[]}))},
    uiWorkspace:{openSession(id){opened.push(id);selected=id},startSession(){assert.fail('spurious new conversation')}},connection:{state:store(()=>'connected')}});
  for(let i=0;i<4;i++){while(frames.length)frames.shift()();await new Promise(r=>setImmediate(r));}
  assert.deepEqual(opened,['history']);assert.deepEqual(visible,['history']);
});

test('first launch without a saved selection opens a running task directly', async () => {
  let plugin, selected='blank-temp'; const frames=[], opened=[], visible=[], posted=[];
  const store=read=>({getSnapshot:read,subscribe:()=>()=>{}});
  const env={window:{__ModuleLoader__:{load:m=>{plugin=m.factory(()=>({}));}}},
    __DSH_MOBILE_SHELL__:{active:true}, __DSH_MOBILE_LAUNCH__:{mode:'new'},
    webkit:{messageHandlers:{dshMobile:{postMessage:m=>posted.push(m)}}},
    requestAnimationFrame:fn=>frames.push(fn), setInterval:()=>1,
    document:{documentElement:{lang:'zh-CN',style:{backgroundColor:'#151517'},removeAttribute:()=>visible.push(selected)},addEventListener(){},
      querySelectorAll:()=>[{dataset:{conversationSession:selected,contentPhase:selected==='running-task'?'active':'hero'},getClientRects:()=>[{}],querySelector:()=>({})}]}};
  const ids=['blank-temp','done-history','running-task'];
  const rows=()=>Object.fromEntries(ids.map(id=>[id,{id,running:id==='running-task',blank:id==='blank-temp',retainedBy:{mainView:+(selected===id)}}]));
  vm.runInNewContext(client,env);
  plugin.apply({slots:{inject(){},subscribe:()=>()=>{},entries:()=>[]},inject(deps,fn){if(deps.includes('uiWorkspace'))fn(this)},effect:fn=>fn(),
    sessions:{list:store(()=>({phase:'ready',ids,byId:rows()})),binding:()=>null},workspaces:{list:store(()=>({phase:'ready',items:[{workspaceId:'w1',sessionIds:ids}]}))},
    uiWorkspace:{openSession(id){opened.push(id);selected=id},openWorkspace(){assert.fail('must not open new workspace while a task is running')},startSession(){assert.fail('must not start blank session while a task is running')}},
    connection:{state:store(()=>'connected')}});
  for(let i=0;i<6;i++){while(frames.length)frames.shift()();await new Promise(r=>setImmediate(r));}
  assert.deepEqual(opened,['running-task']);
  assert.deepEqual(visible,['running-task']);
  assert.equal(posted.some(m=>m.type==='launch-applied' && m.sessionId==='running-task' && m.isBlank===false),true);
});

test('non-blank session waits for the host snapshot and stays covered through slow settling and hero phases', async () => {
  let plugin, selected='history', phase='settling', now=1000; const frames=[], visible=[], posted=[], subs=[];
  let readySnapshot;
  const ready = new Promise(resolve=>readySnapshot=resolve);
  const store=read=>({getSnapshot:read,subscribe:fn=>{subs.push(fn);return()=>{}}});
  const env={window:{__ModuleLoader__:{load:m=>{plugin=m.factory(()=>({}));}}},
    __DSH_MOBILE_SHELL__:{active:true}, __DSH_MOBILE_LAUNCH__:{mode:'resume',resume:'history'},
    Date: {now:()=>now}, clearTimeout(){},
    webkit:{messageHandlers:{dshMobile:{postMessage:m=>posted.push(m)}}},
    requestAnimationFrame:fn=>frames.push(fn), setInterval:()=>1,
    document:{documentElement:{lang:'zh-CN',style:{backgroundColor:'#151517'},removeAttribute:()=>visible.push(`${selected}:${phase}`)},addEventListener(){},
      querySelectorAll:()=>[{dataset:{conversationSession:selected,contentPhase:phase},getClientRects:()=>[{}],querySelector:()=>({})}]}};
  const ids=['history'];
  const rows=()=>({history:{id:'history',running:false,blank:false,retainedBy:{mainView:1}}});
  vm.runInNewContext(client,env);
  plugin.apply({slots:{inject(){},subscribe:()=>()=>{},entries:()=>[]},inject(deps,fn){if(deps.includes('uiWorkspace'))fn(this)},effect:fn=>fn(),
    sessions:{list:store(()=>({phase:'ready',ids,byId:rows()})),binding:()=>({}),retain:()=>({ready,release(){}})},workspaces:{list:store(()=>({phase:'ready',items:[]}))},
    uiWorkspace:{openSession(id){selected=id},startSession(){}},connection:{state:store(()=>'connected')}});
  while(frames.length)frames.shift()();
  assert.deepEqual(visible,[]); // settling -> stay hidden behind snapshot
  phase='active';subs.forEach(f=>f());
  while(frames.length)frames.shift()();
  assert.deepEqual(visible,[], 'cached active DOM is not proof of a current host snapshot');
  readySnapshot();await Promise.resolve();
  phase='hero'; subs.forEach(f=>f());
  while(frames.length)frames.shift()();
  assert.deepEqual(visible,[]); // hero flash on non-blank history -> stay hidden behind snapshot
  assert.equal(posted.filter(m=>m.type==='launch-applied').length,0);
  now += 30000; subs.forEach(f=>f());
  while(frames.length)frames.shift()();
  assert.deepEqual(visible,[], '30 seconds must not turn a hero placeholder into a restored conversation');
  phase='settling'; subs.forEach(f=>f());
  while(frames.length)frames.shift()();
  assert.deepEqual(visible,[], 'slow hydration stays covered');
  phase='active'; subs.forEach(f=>f());
  for(let i=0;i<4;i++){while(frames.length)frames.shift()();}
  assert.deepEqual(visible,['history:active']);
  assert.equal(posted.some(m=>m.type==='launch-applied' && m.sessionId==='history'),true);
});
test('saved blank session survives cold launch, disconnection and foreground while another task runs', async () => {
  let plugin, selected='temporary', connection='connected';
  const frames=[], opened=[], events=new Map(), subs=[];
  const store=read=>({getSnapshot:read,subscribe:fn=>{subs.push(fn);return()=>{}}});
  const ids=['temporary','blank-saved','running'];
  const rows=()=>Object.fromEntries(ids.map(id=>[id,{id,blank:id!=='running',running:id==='running',retainedBy:{mainView:+(selected===id)}}]));
  const env={window:{__ModuleLoader__:{load:m=>{plugin=m.factory(()=>({}));}}},
    __DSH_MOBILE_SHELL__:{active:true}, __DSH_MOBILE_LAUNCH__:{mode:'resume',resume:'blank-saved'},
    requestAnimationFrame:fn=>frames.push(fn),setInterval:()=>1,clearInterval(){},
    document:{hidden:false,documentElement:{lang:'en',removeAttribute(){}},addEventListener:(name,fn)=>events.set(name,fn),
      querySelectorAll:()=>[{dataset:{conversationSession:selected,contentPhase:'hero'},getClientRects:()=>[{}],querySelector:()=>({})}]}};
  vm.runInNewContext(client,env);
  plugin.apply({slots:{inject(){},subscribe:()=>()=>{},entries:()=>[]},inject(deps,fn){if(deps.includes('uiWorkspace'))fn(this)},effect:fn=>fn(),
    sessions:{list:store(()=>({phase:'ready',ids,byId:rows()})),binding:()=>null},workspaces:{list:store(()=>({phase:'ready',items:[]}))},
    uiWorkspace:{openSession(id){opened.push(id);selected=id},startSession(){assert.fail('must retain saved blank ID')}},
    connection:{state:store(()=>connection)}});
  const drain=async()=>{for(let i=0;i<4;i++){while(frames.length)frames.shift()();await new Promise(r=>setImmediate(r));}};
  await drain();
  assert.deepEqual(opened,['blank-saved']);
  connection='disconnected';subs.forEach(f=>f());await drain();
  env.document.hidden=true;events.get('visibilitychange')();
  connection='connected';subs.forEach(f=>f());
  env.document.hidden=false;events.get('visibilitychange')();await drain();
  assert.equal(selected,'blank-saved');assert.deepEqual(opened,['blank-saved']);
});
// Exercise the shipped browser module (not a separately compiled copy of its logic).
function phone(readBytes) {
  const Official = () => {}, entry = {component: Official, children: {'sidebar.workspaces.session.row.action': {}}};
  const slots = new Map(), cleanup = [], notices = [], downloads = [];
  let blob, changed, plugin;
  const React = { createElement: (type, props) => ({type, props}), useMemo: f => f(), useState: () => [false, () => {}],
    useEffect: f => f(), useRef: current => ({current}) };
  const env = { window: {__ModuleLoader__: {load: m => { plugin = m.factory(() => React); }}},
    __DSH_MOBILE_SHELL__: {active: true}, __DSH_MOBILE_BRIDGE__: {showToast: m => notices.push(m)},
    Uint8Array, Blob, AbortController, setTimeout() {}, URL: {createObjectURL: b => {blob=b;return 'blob:test';}},
    document: {documentElement: {lang:'en'}, body: {append() {}}, createElement: () => ({click() {downloads.push({name:this.download, blob});}, remove() {}})} };
  vm.runInNewContext(client, env);
  plugin.apply({inject(deps, fn) {if(deps.includes('remote.workspaceFiles'))fn(this);}, effect: f => cleanup.push(f()), remote: {workspaceFiles: {readBytes}},
    slots: { subscribe: (_, cb) => {changed = cb;return () => {};}, entries: () => [entry],
      inject: (_, cb) => cb(), register: (options, component) => slots.set(options.name, component) }});
  return {entry, Official, changed, slots, notices, downloads, dispose: () => cleanup.reverse().forEach(f => f?.())};
}

test('workspace tree shares real blank IDs without rewriting the host or changing selection', () => {
  const ui=phone(); const local={blank:true, retainedBy:{mainView:1}}, child={blank:true,origin:'subagent'}, remote={id:'phone',blank:true,retainedBy:{}}, done={blank:false,title:'First prompt'};
  const list=Object.freeze({ids:['phone','local','child','done'],byId:Object.freeze({phone:Object.freeze(remote),local,child,done})});
  let snapshot=list;
  const view=ui.entry.component({useSessions: select => select(snapshot),t:()=>'New session',open:'official navigation'});
  assert.equal(view.type,ui.Official); assert.equal(view.props.open,'official navigation');
  const select=s=>s, projected=view.props.useSessions(select);
  assert.equal(projected.ids,list.ids); assert.equal(projected.byId.phone.id,'phone'); assert.equal(projected.byId.phone.blank,false); assert.equal(projected.byId.phone.title,'New session');
  for(const key of ['local','child','done']) assert.equal(projected.byId[key],list.byId[key]);
  assert.equal(list.byId.phone.blank,true); assert.equal(view.props.useSessions(select),projected);
  snapshot={...list,byId:{...list.byId,phone:done}}; assert.equal(view.props.useSessions(select),snapshot);
  const manage=ui.slots.get('sidebar.footer.action');
  assert.equal(manage({wide:false}),false);
  assert.equal(typeof manage({wide:true}).props.onClick,'function');
  ui.changed();ui.dispose();assert.equal(ui.entry.component,ui.Official);
});

test('both download surfaces unwrap Harness results, preserve original bytes and filename', async () => {
  for(const surface of ['actions','unpreviewable']) {
    const data=Uint8Array.of(0,255,1,2), ui=phone(async (sid, path, {range:{offset}}) => {
      assert.equal(sid,'session-a');assert.equal(path,'C:\\demo\\测 试.docx');
      return {ok:true,value:{version:'v',offset,bytes:4,eof:offset===2,data:data.slice(offset,offset+2)}};
    });
    const btn=ui.slots.get('sidebar.right.tab.document.'+surface)({absolutePath:'C:\\demo\\测 试.docx',sessionId:'session-a'});
    await btn.props.onClick();assert.deepEqual(ui.notices,[]);assert.equal(ui.downloads[0].name,'测 试.docx');
    assert.deepEqual(new Uint8Array(await ui.downloads[0].blob.arrayBuffer()),data);ui.dispose();
  }
});

test('a denied read or changing file never produces a partial download', async () => {
  for(const fail of [true,false]) {
    const ui=phone(async (_id,_path,{range:{offset}}) => fail?{ok:false,error:{message:'Permission denied'}}:
      {ok:true,value:{offset,data:Uint8Array.of(1),version:String(offset),eof:offset===1}});
    await ui.slots.get('sidebar.right.tab.document.actions')({absolutePath:'/x.pdf',sessionId:'a'}).props.onClick();
    assert.equal(ui.downloads.length,0);assert.equal(ui.notices.length,1);assert.match(ui.notices[0],/Permission denied|File changed/);ui.dispose();
  }
});
