import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { writePrivate } from './identity.mjs';
import { openOutbox } from './task-outbox.mjs';
import { taskReducer, view, safeID, labels, finalReplyExcerpt, noticeText } from './task-events.mjs';
const hex = (s) => typeof s === 'string' && /^(?:[a-f0-9]{2}){16,256}$/.test(s);
const bad = () => {
  throw Object.assign(new Error('invalid notification setting'), { status: 400 });
};
export async function taskPush({ stateDir, desktopId, devices, send, live = () => true }) {
  const file = join(stateDir, 'task-push-devices.json');
  let cfg = {};
  try {
    cfg = JSON.parse(await readFile(join(stateDir, 'push-relay.json'), 'utf8'));
  } catch {}
  const remote = Boolean(
    /^https:\/\//.test(cfg.url) && typeof cfg.secret === 'string' && cfg.secret.length >= 32,
  );
  const channel =
    send ||
    (async (msg) => {
      if (!remote) return;
      const body = JSON.stringify(msg),
        time = String(Date.now()),
        nonce = randomUUID();
      const sig = createHmac('sha256', cfg.secret)
        .update(time + '.' + nonce + '.' + body)
        .digest('hex');
      const r = await fetch(cfg.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(9000),
        headers: {
          'content-type': 'application/json',
          'x-dsh-time': time,
          'x-dsh-nonce': nonce,
          'x-dsh-signature': sig,
        },
        body,
      });
      if (!r.ok) throw new Error('delivery failed');
    });
  let rows = new Map(),
    states = new Map(),
    writing = Promise.resolve(),
    closed = false;
  const lanes = new Map(),
    cooldown = new Map(),
    recent = new Map(),
    trailing = new Map(),
    remoteStarts = new Map();
  try {
    rows = new Map(JSON.parse(await readFile(file, 'utf8')));
  } catch {}
  const save = () => {
    const data = JSON.stringify([...rows]);
    writing = writing.catch(() => {}).then(() => writePrivate(file, data));
    return writing;
  };
  const outbox = await openOutbox(join(stateDir, 'task-push-outbox.json')),
    inFlight = new Set();
  const off = devices.onChange((e) => {
    if (e.type === 'removed') {
      rows.delete(e.id);
      outbox.forget(e.id).catch(() => {});
      save().catch(() => {});
    }
  });
  const rowFor = (id) => {
    const row = rows.get(id);
    return row && devices.list().some((d) => d.id === id && d.pairedAt === row.pair) ? row : null;
  };
  function enqueue(id, s, method, token) {
    if (!remote && !send) return;
    const item = {
      state: view(s),
      eventId: randomUUID(),
      kind: s.kind,
      title: labels[s.kind],
      method,
      ...(method === 'bark' && s.report ? { report: s.report } : {}),
      token,
      desktopId,
    };
    if ((method === 'bark' || method === 'end') && rowFor(id)) {
      void outbox.add(id, rowFor(id).pair, item).then(
        () => submit(id, item),
        () => submit(id, item),
      );
    } else submit(id, item);
  }
  function submit(id, item) {
    if (closed || inFlight.has(item.eventId)) return;
    const { method, state: s } = item,
      key = [id, method === 'bark' ? 'bark' : s.sessionId + ':' + s.turn].join('/'),
      queue = lanes.get(key) ?? [];
    const p = queue.at(-1);
    if (method === 'update' && p?.method === 'update' && queue.length > 1) queue[queue.length - 1] = item;
    else {
      if (queue.length >= 80) {
        if (method === 'update') return;
        const evicted = queue.splice(1, 1)[0];
        inFlight.delete(evicted.eventId);
      }
      queue.push(item);
    }
    if (method !== 'update') inFlight.add(item.eventId);
    if (lanes.has(key)) return;
    lanes.set(key, queue);
    void (async () => {
      try {
        while (queue.length && !closed) {
          const m = queue[0];
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = rowFor(id);
            if (
              !r ||
              !live() ||
              (m.method === 'bark'
                ? r.bark !== m.token
                : !r.island ||
                  (m.method === 'start'
                    ? r.start !== m.token
                    : r.tokens[m.state.sessionId + ':' + m.state.turn] !== m.token))
            )
              break;
            try {
              await channel(m);
              if (m.method === 'bark' || m.method === 'end') await outbox.ack(m.eventId);
              break;
            } catch {
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
              else console.warn('[dsh-mobile-link] notification delivery failed (no payload logged)');
            }
          }
          inFlight.delete(m.eventId);
          queue.shift();
        }
      } finally {
        lanes.delete(key);
      }
    })();
  }
  function dispatch(id, r, s) {
    const key = s.sessionId + ':' + s.turn,
      now = Date.now(),
      gate = id + '/' + key;
    if (r.bark && s.terminal) enqueue(id, s, 'bark', r.bark);
    if (!r.island) return;
    const token = r.tokens[key];
    if (token) {
      const left = 5000 - (now - (cooldown.get(gate) || 0));
      if (s.notify || left <= 0) {
        clearTimeout(trailing.get(gate));
        trailing.delete(gate);
        cooldown.set(gate, now);
        enqueue(id, s, s.terminal ? 'end' : 'update', token);
      } else if (!trailing.has(gate)) {
        const timer = setTimeout(() => {
          trailing.delete(gate);
          const latest = recent.get(key);
          if (!closed && latest && !latest.terminal && rowFor(id)?.tokens[key] === token) {
            cooldown.set(gate, Date.now());
            enqueue(id, latest, 'update', token);
          }
        }, left);
        timer.unref();
        trailing.set(gate, timer);
      }
    } else if (s.kind === 'started' && r.start) {
      const remoteStart = () => {
        const cur = rowFor(id),
          latest = recent.get(key);
        if (
          live() &&
          !closed &&
          cur?.island &&
          cur.start &&
          !cur.tokens[key] &&
          latest &&
          !latest.terminal &&
          Date.now() - (cur.seen || 0) > 8000
        ) {
          remoteStarts.set(gate, Date.now());
          enqueue(id, latest, 'start', cur.start);
        }
      };
      if (now - (r.seen || 0) > 8000) remoteStart();
      else {
        const t = setTimeout(remoteStart, 8500);
        t.unref();
      }
    }
  }
  const retry = setInterval(() => {
    if ((remote || send) && !closed && live()) outbox.recover(rowFor, submit).catch(() => {});
  }, 20000);
  retry.unref();
  return {
    event(sid, e, getSessionInfo) {
      if (closed || !live()) return;
      const previous = states.get(sid);
      if (e?.type === 'assistant/message') {
        if (previous && !previous.terminal && previous.turn === e.data?.turn &&
            e.seq > previous.seq && [...rows.values()].some(r => r.bark)) {
          previous.excerpt = finalReplyExcerpt(e.data);
          previous.seq = e.seq;
        }
        return;
      }
      const s = taskReducer(previous, sid, e);
      if (!s) return;
      if (previous?.turn === s.turn && e.type !== 'step/start') s.excerpt = previous.excerpt;
      if (s.terminal && [...rows.values()].some(r => r.bark)) {
        let info;
        try { info = getSessionInfo?.(); } catch { /* Optional host services may be unavailable. */ }
        s.report = {
          task: noticeText(info?.title, 48) || '未命名任务',
          workspace: noticeText(info?.workspace, 40) || '未分组',
          summary: (s.kind === 'completed' && s.excerpt) || s.detail || ({
            completed: '本轮已完成，没有文字汇报。', error: '本轮执行失败，请打开会话查看原因。',
            aborted: '本轮已取消。', blocked: '本轮受阻，未能继续执行。',
            interrupted: '本轮已中断。', 'max-tokens': '输出达到上限，结果可能不完整。',
          }[s.kind] ?? '本轮已结束。'),
        };
        delete s.excerpt;
      }
      const key = sid + ':' + s.turn;
      recent.delete(key);
      recent.set(key, s);
      if (recent.size > 512) recent.delete(recent.keys().next().value);
      if (remoteStarts.size > 2048) remoteStarts.delete(remoteStarts.keys().next().value);
      states.delete(sid);
      states.set(sid, s);
      if (states.size > 512) states.delete(states.keys().next().value);
      if (cooldown.size > 2048) cooldown.delete(cooldown.keys().next().value);
      for (const id of rows.keys()) {
        const r = rowFor(id);
        if (r) dispatch(id, r, s);
      }
    },
    status(id) {
      const r = rowFor(id);
      if (r) r.seen = Date.now();
      return {
        relay: remote || !!send,
        bark: !!r?.bark,
        island: !!r?.island,
        tasks: r?.island
          ? [...recent.values()]
              .filter((s) => !s.terminal || Date.now() - s.updatedAt < 300000)
              .map((s) => ({
                ...view(s),
                remoteStarting:
                  Date.now() - (remoteStarts.get(id + '/' + s.sessionId + ':' + s.turn) || 0) < 20000,
              }))
          : [],
      };
    },
    async configure(id, body) {
      const pair = devices.list().find((d) => d.id === id)?.pairedAt;
      if (!pair) bad();
      const r = rowFor(id) ?? { pair, tokens: {}, island: false };
      switch (body?.op) {
        case 'bark':
          if (body.key !== '' && !(typeof body.key === 'string' && /^[\w-]{8,128}$/.test(body.key))) bad();
          if (body.key && !remote && !send)
            throw Object.assign(new Error('relay not configured'), { status: 503 });
          r.bark = body.key;
          break;
        case 'island':
          if (typeof body.enabled !== 'boolean') bad();
          r.island = body.enabled;
          if (!r.island) {
            r.tokens = {};
            delete r.start;
          }
          break;
        case 'test': {
          if (!r.bark || (!remote && !send)) bad();
          if (Date.now() - (r.testAt || 0) < 30000) throw Object.assign(Error('rate'), { status: 429 });
          r.testAt = Date.now();
          await channel({
            desktopId,
            eventId: randomUUID(),
            method: 'bark',
            kind: 'test',
            title: '推送测试',
            token: r.bark,
            state: {
              sessionId: 'test',
              phase: 'test',
              turn: 0,
              step: 0,
              label: '推送测试',
              detail: '',
              updatedAt: Date.now(),
              terminal: false,
            },
          });
          return;
        }
        case 'background':
          r.seen = 0;
          break;
        case 'startToken':
          if (!r.island || !hex(body.token)) bad();
          r.start = body.token;
          break;
        case 'activity': {
          if (!r.island || !hex(body.token) || !safeID(body.sessionId) || !Number.isSafeInteger(body.turn))
            bad();
          const k = body.sessionId + ':' + body.turn;
          if (!r.tokens[k] && Object.keys(r.tokens).length >= 48) delete r.tokens[Object.keys(r.tokens)[0]];
          r.tokens[k] = body.token;
          const s = recent.get(k);
          if (s) enqueue(id, s, s.terminal ? 'end' : 'update', body.token);
          break;
        }
        default:
          bad();
      }
      rows.set(id, r);
      await save();
    },
    async close() {
      closed = true;
      clearInterval(retry);
      for (const t of trailing.values()) clearTimeout(t);
      off?.();
      await writing.catch(() => {});
      await outbox.close();
    },
  };
}
