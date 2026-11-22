import SwiftUI
import DSHCore

struct ProvidersView: View {
    @EnvironmentObject private var model: AppModel
    @State private var rows: [JSON] = []
    @State private var settings: JSON?
    @State private var problem: String?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if settings == nil && problem == nil { ProgressView("正在读取供应商") }
            Section("供应商") {
                ForEach(rows, id: \.self) { row in
                    NavigationLink {
                        ProviderDetail(row: row, settings: settings ?? .null)
                    } label: {
                        LabeledContent(row["displayName"].string, value: row["provider"].string)
                    }
                }
                if settings != nil && rows.isEmpty { Text("电脑没有发布可配置的供应商。") }
            }
            Section("配置") {
                NavigationLink("按引用管理凭据") { CredentialEditor(initialRef: "") }
                NavigationLink("编辑供应商配置与自定义路由") { HostSettingsList(filter: .providers) }
            }
        }
        .navigationTitle("模型供应商").navigationBarTitleDisplayMode(.inline)
        .task { await load() }.refreshable { await load() }
    }

    private func load() async {
        do {
            async let entries = model.read("llm/listConfigurableProviders", args: .object([:]))
            async let configuration = model.read("settings/describe", args: .object([:]))
            let (providers, document) = try await (entries, configuration)
            rows = providers.array; settings = document; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct ProviderDetail: View {
    let row: JSON
    let settings: JSON
    private var ns: String { row["settingsNs"].string }
    private var path: [String] { row["settingsPath"].array.map(\.string) }
    private var section: JSON? { settings["namespaces"].array.first { $0["ns"].string == ns } }
    private var profile: JSON { path.reduce(section?["value"] ?? .null) { $0[$1] } }
    private var endpoint: String {
        let configured = profile["baseURL"].string
        return configured.isEmpty ? row["defaultBaseURL"].string : configured
    }

    var body: some View {
        List {
            Section("供应商") {
                LabeledContent("路由", value: row["provider"].string)
                if !endpoint.isEmpty { LabeledContent("端点", value: endpoint).textSelection(.enabled) }
                if !row["error"].string.isEmpty { Text(row["error"].string).foregroundStyle(Theme.warnText) }
            }
            Section("操作") {
                if let section {
                    NavigationLink("编辑配置") {
                        HostNamespaceEditor(original: section, writable: settings["writable"].bool, basePath: path)
                    }
                }
                NavigationLink("管理 API 凭据") { CredentialEditor(initialRef: profile["credentialRef"].string) }
                NavigationLink("查找端点模型") {
                    ProviderDiscovery(row: row, endpoint: endpoint, api: profile["api"].string)
                }
            }
        }
        .navigationTitle(row["displayName"].string).navigationBarTitleDisplayMode(.inline)
    }
}

private struct CredentialEditor: View {
    @EnvironmentObject private var model: AppModel
    @State private var ref: String
    @State private var value = ""
    @State private var info: JSON?
    @State private var busy = false
    @State private var confirm = false
    @State private var problem: String?

    init(initialRef: String) { _ref = State(initialValue: initialRef) }
    private var key: String { ref.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var writable: Bool { model.canWrite && info?["writable"].bool == true && !busy }

    var body: some View {
        Form {
            Section("凭据引用") {
                TextField("输入电脑配置中的引用", text: $ref)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onChange(of: ref) { _, _ in info = nil; value = ""; problem = nil }
                    .disabled(busy)
                Button("检查凭据状态") { Task { await run() } }.disabled(key.isEmpty || busy)
                if let info {
                    LabeledContent("状态", value: info["configured"].bool ? "已设置" : "未设置")
                    if !info["source"].string.isEmpty { LabeledContent("来源", value: info["source"].string) }
                }
            }
            if writable {
                Section("保存在电脑") {
                    SecureField("新值", text: $value).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("保存凭据") { Task { await run("credentials/set") } }.disabled(value.isEmpty)
                    if info?["configured"].bool == true {
                        Button("移除凭据", role: .destructive) { confirm = true }
                    }
                }
            }
            if busy { ProgressView() }
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
        }
        .navigationTitle("API 凭据").navigationBarTitleDisplayMode(.inline)
        .task { if !key.isEmpty { await run() } }
        .confirmationDialog("移除电脑上的凭据？", isPresented: $confirm, titleVisibility: .visible) {
            Button("移除", role: .destructive) { Task { await run("credentials/unset") } }
            Button("取消", role: .cancel) {}
        } message: { Text(key) }
    }

    private func run(_ mutation: String? = nil) async {
        guard !busy, !key.isEmpty else { return }
        let reference = key
        busy = true; problem = nil; defer { busy = false }
        do {
            if let mutation {
                var args: [String: JSON] = ["ref": .string(reference)]
                if mutation == "credentials/set" { args["value"] = .string(value) }
                try await model.action(mutation, args: .object(args))
                value = ""
            }
            info = try await model.read("credentials/describe", args: .object(["refs": .array([.string(reference)])]))[reference]
        } catch {
            if !Task.isCancelled {
                problem = mutation == "credentials/set" ? "电脑未能确认保存，请重新检查凭据状态。" : error.localizedDescription
            }
        }
    }
}

private struct ProviderDiscovery: View {
    let row: JSON
    @EnvironmentObject private var model: AppModel
    @State private var endpoint: String
    @State private var api: String
    @State private var key = ""
    @State private var found: [JSON]?
    @State private var busy = false
    @State private var problem: String?

    init(row: JSON, endpoint: String, api: String) {
        self.row = row
        _endpoint = State(initialValue: endpoint)
        _api = State(initialValue: api)
    }

    var body: some View {
        Form {
            Section("由电脑查询供应商") {
                TextField("端点 URL（可选）", text: $endpoint)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("API 协议（可选）", text: $api).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("仅用于本次查询的密钥（可选）", text: $key)
                Button("查询模型") { Task { await discover() } }.disabled(!model.canWrite || busy)
            }
            if busy { ProgressView() }
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if let found {
                Section("发现的模型") {
                    if found.isEmpty { Text("供应商没有返回模型。") }
                    ForEach(found, id: \.self) { item in
                        LabeledContent(item["name"].string, value: item["id"].string).textSelection(.enabled)
                    }
                }
            }
        }
        .navigationTitle("查找端点模型").navigationBarTitleDisplayMode(.inline)
    }

    private func discover() async {
        guard !busy else { return }
        busy = true; problem = nil; defer { key = ""; busy = false }
        var draft: [String: JSON] = ["provider": row["provider"]]
        for (name, value) in [("baseURL", endpoint), ("api", api), ("apiKey", key)] where !value.isEmpty {
            draft[name] = .string(value)
        }
        do {
            found = try await model.action("llm/discoverModels", args: .object([
                "settingsNs": row["settingsNs"], "request": .object(draft)
            ])).array
        } catch { problem = key.isEmpty ? error.localizedDescription : "查询失败，请检查端点、协议和临时密钥。" }
    }
}
