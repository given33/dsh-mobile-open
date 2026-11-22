import SwiftUI
import DSHCore

struct NativePluginPanels: View {
    @EnvironmentObject private var model: AppModel
    @State private var panels: [JSON]?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if panels == nil && problem == nil { ProgressView("正在读取原生面板") }
            ForEach(panels ?? [], id: \.self) { panel in
                NavigationLink {
                    NativePluginPanel(summary: panel)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(panel["title"].string)
                        Text(panel["owner"].string).font(DSHFont.meta).foregroundStyle(Theme.meta)
                    }
                }.accessibilityIdentifier("native-panel-" + panel["id"].string)
            }
            if panels?.isEmpty == true {
                ContentUnavailableView("没有原生插件面板", systemImage: "puzzlepiece.extension",
                                       description: Text("这里会显示电脑插件发布的手机面板。"))
            }
        }
        .navigationTitle("原生插件面板").navigationBarTitleDisplayMode(.inline)
        .task { await load() }.refreshable { await load() }
    }

    private func load() async {
        do { panels = try await model.read("mobilePanels/list", args: .object([:])).array; problem = nil }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct NativePluginPanel: View {
    let summary: JSON
    @EnvironmentObject private var model: AppModel
    @State private var panel: JSON?
    @State private var strings: [String: String] = [:]
    @State private var toggles: [String: Bool] = [:]
    @State private var loading = false
    @State private var busy = false
    @State private var pending: JSON?
    @State private var problem: String?
    @State private var message: String?

    private var id: JSON { summary["id"] }
    private var fields: [JSON] { panel?["fields"].array ?? [] }
    private var actions: [JSON] { panel?["actions"].array ?? [] }
    private var writable: Bool { model.canWrite && !actions.isEmpty && !loading && !busy }

    var body: some View {
        Form {
            if !summary["detail"].string.isEmpty { Text(summary["detail"].string).foregroundStyle(Theme.meta) }
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if let message { Text(message).foregroundStyle(Theme.meta) }
            if loading || busy { ProgressView() }
            if let panel, !panel["info"].array.isEmpty {
                Section("状态") {
                    let information = panel["info"].array
                    ForEach(information.indices, id: \.self) { index in
                        let row = information[index]
                        LabeledContent(row["title"].string, value: row["value"].string).textSelection(.enabled)
                    }
                }
            }
            if !fields.isEmpty {
                Section("选项") { ForEach(fields, id: \.self) { field in fieldRow(field) } }
                    .disabled(!writable)
            }
            if !actions.isEmpty {
                Section("操作") {
                    ForEach(actions, id: \.self) { action in
                        Button(action["title"].string) {
                            if action["confirm"].bool { pending = action }
                            else { Task { await run(action) } }
                        }.disabled(!writable || inputs == nil)
                    }
                }
            }
        }
        .navigationTitle(summary["title"].string).navigationBarTitleDisplayMode(.inline)
        .task { await load() }.refreshable { if !busy { await load() } }
        .confirmationDialog("运行插件操作？", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible, presenting: pending) { action in
            Button("确认\(action["title"].string)") { Task { await run(action) } }
            Button("取消", role: .cancel) {}
        } message: { _ in Text(summary["owner"].string) }
    }

    @ViewBuilder private func fieldRow(_ field: JSON) -> some View {
        let key = field["id"].string
        let title = field["title"].string
        let value = Binding(get: { strings[key] ?? "" }, set: { strings[key] = $0 })
        switch field["kind"].string {
        case "toggle":
            Toggle(title, isOn: Binding(get: { toggles[key] ?? false }, set: { toggles[key] = $0 }))
        case "select":
            Picker(title, selection: value) {
                Text("请选择").tag("")
                ForEach(field["options"].array, id: \.self) { Text($0["title"].string).tag($0["id"].string) }
            }
        case "number":
            TextField(title, text: value).keyboardType(.numbersAndPunctuation)
        case "secret":
            SecureField(title, text: value).textInputAutocapitalization(.never).autocorrectionDisabled()
        case "multiline":
            TextField(title, text: value, axis: .vertical).lineLimit(3...8)
        default:
            TextField(title, text: value)
        }
        if !field["detail"].string.isEmpty { Text(field["detail"].string).font(DSHFont.meta).foregroundStyle(Theme.meta) }
    }

    private var inputs: [String: JSON]? {
        var values: [String: JSON] = [:]
        for field in fields {
            let id = field["id"].string
            let text = strings[id] ?? ""
            switch field["kind"].string {
            case "toggle": values[id] = .bool(toggles[id] ?? false)
            case "number":
                if let number = Double(text), number.isFinite { values[id] = .number(number) }
                else if !text.isEmpty { return nil }
            case "select", "secret":
                if !text.isEmpty { values[id] = .string(text) }
            default:
                if !text.isEmpty || field["value"] != .null { values[id] = .string(text) }
            }
            if field["required"].bool && (values[id] == nil ||
                (["text", "multiline", "secret"].contains(field["kind"].string) && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) {
                return nil
            }
        }
        return values
    }

    private func load() async {
        guard !loading else { return }
        loading = true; problem = nil; defer { loading = false }
        do {
            let fresh = try await model.read("mobilePanels/read", args: .object(["id": id]))
            guard fresh["version"].int == 1 else { throw ClientError.message("此面板需要更新手机 App。") }
            panel = fresh; strings = [:]; toggles = [:]
            for field in fields {
                let key = field["id"].string
                if case .number(let value) = field["value"] { strings[key] = String(value) }
                else if case .bool(let value) = field["value"] { toggles[key] = value }
                else if field["kind"].string != "secret" { strings[key] = field["value"].string }
            }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func run(_ action: JSON) async {
        guard writable, let inputs, let panel else { return }
        busy = true; problem = nil; message = nil
        defer {
            busy = false
            for field in fields where field["kind"].string == "secret" { strings[field["id"].string] = "" }
        }
        do {
            let result = try await model.action("mobilePanels/perform", args: .object([
                "id": id, "action": action["id"], "expectedRevision": panel["revision"], "values": .object(inputs)
            ]))
            message = result["message"].string.isEmpty ? "已完成。" : result["message"].string
            await load()
        } catch { problem = error.localizedDescription }
    }
}
