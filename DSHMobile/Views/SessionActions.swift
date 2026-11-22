import SwiftUI
import DSHCore

struct SessionActionMenu: View {
    let session: SessionRow
    @EnvironmentObject private var model: AppModel
    @State private var editName = false
    @State private var confirmArchive = false
    @State private var problem: String?
    @State private var title = ""
    @State private var busy = false

    var body: some View {
        Menu {
            let pinned = model.directory.pinned.contains(session.id)
            let archived = model.directory.archived.contains(session.id)
            Button {
                title = session.title; editName = true
            } label: { Label("重命名", systemImage: "pencil") }
            Button {
                Task { await run(pinned ? "workspace/unpinSession" : "workspace/pinSession") }
            } label: { Label(pinned ? "取消置顶" : "置顶", systemImage: pinned ? "pin.slash" : "pin") }
            Button {
                Task { await run("session/fork", fields: ["allowMigration": .bool(false)], selectResult: true) }
            } label: { Label("分叉会话", systemImage: "arrow.triangle.branch") }
            if archived {
                Button { Task { await run("workspace/unarchiveSession") } } label: {
                    Label("恢复会话", systemImage: "tray.and.arrow.up")
                }
            } else {
                Button(role: .destructive) { confirmArchive = true } label: {
                    Label("归档", systemImage: "archivebox")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("会话操作")
        .disabled(busy || !model.canWrite)
        .alert("重命名会话", isPresented: $editName) {
            TextField("名称", text: $title)
            Button("保存") {
                let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
                if !name.isEmpty { Task { await run("session/rename", fields: ["title": .string(name)]) } }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("归档「\(session.title)」？", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("归档", role: .destructive) { Task { await run("workspace/archiveSession") } }
            if model.status(of: session.id).isLive {
                Button("停止任务并归档", role: .destructive) {
                    Task { await run("workspace/archiveSession", fields: ["stopActivity": .bool(true)]) }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .alert("会话操作失败", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(problem ?? "") }
    }

    private func run(_ method: String, fields: [String: JSON] = [:], selectResult: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await model.mutate(method, fields: fields.merging(["sessionId": .string(session.id)]) { a, _ in a })
            if selectResult, !result["sessionId"].string.isEmpty { model.selection = result["sessionId"].string }
            try? await model.refreshList()
        } catch { problem = error.localizedDescription }
    }
}

struct ArchivedSessionsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(rows) { row in
                HStack {
                    Button {
                        model.selection = row.id
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title)
                            Text(row.workspaceName).font(DSHFont.meta).foregroundStyle(Theme.meta)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    if model.canWrite { SessionActionMenu(session: row) }
                }
            }
            .overlay {
                if rows.isEmpty { ContentUnavailableView("暂无归档会话", systemImage: "archivebox") }
            }
            .navigationTitle("归档会话").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }

    private var rows: [SessionRow] {
        model.directory.archived.compactMap { model.directory[$0] }.sorted { $0.updatedAt > $1.updatedAt }
    }
}

struct WorkspaceManager: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var choosingFolder = false
    @State private var title = ""
    @State private var editing: WorkspaceGroup?
    @State private var deleting: WorkspaceGroup?
    @State private var problem: String?
    @State private var busy = false

    private var groups: [WorkspaceGroup] { model.directory.groups.filter { !$0.id.isEmpty } }

    var body: some View {
        NavigationStack {
            Form {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                Section("添加电脑上的工作区") {
                    TextField("电脑上的绝对路径", text: $path).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button { choosingFolder = true } label: { Label("浏览电脑目录", systemImage: "folder") }
                    Button("添加工作区") {
                        let value = path.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { if await run("workspace/create", ["path": .string(value)]) { path = "" } }
                    }
                    .disabled(path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section("工作区") {
                    ForEach(groups) { group in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.title)
                                Text(group.path).font(DSHFont.code).foregroundStyle(Theme.meta)
                            }
                            Spacer()
                            Menu {
                                Button("重命名") { title = group.title; editing = group }
                                if let index = groups.firstIndex(where: { $0.id == group.id }), index > 0 {
                                    Button("上移") {
                                        Task { await run("workspace/insertBefore", [
                                            "workspaceId": .string(group.id), "beforeWorkspaceId": .string(groups[index - 1].id),
                                        ]) }
                                    }
                                }
                                if let index = groups.firstIndex(where: { $0.id == group.id }), index + 1 < groups.count {
                                    Button("下移") {
                                        var request: [String: JSON] = ["workspaceId": .string(group.id)]
                                        if let after = groups.dropFirst(index + 2).first { request["beforeWorkspaceId"] = .string(after.id) }
                                        Task { await run("workspace/insertBefore", request) }
                                    }
                                }
                                Button("移除工作区", role: .destructive) { deleting = group }
                            } label: { Image(systemName: "ellipsis.circle").frame(minWidth: 44, minHeight: 44) }
                                .accessibilityLabel("管理 \(group.title)")
                        }
                    }
                }
            }
            .disabled(busy || !model.canWrite)
            .navigationTitle("管理工作区").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .sheet(isPresented: $choosingFolder) { DesktopFolderPicker(initialPath: path) { path = $0 } }
            .alert("重命名工作区", isPresented: flag($editing), presenting: editing) { group in
                TextField("名称", text: $title)
                Button("保存") {
                    let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !value.isEmpty else { return }
                    Task { await run("workspace/rename", ["workspaceId": .string(group.id), "title": .string(value)]) }
                }
                Button("取消", role: .cancel) {}
            }
            .confirmationDialog("移除此工作区？", isPresented: flag($deleting), titleVisibility: .visible, presenting: deleting) { group in
                Button("移除 \(group.title)", role: .destructive) {
                    Task { await run("workspace/delete", ["workspaceId": .string(group.id)]) }
                }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func flag(_ value: Binding<WorkspaceGroup?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }

    @discardableResult private func run(_ method: String, _ fields: [String: JSON]) async -> Bool {
        guard !busy else { return false }
        busy = true; problem = nil
        defer { busy = false }
        do { try await model.mutate(method, fields: fields); return true }
        catch { problem = error.localizedDescription; return false }
    }
}
