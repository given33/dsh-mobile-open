import Foundation
import SwiftUI
import UIKit
import WebKit
import Network
import DSHCore
import CryptoKit
import UserNotifications

private struct ResumeSnapshot: Codable {
    let sessionID: String
    let capturedAt: Date
    let jpeg: Data
    let theme: PageTheme? // Absent in snapshots saved before 0.6.1.
}

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

enum WebSocketHealth: Equatable {
    case connecting
    case connected
    case disconnected
}

struct DesktopFocus: Equatable {
    let sessionId: String
    let title: String
}

struct PageTheme: Equatable, Codable {
    var dark: Bool?
    var bgBase: String
    var sidebarFill: String

    var backgroundUIColor: UIColor? {
        if let color = Self.parseColor(bgBase), color.cgColor.alpha == 1 {
            var brightness: CGFloat = 0
            if dark == nil || !color.getWhite(&brightness, alpha: nil) || dark == (brightness < 0.5) { return color }
        }
        return dark.map { $0 ? UIColor(red: 21/255, green: 21/255, blue: 23/255, alpha: 1) : .white }
    }

    /// Older records contain only pixels. Sample the WebView's header margin (not the
    /// document itself) when its last saved appearance disagrees with the preview.
    func matchingLegacyFrame(_ image: UIImage) -> PageTheme {
        guard let cg = image.cgImage,
              let strip = cg.cropping(to: CGRect(x: 0, y: 0, width: cg.width, height: max(1, cg.height / 160))),
              let ctx = CGContext(data: nil, width: 9, height: 1, bitsPerComponent: 8, bytesPerRow: 36,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let buffer = ctx.data else { return self }
        ctx.draw(strip, in: CGRect(x: 0, y: 0, width: 9, height: 1))
        let bytes = buffer.assumingMemoryBound(to: UInt8.self)
        let centers = (0..<9).map { Int(bytes[$0 * 4]) }.sorted()
        let level = centers[4]
        guard level < 64 || level > 208 else { return self }
        let matches = (0..<9).filter { index in
            (0..<3).allSatisfy { abs(Int(bytes[index * 4 + $0]) - level) < 15 }
        }
        guard matches.count >= 6 else { return self }
        let isDark = level < 64
        if dark == isDark, let color = Self.parseColor(bgBase), color.cgColor.alpha == 1 {
            var white: CGFloat = 0
            if color.getWhite(&white, alpha: nil), (white < 0.5) == isDark { return self }
        }
        let offset = matches[matches.count / 2] * 4
        let hex = String(format: "#%02x%02x%02x", bytes[offset], bytes[offset + 1], bytes[offset + 2])
        return PageTheme(dark: isDark, bgBase: hex, sidebarFill: hex)
    }
    var backgroundColor: Color? { backgroundUIColor.map(Color.init(uiColor:)) }

    static func parseColor(_ raw: String) -> UIColor? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") {
            let hex = String(s.dropFirst())
            var value: UInt64 = 0
            guard Scanner(string: hex).scanHexInt64(&value) else { return nil }
            if hex.count == 6 {
                return UIColor(
                    red: CGFloat((value >> 16) & 0xff) / 255,
                    green: CGFloat((value >> 8) & 0xff) / 255,
                    blue: CGFloat(value & 0xff) / 255,
                    alpha: 1
                )
            }
            if hex.count == 3 {
                let r = (value >> 8) & 0xf
                let g = (value >> 4) & 0xf
                let b = value & 0xf
                return UIColor(red: CGFloat(r * 17) / 255, green: CGFloat(g * 17) / 255, blue: CGFloat(b * 17) / 255, alpha: 1)
            }
            return nil
        }
        if s.lowercased().hasPrefix("rgb") {
            let digits = s.split { !$0.isNumber && $0 != "." }
            guard digits.count >= 3,
                  let r = Double(digits[0]), let g = Double(digits[1]), let b = Double(digits[2]) else { return nil }
            let a = digits.count >= 4 ? (Double(digits[3]) ?? 1) : 1
            return UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
        }
        return nil
    }
}

enum WebViewCommand: Equatable {
    case toggleSidebar(UUID)
    case openSession(UUID, String)
    case newSession(UUID)
    case insertDraft(UUID, String)
    case openHub(UUID, String?)
    case scrollToTop(UUID)
    case toggleRightPanel(UUID)
    case reconnect(UUID)
    case wakeCheck(UUID)
    case setFollowDesktop(UUID, Bool)

    var id: UUID {
        switch self {
        case .toggleSidebar(let id),
             .openSession(let id, _),
             .newSession(let id),
             .insertDraft(let id, _),
             .openHub(let id, _),
             .scrollToTop(let id),
             .toggleRightPanel(let id),
             .reconnect(let id),
             .wakeCheck(let id),
             .setFollowDesktop(let id, _):
            return id
        }
    }
}

private final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    @MainActor weak var model: AppModel?
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sid = response.notification.request.content.userInfo["sessionId"] as? String
        if let sid, !sid.isEmpty {
            Task { @MainActor [weak self] in
                self?.model?.openNotificationSession(sid)
            }
        }
        completionHandler()
    }
}

/// Pairing, pinned-TLS reachability, network switching, and live status bridge.
/// Official DSH JavaScript owns sessions, workflows, models, plugins, approvals
/// and all application state.
@MainActor final class AppModel: ObservableObject {
    @Published private(set) var desktop: PairedDesktop?
    @Published private(set) var browser: BrowserSession?
    @Published private(set) var connecting = false
    @Published private(set) var reconnecting = false
    @Published private(set) var problem: String?
    @Published private(set) var incomingLink: String?
    @Published private(set) var showPairing = false
    @Published private(set) var savedDesktops: [PairedDesktop] = []
    @Published var reloadID = UUID()

    @Published private(set) var linkInterrupted = false
    @Published private(set) var wsHealth: WebSocketHealth = .connecting
    @Published private(set) var actionsEnabled = true
    @Published private(set) var terminalEnabled = false
    @Published private(set) var drawerOpen = false
    @Published private(set) var pageTitle = ""
    @Published private(set) var currentSessionID: String?
    @Published private(set) var desktopFocus: DesktopFocus?
    @Published private(set) var pageTheme = PageTheme(dark: nil, bgBase: "", sidebarFill: "")
    @Published private(set) var followDesktop = false
    @Published private(set) var secondaryHubBadge: String?
    @Published private(set) var taskRunning = false
    @Published private(set) var pendingApprovalsCount = 0
    @Published private(set) var notificationsEnabled = false
    @Published private(set) var lastLatencyMs: Int?
    @Published private(set) var pinging = false
    @Published private(set) var pendingCommand: WebViewCommand?

    let taskPush = TaskPushSettings()
    private var linkedTask: (desktop: String, session: String)?
    private let notificationRouter = NotificationRouter()

    private var connectionTask: Task<Void, Never>?
    private var transport: PinnedTransport?
    private var recoveryTask: Task<Void, Never>?
    private var generation = UUID()
    private let ephemeral: Bool
    private var pathMonitor: NWPathMonitor?
    private var lastNetworkSignature: String?
    private var currentOnWifi: Bool?
    private var networkChangedWhileBackgrounded = false
    private var isForeground = true
    private var bgKeepAliveTask: UIBackgroundTaskIdentifier = .invalid
    // Fixture-only observation and a deterministic expiry, without waiting out a token TTL.
    @Published private(set) var testDocumentCount = 0
    @Published private(set) var testRenewals = 0
    private var testRenewOnResume = false
    var fixtureObservation: String? {
        guard ephemeral else { return nil }
        return "doc:\(testDocumentCount)|sid:\(currentSessionID ?? "")|\(wsHealth)|busy:\(reconnecting)|renew:\(testRenewals)"
    }
    private var pathAvailable = true
    private var recoveryDue: Date?
    @Published private(set) var recoveryFailures = 0
    @Published private(set) var revoked = false
    @Published private(set) var needsLaunchSelection = true
    @Published private(set) var documentRecoveryNeeded = false
    private var documentDeadline: Task<Void, Never>?
    @Published private(set) var resumeFrame: UIImage?
    private let frameQueue = DispatchQueue(label: "app.dshmobile.snapshot", qos: .utility)
    private var frameGeneration = UUID()
    private func frameURL(_ id: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("dsh-resume-v2-" + BrowserSession.dataStoreID(for: id).uuidString + ".json")
    }

    private func loadSavedTheme(for id: String) -> PageTheme {
        guard !ephemeral else { return PageTheme(dark: nil, bgBase: "", sidebarFill: "") }
        let defaults = UserDefaults.standard
        let key = "dsh.theme." + id
        let bg = defaults.string(forKey: key + ".bg") ?? ""
        let sidebar = defaults.string(forKey: key + ".sidebar") ?? ""
        let darkObj = defaults.object(forKey: key + ".dark") as? Bool
        return PageTheme(dark: darkObj, bgBase: bg, sidebarFill: sidebar)
    }

    private func saveTheme(_ theme: PageTheme, for id: String) {
        guard !ephemeral else { return }
        let defaults = UserDefaults.standard
        let key = "dsh.theme." + id
        if let dark = theme.dark { defaults.set(dark, forKey: key + ".dark") }
        if !theme.bgBase.isEmpty { defaults.set(theme.bgBase, forKey: key + ".bg") }
        if !theme.sidebarFill.isEmpty { defaults.set(theme.sidebarFill, forKey: key + ".sidebar") }
    }

    private func loadCachedRoute(for id: String) -> CachedBrowserRoute? {
        guard !ephemeral, let data = UserDefaults.standard.data(forKey: "dsh.lastRoute." + id) else { return nil }
        return try? JSONDecoder().decode(CachedBrowserRoute.self, from: data)
    }

    private func saveCachedRoute(_ session: BrowserSession) {
        guard !ephemeral, !session.isOptimistic else { return }
        let route = CachedBrowserRoute(
            endpoint: session.endpoint,
            expiresAt: session.expiresAt,
            actions: session.actions,
            terminal: session.terminal,
            appVersion: session.appVersion,
            wakeEndpoints: session.wakeEndpoints
        )
        if let data = try? JSONEncoder().encode(route) {
            UserDefaults.standard.set(data, forKey: "dsh.lastRoute." + session.desktopID)
        }
    }

    private func clearCachedRoute(for id: String) {
        guard !ephemeral else { return }
        UserDefaults.standard.removeObject(forKey: "dsh.lastRoute." + id)
    }

    private func endBackgroundKeepAlive() {
        guard bgKeepAliveTask != .invalid else { return }
        let id = bgKeepAliveTask
        bgKeepAliveTask = .invalid
        UIApplication.shared.endBackgroundTask(id)
    }

    private func syncIdleTimer() {
        guard !ephemeral else { return }
        let shouldKeepAwake = isForeground && taskRunning && browser != nil
        if UIApplication.shared.isIdleTimerDisabled != shouldKeepAwake {
            UIApplication.shared.isIdleTimerDisabled = shouldKeepAwake
        }
    }

    private func performHaptic(_ raw: String) {
        guard !ephemeral, isForeground else { return }
        switch raw.lowercased() {
        case "medium":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy":
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "soft":
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case "rigid":
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        case "selection":
            UISelectionFeedbackGenerator().selectionChanged()
        case "success":
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning":
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        default:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    /// Reject solid blank frames (e.g. a white/unpainted WebView before DSH finishes rendering)
    /// so we never overwrite a real historical snapshot with an empty screen.
    nonisolated private static func isBlankFrame(_ image: UIImage) -> Bool {
        guard let cg = image.cgImage else { return true }
        let w = 8, h = 8
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(
            data: &pixels,
            width: w,
            height: h,
            bitsPerComponent: 8,
            bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        ctx.interpolationQuality = .low
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var minR: UInt8 = 255, maxR: UInt8 = 0
        var minG: UInt8 = 255, maxG: UInt8 = 0
        var minB: UInt8 = 255, maxB: UInt8 = 0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
            if r < minR { minR = r }; if r > maxR { maxR = r }
            if g < minG { minG = g }; if g > maxG { maxG = g }
            if b < minB { minB = b }; if b > maxB { maxB = b }
        }
        return Int(maxR - minR) < 6 && Int(maxG - minG) < 6 && Int(maxB - minB) < 6
    }

    func captureFrame(_ image: UIImage, for id: String, sessionID: String) {
        guard desktop?.id == id, currentSessionID == sessionID, !revoked, !needsLaunchSelection else { return }
        let url = frameURL(id)
        let capturedTheme = pageTheme.dark == nil ? nil : pageTheme
        let shouldPersist = !ephemeral
        let generation = UUID()
        frameGeneration = generation
        // Serial encoding prevents an older slow capture overwriting a newer one.
        // Session identity and pixels are persisted atomically in the same record.
        frameQueue.async { [weak self] in
            guard !AppModel.isBlankFrame(image) else { return }
            if shouldPersist, let data = image.jpegData(compressionQuality: 0.78) {
                let saved = ResumeSnapshot(sessionID: sessionID, capturedAt: Date(), jpeg: data, theme: capturedTheme)
                if let record = try? JSONEncoder().encode(saved) {
                    try? record.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                }
            }
            Task { @MainActor [weak self] in
                guard let self, self.desktop?.id == id, self.currentSessionID == sessionID,
                      self.frameGeneration == generation, !self.revoked, !self.needsLaunchSelection else { return }
                self.resumeFrame = image
            }
        }
    }
    private func discardFrame(_ id: String) {
        frameGeneration = UUID()
        resumeFrame = nil
        let url = frameURL(id)
        if !ephemeral { frameQueue.async { try? FileManager.default.removeItem(at: url) } }
    }
    var launchRoute: [String: String] {
        var route: [String: String]
        if let id = currentSessionID {
            route = ["mode": "resume", "resume": id]
        } else {
            route = ["mode": needsLaunchSelection ? "new" : "keep"]
        }
        if let dark = pageTheme.dark {
            route["surface"] = dark ? "dark" : "light"
        }
        if !pageTheme.bgBase.isEmpty {
            route["bg"] = pageTheme.bgBase
        }
        return route
    }

    private static let followKey = "dsh.mobile.followDesktop"
    private static let notificationsKey = "dsh.mobile.taskNotifications"

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let fixture = environment["DSH_DEMO_LINK"] ?? ""
        ephemeral = !fixture.isEmpty || environment["DSH_UI_TEST"] == "1"
        followDesktop = ephemeral ? false : UserDefaults.standard.bool(forKey: Self.followKey)
        notificationsEnabled = ephemeral ? false : UserDefaults.standard.bool(forKey: Self.notificationsKey)
        savedDesktops = ephemeral ? [] : SecureStore.desktops()
        if !ephemeral {
            notificationRouter.model = self
            UNUserNotificationCenter.current().delegate = notificationRouter
            startNetworkMonitor()
        }
        if let first = savedDesktops.first {
            loadFamily(first)
            let defaults = UserDefaults.standard
            let lastView = defaults.string(forKey: "dsh.family.view." + first.id)
            let lastDevice = defaults.string(forKey: "dsh.family.device." + first.id)
            let view = cloudHost.flatMap { $0.id == lastView ? $0 : nil } ?? first
            selectedDevice = cloudHost.flatMap { $0.id == lastDevice ? $0 : nil } ?? first
            activate(view, transport: PinnedTransport(fingerprint: view.fingerprint))
        } else if !fixture.isEmpty {
            Task { [weak self] in
                do { try await self?.pair(link: fixture) }
                catch { self?.problem = error.localizedDescription }
            }
        }
    }

    deinit {
        transport?.invalidate()
        pathMonitor?.cancel()
        if !ephemeral {
            Task { @MainActor in UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    func pair(link: String) async throws {
        let offer = try PairingOffer(link: link)
        let channel = PinnedTransport(fingerprint: offer.fingerprint)
        do {
            let paired = try await PairingFlow.pair(offer: offer, transport: channel)
            var all = savedDesktops.filter { $0.id != paired.id }
            all.insert(paired, at: 0)
            if !ephemeral { try SecureStore.saveDesktops(all) }
            savedDesktops = all
            if !ephemeral { try SecureStore.write("cloud." + paired.id, nil) }
            // Reuse the pinned connection from hello/pair for the WebView bootstrap.
            use(paired, transport: channel)
        } catch { channel.invalidate(); throw error }
    }

    @Published private(set) var cloudHost: PairedDesktop?
    @Published private(set) var selectedDevice: PairedDesktop?
    @Published var showDeviceDrawer = false
    @Published private(set) var deviceIssue: String?
    @Published private(set) var switchingDevice = false
    @Published private(set) var offerCloud = false
    private var offeredThisOutage = false
    private var offlineAttempts = 0
    private var familyID: String?
    private var switchTask: Task<Void, Never>?
    private var controlWatch: Task<Void, Never>?
    private var grantTask: Task<Void, Never>?
    private var switchID = UUID()
    var localHost: PairedDesktop? { savedDesktops.first { $0.id == familyID } }

    private func loadFamily(_ primary: PairedDesktop) {
        familyID = primary.id
        cloudHost = SecureStore.read("cloud." + primary.id).flatMap { try? JSONDecoder().decode(PairedDesktop.self, from: $0) }
    }

    private func refreshGrant(_ primary: PairedDesktop, endpoint: Endpoint, using transport: PinnedTransport) {
        guard primary.id == familyID, !ephemeral, grantTask == nil else { return }
        grantTask = Task { [weak self] in
            guard let self else { return }
            defer { if !Task.isCancelled { self.grantTask = nil } }
            do {
                let cloud = try await LinkClient(transport: transport, base: endpoint.baseURL, token: primary.token).familyCloud(for: primary.id)
                guard !Task.isCancelled, self.familyID == primary.id else { return }
                try SecureStore.write("cloud." + primary.id, try cloud.map { try JSONEncoder().encode($0) })
                self.cloudHost = cloud
            } catch { /* Keep the last pinned grant on transient network errors. */ }
        }
    }

    func dismissCloudOffer() { offerCloud = false }

    // Route selection is independent from the conversation's executor. In particular
    // a cloud-backed turn must not lose its WKWebView, socket, approvals or scroll position.
    func chooseDevice(_ target: PairedDesktop, openWorkspace: Bool = false) {
        guard let owner = familyID, [localHost?.id, cloudHost?.id].contains(target.id) else { return }
        switchTask?.cancel()
        let ticket = UUID(); switchID = ticket
        offerCloud = false; deviceIssue = nil
        if desktop?.id == target.id, !linkInterrupted, wsHealth == .connected {
            selectedDevice = target; persistSelection(); watchSelectedDevice()
            switchingDevice = false; showDeviceDrawer = false
            return
        }
        switchingDevice = true
        switchTask = Task { [weak self] in
            let channel = PinnedTransport(fingerprint: target.fingerprint)
            var adopted = false
            defer { if !adopted { channel.invalidate() } }
            do {
                let ready = try await BrowserConnector.connect(target, keeping: nil, transport: channel)
                guard let self, !Task.isCancelled, self.switchID == ticket, self.familyID == owner else { return }
                self.switchingDevice = false; self.showDeviceDrawer = false
                var chosen = target; chosen.preferred = ready.endpoint
                self.selectedDevice = chosen
                if self.taskRunning && self.wsHealth == .connected && !openWorkspace {
                    self.persistSelection(); self.watchSelectedDevice()
                    return
                }
                adopted = true
                self.activate(chosen, transport: channel, ready: ready, sharedSessionID: self.currentSessionID)
            } catch {
                guard let self, !Task.isCancelled, self.switchID == ticket else { return }
                self.switchingDevice = false
                self.deviceIssue = "未切换到" + target.name + "：" + error.localizedDescription
                self.showDeviceDrawer = true
            }
        }
    }

    private func persistSelection() {
        guard !ephemeral, let familyID else { return }
        UserDefaults.standard.set(desktop?.id, forKey: "dsh.family.view." + familyID)
        UserDefaults.standard.set(selectedDevice?.id, forKey: "dsh.family.device." + familyID)
    }

    private func watchSelectedDevice() {
        controlWatch?.cancel(); controlWatch = nil
        guard let selected = selectedDevice, let endpoint = selected.preferred,
              selected.id != desktop?.id else { return }
        controlWatch = Task { [weak self] in
            let channel = PinnedTransport(fingerprint: selected.fingerprint)
            defer { channel.invalidate() }
            let link = LinkClient(transport: channel, base: endpoint.baseURL, token: selected.token)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                guard let self, self.selectedDevice?.id == selected.id else { return }
                if !self.isForeground { continue }
                do { _ = try await link.checkSession() }
                catch {
                    guard !Task.isCancelled, self.selectedDevice?.id == selected.id else { return }
                    // Drop the unreachable control connection. Do not submit, cancel, or replay a turn.
                    self.selectedDevice = self.desktop; self.persistSelection()
                    return
                }
            }
        }
    }

    func use(_ selected: PairedDesktop) {
        loadFamily(selected); selectedDevice = selected
        activate(selected, transport: PinnedTransport(fingerprint: selected.fingerprint))
    }

    private func use(_ selected: PairedDesktop, transport channel: PinnedTransport) {
        loadFamily(selected); selectedDevice = selected
        activate(selected, transport: channel)
    }

    private func activate(_ selected: PairedDesktop, transport channel: PinnedTransport, ready: BrowserSession? = nil, sharedSessionID: String? = nil) {
        controlWatch?.cancel(); grantTask?.cancel(); grantTask = nil
        connectionTask?.cancel(); recoveryTask?.cancel(); generation = UUID(); frameGeneration = UUID()
        switchTask?.cancel(); switchID = UUID(); switchingDevice = false
        offlineAttempts = 0; offeredThisOutage = false; offerCloud = false; deviceIssue = nil
        pendingCommand = nil
        transport?.invalidate()
        transport = channel
        cancelDocumentDeadline()
        needsLaunchSelection = true; recoveryFailures = 0; revoked = false
        desktop = selected
        if !ephemeral { taskPush.bind(selected,channel) }
        currentSessionID = ephemeral ? nil : (sharedSessionID ?? UserDefaults.standard.string(forKey: "dsh.lastSession." + selected.id))
        persistSelection(); watchSelectedDevice()
        pageTheme = loadSavedTheme(for: selected.id)
        if !ephemeral, let data = try? Data(contentsOf: frameURL(selected.id)),
           let saved = try? JSONDecoder().decode(ResumeSnapshot.self, from: data),
           saved.sessionID == currentSessionID, Date().timeIntervalSince(saved.capturedAt) < 86400,
           let savedImg = UIImage(data: saved.jpeg), !Self.isBlankFrame(savedImg) {
            pageTheme = saved.theme ?? pageTheme.matchingLegacyFrame(savedImg)
            resumeFrame = savedImg
        } else {
            resumeFrame = nil
        }
        linkInterrupted = false
        wsHealth = .connecting
        drawerOpen = false
        secondaryHubBadge = nil
        taskRunning = false
        pendingApprovalsCount = 0
        lastLatencyMs = nil
        syncIdleTimer()
        pageTitle = ""
        desktopFocus = nil
        // Zero-wait optimistic cold boot: instantiate WKWebView immediately at t=0 using the
        // persisted HttpOnly cookie in WKWebsiteDataStore while refreshing/racing in parallel.
        if let ready {
            self.browser = ready; self.actionsEnabled = ready.actions; self.terminalEnabled = ready.terminal
            self.connecting = false; self.reconnecting = false; self.problem = nil
            self.connectionTask = nil; self.recoveryTask = nil
            saveCachedRoute(ready)
            if !ephemeral { taskPush.connected(ready.endpoint) }
            refreshGrant(selected, endpoint: ready.endpoint, using: channel)
            return
        }
        if let cached = loadCachedRoute(for: selected.id),
           cached.expiresAt.timeIntervalSinceNow > 120,
           selected.candidates.contains(cached.endpoint) {
            actionsEnabled = cached.actions
            terminalEnabled = cached.terminal
            browser = BrowserSession(
                endpoint: cached.endpoint,
                url: cached.endpoint.baseURL,
                fingerprint: selected.fingerprint,
                cookies: [],
                expiresAt: cached.expiresAt,
                desktopID: selected.id,
                actions: cached.actions,
                terminal: cached.terminal,
                appVersion: cached.appVersion,
                wakeEndpoints: cached.wakeEndpoints,
                isOptimistic: true
            )
            beginConnection(preservePage: true, reusePage: false)
        } else {
            browser = nil
            beginConnection(preservePage: false)
        }
    }

    func presentPairing(_ link: String? = nil) {
        incomingLink = link
        showPairing = true
    }

    func closePairing() { incomingLink = nil; showPairing = false }

    func retryNow() {
        beginConnection(preservePage: browser != nil, reusePage: true, userRetry: true)
    }

    func launchDesktopNow() {
        guard !(desktop?.wakeEndpoints ?? []).isEmpty else { return }
        beginConnection(preservePage: browser != nil, wakeFirst: true)
    }

    func forceSwitchEndpoint() {
        beginConnection(preservePage: false)
    }

    func reloadPage() {
        if browser == nil { beginConnection(preservePage: false) }
        else {
            cancelDocumentDeadline()
            needsLaunchSelection = true
            reloadID = UUID(); problem = nil; wsHealth = .connecting
        }
    }

    func toggleSidebar() {
        guard browser != nil else { return }
        performHaptic("light")
        pendingCommand = .toggleSidebar(UUID())
    }

    func startNewSession() {
        guard browser != nil, actionsEnabled else { return }
        performHaptic("light")
        pendingCommand = .newSession(UUID())
    }

    func insertDraft(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard browser != nil, actionsEnabled, !trimmed.isEmpty else { return }
        performHaptic("light")
        pendingCommand = .insertDraft(UUID(), trimmed)
    }

    func openHub(_ tab: String? = nil) {
        guard browser != nil else { return }
        performHaptic("light")
        pendingCommand = .openHub(UUID(), tab)
    }

    func scrollToTop() {
        guard browser != nil else { return }
        performHaptic("light")
        pendingCommand = .scrollToTop(UUID())
    }

    func toggleRightPanel() {
        guard browser != nil else { return }
        performHaptic("light")
        pendingCommand = .toggleRightPanel(UUID())
    }

    func openTaskURL(_ url: URL) {
        let parts=url.path.split(separator:"/").map(String.init)
        let hosts = savedDesktops + [cloudHost].compactMap { $0 }
        guard parts.count==2, let known=hosts.first(where:{$0.id==parts[0]}),
              parts[1].range(of:"^[a-zA-Z0-9_-]{1,128}$",options:.regularExpression) != nil else{return}
        if desktop?.id != known.id {
            if known.id == cloudHost?.id { selectedDevice = known; activate(known, transport: PinnedTransport(fingerprint: known.fingerprint)) }
            else { use(known) }
        }
        linkedTask=(known.id,parts[1]);openNotificationSession(parts[1]);if browser != nil && !needsLaunchSelection {linkedTask=nil}
    }

    func openNotificationSession(_ sessionId: String) {
        guard !sessionId.isEmpty else { return }
        if browser != nil {
            pendingCommand = .openSession(UUID(), sessionId)
        } else {
            currentSessionID = sessionId
            if !ephemeral, let id = desktop?.id {
                UserDefaults.standard.set(sessionId, forKey: "dsh.lastSession." + id)
            }
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        guard !ephemeral else { return }
        if !enabled {
            notificationsEnabled = false
            UserDefaults.standard.set(false, forKey: Self.notificationsKey)
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            self.notificationsEnabled = granted
            UserDefaults.standard.set(granted, forKey: Self.notificationsKey)
        }
    }

    func measureLatencyNow() {
        guard let session = browser, let transport, !pinging else { return }
        pinging = true
        Task { @MainActor [weak self] in
            defer { self?.pinging = false }
            let start = ContinuousClock.now
            var req = URLRequest(
                url: session.endpoint.baseURL.appendingPathComponent("mobile/v1/ping"),
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 4
            )
            for (k, v) in HTTPCookie.requestHeaderFields(with: session.cookies) {
                req.setValue(v, forHTTPHeaderField: k)
            }
            if let token = self?.desktop?.token {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            guard let (_, response) = try? await transport.session.data(for: req),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let elapsed = start.duration(to: .now)
            let ms = max(1, Int(elapsed.components.seconds) * 1000 + Int(elapsed.components.attoseconds / 1_000_000_000_000_000))
            self?.lastLatencyMs = ms
            self?.performHaptic("selection")
        }
    }

    private func deliverTaskNotification(kind: String, sessionId: String?, title: String) {
        guard !ephemeral, !isForeground, notificationsEnabled, !taskPush.bark else { return }
        let content = UNMutableNotificationContent()
        content.title = kind == "approval" ? "任务需要确认审批" : "DSH 任务已完成"
        content.body = title.isEmpty ? "点击返回查看详情" : title
        content.sound = .default
        if let sessionId, !sessionId.isEmpty {
            content.userInfo = ["sessionId": sessionId]
        }
        let req = UNNotificationRequest(
            identifier: "dsh.\(kind).\(sessionId ?? "global")",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    func jumpToDesktopFocus() {
        guard browser != nil, let sessionId = desktopFocus?.sessionId, !sessionId.isEmpty else { return }
        pendingCommand = .openSession(UUID(), sessionId)
    }

    func setFollowDesktop(_ enabled: Bool) {
        followDesktop = enabled
        if !ephemeral { UserDefaults.standard.set(enabled, forKey: Self.followKey) }
        if browser != nil {
            pendingCommand = .setFollowDesktop(UUID(), enabled)
        }
    }

    // Store only a confirmed selection, never a transcript or a pairing credential.
    private func remember(_ id: String?) {
        guard let desktop else { return }
        guard let id, !id.isEmpty, id != currentSessionID else { return }
        frameGeneration = UUID()
        resumeFrame = nil
        currentSessionID = id
        if !ephemeral { UserDefaults.standard.set(id, forKey: "dsh.lastSession." + desktop.id) }
    }

    private func cancelDocumentDeadline() {
        documentDeadline?.cancel()
        documentDeadline = nil
        if documentRecoveryNeeded { documentRecoveryNeeded = false }
    }

    func restoringDocument() {
        cancelDocumentDeadline()
        if !needsLaunchSelection { needsLaunchSelection = true }
        // HTTP and the socket can be ready before the target conversation paints.
        // Keep its snapshot, but never leave the user stuck behind the cover.
        var delay = 12.0
        #if DEBUG
        if ephemeral && ProcessInfo.processInfo.environment["DSH_TEST_HOLD_FIRST_LAUNCH"] == "1" { delay = 5.0 }
        #endif
        documentDeadline = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.needsLaunchSelection, self.browser != nil, !self.revoked else { return }
            self.documentRecoveryNeeded = true
        }
    }

    func pageLoaded() {
        if ephemeral { testDocumentCount += 1 }
        problem = nil
        // A loaded HTML document does not prove that the Harness stream is usable.
    }

    func pageFailed(_ text: String) {
        // Ignore stale failures from an optimistic cold-boot endpoint while parallel failover is already in flight.
        if connectionTask != nil && browser?.isOptimistic == true { return }
        linkInterrupted = true
        problem = text
        wsHealth = .disconnected
        scheduleRecoveryCheck(delaySeconds: 0.12, fresh: true)
    }

    func pageProcessTerminated() {
        guard desktop != nil else { return }
        // Immediately restore the last captured snapshot cover before reloading in background.
        cancelDocumentDeadline()
        needsLaunchSelection = true
        if browser != nil {
            reloadID = UUID()
            wsHealth = .connecting
        } else {
            beginConnection(preservePage: false)
        }
    }

    func pageAuthExpired() {
        guard desktop != nil, connectionTask == nil, !revoked else { return }
        beginConnection(preservePage: browser != nil)
    }

    func handleBridgeMessage(_ body: [String: Any]) {
        guard let type = body["type"] as? String else { return }
        switch type {
        case "launch-applied":
            cancelDocumentDeadline()
            needsLaunchSelection = false
            remember(body["sessionId"] as? String)
            if let target=linkedTask, target.desktop==desktop?.id {linkedTask=nil;openNotificationSession(target.session)}
        case "ready":
            if followDesktop {
                pendingCommand = .setFollowDesktop(UUID(), true)
            }
        case "theme":
            // Old plugins can report the light bootstrap document over a dark snapshot.
            guard !needsLaunchSelection || pageTheme.dark == nil || body["confirmed"] as? Bool == true,
                  let dark = body["dark"] as? Bool else { return }
            let bgBase = body["bgBase"] as? String ?? ""
            let sidebarFill = body["sidebarFill"] as? String ?? ""
            guard let surface = PageTheme.parseColor(bgBase), surface.cgColor.alpha == 1 else { return }
            let next = PageTheme(dark: dark, bgBase: bgBase, sidebarFill: sidebarFill)
            pageTheme = next
            if let id = desktop?.id { saveTheme(next, for: id) }
        case "ws":
            let raw = (body["state"] as? String ?? "").lowercased()
            switch raw {
            case "connected":
                if linkInterrupted { linkInterrupted = false }
                wsHealth = .connected
                problem = nil
                reconnecting = false
                recoveryTask?.cancel(); recoveryTask = nil; recoveryFailures = 0
            case "connecting":
                if wsHealth == .connected { linkInterrupted = true }
                wsHealth = .connecting
                scheduleRecoveryCheck(delaySeconds: 3.0, fresh: true)
            default:
                if !linkInterrupted { linkInterrupted = true }
                wsHealth = .disconnected
                scheduleRecoveryCheck(delaySeconds: 0.05)
            }
        case "secondary-hub":
            secondaryHubBadge = body["visible"] as? Bool == true ? (body["badge"] as? String ?? "") : nil
        case "ui":
            if let open = body["drawerOpen"] as? Bool { drawerOpen = open }
            if let title = body["title"] as? String { pageTitle = title }
            if let pending = body["pendingCount"] as? Int, pendingApprovalsCount != pending {
                pendingApprovalsCount = pending
            }
            if let running = body["taskRunning"] as? Bool, taskRunning != running {
                taskRunning = running
                syncIdleTimer()
            }
            if !needsLaunchSelection {
                remember(body["currentSessionId"] as? String)
            }
        case "task-event":
            let kind = body["kind"] as? String ?? ""
            let sid = body["sessionId"] as? String
            let title = body["title"] as? String ?? ""
            deliverTaskNotification(kind: kind, sessionId: sid, title: title)
        case "haptic":
            performHaptic(body["style"] as? String ?? "light")
        case "sync":
            if let actions = body["actions"] as? Bool { actionsEnabled = actions }
            if let terminal = body["terminal"] as? Bool { terminalEnabled = terminal }
            if let focus = body["desktopFocus"] as? [String: Any],
               let sid = focus["sessionId"] as? String, !sid.isEmpty {
                let title = focus["title"] as? String ?? ""
                desktopFocus = DesktopFocus(sessionId: sid, title: title)
            } else {
                desktopFocus = nil
            }
        case "auth-expired":
            pageAuthExpired()
        default:
            break
        }
    }

    func removeCurrent() {
        guard let current = desktop else { return }
        if !ephemeral, let endpoint=browser?.endpoint ?? current.preferred ?? current.endpoints.first {
            let channel=PinnedTransport(fingerprint:current.fingerprint)
            Task {await LinkClient(transport:channel,base:endpoint.baseURL,token:current.token).unpair();channel.invalidate()}
        }
        cancelDocumentDeadline()
        endBackgroundKeepAlive()
        discardFrame(current.id)
        clearCachedRoute(for: current.id)
        connectionTask?.cancel(); connectionTask = nil
        recoveryTask?.cancel()
        generation = UUID()
        browser = nil
        UserDefaults.standard.removeObject(forKey:"dsh.island."+current.id)
        taskPush.bind(nil,nil)
        desktop = nil
        linkInterrupted = false
        transport?.invalidate(); transport = nil
        problem = nil
        reconnecting = false
        connecting = false
        secondaryHubBadge = nil
        taskRunning = false
        pendingApprovalsCount = 0
        lastLatencyMs = nil
        syncIdleTimer()
        desktopFocus = nil
        let dataStore = WKWebsiteDataStore(forIdentifier: BrowserSession.dataStoreID(for: current.id))
        dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        if !ephemeral {
            UserDefaults.standard.removeObject(forKey: "dsh.lastSession." + current.id)
            UserDefaults.standard.removeObject(forKey: "dsh.theme." + current.id + ".dark")
            UserDefaults.standard.removeObject(forKey: "dsh.theme." + current.id + ".bg")
            UserDefaults.standard.removeObject(forKey: "dsh.theme." + current.id + ".sidebar")
        }
        let owner = familyID ?? current.id
        if let cloudHost { discardFrame(cloudHost.id); clearCachedRoute(for: cloudHost.id) }
        try? SecureStore.write("cloud." + owner, nil)
        UserDefaults.standard.removeObject(forKey: "dsh.family.view." + owner)
        UserDefaults.standard.removeObject(forKey: "dsh.family.device." + owner)
        if owner != current.id, let primary = localHost, let end = primary.preferred ?? primary.candidates.first {
            let channel = PinnedTransport(fingerprint: primary.fingerprint)
            Task { await LinkClient(transport: channel, base: end.baseURL, token: primary.token).unpair(); channel.invalidate() }
        }
        discardFrame(owner); clearCachedRoute(for: owner)
        grantTask?.cancel(); switchTask?.cancel(); controlWatch?.cancel()
        switchID = UUID(); familyID = nil; cloudHost = nil; selectedDevice = nil; offerCloud = false
        let all = savedDesktops.filter { $0.id != owner }
        do {
            if !ephemeral { try SecureStore.saveDesktops(all) }
            savedDesktops = all
            if let next = all.first { use(next) }
        } catch { problem = error.localizedDescription }
    }

    func sceneChanged(_ phase: ScenePhase) {
        isForeground = (phase == .active)
        if !ephemeral {taskPush.scene(isForeground)}
        syncIdleTimer()
        guard phase == .active else {
            if phase == .background {
                if ephemeral && ProcessInfo.processInfo.environment["DSH_TEST_EXPIRY"] == "1" { testRenewOnResume = true }
                // Keep the live WebSocket alive in background during short app switches (~25s grace)
                // so quickly switching apps and returning needs zero reconnect.
                if !ephemeral, browser != nil, wsHealth == .connected, bgKeepAliveTask == .invalid {
                    bgKeepAliveTask = UIApplication.shared.beginBackgroundTask(withName: "dsh.keepalive") { [weak self] in
                        Task { @MainActor [weak self] in
                            self?.endBackgroundKeepAlive()
                        }
                    }
                }
            }
            recoveryTask?.cancel(); recoveryTask = nil
            return
        }
        endBackgroundKeepAlive()
        let roamed = networkChangedWhileBackgrounded
        networkChangedWhileBackgrounded = false
        guard desktop != nil, !revoked, pathAvailable else { return }
        if browser == nil {
            if !connecting { beginConnection(preservePage: false) }
            return
        }
        if browser?.endpoint.kind == .lan && currentOnWifi == false {
            linkInterrupted = true
            wsHealth = .connecting
            scheduleRecoveryCheck(delaySeconds: 0, fresh: true)
            return
        }
        if testRenewOnResume || (browser?.expiresAt.timeIntervalSinceNow ?? 0) < 120 {
            testRenewOnResume = false
            if connectionTask == nil { beginConnection(preservePage: true) }
            return
        }
        // Immediately wake-check the browser bridge (cancels WS backoff + triggers 1-RTT sync?poke=1)
        // when returning to foreground or after offscreen roaming so half-open NAT sockets recover at t=0.
        if wsHealth != .connected {
            pendingCommand = .wakeCheck(UUID())
            scheduleRecoveryCheck(delaySeconds: 0)
        } else if roamed || !ephemeral {
            pendingCommand = .wakeCheck(UUID())
        }
    }

    private func startNetworkMonitor() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let onWifi = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            let interfaces = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .other].filter { path.usesInterfaceType($0) }.map { "\($0)" }.joined(separator: ",")
            let available = path.status == .satisfied
            let sig = "\(path.status)|\(interfaces)"
            Task { @MainActor [weak self] in
                guard let self else { return }
                let previous = self.lastNetworkSignature
                self.lastNetworkSignature = sig
                self.pathAvailable = available
                self.currentOnWifi = available ? onWifi : nil
                guard previous != nil, previous != sig else { return }
                if !self.isForeground {
                    self.networkChangedWhileBackgrounded = true
                    return
                }
                guard self.desktop != nil else { return }
                if available {
                    // Instant Wi-Fi <-> 5G roaming failover:
                    // If currently pinned to a private LAN endpoint while off Wi-Fi (e.g. cellular),
                    // immediately switch to public/tailnet at t = 0ms instead of waiting for TCP timeout.
                    if !onWifi, self.browser?.endpoint.kind == .lan, !self.revoked {
                        self.linkInterrupted = true
                        self.wsHealth = .connecting
                        self.scheduleRecoveryCheck(delaySeconds: 0, fresh: true)
                        return
                    }
                    self.recoveryTask?.cancel(); self.recoveryTask = nil
                    self.pendingCommand = .wakeCheck(UUID())
                    if self.wsHealth != .connected { self.scheduleRecoveryCheck(delaySeconds: 0.05) }
                } else {
                    self.linkInterrupted = true
                    self.wsHealth = .disconnected
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.dshmobile.netpath"))
        pathMonitor = monitor
    }

    // One non-sliding deadline per outage: repeated socket events must not push
    // recovery into the future indefinitely. Timers have no ownership offscreen.
    private func scheduleRecoveryCheck(delaySeconds: Double, fresh: Bool = false) {
        guard isForeground, pathAvailable, !revoked, desktop != nil else { return }
        let deadline = Date().addingTimeInterval(delaySeconds)
        if recoveryTask != nil, let due = recoveryDue, due <= deadline { return }
        recoveryTask?.cancel(); recoveryDue = deadline
        recoveryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delaySeconds))
            guard !Task.isCancelled, let self, self.isForeground, self.desktop != nil else { return }
            self.recoveryTask = nil
            guard self.pathAvailable, !self.revoked, self.connectionTask == nil else { return }
            self.beginConnection(preservePage: self.browser != nil, reusePage: !fresh)
        }
    }

    /// Give the loaded page a head start, not an exclusive six-second timeout.
    private func verifyOrSwitchEndpoint() {
        guard connectionTask == nil else { return }
        beginConnection(preservePage: browser != nil, reusePage: true)
    }

    private func beginConnection(preservePage: Bool, reusePage: Bool = false, userRetry: Bool = false, wakeFirst: Bool = false) {
        guard let current = desktop, let transport else { return }
        let active = reusePage && browser?.isOptimistic != true && (browser?.expiresAt.timeIntervalSinceNow ?? 0) >= 120 ? browser : nil
        connectionTask?.cancel()
        recoveryTask?.cancel(); recoveryTask = nil
        let ticket = UUID()
        generation = ticket
        reconnecting = preservePage && browser != nil
        connecting = !reconnecting
        problem = nil
        if browser == nil { wsHealth = .connecting }
        let lanWithoutWifi = (browser?.endpoint.kind == .lan && currentOnWifi == false)
        let renewalEndpoint = preservePage && active == nil && browser?.isOptimistic != true && !lanWithoutWifi ? browser?.endpoint : nil
        connectionTask = Task { [weak self] in
            defer { if self?.generation == ticket { self?.connectionTask = nil } }
            do {
                let ready: BrowserSession
                if wakeFirst {
                    ready = try await BrowserConnector.launchAndConnect(current, transport: transport)
                } else {
                    do { ready = try await BrowserConnector.connect(current, keeping: active, transport: transport, renewing: renewalEndpoint) }
                    catch LinkError.unreachable where userRetry && !(current.wakeEndpoints ?? []).isEmpty {
                        ready = try await BrowserConnector.launchAndConnect(current, transport: transport)
                    }
                }
                try Task.checkCancellation()
                guard let self, self.generation == ticket else { return }
                self.saveCachedRoute(ready)
                let mergedEndpoints = Self.mergeAdvertisedEndpoints(existing: current.endpoints, advertised: ready.advertisedEndpoints)
                let endpointsChanged = mergedEndpoints != current.endpoints
                if active?.id != ready.id || endpointsChanged {
                    var updated = current
                    updated.endpoints = mergedEndpoints
                    updated.preferred = ready.endpoint
                    updated.wakeEndpoints = ready.wakeEndpoints
                    self.desktop = updated
                    if updated.id == self.familyID {
                        self.savedDesktops = [updated] + self.savedDesktops.filter { $0.id != updated.id }
                        if !self.ephemeral { try SecureStore.saveDesktops(self.savedDesktops) }
                    }
                    if self.selectedDevice?.id == updated.id { self.selectedDevice = updated }
                    if self.browser == nil { self.wsHealth = .connecting }
                } else if self.wsHealth == .disconnected {
                    self.pendingCommand = .reconnect(UUID())
                }
                self.actionsEnabled = ready.actions
                self.terminalEnabled = ready.terminal
                if let latency = ready.latencyMs { self.lastLatencyMs = latency }
                if self.ephemeral, let previous = self.browser, previous.id != ready.id { self.testRenewals += 1 }
                if !self.ephemeral { self.taskPush.connected(ready.endpoint) }
                self.offlineAttempts = 0; self.offeredThisOutage = false; self.offerCloud = false
                self.refreshGrant(current, endpoint: ready.endpoint, using: transport)
                self.browser = ready
                self.syncIdleTimer()
                self.connecting = false
                self.reconnecting = false
                self.problem = nil
                if self.wsHealth != .connected {
                    self.scheduleRecoveryCheck(delaySeconds: active?.id == ready.id ? 1.5 : min(20, 8 + 3 * Double(self.recoveryFailures)), fresh: true)
                    self.recoveryFailures = min(8, self.recoveryFailures + 1)
                }
            } catch {
                guard !Task.isCancelled, let self, self.generation == ticket else { return }
                self.connecting = false
                self.reconnecting = false
                self.linkInterrupted = true
                self.wsHealth = .disconnected
                self.offlineAttempts = (error as? LinkError) == .unreachable ? self.offlineAttempts + 1 : 0
                if self.offlineAttempts >= 2, current.id == self.familyID, self.cloudHost != nil, !self.offeredThisOutage {
                    self.offeredThisOutage = true; self.offerCloud = true
                }
                if (error as? LinkError) == .unpaired {
                    if let owner = self.familyID { try? SecureStore.write("cloud." + owner, nil); self.cloudHost = nil }
                    self.offerCloud = false
                    self.taskPush.bind(nil,nil); self.revoked = true; self.discardFrame(current.id); self.clearCachedRoute(for: current.id); self.browser = nil
                    self.taskRunning = false; self.syncIdleTimer()
                } else {
                    let delays = [0.12, 0.35, 0.8, 1.6, 3.2, 6.0]
                    self.scheduleRecoveryCheck(delaySeconds: delays[min(self.recoveryFailures, delays.count - 1)])
                    self.recoveryFailures = min(8, self.recoveryFailures + 1)
                }
                self.problem = error.localizedDescription
            }
        }
    }
    /// Merge newly advertised desktop endpoints (e.g. a switched public relay host) while keeping LAN/tailnet first.
    private static func mergeAdvertisedEndpoints(existing: [Endpoint], advertised: [Endpoint]) -> [Endpoint] {
        guard !advertised.isEmpty else { return existing }
        var seen = Set<Endpoint>()
        let merged = (advertised + existing).filter { seen.insert($0).inserted }
        let rank: [Endpoint.Kind: Int] = [.lan: 0, .tailnet: 1, .other: 2, .loopback: 3]
        return Array(merged.enumerated().sorted {
            (rank[$0.element.kind] ?? 3, $0.offset) < (rank[$1.element.kind] ?? 3, $1.offset)
        }.map(\.element).prefix(8))
    }
}

private struct CachedBrowserRoute: Codable, Sendable {
    let endpoint: Endpoint
    let expiresAt: Date
    let actions: Bool
    let terminal: Bool
    let appVersion: String
    let wakeEndpoints: [Endpoint]
}

/// HttpOnly cookies never enter JavaScript or a URL.
struct BrowserSession: Identifiable {
    let id = UUID()
    let endpoint: Endpoint
    let url: URL
    let fingerprint: String
    let cookies: [HTTPCookie]
    let expiresAt: Date
    let desktopID: String
    var actions: Bool
    var terminal: Bool
    let appVersion: String
    let wakeEndpoints: [Endpoint]
    var isOptimistic: Bool = false
    var latencyMs: Int? = nil
    var advertisedEndpoints: [Endpoint] = []

    static func dataStoreID(for desktopID: String) -> UUID {
        let bytes = Array(SHA256.hash(data: Data(desktopID.utf8)).prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
}

enum BrowserConnector {
    private struct Bootstrap: Decodable {
        struct Desktop: Decodable { let id: String }
        let url: String
        let desktop: Desktop
        let expiresAt: Double
        let actions: Bool?
        let terminal: Bool?
        let app: String?
        let endpoints: [String]?
        struct Wake: Decodable { let port: Int; let publicPort: Int? }
        let wake: Wake?
    }

    private enum Attempt: @unchecked Sendable {
        case success(BrowserSession)
        case failure(String, unpaired: Bool, network: Bool, starting: Bool)
    }

    /// Only the user's launch/retry action is allowed to wake the desktop.
    static func launchAndConnect(_ desktop: PairedDesktop, transport: PinnedTransport) async throws -> BrowserSession {
        try Task.checkCancellation()
        try await wake(desktop, transport: transport)
        let deadline = ContinuousClock.now.advanced(by: .seconds(22))
        for delay in [250, 400, 650, 1000, 1500, 2000, 2500, 3000] {
            try await Task.sleep(for: .milliseconds(delay))
            guard ContinuousClock.now < deadline else { break }
            do { return try await connect(desktop, keeping: nil, transport: transport, timeout: 2.5) }
            catch LinkError.unreachable { continue }
            catch LinkError.http(503) { continue }
        }
        throw ClientError.message("已请求电脑启动 DSH，但连接插件尚未就绪。请稍后重试。")
    }

    /// Only an explicit Retry can reach this method, never background recovery.
    static func wake(_ desktop: PairedDesktop, transport: PinnedTransport) async throws {
        let accepted = await withTaskGroup(of: Bool.self) { group in
            for endpoint in desktop.wakeEndpoints ?? [] {
                group.addTask {
                    var req = URLRequest(url: endpoint.baseURL.appendingPathComponent("mobile/v1/wake"), timeoutInterval: 3)
                    req.httpMethod = "POST"
                    req.setValue("Bearer \(desktop.token)", forHTTPHeaderField: "Authorization")
                    guard !Task.isCancelled, let (_, response) = try? await transport.session.data(for: req) else { return false }
                    return (response as? HTTPURLResponse)?.statusCode == 202
                }
            }
            for await ok in group where ok { group.cancelAll(); return true }
            return false
        }
        if !accepted { throw ClientError.message("未能联系电脑的 DSH 启动组件。请检查电脑是否已登录、已启用组件，以及网络或中继是否可达。") }
    }

    static func connect(_ desktop: PairedDesktop, keeping active: BrowserSession?, transport: PinnedTransport, timeout: TimeInterval = 8, renewing: Endpoint? = nil, only: Endpoint? = nil) async throws -> BrowserSession {
        // An ordinary credential refresh should not migrate a healthy page just
        // because another interface answers slightly faster. Fail over on failure.
        if let renewing {
            do { return try await connect(desktop, keeping: nil, transport: transport, timeout: 2, only: renewing) }
            catch LinkError.unpaired { throw LinkError.unpaired }
            catch { try Task.checkCancellation() }
        }
        return try await withThrowingTaskGroup(of: Attempt.self) { group in
            for (index, endpoint) in (only.map { [$0] } ?? desktop.candidates).enumerated() {
                group.addTask {
                    do {
                        let delay = EndpointTiming.delay(index: index, preservingPage: active != nil)
                        if delay > 0 { try await Task.sleep(for: .milliseconds(delay)) }
                        try Task.checkCancellation()
                        if var retained = active, endpoint == retained.endpoint {
                            // Probe the actual page credential, not the longer-lived pairing
                            // token: restarting the desktop invalidates existing web cookies.
                            let start = ContinuousClock.now
                            var probe = URLRequest(url: endpoint.baseURL.appendingPathComponent("mobile/v1/session"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: min(timeout, 4))
                            for (k,v) in HTTPCookie.requestHeaderFields(with: retained.cookies) { probe.setValue(v, forHTTPHeaderField: k) }
                            let (data, response) = try await transport.session.data(for: probe)
                            let elapsed = start.duration(to: .now)
                            let ms = max(1, Int(elapsed.components.seconds) * 1000 + Int(elapsed.components.attoseconds / 1_000_000_000_000_000))
                            if (response as? HTTPURLResponse)?.statusCode == 200 {
                                let state = try JSON.parse(data)
                                guard state["desktop"]["id"].string == desktop.id else { throw LinkError.wrongDesktop }
                                retained.actions = state["actions"].bool; retained.terminal = state["terminal"].bool
                                retained.latencyMs = ms
                                retained.advertisedEndpoints = state["endpoints"].array.compactMap { Endpoint($0.string) }
                                return .success(retained)
                            }
                            // A stale cookie alone never means unpaired. Bootstrap below.
                        }
                        let start = ContinuousClock.now
                        var request = URLRequest(url: endpoint.baseURL.appendingPathComponent("mobile/v1/web-session"),
                                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
                        request.httpMethod = "POST"
                        request.setValue("Bearer \(desktop.token)", forHTTPHeaderField: "Authorization")
                        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                        request.httpBody = Data("{}".utf8)
                        let (data, response) = try await transport.session.data(for: request)
                        let elapsed = start.duration(to: .now)
                        let latencyMs = max(1, Int(elapsed.components.seconds) * 1000 + Int(elapsed.components.attoseconds / 1_000_000_000_000_000))
                        guard let http = response as? HTTPURLResponse else { throw LinkError.badResponse }
                        if http.statusCode == 401 { throw LinkError.unpaired }
                        if http.statusCode == 403 { throw LinkError.actionsDisabled }
                        if http.statusCode == 404 {
                            throw ClientError.message("电脑连接插件需要更新到支持官方界面的 0.4.0 版本。")
                        }
                        if http.statusCode == 503 {
                            throw LinkError.http(503)
                        }
                        guard http.statusCode == 200 else { throw LinkError.http(http.statusCode) }
                        let reply = try JSONDecoder().decode(Bootstrap.self, from: data)
                        guard reply.desktop.id == desktop.id else { throw LinkError.wrongDesktop }
                        guard reply.url.hasPrefix("/"), !reply.url.hasPrefix("//"),
                              let url = URL(string: reply.url, relativeTo: endpoint.baseURL)?.absoluteURL,
                              url.scheme == "https", url.host == endpoint.baseURL.host,
                              url.port == endpoint.baseURL.port else { throw LinkError.badResponse }
                        let headers = Dictionary(uniqueKeysWithValues: http.allHeaderFields.compactMap { key, value -> (String, String)? in
                            guard let key = key as? String, let value = value as? String else { return nil }
                            return (key, value)
                        })
                        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: endpoint.baseURL)
                            .filter { $0.name == "__Host-dsh-mobile" && $0.isSecure && $0.isHTTPOnly && $0.path == "/" }
                        guard !cookies.isEmpty else { throw LinkError.badResponse }
                        let advertised = (reply.endpoints ?? []).compactMap(Endpoint.init)
                        return .success(BrowserSession(
                            endpoint: endpoint,
                            url: url,
                            fingerprint: desktop.fingerprint,
                            cookies: cookies,
                            expiresAt: Date(timeIntervalSince1970: reply.expiresAt / 1000),
                            desktopID: desktop.id,
                            actions: reply.actions ?? true,
                            terminal: reply.terminal ?? false,
                            appVersion: reply.app ?? "",
                            wakeEndpoints: Endpoint.wakeRoutes(advertised.isEmpty ? desktop.candidates : advertised, localPort: reply.wake?.port, publicPort: reply.wake?.publicPort),
                            latencyMs: latencyMs,
                            advertisedEndpoints: advertised
                        ))
                    } catch {
                        if Task.isCancelled { throw CancellationError() }
                        let offline: Set<URLError.Code> = [.notConnectedToInternet, .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed]
                        return .failure(error.localizedDescription, unpaired: (error as? LinkError) == .unpaired, network: (error as? URLError).map { offline.contains($0.code) } ?? false, starting: (error as? LinkError) == .http(503))
                    }
                }
            }
            var failures: [String] = []
            var unpaired = false, onlyNetwork = true, anyStarting = false
            for try await result in group {
                switch result {
                case .success(let session):
                    group.cancelAll()
                    return session
                case .failure(let message, let revoked, let network, let starting):
                    anyStarting = anyStarting || starting
                    onlyNetwork = onlyNetwork && network
                    failures.append(message)
                    unpaired = unpaired || revoked
                }
            }
            if unpaired { throw LinkError.unpaired }
            if anyStarting { throw LinkError.http(503) }
            if onlyNetwork { throw LinkError.unreachable }
            throw ClientError.message(failures.first ?? "没有可用的电脑地址，请重新配对。")
        }
    }
}
