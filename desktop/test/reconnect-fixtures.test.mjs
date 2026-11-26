import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RECONNECT_POLICY as policy, initialForceState, nextForceState, shouldForceReconnect } from '../lib/mobile-shell.mjs';

// The browser executes these rows from the start of a fresh, unsubscribed mux.
// Check their expected force totals independently, including the old 1600ms regression.
function checkTimeline(rows, path) {
  let state = initialForceState(0), forces = 0, previous = 0;
  for (const [at, method, repeats, expected] of rows) {
    assert.ok(at >= previous && repeats >= 1 && ['credentialsChanged', 'wakeCheck'].includes(method), path);
    state = nextForceState(state, { type: 'tick' }, at);
    for (let call = 0; call < repeats; call++) {
      if (!shouldForceReconnect(state, at, method)) continue;
      forces++;
      state = nextForceState(state, { type: 'forced' }, at);
    }
    assert.equal(expected, forces, `${path}: ${method} at ${at}ms expects ${expected}, policy allows ${forces}`);
    previous = at;
  }
  assert.ok(rows.some(([ms, method, n]) => method === 'wakeCheck' && n >= 10 && ms < policy.handshakeGraceMs), 'missing wake storm in grace');
  assert.ok(rows.some(([ms, method]) => method === 'credentialsChanged' && ms < policy.handshakeGraceMs), 'missing credential change in grace');
  assert.ok(forces >= 2, 'missing force after grace and minimum gap');
}

test('test and script policy numbers and Python wake timelines agree with RECONNECT_POLICY', async () => {
  const root = new URL('../../', import.meta.url);
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  for (const name of paths) {
    if (!/(?:^|\/)(?:tests?\/|[^/]*Tests\/|scripts?\/|tools?\/|test[-_.]|[^/]+\.test\.)/i.test(name) ||
        !/\.(?:[cm]?js|ts|py|sh|ps1|swift|kt)$/.test(name)) continue;
    const path = new URL(name, root);
    const text = await readFile(path, 'utf8');
    for (const [key, value] of Object.entries(policy)) {
      const literal = new RegExp(`\\b${key}["']?\\s*[:=]\\s*(\\[[\\d_, ]+\\]|[0-9][0-9_]*)`, 'g');
      for (const [, raw] of text.matchAll(literal)) assert.deepEqual(JSON.parse(raw.replaceAll('_', '')), value, `${path.pathname}: ${key}`);
    }
    if (!path.pathname.endsWith('.py')) continue;
    const unchecked = text.split('\n').filter(line => /assert\b.*(?:["'](?:__)?reconnects["'][)\s=:]+\d|\d\s*==.*__reconnects)/.test(line));
    assert.equal(unchecked.length, 0, `${name}: unchecked reconnect count; use RECONNECT_TIMELINE:\n${unchecked.map(line => line.trim()).join('\n')}`);
    const matrix = text.match(/^RECONNECT_TIMELINE\s*=\s*(\[[\s\S]*?^\])/m);
    if (matrix) checkTimeline(JSON.parse(matrix[1]), path.pathname);
    if (path.pathname.endsWith('/shell_recovery.py')) assert.ok(matrix, 'missing shell wake timeline');
  }
});

test('native intent comes from taps; automatic restore, wake and process termination keep their gates', async () => {
  const app = await readFile(new URL('../../DSHMobile/App/AppModel.swift', import.meta.url), 'utf8');
  const web = await readFile(new URL('../../DSHMobile/App/OfficialWebView.swift', import.meta.url), 'utf8');
  const intent = app.slice(app.indexOf("private enum ConnectionSource:"), app.indexOf("private let traceEnabled"));
  const sources = enabled => intent.match(new RegExp(`case ([.\\w, ]+): return ${enabled}`))[1].split(', ').map(s => s.slice(1));
  assert.deepEqual(sources(true), ['activate', 'userRetry', 'launchDesktopNow', 'switchEndpoint', 'reloadPage']);
  assert.deepEqual(sources(false), ['restore', 'recovery', 'sceneChanged', 'network', 'pageFailed', 'authExpired']);
  assert.match(app, /clearUserBudget\(source, for: current.id\)\s*} else if deviceHold > Date\(\) \|\| \(holdUntil > Date\(\)/);
  assert.match(app, /while !source.userInitiated && ready.id/);
  assert.match(app, /if requestedPageReconnect \{ pendingCommand = \.reconnect\(UUID\(\), userInitiated: true\)/);
  assert.deepEqual([...app.matchAll(/issueWakeCheck\(\.(\w+)\)/g)].map(m => m[1]), ['sceneChanged', 'network', 'network']);
  const wake = app.slice(app.indexOf('private func issueWakeCheck'), app.indexOf('private let ephemeral'));
  assert.match(wake, /guard holdUntil <= Date\(\)/);
  assert.match(app, /if restartingDeadPage \{ startReload\(userInitiated: true\) \}/);
  assert.match(app, /func pageProcessTerminated\(\)[\s\S]*?reloadPage\(source: \.pageFailed\)/);
  assert.match(app, /func reloadPage\(\) \{ reloadPage\(source: \.reloadPage\) \}/);
  assert.match(web, /guard userInitiated \|\| holdUntil <= Date\(\)/);
  assert.match(web, /guard budget.accept\(for: session.desktopID\)/);
  assert.match(web, /installedBudget\?\.resetID != budget\?\.resetID/);
  assert.match(web, /applyNativeBudget\?\.\(globalThis.__DSH_RECONNECT_BUDGET__\)/);
  assert.match(app, /@MainActor static func clear\(for id: String\)[\s\S]+?devices\[id\] = Self\([^)]*Date\(\)[\s\S]+?until: 0, decision: 0,[\s\S]+?lastClose: nil, forces: 0, closes: 0,/);
  assert.match(app, /guard current.resetID == resetID, updated >= current.updated else \{ return false \}/);
});

// Exercise the production Swift type (including Codable and actor isolation) in the macOS test job.
if (process.platform === 'darwin') test('native device budget rejects stale generations after a user reset', async () => {
  const app = await readFile(new URL('../../DSHMobile/App/AppModel.swift', import.meta.url), 'utf8');
  const declaration = name => app.match(new RegExp(`(?:struct|enum) ${name}\\b[\\s\\S]*?^}`, 'm'))[0];
  const swift = `import Foundation\n${declaration('ReconnectPolicy')}\n${declaration('ReconnectBudget')}
    @main struct Check { @MainActor static func main() throws {
      let old = ReconnectBudget(updated: 0, until: 60000, decision: 10000, lastForce: 1, lastClose: 2,
                                forces: 3, closes: 2, resetID: nil, lastUserForce: nil)
      precondition(old.accept(for: "desktop") && old.accept(for: "cloud"))
      ReconnectBudget.clear(for: "desktop")
      let clear = ReconnectBudget.devices["desktop"]!
      precondition(clear.forces == 0 && clear.decision == 0 && clear.until == 0 && clear.closes == 0 && clear.lastClose == nil)
      precondition(clear.lastForce == 1 && clear.resetID != nil && !old.accept(for: "desktop"))
      precondition(ReconnectBudget.devices["cloud"] == old && ReconnectBudget.devices["desktop"] == clear)
      let echo = try JSONDecoder().decode(ReconnectBudget.self, from: JSONEncoder().encode(clear))
      precondition(echo.accept(for: "desktop"))
    } }`;
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-budget-'));
  try {
    const executable = join(tmp, 'budget');
    execFileSync('swiftc', ['-parse-as-library', '-o', executable, '-'], { input: swift });
    execFileSync(executable);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// Bound every assertion to its own Swift method, so a guard in an unrelated caller cannot satisfy it.
function method(source, signature) {
  const start = source.indexOf(`func ${signature}`);
  assert.notEqual(start, -1, signature);
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start).match(/^ */)[0];
  const end = source.indexOf(`\n${indent}}`, start);
  assert.notEqual(end, -1, signature);
  return source.slice(start, end);
}

const swiftSource = name => readFile(new URL(`../../DSHMobile/App/${name}.swift`, import.meta.url), 'utf8');
const socketCommand = /issueWakeCheck|wakeCheck\s*\(|\.reconnect\s*\(|forceUserReconnect|credentialsChanged|clearUserBudget/;

test('terminated WebContent immediately issues a non-user navigation through both native layers', async () => {
  const [app, web] = await Promise.all(['AppModel', 'OfficialWebView'].map(swiftSource));
  const terminated = method(app, 'pageProcessTerminated(');
  const reload = method(app, 'reloadPage(source:');
  const automatic = reload.slice(0, reload.indexOf('guard source.userInitiated'));
  assert.match(terminated, /handshake = PageHandshake\(\)[\s\S]*?reloadPage\(source: \.pageFailed\)/);
  assert.match(automatic, /if source == \.pageFailed \{[\s\S]*restore source=pageFailed breaker=ignored[\s\S]*startReload\(userInitiated: false\)\s*return/);
  assert.match(method(app, 'startReload('), /reloadID = PageReload\(userInitiated: userInitiated\)/);
  assert.match(method(web, 'webViewWebContentProcessDidTerminate('), /handshake = PageHandshake\(\)[\s\S]*onProcessTerminated\(\)/);
  assert.match(method(web, 'updateUIView('), /reloadHome\(userInitiated: reloadID.userInitiated\)/);
  const home = method(web, 'reloadHome(');
  assert.match(home, /let holdUntil = handshake.holdUntil[^\n]*\n\s*guard userInitiated \|\| holdUntil <= Date\(\)[\s\S]*loadHome\(\)/);
  assert.match(method(web, 'loadHome('), /webView.load\(URLRequest/);
  const path = [terminated, automatic, method(app, 'startReload('), home, method(web, 'loadHome(')].join('\n');
  assert.doesNotMatch(path, /ReconnectBudget|Task\.sleep|scheduleRecoveryCheck/);
  assert.doesNotMatch(path, socketCommand);
});

test('failed navigation keeps its own handshake deadline and HTTP backoff across retries and binds', async () => {
  const [app, web] = await Promise.all(['AppModel', 'OfficialWebView'].map(swiftSource));
  const failed = method(app, 'pageFailed('), schedule = method(app, 'scheduleDocumentRetry('), arm = method(app, 'armDocumentRetryIfNeeded(');
  assert.match(failed, /scheduleDocumentRetry\(after: 0\.12\)/);
  assert.match(app, /var documentHoldUntil: Date \{ browser == nil \? \.distantPast : handshake.holdUntil \}/);
  assert.match(schedule, /max\(Date\(\).addingTimeInterval\(delay\), documentHoldUntil\)/);
  assert.match(arm, /Task\.sleep\(for: \.seconds\(max\(0, deadline.timeIntervalSinceNow\)\)\)/);
  assert.match(arm, /beginConnection\(preservePage: self.browser != nil, reusePage: false, source: \.pageFailed\)/);
  assert.doesNotMatch(failed + schedule + arm, /ReconnectBudget|\bholdUntil\b|scheduleRecoveryCheck/);
  assert.doesNotMatch(failed + schedule + arm, socketCommand);
  const begin = method(app, 'beginConnection(');
  assert.match(begin, /if source == \.pageFailed \{\s*if documentHoldUntil > Date\(\) \{ scheduleDocumentRetry\(after: 0\); return \}[\s\S]*?\} else if source.userInitiated/);
  assert.match(begin, /ready.endpoint != self.browser\?\.endpoint && self.navigationHoldUntil\(for: source\) > Date\(\)/);
  assert.match(method(app, 'navigationHoldUntil('), /source == \.pageFailed \? documentHoldUntil : holdUntil/);
  assert.match(begin, /if source != \.pageFailed, !source.userInitiated, self.holdUntil > Date\(\)/);
  assert.match(begin, /let delays = \[0\.12, 0\.35, 0\.8, 1\.6, 3\.2, 6\.0\]\s*let delay = delays\[min\(self.recoveryFailures, delays.count - 1\)\]\s*if source == \.pageFailed \{ self.scheduleDocumentRetry\(after: delay\) \}/);
  assert.match(begin, /let requestedPageReconnect = source.userInitiated &&/);
  assert.match(begin, /if source != \.pageFailed && !restartingDeadPage && !requestedPageReconnect/);
  assert.match(begin, /ready.restoresFailedDocument = source == \.pageFailed/);
  const bind = method(web, 'bind(_ next:');
  assert.match(bind, /guard self.loaded, !next.restoresFailedDocument else \{ return \}[\s\S]*?userReconnect/);
  assert.match(bind, /let deadline = next.restoresFailedDocument \? self.handshake.holdUntil : self.holdUntil/);
  assert.match(method(app, 'scheduleRecoveryCheck('), /max\(Date\(\).addingTimeInterval\(delaySeconds\), holdUntil\)/);
});

test('transient ws transitions preserve document backoff; stable health owns the reset and automatic origin replacement is guarded', async () => {
  const text = await readFile(new URL('../../DSHMobile/App/AppModel.swift', import.meta.url),'utf8');
  const ws = text.slice(text.indexOf('case "ws":'), text.indexOf('case "secondary-hub":'));
  assert.ok(ws.includes('lastBridgeHealth = reported'));
  assert.doesNotMatch(ws,/retryStep\s*=|recoveryFailures\s*=/);
  assert.match(text,/stableHealthTask\?\.cancel\(\)[\s\S]*?Task\.sleep\(for: .seconds\(ReconnectPolicy.seconds\(ReconnectPolicy.handshakeGraceMs\)\)\)[\s\S]*?self.wsHealth == .connected[\s\S]*?self.retryStep = 0/);
  const publish = text.slice(text.indexOf('// A mux or breaker can start'), text.indexOf('self.browser = ready',text.indexOf('// A mux or breaker can start')));
  assert.match(publish,/if !source.userInitiated,[\s\S]*?self.wsHealth == .connected,[\s\S]*?ready.endpoint != currentPage.endpoint \{[^}]*?return/);
  const view = await readFile(new URL('../../DSHMobile/App/OfficialWebView.swift', import.meta.url),'utf8');
  assert.match(view,/!changingOrigin && \(self.loaded \|\| self.loadingStarted\)[\s\S]*?credentialsChanged[\s\S]*?return\s+}/);
});
