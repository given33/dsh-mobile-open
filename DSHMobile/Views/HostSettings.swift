import SwiftUI
import DSHCore

struct PermissionSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var options: [JSON] = []
    @State private var candidate: JSON?
    @State private var loading = true
    @State private var saving = false
    @State private var problem: String?
    @State private var selected: String?

    private var current: String {
        selected ?? model.directory[sessionID]?.projection["permissions"]["currentValue"].string ?? ""
    }

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if loading { ProgressView("正在读取权限预设") }
                if !current.isEmpty { LabeledContent("当前预设", value: options.first(where: { $0["value"].string == current })?["name"].string ?? current) }
                ForEach(options, id: \.self) { row in
                    Button { candidate = row } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row["name"].string.isEmpty ? row["value"].string : row["name"].string)
                                if !row["description"].string.isEmpty {
                                    Text(row["description"].string).font(DSHFont.meta).foregroundStyle(Theme.meta)
                                }
                            }
                            Spacer()
                            if row["value"].string == current { Image(systemName: "checkmark") }
                        }
                    }
                    .disabled(!model.canWrite || saving || row["value"].string == current)
                }
                NavigationLink("编辑桌面权限与审批配置") {
                    HostSettingsList(filter: .permissions)
                }
            }
            .navigationTitle("会话权限").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
            .confirmationDialog("切换会话权限？", isPresented: Binding(get: { candidate != nil }, set: { if !$0 { candidate = nil } }),
                                titleVisibility: .visible, presenting: candidate) { option in
                Button("使用「\(option["name"].string)」", role: option["value"].string == "danger-full-access" ? .destructive : nil) {
                    Task { await select(option["value"].string) }
                }
                Button("取消", role: .cancel) {}
            } message: { option in Text(option["description"].string) }
        }
    }

    private func load() async {
        loading = true; problem = nil; defer { loading = false }
        do { options = try await model.read("permissionPresets/catalog", args: .object([:]))["options"].array }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func select(_ preset: String) async {
        guard !saving else { return }
        saving = true; problem = nil; defer { saving = false }
        do {
            let result = try await model.action("mobilePermissions/select", args: .object(["sessionId": .string(sessionID), "preset": .string(preset)]))
            guard result != .null else { throw ClientError.message("此会话未启用权限切换命令。") }
            let outcome = result["result"]
            if ["error", "failed"].contains(outcome["kind"].string) {
                throw ClientError.message(outcome["text"].string.isEmpty ? "电脑拒绝了权限切换。" : outcome["text"].string)
            }
            selected = preset
        } catch { problem = error.localizedDescription }
    }
}

enum HostSettingsFilter {
    case all, permissions, providers
    func allows(_ id: String) -> Bool {
        switch self {
        case .all: true
        case .providers: ["llm", "model", "provider"].contains { id.localizedCaseInsensitiveContains($0) }
        case .permissions: ["permission", "approval", "sandbox"].contains { id.localizedCaseInsensitiveContains($0) }
        }
    }
}

struct HostSettingsList: View {
    var filter: HostSettingsFilter = .all
    @EnvironmentObject private var model: AppModel
    @State private var state: JSON?
    @State private var problem: String?
    @State private var query = ""

    private var namespaces: [JSON] {
        (state?["namespaces"].array ?? []).filter {
            let id = $0["ns"].string
            return filter.allows(id) && (query.isEmpty || id.localizedCaseInsensitiveContains(query))
        }.sorted { $0["ns"].string < $1["ns"].string }
    }

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if state == nil && problem == nil { ProgressView("正在读取电脑配置") }
            if state != nil && namespaces.isEmpty {
                ContentUnavailableView("没有匹配的配置", systemImage: "gear")
            }
            ForEach(namespaces, id: \.self) { section in
                NavigationLink {
                    HostNamespaceEditor(original: section, writable: state?["writable"].bool == true)
                } label: { Text(section["ns"].string) }
            }
        }
        .navigationTitle("桌面设置").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "查找配置")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            state = try await model.read("settings/describe", args: .object([:]))
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

@MainActor private final class NamespaceState: ObservableObject {
    @Published var raw: JSON
    @Published var problem: String?
    @Published var saving = false
    let hostWritable: Bool
    init(raw: JSON, writable: Bool) { self.raw = raw; hostWritable = writable }

    var ns: String { raw["ns"].string }
    func value(_ path: [String], key: String = "value") -> JSON {
        path.reduce(raw[key]) { $0[$1] }
    }
    func secrets(_ path: [String]) -> [JSON] {
        raw["secrets"].array.filter { $0["path"].array.map(\.string).starts(with: path) }
    }
    func secret(_ path: [String]) -> JSON? {
        secrets(path).first { $0["path"].array.map(\.string) == path }
    }
    func names(_ path: [String]) -> [String] {
        var keys = Set(value(path).object.keys)
        for secret in secrets(path) {
            let segments = secret["path"].array.map(\.string)
            if segments.count > path.count { keys.insert(segments[path.count]) }
        }
        return keys.sorted()
    }
    func apply(_ model: AppModel, path: [String], value: JSON?) async -> Bool {
        guard !saving, model.canWrite, hostWritable else { return false }
        saving = true; problem = nil; defer { saving = false }
        var op: [String: JSON] = ["op": .string(value == nil ? "unset" : "set"), "path": .array(path.map(JSON.string))]
        if let value { op["value"] = value }
        do {
            raw = try await model.action("settings/mutate", args: .object([
                "ns": .string(ns), "expectedRevision": raw["revision"], "ops": .array([.object(op)])
            ]))
            return true
        } catch {
            problem = secret(path) != nil ? "电脑未保存该凭据。请重新读取配置再试。" : error.localizedDescription
            return false
        }
    }
    func reload(_ model: AppModel) async {
        let wanted = ns
        do {
            let result = try await model.read("settings/describe", args: .object([:]))
            guard let section = result["namespaces"].array.first(where: { $0["ns"].string == wanted }) else {
                throw ClientError.message("该设置已从电脑移除。")
            }
            raw = section; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

@MainActor struct HostNamespaceEditor: View {
    @StateObject private var state: NamespaceState
    private let basePath: [String]
    init(original: JSON, writable: Bool, basePath: [String] = []) {
        _state = StateObject(wrappedValue: NamespaceState(raw: original, writable: writable))
        self.basePath = basePath
    }

    var body: some View {
        NamespaceFolder(path: basePath).environmentObject(state)
    }
}

private struct NamespaceFolder: View {
    let path: [String]
    @EnvironmentObject private var state: NamespaceState
    @EnvironmentObject private var model: AppModel
    @State private var add = false
    @State private var fieldName = ""

    private var canWrite: Bool { model.canWrite && state.hostWritable && !state.saving }

    var body: some View {
        List {
            if let problem = state.problem { Text(problem).foregroundStyle(Theme.warnText) }
            if state.names(path).isEmpty {
                Text("没有已解析的配置项。").foregroundStyle(Theme.meta)
            }
            ForEach(state.names(path), id: \.self) { key in
                let target = path + [key]
                let raw = state.value(target)
                if case .object = raw {
                    NavigationLink(key) { NamespaceFolder(path: target) }
                } else if state.secret(target) == nil && !state.names(target).isEmpty {
                    NavigationLink(key) { NamespaceFolder(path: target) }
                } else {
                    NavigationLink {
                        NamespaceField(path: target)
                    } label: {
                        LabeledContent(key) {
                            if let secret = state.secret(target) {
                                Label(secret["set"].bool ? "已设置" : "未设置", systemImage: "lock")
                            } else {
                                Text(raw.string.isEmpty ? raw.pretty : raw.string).lineLimit(1)
                            }
                        }
                    }
                }
            }
            if canWrite {
                Button { fieldName = ""; add = true } label: { Label("添加配置项", systemImage: "plus.circle") }
            }
        }
        .navigationTitle(path.last ?? state.ns).navigationBarTitleDisplayMode(.inline)
        .refreshable { await state.reload(model) }
        .sheet(isPresented: $add) {
            NavigationStack {
                Form {
                    TextField("字段名称", text: $fieldName).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !fieldName.isEmpty && !state.names(path).contains(fieldName) {
                        NavigationLink("输入字段值") { NamespaceField(path: path + [fieldName]) }
                    }
                }
                .navigationTitle("添加配置项").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { add = false } } }
            }
        }
    }
}

private struct NamespaceField: View {
    enum Kind: String, CaseIterable { case text = "文本", boolean = "开关", number = "数字", json = "JSON" }
    let path: [String]
    @EnvironmentObject private var state: NamespaceState
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var flag = false
    @State private var kind = Kind.text
    @State private var reset = false

    private var secret: JSON? { state.secret(path) }
    private var canWrite: Bool { model.canWrite && state.hostWritable && !state.saving }
    private var parsed: JSON? {
        if secret != nil { return text.isEmpty ? nil : .string(text) }
        switch kind {
        case .text: return .string(text)
        case .boolean: return .bool(flag)
        case .number:
            guard let value = Double(text), value.isFinite else { return nil }
            return .number(value)
        case .json: return try? JSON.parse(Data(text.utf8))
        }
    }

    var body: some View {
        Form {
            if let problem = state.problem { Text(problem).foregroundStyle(Theme.warnText) }
            Section("配置值") {
                if let secret {
                    Text(secret["set"].bool ? "凭据已设置。请输入新值以替换。" : "尚未设置。")
                    SecureField("新值", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
                } else {
                    Picker("类型", selection: $kind) { ForEach(Kind.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    switch kind {
                    case .text: TextField("值", text: $text, axis: .vertical).textInputAutocapitalization(.never)
                    case .boolean: Toggle("启用", isOn: $flag)
                    case .number: TextField("值", text: $text).keyboardType(.numbersAndPunctuation)
                    case .json:
                        TextEditor(text: $text).font(DSHFont.code).frame(minHeight: 180)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
            }.disabled(!canWrite)
            if canWrite {
                Section {
                    Button("保存") { Task { await save() } }.disabled(parsed == nil)
                    if state.value(path, key: "user") != .null || secret?["set"].bool == true {
                        Button("移除覆盖值", role: .destructive) { reset = true }
                    }
                }
            }
        }
        .navigationTitle(path.last ?? "设置").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            switch state.value(path) {
            case .string(let value): kind = .text; text = value
            case .bool(let value): kind = .boolean; flag = value
            case .number(let value): kind = .number; text = String(value)
            case .null: kind = .text
            default: kind = .json; text = state.value(path).pretty
            }
        }
        .confirmationDialog("移除覆盖值？", isPresented: $reset, titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                Task { if await state.apply(model, path: path, value: nil) { dismiss() } }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private func save() async {
        guard let value = parsed else { return }
        if await state.apply(model, path: path, value: value) {
            text = ""
            dismiss()
        }
    }
}
