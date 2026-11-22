import Foundation

/// A pending interaction the desktop is waiting on, from `$events` waterfall frames.
public struct PendingInteraction: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case approval, planReview, question }
    public let id: String
    public let sessionId: String
    public let kind: Kind
    public let request: JSON
    public let continuedCallID: String?

    public init?(_ frame: JSON) {
        guard frame["type"].string == "waterfall" else { return nil }
        let event = frame["event"].string
        switch event {
        case "approval/request": kind = .approval
        case "user-questions/request":
            kind = frame["request"]["questions"].array.contains { $0["intent"]["kind"].string == "plan-review" } ? .planReview : .question
        default: return nil
        }
        id = frame["eventId"].string; sessionId = frame["agentId"].string; request = frame["request"]
        guard !id.isEmpty, !sessionId.isEmpty else { return nil }
        continuedCallID = nil
    }

    public init?(continued value: JSON, sessionID: String) {
        let callID = value["callId"].string
        guard value["state"].string == "continued", !callID.isEmpty, !value["questions"].array.isEmpty else { return nil }
        self.id = "continued:" + callID
        self.sessionId = sessionID
        self.kind = .question
        self.request = .object(["questions": value["questions"]])
        self.continuedCallID = callID
    }

    /// One line for the transcript banner.
    public var summary: String {
        switch kind {
        case .approval:
            let tool = request["toolName"].string
            return tool.isEmpty ? "有一项操作等待审批" : "工具 \(tool) 请求越权执行"
        case .question:
            return request["questions"].array.lazy.map { $0["question"].string }.first { !$0.isEmpty } ?? "有一个问题等待回答"
        case .planReview: return "计划等待审阅"
        }
    }
    public var detail: String { kind == .approval ? request["reason"].string : "" }
}

/// List status, as the desktop sidebar ranks it: pending interaction, running, subagents, unread completion, idle.
public enum SessionStatus: Equatable, Sendable {
    case waitingApproval, planReview, waitingAnswer, running, subagents(Int), completed, idle
    public var label: String {
        switch self {
        case .waitingApproval: "等待审批"; case .planReview: "计划待审"; case .waitingAnswer: "等待回答"
        case .running: "进行中"; case .subagents(let n): "\(n) 个子智能体运行中"; case .completed: "已完成"; case .idle: "空闲"
        }
    }
    public var compactLabel: String {
        switch self { case .waitingApproval: "待审批"; case .waitingAnswer: "待回答"; default: label }
    }
    public var needsAttention: Bool { [.waitingApproval, .planReview, .waitingAnswer].contains(self) }
    public var isLive: Bool { if case .running = self { return true }; if case .subagents = self { return true }; return false }
}

public struct WorkspaceGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let path: String
    public var sessions: [SessionRow]
}

/// Session list state: `session/list`, `session/control`, `$events` and `workspace/follow`.
public struct SessionDirectory: Equatable, Sendable {
    public private(set) var rows: [String: SessionRow] = [:]
    public private(set) var workspaces: [JSON] = []
    public private(set) var archived: Set<String> = []
    public private(set) var pinned: [String] = []
    public private(set) var pending: [String: PendingInteraction] = [:]
    /// Sessions that finished while not being viewed (the desktop's completion reminder).
    public private(set) var unread: Set<String> = []
    public var viewing: String?
    private var keySeq: [String: Int] = [:]

    public init() {}

    public var count: Int { rows.count }
    public subscript(id: String) -> SessionRow? { rows[id] }

    /// `session/list` result; projections only move forward.
    public mutating func receiveList(_ value: JSON) {
        var next: [String: SessionRow] = [:]
        for item in value["items"].array {
            var row = SessionRow(item)
            if let old = rows[row.id], old.watermark > row.watermark { row.projection = old.projection; row.watermark = old.watermark }
            next[row.id] = row
        }
        rows = next
    }

    /// One `$events` item. Returns true when the list should be re-read.
    @discardableResult
    public mutating func receiveEvent(_ value: JSON) -> Bool {
        switch value["type"].string {
        case "ready":
            pending = [:]
            return true
        case "emit":
            let args = value["args"].array
            switch value["event"].string {
            case "api-session/added", "api-session/updated":
                if let item = args.first, !item["sessionId"].string.isEmpty { upsert(item) }
                return false
            case "api-session/status":
                guard args.count >= 2 else { return false }
                setRunning(args[0].string, args[1].bool)
                return false
            case "api-session/activity":
                guard args.count >= 2, var row = rows[args[0].string] else { return false }
                row.raw = .object(row.raw.object.merging(["updatedAt": args[1]]) { $1 }); rows[row.id] = row
                return false
            case "api-session/removed", "api-session/deleted":
                if let id = args.first?.string { rows.removeValue(forKey: id) }
                return false
            default:
                return value["event"].string.hasPrefix("api-session/")
            }
        case "waterfall":
            if let p = PendingInteraction(value) { pending[p.id] = p }
            return false
        case "cancel":
            pending.removeValue(forKey: value["eventId"].string)
            return false
        default: return false
        }
    }

    /// One `session/control` item: a baseline, or projection changes in either wire form
    /// (0.2.1 sends one `key`/`value` per frame; later builds batch `changes`).
    public mutating func receiveControl(_ value: JSON) {
        switch value["type"].string {
        case "baseline":
            for (id, projection) in value["value"]["projections"].object { rows[id]?.baseline(projection) }
        case "projection":
            let id = value["sessionId"].string
            guard var row = rows[id] else { return }
            let seq = value["seq"].int
            var changes: [(String, JSON)] = []
            if case .array(let list) = value["changes"] { changes = list.map { ($0["key"].string, $0["val"]) } }
            else if !value["key"].string.isEmpty { changes = [(value["key"].string, value["value"])] }
            var map = row.projection.object
            for (key, val) in changes where !key.isEmpty {
                let k = "\(id)#\(key)"
                if let last = keySeq[k], seq < last { continue }
                keySeq[k] = seq; map[key] = val
            }
            row.projection = .object(map)
            row.watermark = max(row.watermark, seq)
            rows[id] = row
        default: break
        }
    }

    /// One `workspace/follow` item.
    public mutating func receiveWorkspace(_ frame: JSON) {
        let value = frame["value"]
        switch frame["type"].string {
        case "baseline", "replace":
            workspaces = value["items"].array
            archived = Set(value["archivedSessionIds"].array.map(\.string)); pinned = value["pinnedSessionIds"].array.map(\.string)
        case "upsert":
            let workspace = frame["workspace"]
            if let i = workspaces.firstIndex(where: { $0["workspaceId"] == workspace["workspaceId"] }) { workspaces[i] = workspace } else { workspaces.append(workspace) }
        case "remove": workspaces.removeAll { $0["workspaceId"] == frame["workspaceId"] }
        case "order":
            let ids = frame["workspaceIds"].array.map(\.string)
            workspaces = ids.compactMap { id in workspaces.first { $0["workspaceId"].string == id } }
        case "archived": archived = Set(frame["archivedSessionIds"].array.map(\.string))
        case "pinned": pinned = frame["pinnedSessionIds"].array.map(\.string)
        default: break
        }
    }

    /// Projections carried by a `session/follow` snapshot for one session.
    public mutating func receiveProjection(_ id: String, _ projection: JSON) {
        guard projection != .null else { return }
        rows[id]?.baseline(projection)
    }

    public mutating func markViewed(_ id: String?) {
        viewing = id
        if let id { unread.remove(id) }
    }

    public mutating func upsert(_ item: JSON) {
        var row = SessionRow(item)
        if let old = rows[row.id], old.watermark > row.watermark { row.projection = old.projection; row.watermark = old.watermark }
        rows[row.id] = row
    }

    mutating func setRunning(_ id: String, _ running: Bool) {
        guard var row = rows[id] else { return }
        if row.running, !running, viewing != id { unread.insert(id) }
        row.running = running; rows[id] = row
    }

    public mutating func clearPending() { pending.removeAll() }

    public mutating func removePending(_ id: String) { pending.removeValue(forKey: id) }

    public func pending(for id: String) -> [PendingInteraction] {
        let live = pending.values.filter { $0.sessionId == id }.sorted { $0.id < $1.id }
        guard let row = rows[id] else { return live }
        let seen = Set(live.map { $0.request["wait"]["callId"].string })
        let queued = Set(row.queuedInputs.map { $0.source["callId"].string })
        let continued = row.projection["userQuestions"]["active"].array.compactMap { value -> PendingInteraction? in
            let call = value["callId"].string
            guard !seen.contains(call), !queued.contains(call) else { return nil }
            return PendingInteraction(continued: value, sessionID: id)
        }
        return live + continued
    }

    public func status(of id: String) -> SessionStatus {
        let kinds = Set(pending(for: id).map(\.kind))
        if kinds.contains(.approval) { return .waitingApproval }
        if kinds.contains(.planReview) { return .planReview }
        if kinds.contains(.question) { return .waitingAnswer }
        guard let row = rows[id] else { return .idle }
        if row.running { return .running }
        let children = row.projection["subagentCatalog"].array.filter { rows[$0["id"].string]?.running == true }.count
        if children > 0 { return .subagents(children) }
        return unread.contains(id) ? .completed : .idle
    }

    /// Top-level sessions, newest first; subagent children stay under their parent.
    public var visible: [SessionRow] {
        let children = Set(rows.values.flatMap { $0.projection["subagentCatalog"].array.map { $0["id"].string } })
        return rows.values.filter { !children.contains($0.id) && !$0.raw["blank"].bool && !archived.contains($0.id) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The desktop's "按工作区" grouping: workspaces in their order, then 未分组. Pinned rows lead each group.
    public var groups: [WorkspaceGroup] {
        let list = visible
        var claimed = Set<String>()
        var out: [WorkspaceGroup] = []
        let pinRank = Dictionary(pinned.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        func ordered(_ rows: [SessionRow], manual: [String] = []) -> [SessionRow] {
            let order = Dictionary(manual.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
            return rows.sorted { a, b in
                switch (pinRank[a.id], pinRank[b.id]) {
                case let (x?, y?): return x < y
                case (.some, nil): return true
                case (nil, .some): return false
                default:
                    if let x = order[a.id], let y = order[b.id] { return x < y }
                    if order[a.id] != nil || order[b.id] != nil { return order[a.id] != nil }
                    return a.updatedAt == b.updatedAt ? a.id < b.id : a.updatedAt > b.updatedAt
                }
            }
        }
        let accounted = Set(workspaces.flatMap { $0["sessionIds"].array.map(\.string) })
        for ws in workspaces {
            let path = ws["path"].string
            let manual = ws["sessionIds"].array.map(\.string)
            let membership = Set(manual)
            let members = list.filter { row in
                !claimed.contains(row.id) && (membership.contains(row.id) ||
                    (ws["sessionIds"] == .null && !accounted.contains(row.id) && Self.inside(row.cwd, path)))
            }
            members.forEach { claimed.insert($0.id) }
            let title = ws["title"].string.isEmpty ? Self.basename(path) : ws["title"].string
            out.append(WorkspaceGroup(id: ws["workspaceId"].string, title: title, path: path, sessions: ordered(members, manual: manual)))
        }
        let stray = list.filter { !claimed.contains($0.id) }
        if !stray.isEmpty { out.append(WorkspaceGroup(id: "", title: "未分组", path: "", sessions: ordered(stray))) }
        return out
    }

    public func manualSessionOrder(in workspaceID: String) -> [String] {
        workspaces.first { $0["workspaceId"].string == workspaceID }?["sessionIds"].array.map(\.string) ?? []
    }

    static func inside(_ cwd: String, _ root: String) -> Bool {
        guard !root.isEmpty else { return false }
        let a = cwd.replacingOccurrences(of: "\\", with: "/").lowercased(), b = root.replacingOccurrences(of: "\\", with: "/").lowercased()
        return a == b || a.hasPrefix(b.hasSuffix("/") ? b : b + "/")
    }
    static func basename(_ path: String) -> String {
        path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
    }
}

/// One entry of a session's to-do list (`todos` projection).
public struct TodoItem: Equatable, Sendable {
    public enum Status: Sendable { case completed, inProgress, pending }
    public let content: String
    public let status: Status
    public var label: String {
        switch status { case .completed: "已完成"; case .inProgress: "进行中"; case .pending: "待处理" }
    }
}

public extension SessionRow {
    var todoItems: [TodoItem] {
        projection["todos"].array.map { item in
            let status: TodoItem.Status = switch item["status"].string {
            case "completed": .completed
            case "in_progress": .inProgress
            default: .pending
            }
            return TodoItem(content: item["content"].string, status: status)
        }
    }
    /// The TodoPanel header: "2 已完成 · 1 进行中 · 1 待处理", zero counts left out.
    var todoProgress: String? {
        let items = todoItems
        guard !items.isEmpty else { return nil }
        let done = items.filter { $0.status == .completed }.count, active = items.filter { $0.status == .inProgress }.count
        let pending = items.count - done - active
        return [done > 0 ? "\(done) 已完成" : nil, active > 0 ? "\(active) 进行中" : nil, pending > 0 ? "\(pending) 待处理" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }
    var todos: (done: Int, total: Int)? {
        let list = projection["todos"].array
        guard !list.isEmpty else { return nil }
        return (list.filter { $0["status"].string == "completed" }.count, list.count)
    }
    var workspaceName: String { SessionDirectory.basename(cwd) }
}
