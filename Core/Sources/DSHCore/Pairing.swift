import Foundation

/// One address the phone may try for a desktop. Direct endpoints are pinned to
/// the certificate fingerprint from the QR code; tunnel URLs use system trust.
public struct Endpoint: Codable, Hashable, Sendable {
    public let host: String
    public let port: Int
    public init(host: String, port: Int) { self.host = host; self.port = port }

    /// "192.168.1.5:3081", "[fd7a::1]:3081" or "desk.local:3081".
    public init?(_ text: String) {
        var rest = Substring(text.trimmingCharacters(in: .whitespaces))
        let host: String
        if rest.hasPrefix("[") {
            guard let close = rest.firstIndex(of: "]") else { return nil }
            host = String(rest[rest.index(after: rest.startIndex)..<close]).lowercased()
            rest = rest[rest.index(after: close)...]
            guard rest.hasPrefix(":") else { return nil }
            rest = rest.dropFirst()
            guard host.contains(":") else { return nil }
        } else {
            guard let colon = rest.lastIndex(of: ":") else { return nil }
            host = String(rest[..<colon]).lowercased()
            rest = rest[rest.index(after: colon)...]
            guard !host.contains(":") else { return nil }
        }
        guard let port = Int(rest), (1...65535).contains(port), Endpoint.validHost(host) else { return nil }
        self.host = host; self.port = port
    }

    /// Text form used in links and logs.
    public var authority: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }

    /// Base URL for HTTPS requests. IPv6 literals are bracketed.
    public var baseURL: URL { URL(string: "https://\(authority)/")! }

    static func validHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.count <= 253 else { return false }
        if host.contains(":") {
            return host.allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." }
        }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-.")
        return host.unicodeScalars.allSatisfy(allowed.contains) && !host.hasPrefix(".") && !host.hasPrefix("-")
    }

    /// Rough network class, used to try LAN addresses before VPN ones and to label them.
    public var kind: Kind {
        if host == "localhost" || host.hasPrefix("127.") || host == "::1" { return .loopback }
        if host.hasSuffix(".local") { return .lan }
        if host.hasSuffix(".ts.net") { return .tailnet }
        if host.contains(":") {
            let lower = host.lowercased()
            if lower.hasPrefix("fd7a:115c:a1e0:") { return .tailnet }
            if lower.hasPrefix("fe80:") || lower.hasPrefix("fc") || lower.hasPrefix("fd") { return .lan }
            return .other
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let v4 = parts.compactMap { UInt8($0) }
        guard parts.count == 4, v4.count == 4 else { return .other }
        let a = Int(v4[0]), b = Int(v4[1])
        if a == 10 || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 172 && (16...31).contains(b)) { return .lan }
        if a == 100 && (64...127).contains(b) { return .tailnet }
        return .other
    }

    /// Keep the paired host; only a separately configured public relay can be used for wake.
    public static func wakeRoutes(_ candidates: [Endpoint], localPort: Int?, publicPort: Int?) -> [Endpoint] {
        guard let localPort, (1024...65535).contains(localPort) else { return [] }
        var result = [Endpoint]()
        for candidate in candidates {
            guard let port = (candidate.kind == .other ? publicPort : localPort), (1...65535).contains(port) else { continue }
            let route = Endpoint(host: candidate.host, port: port)
            if !result.contains(route) { result.append(route) }
        }
        return result
    }

    public enum Kind: String, Codable, Sendable { case lan, tailnet, loopback, other }
}

/// What the desktop pairing QR code carries.
///
/// `dshmobile://pair?v=1&id=<desktop id>&n=<name>&fp=<sha256 base64url>&c=<one-time code>&e=<unix expiry>&h=<host:port>&h=…[&u=<https tunnel url>]`
public struct PairingOffer: Equatable, Sendable {
    public static let version = 1
    public let desktopID: String
    public let desktopName: String
    public let endpoints: [Endpoint]
    public let tunnels: [URL]
    public let fingerprint: String
    public let code: String
    public let expiresAt: Date?

    public init(desktopID: String, desktopName: String, endpoints: [Endpoint], tunnels: [URL] = [], fingerprint: String, code: String, expiresAt: Date?) {
        self.desktopID = desktopID; self.desktopName = desktopName; self.endpoints = endpoints
        self.tunnels = tunnels; self.fingerprint = fingerprint; self.code = code; self.expiresAt = expiresAt
    }

    public init(link: String) throws {
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let c = URLComponents(string: text), c.scheme?.lowercased() == "dshmobile", c.host?.lowercased() == "pair" else {
            throw PairingError.notPairingCode
        }
        let items = c.queryItems ?? []
        func one(_ name: String) -> String? { items.last { $0.name == name }?.value }
        guard let v = one("v").flatMap(Int.init), v >= 1 else { throw PairingError.notPairingCode }
        guard v <= PairingOffer.version else { throw PairingError.unsupportedVersion }
        guard let id = one("id"), PairingOffer.token(id, 8...64) else { throw PairingError.malformed }
        guard let fp = one("fp"), PairingOffer.token(fp, 43...43) else { throw PairingError.malformed }
        guard let code = one("c"), PairingOffer.token(code, 16...128) else { throw PairingError.malformed }
        var seen = Set<Endpoint>()
        let endpoints = items.filter { $0.name == "h" }.compactMap { $0.value.flatMap(Endpoint.init) }.filter { seen.insert($0).inserted }
        let tunnels = items.filter { $0.name == "u" }.compactMap { $0.value.flatMap(URL.init(string:)) }.filter {
            $0.scheme == "https" && $0.host?.isEmpty == false && $0.user == nil && $0.password == nil && $0.query == nil
        }
        guard !endpoints.isEmpty || !tunnels.isEmpty else { throw PairingError.noAddress }
        let rawName = (one("n") ?? "").trimmingCharacters(in: .whitespacesAndNewlines).filter { !$0.isNewline }
        desktopID = id
        desktopName = rawName.isEmpty ? "我的电脑" : String(rawName.prefix(64))
        self.endpoints = Array(endpoints.prefix(8)); self.tunnels = Array(tunnels.prefix(2))
        fingerprint = fp; self.code = code
        expiresAt = one("e").flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
    }

    public func isExpired(at now: Date = Date()) -> Bool { expiresAt.map { now >= $0 } ?? false }

    /// The code the desktop panel shows next to the QR code ("DFBC 72ED 8C52 8D73").
    public var safetyCode: String { Fingerprint.display(fingerprint) }

    public var link: String {
        var c = URLComponents(); c.scheme = "dshmobile"; c.host = "pair"
        var items = [URLQueryItem(name: "v", value: String(PairingOffer.version)), URLQueryItem(name: "id", value: desktopID),
                     URLQueryItem(name: "n", value: desktopName), URLQueryItem(name: "fp", value: fingerprint), URLQueryItem(name: "c", value: code)]
        if let expiresAt { items.append(URLQueryItem(name: "e", value: String(Int(expiresAt.timeIntervalSince1970)))) }
        items += endpoints.map { URLQueryItem(name: "h", value: $0.authority) }
        items += tunnels.map { URLQueryItem(name: "u", value: $0.absoluteString) }
        c.queryItems = items
        return c.string ?? ""
    }

    /// Endpoints in the order the phone should try them: LAN, then tailnet, then the rest.
    public var orderedEndpoints: [Endpoint] {
        let rank: [Endpoint.Kind: Int] = [.lan: 0, .tailnet: 1, .other: 2, .loopback: 3]
        return endpoints.enumerated().sorted { (rank[$0.element.kind]!, $0.offset) < (rank[$1.element.kind]!, $1.offset) }.map(\.element)
    }

    /// base64url / id alphabet only, within a length range.
    static func token(_ value: String, _ length: ClosedRange<Int>) -> Bool {
        guard length.contains(value.count) else { return false }
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F: continue
            default: return false
            }
        }
        return true
    }
}

public enum PairingError: LocalizedError, Equatable {
    case notPairingCode, unsupportedVersion, malformed, noAddress, expired

    public var errorDescription: String? {
        switch self {
        case .notPairingCode: return "这不是 DSH Mobile 的配对二维码。请扫描电脑上「手机连接」里显示的二维码。"
        case .unsupportedVersion: return "电脑端的连接组件比这个 App 新，请先更新 DSH Mobile。"
        case .malformed: return "二维码内容不完整，请在电脑上刷新二维码后重新扫描。"
        case .noAddress: return "二维码里没有可用的电脑地址。请确认电脑已连接网络后刷新二维码。"
        case .expired: return "二维码已过期，请在电脑上刷新后重新扫描。"
        }
    }
}

/// The phone's identity sent with a pairing request.
public struct DeviceInfo: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let model: String
    public let system: String
    public let app: String
    public init(id: String, name: String, model: String, system: String, app: String) {
        self.id = id; self.name = name; self.model = model; self.system = system; self.app = app
    }
}

/// `POST /mobile/v1/pair` body.
public struct PairRequest: Codable, Equatable, Sendable {
    public let code: String
    public let device: DeviceInfo
    public init(code: String, device: DeviceInfo) { self.code = code; self.device = device }
}

/// `POST /mobile/v1/pair` success body.
public struct PairResponse: Codable, Equatable, Sendable {
    public struct Desktop: Codable, Equatable, Sendable { public let id: String; public let name: String }
    public let desktop: Desktop
    public let token: String
}

/// A desktop this phone has paired with, stored in the Keychain.
public struct PairedDesktop: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public var endpoints: [Endpoint]
    public var tunnels: [URL]
    public let fingerprint: String
    public let token: String
    public let pairedAt: Date
    /// Last endpoint that answered, tried first next time.
    public var wakeEndpoints: [Endpoint]?
    public var preferred: Endpoint?

    public init(offer: PairingOffer, response: PairResponse, pairedAt: Date = Date(), preferred: Endpoint? = nil) {
        id = offer.desktopID; name = response.desktop.name.isEmpty ? offer.desktopName : response.desktop.name
        endpoints = offer.orderedEndpoints; tunnels = offer.tunnels
        fingerprint = offer.fingerprint; token = response.token; self.pairedAt = pairedAt; self.preferred = preferred
    }

    /// Apply only to a cloud grant received from the paired desktop (including a
    /// cached one). Keep the original route as fallback; both use the same pin.
    public func preparedCloudGrant() -> Self {
        var grant = self
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty || label == "云端" {
            grant.name = "DSH 云服务器 · " + id.suffix(6).uppercased()
        }
        if let old = endpoints.first, old.host.hasPrefix("dsh-cloud."), old.host.hasSuffix(".sslip.io") {
            let parts = old.host.split(separator: ".")
            if parts.count == 4 {
                let address = parts[1].split(separator: "-", omittingEmptySubsequences: false)
                if address.count == 4 && address.allSatisfy({ UInt8($0).map { String($0) } == String($0) }) {
                    let relay = Endpoint(host: "\(parts[1]).dsh-cloud.sslip.io", port: old.port)
                    if !grant.endpoints.contains(relay) { grant.endpoints.insert(relay, at: 0) }
                    grant.preferred = relay
                }
            }
        }
        return grant
    }

    public var safetyCode: String { Fingerprint.display(fingerprint) }

    /// Candidates in try order: the last good endpoint first.
    public var candidates: [Endpoint] {
        guard let preferred, endpoints.contains(preferred) else { return endpoints }
        return [preferred] + endpoints.filter { $0 != preferred }
    }
}

public enum Fingerprint {
    /// DER prefix of a P-256 SubjectPublicKeyInfo; the 65-byte uncompressed point follows it.
    public static let p256SPKIHeader: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ]

    /// SubjectPublicKeyInfo DER for an uncompressed P-256 point, as returned by
    /// `SecKeyCopyExternalRepresentation`. The desktop pins SHA-256 of these bytes.
    public static func p256SPKI(rawPoint: [UInt8]) -> [UInt8]? {
        guard rawPoint.count == 65, rawPoint[0] == 0x04 else { return nil }
        return p256SPKIHeader + rawPoint
    }

    /// base64url without padding, as carried in the QR code.
    public static func encode(_ digest: [UInt8]) -> String {
        Data(digest).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Groups of four hex digits, for the "verify on the computer" line in settings.
    public static func display(_ base64url: String) -> String {
        var s = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s) else { return base64url }
        let hex = data.prefix(8).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: hex.count, by: 4).map { i -> String in
            let a = hex.index(hex.startIndex, offsetBy: i), b = hex.index(a, offsetBy: 4)
            return String(hex[a..<b])
        }.joined(separator: " ")
    }
}

/// First address is immediate. Cap the stagger so a public relay behind several
/// unreachable LAN adapters does not wait for every adapter's head start.
public enum EndpointTiming {
    public static func delay(index: Int, preservingPage: Bool = false) -> Int {
        guard index > 0 else { return 0 }
        return (preservingPage ? 100 : 0) + 40 * min(index, 3)
    }
}
