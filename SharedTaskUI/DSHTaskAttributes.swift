import ActivityKit
import Foundation

struct DSHTaskAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let turn: Int
        let step: Int
        let phase: String
        let label: String
        let detail: String
        let terminal: Bool
        let updatedAt: Int64 // epoch milliseconds; matches the relay JSON
    }
    let desktopId: String
    let sessionId: String
    let turn: Int
    var link: URL? { URL(string: "dshmobile://task/\(desktopId)/\(sessionId)") }
}
