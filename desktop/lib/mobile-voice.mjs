// Cancel only on an intentional drag into the visible bottom target. A press can
// start over that target in a compact conversation; holding still must keep the draft.
export function voiceReleaseAction(origin, point, target) {
  const moved = Math.hypot(point.x - origin.x, point.y - origin.y) >= 20;
  const inside = point.x >= target.left && point.x <= target.right && point.y >= target.top && point.y <= target.bottom;
  return moved && inside ? 'cancel' : 'draft';
}

// Serialized into the mobile shell. Only text returns from the native recognizer.
export function installMobileVoice({ post, readOnly, session, insertDraft, showToast, haptic, releaseAction }) {
  if (globalThis.__DSH_NATIVE_VOICE__ !== 1) return null;
  const make = (tag, id, markup) => {
    const el = document.createElement(tag);
    el.id = id; el.innerHTML = markup;
    return el;
  };
  const mic = make('button', 'dml-voice-button', '<svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3m-7-12v2a7 7 0 0 0 14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>');
  mic.type = 'button'; mic.title = '语音输入'; mic.setAttribute('aria-label', '语音输入');
  const hud = make('div', 'dml-voice-hud', '<div class="dml-voice-bubble"><div class="dml-voice-wave" aria-hidden="true">' + '<i></i>'.repeat(13) + '</div></div><div class="dml-voice-dock"><span data-target="cancel" role="status">滑到此处取消</span></div>');
  const panel = make('dialog', 'dml-voice-panel', '<div class="dml-voice-title" tabindex="-1" autofocus>语音转文字</div><div role="status"></div><div class="dml-voice-actions"><button type="button" data-voice-cancel>取消</button><button type="button" data-voice-record hidden>开始录音</button></div>');
  panel.setAttribute('aria-label', '语音转文字'); hud.hidden = true;
  document.body.append(hud, panel);
  const cancelTarget = hud.querySelector('[data-target=cancel]');
  const bars = [...hud.querySelectorAll('i')];
  const status = panel.querySelector('[role=status]');
  const record = panel.querySelector('[data-voice-record]');
  const levels = new Float32Array(Math.ceil(bars.length / 2));
  let silenceTimer;
  function resetWave() {
    clearTimeout(silenceTimer);
    levels.fill(0);
    for (const bar of bars) bar.style.removeProperty('transform');
  }
  function showLevel(value) {
    if (!Number.isFinite(value)) return;
    const level = Math.max(0, Math.min(1, value));
    levels.copyWithin(1, 0);
    levels[0] = level;
    // The middle reacts immediately; older samples spread out toward both edges.
    const middle = levels.length - 1;
    bars.forEach((bar, i) => {
      const distance = Math.abs(i - middle);
      const energy = levels[distance] * (1 - 0.45 * distance / middle);
      bar.style.transform = 'scaleY(' + (0.12 + 0.88 * energy) + ')';
    });
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(resetWave, 250);
  }
  let current, gesture, panelTouch, serial = 0;
  const sameSession = item => !readOnly() && item.session === session() && item.card.isConnected;
  const command = (name, item, args = {}) => post({ type: 'voice-' + name, id: item.id, ...args });
  const point = e => ({ x: e.clientX - (visualViewport?.offsetLeft || 0), y: e.clientY - (visualViewport?.offsetTop || 0), width: visualViewport?.width || innerWidth });
  function abandon() {
    if (gesture) clearTimeout(gesture.timer);
    gesture = panelTouch = undefined; mic.removeAttribute('data-pressed');
    if (current) {
      clearTimeout(current.watchdog); command('cancel', current); current = undefined;
    }
    resetMicLabel();
    hud.hidden = true;
    if (panel.open) panel.close();
    mic.removeAttribute('data-recording'); resetWave();
  }
  function showPanel(mode, message = '') {
    hud.hidden = true; status.textContent = message;
    record.hidden = mode !== 'ready' && mode !== 'tap';
    record.textContent = mode === 'tap' ? '完成' : '开始录音';
    if (!panel.open) panel.showModal();
  }
  function start(position, mode) {
    const card = mic.closest('[data-composer-card]');
    if (current || readOnly() || !card || document.hidden) return false;
    const item = { id: 'dml-' + Date.now() + '-' + (++serial), session: session(), card, mode, phase: 'starting' };
    current = item;
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未响应'); }
    }, 65000);
    if (mode !== 'inline') document.activeElement?.closest?.('[data-composer-card] [contenteditable]')?.blur();
    mic.setAttribute('data-recording', ''); hud.removeAttribute('data-finishing');
    if (mode === 'press') {
      hud.hidden = false; hud.dataset.action = 'draft';
      cancelTarget.textContent = '滑到此处取消'; resetWave();
    } else if (mode === 'tap') showPanel('tap', '正在启动麦克风…');
    command('start', item, position);
    return true;
  }
  function finish(action) {
    const item = current;
    if (!item || item.phase === 'finishing') return;
    if (action === 'cancel' || !sameSession(item)) { abandon(); return; }
    item.phase = 'finishing';
    clearTimeout(item.watchdog);
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未完成，请重试'); }
    }, 4600);
    if (item.mode === 'press') {
      hud.setAttribute('data-finishing', ''); hud.dataset.action = 'draft'; cancelTarget.textContent = '正在转文字…'; resetWave();
    } else if (item.mode !== 'inline') showPanel('wait', '正在转文字…');
    if (item.final !== undefined) applyFinal(item, item.final);
    else command('stop', item);
  }
  function applyFinal(item, text) {
    clearTimeout(item.watchdog);
    if (!text) { abandon(); showToast('没有识别到文字'); return; }
    if (sameSession(item) && !insertDraft(text, { focus: item.mode === 'inline' })) showToast('无法插入当前草稿');
    abandon();
  }
  function resetMicLabel() {
    mic.setAttribute('aria-label', '语音输入');
    mic.setAttribute('aria-pressed', 'false');
    mic.title = '语音输入';
  }
  function startInline(position) {
    const card = mic.closest('[data-composer-card]');
    const editor = card?.querySelector('[contenteditable="true"]');
    if (!editor) { showPanel('ready'); return; }
    // Still in the trusted tap: keep the system keyboard and the actual editable draft.
    editor.focus({ preventScroll: true });
    mic.setAttribute('aria-label', '结束听写');
    mic.setAttribute('aria-pressed', 'true');
    mic.title = '结束听写';
    if (!start(position, 'inline')) resetMicLabel();
  }
  function actionAt(e, g) {
    return releaseAction(g, {x: e.clientX, y: e.clientY}, cancelTarget.getBoundingClientRect());
  }
  {
    const control = mic;
    control.addEventListener('pointerdown', e => {
      if (!e.isTrusted || !e.isPrimary || e.button !== 0 || (current && current.mode !== 'inline') || gesture || readOnly()) return;
      e.preventDefault(); e.stopPropagation(); control.setPointerCapture(e.pointerId);
      mic.setAttribute('data-pressed', '');
      const g = { id: e.pointerId, x: e.clientX, y: e.clientY, position: point(e) }; gesture = g;
      if (!current) g.timer = setTimeout(() => { if (gesture === g) g.started = start(g.position, 'press'); }, 125);
    });
    control.addEventListener('pointermove', e => {
      if (!gesture?.started || gesture.id !== e.pointerId || !current) return;
      const action = actionAt(e, gesture);
      if (hud.dataset.action === action) return;
      haptic('light'); hud.dataset.action = action;
      cancelTarget.textContent = action === 'cancel' ? '松开取消' : '滑到此处取消';
    });
    control.addEventListener('pointerup', e => {
      if (gesture?.id !== e.pointerId) return;
      const g = gesture; gesture = undefined; clearTimeout(g.timer); mic.removeAttribute('data-pressed');
      e.preventDefault(); e.stopPropagation();
      if (g.started) finish(actionAt(e, g));
      else if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 14) {
        if (current?.mode === 'inline') finish('draft');
        else if (!current) startInline(g.position);
      }
    });
    for (const type of ['pointercancel', 'lostpointercapture']) control.addEventListener(type, e => {
      if (gesture?.id === e.pointerId) abandon();
    });
    control.addEventListener('contextmenu', e => e.preventDefault());
  }
  mic.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.isTrusted && e.detail === 0) {
      if (current?.mode === 'inline') finish('draft');
      else if (!current) showPanel('ready');
    }
  });
  record.addEventListener('pointerdown', e => { if (e.isTrusted && e.isPrimary && e.button === 0) panelTouch = point(e); });
  record.addEventListener('pointercancel', () => { panelTouch = undefined; });
  record.addEventListener('click', e => {
    if (!e.isTrusted) return;
    if (current?.mode === 'tap') finish('draft');
    else if (panelTouch) start(panelTouch, 'tap');
    else showToast('请点按屏幕开始录音');
    panelTouch = undefined;
  });
  panel.querySelector('[data-voice-cancel]').addEventListener('click', abandon);
  panel.addEventListener('cancel', e => { e.preventDefault(); abandon(); });
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (!current && !panel.open)) return;
    e.preventDefault(); e.stopImmediatePropagation(); abandon();
  }, true);
  window.addEventListener('pagehide', abandon);
  document.addEventListener('visibilitychange', () => { if (document.hidden) abandon(); });

  return {
    refresh() {
      const card = document.querySelector('[data-composer-card]');
      const send = card && [...card.querySelectorAll('button')].reverse().find(b => b.type === 'submit' || /^(?:发送|停止|继续生成|send|stop|resume|continue)/i.test(b.getAttribute('aria-label') || b.title || ''));
      if (current && (!sameSession(current) || current.card !== card || !send)) abandon();
      if (readOnly() || !send) { if (panel.open || gesture || current) abandon(); mic.remove(); return; }
      if (mic.nextElementSibling !== send) send.before(mic);
    },
    receive(data) {
      const item = current;
      if (!item || item.id !== data?.id) return;
      if (!sameSession(item)) { abandon(); return; }
      if (data.status === 'level' && !hud.hidden && item.phase !== 'finishing') {
        showLevel(data.level);
      }
      if (data.status === 'recording' && item.phase === 'finishing') { command('stop', item); return; }
      if (data.status === 'recording' && item.phase === 'starting') {
        item.phase = 'recording';
        if (item.mode === 'tap') status.textContent = '正在录音…';
        haptic('light');
      }
      if (data.status === 'error' || data.status === 'permission-ready') {
        abandon(); showToast(data.message || '语音识别暂不可用'); return;
      }
      if (data.status === 'final') {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        // Some OS recognizers finish at a pause before the user releases their finger.
        if (item.phase !== 'finishing' && item.mode !== 'inline') { item.final = text; return; }
        applyFinal(item, text);
      }
    },
  };
}
