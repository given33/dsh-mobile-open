// Maps only public lifecycle metadata. Never send prompts, tool arguments, answers,
// raw errors, filenames, workspace paths or credentials to a lock screen.
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
