export function voiceReleaseAction(dx, dy) {
  if (dx < -44 || (dy < -72 && dx < 28)) return 'cancel';
  return dx > 42 ? 'preview' : 'draft';
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
  const pad = make('button', 'dml-voice-hold', '按住 说话'); pad.type = 'button';
  const hud = make('div', 'dml-voice-hud', '<div class="dml-voice-bubble"><div class="dml-voice-wave" aria-hidden="true">' + '<i></i>'.repeat(13) + '</div></div><div class="dml-voice-directions" aria-hidden="true"><span data-target="cancel"><b>×</b>取消</span><span data-target="preview"><b>文</b>预览文字</span></div><div class="dml-voice-dock"><span role="status"></span></div>');
  const panel = make('dialog', 'dml-voice-panel', '<div class="dml-voice-title" tabindex="-1" autofocus>语音转文字</div><div role="status"></div><textarea rows="4" aria-label="识别结果" hidden></textarea><div class="dml-voice-actions"><button type="button" data-voice-cancel>取消</button><button type="button" data-voice-record hidden>开始录音</button><button type="button" data-voice-use hidden>插入草稿</button></div>');
  panel.setAttribute('aria-label', '语音转文字'); hud.hidden = true;
  document.body.append(hud, panel);
  const caption = hud.querySelector('[role=status]'), directions = hud.querySelector('.dml-voice-directions');
  const bars = [...hud.querySelectorAll('i')];
  const status = panel.querySelector('[role=status]'), result = panel.querySelector('textarea');
  const use = panel.querySelector('[data-voice-use]'), record = panel.querySelector('[data-voice-record]');
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
    hud.hidden = true;
    if (panel.open) panel.close();
    mic.removeAttribute('data-recording'); result.value = '';
  }
  function showPanel(mode, message = '') {
    hud.hidden = true; status.textContent = message;
    result.hidden = use.hidden = mode !== 'preview';
    use.disabled = !result.value.trim();
    record.hidden = mode !== 'ready' && mode !== 'tap';
    record.textContent = mode === 'tap' ? '完成' : '开始录音';
    if (!panel.open) panel.showModal();
  }
  function start(position, mode) {
    const card = mic.closest('[data-composer-card]');
    if (current || readOnly() || !card || document.hidden) return false;
    const item = { id: 'dml-' + Date.now() + '-' + (++serial), session: session(), card, mode, phase: 'starting', action: 'draft' };
    current = item;
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未响应'); }
    }, 65000);
    document.activeElement?.closest?.('[data-composer-card] [contenteditable]')?.blur();
    mic.setAttribute('data-recording', ''); hud.removeAttribute('data-finishing');
    if (mode === 'press') {
      hud.hidden = false; hud.dataset.action = 'draft';
      caption.textContent = '正在启动麦克风…'; directions.hidden = false;
      for (const bar of bars) bar.style.transform = 'scaleY(.14)';
    } else showPanel('tap', '正在启动麦克风…');
    command('start', item, position);
    return true;
  }
  function finish(action) {
    const item = current;
    if (!item || item.phase === 'finishing') return;
    if (action === 'cancel' || !sameSession(item)) { abandon(); return; }
    item.phase = 'finishing'; item.action = action;
    clearTimeout(item.watchdog);
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未完成，请重试'); }
    }, 4600);
    if (item.mode === 'press') {
      hud.setAttribute('data-finishing', ''); directions.hidden = true; hud.dataset.action = 'draft'; caption.textContent = '正在转文字…';
    } else showPanel('wait', '正在转文字…');
    if (item.final !== undefined) applyFinal(item, item.final);
    else command('stop', item);
  }
  function applyFinal(item, text) {
    clearTimeout(item.watchdog);
    if (!text) { abandon(); showToast('没有识别到文字'); return; }
    if (item.action === 'preview' || item.mode === 'tap') {
      item.phase = 'preview'; mic.removeAttribute('data-recording'); result.value = text; showPanel('preview');
    } else {
      if (!insertDraft(text, { focus: false })) showToast('无法插入当前草稿');
      if (pad.isConnected) togglePad(false);
      abandon();
    }
  }
  function togglePad(on) {
    const input = mic.closest('[data-composer-card]')?.querySelector('[data-input-scroll]');
    if (on && input) { input.before(pad); document.activeElement?.closest('[contenteditable]')?.blur(); }
    else pad.remove();
    mic.setAttribute('aria-pressed', String(pad.isConnected));
  }
  function actionAt(e, g) {
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (dy < -32) {
      for (const el of directions.children) {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left - 16 && e.clientX <= r.right + 16 && e.clientY >= r.top - 22 && e.clientY <= r.bottom + 22) return el.dataset.target;
      }
    }
    return releaseAction(dx, dy);
  }
  for (const control of [mic, pad]) {
    control.addEventListener('pointerdown', e => {
      if (!e.isTrusted || !e.isPrimary || e.button !== 0 || current || gesture || readOnly()) return;
      e.preventDefault(); e.stopPropagation(); control.setPointerCapture(e.pointerId);
      mic.setAttribute('data-pressed', '');
      const g = { id: e.pointerId, x: e.clientX, y: e.clientY, position: point(e) }; gesture = g;
      if (control === pad) g.started = start(g.position, 'press');
      else g.timer = setTimeout(() => { if (gesture === g) g.started = start(g.position, 'press'); }, 125);
    });
    control.addEventListener('pointermove', e => {
      if (!gesture?.started || gesture.id !== e.pointerId || !current) return;
      const action = actionAt(e, gesture);
      if (hud.dataset.action === action) return;
      haptic('light'); hud.dataset.action = action;
      caption.textContent = action === 'cancel' ? '松开取消' : action === 'preview' ? '松开预览文字' : '松开插入草稿';
    });
    control.addEventListener('pointerup', e => {
      if (gesture?.id !== e.pointerId) return;
      const g = gesture; gesture = undefined; clearTimeout(g.timer); mic.removeAttribute('data-pressed');
      e.preventDefault(); e.stopPropagation();
      if (g.started) finish(actionAt(e, g));
      else if (control === mic && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 14 && !current) {
        if (mic.closest('[data-composer-card]')?.querySelector('[data-input-scroll]')) togglePad(!pad.isConnected);
        else showPanel('ready');
      }
    });
    for (const type of ['pointercancel', 'lostpointercapture']) control.addEventListener(type, e => {
      if (gesture?.id === e.pointerId) abandon();
    });
    control.addEventListener('contextmenu', e => e.preventDefault());
  }
  pad.addEventListener('click', e => { if (e.isTrusted && e.detail === 0 && !current) showPanel('ready'); });
  mic.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.isTrusted && e.detail === 0 && !current) showPanel('ready');
  });
  record.addEventListener('pointerdown', e => { if (e.isTrusted && e.isPrimary && e.button === 0) panelTouch = point(e); });
  record.addEventListener('pointercancel', () => { panelTouch = undefined; });
  record.addEventListener('click', e => {
    if (!e.isTrusted) return;
    if (current?.mode === 'tap') finish('preview');
    else if (panelTouch) start(panelTouch, 'tap');
    else showToast('请点按屏幕开始录音');
    panelTouch = undefined;
  });
  panel.querySelector('[data-voice-cancel]').addEventListener('click', abandon);
  panel.addEventListener('cancel', e => { e.preventDefault(); abandon(); });
  result.addEventListener('input', () => { use.disabled = !result.value.trim(); });
  use.addEventListener('click', e => {
    if (!e.isTrusted || current?.phase !== 'preview') return;
    if (sameSession(current) && insertDraft(result.value.trim(), { focus: false })) { togglePad(false); abandon(); }
    else showToast('无法插入当前草稿');
  });
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
      if (readOnly() || !send) { if (panel.open || gesture) abandon(); togglePad(false); mic.remove(); return; }
      if (mic.nextElementSibling !== send) send.before(mic);
    },
    receive(data) {
      const item = current;
      if (!item || item.id !== data?.id || item.phase === 'preview') return;
      if (!sameSession(item)) { abandon(); return; }
      if (data.status === 'level' && !hud.hidden && item.phase !== 'finishing') {
        const level = Math.max(0, Math.min(1, Number(data.level) || 0));
        for (let i = 0; i < bars.length - 1; i++) bars[i].style.transform = bars[i + 1].style.transform;
        bars[bars.length - 1].style.transform = 'scaleY(' + (.14 + .86 * level) + ')';
      }
      if (data.status === 'recording' && item.phase === 'finishing') { command('stop', item); return; }
      if (data.status === 'recording' && item.phase === 'starting') {
        item.phase = 'recording';
        if (item.mode === 'press' && hud.dataset.action === 'draft') caption.textContent = '松开插入草稿';
        else if (item.mode === 'tap') status.textContent = '正在录音…';
        haptic('light');
      }
      if (data.status === 'error' || data.status === 'permission-ready') {
        abandon(); showToast(data.message || '语音识别暂不可用'); return;
      }
      if (data.status === 'final') {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        // Some OS recognizers finish at a pause before the user releases their finger.
        if (item.phase !== 'finishing') { item.final = text; return; }
        applyFinal(item, text);
      }
    },
  };
}
