import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {writePrivate} from './identity.mjs';
import {taskReducer,view,safeID,labels} from './task-events.mjs';
const hex=s=>typeof s==='string' && /^(?:[a-f0-9]{2}){16,256}$/.test(s);
const bad=()=>{throw Object.assign(new Error('invalid notification setting'),{status:400});};
export async function taskPush({stateDir,desktopId,devices,send,live=()=>true}) {
  const file=join(stateDir,'task-push-devices.json'); let cfg={};
  try {cfg=JSON.parse(await readFile(join(stateDir,'push-relay.json'),'utf8'));} catch {}
  const remote=Boolean(/^https:\/\//.test(cfg.url) && typeof cfg.secret==='string' && cfg.secret.length>=32);
  const channel=send || (async msg=>{if(!remote)return; const body=JSON.stringify(msg), time=String(Date.now()),nonce=randomUUID();
    const sig=createHmac('sha256',cfg.secret).update(time+'.'+nonce+'.'+body).digest('hex');
    const r=await fetch(cfg.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(9000),headers:{'content-type':'application/json','x-dsh-time':time,'x-dsh-nonce':nonce,'x-dsh-signature':sig},body}); if(!r.ok)throw new Error('delivery failed');});
  let rows=new Map(),states=new Map(),writing=Promise.resolve(),closed=false;const lanes=new Map(),cooldown=new Map();
  try{rows=new Map(JSON.parse(await readFile(file,'utf8')));}catch{}
  const save=()=>{const data=JSON.stringify([...rows]);writing=writing.catch(()=>{}).then(()=>writePrivate(file,data));return writing;};
  const off=devices.onChange(e=>{if(e.type==='removed'){rows.delete(e.id);save().catch(()=>{});}});
  const rowFor=id=>{const row=rows.get(id);return row && devices.list().some(d=>d.id===id&&d.pairedAt===row.pair)?row:null;};
  function enqueue(id,s,method,token){
    if(!remote&&!send)return;
    const key=[id,method==='bark'?'bark':s.sessionId+':'+s.turn].join('/');const queue=lanes.get(key)??[];
    const item={state:view(s),eventId:randomUUID(),kind:s.kind,title:labels[s.kind],method,token,desktopId};
    const p=queue.at(-1); if(method==='update' && p?.method==='update' && queue.length>1)queue[queue.length-1]=item;
    else {if(queue.length>=80)queue.splice(1,1);queue.push(item);} if(lanes.has(key))return;lanes.set(key,queue);
    void (async()=>{try{while(queue.length&&!closed){const m=queue[0];for(let attempt=0;attempt<3;attempt++){
      const r=rowFor(id); if(!r||!live()||(m.method==='bark'?r.bark!==m.token:!r.island||(m.method==='start'?r.start!==m.token:r.tokens[m.state.sessionId+':'+m.state.turn]!==m.token))) break;
      try{await channel(m);break;}catch{if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));else console.warn('[dsh-mobile-link] notification delivery failed (no payload logged)');}}
      queue.shift();}}finally{lanes.delete(key);}})();
  }
  function dispatch(id,r,s){const key=s.sessionId+':'+s.turn,now=Date.now(),gate=id+'/'+key;
    if(r.bark && s.notify)enqueue(id,s,'bark',r.bark);
    if(!r.island)return;const token=r.tokens[key];
    if(token){if(s.notify||now-(cooldown.get(gate)||0)>=5000){cooldown.set(gate,now);enqueue(id,s,s.terminal?'end':'update',token);}}
    else if(s.kind==='started'&&r.start && now-(r.seen||0)>10000)enqueue(id,s,'start',r.start);
  }
  return {event(sid,e){if(closed||!live())return;const s=taskReducer(states.get(sid),sid,e);if(!s)return;
    states.delete(sid);states.set(sid,s);if(states.size>512)states.delete(states.keys().next().value);
    if(cooldown.size>2048)cooldown.delete(cooldown.keys().next().value);
    for(const id of rows.keys()){const r=rowFor(id);if(r)dispatch(id,r,s);}},
    status(id){const r=rowFor(id);if(r)r.seen=Date.now();return {relay:remote||!!send,bark:!!r?.bark,island:!!r?.island,tasks:r?.island?[...states.values()].filter(s=>!s.terminal||Date.now()-s.updatedAt<300000).map(view):[]};},
    async configure(id,body){const pair=devices.list().find(d=>d.id===id)?.pairedAt;if(!pair)bad();const r=rowFor(id)??{pair,tokens:{},island:false};
      switch(body?.op){case 'bark': if(body.key!==''&&!(typeof body.key==='string'&&/^[\w-]{8,128}$/.test(body.key)))bad();if(body.key&&!remote&&!send)throw Object.assign(new Error('relay not configured'),{status:503});r.bark=body.key;break;
      case 'island':if(typeof body.enabled!=='boolean')bad();r.island=body.enabled;if(!r.island){r.tokens={};delete r.start;} break;
      case 'startToken':if(!r.island||!hex(body.token))bad();r.start=body.token;break;
      case 'activity':{if(!r.island||!hex(body.token)||!safeID(body.sessionId)||!Number.isSafeInteger(body.turn))bad();const k=body.sessionId+':'+body.turn;if(!r.tokens[k]&&Object.keys(r.tokens).length>=48)delete r.tokens[Object.keys(r.tokens)[0]];r.tokens[k]=body.token;const s=states.get(body.sessionId);if(s?.turn===body.turn)enqueue(id,s,s.terminal?'end':'update',body.token);break;}
      default:bad();}
      rows.set(id,r);await save();}, async close(){closed=true;off?.();await writing.catch(()=>{});}};
}
