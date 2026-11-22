import SwiftUI
import DSHCore

private struct DesktopFolder: Identifiable {
    let raw: JSON
    var id: String { raw["path"].string }
    var name: String { raw["name"].string.isEmpty ? id : raw["name"].string }
}

struct DesktopFolderPicker: View {
    let initialPath: String
    let choose: (String) -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var target: String?
    @State private var listing: JSON = .null
    @State private var loading = true
    @State private var hidden = false
    @State private var showCreate = false
    @State private var folderName = ""
    @State private var problem: String?

    private var path: String { listing["path"].string }
    private var crumbs: [DesktopFolder] { listing["crumbs"].array.map(DesktopFolder.init) }
    private var children: [DesktopFolder] {
        listing["entries"].array.filter { hidden || !$0["hidden"].bool }.map(DesktopFolder.init)
    }

    var body: some View {
        NavigationStack {
            List {
                if let problem {
                    Section {
                        Text(problem).foregroundStyle(Theme.warnText)
                        Button("返回起始目录") { browse(nil) }
                    }
                }
                if loading { ProgressView("正在读取电脑目录") }
                if !path.isEmpty {
                    Section("当前位置") {
                        Text(path).font(DSHFont.code).textSelection(.enabled)
                        if let parent = crumbs.dropLast().last {
                            Button { browse(parent.id) } label: { Label("上一级", systemImage: "arrow.up") }
                        }
                        if crumbs.count > 2 {
                            Menu("跳到上级目录") {
                                ForEach(crumbs.dropLast()) { row in Button(row.name) { browse(row.id) } }
                            }
                        }
                    }
                    Section("文件夹") {
                        Toggle("显示隐藏文件夹", isOn: $hidden)
                        Button { folderName = ""; showCreate = true } label: { Label("新建文件夹", systemImage: "folder.badge.plus") }
                            .disabled(!model.canWrite || loading)
                        if !loading && children.isEmpty { Text("没有子文件夹").foregroundStyle(Theme.meta) }
                        ForEach(children) { row in
                            Button { browse(row.id) } label: {
                                HStack {
                                    Label(row.name, systemImage: "folder")
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(Theme.meta)
                                }
                            }.disabled(loading)
                        }
                        if listing["truncated"].bool { Text("电脑限制了显示数量，可直接输入所需路径。").font(DSHFont.meta) }
                    }
                }
            }
            .navigationTitle("选择电脑目录").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("选取") { choose(path); dismiss() }.disabled(path.isEmpty || loading || problem != nil || !model.canWrite)
                }
            }
            .task(id: target) {
                await load(target ?? (initialPath.isEmpty ? nil : initialPath))
            }
            .refreshable { await load(path.isEmpty ? nil : path) }
            .alert("新建文件夹", isPresented: $showCreate) {
                TextField("文件夹名称", text: $folderName)
                Button("新建") { Task { await createFolder() } }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func browse(_ path: String?) { target = path ?? "" }

    private func createFolder() async {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !path.isEmpty else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            let value = try await model.action("directoryPicker/createDirectory", args: .object(["path": .string(path), "name": .string(name)]))
            guard !value.string.isEmpty else { throw LinkError.badResponse }
            await load(value.string)
        } catch { problem = error.localizedDescription }
    }

    private func load(_ path: String?) async {
        loading = true
        problem = nil
        defer { if !Task.isCancelled { loading = false } }
        var args: [String: JSON] = [:]
        if let path, !path.isEmpty { args["path"] = .string(path) }
        do {
            let value = try await model.read("directoryPicker/list", args: .object(args))
            guard !Task.isCancelled else { return }
            guard !value["path"].string.isEmpty else { throw LinkError.badResponse }
            listing = value
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

struct ConversationSearchSheet: View {
    var initialQuery: String
    let open: (String) -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [JSON] = []
    @State private var loading = false
    @State private var completed = false
    @State private var hasMore = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if loading { ProgressView("正在搜索电脑上的会话") }
                if completed && results.isEmpty { ContentUnavailableView.search(text: query) }
                ForEach(Array(results.enumerated()), id: \.offset) { _, result in
                    let id = result["sessionId"].string
                    Button {
                        dismiss()
                        open(id)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(model.directory[id]?.title ?? "会话").font(.headline)
                            Text(result["snippet"].string).font(DSHFont.secondary).foregroundStyle(Theme.meta)
                                .lineLimit(4)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .disabled(id.isEmpty)
                    .accessibilityIdentifier("search-result-" + id)
                }
                if hasMore { Text("还有更多结果。可输入更具体的关键词。").font(DSHFont.meta) }
            }
            .navigationTitle("搜索聊天内容").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索桌面会话正文")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .onAppear { if query.isEmpty { query = initialQuery } }
            .task(id: query) { await search(query) }
        }
    }

    private func search(_ value: String) async {
        let term = value.trimmingCharacters(in: .whitespacesAndNewlines)
        results = []; hasMore = false; problem = nil; completed = false
        loading = !term.isEmpty
        guard !term.isEmpty else { return }
        defer { if !Task.isCancelled { loading = false } }
        do {
            try await Task.sleep(for: .milliseconds(350))
            let response = try await model.read("session/search", args: ActionPayload.request(["query": .string(term)]))
            guard !Task.isCancelled, value == query else { return }
            results = response["items"].array
            hasMore = response["hasMore"].bool
            completed = true
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
