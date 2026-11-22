// Adapted from Z.AI's ZCode (Apache-2.0): webRemoteControlLifecycle.ts and
// chatSessionScrollMemory.ts. See desktop/THIRD_PARTY_NOTICES.md for provenance.

// The DSH shell embeds these functions as source, so each is self-contained.
export function createWebRemoteControlLifecycleRecovery({ documentTarget, windowTarget, onSuspend, onRecover }) {
  let suspended = documentTarget.visibilityState === 'hidden';
  let offline = windowTarget.navigator?.onLine === false;
  const suspend = () => {
    if (suspended) return;
    suspended = true;
    onSuspend();
  };
  const recover = (reason) => {
    // The first pageshow is not a resume. An online event while backgrounded
    // cannot spend the next foreground's single recovery.
    if (!suspended || offline || documentTarget.visibilityState === 'hidden') return;
    suspended = false;
    onRecover(reason);
  };
  const visibility = () => documentTarget.visibilityState === 'hidden' ? suspend() : recover('visible');
  const pageShow = () => recover('pageshow');
  const resume = () => recover('resume');
  const wentOffline = () => { offline = true; suspend(); };
  const wentOnline = () => { offline = false; recover('online'); };
  if (offline && !suspended) suspend();

  documentTarget.addEventListener('visibilitychange', visibility);
  documentTarget.addEventListener('freeze', suspend);
  documentTarget.addEventListener('resume', resume);
  windowTarget.addEventListener('pageshow', pageShow);
  windowTarget.addEventListener('pagehide', suspend);
  windowTarget.addEventListener('offline', wentOffline);
  windowTarget.addEventListener('online', wentOnline);

  return {
    isSuspended: () => suspended,
    dispose() {
      documentTarget.removeEventListener('visibilitychange', visibility);
      documentTarget.removeEventListener('freeze', suspend);
      documentTarget.removeEventListener('resume', resume);
      windowTarget.removeEventListener('pageshow', pageShow);
      windowTarget.removeEventListener('pagehide', suspend);
      windowTarget.removeEventListener('offline', wentOffline);
      windowTarget.removeEventListener('online', wentOnline);
    },
  };
}

export function createChatSessionScrollMemory(maxEntries = 200) {
  // Like ZCode, read/write refresh LRU order. DSH IDs are scoped to this
  // single desktop document; no transcript or position is persisted to disk.
  const states = new Map();
  function touch(key, state) {
    states.delete(key);
    states.set(key, state);
    return state;
  }
  return {
    read(key) {
      const state = states.get(key);
      return state ? touch(key, state) : null;
    },
    save(key, { scrollTop, scrollHeight, clientHeight }) {
      if (!key || clientHeight <= 0) return;
      const maximum = Math.max(0, scrollHeight - clientHeight);
      touch(key, { scrollTop: Math.min(Math.max(scrollTop, 0), maximum), wasPinnedToBottom: maximum - scrollTop <= 48 });
      while (states.size > maxEntries) states.delete(states.keys().next().value);
    },
    resolve(state, { scrollHeight, clientHeight }) {
      const maximum = Math.max(0, scrollHeight - clientHeight);
      return state.wasPinnedToBottom ? maximum : Math.min(Math.max(state.scrollTop, 0), maximum);
    },
  };
}

export function groupMobileTasks(sessions, query) {
  const buckets = { approval: [], running: [], history: [] };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const session of sessions) {
    const text = (session.title + ' ' + session.workspaceName).toLowerCase();
    if (!terms.every(term => text.includes(term))) continue;
    buckets[session.pendingInteraction ? 'approval' : session.running ? 'running' : 'history'].push(session);
  }
  return buckets;
}
