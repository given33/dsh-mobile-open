// Cancel only on an intentional drag into the visible bottom target. A press can
// start over that target in a compact conversation; holding still must keep the draft.
export function voiceReleaseAction(origin, point, target) {
  const moved = Math.hypot(point.x - origin.x, point.y - origin.y) >= 20;
  const inside = point.x >= target.left && point.x <= target.right && point.y >= target.top && point.y <= target.bottom;
  return moved && inside ? 'cancel' : 'draft';
}

// WeChat-style slide-up gesture: supports left-wing 'cancel', right-wing 'edit',
// and sliding upward from the bottom composer bar.
export function voiceGestureAction(origin, point, cancelTarget, options = {}) {
  const pad = Number.isFinite(options.tolerance) ? options.tolerance : 12;
  const moved = Math.hypot(point.x - origin.x, point.y - origin.y) >= 20;
  if (!moved) return 'draft';
  const hit = rect => rect &&
    point.x >= rect.left - pad && point.x <= rect.right + pad &&
    point.y >= rect.top - pad && point.y <= rect.bottom + pad;
  if (hit(cancelTarget)) return 'cancel';
  if (hit(options.editTarget)) return 'edit';
  if (origin.y >= cancelTarget.bottom - 8 && (origin.y - point.y) >= 56 && point.y <= cancelTarget.bottom + pad) {
    if (options.editTarget && point.x >= (cancelTarget.right + options.editTarget.left) / 2) {
      return 'edit';
    }
    return 'cancel';
  }
  return 'draft';
}

// Serialized into the mobile shell. Only text returns from the native recognizer.
export function installMobileVoice({ post, readOnly, session, insertDraft, showToast, haptic, releaseAction }) {
  if (globalThis.__DSH_NATIVE_VOICE__ !== 1) return null;
  const decideAction = releaseAction || voiceGestureAction;
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const make = (tag, id, markup) => {
    const el = document.createElement(tag);
    el.id = id; el.innerHTML = markup;
    return el;
  };
  const mic = make('button', 'dml-voice-button', '<svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3m-7-12v2a7 7 0 0 0 14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>');
  mic.type = 'button'; mic.title = '语音输入'; mic.setAttribute('aria-label', '语音输入');
  const hud = make('div', 'dml-voice-hud',
    '<div class="dml-voice-scrim" aria-hidden="true"></div>' +
    '<div class="dml-voice-bubble">' +
      '<div class="dml-voice-transcript" aria-live="polite"></div>' +
      '<div class="dml-voice-meter" aria-hidden="true">' +
        '<div class="dml-voice-fringe" data-side="left">' + '<span></span>'.repeat(6) + '</div>' +
        '<div class="dml-voice-wave">' + '<i></i>'.repeat(13) + '</div>' +
        '<div class="dml-voice-fringe" data-side="right">' + '<span></span>'.repeat(6) + '</div>' +
      '</div>' +
      '<span class="dml-voice-countdown" aria-hidden="true"></span>' +
      '<span class="dml-voice-tail" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="dml-voice-finishing-pill" role="status">正在转文字…</div>' +
    '<div class="dml-voice-stage">' +
      '<div class="dml-voice-stage-inner">' +
        '<svg class="dml-voice-svg" viewBox="0 0 393 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
          '<defs><linearGradient id="dml-voice-dome-grad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#9E9E9E"/>' +
            '<stop offset="48%" stop-color="#B3B3B3"/>' +
            '<stop offset="100%" stop-color="#C5C5C5"/>' +
          '</linearGradient></defs>' +
          '<g class="dml-voice-wing-svg" data-side="left" data-target="cancel">' +
            '<path class="dml-voice-wing-path" d="M -34.7 125.1 A 682.6 682.6 0 0 1 137.0 87.2 A 37.1 37.1 0 0 1 143.5 161.2 A 608.4 608.4 0 0 0 -9.6 194.9 Z"/>' +
          '</g>' +
          '<g class="dml-voice-wing-svg" data-side="right" data-target="edit">' +
            '<path class="dml-voice-wing-path" d="M 256.0 87.2 A 682.6 682.6 0 0 1 427.7 125.1 L 402.6 194.9 A 608.4 608.4 0 0 0 249.5 161.2 A 37.1 37.1 0 0 1 256.0 87.2 Z"/>' +
          '</g>' +
          '<path class="dml-voice-dome-path" d="M -8.0 211.0 A 592.6 592.6 0 0 1 401.0 211.0 L 401 306 L -8 306 Z"/>' +
          '<path class="dml-voice-dome-rim" d="M -8.0 211.0 A 592.6 592.6 0 0 1 401.0 211.0" fill="none"/>' +
        '</svg>' +
        '<div class="dml-voice-wing-labels" data-side="left">' +
          '<span class="dml-voice-wing-hint" aria-hidden="true">松手 取消</span>' +
          '<span class="dml-voice-wing-text">取消</span>' +
        '</div>' +
        '<div class="dml-voice-wing-labels" data-side="right">' +
          '<span class="dml-voice-wing-hint" aria-hidden="true">松手 编辑文字</span>' +
          '<span class="dml-voice-wing-text">滑到这里 转文字</span>' +
        '</div>' +
        '<span class="dml-voice-arc-label">松开 填入</span>' +
      '</div>' +
      '<div class="dml-voice-stage-safe" aria-hidden="true"></div>' +
    '</div>'
  );
  const panel = make('dialog', 'dml-voice-panel', '<div class="dml-voice-title" tabindex="-1" autofocus>语音转文字</div><div role="status"></div><div class="dml-voice-actions"><button type="button" data-voice-cancel>取消</button><button type="button" data-voice-record hidden>开始录音</button></div>');
  panel.setAttribute('aria-label', '语音转文字'); hud.hidden = true;
  document.body.append(hud, panel);
  const cancelTarget = hud.querySelector('[data-target=cancel]');
  const editTarget = hud.querySelector('[data-target=edit]');
  const transcriptEl = hud.querySelector('.dml-voice-transcript');
  const arcLabel = hud.querySelector('.dml-voice-arc-label');
  const countdownEl = hud.querySelector('.dml-voice-countdown');
  const bars = [...hud.querySelectorAll('.dml-voice-meter span, .dml-voice-meter i')];
  const status = panel.querySelector('[role=status]');
  const record = panel.querySelector('[data-voice-record]');
  const levels = new Float32Array(Math.ceil(bars.length / 2));
  let silenceTimer, hudCloseTimer, clockTimer;
  function stopClock() {
    clearInterval(clockTimer);
    clockTimer = 0;
  }
  function updateClock(startedAt) {
    if (!countdownEl) return;
    const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (sec >= 50) {
      countdownEl.textContent = '还可说 ' + Math.max(1, 60 - sec) + ' 秒';
    } else {
      countdownEl.textContent = '';
    }
  }
  function renderTranscript(item) {
    if (!transcriptEl) return;
    const text = (item?.partial || item?.final || '').trim();
    transcriptEl.textContent = text || '正在聆听…';
    transcriptEl.toggleAttribute('data-placeholder', !text);
  }
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
    // Keep the center responsive while fanning a smooth 25-bar symmetric WeChat speech envelope outward.
    const middle = levels.length - 1;
    bars.forEach((bar, i) => {
      const distance = Math.abs(i - middle);
      const envelope = Math.exp(-(distance * distance) / 36) * (distance % 2 === 0 ? 1 : 0.78);
      const energy = Math.min(1, Math.max(levels[distance], level * envelope) * (1 - 0.55 * distance / middle));
      bar.style.transform = 'scaleY(' + (0.14 + 0.86 * energy) + ')';
    });
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(resetWave, 250);
  }
  let current, gesture, panelTouch, serial = 0;
  const sameSession = item => !readOnly() && item.session === session() && item.card.isConnected;
  const command = (name, item, args = {}) => post({ type: 'voice-' + name, id: item.id, ...args });
  const point = e => ({ x: e.clientX - (visualViewport?.offsetLeft || 0), y: e.clientY - (visualViewport?.offsetTop || 0), width: visualViewport?.width || innerWidth });
  function hideHud(immediate = false) {
    clearTimeout(hudCloseTimer);
    if (hud.hidden) return;
    if (immediate || document.hidden || reducedMotion()) {
      hud.hidden = true;
      hud.removeAttribute('data-closing');
      hud.removeAttribute('data-finishing');
      return;
    }
    hud.setAttribute('data-closing', 'true');
    hudCloseTimer = setTimeout(() => {
      hud.hidden = true;
      hud.removeAttribute('data-closing');
      hud.removeAttribute('data-finishing');
    }, 150);
  }
  function abandon(immediate = false) {
    if (gesture) clearTimeout(gesture.timer);
    gesture = panelTouch = undefined; mic.removeAttribute('data-pressed');
    stopClock();
    if (current) {
      clearTimeout(current.watchdog); command('cancel', current); current = undefined;
    }
    resetMicLabel();
    hideHud(immediate === true);
    if (panel.open) panel.close();
    mic.removeAttribute('data-recording'); resetWave();
  }
  function showPanel(mode, message = '') {
    hideHud(true); status.textContent = message;
    record.hidden = mode !== 'ready' && mode !== 'tap';
    record.textContent = mode === 'tap' ? '完成' : '开始录音';
    if (!panel.open) panel.showModal();
  }
  function applyHudState(action) {
    hud.dataset.action = action;
    if (arcLabel) arcLabel.textContent = action === 'draft' ? '松开 填入' : '语音';
    if (action === 'edit') renderTranscript(current);
  }
  function start(position, mode) {
    const card = mic.closest('[data-composer-card]');
    if (current || readOnly() || !card || document.hidden) return false;
    const startedAt = Date.now();
    const item = { id: 'dml-' + startedAt + '-' + (++serial), session: session(), card, mode, phase: 'starting', startedAt, partial: '', focusAfter: false };
    current = item;
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未响应'); }
    }, 65000);
    if (mode !== 'inline') document.activeElement?.closest?.('[data-composer-card] [contenteditable]')?.blur();
    mic.setAttribute('data-recording', '');
    clearTimeout(hudCloseTimer);
    hud.removeAttribute('data-closing');
    hud.removeAttribute('data-finishing');
    if (mode === 'press') {
      hud.hidden = false;
      applyHudState('draft');
      renderTranscript(item);
      updateClock(startedAt);
      stopClock();
      clockTimer = setInterval(() => updateClock(startedAt), 500);
      resetWave();
      haptic('soft');
    } else if (mode === 'tap') showPanel('tap', '正在启动麦克风…');
    command('start', item, position);
    return true;
  }
  function finish(action) {
    const item = current;
    if (!item || item.phase === 'finishing') return;
    if (action === 'cancel' || !sameSession(item)) { abandon(); return; }
    item.phase = 'finishing';
    item.focusAfter = action === 'edit';
    stopClock();
    clearTimeout(item.watchdog);
    item.watchdog = setTimeout(() => {
      if (current === item) { abandon(); showToast('语音识别未完成，请重试'); }
    }, 4600);
    if (item.mode === 'press') {
      hud.setAttribute('data-finishing', '');
      hud.dataset.action = 'draft';
      resetWave();
    } else if (item.mode !== 'inline') showPanel('wait', '正在转文字…');
    if (item.final !== undefined) applyFinal(item, item.final);
    else command('stop', item);
  }
  function applyFinal(item, text) {
    clearTimeout(item.watchdog);
    if (!text) { abandon(); showToast('没有识别到文字'); return; }
    if (sameSession(item) && !insertDraft(text, { focus: item.mode === 'inline' || !!item.focusAfter })) showToast('无法插入当前草稿');
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
    return decideAction(g, { x: e.clientX, y: e.clientY }, cancelTarget.getBoundingClientRect(), {
      editTarget: editTarget?.getBoundingClientRect(),
    });
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
      haptic(action === 'cancel' ? 'medium' : 'light');
      applyHudState(action);
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
  panel.querySelector('[data-voice-cancel]').addEventListener('click', () => abandon());
  panel.addEventListener('cancel', e => { e.preventDefault(); abandon(); });
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (!current && !panel.open)) return;
    e.preventDefault(); e.stopImmediatePropagation(); abandon();
  }, true);
  window.addEventListener('pagehide', () => abandon(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) abandon(true); });

  return {
    refresh() {
      const card = document.querySelector('[data-composer-card]');
      const send = card && [...card.querySelectorAll('button')].reverse().find(b => b.type === 'submit' || /^(?:发送|停止|继续生成|send|stop|resume|continue)/i.test(b.getAttribute('aria-label') || b.title || ''));
      if (current && (!sameSession(current) || current.card !== card || !send)) abandon(true);
      if (readOnly() || !send) { if (panel.open || gesture || current) abandon(true); mic.remove(); return; }
      if (mic.nextElementSibling !== send) send.before(mic);
    },
    receive(data) {
      const item = current;
      if (!item || item.id !== data?.id) return;
      if (!sameSession(item)) { abandon(); return; }
      if (data.status === 'level' && !hud.hidden && item.phase !== 'finishing') {
        showLevel(data.level);
      }
      if (data.status === 'partial' && typeof data.text === 'string' && !hud.hidden && item.phase !== 'finishing') {
        item.partial = data.text.trim();
        renderTranscript(item);
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
        if (item.phase !== 'finishing' && item.mode !== 'inline') {
          item.final = text;
          if (!hud.hidden) renderTranscript(item);
          return;
        }
        applyFinal(item, text);
      }
    },
  };
}
