// Desktop-authoritative model preferences. Never read the credentials service or serialize
// arbitrary plugin config, HTTP headers, environment values, or account login state.
import { isDeepStrictEqual as equal } from 'node:util';

export const modelFile = 'model-preferences.json';
const pi = 'llm-pi-ai';
const defaults = 'agent-default-model';
// Change the default last: its provider and model must already exist on the standby.
const namespaces = [pi, 'llm-deepseek', 'llm-deepseek-account', defaults];
const nativeFields = `baseURL apiKeyEnv thinking reasoningEffort maxTokens defaultContextWindow models modelOverrides
  streamIdleTimeoutMs maxRequestFilesBytes maxInlineRequestImageBytes maxImagesPerRequest imageOffloadByteQuantum
  inlineImageOffloadByteQuantum imageOffloadCountQuantum fileUploadConcurrency fileUploadMaxRetries fileUploadRetryDelayMs
  filesApiTimeoutMs fileExpiresAfterSeconds fileRefreshMarginSeconds fileQuotaCleanupBatch retryPolicy modelsMaxAgeMs modelsTimeoutMs`.split(/\s+/);
const routeFields = `apiKeyEnv displayName api baseURL models modelOverrides compat defaultContextWindow defaultMaxTokens
  defaultInput reasoning thinkingBudgets cacheRetention transport timeoutMs websocketConnectTimeoutMs streamIdleTimeoutMs
  maxRequestImageBytes maxRequestImages imageOffloadCountQuantum requestImageBudgetCount requestImagePixelBudget
  requestImageMaxDimension requestImageMaxBytes retryPolicy`.split(/\s+/);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function reject() { throw Error('Invalid or non-portable model preferences'); }
function pick(value, keys) {
  if (!object(value)) reject();
  const fields = Object.fromEntries(keys.filter(k => Object.hasOwn(value,k) && value[k] !== undefined).map(k => [k,value[k]]));
  if (fields.baseURL != null) {
    const url = URL.parse(fields.baseURL);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) reject();
  }
  if (fields.apiKeyEnv != null && !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(fields.apiKeyEnv)) reject();
  return JSON.parse(JSON.stringify(fields));
}
function project(ns, value) {
  if (ns === defaults) {
    const selection = pick(value, ['provider','model','reasoningEffort']);
    if (![selection.provider,selection.model].every(x => typeof x === 'string' && x.length && x.length <= 512)) reject();
    return selection;
  }
  if (ns !== pi) return pick(value, nativeFields);
  const routes = value?.providers ?? {};
  if (!object(routes) || Object.keys(routes).length > 512) reject();
  return {providers: Object.fromEntries(Object.entries(routes).map(([key,route]) => {
    if (!/^[a-zA-Z0-9][\w.:-]{0,159}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) reject();
    return [key,pick(route,routeFields)];
  }))};
}
function validateNested(value, depth = 0) {
  if (depth > 16) reject();
  if (Array.isArray(value)) { for (const item of value) validateNested(item, depth + 1); }
  else if (object(value)) for (const [key,item] of Object.entries(value)) {
    if (['__proto__','prototype','constructor','$expr','__jsExpr'].includes(key) || /^(headers|authorization|api[_-]?key|cookie|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(key)) reject();
    validateNested(item, depth + 1);
  }
}
function view(forms, ns) {
  const row = forms.find(f => f.ns === ns);
  if (!row || !object(row.value)) throw Error('Model settings service not ready');
  return row;
}
// Only native adapter model definitions use the encoded-byte target. Keep the raw
// cloud view for comparison, so a legacy row already on the standby is repaired.
function migrateModelRows(sections) {
  function migrate(row) {
    if (!object(row) || !Object.hasOwn(row,'imageMaxBytes')) return row;
    const entries = Object.entries(row);
    return Object.fromEntries(Object.hasOwn(row,'imageTargetBytes')
      ? entries.filter(([key]) => key !== 'imageMaxBytes')
      : entries.map(([key,value]) => [key === 'imageMaxBytes' ? 'imageTargetBytes' : key, value]));
  }
  for (const ns of ['llm-deepseek', 'llm-deepseek-account']) {
    for (const key of ['models','modelOverrides']) {
      const rows = sections[ns]?.[key];
      if (Array.isArray(rows)) sections[ns][key] = rows.map(migrate);
      else if (object(rows)) sections[ns][key] = Object.fromEntries(Object.entries(rows).map(([id,row]) => [id,migrate(row)]));
    }
  }
}
function snapshot(forms) {
  // Hosts may omit an official adapter (disabled, unconfigured, or not yet mounted).
  // Absence never means "clear this provider". Active empty catalogues are explicit.
  const sections = {};
  for (const ns of namespaces) {
    if (ns !== defaults && !forms.some(row => row.ns === ns)) continue;
    sections[ns] = project(ns,view(forms,ns).value);
  }
  if (Object.keys(sections).length < 2) throw Error('Model settings service not ready');
  validateNested(sections);
  const data = {v:1, owner:'desktop', sections};
  if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) reject();
  return data;
}

export function modelSnapshot(forms) {
  const data = snapshot(forms);
  migrateModelRows(data.sections);
  return data;
}

// Compare public fields, but mutate only the named paths; the cloud keeps its own
// credential store and private headers. Never rebind private headers to a different URL.
function differences(before, after, path) {
  const ops = [];
  for (const k of new Set([...Object.keys(before),...Object.keys(after)])) {
    if (equal(before[k],after[k])) continue;
    ops.push(Object.hasOwn(after,k) ? {op:'set',path:[...path,k],value:after[k]} : {op:'unset',path:[...path,k]});
  }
  return ops;
}
export async function applyModelSnapshot(settings, data) {
  if (data?.v !== 1 || data.owner !== 'desktop' || !object(data.sections)) reject();
  // Validate the whole envelope before any write, including unexpected nested keys.
  const clean = snapshot(Object.entries(data.sections).map(([ns,value]) => ({ns,value})));
  if (!equal(clean,data)) reject();
  migrateModelRows(clean.sections);
  const forms = settings.describe({redactSecrets:true});
  const changes = [];
  for (const ns of namespaces) {
    if (!Object.hasOwn(clean.sections,ns)) continue;
    const row = view(forms,ns), before = project(ns,row.value), after = clean.sections[ns];
    let ops = [];
    if (ns === pi) {
      for (const route of new Set([...Object.keys(before.providers),...Object.keys(after.providers)])) {
        const a = Object.hasOwn(before.providers,route) ? before.providers[route] : undefined;
        const b = Object.hasOwn(after.providers,route) ? after.providers[route] : undefined;
        const path = ['providers',route];
        if (a && Object.keys(row.value.providers[route]?.headers ?? {}).length && (!b || a.baseURL !== b.baseURL || a.api !== b.api)) {
          throw Error('Cloud provider has private headers; refusing to rebind or remove them');
        }
        if (!a) ops.push({op:'set',path,value:b});
        else if (!b) ops.push({op:'unset',path});
        else ops.push(...differences(a,b,path));
      }
    } else ops = differences(before,after,[]);
    if (ops.length) changes.push({ns,ops,revision:row.revision});
  }
  for (const {ns,ops,revision} of changes) await settings.mutate(ns,ops,revision);
}
