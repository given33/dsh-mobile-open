// Host registration for declarative native phone pages. No executable UI
// crosses the wire, and each write dispatches to a named, registered handler.
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const KINDS = new Set(['text', 'multiline', 'toggle', 'number', 'select', 'secret']);
const key = x => typeof x === 'string' && KEY.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x);
const label = (x, max = 160) => typeof x === 'string' && x.trim() && x.length <= max;
const problem = (message, code = 'mobilePanels/input') => Object.assign(new Error(message), { code });
const strings = (x, max) => typeof x === 'string' && x.length <= max;
const result = x => ({ message: typeof x === 'string' ? x.slice(0, 2000) : '' });

function fieldsOf(rows) {
  if (!Array.isArray(rows) || rows.length > 32) throw problem('插件提交了无效的字段定义。');
  const ids = new Set();
  return rows.map(item => {
    if (!item || !key(item.id) || ids.has(item.id) || !label(item.title) || !KINDS.has(item.kind)) {
      throw problem('插件提交了无效的字段定义。');
    }
    ids.add(item.id);
    const field = { id: item.id, title: item.title, kind: item.kind, required: item.required === true };
    if (strings(item.detail, 2000)) field.detail = item.detail;
    if (item.kind === 'select') {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 32) throw problem('插件提交了无效的选项。');
      const keys = new Set();
      field.options = item.options.map(option => {
        if (!option || !key(option.id) || keys.has(option.id) || !label(option.title)) throw problem('插件提交了无效的选项。');
        keys.add(option.id);
        return { id: option.id, title: option.title };
      });
    }
    return field;
  });
}

function validValue(field, value) {
  switch (field.kind) {
    case 'toggle': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'select': return field.options.some(x => x.id === value);
    case 'text': case 'multiline': case 'secret': return strings(value, 4000) && (!field.required || !!value.trim());
    default: return false;
  }
}

export function createPanelRegistry() {
  const entries = new Map();
  let next = 0;
  function register(owner, definition) {
    if (!key(owner) || !definition || !key(definition.id) || !label(definition.title) || typeof definition.read !== 'function') {
      throw problem('无效的原生插件面板。');
    }
    const id = owner + ':' + definition.id;
    if (entries.size >= 64 || entries.has(id)) throw problem('面板已存在或超过数量限制。');
    const fields = fieldsOf(definition.fields ?? []);
    const handlers = new Map();
    const actions = definition.actions ?? [];
    if (!Array.isArray(actions) || actions.length > 12) throw problem('无效的插件操作定义。');
    for (const action of actions) {
      if (!action || !key(action.id) || handlers.has(action.id) || !label(action.title) || typeof action.run !== 'function') {
        throw problem('无效的插件操作定义。');
      }
      handlers.set(action.id, { id: action.id, title: action.title, confirm: action.confirm === true, run: action.run });
    }
    const summary = { id, title: definition.title, owner, version: 1 };
    if (strings(definition.detail, 2000)) summary.detail = definition.detail;
    const entry = { summary, fields, handlers, read: definition.read, generation: ++next, running: false };
    entries.set(id, entry);
    return () => { if (entries.get(id) === entry) entries.delete(id); };
  }

  function panel(id) {
    const entry = typeof id === 'string' && entries.get(id);
    if (!entry) throw problem('该面板已卸载或未启用。', 'mobilePanels/unavailable');
    return entry;
  }

  async function state(entry) {
    const current = await entry.read();
    if (!current || !['string', 'number'].includes(typeof current.revision) || String(current.revision).length > 128) {
      throw problem('插件没有提供有效的状态版本。');
    }
    return { current, revision: entry.generation + ':' + current.revision };
  }

  return {
    register,
    async list() {
      return [...entries.values()].map(x => x.summary).sort((a, b) => a.title.localeCompare(b.title));
    },
    async read({ id }) {
      const entry = panel(id);
      const { current, revision } = await state(entry);
      const fields = entry.fields.map(field => {
        const value = current.values && Object.hasOwn(current.values, field.id) ? current.values[field.id] : undefined;
        return field.kind !== 'secret' && validValue(field, value) ? { ...field, value } : field;
      });
      const info = Array.isArray(current.info) ? current.info.slice(0, 32).filter(x => x && label(x.title) && strings(x.value, 4000))
        .map(x => ({ title: x.title, value: x.value })) : [];
      const actions = [...entry.handlers.values()].map(({ run: _, ...action }) => action);
      return { ...entry.summary, revision, fields, info, actions };
    },
    async perform({ id, action, expectedRevision, values }) {
      const entry = panel(id);
      const handler = entry.handlers.get(action);
      if (!handler || entry.running) throw problem('操作不存在或面板正忙。');
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw problem('提交的字段无效。');
      const accepted = Object.create(null);
      for (const [fieldID, value] of Object.entries(values)) {
        const field = entry.fields.find(x => x.id === fieldID);
        if (!field || !validValue(field, value)) throw problem('提交的字段无效。');
        accepted[fieldID] = value;
      }
      for (const field of entry.fields) {
        if (field.required && !Object.hasOwn(accepted, field.id)) throw problem('请填写必填字段。');
      }
      entry.running = true;
      try {
        const { revision } = await state(entry);
        if (revision !== expectedRevision || entries.get(id) !== entry) {
          throw problem('电脑上的状态已更新，请重新加载面板。', 'mobilePanels/stale');
        }
        // A plugin can perform its own atomic compare before committing, if
        // desktop writes can run concurrently with a mobile action.
        try { return result(await handler.run(accepted, { expectedRevision: revision.slice(revision.indexOf(':') + 1) })); }
        catch { throw problem('插件未能完成操作。', 'mobilePanels/action-failed'); }
      } finally { entry.running = false; }
    },
  };
}
