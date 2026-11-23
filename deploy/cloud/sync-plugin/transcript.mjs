import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const maxBytes = 8 * 1024 * 1024;
const text = blocks => Array.isArray(blocks) ? blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';

// Export only the user-visible transcript. In particular, a tool call, approval or
// automation must never turn into an executable instruction on the other host.
export function transcript(origin, header, events) {
  let title = '', turn;
  const turns = [];
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'session/title' && typeof d.title === 'string') title = d.title;
    if (e.type === 'turn/start') turn = {start:e.time, prompt:[], replies:[]};
    if (!turn) continue;
    if (e.type === 'user/message') turn.prompt.push(text(d.content));
    if (e.type === 'assistant/message') { const answer = text(d.message?.content); if (answer) turn.replies.push(answer); }
    if (e.type === 'turn/end') {
      turns.push({start:turn.start, end:e.time, prompt:turn.prompt.join('\n'), answer:turn.replies.join('\n\n'), outcome:String(d.reason?.kind ?? 'unknown')});
      turn = undefined;
    }
  }
  if (!turns.length) return null;
  return {v:1, origin, source:header.id, created:header.createdAt, title:(title || turns[0].prompt || '共享任务').slice(0,160), turns};
}

export function validate(p, origin) {
  if (p?.v !== 1 || p.origin !== origin || typeof p.source !== 'string' || !/^[\w.-]{1,160}$/.test(p.source) || !Number.isSafeInteger(p.created) || typeof p.title !== 'string' || p.title.length > 160 || !Array.isArray(p.turns) || !p.turns.length || p.turns.length > 20000) throw Error('Invalid shared session');
  for (const t of p.turns) {
    if (!t || !Number.isSafeInteger(t.start) || !Number.isSafeInteger(t.end) || typeof t.prompt !== 'string' || typeof t.answer !== 'string' || typeof t.outcome !== 'string' || t.outcome.length>64) throw Error('Invalid shared turn');
  }
}
export const fileKey = p => digest(p.origin + ':' + p.source);
export function importedEvents(p, id) {
  const events=[];
  const add=(type,data,time,surface=false)=>events.push({seq:events.length,time,type,data,...(surface?{surfaceOp:'append'}:{})});
  for (const [i,t] of p.turns.entries()) {
    const turn=i+1, step=1, start=t.start, end=t.end;
    add('turn/start',{turn},start); add('step/start',{turn,step},start);
    if (!i) add('system/message',{turn,step,message:{id:id+'-system',role:'system',source:{kind:'system-prompt'},content:[]}},start,true);
    add('user/message',{id:id+'-u'+turn,role:'user',source:{kind:'user'},content:[{type:'text',text:t.prompt || '（非文本任务）'}]},start,true);
    if (!i) add('session/title',{title:p.title,messageSeqs:[],source:{kind:'user'}},start);
    // Put the source outcome in the transcript; the local copy itself is always settled.
    const answer=(t.answer || '（无文本回复）')+(t.outcome==='completed'?'':'\n\n原任务状态：'+t.outcome);
    add('assistant/message',{turn,step,stream:[],message:{id:id+'-a'+turn,role:'assistant',source:{kind:'model',provider:'dsh-sync',model:'transcript'},content:[{type:'text',text:answer}]}},end,true);
    add('step/end',{turn,step},end); add('turn/end',{turn,reason:{kind:'completed'}},end);
  }
  return events;
}
