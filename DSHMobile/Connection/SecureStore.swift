import Foundation
import Security
import UIKit
import DSHCore

/// Paired desktops and this phone's stable device id, in the Keychain
/// (this device only, readable after first unlock so a relaunch in the
/// background can reconnect).
enum SecureStore {
    private static let service = "app.dshmobile.link"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    static func write(_ account: String, _ data: Data?) throws {
        let key = query(account)
        var status: OSStatus
        if let data {
            let attributes = [kSecValueData as String: data as Any,
                              kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as Any]
            status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(key.merging(attributes) { _, updated in updated } as CFDictionary, nil)
            }
        } else {
            status = SecItemDelete(key as CFDictionary)
            if status == errSecItemNotFound { return }
        }
        guard status == errSecSuccess else { throw ClientError.message("无法把配对信息保存到钥匙串（\(status)）。") }
    }

    static func desktops() -> [PairedDesktop] {
        guard let data = read("desktops") else { return [] }
        return (try? JSONDecoder().decode([PairedDesktop].self, from: data)) ?? []
    }

    static func saveDesktops(_ list: [PairedDesktop]) throws {
        try write("desktops", list.isEmpty ? nil : try JSONEncoder().encode(list))
    }

    /// Stable per-install id sent when pairing, so re-pairing replaces the old record on the desktop.
    static func deviceID() -> String {
        if let data = read("device-id"), let id = String(data: data, encoding: .utf8), !id.isEmpty { return id }
        var bytes = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let id = "ios-" + Fingerprint.encode(bytes)
        try? write("device-id", Data(id.utf8))
        return id
    }
}

enum DeviceIdentity {
    @MainActor static func current() -> DeviceInfo {
        var sys = utsname(); uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        return DeviceInfo(id: SecureStore.deviceID(), name: UIDevice.current.name, model: model,
                          system: "iOS \(UIDevice.current.systemVersion)", app: version)
    }
}

/// Scan or paste -> pair over the pinned connection -> PairedDesktop.
enum PairingFlow {
    @MainActor static func pair(offer: PairingOffer, transport: PinnedTransport) async throws -> PairedDesktop {
        let route = await EndpointRace.probe(offer.orderedEndpoints, desktopID: offer.desktopID, transport: transport)
        guard let endpoint = route.endpoint else {
            // The desktop is the authority on expiry; the phone's clock only explains a failure.
            if offer.isExpired() { throw PairingError.expired }
            throw LinkError.pairingUnreachable(hasPublicAddress: offer.endpoints.contains { $0.kind == .other }, networkCode: route.publicNetworkCode)
        }
        let device = DeviceIdentity.current()
        let response = try await LinkClient(transport: transport, base: endpoint.baseURL).pair(code: offer.code, device: device)
        guard response.desktop.id == offer.desktopID else { throw LinkError.wrongDesktop }
        return PairedDesktop(offer: offer, response: response, preferred: endpoint)
    }
}
