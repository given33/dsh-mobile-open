import SwiftUI
import SwiftTerm
import DSHCore

struct TerminalsSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [JSON] = []
    @State private var shells: [JSON] = []
    @State private var problem: String?
    @State private var rename: JSON?
    @State private var newName = ""
    @State private var closing: JSON?
    @State private var selected: String?
    @State private var busy = false

    private var allowed: Bool { model.canUseTerminal && !busy }

    var body: some View {
        NavigationStack {
            List {
                if !model.canUseTerminal {
                    Label("在电脑的「手机连接」里打开「允许手机使用终端」。", systemImage: "lock")
                }
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if rows.isEmpty {
                    ContentUnavailableView("暂无终端", systemImage: "terminal")
                }
                ForEach(rows, id: \.self) { row in
                    let id = row["id"].string
                    Button {
                        selected = id
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Label(row["title"].string.isEmpty ? "终端" : row["title"].string, systemImage: "terminal")
                            Text(row["cwd"].string).font(DSHFont.code).foregroundStyle(Theme.meta)
                        }
                    }
                    .disabled(!allowed)
                    .contextMenu {
                        Button("重命名") { newName = row["title"].string; rename = row }.disabled(!allowed)
                        Button("关闭终端", role: .destructive) { closing = row }.disabled(!allowed)
                    }
                }
            }
            .navigationTitle("终端").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("默认 Shell") { Task { await create(nil) } }
                        ForEach(shells, id: \.self) { shell in
                            Button(shell["name"].string) { Task { await create(shell["path"].string) } }
                        }
                    } label: { Image(systemName: "plus").accessibilityLabel("新建终端") }
                    .disabled(!allowed)
                }
            }
            .navigationDestination(item: $selected) { id in
                TerminalDetail(sessionID: sessionID, id: id)
            }
            .task(id: model.canUseTerminal) { await load() }
            .refreshable { await load() }
            .alert("重命名终端", isPresented: binding($rename), presenting: rename) { row in
                TextField("名称", text: $newName)
                Button("保存") {
                    let title = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty { Task { await change("rename", row: row, extra: ["title": .string(title)]) } }
                }
                Button("取消", role: .cancel) {}
            }
            .confirmationDialog("关闭这个终端？", isPresented: binding($closing), titleVisibility: .visible, presenting: closing) { row in
                Button("关闭终端", role: .destructive) { Task { await change("close", row: row) } }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func binding(_ item: Binding<JSON?>) -> Binding<Bool> {
        Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })
    }

    private func load() async {
        guard model.isOnline else { return }
        do {
            rows = try await model.read("terminal/list", args: .object(["sessionId": .string(sessionID)])).array
            if model.canUseTerminal {
                shells = (try? await model.read("terminal/shells", args: .object(["agentId": .string(sessionID)])))?.array ?? []
            }
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func create(_ shell: String?) async {
        guard allowed else { return }
        busy = true; defer { busy = false }
        var request: [String: JSON] = ["id": .string(UUID().uuidString.lowercased()), "cols": .number(80), "rows": .number(24)]
        if let shell { request["shellPath"] = .string(shell) }
        do {
            let row = try await model.action("terminal/create", args: .object(["agentId": .string(sessionID), "request": .object(request)]))
            let id = row["id"].string
            guard !id.isEmpty else { throw LinkError.badResponse }
            await load()
            selected = id
        } catch { problem = error.localizedDescription }
    }

    private func change(_ verb: String, row: JSON, extra: [String: JSON] = [:]) async {
        guard allowed else { return }
        busy = true; defer { busy = false }
        var args = extra; args["id"] = row["id"]; args["agentId"] = .string(sessionID)
        do {
            try await model.action("terminal/\(verb)", args: .object(args))
            await load()
        } catch { problem = error.localizedDescription }
    }
}

private struct TerminalDetail: View {
    let sessionID: String
    let id: String
    @EnvironmentObject private var model: AppModel
    @StateObject private var channel = TerminalChannel()
    @State private var retry = 0

    var body: some View {
        VStack(spacing: 0) {
            if let issue = channel.issue {
                HStack {
                    Label(issue, systemImage: "exclamationmark.circle")
                    Spacer()
                    Button("重新连接") { retry += 1 }
                }.padding(8)
            } else if !model.canUseTerminal {
                Label("终端访问已关闭", systemImage: "lock").padding(8)
            } else if !channel.ready {
                ProgressView("正在连接终端").padding(8)
            } else if !channel.writable {
                Label("当前终端无法接收输入", systemImage: "eye").padding(8)
            }
            TerminalCanvas(channel: channel)
                .accessibilityIdentifier("native-terminal")
        }
        .navigationTitle(channel.title).navigationBarTitleDisplayMode(.inline)
        .task(id: "\(model.canUseTerminal)-\(retry)") {
            guard model.canUseTerminal else { channel.disconnect(); return }
            await channel.connect(model, sessionID: sessionID, id: id)
        }
    }
}

@MainActor private final class TerminalChannel: ObservableObject {
    @Published var title = "终端"
    @Published var issue: String?
    @Published var ready = false
    @Published var writable = false
    private weak var view: TerminalView?
    private weak var model: AppModel?
    private var streamID = ""
    private var waiting: [[String: JSON]] = []
    private var unacked: Int?
    private var sequence = 0
    private var size: (Int, Int)?
    private var feedBuffer = ""
    private var receiving = false

    func attach(_ canvas: TerminalView) {
        view = canvas
        if !feedBuffer.isEmpty { feed(feedBuffer); feedBuffer = "" }
    }

    func connect(_ model: AppModel, sessionID: String, id: String) async {
        disconnect()
        issue = nil
        self.model = model
        let stream = "terminal-" + UUID().uuidString
        streamID = stream
        defer { if streamID == stream { disconnect() } }
        do {
            let args = JSON.object(["agentId": .string(sessionID), "id": .string(id)])
            for try await frame in model.observe("terminal/attach", args: args, streamID: stream) {
                guard !Task.isCancelled, streamID == stream else { return }
                switch frame["type"].string {
                case "snapshot":
                    view?.getTerminal().resetToInitialState()
                    feedBuffer = ""
                    feed(frame["screen"].string)
                    ready = true
                    apply(frame)
                    if let size, size.0 != frame["info"]["cols"].int || size.1 != frame["info"]["rows"].int {
                        resize(size.0, size.1)
                    }
                case "output": feed(frame["data"].string)
                case "state": apply(frame)
                case "ack":
                    guard unacked == frame["sequence"].int else { continue }
                    unacked = nil
                    if !frame["refusal"].string.isEmpty {
                        waiting.removeAll()
                        writable = false
                    } else { drain() }
                default: break
                }
            }
        } catch { if !Task.isCancelled && streamID == stream { issue = error.localizedDescription } }
    }

    func disconnect() {
        streamID = ""; ready = false; writable = false
        waiting.removeAll(); unacked = nil; sequence = 0
    }

    private func apply(_ frame: JSON) {
        writable = frame["writable"].bool
        let nextTitle = frame["info"]["title"].string
        if !nextTitle.isEmpty { title = nextTitle }
        if !frame["info"]["error"].string.isEmpty { issue = frame["info"]["error"].string }
        if !writable { waiting.removeAll() }
    }

    private func feed(_ text: String) {
        guard let view else {
            feedBuffer += text
            if feedBuffer.count > 500_000 { feedBuffer = String(feedBuffer.suffix(500_000)) }
            return
        }
        receiving = true
        view.feed(text: text)
        receiving = false
    }

    func input(_ data: ArraySlice<UInt8>) {
        guard !receiving, writable, !data.isEmpty else { return }
        guard data.count <= 24_000 else { issue = "一次粘贴最多 24 KB。"; return }
        enqueue(["type": .string("write"), "data": .string(String(decoding: data, as: UTF8.self))])
    }

    func resize(_ cols: Int, _ rows: Int) {
        guard (2...500).contains(cols), (2...500).contains(rows), !receiving else { return }
        size = (cols, rows)
        guard writable else { return }
        let value: [String: JSON] = ["type": .string("resize"), "cols": .number(Double(cols)), "rows": .number(Double(rows))]
        if waiting.last?["type"] == .string("resize") { waiting[waiting.count - 1] = value }
        else { enqueue(value) }
    }

    private func enqueue(_ value: [String: JSON]) {
        guard waiting.count < 48 else { issue = "终端输入太快，等待电脑处理后请重试。"; return }
        waiting.append(value)
        drain()
    }

    private func drain() {
        guard writable, unacked == nil, !waiting.isEmpty, let model, !streamID.isEmpty else { return }
        var value = waiting.removeFirst()
        sequence += 1
        value["sequence"] = .number(Double(sequence))
        unacked = sequence
        let stream = streamID
        Task {
            do { try await model.sendTerminal(stream, .object(value)) }
            catch {
                if streamID == stream {
                    issue = error.localizedDescription
                    writable = false; waiting.removeAll()
                }
            }
        }
    }
}

private struct TerminalCanvas: UIViewRepresentable {
    let channel: TerminalChannel
    func makeCoordinator() -> Coordinator { Coordinator(channel) }
    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 13, weight: .regular))
        view.terminalDelegate = context.coordinator
        channel.attach(view)
        return view
    }
    func updateUIView(_ uiView: TerminalView, context: Context) {}

    final class Coordinator: NSObject, TerminalViewDelegate {
        let channel: TerminalChannel
        init(_ channel: TerminalChannel) { self.channel = channel }
        func send(source: TerminalView, data: ArraySlice<UInt8>) { Task { @MainActor in channel.input(data) } }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            Task { @MainActor in channel.resize(newCols, newRows) }
        }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
