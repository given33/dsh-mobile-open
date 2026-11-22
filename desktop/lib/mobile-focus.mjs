// Ephemeral in-memory tracker for the session currently focused in the desktop window.
// Never persisted and never mutates Harness session metadata.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createMobileFocusTracker() {
  let sessionId = null;
  let title = '';
  let updatedAt = 0;
  let revision = 0;
  const listeners = new Set();

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(payload = {}) {
      const nextId = typeof payload?.sessionId === 'string' && ID_PATTERN.test(payload.sessionId)
        ? payload.sessionId
        : null;
      const nextTitle = nextId && typeof payload?.title === 'string'
        ? payload.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
        : '';
      if (nextId === sessionId && nextTitle === title) {
        return { revision, sessionId, title, updatedAt };
      }
      sessionId = nextId;
      title = nextId ? nextTitle : '';
      updatedAt = Date.now();
      revision++;
      for (const fn of listeners) fn();
      return { revision, sessionId, title, updatedAt };
    },
    snapshot() {
      return { revision, sessionId, title, updatedAt };
    },
  };
}
