import Foundation

/// The desktop's StatsPills and context meter, from a session's projections
/// (`sessionStats`, `tokenUsage`, `contextPressure`). Each field is nil when
/// the desktop would show nothing for it.
public struct SessionUsage: Equatable, Sendable {
    /// "1 轮 6 步"
    public let counts: String?
    /// "88 tok/s"
    public let speed: String?
    /// "15.3K tok"
    public let tokens: String?
    /// "缓存命中 0%"
    public let cacheHit: String?
    /// "2%", the share of the context window in use.
    public let context: String?

    public init(projection: JSON) {
        let stats = projection["sessionStats"]
        if stats != .null {
            counts = "\(stats["turns"].int) 轮 \(stats["steps"].int) 步"
            let decodeMs = stats["decodeMs"].int, decoded = stats["decodeTokens"].int
            speed = decodeMs > 0 && decoded > 0 ? "\(Self.perSecond(Double(decoded) / (Double(decodeMs) / 1000))) tok/s" : nil
        } else {
            counts = nil; speed = nil
        }
        let usage = projection["tokenUsage"]
        if usage != .null {
            let billed = usage["uncachedInputTokens"].int + usage["cacheReadTokens"].int + usage["cacheWriteTokens"].int
            let total = billed + usage["outputTokens"].int
            tokens = total > 0 ? "\(Self.tokens(total)) tok" : nil
            cacheHit = billed > 0 ? "缓存命中 \(Self.percent(usage["cacheReadTokens"].int, of: billed))%" : nil
        } else {
            tokens = nil; cacheHit = nil
        }
        let pressure = projection["contextPressure"]
        let window = pressure["contextWindow"].int, used = pressure["pressureTokens"].int
        if window > 0, used > 0 {
            context = "\(max(1, Int((Double(used) * 100 / Double(window)).rounded())))%"
        } else {
            context = nil
        }
    }

    /// `formatTokensPerSecond`: one decimal below 10, whole numbers above.
    static func perSecond(_ value: Double) -> String {
        let v = max(0, value)
        return v >= 10 ? String(Int(v.rounded())) : Self.trim((v * 10).rounded() / 10)
    }

    /// `formatTokens`: 950, 15.3K, 184K, 1.2M.
    public static func tokens(_ value: Int) -> String {
        func scaled(_ v: Double) -> String { v >= 100 ? String(Int(v.rounded())) : trim((v * 10).rounded() / 10) }
        if value < 1000 { return String(value) }
        if value < 1_000_000 { return scaled(Double(value) / 1000) + "K" }
        return scaled(Double(value) / 1_000_000) + "M"
    }

    /// Whole percent, except that a partial hit never shows as 100.
    static func percent(_ part: Int, of whole: Int) -> String {
        guard whole > 0 else { return "0" }
        if part >= whole { return "100" }
        var places = 0
        while places < 4 {
            let scale = pow(10, Double(places))
            let value = (Double(part) * 100 / Double(whole) * scale).rounded() / scale
            if value < 100 { return places == 0 ? String(Int(value)) : String(format: "%.\(places)f", value) }
            places += 1
        }
        return "99.99"
    }

    private static func trim(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }
}

public extension SessionRow {
    var usage: SessionUsage { SessionUsage(projection: projection) }
    /// Permission preset label, as the desktop composer shows it.
    var permissionLabel: String? {
        switch projection["permissions"]["currentValue"].string {
        case "read-only": "仅可查看"
        case "workspace-write": "工作区内修改"
        case "danger-full-access": "完全权限"
        case "": nil
        case let other: other
        }
    }
}
