import SwiftUI
import DSHCore

/// The desktop sidebar: sessions grouped by workspace, with the same status marks and words.
struct SessionListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var showSettings = false
    @State private var showArchived = false
    @State private var showSchedules = false
    @State private var showContentSearch = false
    @State private var showWorkspaces = false
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        Group {
            if model.unreachable {
                UnreachableView()
            } else {
                list
            }
        }
        .background(Theme.sidebarFill)
        .navigationTitle("工作区")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showContentSearch = true } label: {
                    Label("搜索聊天内容", systemImage: "text.magnifyingglass")
                }
                .accessibilityIdentifier("search-chat-content")
                Button { showSettings = true } label: { Label("设置", systemImage: "gearshape") }
                    .accessibilityIdentifier("open-settings")
                Menu {
                    if model.canWrite {
                        Button("新建会话") { Task { await create(in: nil) } }
                        ForEach(model.directory.groups.filter { !$0.id.isEmpty }) { group in
                            Button("在 \(group.title) 新建") { Task { await create(in: group.id) } }
                        }
                        Button("管理工作区") { showWorkspaces = true }
                    }
                    Button("定时任务") { showSchedules = true }
                    Button("归档会话") { showArchived = true }
                } label: { Image(systemName: "ellipsis.circle").font(.title3).frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("工作区操作")
                    .accessibilityIdentifier("workspace-actions")
                    .disabled(busy)
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showContentSearch) {
            ConversationSearchSheet(initialQuery: query) { model.selection = $0 }
        }
        .sheet(isPresented: $showSchedules) { SchedulesSheet() }
        .sheet(isPresented: $showArchived) { ArchivedSessionsView() }
        .sheet(isPresented: $showWorkspaces) { WorkspaceManager() }
        .alert("工作区操作失败", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(problem ?? "") }
    }

    private func create(in workspaceID: String?) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await model.createSession(in: workspaceID) }
        catch { problem = error.localizedDescription }
    }

    private var groups: [WorkspaceGroup] { model.filteredGroups(query) }

    @ViewBuilder private func sessionOrderActions(_ row: SessionRow, in group: WorkspaceGroup) -> some View {
        let order = model.directory.manualSessionOrder(in: group.id)
        let visible = group.sessions.map(\.id).filter { !model.directory.pinned.contains($0) && order.contains($0) }
        if model.canWrite, query.isEmpty, !group.id.isEmpty, let index = visible.firstIndex(of: row.id) {
            if index > 0 {
                Button { Task { await move(row.id, in: group.id, before: visible[index - 1]) } } label: {
                    Label("上移会话", systemImage: "arrow.up")
                }.disabled(busy)
            }
            if index + 1 < visible.count, let target = order.firstIndex(of: visible[index + 1]) {
                Button { Task { await move(row.id, in: group.id, before: order.dropFirst(target + 1).first) } } label: {
                    Label("下移会话", systemImage: "arrow.down")
                }.disabled(busy)
            }
        }
    }

    private func move(_ id: String, in workspaceID: String, before: String?) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        var request: [String: JSON] = ["workspaceId": .string(workspaceID), "sessionId": .string(id)]
        if let before { request["beforeSessionId"] = .string(before) }
        do { try await model.mutate("workspace/insertSessionBefore", fields: request) }
        catch { problem = error.localizedDescription }
    }

    private var list: some View {
        TimelineView(.everyMinute) { context in
            List(selection: $model.selection) {
                Section {
                    if let notice = model.notice {
                        ConnectionNotice(notice: notice) { model.retryNow() }
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(groups) { group in
                        let open = !model.collapsedWorkspaces.contains(group.id) || !query.isEmpty
                        WorkspaceRow(group: group, open: open) {
                            withAnimation(.dsh(0.15)) {
                                if model.collapsedWorkspaces.contains(group.id) { model.collapsedWorkspaces.remove(group.id) }
                                else { model.collapsedWorkspaces.insert(group.id) }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        if open {
                            ForEach(group.sessions) { row in
                                NavigationLink(value: row.id) {
                                    SessionRowView(row: row, status: model.status(of: row.id), now: context.date)
                                }
                                .contextMenu { sessionOrderActions(row, in: group) }
                                .accessibilityIdentifier("session-row-" + row.id)
                                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                                    .listRowSeparator(.hidden)
                                    .listRowBackground(
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .fill(model.selection == row.id ? Theme.navActive : .clear)
                                            .padding(.horizontal, 8)
                                    )
                            }
                        }
                    }
                } header: {
                    DesktopLine()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 44)
            .searchable(text: $query, prompt: "搜索会话名称")
            .refreshable {
                model.retryNow()
                try? await model.refreshList()
            }
            .overlay {
                if model.listLoaded && groups.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "暂无会话" : "无匹配会话", systemImage: query.isEmpty ? "tray" : "magnifyingglass")
                        .foregroundStyle(Theme.process)
                } else if !model.listLoaded && !model.isOnline {
                    ConnectingPlaceholder()
                }
            }
        }
    }
}

/// "DESKTOP-7F3K2QH · 局域网" under the title.
struct DesktopLine: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        HStack(spacing: 6) {
            DSHIcon("followsystem-outline", size: 14)
            Text(text).lineLimit(1)
        }
        .font(DSHFont.meta)
        .foregroundStyle(Theme.meta)
        .textCase(nil)
        .padding(.leading, 4)
        .accessibilityElement(children: .combine)
    }
    private var text: String {
        let name = model.desktop?.name ?? ""
        guard let endpoint = model.endpoint else { return name }
        return "\(name) · \(endpoint.kind.label)"
    }
}

extension Endpoint.Kind {
    var label: String {
        switch self { case .lan: "局域网"; case .tailnet: "Tailscale"; case .loopback: "本机"; case .other: "网络" }
    }
}

struct WorkspaceRow: View {
    let group: WorkspaceGroup
    let open: Bool
    let toggle: () -> Void
    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                DSHIcon(open ? "folder-open-outline" : "folder-close", size: 18)
                    .foregroundStyle(open ? Theme.business : Theme.mark)
                Text(group.title).font(DSHFont.rowTitle).foregroundStyle(Theme.labelPrimary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.title)
        .accessibilityValue(open ? "已展开" : "已收起")
    }
}

struct SessionRowView: View {
    let row: SessionRow
    let status: SessionStatus
    let now: Date

    var body: some View {
        HStack(spacing: 0) {
            StatusMark(status: status)
                .frame(width: 18, height: 22)
                .padding(.trailing, 8)
            Text(row.title)
                .font(DSHFont.rowTitle)
                .foregroundStyle(Theme.labelPrimary)
                .lineLimit(1)
            Spacer(minLength: 10)
            Text(meta)
                .font(DSHFont.meta)
                .monospacedDigit()
                .foregroundStyle(Theme.meta)
                .lineLimit(1)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.title)
        .accessibilityValue("\(status.label)，\(RelativeTime.label(row.updatedAt, now: now))")
    }

    /// Pending interactions show their compact word; everything else shows the time, as the desktop row does.
    private var meta: String {
        status.needsAttention ? status.compactLabel : RelativeTime.label(row.updatedAt, now: now)
    }
}

/// The leading slot: spinner while running, colored dots for attention and unread completion.
struct StatusMark: View {
    let status: SessionStatus
    var body: some View {
        switch status {
        case .running, .subagents: Spinner()
        case .waitingApproval, .planReview, .waitingAnswer: StateDot(.warning)
        case .completed: StateDot(.done)
        case .idle: Color.clear
        }
    }
}

/// The desktop's sidebar times: 刚刚, {n}分钟, {n}小时, {n}天.
enum RelativeTime {
    static func label(_ date: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(date))
        if s < 60 { return "刚刚" }
        if s < 3600 { return "\(Int(s / 60))分钟" }
        if s < 86_400 { return "\(Int(s / 3600))小时" }
        return "\(Int(s / 86_400))天"
    }
}

struct ConnectingPlaceholder: View {
    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("重新连接中").font(DSHFont.meta).foregroundStyle(Theme.meta)
        }
    }
}
