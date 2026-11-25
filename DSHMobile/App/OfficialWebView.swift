import QuickLook
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import WebKit
import Security

/// Weak wrapper so WKUserContentController never creates a retain cycle with the Coordinator.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(controller, didReceive: message)
    }
}

/// Observes the real touch without delaying or taking ownership of WebKit gestures.
private final class VoiceTouchObserver: UIGestureRecognizer {
    var began: ((CGPoint) -> Void)?
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if touches.count == 1, let view, let touch = touches.first { began?(touch.location(in: view)) }
        state = .failed
    }
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}

/// The running desktop supplies every application page, workflow panel and plugin asset.
/// This wrapper handles pinned-TLS trust, native dialogs, downloads, theme matching,
/// and the lightweight native <-> official-UI command/status bridge.
struct OfficialWebView: UIViewRepresentable {
    let session: BrowserSession
    let reloadID: PageReload
    let launchRoute: [String: String]
    let command: WebViewCommand?
    let backgroundColor: UIColor?
    let onRestoring: () -> Void
    let onLoaded: () -> Void
    let onError: (String) -> Void
    let onAuthExpired: () -> Void
    let onProcessTerminated: () -> Void
    let onBridgeMessage: ([String: Any]) -> Void
    let onFrame: (UIImage, String, String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            session: session,
            reloadID: reloadID,
            onRestoring: onRestoring,
            onLoaded: onLoaded,
            onError: onError,
            onAuthExpired: onAuthExpired,
            onProcessTerminated: onProcessTerminated,
            onBridgeMessage: onBridgeMessage
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Separate each paired computer's cookies, caches and local UI state.
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: BrowserSession.dataStoreID(for: session.desktopID))
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .audio
        configuration.userContentController.add(WeakScriptMessageHandler(context.coordinator), name: "dshMobile")

        context.coordinator.install(launchRoute, in: configuration.userContentController)
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        // Left-edge swipe is owned by the DSH sidebar drawer gesture, not browser history.
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        let initialBg = backgroundColor ?? UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: 0x151517) : UIColor(hex: 0xffffff)
        }
        web.underPageBackgroundColor = initialBg
        web.backgroundColor = initialBg
        web.scrollView.backgroundColor = initialBg
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.delegate = context.coordinator
        web.accessibilityIdentifier = "official-web-view"
        context.coordinator.webView = web
        let touch = VoiceTouchObserver(target: nil, action: nil)
        touch.cancelsTouchesInView = false
        touch.delaysTouchesBegan = false
        touch.delaysTouchesEnded = false
        touch.began = { [weak coordinator = context.coordinator] point in coordinator?.recordVoiceTouch(point) }
        web.addGestureRecognizer(touch)
        context.coordinator.onFrame = onFrame
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.captureFrame), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.captureFrame), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.cancelVoice), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        context.coordinator.bind(session, initial: true)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onLoaded = onLoaded
        context.coordinator.onError = onError
        context.coordinator.onAuthExpired = onAuthExpired
        context.coordinator.onProcessTerminated = onProcessTerminated
        context.coordinator.onBridgeMessage = onBridgeMessage
        if let bg = backgroundColor {
            if web.backgroundColor != bg {
                web.underPageBackgroundColor = bg
                web.backgroundColor = bg
                web.scrollView.backgroundColor = bg
            }
        }
        context.coordinator.install(launchRoute, in: web.configuration.userContentController)
        context.coordinator.bind(session)
        if context.coordinator.reloadID != reloadID {
            context.coordinator.reloadID = reloadID
            context.coordinator.reloadHome(userInitiated: reloadID.userInitiated)
        }
        if let command, context.coordinator.lastCommandID != command.id {
            context.coordinator.lastCommandID = command.id
            context.coordinator.execute(command, in: web)
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
        coordinator.stopBackgroundTimers()
        coordinator.cancelVoice()
        web.stopLoading()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "dshMobile")
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.scrollView.delegate = nil
        coordinator.webView = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, UIScrollViewDelegate, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        private var previewFile: URL?
        var session: BrowserSession
        var reloadID: PageReload
        var lastCommandID: UUID?
        #if DEBUG
        private let initialReloadID: PageReload
        #endif
        let onRestoring: () -> Void
        var onLoaded: () -> Void
        var onError: (String) -> Void
        var onAuthExpired: () -> Void
        var onProcessTerminated: () -> Void
        var onBridgeMessage: ([String: Any]) -> Void
        weak var webView: WKWebView?
        private var downloads: [ObjectIdentifier: URL] = [:]
        private let voice = LocalDictation()
        private var voiceID: String?
        private var voiceTouch: (point: CGPoint, time: TimeInterval)?

        func recordVoiceTouch(_ point: CGPoint) { voiceTouch = (point, ProcessInfo.processInfo.systemUptime) }

        @objc func cancelVoice() {
            voiceID = nil
            voiceTouch = nil
            voice.cancel()
        }

        private func handleVoice(_ type: String, _ payload: [String: Any]) {
            guard let id = payload["id"] as? String, id.hasPrefix("dml-"), id.count < 64 else { return }
            if type == "voice-cancel", voiceID == id { cancelVoice(); return }
            if type == "voice-stop", voiceID == id {
                if !voice.requesting { voice.stop() }
                return
            }
            guard type == "voice-start", voiceID == nil, routePainted, session.actions,
                  UIApplication.shared.applicationState == .active, let web = webView,
                  let touch = voiceTouch, ProcessInfo.processInfo.systemUptime - touch.time < 1.2,
                  let x = payload["x"] as? Double, let y = payload["y"] as? Double,
                  let width = payload["width"] as? Double, width > 0, width.isFinite else { return }
            let scale = web.bounds.width / CGFloat(width)
            guard hypot(touch.point.x - CGFloat(x) * scale, touch.point.y - CGFloat(y) * scale) < 44 else { return }
            voiceTouch = nil
            voiceID = id
            voice.text = ""
            voice.event = { [weak self] status, message, level in
                guard let self, self.voiceID == id else { return }
                var result: [String: Any] = ["id": id, "status": status]
                if let message { result[status == "final" ? "text" : "message"] = message }
                if let level { result["level"] = level }
                if let data = try? JSONSerialization.data(withJSONObject: result), let value = String(data: data, encoding: .utf8) {
                    self.webView?.evaluateJavaScript("globalThis.__DSH_MOBILE_BRIDGE__?.voiceEvent?.(\(value))", completionHandler: nil)
                }
                if status == "final" || status == "error" || status == "permission-ready" { self.voiceID = nil }
            }
            Task { [weak self] in
                guard let self, self.voiceID == id else { return }
                await self.voice.start(locale: UserDefaults.standard.string(forKey: "dsh.voice.locale") ?? "", freshGestureAfterPermissions: true)
            }
        }

        init(
            session: BrowserSession,
            reloadID: PageReload,
            onRestoring: @escaping () -> Void,
            onLoaded: @escaping () -> Void,
            onError: @escaping (String) -> Void,
            onAuthExpired: @escaping () -> Void,
            onProcessTerminated: @escaping () -> Void,
            onBridgeMessage: @escaping ([String: Any]) -> Void
        ) {
            self.session = session
            self.reloadID = reloadID
            #if DEBUG
            self.initialReloadID = reloadID
            #endif
            self.onRestoring = onRestoring
            self.onLoaded = onLoaded
            self.onError = onError
            self.onAuthExpired = onAuthExpired
            self.onProcessTerminated = onProcessTerminated
            self.onBridgeMessage = onBridgeMessage
        }

        private var handshake = PageHandshake()
        private var requestedSession: UUID?
        private var bindTask: Task<Void, Never>?
        private var installedBudget: ReconnectBudget?
        private var installedRoute: [String: String]?
        func install(_ route: [String: String], in controller: WKUserContentController) {
            let budget = ReconnectBudget.devices[session.desktopID]
            guard route != installedRoute || budget != installedBudget, let data = try? JSONEncoder().encode(route), let literal = String(data: data, encoding: .utf8) else { return }
            installedRoute = route
            let resetChanged = budget?.resetID != nil && installedBudget?.resetID != budget?.resetID
            installedBudget = budget
            let seed = (try? JSONEncoder().encode(budget)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
            if resetChanged, let webView {
                // Document-start scripts cover subsequent loads. Deliver to the retained page too.
                webView.evaluateJavaScript("globalThis.__DSH_RECONNECT_BUDGET__ = \(seed); globalThis.__DSH_MOBILE_BRIDGE__?.applyNativeBudget?.(globalThis.__DSH_RECONNECT_BUDGET__)", completionHandler: nil)
            }
            controller.removeAllUserScripts()
            let paintBg = "(()=>{const r=globalThis.__DSH_MOBILE_LAUNCH__;if(r?.bg&&document.documentElement)document.documentElement.style.backgroundColor=r.bg;})();"
            controller.addUserScript(WKUserScript(source: Self.nativeNavigation + "\nglobalThis.__DSH_RECONNECT_BUDGET__ = \(seed);\nglobalThis.__DSH_MOBILE_LAUNCH__ = \(literal);\n" + paintBg, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        // Native chrome owns only the leading opener. This runs before Harness paints,
        // even when the paired desktop still serves an older mobile plugin.
        private static let nativeNavigation = """
        (()=>{globalThis.__DSH_NATIVE_PANEL_HUB__=1;globalThis.__DSH_NATIVE_VOICE__=1;
        const mount=()=>{const root=document.documentElement;if(!root)return false;
        root.setAttribute('data-dml-native-nav','');const s=document.createElement('style');
        s.textContent='[data-sidebar-opener]{display:none!important}';root.appendChild(s);return true;};
        if(!mount()){const o=new MutationObserver(()=>{if(mount())o.disconnect()});o.observe(document,{childList:true});}})();
        """
        private var loaded = false
        private var loadingStarted = false
        var onFrame: ((UIImage, String, String) -> Void)?
        private var routePainted = false
        private var snapshotTask: Task<Void, Never>?
        private var periodicSnapshotTask: Task<Void, Never>?
        private var lastCapturedSessionID: String?
        private var frameRequestID = UUID()
        private var lastKeyboardOverlap: CGFloat = 0

        func stopBackgroundTimers() {
            bindTask?.cancel(); bindTask = nil
            snapshotTask?.cancel(); snapshotTask = nil
            periodicSnapshotTask?.cancel(); periodicSnapshotTask = nil
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            // Keep the outer WKWebView viewport pinned so WebKit never pans the fixed header
            // off-screen or fights the GPU-composited keyboard transform.
            if scrollView.zoomScale <= 1.01,
               abs(scrollView.contentOffset.x) > 0.5 || abs(scrollView.contentOffset.y) > 0.5 {
                scrollView.contentOffset = .zero
            }
        }

        @objc func keyboardWillChangeFrame(_ note: Notification) {
            guard let info = note.userInfo,
                  let endFrame = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
            let overlap = keyboardOverlap(for: endFrame)
            dispatchKeyboard(overlap: overlap, durationSeconds: duration)
        }

        @objc func keyboardWillHide(_ note: Notification) {
            let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
            dispatchKeyboard(overlap: 0, durationSeconds: duration)
        }

        private func keyboardOverlap(for screenEndFrame: CGRect) -> CGFloat {
            guard let web = webView, let window = web.window else { return 0 }
            let windowFrame = window.convert(screenEndFrame, from: nil)
            let localEnd = web.convert(windowFrame, from: window)
            let raw = web.bounds.maxY - localEnd.minY
            guard raw > 1, web.bounds.height > 0 else { return 0 }
            return min(raw, web.bounds.height * 0.78)
        }

        private func dispatchKeyboard(overlap: CGFloat, durationSeconds: Double, force: Bool = false) {
            let clamped = max(0, (overlap * 2).rounded() / 2)
            let wasOpen = lastKeyboardOverlap > 0.5
            if !force, abs(clamped - lastKeyboardOverlap) < 0.5 { return }
            lastKeyboardOverlap = clamped
            let ms = max(0, min(600, Int((durationSeconds * 1000).rounded())))
            if let web = webView, loaded || force {
                web.evaluateJavaScript(
                    "globalThis.__DSH_MOBILE_BRIDGE__?.setKeyboard?.(\(clamped), \(ms))",
                    completionHandler: nil
                )
            }
            if wasOpen && clamped == 0 && routePainted {
                scheduleFrameCapture(delaySeconds: 0.45)
            }
        }

        private func scheduleFrameCapture(delaySeconds: Double) {
            snapshotTask?.cancel()
            snapshotTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(delaySeconds))
                guard !Task.isCancelled, let self else { return }
                self.captureFrame()
            }
        }

        private func ensurePeriodicSnapshot() {
            guard periodicSnapshotTask == nil else { return }
            periodicSnapshotTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled, let self else { return }
                    if self.routePainted, UIApplication.shared.applicationState == .active {
                        self.captureFrame()
                    }
                }
            }
        }

        @objc func captureFrame() {
            guard routePainted, lastKeyboardOverlap == 0, let web = webView, let url = web.url, local(url), web.bounds.width > 0, web.bounds.height > 0 else { return }
            let owner = session.desktopID
            guard let capturedSession = lastCapturedSessionID, !capturedSession.isEmpty else { return }
            let requestID = UUID()
            frameRequestID = requestID
            guard let data = try? JSONEncoder().encode(capturedSession),
                  let literal = String(data: data, encoding: .utf8) else { return }
            // Selection metadata can precede the new DOM. Never label the old
            // pixels with the newly selected session's identity.
            let ready = """
            (()=>{const d=document.documentElement;
            if(d.hasAttribute('data-dml-routing')||d.hasAttribute('data-dml-snap-cover'))return false;
            const v=[...document.querySelectorAll('[data-conversation-content]')].find(x=>x.getClientRects().length);
            return !!v&&v.dataset.conversationSession===\(literal)&&v.dataset.contentPhase!=='settling'&&!!v.querySelector('[data-composer-card]');})()
            """
            web.evaluateJavaScript(ready) { [weak self, weak web] value, _ in
                guard let self, let web, web === self.webView, value as? Bool == true,
                      self.frameRequestID == requestID else { return }
                let configuration = WKSnapshotConfiguration()
                configuration.snapshotWidth = NSNumber(value: Double(min(web.bounds.width, 780)))
                configuration.afterScreenUpdates = false
                web.takeSnapshot(with: configuration) { [weak self, weak web] frame, _ in
                    guard let self, let web, web === self.webView, self.routePainted, let frame else { return }
                    guard self.frameRequestID == requestID, self.session.desktopID == owner,
                          self.lastCapturedSessionID == capturedSession else { return }
                    self.onFrame?(frame, owner, capturedSession)
                }
            }
        }
        private var cover: UIView?
        private func uncover() {
            guard let existing = cover else { return }
            cover = nil
            // Cut directly in one frame once the live view has painted — no crossfade ghosting.
            existing.removeFromSuperview()
        }
        private func coverCurrentDocument() {
            guard loaded, cover == nil, let webView, let image = webView.snapshotView(afterScreenUpdates: false) else { return }
            image.frame = webView.bounds; image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            image.isUserInteractionEnabled = false
            image.isAccessibilityElement = false; image.accessibilityElementsHidden = true
            webView.addSubview(image); cover = image
        }
        func reloadHome(userInitiated: Bool) {
            guard userInitiated || holdUntil <= Date() else { return }
            coverCurrentDocument(); loadHome()
        }

        func bind(_ next: BrowserSession, initial: Bool = false) {
            guard requestedSession != next.id, let web = webView else { return }
            requestedSession = next.id
            bindTask?.cancel()
            let changingOrigin = !local(next.url)
            if initial && next.cookies.isEmpty {
                loadHome() // First navigation can use WKWebsiteDataStore's persisted cookie.
                return
            }
            bindTask = Task { @MainActor [weak self, weak web] in
                guard let self, let web else { return }
                for cookie in next.cookies {
                    guard !Task.isCancelled, self.webView === web else { return }
                    await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                }
                guard !Task.isCancelled, self.webView === web else { return }
                if !initial && !changingOrigin && (self.loaded || self.loadingStarted) {
                    self.session = next
                    guard self.loaded else { return } // A new document is already loading.
                    if next.userInitiatedBind { self.userReconnect(in: web); return }
                    guard self.holdUntil <= Date() else { return }
                    web.evaluateJavaScript("globalThis.__DSH_MOBILE_BRIDGE__?.credentialsChanged?.()", completionHandler: nil)
                    return
                }
                // Only a new origin or a missing document needs navigation. A newer
                // bind cancels this one, including while the cookie store is suspended.
                while !initial && !next.userInitiatedBind && self.holdUntil > Date() {
                    do { try await Task.sleep(for: .seconds(max(0, self.holdUntil.timeIntervalSinceNow))) } catch { return }
                }
                guard !Task.isCancelled, self.webView === web else { return }
                if changingOrigin {
                    self.coverCurrentDocument(); web.stopLoading()
                }
                self.session = next
                self.loadHome()
            }
        }

        private var holdUntil: Date {
            max(handshake.holdUntil, ReconnectBudget.devices[session.desktopID]?.holdUntil ?? .distantPast)
        }

        private func loadHome() {
            guard let webView else { return }
            frameRequestID = UUID()
            handshake.bind()
            loaded = false; loadingStarted = true; routePainted = false
            webView.load(URLRequest(url: session.url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 20))
        }

        private func userReconnect(in web: WKWebView) {
            web.evaluateJavaScript("globalThis.__DSH_MOBILE_BRIDGE__?.forceUserReconnect?.()") { [weak self, weak web] value, _ in
                guard let self, let web, self.webView === web, value as? String != "started" else { return }
                self.onBridgeMessage(["type": "user-reconnect-feedback", "result": value as? String ?? "unavailable"])
            }
        }

        func execute(_ command: WebViewCommand, in webView: WKWebView) {
            let script: String
            switch command {
            case .toggleSidebar:
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.toggleSidebar?.()"
            case .openSession(_, let sessionId):
                guard let encoded = try? JSONEncoder().encode(sessionId),
                      let literal = String(data: encoded, encoding: .utf8) else { return }
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.openSession?.(\(literal))"
            case .newSession:
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.newSession?.()"
            case .insertDraft(_, let text):
                guard let encoded = try? JSONEncoder().encode(text),
                      let literal = String(data: encoded, encoding: .utf8) else { return }
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.insertDraft?.(\(literal))"
            case .openHub(_, let tab):
                if let tab,
                   let encoded = try? JSONEncoder().encode(tab),
                   let literal = String(data: encoded, encoding: .utf8) {
                    script = "globalThis.__DSH_MOBILE_BRIDGE__?.openHub?.(\(literal))"
                } else {
                    script = "globalThis.__DSH_MOBILE_BRIDGE__?.openHub?.()"
                }
            case .scrollToTop:
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.scrollToTop?.()"
            case .toggleRightPanel:
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.toggleRightPanel?.()"
            case .reconnect(_, let userInitiated):
                if userInitiated { userReconnect(in: webView); return }
                guard holdUntil <= Date() else { return }
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.reconnect?.()"
            case .wakeCheck:
                guard holdUntil <= Date() else { return }
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.wakeCheck?.()"
            case .setFollowDesktop(_, let enabled):
                script = "globalThis.__DSH_MOBILE_BRIDGE__?.setFollowDesktop?.(\(enabled ? "true" : "false"))"
            }
            webView.evaluateJavaScript(script) { _, _ in }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, local(source), message.name == "dshMobile", let payload = message.body as? [String: Any] else { return }
            let type = payload["type"] as? String
            if type == "reconnect-budget", let raw = payload["budget"] as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: raw),
               let budget = try? JSONDecoder().decode(ReconnectBudget.self, from: data) {
                guard budget.accept(for: session.desktopID) else { return }
                if payload["userOverride"] as? Bool == true { onBridgeMessage(["type": "page-user-override"]) }
                if let route = installedRoute { install(route, in: controller) }
                return
            }
            if type == "mux", let phase = payload["phase"] as? String { handshake.mux(phase) }
            if type == "ws", payload["state"] as? String == "connected" { handshake.didConnect() }
            if let type, type.hasPrefix("voice-") { handleVoice(type, payload); return }
            if type == "launch-applied" {
                #if DEBUG
                if reloadID == initialReloadID,
                   ProcessInfo.processInfo.environment["DSH_TEST_HOLD_FIRST_LAUNCH"] == "1" { return }
                #endif
                routePainted = true
                uncover()
                onBridgeMessage(payload)
                lastCapturedSessionID = payload["sessionId"] as? String
                // Wait briefly after the live view is uncovered so WebKit has composited real pixels (never a blank frame).
                scheduleFrameCapture(delaySeconds: 0.35)
                ensurePeriodicSnapshot()
                return
            }
            if type == "ready" {
                dispatchKeyboard(overlap: lastKeyboardOverlap, durationSeconds: 0, force: true)
            }
            if type == "ui", routePainted {
                let sid = payload["currentSessionId"] as? String
                if sid != lastCapturedSessionID {
                    frameRequestID = UUID()
                    lastCapturedSessionID = sid
                    scheduleFrameCapture(delaySeconds: 1.0)
                }
            }
            onBridgeMessage(payload)
        }

        private func local(_ url: URL) -> Bool {
            url.scheme == "https" && url.host?.lowercased() == session.url.host?.lowercased()
                && (url.port ?? 443) == (session.url.port ?? 443)
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  challenge.protectionSpace.host.lowercased() == session.url.host?.lowercased(),
                  challenge.protectionSpace.port == (session.url.port ?? 443),
                  let trust = challenge.protectionSpace.serverTrust,
                  PinnedTransport.spkiFingerprint(of: trust) == session.fingerprint else {
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == false && ["about:srcdoc", "about:blank"].contains(url.absoluteString) {
                decisionHandler(.allow) // Official sandboxed HTML preview, never top-level navigation.
                return
            }
            if local(url) {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
                return
            }
            // Blob downloads are generated by the official page, not a remote host.
            if url.scheme == "blob", action.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            // A clicked external link opens in the system browser. Never forward
            // the desktop's credential, navigation headers or local cookies.
            if action.navigationType == .linkActivated, ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let http = response.response as? HTTPURLResponse, http.statusCode == 401 {
                loaded = false; loadingStarted = false; routePainted = false
                onAuthExpired()
                decisionHandler(.cancel)
            } else {
                decisionHandler(response.canShowMIMEType ? .allow : .download)
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            cancelVoice()
            handshake.bind()
            onRestoring()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            handshake.didLoad()
            loaded = true; loadingStarted = false; onLoaded()
            dispatchKeyboard(overlap: lastKeyboardOverlap, durationSeconds: 0, force: true)
            // didFinish only confirms HTML loading. Keep the captured view until
            // the route owner confirms that the selected conversation is painted.
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            cancelVoice()
            loaded = false; loadingStarted = false; routePainted = false
            // Tell AppModel first so the saved snapshot covers the WebView before reloading silently in background.
            handshake = PageHandshake() // A terminated process has no pending mux.
            // Keep any active cover pinned until the reloaded live session posts launch-applied.
            onProcessTerminated()
        }

        private func failed(_ error: Error) {
            if (error as? URLError)?.code == .cancelled { return }
            loaded = false; loadingStarted = false; routePainted = false
            onError("官方页面加载失败：\(error.localizedDescription)")
            uncover()
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = action.request.url else { return nil }
            if local(url) { webView.load(action.request) }
            else if ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "DSH", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
            if !present(alert) { completionHandler() }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "DSH", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
            if !present(alert) { completionHandler(false) }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: "DSH", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
            if !present(alert) { completionHandler(nil) }
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            let sameHost = origin.host.lowercased() == session.url.host?.lowercased()
            decisionHandler(sameHost && origin.protocol == "https" ? .prompt : .deny)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("DSHDownloads/\(UUID().uuidString)", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
                let url = directory.appendingPathComponent(["", ".", "..", "/"].contains(name) ? "download" : name)
                downloads[ObjectIdentifier(download)] = url
                completionHandler(url)
            } catch {
                fileError("无法保存下载文件：\(error.localizedDescription)")
                completionHandler(nil)
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            let menu = UIAlertController(title: url.lastPathComponent, message: nil, preferredStyle: .actionSheet)
            if QLPreviewController.canPreview(url as NSURL) {
                menu.addAction(UIAlertAction(title: "本机预览", style: .default) { [weak self] _ in
                    self?.previewFile = url
                    let preview = QLPreviewController(); preview.dataSource = self; preview.delegate = self
                    _ = self?.present(preview)
                })
            }
            menu.addAction(UIAlertAction(title: "存储到文件", style: .default) { [weak self] _ in
                _ = self?.present(UIDocumentPickerViewController(forExporting: [url], asCopy: true))
            })
            menu.addAction(UIAlertAction(title: "共享或用其他 App 打开", style: .default) { [weak self] _ in self?.shareFile(url) })
            menu.addAction(UIAlertAction(title: "取消", style: .cancel))
            menu.popoverPresentationController?.sourceView = webView
            menu.popoverPresentationController?.sourceRect = CGRect(x: 12, y: 8, width: 1, height: 1)
            _ = present(menu)
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewFile == nil ? 0 : 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { previewFile! as NSURL }
        func previewControllerDidDismiss(_ controller: QLPreviewController) { previewFile = nil }

        private func shareFile(_ url: URL) {
            let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let view = webView {
                share.popoverPresentationController?.sourceView = view
                share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 10, width: 1, height: 1)
            }
            _ = present(share)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
            fileError("文件下载失败：\(error.localizedDescription)")
        }

        private func fileError(_ message: String) {
            let alert = UIAlertController(title: "文件下载失败", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default))
            _ = present(alert)
        }

        private func present(_ controller: UIViewController) -> Bool {
            guard var presenter = webView?.window?.rootViewController else { return false }
            while let next = presenter.presentedViewController { presenter = next }
            presenter.present(controller, animated: true)
            return true
        }
    }
}
