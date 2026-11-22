import SwiftUI
import DSHCore

/// One session's conversation, built and folded exactly as the desktop Chat does.
struct ConversationView: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    /// Manual whole-turn choices; nil means the display mode's default.
    @State private var turnOpen: [Int: Bool] = [:]
    @State private var groupOpen: [String: Bool] = [:]
    @State private var detail: ToolRow?
    @State private var showStats = false
    @State private var showGoal = false
    @State private var showJobs = false
    @State private var showTerminals = false
    @State private var showFiles = false
    @State private var showGit = false
    @State private var showSubagents = false
    @State private var showPermissions = false
    @State private var showPresets = false
    @State private var showQueue = false
    @State private var interaction: PendingInteraction?
    @State private var atBottom = true

    private var row: SessionRow? { model.directory[sessionID] }
    private var status: SessionStatus { model.status(of: sessionID) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    HistoryHeader()
                    ForEach(model.turns) { turn in
                        TurnView(turn: turn, mode: model.displayMode, cwd: row?.cwd ?? "",
                                 open: binding(for: turn), groupOpen: $groupOpen) { detail = $0 }
                            .padding(.bottom, 24)
                    }
                    if let error = model.followError {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(error, systemImage: "exclamationmark.circle")
                            Button("重新同步会话") { model.retryConversation() }.frame(minHeight: 44)
                        }
                        .font(DSHFont.meta).foregroundStyle(Theme.meta).padding(.vertical, 8)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.never)
            .onChange(of: model.turns) { _, _ in
                if atBottom { withAnimation(.dsh(0.16)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !model.turns.isEmpty {
                    Button { withAnimation(.dsh()) { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                        DSHIcon("chevron-down-outline")
                            .foregroundStyle(Theme.labelSecondary)
                            .frame(width: 40, height: 40)
                            .background(Theme.sheet, in: Circle())
                            .overlay(Circle().strokeBorder(Theme.borderL3, lineWidth: 0.5))
                            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("回到底部")
                    .padding(.trailing, 12)
                    .padding(.bottom, 8)
                }
            }
            .overlay {
                if model.turns.isEmpty && model.followError == nil {
                    if model.hasSnapshot {
                        ContentUnavailableView("暂无消息", systemImage: "bubble.left.and.bubble.right")
                            .foregroundStyle(Theme.meta)
                    } else if model.isOnline { ProgressView().controlSize(.regular) }
                    else { ConnectingPlaceholder() }
                }
            }
        }
        .background(Theme.bgBase)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                dock
                SessionComposer(sessionID: sessionID).id(sessionID)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(row?.title ?? "新会话").font(.headline).foregroundStyle(Theme.labelPrimary).lineLimit(1)
                    Text(subtitle).font(DSHFont.caption).foregroundStyle(Theme.meta).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let row, model.canWrite { SessionActionMenu(session: row) }
                Menu {
                    Button { showStats = true } label: { Label("会话统计", systemImage: "chart.bar") }
                    Button { showGoal = true } label: { Label("会话目标", systemImage: "target") }
                    Button { showPermissions = true } label: { Label("会话权限", systemImage: "shield") }
                    Button { showPresets = true } label: { Label("智能体预设", systemImage: "slider.horizontal.3") }
                    Button { showSubagents = true } label: { Label("子任务", systemImage: "point.3.connected.trianglepath.dotted") }
                    Button { showFiles = true } label: { Label("工作区文件", systemImage: "folder") }
                    Button { showGit = true } label: { Label("Git 变更", systemImage: "arrow.triangle.branch") }
                    Button { showTerminals = true } label: { Label("终端", systemImage: "terminal") }
                    Button { showJobs = true } label: { Label("后台任务", systemImage: "list.bullet.rectangle") }
                    Button { showQueue = true } label: { Label("排队消息", systemImage: "tray") }
                } label: {
                    Image(systemName: "info.circle").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("会话详情")
            }
        }
        .sheet(item: $detail) { tool in ToolDetailSheet(tool: tool, cwd: row?.cwd ?? "") }
        .sheet(isPresented: $showStats) { SessionStatsSheet(sessionID: sessionID) }
        .sheet(isPresented: $showGoal) { GoalSheet(sessionID: sessionID) }
        .sheet(isPresented: $showPermissions) { PermissionSheet(sessionID: sessionID) }
        .sheet(isPresented: $showPresets) { AgentPresetsSheet(sessionID: sessionID) }
        .sheet(isPresented: $showSubagents) { SubagentsSheet(sessionID: sessionID) }
        .sheet(isPresented: $showFiles) { WorkspaceFilesSheet(sessionID: sessionID) }
        .sheet(isPresented: $showGit) { GitChangesSheet(sessionID: sessionID) }
        .sheet(isPresented: $showTerminals) { TerminalsSheet(sessionID: sessionID) }
        .sheet(isPresented: $showJobs) { BackgroundJobsSheet(sessionID: sessionID) }
        .sheet(isPresented: $showQueue) { QueueSheet(sessionID: sessionID) }
        .sheet(item: $interaction) { InteractionSheet(interaction: $0) }
    }

    private var subtitle: String {
        guard let row else { return "" }
        let name = row.workspaceName
        return name.isEmpty ? status.label : "\(name) · \(status.label)"
    }

    private func binding(for turn: Turn) -> Binding<Bool> {
        Binding(
            get: { turnOpen[turn.id] ?? !(turn.foldable && model.displayMode != .verbose) },
            set: { turnOpen[turn.id] = $0 }
        )
    }

    /// Bottom dock: a pending question or approval takes the place of the to-do panel.
    @ViewBuilder private var dock: some View {
        let pending = model.pending(for: sessionID)
        if let first = pending.first {
            VStack(spacing: 4) {
                Button { interaction = first } label: {
                    PendingCard(interaction: first, compact: true)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("pending-interaction")
                if pending.count > 1 {
                    Menu("另外 \(pending.count - 1) 项待处理") {
                        ForEach(pending.dropFirst()) { item in Button(item.summary) { interaction = item } }
                    }
                    .font(DSHFont.meta).frame(minHeight: 44)
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 8)
        } else if let row, !row.todoItems.isEmpty {
            TodoDock(items: row.todoItems, progress: row.todoProgress ?? "")
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
    }
}

/// "加载更早" at the top of the loaded window.
struct HistoryHeader: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        if model.transcript.hasMore {
            Group {
                switch model.history {
                case .loading:
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("载入历史…") }
                case .failed(let message):
                    Button { Task { await model.loadEarlier() } } label: { Text("历史加载失败：\(message)") }
                case .idle:
                    Button { Task { await model.loadEarlier() } } label: { Text("加载更早") }
                }
            }
            .font(DSHFont.meta)
            .foregroundStyle(Theme.meta)
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
    }
}

// MARK: - Turn

struct TurnView: View {
    let turn: Turn
    let mode: DisplayMode
    let cwd: String
    var attachmentSessionID: String? = nil
    @Binding var open: Bool
    @Binding var groupOpen: [String: Bool]
    let onTool: (ToolRow) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(turn.opening) { input in UserInputView(input: input, attachmentSessionID: attachmentSessionID).padding(.bottom, 10) }
            if showsControl {
                TurnControl(turn: turn, open: open, collapsible: collapsible) {
                    withAnimation(.dsh()) { open.toggle() }
                }
                .padding(.bottom, 10)
            }
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, item in
                elementView(item)
                    .padding(.top, index == 0 ? 0 : gap(before: index))
            }
            if turn.outcome == .running {
                RunningIndicator(since: turn.startedAt).padding(.top, 12)
            }
            if case .failed(let message, let code) = turn.outcome {
                TurnErrorRow(message: message, code: code).padding(.top, visible.isEmpty ? 0 : 8)
            }
        }
    }

    // Verbose keeps the header without a collapse action; failed and stopped turns are never foldable.
    private var collapsible: Bool { turn.foldable && mode != .verbose }
    private var showsControl: Bool { turn.isClosed && (turn.hasProcess || !turn.controlLabel.isEmpty) && !turn.elements.isEmpty }

    /// Folding hides process groups and retries; every reply stays ("All replies", the desktop default).
    private var visible: [TurnElement] {
        guard collapsible && !open else { return turn.elements }
        return turn.elements.filter {
            switch $0 { case .reply, .input: return true; case .group, .retry: return false }
        }
    }

    private func gap(before index: Int) -> CGFloat {
        if case .reply = visible[index - 1] { return 12 }
        return 6
    }

    @ViewBuilder private func elementView(_ element: TurnElement) -> some View {
        switch element {
        case .input(let input): UserInputView(input: input, attachmentSessionID: attachmentSessionID)
        case .reply(let reply): MarkdownView(text: reply.text)
        case .retry(let retry): RetryRowView(retry: retry, settled: turn.isClosed)
        case .group(let group):
            ProcessGroupView(group: group, mode: mode, running: !turn.isClosed, cwd: cwd,
                             open: Binding(get: { groupOpen[group.id] ?? defaultOpen(group) }, set: { groupOpen[group.id] = $0 }),
                             onTool: onTool)
        }
    }

    /// Detailed shows running groups flat; Verbose shows every group flat.
    private func defaultOpen(_ group: ProcessGroup) -> Bool {
        switch mode {
        case .compact, .standard: false
        case .detailed: !turn.isClosed
        case .verbose: true
        }
    }
}

struct UserInputView: View {
    let input: UserInput
    var attachmentSessionID: String? = nil
    @EnvironmentObject private var model: AppModel
    @State private var imageRef: JSON?
    var body: some View {
        switch input.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                Text(input.text.isEmpty && input.attachments > 0 ? "[\(input.attachments) 个附件]" : input.text)
                    .font(DSHFont.content)
                    .foregroundStyle(Theme.labelPrimary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 16)
                    .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in width * 0.82 }
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(input.attachmentBlocks.enumerated()), id: \.offset) { _, block in
                    let ref = block["attachment"]
                    let photo = block["type"].string == "image"
                    let name = ref["name"].string.isEmpty ? (photo ? "图片附件" : "文件附件") : ref["name"].string
                    if photo {
                        Button { imageRef = ref } label: {
                            Label(name, systemImage: "photo").font(DSHFont.meta).lineLimit(1)
                                .padding(.horizontal, 12).frame(minHeight: 44)
                                .background(Theme.bubble, in: Capsule())
                        }.buttonStyle(.plain).disabled(!model.isOnline)
                    } else {
                        Label(name, systemImage: "doc").font(DSHFont.meta).foregroundStyle(Theme.meta)
                            .lineLimit(1).padding(.trailing, 4)
                    }
                }
                Text(MessageTime.label(input.time))
                    .font(DSHFont.meta).monospacedDigit()
                    .foregroundStyle(Theme.meta)
                    .padding(.trailing, 4)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .sheet(isPresented: Binding(get: { imageRef != nil }, set: { if !$0 { imageRef = nil } })) {
                if let imageRef, let sessionID = attachmentSessionID ?? model.selection { ImageAttachmentSheet(reference: imageRef, sessionID: sessionID) }
            }
        case .trigger(let label):
            HStack(spacing: 6) {
                DSHIcon("sparkle")
                Text(label).lineLimit(1)
                if !input.text.isEmpty {
                    SeparatorDot()
                    Text(input.text.split(separator: "\n").first.map(String.init) ?? "").lineLimit(1)
                }
            }
            .font(DSHFont.secondary)
            .foregroundStyle(Theme.process)
            .frame(minHeight: 40, alignment: .leading)
        }
    }
}

/// "已完成，用时 6秒" with its chevron and hairline.
struct TurnControl: View {
    let turn: Turn
    let open: Bool
    let collapsible: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                (Text(turn.controlLabel) + DurationText.text(turn.durationLabel ?? ""))
                    .lineLimit(1)
                if collapsible { DSHIcon(open ? "chevron-up-outline" : "chevron-down-outline") }
                Spacer(minLength: 0)
            }
            .font(DSHFont.content)
            .foregroundStyle(Theme.process)
            .frame(height: 44)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!collapsible)
        .accessibilityIdentifier("turn-control")
        .accessibilityValue(collapsible ? (open ? "已展开" : "已收起") : "")
    }
}

/// "深度求索中，用时 1分12秒 ···"
struct RunningIndicator: View {
    let since: Int?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 6) {
                LoadingIcon()
                Text(Elapsed.running(since: since, now: Int(context.date.timeIntervalSince1970 * 1000)))
                    .monospacedDigit()
            }
            .font(DSHFont.secondary)
            .foregroundStyle(Theme.deepDiving)
        }
        .accessibilityElement(children: .combine)
    }
}

struct RetryRowView: View {
    let retry: RetryRow
    let settled: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.dsh(0.12)) { open.toggle() } } label: {
                HStack(spacing: 7) {
                    Text(retry.status(settled: settled)).monospacedDigit()
                    DSHIcon(open ? "chevron-up-outline" : "chevron-down-outline", size: 14)
                }
                .font(DSHFont.secondary)
                .foregroundStyle(Theme.process)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    if !retry.failure.isEmpty {
                        (Text("失败原因：").foregroundColor(Theme.labelSecondary) + Text(retry.failure))
                    }
                    (Text("重试延迟：").foregroundColor(Theme.labelSecondary) + Text(String(format: "%.1fs", Double(retry.delayMs) / 1000)))
                }
                .font(DSHFont.meta)
                .foregroundStyle(Theme.process)
                .padding(.leading, 14)
                .padding(.bottom, 6)
            }
        }
    }
}

/// Red dot, "本轮运行失败", the provider message and its code.
struct TurnErrorRow: View {
    let message: String
    let code: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(Theme.error).frame(width: 8, height: 8).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 2) {
                (Text("本轮运行失败  ").fontWeight(.semibold).foregroundColor(Theme.error)
                 + Text(message).foregroundColor(Theme.labelSecondary))
                    .font(DSHFont.secondary)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                if !code.isEmpty {
                    Text(code).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.meta)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
