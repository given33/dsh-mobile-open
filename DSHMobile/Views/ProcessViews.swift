import SwiftUI
import DSHCore

/// A process group: the desktop's one-line header ("更新了计划，已搜索代码，已读取文件")
/// over the steps it folds. Detailed (running) and Verbose show the steps flat.
struct ProcessGroupView: View {
    let group: ProcessGroup
    let mode: DisplayMode
    let running: Bool
    let cwd: String
    @Binding var open: Bool
    let onTool: (ToolRow) -> Void

    /// Detailed hides headers in running turns; Verbose hides them everywhere.
    private var showsHeader: Bool {
        switch mode {
        case .compact, .standard: true
        case .detailed: !running
        case .verbose: false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsHeader {
                header
            }
            if open || !showsHeader {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(group.items) { item in
                        switch item {
                        case .reasoning(let reasoning): ReasoningRowView(row: reasoning, showsPreview: mode != .compact)
                        case .tool(let tool): ToolRowView(tool: tool, cwd: cwd, onTap: tool.hasDetail ? { onTool(tool) } : nil)
                        }
                    }
                }
                .padding(.bottom, showsHeader ? 6 : 0)
            }
        }
    }

    private var title: String { group.title(mode: mode) }

    private var header: some View {
        Button { withAnimation(.dsh(0.16)) { open.toggle() } } label: {
            HStack(spacing: 6) {
                Group {
                    if open { DSHIcon("chevron-down-outline") } else { DSHIcon(group.leadCategory?.icon ?? "think-outline") }
                }
                .frame(width: 18, height: 18)
                if group.closed { Text(title).lineLimit(1) } else { ShimmerText(text: title) }
                Spacer(minLength: 0)
            }
            .font(DSHFont.content)
            .foregroundStyle(Theme.process)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(open ? "已展开" : "已收起")
    }
}

/// One tool call: icon, title, separator dot, summary; error summaries in red.
struct ToolRowView: View {
    let tool: ToolRow
    let cwd: String
    let onTap: (() -> Void)?

    var body: some View {
        if let onTap {
            Button(action: onTap) { content }
                .buttonStyle(.plain)
                .accessibilityHint("查看详情")
        } else {
            content
        }
    }

    private var title: String { tool.state == .preparing ? tool.category.preparing : tool.title }

    private var summary: String {
        if let error = tool.errorSummary { return error }
        return tool.summary(cwd: cwd)
    }

    private var summaryColor: Color {
        switch tool.state {
        case .error: Theme.error
        case .stopped: Theme.warnText
        default: Theme.process
        }
    }

    private var content: some View {
        HStack(spacing: 0) {
            Group {
                if tool.state == .running || tool.state == .preparing { Spinner(size: 16, color: Theme.process) }
                else { DSHIcon(tool.category.icon) }
            }
            .frame(width: 18, height: 18)
            .padding(.trailing, 6)
            Text(title).lineLimit(1).layoutPriority(1)
            if !summary.isEmpty {
                SeparatorDot()
                Text(summary).foregroundStyle(summaryColor).lineLimit(1).truncationMode(.tail)
            }
            if let code = tool.exitCode, code != 0 {
                HStack(spacing: 5) {
                    Circle().fill(Theme.error).frame(width: 4, height: 4)
                    Text("\(code)").monospacedDigit()
                }
                .padding(.leading, 8)
            }
            Spacer(minLength: 6)
            if onTap != nil { DSHIcon("chevron-right-outline", size: 14).foregroundStyle(Theme.mark) }
        }
        .font(DSHFont.secondary)
        .foregroundStyle(Theme.process)
        .frame(minHeight: 40)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension ToolRow {
    /// Preparing calls render one non-expandable row, as on the desktop.
    var hasDetail: Bool { state != .preparing }
}

/// "思考 · 预览" with the full reasoning on tap.
struct ReasoningRowView: View {
    let row: ReasoningRow
    let showsPreview: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.dsh(0.16)) { open.toggle() } } label: {
                HStack(spacing: 0) {
                    Group {
                        if open { DSHIcon("chevron-down-outline") } else { DSHIcon("think-outline") }
                    }
                    .frame(width: 18, height: 18)
                    .padding(.trailing, 6)
                    Text("思考")
                    if showsPreview, !open, let preview = row.preview {
                        SeparatorDot()
                        Text(preview).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .font(DSHFont.secondary)
                .foregroundStyle(Theme.process)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text(row.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(DSHFont.secondary)
                    .foregroundStyle(Theme.process)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(.leading, 24)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The desktop TodoPanel, docked above the home indicator.
struct TodoDock: View {
    let items: [TodoItem]
    let progress: String
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.dsh()) { open.toggle() } } label: {
                HStack(spacing: 10) {
                    DSHIcon("checklist-outline").foregroundStyle(Theme.process)
                    Text("任务").font(DSHFont.secondary.weight(.medium)).foregroundStyle(Theme.labelPrimary)
                    Text(progress).font(DSHFont.secondary).foregroundStyle(Theme.process).lineLimit(1)
                    Spacer(minLength: 0)
                    DSHIcon(open ? "chevron-down-outline" : "chevron-up-outline").foregroundStyle(Theme.process)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("任务，\(progress)")
            .accessibilityIdentifier("todo-dock")
            if open {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in TodoRow(item: item) }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                }
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .background(.ultraThinMaterial)
        .background(Theme.menu)
        .panelElevation()
    }
}

struct TodoRow: View {
    let item: TodoItem
    var body: some View {
        HStack(spacing: 10) {
            Group {
                switch item.status {
                case .completed: StateDot(.done)
                case .inProgress: Spinner()
                case .pending: StateDot(.idle)
                }
            }
            .frame(width: 16, height: 16)
            Text(item.content)
                .font(DSHFont.secondary)
                .foregroundStyle(Theme.labelSecondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(item.label)
    }
}

/// A compact entry into the native response form.
struct PendingCard: View {
    let interaction: PendingInteraction
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                StateDot(.warning, size: 14)
                Text(kindLine)
            }
            .font(DSHFont.meta.weight(.medium))
            .foregroundStyle(Theme.meta)
            Text(interaction.summary)
                .font(.headline)
                .foregroundStyle(Theme.labelPrimary)
                .padding(.top, 8)
                .fixedSize(horizontal: false, vertical: true)
            if !compact {
                switch interaction.kind {
                case .question: options
                case .approval: approval
                case .planReview: EmptyView()
                }
            }
            HStack(spacing: 6) {
                DSHIcon("chevron-right-outline")
                Text(hint)
            }
            .font(DSHFont.secondary)
            .foregroundStyle(Theme.meta)
            .padding(.top, 12)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sheet)
        .panelElevation(stroke: Theme.borderL3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pending-card")
    }

    private var question: JSON { interaction.request["questions"].array.first ?? .null }

    private var kindLine: String {
        switch interaction.kind {
        case .question:
            let header = question["header"].string
            return header.isEmpty ? "等待回答" : "等待回答 · \(header)"
        case .approval: return "等待审批"
        case .planReview: return "计划待审"
        }
    }

    private var hint: String {
        switch interaction.kind {
        case .question: "查看并回答"
        case .approval: "查看审批详情"
        case .planReview: "查看并审阅"
        }
    }

    @ViewBuilder private var options: some View {
        let list = question["options"].array
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Hairline()
                ForEach(Array(list.enumerated()), id: \.offset) { _, option in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option["label"].string).font(DSHFont.content).foregroundStyle(Theme.labelPrimary)
                        if !option["description"].string.isEmpty {
                            Text(option["description"].string).font(DSHFont.meta).foregroundStyle(Theme.meta)
                        }
                    }
                    .padding(.vertical, 10)
                    Hairline()
                }
            }
            .padding(.top, 10)
        }
    }

    @ViewBuilder private var approval: some View {
        if let command = approvalCommand {
            Text(command)
                .font(DSHFont.code)
                .foregroundStyle(Theme.labelPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.codeBlock, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.borderL1, lineWidth: 0.5))
                .padding(.top, 10)
        }
        if !interaction.detail.isEmpty {
            Text(interaction.detail)
                .font(DSHFont.secondary)
                .foregroundStyle(Theme.labelSecondary)
                .padding(.top, 10)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The command or path the call wants to run, when the request carries one.
    private var approvalCommand: String? {
        let request = interaction.request
        for container in [request["arguments"], request["input"], request["args"], request] {
            var value = container
            if case .string(let raw) = container, let parsed = try? JSON.parse(Data(raw.utf8)) { value = parsed }
            for key in ["command", "cmd", "file_path", "path", "url"] {
                let text = value[key].string
                if !text.isEmpty { return text }
            }
        }
        return nil
    }
}
