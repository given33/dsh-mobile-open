import SwiftUI
import DSHCore

struct InteractionSheet: View {
    let interaction: PendingInteraction
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var selections: [String: [String]] = [:]
    @State private var custom: [String: String] = [:]
    @State private var submitting = false
    @State private var problem: String?
    @State private var approveConfirm = false

    private var live: Bool { model.pending(for: interaction.sessionId).contains(interaction) }
    private var actionable: Bool { live && model.canWrite && !submitting }
    private var questions: [JSON] { interaction.request["questions"].array.filter { !$0["id"].string.isEmpty } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !live {
                        Label("此请求已由其他设备处理，或已结束。", systemImage: "info.circle")
                            .foregroundStyle(Theme.meta)
                    } else if !model.canWrite {
                        Label("需要在电脑上开启「允许手机操作」。", systemImage: "lock")
                            .foregroundStyle(Theme.meta)
                    }
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.circle").foregroundStyle(Theme.warnText)
                    }
                    if interaction.kind == .approval {
                        approval
                    } else {
                        ForEach(Array(questions.enumerated()), id: \.offset) { _, item in question(item) }
                        Button("提交") { Task { await submit(ActionPayload.answers(answers)) } }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(!actionable || questions.isEmpty || answers.count != questions.count)
                            .accessibilityIdentifier("submit-question")
                    }
                }
                .padding(20)
                .frame(maxWidth: 620).frame(maxWidth: .infinity, alignment: .center)
            }
            .background(Theme.sheet)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(submitting) } }
            .confirmationDialog("允许执行这项操作？", isPresented: $approveConfirm, titleVisibility: .visible) {
                Button("仅允许本次") { Task { await submit(.string("allowed-once")) } }.disabled(!actionable)
                Button("取消", role: .cancel) {}
            } message: { Text(interaction.summary) }
        }
        .interactiveDismissDisabled(submitting)
    }

    private var title: String {
        switch interaction.kind {
        case .approval: "审批请求"
        case .question: "回答问题"
        case .planReview: "审阅计划"
        }
    }

    private var approval: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(interaction.summary).font(.title3.bold())
            if !interaction.detail.isEmpty { Text(interaction.detail).textSelection(.enabled) }
            let callID = interaction.request["callId"].string
            if let tool = model.tool(callID), !tool.argsRaw.isEmpty {
                Text("请求执行的参数").font(.headline)
                CodeBlockView(language: "json", code: tool.argsRaw)
            } else if let args = [interaction.request["arguments"], interaction.request["input"], interaction.request["args"]]
                .first(where: { $0 != .null }) {
                CodeBlockView(language: "json", code: args.string.isEmpty ? args.pretty : args.string)
            }
            Button("仅允许本次") { approveConfirm = true }.buttonStyle(PrimaryButtonStyle())
                .disabled(!actionable).accessibilityIdentifier("approve-once")
            Button("拒绝", role: .destructive) { Task { await submit(.string("rejected")) } }
                .frame(minHeight: 44).disabled(!actionable).accessibilityIdentifier("reject-approval")
        }
    }

    private func question(_ value: JSON) -> some View {
        let id = value["id"].string
        let intent = value["intent"]["kind"].string
        let display = value["intent"]["display"]
        let fixed = intent == "plan-review" || intent == "approval"
        let multiple = !fixed && value["multiSelect"].bool
        let selected = selections[id, default: []]
        return VStack(alignment: .leading, spacing: 8) {
            if !value["header"].string.isEmpty { Text(value["header"].string).font(DSHFont.meta).foregroundStyle(Theme.meta) }
            Text(localized(display["question"], fallback: value["question"].string)).font(.headline)
            let detail = localized(display["detail"], fallback: value["detail"].string)
            if !detail.isEmpty { MarkdownView(text: detail) }
            ForEach(Array(value["options"].array.enumerated()), id: \.offset) { _, option in
                let label = option["label"].string
                if !label.isEmpty {
                    Button {
                        if multiple {
                            selections[id] = selected.contains(label) ? selected.filter { $0 != label } : selected + [label]
                        } else {
                            selections[id] = [label]; custom[id] = nil
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: selected.contains(label) ? "checkmark.circle.fill" : "circle")
                            VStack(alignment: .leading, spacing: 3) {
                                Text(label).font(DSHFont.content)
                                if !option["description"].string.isEmpty {
                                    Text(option["description"].string).font(DSHFont.meta).foregroundStyle(Theme.meta)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(9).frame(minHeight: 44)
                        .background(Theme.grouped, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected.contains(label) ? .isSelected : [])
                }
            }
            if !fixed {
                TextField("其他回答", text: Binding(get: { custom[id, default: ""] }, set: {
                    custom[id] = $0
                    if !multiple && !$0.isEmpty { selections[id] = [] }
                }), axis: .vertical)
                .lineLimit(2...5)
                .padding(10).background(Theme.grouped, in: RoundedRectangle(cornerRadius: 10))
            }
            Hairline()
        }
        .disabled(!actionable)
    }

    private var answers: [QuestionAnswer] {
        questions.compactMap { value in
            let id = value["id"].string
            let labels = selections[id, default: []]
            let text = custom[id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !labels.isEmpty || !text.isEmpty else { return nil }
            return QuestionAnswer(id: id, selected: labels, custom: text)
        }
    }

    private func localized(_ value: JSON, fallback: String) -> String {
        let text = value["zh"].string
        return text.isEmpty ? (fallback.isEmpty ? value["en"].string : fallback) : text
    }

    private func submit(_ value: JSON) async {
        guard actionable else { return }
        submitting = true; problem = nil
        defer { submitting = false }
        do { try await model.resolve(interaction, with: value); dismiss() }
        catch { problem = error.localizedDescription }
    }
}
