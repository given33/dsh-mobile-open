import SwiftUI
import QuickLook
import DSHCore

struct WorkspaceFilesSheet: View {
    let sessionID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WorkspaceFolder(sessionID: sessionID, path: "", title: "工作区文件")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        }
    }
}

private struct WorkspaceFolder: View {
    let sessionID: String
    let path: String
    let title: String
    @EnvironmentObject private var model: AppModel
    @State private var listing: JSON?
    @State private var problem: String?
    @State private var query = ""

    private var entries: [JSON] {
        (listing?["entries"].array ?? [])
            .filter { !$0["name"].string.isEmpty && (query.isEmpty || $0["name"].string.localizedCaseInsensitiveContains(query)) }
            .sorted {
                let l = $0["type"].string == "directory", r = $1["type"].string == "directory"
                return l == r ? $0["name"].string.localizedStandardCompare($1["name"].string) == .orderedAscending : l
            }
    }

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if listing == nil && problem == nil { ProgressView("正在读取目录") }
            if listing != nil && entries.isEmpty {
                ContentUnavailableView(query.isEmpty ? "空文件夹" : "没有匹配的文件", systemImage: "folder")
            }
            ForEach(entries, id: \.self) { row in
                let name = row["name"].string
                let folder = row["type"].string == "directory"
                let child = [path, name].filter { !$0.isEmpty }.joined(separator: "/")
                if folder {
                    NavigationLink {
                        WorkspaceFolder(sessionID: sessionID, path: child, title: name)
                    } label: { Label(name, systemImage: "folder") }
                } else if row["type"].string == "file" {
                    NavigationLink {
                        WorkspaceFileView(sessionID: sessionID, path: child)
                    } label: {
                        HStack {
                            Label(name, systemImage: "doc")
                            Spacer()
                            if row["size"] != .null {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(row["size"].int), countStyle: .file))
                                    .font(DSHFont.meta).foregroundStyle(Theme.meta)
                            }
                        }
                    }
                } else {
                    Label(name, systemImage: "link").foregroundStyle(Theme.meta)
                }
            }
            if listing?["truncated"].bool == true { Text("目录结果达到电脑的显示上限。").font(DSHFont.meta) }
        }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "查找当前目录")
        .task(id: model.isOnline) { if model.isOnline { await load() } }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            listing = try await model.read("workspaceFiles/list", args: .object([
                "workspaceFileScopeId": .string(sessionID), "path": .string(path.isEmpty ? "." : path)
            ]))
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private final class FilePreviewCache: ObservableObject {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    func save(_ data: Data, name: String) throws -> URL {
        let cleanName = (name as NSString).lastPathComponent
        guard !cleanName.isEmpty, cleanName != ".", cleanName != ".." else { throw LinkError.badResponse }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(cleanName)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }
    deinit { try? FileManager.default.removeItem(at: folder) }
}

struct WorkspaceFileView: View {
    let sessionID: String
    let path: String
    @EnvironmentObject private var model: AppModel
    @StateObject private var cache = FilePreviewCache()
    @State private var local: URL?
    @State private var preview: URL?
    @State private var problem: String?
    @State private var loading = false

    private var name: String { path.split(separator: "/").last.map(String.init) ?? "文件" }

    var body: some View {
        List {
            Section {
                Text(path).font(DSHFont.code).textSelection(.enabled)
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if loading { ProgressView("正在下载") }
                if let local {
                    Button { preview = local } label: { Label("预览", systemImage: "eye") }
                    ShareLink(item: local) { Label("存储到文件或分享", systemImage: "square.and.arrow.up") }
                } else {
                    Button { Task { await load() } } label: { Label("下载", systemImage: "arrow.down.circle") }.disabled(loading)
                }
            }
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .quickLookPreview($preview)
        .task { await load() }
    }

    private func load() async {
        guard !loading, local == nil else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            let result = try await model.read("mobileFiles/download", args: .object(["sessionId": .string(sessionID), "path": .string(path)]))
            guard let bytes = Data(base64Encoded: result["data"].string), bytes.count == result["bytes"].int,
                  !result["name"].string.isEmpty else { throw LinkError.badResponse }
            try Task.checkCancellation()
            local = try cache.save(bytes, name: result["name"].string)
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

struct GitChangesSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [JSON]?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if rows == nil && problem == nil { ProgressView("正在读取 Git 状态") }
                if rows?.isEmpty == true { ContentUnavailableView("没有未提交的变更", systemImage: "checkmark.circle") }
                ForEach(rows ?? [], id: \.self) { row in
                    let path = row["path"].string
                    NavigationLink {
                        if row["index"].string == "?" {
                            WorkspaceFileView(sessionID: sessionID, path: path)
                        } else {
                            GitDiffView(sessionID: sessionID, row: row)
                        }
                    } label: {
                        HStack {
                            Text(row["index"].string + row["worktree"].string).font(DSHFont.code).foregroundStyle(Theme.warnText)
                            VStack(alignment: .leading) {
                                Text(path).font(DSHFont.code)
                                if !row["previous"].string.isEmpty {
                                    Text("原路径：\(row["previous"].string)").font(DSHFont.meta).foregroundStyle(Theme.meta)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Git 变更").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        do {
            rows = try await model.read("mobileGit/status", args: .object(["sessionId": .string(sessionID)])).array
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct GitDiffView: View {
    let sessionID: String
    let row: JSON
    @EnvironmentObject private var model: AppModel
    @State private var staged = false
    @State private var diff: String?
    @State private var problem: String?

    private var path: String { row["path"].string }
    private var lines: [Substring] { diff?.split(separator: "\n", omittingEmptySubsequences: false) ?? [] }
    private var visibleLines: [Substring] { Array(lines.prefix(4500)) }

    private func lineColor(_ first: Character?) -> Color {
        switch first {
        case "+": return Theme.success
        case "-": return Theme.error
        default: return Theme.labelPrimary
        }
    }

    var body: some View {
        VStack(spacing: 6) {
            Picker("差异类型", selection: $staged) {
                Text("工作区").tag(false); Text("暂存区").tag(true)
            }.pickerStyle(.segmented).padding(.horizontal)
            if let problem { Text(problem).foregroundStyle(Theme.warnText).padding() }
            else if diff == nil { ProgressView("正在读取差异") }
            else if diff?.isEmpty == true { ContentUnavailableView("此范围没有差异", systemImage: "doc.plaintext") }
            else {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        let displayed = visibleLines
                        ForEach(displayed.indices, id: \.self) { index in
                            let line = displayed[index]
                            Text(String(line.prefix(4000)))
                                .font(DSHFont.code).textSelection(.enabled)
                                .foregroundStyle(lineColor(line.first))
                        }
                        if lines.count > 4500 { Text("剩余差异未显示。").font(DSHFont.meta) }
                    }.padding(12)
                }
            }
            Spacer(minLength: 0)
        }
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: staged) {
            problem = nil; diff = nil
            do {
                let value = try await model.read("mobileGit/diff", args: .object([
                    "sessionId": .string(sessionID), "path": .string(path), "staged": .bool(staged)
                ]))
                if !Task.isCancelled { diff = value.string }
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
    }
}
