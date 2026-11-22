// Live Activities use lifecycle metadata only. Bark can additionally show a bounded
// terminal report; never serialize the transcript, reasoning, tools or raw errors.
export function noticeText(input, limit) {
  if (typeof input !== 'string') return '';
  const text = input.slice(0, 4096).replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!?(?:\[([^\]]*)\])\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|secret|密码|密钥)\s*[:=：]\s*)[^\s,;，。]+/gi, '[已隐藏]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/(?:\*\*|__|`|^#{1,6} +)/gm, '').replace(/[\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text;
}

export function finalReplyExcerpt(data) {
  const blocks = data?.message?.content;
  if (data?.interrupted || !Array.isArray(blocks) || blocks.some(b => b?.type === 'tool-call')) return '';
  return noticeText(blocks.filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text.slice(0, 4096)).join(' '), 120);
}
export const labels = Object.freeze({
  started: '任务开始',
  plan: '计划模式已更新',
  todos: '待办进度已更新',
  step: '正在执行步骤',
  tool: '正在调用工具',
  result: '工具执行完毕',
  toolError: '工具执行失败',
  question: '等待你回答',
  answered: '提问已处理',
  approval: '等待你审批',
  approved: '审批通过',
  denied: '审批未通过',
  retry: '模型请求重试',
  compact: '正在整理上下文',
  resumed: '继续执行',
  completed: '任务已完成',
  aborted: '任务已取消',
  blocked: '任务受阻',
  error: '任务失败',
  interrupted: '任务中断',
  'max-tokens': '达到输出上限',
  ended: '任务已结束',
});
const endings = new Set(['completed', 'aborted', 'blocked', 'error', 'interrupted', 'max-tokens']);
export const safeID = (s) => typeof s === 'string' && /^[\w-]{1,128}$/.test(s);
export function taskReducer(previous, sid, event, now = Date.now()) {
  if (!safeID(sid) || !event?.data) return;
  const d = event.data,
    type = event.type,
    turn = d.turn ?? previous?.turn;
  if (
    !Number.isSafeInteger(turn) ||
    turn < 0 ||
    (previous &&
      (turn < previous.turn ||
        (turn === previous.turn &&
          (previous.terminal || (Number.isSafeInteger(event.seq) && event.seq <= previous.seq)))))
  )
    return;
  const old = previous?.turn === turn ? previous : undefined;
  if (!old && !['turn/start', 'turn/end', 'step/start', 'tool/call'].includes(type)) return;
  const waits = new Map(old?.waits);
  let kind,
    detail = '',
    terminal = false,
    notify = true;
  let todo = old?.todo ?? '',
    tools = old?.tools ?? 0;
  switch (type) {
    case 'turn/start':
      if (old) return;
      kind = 'started';
      break;
    case 'step/start':
      kind = 'step';
      notify = false;
      break;
    case 'todo/write': {
      if (!Array.isArray(d.todos)) return;
      const done = d.todos.filter((t) => t?.status === 'completed').length;
      todo = `待办 ${done}/${d.todos.length}`;
      kind = 'todos';
      notify = false;
      break;
    }
    case 'plan/mode':
      kind = 'plan';
      detail = d.active ? '进入计划模式' : '退出计划模式';
      notify = false;
      break;
    case 'tool/call':
      tools++;
      if (d.name === 'ask_user_question') {
        kind = 'question';
        waits.set('q:' + d.callId, kind);
      } else {
        kind = 'tool';
        notify = false;
        detail = /^(?:read|list|search|grep)/i.test(d.name)
          ? '读取或查找资料'
          : /^(?:write|edit|patch)/i.test(d.name)
            ? '编辑内容'
            : /^(?:bash|exec|shell|run)/i.test(d.name)
              ? '运行命令'
              : '使用工具';
      }
      break;
    case 'tool/result': {
      const asked = waits.delete('q:' + d.message?.toolCallId);
      kind = d.message?.isError ? 'toolError' : asked ? 'answered' : 'result';
      notify = asked || kind === 'toolError';
      break;
    }
    case 'approval/asked':
      kind = 'approval';
      waits.set('a:' + d.id, kind);
      break;
    case 'approval/decided':
      waits.delete('a:' + d.id);
      kind = d.outcome === 'allowed-once' ? 'approved' : 'denied';
      break;
    case 'llm/retry':
      kind = 'retry';
      if (Number.isSafeInteger(d.retry)) detail = `第 ${d.retry} 次重试`;
      break;
    case 'compaction/start':
      kind = 'compact';
      notify = false;
      break;
    case 'compaction/end':
      kind = 'resumed';
      notify = false;
      break;
    case 'turn/end':
      if (d.reason?.kind === 'forked') return;
      if (d.reason?.kind === 'aborted')
        detail =
          { user: '用户停止', parent: '父任务取消', hook: '工作流停止', disposed: '会话已关闭' }[
            d.reason.reason?.kind
          ] ?? '';
      kind = endings.has(d.reason?.kind) ? d.reason.kind : 'ended';
      terminal = true;
      waits.clear();
      break;
    default:
      return;
  }
  const step = Number.isSafeInteger(d.step) ? Math.max(0, d.step) : (old?.step ?? 0);
  const phase = waits.size ? ([...waits.values()].includes('approval') ? 'approval' : 'question') : kind;
  return {
    sessionId: sid,
    turn,
    step,
    todo,
    tools,
    kind,
    phase,
    detail: phase === kind ? detail : '',
    terminal,
    notify,
    seq: Number.isSafeInteger(event.seq) ? event.seq : (old?.seq ?? -1) + 1,
    updatedAt: now,
    waits,
  };
}
export function view(s) {
  return {
    sessionId: s.sessionId,
    turn: s.turn,
    step: s.step,
    phase: s.phase,
    label: labels[s.phase],
    detail: [s.detail, s.todo, s.tools ? '工具 ' + s.tools + ' 次' : ''].filter(Boolean).join(' · '),
    terminal: s.terminal,
    updatedAt: s.updatedAt,
  };
}
