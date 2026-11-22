import Foundation

public struct SessionRow: Identifiable, Equatable, Sendable {
    public let id: String
    public var raw: JSON
    public var projection: JSON
    public var watermark: Int
    public var running: Bool
    public init(_ json: JSON) {
        id = json["sessionId"].string; raw = json
        projection = json["projections"]["values"]
        watermark = json["projections"]["asOfSeq"].int
        running = json["running"].bool
    }
    public var title: String { projection["title"].string.isEmpty ? "新会话" : projection["title"].string }
    public var cwd: String { projection["workingDirectory"].string.isEmpty ? raw["cwd"].string : projection["workingDirectory"].string }
    public var updatedAt: Date { Date(timeIntervalSince1970: Double(raw["updatedAt"].int) / 1000) }
    public var model: String {
        let v = projection["modelSelection"]
        return v["next"]["model"].string.isEmpty ? v["lastUsed"]["model"].string : v["next"]["model"].string
    }
    public mutating func baseline(_ value: JSON) {
        guard value["asOfSeq"].int >= watermark else { return }
        watermark = value["asOfSeq"].int; projection = value["values"]
    }
    public mutating func patch(_ value: JSON) {
        guard value["seq"].int > watermark else { return }
        var map = projection.object
        for change in value["changes"].array { map[change["key"].string] = change["val"] }
        projection = .object(map); watermark = value["seq"].int
    }
}

public struct TimelineEvent: Identifiable, Equatable, Sendable {
    public let raw: JSON
    public var id: Int { raw["seq"].int }
    public var type: String { raw["type"].string }
    public var data: JSON { raw["data"] }
    public init(_ value: JSON) { raw = value }
    public var message: JSON { data["message"] == .null ? data : data["message"] }
    public var blocks: [JSON] { message["content"].array }
}

public struct Transcript: Equatable, Sendable {
    public var events: [TimelineEvent] = []
    public var cursor = -1
    public var hasMore = false
    public var revision = 0
    public var attemptID = ""
    public var nextIndex = 0
    public var live: [Int: JSON] = [:]
    public var fault: String?
    private var turn = -1
    private var step = -1
    private var startedAfter = -1
    public init() {}
    public var liveBlocks: [JSON] { live.sorted { $0.key < $1.key }.map(\.value) }
    public mutating func receive(_ frame: JSON) {
        switch frame["type"].string {
        case "snapshot":
            events = []; live = [:]; fault = nil; attemptID = ""
            cursor = frame["cursor"].int; hasMore = frame["hasMore"].bool
            merge(frame["records"].array)
            let baseline = frame["assistantStream"], active = baseline["activeAttempt"]
            revision = baseline["revision"].int
            if active != .null {
                start(active); nextIndex = active["nextIndex"].int
                for record in active["stream"].array {
                    switch record["type"].string {
                    case "text-chunks", "reasoning-chunks":
                        chunk(.object(["type": .string(record["type"].string == "text-chunks" ? "text-delta" : "reasoning-delta"), "index": record["index"], "text": .string(record["texts"].array.map(\.string).joined())]))
                    case "tool-call-chunks":
                        chunk(.object(["type": .string("tool-call-delta"), "index": record["index"], "id": record["id"], "name": record["name"], "argumentsDelta": .string(record["args"].array.map(\.string).joined())]))
                    default: chunk(record["chunk"])
                    }
                }
            }
        case "event":
            let event = TimelineEvent(frame["event"])
            merge([frame])
            if ["assistant/message", "assistant/attempt"].contains(event.type), event.id > startedAfter,
               event.data["turn"].int == turn, event.data["step"].int == step {
                live = [:]; attemptID = ""
            }
        case "assistant-stream":
            let f = frame["frame"]
            if f["revision"].int <= revision { return }
            if revision > 0 && f["revision"].int != revision + 1 { live = [:]; attemptID = ""; fault = "实时消息存在缺口，正在重新同步。"; return }
            revision = f["revision"].int
            switch f["type"].string {
            case "start": start(f)
            case "chunk":
                guard f["attemptId"].string == attemptID, f["index"].int == nextIndex else { live = [:]; fault = "实时消息顺序异常，正在重新同步。"; return }
                chunk(f["chunk"]); nextIndex += 1
            case "end":
                guard f["attemptId"].string == attemptID else { return }
                if f["index"].int != nextIndex { live = [:]; fault = "实时消息存在缺口，正在重新同步。" }
                if f["outcome"]["kind"].string == "abandoned" || events.contains(where: { $0.id == f["outcome"]["seq"].int }) { live = [:]; attemptID = "" }
            default: break
            }
        default: break
        }
    }
    public mutating func merge(_ records: [JSON]) {
        var map = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
        for record in records where record["type"].string == "event" {
            let event = TimelineEvent(record["event"]); map[event.id] = event
        }
        events = map.values.sorted { $0.id < $1.id }
    }
    private mutating func start(_ v: JSON) {
        attemptID = v["attemptId"].string; nextIndex = 0; live = [:]
        turn = v["turn"].int; step = v["step"].int; startedAfter = v["startedAfterSeq"].int
    }
    private mutating func chunk(_ value: JSON) {
        let index = value["index"].int, type = value["type"].string
        if type == "text-delta" || type == "reasoning-delta" {
            var block = live[index]?.object ?? [:]
            block["type"] = .string(type == "text-delta" ? "text" : "reasoning")
            block["text"] = .string((block["text"]?.string ?? "") + value["text"].string)
            live[index] = .object(block)
        } else if type == "tool-call-delta" {
            var block = live[index]?.object ?? [:]
            block["type"] = .string("tool-call"); block["id"] = value["id"]
            if !value["name"].string.isEmpty { block["name"] = value["name"] }
            block["arguments"] = .string((block["arguments"]?.string ?? "") + value["argumentsDelta"].string)
            live[index] = .object(block)
        }
    }
}
