import Foundation
import Combine
import Network
import DSHCore

/// One logical-stream frame from the desktop (DSH remote.mux protocol).
struct MuxFrame: Sendable {
    enum Kind: Sendable { case item(JSON), end, error(code: String, message: String) }
    let streamID: String
    let kind: Kind
}

/// Keeps one paired desktop connected: finds the address that answers, checks
/// the token, holds the WebSocket, pings it and reconnects with backoff. It
/// knows nothing about sessions; the store opens streams in `onOpen` and calls
/// `markOnline()` when the `$events` ready frame arrives.
@MainActor final class LinkSession: ObservableObject {
    enum Phase: Equatable {
        case idle
        case connecting(attempt: Int)
        case online
        case waiting(retryIn: Int, reason: String)
        case unpaired
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var endpoint: Endpoint?
    @Published private(set) var lastError: String?
    private(set) var desktop: PairedDesktop
    private(set) var canWrite = false
    private(set) var canUseTerminal = false

    var onOpen: (() async -> Void)?
    var onFrame: ((MuxFrame) -> Void)?
    /// A connection ended; data on screen is now stale until the next snapshot.
    var onClose: (() -> Void)?
    /// The preferred endpoint changed; persist the desktop.
    var onDesktopUpdate: ((PairedDesktop) -> Void)?

    private let transport: PinnedTransport
    private var socket: URLSessionWebSocketTask?
    private var supervisor: Task<Void, Never>?
    private var sleeper: Task<Void, Never>?
    private let monitor = NWPathMonitor()

    init(desktop: PairedDesktop) {
        self.desktop = desktop
        transport = PinnedTransport(fingerprint: desktop.fingerprint)
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied, let self else { return }
            Task { @MainActor in self.networkReturned() }
        }
        monitor.start(queue: DispatchQueue(label: "app.dshmobile.path"))
    }

    deinit {
        monitor.cancel()
        transport.invalidate()
    }

    var isOnline: Bool { phase == .online }

    func start() {
        guard phase != .unpaired else { return }
        if supervisor != nil { retryNow(); return }
        supervisor = Task { [weak self] in await self?.supervise() }
    }

    func stop() {
        supervisor?.cancel(); supervisor = nil
        sleeper?.cancel()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        endpoint = nil; canWrite = false
        onClose?()
        if phase != .unpaired { phase = .idle }
    }

    /// Skip the remaining backoff (pull to refresh, app became active, network back).
    func retryNow() { sleeper?.cancel() }

    /// Drop the current socket; the supervisor reconnects and every stream is reopened.
    func restart() { socket?.cancel(with: .goingAway, reason: nil) }

    func markOnline() { phase = .online; lastError = nil }

    /// Tell the desktop to forget this phone, then stop.
    func forget() async {
        if let endpoint { await LinkClient(transport: transport, base: endpoint.baseURL, token: desktop.token).unpair() }
        stop()
    }

    func send(_ value: JSON) async throws {
        guard let socket else { throw LinkError.unreachable }
        let text = String(decoding: try value.encoded(), as: UTF8.self)
        try await socket.send(.string(text))
    }

    func open(_ streamID: String, endpoint: String, args: JSON = .object([:])) async throws {
        try await send(.object(["type": .string("open"), "streamId": .string(streamID), "endpoint": .string(endpoint),
                                "payload": .object(["args": args])]))
    }

    func cancel(_ streamID: String) async {
        guard !streamID.isEmpty else { return }
        try? await send(.object(["type": .string("cancel"), "streamId": .string(streamID)]))
    }

    func rpc(_ method: String, args: JSON) async throws -> JSON {
        guard let endpoint else { throw LinkError.unreachable }
        return try await LinkClient(transport: transport, base: endpoint.baseURL, token: desktop.token).rpc(method, args: args)
    }

    func uploadFile(_ url: URL, sessionID: String) async throws -> String {
        guard let endpoint else { throw LinkError.unreachable }
        return try await LinkClient(transport: transport, base: endpoint.baseURL, token: desktop.token)
            .uploadFile(url, sessionID: sessionID)
    }

    // MARK: - Supervision

    private func networkReturned() {
        if case .waiting = phase { retryNow() }
    }

    private func supervise() async {
        var failures = 0
        while !Task.isCancelled {
            phase = .connecting(attempt: failures + 1)
            do {
                try await connectOnce()
                failures = 0
            } catch LinkError.unpaired {
                if Task.isCancelled { return }
                socket = nil; endpoint = nil
                phase = .unpaired; supervisor = nil
                onClose?()
                return
            } catch {
                if Task.isCancelled { return }
                socket = nil; endpoint = nil
                if phase == .online { failures = 0 }
                failures += 1
                canWrite = false
                onClose?()
                let message = (error as? LocalizedError)?.errorDescription ?? LinkError.unreachable.errorDescription!
                lastError = message
                let delay = Self.backoff(failures)
                phase = .waiting(retryIn: Int(delay.rounded(.up)), reason: message)
                await pause(delay)
            }
        }
    }

    /// 1, 2, 4, 8, 16, 30 s with ±20 % jitter.
    nonisolated static func backoff(_ failures: Int) -> Double {
        min(30, 0.5 * pow(2, Double(min(max(failures, 1), 6)))) * Double.random(in: 0.8...1.2)
    }

    private func pause(_ seconds: Double) async {
        let t = Task { _ = try? await Task.sleep(for: .seconds(seconds)) }
        sleeper = t
        await t.value
        sleeper = nil
    }

    private func connectOnce() async throws {
        guard let found = await EndpointRace.first(desktop.candidates, desktopID: desktop.id, transport: transport) else {
            throw LinkError.unreachable
        }
        try Task.checkCancellation()
        let client = LinkClient(transport: transport, base: found.baseURL, token: desktop.token)
        let capabilities = try await client.checkSession()
        try Task.checkCancellation()
        canWrite = capabilities.actions
        canUseTerminal = capabilities.terminal
        let task = client.webSocket()
        socket = task
        endpoint = found
        task.resume()
        if desktop.preferred != found {
            desktop.preferred = found
            onDesktopUpdate?(desktop)
        }
        await onOpen?()
        try await receive(task)
    }

    private func receive(_ task: URLSessionWebSocketTask) async throws {
        let pinger = Task { [weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let task, !Task.isCancelled else { return }
                let alive = await Self.ping(task, timeout: 10)
                if !alive { task.cancel(with: .goingAway, reason: nil); return }
            }
        }
        let handshake = Task { [weak self, weak task] in
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled, let self, self.phase != .online else { return }
            task?.cancel(with: .goingAway, reason: nil)
        }
        defer { pinger.cancel(); handshake.cancel() }
        do {
            while true {
                let message = try await task.receive()
                let data: Data
                switch message {
                case .data(let d): data = d
                case .string(let s): data = Data(s.utf8)
                @unknown default: continue
                }
                let frame = try await Self.decode(data)
                guard socket === task else { return }
                if let frame { onFrame?(frame) }
            }
        } catch {
            let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
            if task.closeCode.rawValue == 4401 || reason == "unpaired" { throw LinkError.unpaired }
            throw error
        }
    }

    /// Parsed off the main actor: a 100-message snapshot can be a few MB.
    private nonisolated static func decode(_ data: Data) async throws -> MuxFrame? {
        let envelope = try JSON.parse(data)
        let id = envelope["streamId"].string
        switch envelope["type"].string {
        case "item": return MuxFrame(streamID: id, kind: .item(envelope["value"]))
        case "end": return MuxFrame(streamID: id, kind: .end)
        case "error": return MuxFrame(streamID: id, kind: .error(code: envelope["error"]["code"].string, message: envelope["error"]["message"].string))
        default: return nil
        }
    }

    private nonisolated static func ping(_ task: URLSessionWebSocketTask, timeout: Double) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let once = Once()
            task.sendPing { error in once.run { continuation.resume(returning: error == nil) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { once.run { continuation.resume(returning: false) } }
        }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ body: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true; body()
    }
}
