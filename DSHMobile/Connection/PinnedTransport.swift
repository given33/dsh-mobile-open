import Foundation
import CryptoKit
import Security
import DSHCore

/// URLSession whose TLS trust is exactly one public key: the SHA-256 of the
/// desktop's SubjectPublicKeyInfo carried in the pairing QR code. No CA, no
/// hostname check; any other key fails the handshake before a byte is sent.
final class PinnedTransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let fingerprint: String
    /// Requests: short idle timeout.
    private(set) var session: URLSession!
    /// The long-lived WebSocket. `timeoutIntervalForRequest` is an idle timer for
    /// WebSocket tasks too, so it is long here; liveness comes from our own pings.
    private(set) var streams: URLSession!
    private var operations: URLSession!

    /// Both sessions are created here, before the object is shared, so
    /// concurrent readers never race a lazy initializer. URLSession retains its
    /// delegate: call `invalidate()` when this transport is no longer used.
    init(fingerprint: String) {
        self.fingerprint = fingerprint
        super.init()
        session = makeSession(idleTimeout: 15)
        streams = makeSession(idleTimeout: 24 * 3600)
        operations = makeSession(idleTimeout: 600)
    }

    func invalidate() { session.invalidateAndCancel(); streams.invalidateAndCancel(); operations.invalidateAndCancel() }

    private func makeSession(idleTimeout: TimeInterval) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = idleTimeout
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.waitsForConnectivity = false
        config.allowsCellularAccess = true
        config.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        if PinnedTransport.spkiFingerprint(of: trust) == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func rpcSession(long: Bool) -> URLSession { long ? operations : session }

    /// base64url SHA-256 of the leaf certificate's P-256 SubjectPublicKeyInfo.
    static func spkiFingerprint(of trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let key = SecCertificateCopyKey(leaf),
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let spki = Fingerprint.p256SPKI(rawPoint: Array(raw)) else { return nil }
        return Fingerprint.encode(Array(SHA256.hash(data: Data(spki))))
    }
}

enum LinkError: LocalizedError, Equatable {
    case unreachable, wrongDesktop, unpaired, codeRejected(String), rateLimited, actionsDisabled, http(Int), badResponse
    case pairingUnreachable(hasPublicAddress: Bool, networkCode: Int?)

    var errorDescription: String? {
        switch self {
        case .unreachable: return "连不上这台电脑。请确认电脑上的 DSH 正在运行，然后重试。"
        case .pairingUnreachable(let hasPublicAddress, let networkCode):
            if hasPublicAddress {
                let detail = networkCode.map { "（iOS 网络错误 \($0)）" } ?? ""
                return "手机未能连上配对链接里的公网入口\(detail)。请确认电脑上的 DSH 和公网中继在线，再换一个网络重试。"
            }
            return "这个配对链接没有公网地址。如果你在外网，请在电脑的「手机连接」中刷新并复制包含公网地址的链接。"
        case .wrongDesktop: return "这个地址上运行的是另一台电脑，请重新扫码。"
        case .unpaired: return "这台电脑已移除了此手机的配对，请重新扫码连接。"
        case .codeRejected(let reason):
            return reason == "code-expired" ? PairingError.expired.errorDescription : "配对码无效，请在电脑上刷新二维码后重新扫描。"
        case .rateLimited: return "尝试次数过多，请稍等一分钟再扫码。"
        case .actionsDisabled: return "请在电脑的「手机连接」中开启「允许手机操作」。"
        case .http(let code): return "电脑返回了 HTTP \(code)。"
        case .badResponse: return "电脑返回的数据无法识别，请更新电脑端的 DSH Mobile 连接组件。"
        }
    }
}

/// Talks to the desktop link server (see desktop/lib/link-server.mjs).
struct LinkClient: Sendable {
    let transport: PinnedTransport
    let base: URL
    var token: String?

    struct Hello: Decodable, Sendable { let desktop: PairResponse.Desktop; let `protocol`: Int; let fingerprint: String }

    func hello(timeout: TimeInterval = 4) async throws -> Hello {
        let (data, response) = try await transport.session.data(for: request("mobile/v1/hello", timeout: timeout))
        try check(response)
        return try JSONDecoder().decode(Hello.self, from: data)
    }

    func pair(code: String, device: DeviceInfo) async throws -> PairResponse {
        var req = request("mobile/v1/pair")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(PairRequest(code: code, device: device))
        let (data, response) = try await transport.session.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode == 403 || http.statusCode == 429 {
            let reason = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw http.statusCode == 429 ? LinkError.rateLimited : LinkError.codeRejected(reason)
        }
        try check(response)
        return try JSONDecoder().decode(PairResponse.self, from: data)
    }

    func familyCloud(for owner: String) async throws -> PairedDesktop? {
        struct Grant: Decodable { let familyID, endpoint, fingerprint: String }
        let (data, response) = try await transport.session.data(for: request("mobile/v1/cloud-route", timeout: 5))
        if (response as? HTTPURLResponse)?.statusCode == 404 { return nil }
        try check(response)
        let grant = try JSONDecoder().decode(Grant.self, from: data)
        let pair = try JSONDecoder().decode(PairResponse.self, from: data)
        guard grant.familyID == owner, pair.desktop.id != owner,
              pair.desktop.id.range(of: "^[a-zA-Z0-9_-]{8,64}$", options: .regularExpression) != nil,
              [pair.token, grant.fingerprint].allSatisfy({ $0.range(of: "^[a-zA-Z0-9_-]{43}$", options: .regularExpression) != nil }),
              let endpoint = Endpoint(grant.endpoint), endpoint.kind == .other else { throw LinkError.badResponse }
        let offer = PairingOffer(desktopID: pair.desktop.id, desktopName: "云端", endpoints: [endpoint], fingerprint: grant.fingerprint, code: "", expiresAt: nil)
        return PairedDesktop(offer: offer, response: pair, preferred: endpoint).preparedCloudGrant()
    }

    func checkSession(expectedDesktopID: String? = nil, timeout: TimeInterval = 6) async throws -> (actions: Bool, terminal: Bool) {
        let (data, response) = try await transport.session.data(for: request("mobile/v1/session", timeout: timeout))
        try check(response)
        let value = try JSON.parse(data)
        if let expectedDesktopID, value["desktop"]["id"].string != expectedDesktopID { throw LinkError.wrongDesktop }
        return (value["actions"].bool, value["terminal"].bool)
    }

    func unpair() async {
        var req = request("mobile/v1/unpair", timeout: 4); req.httpMethod = "POST"
        _ = try? await transport.session.data(for: req)
    }

    /// DSH RPC envelope over HTTPS, forwarded unchanged by the desktop.
    func rpc(_ method: String, args: JSON) async throws -> JSON {
        let long = ["pluginManager/installBundle", "pluginManager/cancelInstall", "pluginManager/inspect", "llm/discoverModels", "mobileFiles/download"].contains(method)
        var req = request("api/\(method)", timeout: long ? 600 : 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSON.object(["type": .string("client-request"), "rpcId": .string(UUID().uuidString),
                                        "method": .string(method), "payload": .object(["args": args])]).encoded()
        let (data, response) = try await transport.rpcSession(long: long).data(for: req)
        try check(response, body: data)
        let envelope = try JSON.parse(data)
        let result = envelope["result"]
        guard result["ok"].bool else {
            let message = result["error"]["message"].string
            throw ClientError.message(message.isEmpty ? "Harness 返回未知错误。" : message)
        }
        return result["value"]
    }

    func uploadFile(_ file: URL, sessionID: String) async throws -> String {
        var req = request("api/session/uploadFileBinary", timeout: 90)
        guard let url = req.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw LinkError.badResponse
        }
        parts.queryItems = [URLQueryItem(name: "sessionId", value: sessionID),
                            URLQueryItem(name: "name", value: file.lastPathComponent)]
        req.url = parts.url
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport.session.upload(for: req, fromFile: file)
        try check(response, body: data)
        let result = try JSON.parse(data)
        let receipt = result["value"]["receiptId"].string
        guard result["ok"].bool, !receipt.isEmpty else {
            let message = result["error"]["message"].string
            throw message.isEmpty ? LinkError.badResponse : ClientError.message(message)
        }
        return receipt
    }

    func webSocket() -> URLSessionWebSocketTask {
        var req = request("api/remote.mux", timeout: 24 * 3600)
        var c = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        c.scheme = "wss"; req.url = c.url
        let task = transport.streams.webSocketTask(with: req)
        task.maximumMessageSize = 64 * 1024 * 1024
        return task
    }

    private func request(_ path: String, timeout: TimeInterval = 15) -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func check(_ response: URLResponse, body: Data? = nil) throws {
        guard let http = response as? HTTPURLResponse else { throw LinkError.badResponse }
        switch http.statusCode {
        case 200...299: return
        case 401: throw LinkError.unpaired
        case 403 where body.flatMap({ try? JSON.parse($0)["error"].string }) == "actions-disabled":
            throw LinkError.actionsDisabled
        case 403 where body.flatMap({ try? JSON.parse($0)["error"].string }) == "terminal-disabled":
            throw ClientError.message("请在电脑的「手机连接」中开启「允许手机操作」和「允许手机终端」。")
        case 409 where body.flatMap({ try? JSON.parse($0)["error"].string }) == "interaction-unavailable":
            throw ClientError.message("这项请求已结束，或已由其他设备处理。")
        case 429: throw LinkError.rateLimited
        default: throw LinkError.http(http.statusCode)
        }
    }
}

/// Finds which of a desktop's addresses answers, fastest first. The preferred
/// endpoint starts immediately; the others follow at a short stagger, and the
/// first one whose /hello names the expected desktop wins.
enum EndpointRace {
    struct Result: Sendable {
        let endpoint: Endpoint?
        let publicNetworkCode: Int?
    }

    static func first(_ endpoints: [Endpoint], desktopID: String, transport: PinnedTransport) async -> Endpoint? {
        await probe(endpoints, desktopID: desktopID, transport: transport).endpoint
    }

    static func probe(_ endpoints: [Endpoint], desktopID: String, transport: PinnedTransport) async -> Result {
        let noMatch = Result(endpoint: nil, publicNetworkCode: nil)
        return await withTaskGroup(of: Result.self) { group in
            for (index, endpoint) in endpoints.enumerated() {
                group.addTask {
                    if index > 0 { try? await Task.sleep(for: .milliseconds(EndpointTiming.delay(index: index))) }
                    guard !Task.isCancelled else { return noMatch }
                    let client = LinkClient(transport: transport, base: endpoint.baseURL)
                    do {
                        let hello = try await client.hello(timeout: endpoint.kind == .other ? 10 : 4)
                        return hello.desktop.id == desktopID ? Result(endpoint: endpoint, publicNetworkCode: nil) : noMatch
                    } catch {
                        return Result(endpoint: nil, publicNetworkCode: endpoint.kind == .other ? (error as? URLError)?.errorCode : nil)
                    }
                }
            }
            var publicNetworkCode: Int?
            for await result in group {
                if result.endpoint != nil { group.cancelAll(); return result }
                if publicNetworkCode == nil { publicNetworkCode = result.publicNetworkCode }
            }
            return Result(endpoint: nil, publicNetworkCode: publicNetworkCode)
        }
    }
}
