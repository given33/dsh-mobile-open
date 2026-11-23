import XCTest
#if canImport(CryptoKit)
import CryptoKit
#endif
@testable import DSHCore

final class PairingTests: XCTestCase {
    let fp = "oNDVQLlkzc6EAbCdEfGhIjKlMnOpQrStUvWxYz01234"
    let code = "Zk3pQ9vL2mX8rT4wY6uB1nC5"

    func testEndpointHeadStartIsBoundedAcrossAdapters() {
        XCTAssertEqual(EndpointTiming.delay(index: 0, preservingPage: true), 0)
        XCTAssertEqual(EndpointTiming.delay(index: 7), 120)
        XCTAssertEqual(EndpointTiming.delay(index: 1, preservingPage: true), 140)
    }

    func testWakeUsesOnlyPairedHostsAndExplicitPublicPort() {
        let lan = Endpoint(host: "192.168.1.20", port: 443), relay = Endpoint(host: "example.test", port: 443)
        let routes = [lan, lan, relay]
        XCTAssertEqual(Endpoint.wakeRoutes(routes, localPort: nil, publicPort: 8444), [])
        XCTAssertEqual(Endpoint.wakeRoutes(routes, localPort: 3444, publicPort: nil).map(\.authority), ["192.168.1.20:3444"])
        XCTAssertEqual(Endpoint.wakeRoutes(routes, localPort: 3444, publicPort: 8444).map(\.authority), ["192.168.1.20:3444", "example.test:8444"])
    }

    func link(_ extra: String = "") -> String {
        "dshmobile://pair?v=1&id=desk-7f3a91c2&n=%E5%B7%A5%E4%BD%9C%E7%AB%99&fp=\(fp)&c=\(code)&e=4102444800&h=100.101.7.8:3081&h=192.168.1.20:3081&h=%5Bfe80::1%5D:3081\(extra)"
    }

    func testParsesOfferAndOrdersLanFirst() throws {
        let offer = try PairingOffer(link: link())
        XCTAssertEqual(offer.desktopID, "desk-7f3a91c2")
        XCTAssertEqual(offer.desktopName, "工作站")
        XCTAssertEqual(offer.fingerprint, fp)
        XCTAssertEqual(offer.code, code)
        XCTAssertEqual(offer.endpoints.count, 3)
        XCTAssertEqual(offer.orderedEndpoints.map(\.authority), ["192.168.1.20:3081", "[fe80::1]:3081", "100.101.7.8:3081"])
        XCTAssertEqual(offer.expiresAt, Date(timeIntervalSince1970: 4102444800))
        XCTAssertFalse(offer.isExpired(at: Date(timeIntervalSince1970: 1_700_000_000)))
        XCTAssertTrue(offer.isExpired(at: Date(timeIntervalSince1970: 4102444800)))
    }

    func testLinkRoundTrip() throws {
        let offer = try PairingOffer(link: link("&u=https%3A%2F%2Fdesk.example.ts.net%2F"))
        XCTAssertEqual(offer.tunnels.map(\.absoluteString), ["https://desk.example.ts.net/"])
        XCTAssertEqual(try PairingOffer(link: offer.link), offer)
    }

    func testRejectsForeignAndBrokenCodes() {
        XCTAssertThrowsError(try PairingOffer(link: "https://example.com/?v=1")) { XCTAssertEqual($0 as? PairingError, .notPairingCode) }
        XCTAssertThrowsError(try PairingOffer(link: "dshmobile://connect?url=http://x")) { XCTAssertEqual($0 as? PairingError, .notPairingCode) }
        XCTAssertThrowsError(try PairingOffer(link: link().replacingOccurrences(of: "v=1", with: "v=9"))) { XCTAssertEqual($0 as? PairingError, .unsupportedVersion) }
        XCTAssertThrowsError(try PairingOffer(link: link().replacingOccurrences(of: "fp=\(fp)", with: "fp=short"))) { XCTAssertEqual($0 as? PairingError, .malformed) }
        XCTAssertThrowsError(try PairingOffer(link: link().replacingOccurrences(of: "c=\(code)", with: "c=a%20b"))) { XCTAssertEqual($0 as? PairingError, .malformed) }
        let noHosts = "dshmobile://pair?v=1&id=desk-7f3a91c2&fp=\(fp)&c=\(code)&h=bad&u=http%3A%2F%2Fplain.example"
        XCTAssertThrowsError(try PairingOffer(link: noHosts)) { XCTAssertEqual($0 as? PairingError, .noAddress) }
    }

    func testCachedCloudGrantKeepsIdentityAndPinWhenAddingScopedRelay() throws {
        let offer = try PairingOffer(link: link())
        let reply = try JSONDecoder().decode(PairResponse.self, from: Data(#"{"desktop":{"id":"cloud-fixture","name":"云端"},"token":"fixture"}"#.utf8))
        var old = PairedDesktop(offer: offer, response: reply)
        let original = try XCTUnwrap(Endpoint("dsh-cloud.192-0-2-1.sslip.io:443"))
        old.endpoints = [original]; old.preferred = original
        let upgraded = old.preparedCloudGrant()
        XCTAssertEqual(upgraded.candidates.map(\.authority), ["192-0-2-1.dsh-cloud.sslip.io:443", original.authority])
        XCTAssertEqual(upgraded.preparedCloudGrant(), upgraded)
        XCTAssertEqual(upgraded.fingerprint, old.fingerprint); XCTAssertEqual(upgraded.token, old.token)
        XCTAssertNotEqual(upgraded.name, "云端")
        old.name = "模拟云服务器"; old.endpoints = [try XCTUnwrap(Endpoint("cloud.example:443"))]
        XCTAssertEqual(old.preparedCloudGrant(), old)
    }

    func testEndpointParsing() {
        XCTAssertEqual(Endpoint("192.168.0.2:3081")?.host, "192.168.0.2")
        XCTAssertEqual(Endpoint("[FD7A:115C:A1E0::5]:443")?.host, "fd7a:115c:a1e0::5")
        XCTAssertEqual(Endpoint("[FD7A:115C:A1E0::5]:443")?.kind, .tailnet)
        XCTAssertEqual(Endpoint("Desk.local:3081")?.host, "desk.local")
        XCTAssertEqual(Endpoint("Desk.local:3081")?.kind, .lan)
        XCTAssertEqual(Endpoint("172.20.1.1:1")?.kind, .lan)
        XCTAssertEqual(Endpoint("172.32.1.1:1")?.kind, .other)
        XCTAssertEqual(Endpoint("fd-server:80")?.kind, .other)
        XCTAssertNil(Endpoint("fe80::1:3081"))
        XCTAssertNil(Endpoint("host:0"))
        XCTAssertNil(Endpoint("host:70000"))
        XCTAssertNil(Endpoint("ho st:80"))
        XCTAssertNil(Endpoint("user@host:80"))
        XCTAssertEqual(Endpoint("[::1]:8080")?.baseURL.absoluteString, "https://[::1]:8080/")
    }

    func testDuplicateHostsAreDroppedAndNameIsSanitized() throws {
        let offer = try PairingOffer(link: "dshmobile://pair?v=1&id=desk-7f3a91c2&n=%0A%20&fp=\(fp)&c=\(code)&h=10.0.0.2:3081&h=10.0.0.2:3081")
        XCTAssertEqual(offer.endpoints.count, 1)
        XCTAssertEqual(offer.desktopName, "我的电脑")
        XCTAssertNil(offer.expiresAt)
    }

    func testPairedDesktopPrefersLastGoodEndpoint() throws {
        let offer = try PairingOffer(link: link())
        let response = PairResponse(desktop: .init(id: offer.desktopID, name: ""), token: "t0k3n")
        var desk = PairedDesktop(offer: offer, response: response, pairedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(desk.name, "工作站")
        XCTAssertEqual(desk.candidates.first?.authority, "192.168.1.20:3081")
        desk.preferred = Endpoint("100.101.7.8:3081")
        XCTAssertEqual(desk.candidates.map(\.authority), ["100.101.7.8:3081", "192.168.1.20:3081", "[fe80::1]:3081"])
        let decoded = try JSONDecoder().decode(PairedDesktop.self, from: JSONEncoder().encode(desk))
        XCTAssertEqual(decoded, desk)
    }

    func testFingerprintFormatting() {
        let digest: [UInt8] = Array(0..<32)
        let encoded = Fingerprint.encode(digest)
        XCTAssertEqual(encoded.count, 43)
        XCTAssertFalse(encoded.contains("="))
        XCTAssertEqual(Fingerprint.display(encoded), "0001 0203 0405 0607")
    }

    /// Generated by desktop/lib/identity.mjs (fingerprintOfKey) for one P-256 key.
    func testSPKIMatchesDesktopFingerprint() throws {
        let raw = hexBytes("0412bbb152360418b3d1dc76d8534ad7b9c24e2d085c1d6883aaf3a98c008ee9dd629eaf28646f80aed9c4638c56e042a77297745e714de31299a06912f6cd4382")
        let spki = try XCTUnwrap(Fingerprint.p256SPKI(rawPoint: raw))
        XCTAssertEqual(spki.count, 91)
        XCTAssertEqual(Array(spki.prefix(26)), hexBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200"))
        XCTAssertNil(Fingerprint.p256SPKI(rawPoint: Array(raw.dropFirst())))
        #if canImport(CryptoKit)
        XCTAssertEqual(Fingerprint.encode(Array(SHA256.hash(data: Data(spki)))), "37xy7YxSjXOStXHwa32paYJ4De6vIBFnfvTZklusQNE")
        #endif
    }

    /// The exact link produced by desktop/test/pairing.test.mjs.
    func testParsesDesktopGeneratedLink() throws {
        let offer = try PairingOffer(link: "dshmobile://pair?v=1&id=desk-7f3a91c2&n=%E5%B7%A5%E4%BD%9C%E7%AB%99%20A%26B&fp=oNDVQLlkzc6EAbCdEfGhIjKlMnOpQrStUvWxYz01234&c=Zk3pQ9vL2mX8rT4wY6uB1nC5&e=4102444800&h=192.168.1.20%3A3081&h=%5Bfd7a%3A115c%3Aa1e0%3A%3A5%5D%3A3081")
        XCTAssertEqual(offer.desktopName, "工作站 A&B")
        XCTAssertEqual(offer.endpoints.map(\.authority), ["192.168.1.20:3081", "[fd7a:115c:a1e0::5]:3081"])
        XCTAssertEqual(offer.endpoints.last?.kind, .tailnet)
        XCTAssertEqual(offer.expiresAt, Date(timeIntervalSince1970: 4102444800))
    }

    func hexBytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []; var i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); out.append(UInt8(hex[i..<j], radix: 16)!); i = j }
        return out
    }
}
