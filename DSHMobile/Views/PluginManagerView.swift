import SwiftUI
import DSHCore

private func localizedPluginText(_ raw: JSON) -> String {
    if !raw.string.isEmpty { return raw.string }
    for language in ["zh-CN", "zh-Hans", "zh", "en", "en-US"] where !raw[language].string.isEmpty {
        return raw[language].string
    }
    return raw.object.sorted { $0.key < $1.key }.first { !$0.value.string.isEmpty }?.value.string ?? ""
}

struct PluginManagerView: View {
    @EnvironmentObject private var model: AppModel
    @State private var bundles: [JSON]?
    @State private var plugins: [JSON] = []
    @State private var problem: String?
    @State private var result: String?
    @State private var query = ""
    @State private var busy = false
    @State private var removing: JSON?
    @State private var install: InstallTarget?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if let result { Text(result).foregroundStyle(Theme.meta) }
            if bundles == nil && problem == nil { ProgressView("正在读取插件") }
            Section("来源") {
                NavigationLink("原生插件面板") { NativePluginPanels() }.accessibilityIdentifier("native-plugin-panels")
                NavigationLink("插件市场") { PluginMarketView() }
                NavigationLink("软件包源") { PluginRegistriesView() }
                Button("按包名或来源安装") { install = InstallTarget(spec: "", registry: "") }.disabled(!model.canWrite)
            }
            Section("插件包") {
                ForEach(filtered(bundles ?? [], key: "name"), id: \.self) { row in
                    bundleRow(row)
                }
            }
            Section("插件组件") {
                ForEach(filtered(plugins, key: "moduleName"), id: \.self) { row in
                    componentRow(row)
                }
            }
        }
        .navigationTitle("插件管理").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "查找插件")
        .task { await load() }.refreshable { await load() }
        .sheet(item: $install, onDismiss: { Task { await load() } }) { target in PluginInstallSheet(target: target) }
        .confirmationDialog("从电脑移除插件包？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { row in
            Button("移除插件包", role: .destructive) {
                Task { await change("pluginManager/removeBundle", ["name": row["name"]]) }
            }
            Button("取消", role: .cancel) {}
        } message: { row in Text(row["name"].string) }
    }

    private func filtered(_ rows: [JSON], key: String) -> [JSON] {
        rows.filter { query.isEmpty || $0[key].string.localizedCaseInsensitiveContains(query) ||
            localizedPluginText($0["meta"]["title"]).localizedCaseInsensitiveContains(query) }
    }

    private func isBridge(_ name: String) -> Bool { name.contains("dsh-mobile-link") }

    private func bundleRow(_ row: JSON) -> some View {
        let name = row["name"].string
        let title = localizedPluginText(row["meta"]["title"])
        let enabled = row["enabled"].bool
        return VStack(alignment: .leading, spacing: 7) {
            LabeledContent(title.isEmpty ? name : title, value: row["version"].string)
            if !title.isEmpty { Text(name).font(DSHFont.meta).foregroundStyle(Theme.meta) }
            if row["error"] != .null {
                Text(row["error"]["diagnostic"].string.isEmpty ? row["error"]["code"].string : row["error"]["diagnostic"].string)
                    .font(DSHFont.meta).foregroundStyle(Theme.warnText)
            }
            if row["availability"].string == "missing" {
                if !row["installTarget"]["spec"].string.isEmpty {
                    Button("安装") { install = InstallTarget(spec: row["installTarget"]["spec"].string, registry: "") }
                        .buttonStyle(.borderless).disabled(!model.canWrite || busy)
                }
            } else {
                Toggle("已启用", isOn: Binding(get: { enabled }, set: { value in
                    Task { await change("pluginManager/setBundleEnabled", ["name": .string(name), "enabled": .bool(value)]) }
                }))
                .disabled(!model.canWrite || busy || row["readOnlyReason"] != .null || isBridge(name))
            }
            if row["removable"].bool && !isBridge(name) {
                Button("移除…", role: .destructive) { removing = row }.buttonStyle(.borderless).disabled(!model.canWrite || busy)
            }
        }
    }

    private func componentRow(_ row: JSON) -> some View {
        let name = row["moduleName"].string
        return Toggle(isOn: Binding(get: { row["enabled"].bool }, set: { value in
            Task { await change("pluginManager/setPluginEnabled", ["id": row["entryId"], "enabled": .bool(value)]) }
        })) {
            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                if !row["fiberPhase"].string.isEmpty { Text(row["fiberPhase"].string).font(DSHFont.meta).foregroundStyle(Theme.meta) }
            }
        }
        .disabled(!model.canWrite || busy || row["readOnlyReason"] != .null || isBridge(name))
    }

    private func load() async {
        do {
            async let a = model.read("pluginManager/listBundles", args: .object([:]))
            async let b = model.read("pluginManager/listPlugins", args: .object([:]))
            let (one, two) = try await (a, b)
            bundles = one.array; plugins = two.array; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func change(_ method: String, _ args: [String: JSON]) async {
        guard !busy else { return }
        busy = true; problem = nil; result = nil; defer { busy = false }
        do {
            let changed = try await model.action(method, args: .object(args))
            result = pluginChangeMessage(changed)
            await load()
        } catch { problem = error.localizedDescription }
    }
}

private struct PluginRegistriesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var source: JSON?
    @State private var problem: String?
    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if let source {
                LabeledContent("配置源", value: source["registry"].string)
                LabeledContent("pnpm 当前源", value: source["resolved"].string)
                ForEach(source["fallbackRegistries"].array, id: \.self) { Text($0.string).textSelection(.enabled) }
            } else if problem == nil { ProgressView() }
        }
        .navigationTitle("软件包源").navigationBarTitleDisplayMode(.inline)
        .task {
            do { source = try await model.read("pluginManager/registries", args: .object([:])) }
            catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
    }
}

private struct InstallTarget: Identifiable {
    let id = UUID()
    let spec: String
    let registry: String
}

private func pluginChangeMessage(_ result: JSON) -> String {
    switch result["application"].string {
    case "applied": return result["changed"].bool ? "已应用。" : "已处于请求的状态。"
    case "restart-required": return "已保存，重启电脑上的 Harness 后生效。"
    case "overridden": return "已保存，但当前配置中存在优先级更高的覆盖。"
    case "cancelled": return "已取消，电脑已恢复安装前的状态。"
    default:
        let detail = result["error"]["diagnostic"].string
        return detail.isEmpty ? "操作失败：\(result["error"]["code"].string)" : detail
    }
}

private struct PluginInstallSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var spec: String
    @State private var registry: String
    @State private var inspection: JSON?
    @State private var result: JSON?
    @State private var busy = false
    @State private var cancelling = false
    @State private var requestID: String?
    @State private var enable = true
    @State private var exact = true
    @State private var confirmBuildScripts = false
    @State private var problem: String?

    init(target: InstallTarget) {
        _spec = State(initialValue: target.spec)
        _registry = State(initialValue: target.registry)
    }

    private var normalized: String { spec.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var options: [String: JSON] {
        let registry = registry.trimmingCharacters(in: .whitespacesAndNewlines)
        return registry.isEmpty ? [:] : ["registry": .string(registry)]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("插件来源") {
                    TextField("包名、网址或电脑上的路径", text: $spec)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("软件包源（可选）", text: $registry)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("检查软件包") { Task { await preview() } }.disabled(normalized.isEmpty)
                }.disabled(busy)
                if let inspection {
                    Section("检查结果") {
                        if inspection["status"].string == "accepted" {
                            LabeledContent("来源类型", value: inspection["kind"].string)
                            if !inspection["name"].string.isEmpty { LabeledContent("包名", value: inspection["name"].string) }
                            if !inspection["version"].string.isEmpty { LabeledContent("版本", value: inspection["version"].string) }
                            if !inspection["description"].string.isEmpty { Text(inspection["description"].string) }
                            if !inspection["host"].string.isEmpty { LabeledContent("来源主机", value: inspection["host"].string) }
                            Toggle("安装后启用", isOn: $enable).disabled(busy)
                            Toggle("固定版本", isOn: $exact).disabled(busy)
                            Button("在电脑上安装") { Task { await install() } }
                                .disabled(busy || !model.canWrite || result?["application"].string == "applied")
                        } else {
                            Text(inspection["reason"].string.isEmpty ? inspection["problem"].string : inspection["reason"].string)
                                .foregroundStyle(Theme.warnText)
                        }
                    }
                }
                if busy { ProgressView(requestID == nil ? "正在检查" : "电脑正在安装") }
                if requestID != nil {
                    Button("取消安装", role: .destructive) { Task { await cancel() } }.disabled(cancelling)
                }
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if let result {
                    Section("安装结果") {
                        Text(pluginChangeMessage(result))
                        if !result["pendingBuilds"].array.isEmpty {
                            Text("以下包需要在电脑上运行安装脚本：")
                            ForEach(result["pendingBuilds"].array, id: \.self) { Text($0.string).font(DSHFont.code) }
                            Button("允许这些脚本并重试…") { confirmBuildScripts = true }
                                .disabled(busy || !model.canWrite)
                        }
                        let output = result["packageResult"]["output"].string
                        if !output.isEmpty { Text(String(output.suffix(8000))).font(DSHFont.code).textSelection(.enabled) }
                    }
                }
            }
            .navigationTitle("安装插件包").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() }.disabled(busy) } }
            .onChange(of: spec) { _, _ in inspection = nil; result = nil }
            .onChange(of: registry) { _, _ in inspection = nil; result = nil }
            .confirmationDialog("允许这些软件包在电脑上运行安装脚本？", isPresented: $confirmBuildScripts, titleVisibility: .visible) {
                Button("允许并重试") {
                    let approved = result?["pendingBuilds"].array ?? []
                    if !approved.isEmpty { Task { await install(approvedBuilds: approved) } }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text((result?["pendingBuilds"].array ?? []).map(\.string).joined(separator: "、"))
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func preview() async {
        guard !busy else { return }
        busy = true; problem = nil; inspection = nil; result = nil; defer { busy = false }
        do {
            inspection = try await model.read("pluginManager/inspect", args: .object([
                "spec": .string(normalized), "options": .object(options)
            ]))
        } catch { problem = error.localizedDescription }
    }

    private func install(approvedBuilds: [JSON] = []) async {
        guard !busy else { return }
        let id = UUID().uuidString.lowercased()
        busy = true; problem = nil; result = nil; requestID = id
        defer { busy = false; requestID = nil }
        var args = options
        args["requestId"] = .string(id); args["enabled"] = .bool(enable); args["saveExact"] = .bool(exact)
        if !approvedBuilds.isEmpty { args["approvedBuilds"] = .array(approvedBuilds) }
        do {
            result = try await model.action("pluginManager/installBundle", args: .object([
                "spec": .string(normalized), "options": .object(args)
            ]))
        } catch { problem = error.localizedDescription }
    }

    private func cancel() async {
        guard let requestID, !cancelling else { return }
        cancelling = true; defer { cancelling = false }
        do {
            let response = try await model.action("pluginManager/cancelInstall", args: .object(["requestId": .string(requestID)]))
            if response["status"].string == "too-late" { problem = "已进入应用阶段，请等待结果。" }
        } catch { problem = error.localizedDescription }
    }
}

private struct PluginMarketView: View {
    @EnvironmentObject private var model: AppModel
    @State private var indexes: [JSON]?
    @State private var problem: String?
    @State private var edit = false

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if indexes == nil && problem == nil { ProgressView("正在读取市场来源") }
            ForEach(indexes ?? [], id: \.self) { index in
                NavigationLink {
                    MarketEntries(index: index)
                } label: {
                    let title = localizedPluginText(index["title"])
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title.isEmpty ? index["url"].string : title)
                        if !index["error"].string.isEmpty { Text(index["error"].string).font(DSHFont.meta).foregroundStyle(Theme.warnText) }
                    }
                }
            }
            if indexes?.isEmpty == true { Text("电脑没有配置插件市场。") }
            Button("编辑市场来源") { edit = true }.disabled(!model.canWrite || indexes == nil)
        }
        .navigationTitle("插件市场").navigationBarTitleDisplayMode(.inline)
        .task { await load() }.refreshable { await load() }
        .sheet(isPresented: $edit, onDismiss: { Task { await load() } }) {
            MarketSources(urls: (indexes ?? []).map { $0["url"].string })
        }
    }

    private func load() async {
        do { indexes = try await model.read("pluginMarket/listIndexes", args: .object([:])).array; problem = nil }
        catch LinkError.http(404) { problem = "电脑尚未启用 Harness 的插件市场。仍可回到插件管理，按包名安装。" }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct MarketSources: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var lines: String
    @State private var busy = false
    @State private var problem: String?

    init(urls: [String]) { _lines = State(initialValue: urls.joined(separator: "\n")) }

    var body: some View {
        NavigationStack {
            Form {
                Section("每行一个市场 URL") {
                    TextEditor(text: $lines).frame(minHeight: 180).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            }
            .disabled(busy)
            .navigationTitle("市场来源").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(busy) }
            }
        }.interactiveDismissDisabled(busy)
    }

    private func save() async {
        busy = true; problem = nil; defer { busy = false }
        let urls = lines.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        do {
            try await model.action("pluginMarket/setIndexes", args: .object(["urls": .array(urls.map(JSON.string))]))
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

private struct MarketEntries: View {
    let index: JSON
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var loadedQuery = ""
    @State private var entries: [JSON] = []
    @State private var next: JSON = .null
    @State private var fetched: JSON = .null
    @State private var busy = false
    @State private var problem: String?
    @State private var install: InstallTarget?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if busy { ProgressView() }
            ForEach(entries, id: \.self) { entry in
                NavigationLink {
                    versions(entry)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        let title = localizedPluginText(entry["title"])
                        Text(title.isEmpty ? entry["name"].string : title)
                        let description = localizedPluginText(entry["description"])
                        if !description.isEmpty { Text(description).font(DSHFont.meta).lineLimit(2) }
                    }
                }
            }
            if next != .null {
                Button("加载更多") { Task { await fetch(reset: false) } }.disabled(busy)
            }
            if !busy && problem == nil && entries.isEmpty { Text("没有匹配的插件。") }
        }
        .navigationTitle("市场插件").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "搜索市场插件")
        .onSubmit(of: .search) { Task { await fetch(reset: true) } }
        .task { await fetch(reset: true) }
        .refreshable { await fetch(reset: true, refresh: true) }
        .sheet(item: $install, onDismiss: { Task { await fetch(reset: true) } }) { PluginInstallSheet(target: $0) }
    }

    private func versions(_ entry: JSON) -> some View {
        List {
            let description = localizedPluginText(entry["description"])
            if !description.isEmpty { Text(description) }
            if !entry["installation"]["installedVersion"].string.isEmpty {
                LabeledContent("已安装版本", value: entry["installation"]["installedVersion"].string)
            }
            ForEach(entry["versions"].array, id: \.self) { row in
                Button {
                    install = InstallTarget(spec: row["install"]["spec"].string, registry: row["install"]["registry"].string)
                } label: {
                    LabeledContent(row["version"].string, value: row["compatibility"]["compatible"].bool ? "检查并安装" : "不兼容")
                }
                .disabled(!model.canWrite || row["install"]["spec"].string.isEmpty ||
                          (!row["compatibility"]["compatible"].bool && !row["compatibility"]["exempted"].bool))
            }
        }.navigationTitle(entry["name"].string).navigationBarTitleDisplayMode(.inline)
    }

    private func fetch(reset: Bool, refresh: Bool = false) async {
        guard !busy else { return }
        let requested = reset ? query : loadedQuery
        busy = true; problem = nil; defer { busy = false }
        var search: [String: JSON] = [
            "text": .string(requested), "sort": .object(["kind": .string("relevance")]),
            "offset": reset ? .number(0) : next, "limit": .number(30)
        ]
        if refresh { search["refresh"] = .bool(true) }
        if !reset && fetched != .null { search["fetchedAt"] = fetched }
        do {
            let page = try await model.read("pluginMarket/search", args: .object(["url": index["url"], "query": .object(search)]))
            if reset || page["fetchedAt"] != fetched { entries = [] }
            let known = Set(entries.map { $0["name"].string })
            entries += page["entries"].array.filter { !known.contains($0["name"].string) }
            next = page["nextOffset"]; fetched = page["fetchedAt"]; loadedQuery = requested
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
