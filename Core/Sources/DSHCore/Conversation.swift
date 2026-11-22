import Foundation

// The desktop Chat's reading model, rebuilt from the same session events the
// desktop receives (DSH 0.2.1-rc.3, dsh-client-ui-chat "Chat 节点业务规则"):
// a turn is its inputs, then process groups (reasoning and tool calls) cut by
// replies, then its outcome. Labels are the desktop's zh strings.

/** 设置 → 工作步骤展示. */
public enum DisplayMode: String, CaseIterable, Codable, Sendable {
    case compact, standard, detailed, verbose
    public var label: String {
        switch self { case .compact: "简洁"; case .standard: "标准"; case .detailed: "详细"; case .verbose: "完全展开" }
    }
}

/** Tool-name categories used for group titles and counts (exact names, first match wins). */
public enum ToolCategory: String, Sendable, CaseIterable {
    case read, readImage, search, write, edit, commands, code, webSearch, webFetch, subagents, plan, questions, tools

    public init(toolName n: String) {
        switch n {
        case "read": self = .read
        case "read_image": self = .readImage
        case _ where n == "grep" || n == "glob" || n.hasSuffix("_inspect"): self = .search
        case "write": self = .write
        case "edit", "apply_patch": self = .edit
        case _ where ["bash", "pwsh", "exec_command", "write_stdin"].contains(n) || n.hasPrefix("terminal_"): self = .commands
        case "run_code": self = .code
        case "web_search": self = .webSearch
        case "web_fetch": self = .webFetch
        case _ where n == "subagent" || n.hasPrefix("subagent_"): self = .subagents
        case "todo_write", "create_goal", "update_goal", "get_goal": self = .plan
        case "ask_user_question", "request_user_input": self = .questions
        default: self = .tools
        }
    }

    /// 未结束组的活动文案.
    public var activity: String {
        switch self {
        case .read: "正在读取文件"; case .readImage: "正在读取图片"; case .search: "正在搜索代码"; case .write: "正在写入文件"
        case .edit: "正在编辑文件"; case .commands: "正在运行命令"; case .code: "正在运行代码"; case .webSearch: "正在搜索网页"
        case .webFetch: "正在访问网页"; case .subagents: "正在协调子智能体"; case .plan: "正在更新计划"; case .questions: "等待你的操作"
        case .tools: "正在调用工具"
        }
    }
    /// 准备中调用的文案.
    public var preparing: String {
        switch self {
        case .read: "准备读取文件"; case .readImage: "准备读取图片"; case .search: "准备搜索代码"; case .write: "准备写入文件"
        case .edit: "准备编辑文件"; case .commands: "准备运行命令"; case .code: "准备运行代码"; case .webSearch: "准备搜索网页"
        case .webFetch: "准备访问网页"; case .subagents: "准备协调子智能体"; case .plan: "准备更新计划"; case .questions: "准备提问"
        case .tools: "准备调用工具"
        }
    }
    /// 已结束组的摘要文案.
    public var done: String {
        switch self {
        case .read: "已读取文件"; case .readImage: "已读取图片"; case .search: "已搜索代码"; case .write: "已写入文件"
        case .edit: "修改了文件"; case .commands: "执行了命令"; case .code: "运行了代码"; case .webSearch: "已搜索网页"
        case .webFetch: "已访问网页"; case .subagents: "已协调子智能体"; case .plan: "更新了计划"; case .questions: "向用户提出了问题"
        case .tools: "已调用工具"
        }
    }
    public static let thinkingActivity = "正在分析请求"
    public static let thinkingDone = "已完成分析"
}

/** Row family (icon and colors), as the desktop ToolRow variant. */
public enum ToolVariant: String, Sendable { case search, read, bash, write, edit, code, others }

public enum ToolState: String, Sendable { case preparing, running, ok, error, stopped }

public struct ToolRow: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var argsRaw: String
    public var state: ToolState
    public var output: String?
    public var time: Int
    public var exitCode: Int?
    public var subCalls: [ToolRow] = []

    public init(id: String, name: String, argsRaw: String, state: ToolState, output: String? = nil, time: Int = 0) {
        self.id = id; self.name = name; self.argsRaw = argsRaw; self.state = state; self.output = output; self.time = time
    }

    public var args: JSON { (try? JSON.parse(Data(argsRaw.utf8))) ?? .null }
    public var category: ToolCategory { ToolCategory(toolName: name) }
    public var variant: ToolVariant {
        switch name {
        case "bash", "pwsh": .bash
        case "read", "read_image", "web_fetch", "cordis_package_inspect", "cordis_runtime_inspect": .read
        case "web_search", "grep", "glob": .search
        case "write": .write
        case "edit": .edit
        case "run_code": .code
        default: .others
        }
    }
    /// Row title, as `toolTitleKey`.
    public var title: String {
        if let own = Self.titles[name] { return own }
        switch variant {
        case .search: return "搜索"; case .read: return "读取"; case .bash: return "运行命令"; case .write: return "写入"
        case .edit: return "编辑"; case .code: return "代码"; case .others: return "工具调用"
        }
    }
    private static let titles: [String: String] = [
        "pwsh": "运行命令", "read_image": "读取图片", "todo_write": "更新任务清单", "ask_user_question": "提问",
        "create_goal": "创建目标", "get_goal": "查看目标", "update_goal": "更新目标",
        "schedule_create": "创建定时任务", "schedule_list": "查看定时任务", "schedule_delete": "删除定时任务", "schedule_update": "修改定时任务",
        "subagent": "创建子智能体", "list_agents": "查看子智能体", "send_message": "发送消息", "interrupt_agent": "中断智能体",
        "job_list": "查看后台任务", "job_output": "读取任务输出", "job_kill": "取消后台任务",
        "terminal_open": "创建终端", "terminal_read": "读取终端", "terminal_list": "查看终端", "terminal_signal": "发送终端信号", "terminal_close": "关闭终端",
        "lsp": "查询代码符号", "list_subagent_models": "查看可用模型", "wait_agent": "等待子智能体", "workflow": "运行工作流",
        "session_search": "搜索会话", "session_trace": "追踪会话", "session_event_read": "读取事件", "session_event_search": "搜索事件",
    ]

    /// One-line summary, as `toolRowModel` (generic rows keep the wire name).
    public func summary(cwd: String = "", home: String = "") -> String {
        let a = args
        // Tools with their own desktop card summarize their content instead of raw arguments.
        if name == "todo_write", case .array(let todos) = a["todos"] {
            return "\(todos.filter { $0["status"].string == "completed" }.count)/\(todos.count) 已完成"
        }
        if name == "ask_user_question", let q = a["questions"].array.lazy.map({ $0["question"].string }).first(where: { !$0.isEmpty }) {
            return q
        }
        var base = ""
        if [.read, .write, .edit].contains(variant), !a["file_path"].string.isEmpty {
            base = Paths.display(firstLine(a["file_path"].string), cwd: cwd, home: home)
        } else if !a["description"].string.isEmpty, ![.read, .write, .edit].contains(variant) {
            base = firstLine(a["description"].string)
        } else if !argsRaw.isEmpty {
            base = Paths.display(derived(a), cwd: cwd, home: home)
        }
        return [title == "工具调用" ? name : "", base].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func derived(_ a: JSON) -> String {
        guard case .object(let map) = a else { return firstLine(argsRaw) }
        if variant == .search, case .array(let queries) = a["queries"] {
            let list = queries.compactMap { $0.string.isEmpty ? nil : firstLine($0.string) }
            if !list.isEmpty { return list.joined(separator: ", ") }
        }
        let keys: [String]
        switch variant {
        case .bash: keys = ["description", "command"]
        case .read: keys = ["path", "file_path", "url"]
        case .search: keys = ["query", "pattern", "url"]
        case .write, .edit: keys = ["path", "file_path"]
        case .code: keys = ["description"]
        case .others: keys = []
        }
        for key in keys where !(map[key]?.string ?? "").isEmpty { return firstLine(map[key]!.string) }
        for key in map.keys.sorted() where !(map[key]?.string ?? "").isEmpty { return firstLine(map[key]!.string) }
        return firstLine(argsRaw)
    }

    /// Group-header detail: first supported argument field in the desktop's fixed order.
    public var detail: String {
        let a = args
        for key in Self.detailKeys {
            let v = a[key]
            if case .string(let s) = v {
                let t = s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                if !t.isEmpty { return t }
            } else if case .array(let items) = v, !items.isEmpty {
                if key == "questions", let q = items.lazy.map({ $0["question"].string }).first(where: { !$0.isEmpty }) { return q }
                let strings = items.compactMap { item -> String? in if case .string(let s) = item { return s }; return nil }
                if strings.count == items.count { return strings.joined(separator: ", ") }
            }
        }
        return state == .preparing || state == .running ? "" : name
    }
    static let detailKeys = ["title", "description", "objective", "task", "task_name", "name", "question", "questions", "prompt", "message",
                             "command", "cmd", "queries", "query", "pattern", "url", "uri", "file_path", "path", "target", "action", "status"]

    /// First line of the result on an error row.
    public var errorSummary: String? {
        guard state == .error, let output, !output.isEmpty else { return nil }
        return firstLine(output)
    }
    var isLive: Bool { state == .preparing || state == .running }
}

public struct ReasoningRow: Identifiable, Equatable, Sendable {
    public let id: String
    public var text: String
    public var streaming: Bool
    /// Settled preview: the most recent paragraph whose first line ends with a newline.
    public var preview: String? {
        let paragraphs = text.components(separatedBy: "\n\n")
        for p in paragraphs.reversed() {
            let trimmed = p.trimmingCharacters(in: .whitespaces)
            guard let nl = trimmed.firstIndex(of: "\n") else { continue }
            let line = String(trimmed[..<nl]).replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { return line }
        }
        let single = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return streaming || single.contains("\n") || single.isEmpty ? nil : single.replacingOccurrences(of: "**", with: "")
    }
    /// Detail for a running group header: last non-empty paragraph without `**`.
    var liveDetail: String {
        text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last(where: { !$0.isEmpty })?
            .replacingOccurrences(of: "**", with: "") ?? ""
    }
}

public struct RetryRow: Identifiable, Equatable, Sendable {
    public let id: String
    public var retry: Int
    public var maximum: Int
    public var delayMs: Int
    public var started: Bool
    /// The provider's message for the failure that caused this retry.
    public var failure: String = ""
    public var label: String { started ? "正在重试模型请求" : "等待重试模型请求" }
    /// Label once the turn has ended.
    public static let settledLabel = "已重试模型请求"
    public func status(settled: Bool) -> String {
        "\(settled ? Self.settledLabel : label)（\(retry)/\(maximum)） · \(max(1, Int((Double(delayMs) / 1000).rounded())))s"
    }
    public var status: String { "\(label)（\(retry)/\(maximum)） · \(max(1, Int((Double(delayMs) / 1000).rounded())))s" }
}

public enum ProcessItem: Identifiable, Equatable, Sendable {
    case reasoning(ReasoningRow), tool(ToolRow)
    public var id: String {
        switch self { case .reasoning(let r): "r:\(r.id)"; case .tool(let t): "t:\(t.id)" }
    }
}

public struct ProcessGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public var items: [ProcessItem]
    public var closed: Bool

    public var tools: [ToolRow] { items.compactMap { if case .tool(let t) = $0 { return t }; return nil } }

    /// Category counts over the group's calls (first callId wins, parents before children), ordered by count then first appearance.
    public var categories: [(ToolCategory, Int)] {
        var counts: [ToolCategory: Int] = [:], order: [ToolCategory] = [], seen = Set<String>()
        func visit(_ t: ToolRow) {
            guard seen.insert(t.id).inserted else { return }
            let c = t.category
            if counts[c] == nil { order.append(c) }
            counts[c, default: 0] += 1
            t.subCalls.forEach(visit)
        }
        tools.forEach(visit)
        return order.enumerated().sorted { a, b in
            let (ca, cb) = (counts[a.element]!, counts[b.element]!)
            return ca != cb ? ca > cb : a.offset < b.offset
        }.map { ($0.element, counts[$0.element]!) }
    }

    /// The group header text for a display mode.
    public func title(mode: DisplayMode) -> String {
        if closed {
            let labels = categories.prefix(3).map(\.0.done)
            switch categories.count {
            case 0: return ToolCategory.thinkingDone
            case 1: return labels[0]
            case 2:
                let second = labels[0].hasPrefix("已") && labels[1].hasPrefix("已") ? String(labels[1].dropFirst()) : labels[1]
                return "\(labels[0])并\(second)"
            case 3: return labels.joined(separator: "，")
            default: return labels.joined(separator: "，") + "等"
            }
        }
        let live = allTools.filter(\.isLive).max { a, b in a.time <= b.time }
        if let live {
            let head = live.state == .preparing ? live.category.preparing : live.category.activity
            let detail = mode == .standard ? live.detail : ""
            return detail.isEmpty ? head : "\(head) · \(detail)"
        }
        let reasoning = items.reversed().lazy.compactMap { item -> ReasoningRow? in if case .reasoning(let r) = item, r.streaming { return r }; return nil }.first
        let detail = mode == .standard ? (reasoning?.liveDetail ?? "") : ""
        return detail.isEmpty ? ToolCategory.thinkingActivity : "\(ToolCategory.thinkingActivity) · \(detail)"
    }

    /// Icon category for the header: the live call's, else the top-ranked one.
    public var leadCategory: ToolCategory? {
        if !closed, let live = allTools.filter(\.isLive).max(by: { $0.time <= $1.time }) { return live.category }
        return closed ? categories.first?.0 : nil
    }
    var allTools: [ToolRow] {
        var out: [ToolRow] = []
        func visit(_ t: ToolRow) { out.append(t); t.subCalls.forEach(visit) }
        tools.forEach(visit)
        return out
    }
}

public struct Reply: Identifiable, Equatable, Sendable {
    public let id: String
    public var text: String
    public var streaming: Bool
}

public struct UserInput: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case user, trigger(String) }
    public let id: String
    public var text: String
    public var attachments: Int
    public var attachmentBlocks: [JSON] = []
    public var time: Int
    public var kind: Kind
}

public enum TurnElement: Identifiable, Equatable, Sendable {
    case input(UserInput), group(ProcessGroup), reply(Reply), retry(RetryRow)
    public var id: String {
        switch self {
        case .input(let u): "i:\(u.id)"; case .group(let g): "g:\(g.id)"; case .reply(let r): "a:\(r.id)"; case .retry(let r): "y:\(r.id)"
        }
    }
}

public enum TurnOutcome: Equatable, Sendable {
    case running, completed, failed(message: String, code: String), stopped, interrupted, maxTokens
}

public struct Turn: Identifiable, Equatable, Sendable {
    public let id: Int
    public var opening: [UserInput] = []
    public var elements: [TurnElement] = []
    public var outcome: TurnOutcome = .running
    public var startedAt: Int?
    public var endedAt: Int?

    public var isClosed: Bool { outcome != .running }
    /// Process content the whole-turn control can fold: everything but replies and inputs.
    public var hasProcess: Bool { elements.contains { if case .group = $0 { return true }; if case .retry = $0 { return true }; return false } }
    /// 整轮折叠资格: closed, not failed or stopped, and no input arrived after the process started.
    public var foldable: Bool {
        guard hasProcess else { return false }
        switch outcome {
        case .completed, .maxTokens: break
        default: return false
        }
        return !elements.contains { if case .input = $0 { return true }; return false }
    }
    /// The last settled reply with visible text and no later process content.
    public var finalReplyID: String? {
        guard isClosed, case .reply(let r)? = elements.last else { return nil }
        return r.id
    }
    public var toolCallCount: Int { elements.reduce(0) { n, e in if case .group(let g) = e { return n + g.allTools.count }; return n } }
    public var durationMs: Int? {
        guard let s = startedAt, let e = endedAt else { return nil }
        return max(1000, e - s)
    }
    /// The turn control's text once the turn is closed.
    public var controlLabel: String {
        switch outcome {
        case .stopped, .interrupted: return "已停止"
        case .failed: return "处理失败"
        case .running: return ""
        default: return durationMs == nil ? "已完成" : "已完成，用时 "
        }
    }
    /// Duration shown after "已完成，用时 ", in the desktop's compact form.
    public var durationLabel: String? {
        switch outcome { case .completed, .maxTokens: return durationMs.map(Elapsed.compact); default: return nil }
    }
}

public enum Elapsed {
    /// "8秒", "2分5秒", "1小时3分".
    public static func compact(_ ms: Int) -> String {
        let s = max(1, ms / 1000)
        if s < 60 { return "\(s)秒" }
        if s < 3600 { return "\(s / 60)分\(s % 60)秒" }
        return "\(s / 3600)小时\((s % 3600) / 60)分"
    }
    /// The running indicator: "深度求索中，用时 12秒 ···".
    public static func running(since start: Int?, now: Int) -> String {
        guard let start else { return "深度求索中" }
        return "深度求索中，用时 \(compact(max(1000, now - start))) ···"
    }
}

enum Paths {
    /// Workspace-relative where possible; the home directory as `~`.
    static func display(_ path: String, cwd: String, home: String) -> String {
        guard !path.isEmpty else { return path }
        for root in [cwd].filter({ !$0.isEmpty }) {
            let sep = root.contains("\\") ? "\\" : "/"
            let prefix = root.hasSuffix(sep) ? root : root + sep
            if path.lowercased().hasPrefix(prefix.lowercased()) { return String(path.dropFirst(prefix.count)) }
        }
        if !home.isEmpty, path.lowercased().hasPrefix(home.lowercased()) { return "~" + path.dropFirst(home.count) }
        return path
    }
}

func firstLine(_ text: String) -> String {
    text.firstIndex(of: "\n").map { String(text[..<$0]) } ?? text
}

/// Builds the turn model from a session's events plus the live assistant attempt.
public enum ConversationBuilder {
    static let triggerLabels: [String: String] = [
        "schedule": "自动化任务", "tool-jobs": "后台任务状态更新", "cordis-host-runner": "插件状态更新", "goal": "继续执行目标",
        "agent": "收到任务消息", "team": "收到团队消息", "subagent": "子任务状态更新", "webhook": "收到外部事件", "request": "收到执行请求",
    ]

    public static func build(_ transcript: Transcript) -> [Turn] {
        var turns: [Turn] = []
        var pendingInputs: [UserInput] = []
        var groupSerial = 0
        var index: [String: (turn: Int, element: Int, item: Int)] = [:]

        func current() -> Int {
            if turns.isEmpty { turns.append(Turn(id: 0)) }
            return turns.count - 1
        }
        func closeGroup(_ t: Int) {
            if case .group(var g)? = turns[t].elements.last, !g.closed {
                g.closed = true; turns[t].elements[turns[t].elements.count - 1] = .group(g)
            }
        }
        func openGroup(_ t: Int) -> Int {
            if case .group(let g)? = turns[t].elements.last, !g.closed { return turns[t].elements.count - 1 }
            groupSerial += 1
            turns[t].elements.append(.group(ProcessGroup(id: "\(turns[t].id).\(groupSerial)", items: [], closed: false)))
            return turns[t].elements.count - 1
        }
        func append(_ item: ProcessItem, to t: Int) {
            let e = openGroup(t)
            guard case .group(var g) = turns[t].elements[e] else { return }
            g.items.append(item)
            turns[t].elements[e] = .group(g)
            if case .tool(let row) = item { index[row.id] = (t, e, g.items.count - 1) }
        }
        func updateTool(_ id: String, _ change: (inout ToolRow) -> Void) {
            guard let at = index[id], case .group(var g) = turns[at.turn].elements[at.element], case .tool(var row) = g.items[at.item] else { return }
            change(&row); g.items[at.item] = .tool(row); turns[at.turn].elements[at.element] = .group(g)
        }
        func addReply(_ id: String, _ text: String, streaming: Bool, to t: Int) {
            closeGroup(t)
            if case .reply(var r)? = turns[t].elements.last, r.id == id {
                r.text += "\n\n" + text; r.streaming = streaming; turns[t].elements[turns[t].elements.count - 1] = .reply(r)
            } else {
                turns[t].elements.append(.reply(Reply(id: id, text: text, streaming: streaming)))
            }
        }
        func hasProcessEvidence(_ t: Int) -> Bool { !turns[t].elements.isEmpty }

        for event in transcript.events {
            let d = event.data
            switch event.type {
            case "turn/start":
                if let last = turns.indices.last { closeGroup(last) }
                var turn = Turn(id: d["turn"].int)
                turn.startedAt = event.raw["time"].int
                turn.opening = pendingInputs; pendingInputs = []
                turns.append(turn)
            case "user/message":
                let kind = d["source"]["kind"].string
                let label = triggerLabels[kind]
                guard kind == "user" || label != nil else { continue } // ordinary context stays hidden
                let blocks = d["content"].array
                let text = blocks.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n")
                let input = UserInput(id: d["id"].string.isEmpty ? "\(event.id)" : d["id"].string, text: text,
                                      attachments: blocks.filter { $0["type"].string != "text" }.count,
                                      attachmentBlocks: blocks.filter { ["image", "file"].contains($0["type"].string) },
                                      time: event.raw["time"].int,
                                      kind: label.map { .trigger($0) } ?? .user)
                if turns.isEmpty || turns.last!.isClosed { pendingInputs.append(input); continue }
                let t = turns.count - 1
                if hasProcessEvidence(t) { closeGroup(t); turns[t].elements.append(.input(input)) } else { turns[t].opening.append(input) }
            case "assistant/message":
                let t = current()
                let message = d["message"]
                let id = message["id"].string.isEmpty ? "\(event.id)" : message["id"].string
                var replyText: [String] = []
                for (i, block) in message["content"].array.enumerated() {
                    switch block["type"].string {
                    case "reasoning":
                        let text = block["text"].string
                        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                        append(.reasoning(ReasoningRow(id: "\(id).\(i)", text: text, streaming: false)), to: t)
                    case "text":
                        let text = block["text"].string
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { replyText.append(text) }
                    default: break
                    }
                }
                if !replyText.isEmpty { addReply(id, replyText.joined(separator: "\n\n"), streaming: false, to: t) }
            case "tool/call":
                let t = current()
                let id = d["callId"].string
                var row = ToolRow(id: id, name: d["name"].string, argsRaw: d["arguments"].string, state: .running, time: event.raw["time"].int)
                if let parent = d["parentCallId"].stringValue, index[parent] != nil {
                    row.state = .running
                    updateTool(parent) { $0.subCalls.append(row) }
                    continue
                }
                if index[id] != nil { updateTool(id) { $0.argsRaw = row.argsRaw; $0.state = .running } } else { append(.tool(row), to: t) }
            case "tool/result":
                let message = d["message"]
                let id = message["toolCallId"].string.isEmpty ? message["source"]["callId"].string : message["toolCallId"].string
                let output = message["content"].array.map { $0["type"].string == "text" ? $0["text"].string : (String(data: (try? $0.encoded()) ?? Data(), encoding: .utf8) ?? "") }.joined(separator: "\n")
                let error = message["error"]
                let state: ToolState = error["code"].string == "interrupted" ? .stopped
                    : message["isError"].bool || d["meta"]["stopped"].bool ? .error : .ok
                let fallback = output.isEmpty && error != .null ? "\(error["name"].string): \(error["code"].string)" : output
                updateTool(id) { $0.state = state; $0.output = fallback.isEmpty ? nil : fallback }
            case "job/settled":
                let id = d["toolCall"]["callId"].string
                if let code = d["detail"].string.split(separator: ":").last.flatMap({ Int($0.trimmingCharacters(in: .whitespaces)) }) {
                    updateTool(id) { $0.exitCode = code }
                }
            case "llm/retry", "llm/retry-started":
                let t = current()
                closeGroup(t)
                let id = d["retryId"].string
                if case .retry(var r)? = turns[t].elements.last, r.id == id {
                    if event.type == "llm/retry" { r.retry = d["retry"].int; r.maximum = d["maxRetries"].int; r.delayMs = d["delayMs"].int; r.started = false; r.failure = d["failure"]["message"].string } else { r.started = true }
                    turns[t].elements[turns[t].elements.count - 1] = .retry(r)
                } else if event.type == "llm/retry" {
                    turns[t].elements.append(.retry(RetryRow(id: id, retry: d["retry"].int, maximum: d["maxRetries"].int, delayMs: d["delayMs"].int, started: false, failure: d["failure"]["message"].string)))
                }
            case "turn/end":
                let t = current()
                closeGroup(t)
                turns[t].endedAt = event.raw["time"].int
                let reason = d["reason"]
                switch reason["kind"].string {
                case "completed": turns[t].outcome = .completed
                case "error": turns[t].outcome = .failed(message: reason["error"]["message"].string, code: reason["error"]["code"].string)
                case "aborted", "cancelled": turns[t].outcome = .stopped
                case "interrupted": turns[t].outcome = .interrupted
                case "max-tokens", "maxTokens", "length": turns[t].outcome = .maxTokens
                default: turns[t].outcome = .completed
                }
                // Calls still open when the turn ends did not finish.
                for (id, at) in index where at.turn == t {
                    updateTool(id) { if $0.isLive { $0.state = .stopped } }
                }
            default: continue
            }
        }

        // The live attempt belongs to the open turn.
        if let t = turns.indices.last, !turns[t].isClosed, !transcript.live.isEmpty {
            for (i, block) in transcript.liveBlocks.enumerated() {
                switch block["type"].string {
                case "reasoning":
                    guard !block["text"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    append(.reasoning(ReasoningRow(id: "live.\(transcript.attemptID).\(i)", text: block["text"].string, streaming: true)), to: t)
                case "text":
                    guard !block["text"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    addReply("live.\(transcript.attemptID).\(i)", block["text"].string, streaming: true, to: t)
                case "tool-call":
                    let id = block["id"].string
                    guard index[id] == nil, !block["name"].string.isEmpty else { continue }
                    append(.tool(ToolRow(id: id, name: block["name"].string, argsRaw: block["arguments"].string, state: .preparing, time: Int(Date().timeIntervalSince1970 * 1000))), to: t)
                default: break
                }
            }
        }
        if !pendingInputs.isEmpty {
            var queued = Turn(id: (turns.last?.id ?? 0) + 1)
            queued.opening = pendingInputs
            turns.append(queued)
        }
        return turns.filter { !$0.opening.isEmpty || !$0.elements.isEmpty || $0.isClosed }
    }
}

extension JSON {
    /// A string value, or nil for anything else (unlike `string`, which flattens to "").
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
}
