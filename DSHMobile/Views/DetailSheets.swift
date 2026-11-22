import SwiftUI
import DSHCore

struct ToolDetailSheet: View {
    let tool: ToolRow
    let cwd: String

    private var summary: String { tool.summary(cwd: cwd) }
    private var directory: String {
        for key in ["cwd", "workdir", "workingDirectory"] {
            let path = tool.args[key].string
            if !path.isEmpty { return path }
        }
        return cwd
    }
    private var command: String {
        let value = tool.args["command"].string
        return value.isEmpty ? tool.args["cmd"].string : value
    }

    var body: some View {
        DetailSheet(title: tool.title, subtitle: summary) {
            if tool.variant == .bash && !command.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 8) {
                        Circle().fill(tool.state == .error ? Theme.error : tool.state == .ok ? Theme.success : Theme.mark)
                            .frame(width: 8, height: 8).padding(.top, 5).accessibilityHidden(true)
                        Text(command).textSelection(.enabled)
                        Spacer(minLength: 0)
                    }
                    .padding(12).background(Theme.codeBanner)
                    if let output = tool.output, !output.isEmpty {
                        Hairline()
                        Text(output).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                }
                .font(DSHFont.code)
                .background(Theme.codeBlock, in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let output = tool.output, !output.isEmpty {
                CodeBlockView(language: "输出", code: output)
            }

            VStack(spacing: 0) {
                DetailFact(title: "状态", value: state)
                if let exitCode = tool.exitCode { DetailFact(title: "退出码", value: String(exitCode), mono: true) }
                if !directory.isEmpty { DetailFact(title: "工作目录", value: directory, mono: true) }
                DetailFact(title: "工具", value: tool.name, mono: true)
            }
            if !tool.argsRaw.isEmpty {
                DisclosureGroup("调用参数") { CodeBlockView(language: "json", code: tool.argsRaw) }
                    .font(DSHFont.content)
            }
            if !tool.subCalls.isEmpty {
                DisclosureGroup("子步骤") {
                    ForEach(tool.subCalls) { child in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(child.title).font(.headline)
                            Text(child.summary(cwd: cwd)).font(DSHFont.secondary).foregroundStyle(Theme.meta)
                            if let output = child.output, !output.isEmpty {
                                CodeBlockView(language: "输出", code: output)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
        }
    }

    private var state: String {
        switch tool.state {
        case .preparing: "准备中"
        case .running: "进行中"
        case .ok: "已完成"
        case .error: "失败"
        case .stopped: "已停止"
        }
    }
}

struct SessionStatsSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        DetailSheet(title: "会话统计") {
            if let row = model.directory[sessionID] {
                let usage = row.usage
                let throughput = [usage.counts, usage.speed].compactMap { $0 }.joined(separator: " · ")
                let tokens = [usage.tokens, usage.cacheHit].compactMap { $0 }.joined(separator: " · ")
                if !throughput.isEmpty { pill(throughput, icon: "gauge.with.dots.needle.50percent") }
                if !tokens.isEmpty { pill(tokens, icon: "cylinder") }
                if let context = usage.context { pill("上下文已用 \(context)", icon: "chart.bar") }
                if throughput.isEmpty && tokens.isEmpty && usage.context == nil {
                    Text("暂无用量统计").font(DSHFont.secondary).foregroundStyle(Theme.meta)
                }
                if let counts = row.todos {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("任务 · \(counts.done)/\(counts.total) 已完成").font(.headline)
                        ForEach(Array(row.todoItems.enumerated()), id: \.offset) { _, item in TodoRow(item: item) }
                    }
                }
                VStack(spacing: 0) {
                    if !row.cwd.isEmpty { DetailFact(title: "工作目录", value: row.cwd, mono: true) }
                    if !row.model.isEmpty { DetailFact(title: "模型", value: row.model) }
                    if let permission = row.permissionLabel { DetailFact(title: "权限", value: permission) }
                }
            } else {
                Text("此会话已不在电脑的会话列表中。").foregroundStyle(Theme.meta)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func pill(_ value: String, icon: String) -> some View {
        Label(value, systemImage: icon)
            .font(DSHFont.meta.monospacedDigit())
            .padding(.vertical, 8).padding(.horizontal, 10)
            .background(Theme.grouped, in: Capsule())
    }
}

private struct DetailSheet<Content: View>: View {
    let title: String
    var subtitle = ""
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) { content }
                    .frame(maxWidth: 720, alignment: .leading).padding(20)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .background(Theme.sheet)
            .foregroundStyle(Theme.labelPrimary)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !subtitle.isEmpty {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 2) {
                            Text(title).font(.headline)
                            Text(subtitle).font(DSHFont.caption).foregroundStyle(Theme.meta).lineLimit(1)
                        }.accessibilityElement(children: .combine)
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
        .presentationDragIndicator(.visible)
    }
}

private struct DetailFact: View {
    let title: String
    let value: String
    var mono = false

    var body: some View {
        VStack(spacing: 0) {
            LabeledContent(title) {
                Text(value).font(mono ? DSHFont.code : DSHFont.secondary)
                    .foregroundStyle(Theme.labelPrimary).textSelection(.enabled)
            }
            .font(DSHFont.secondary)
            .padding(.vertical, 10)
            Hairline()
        }
    }
}
