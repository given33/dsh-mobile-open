import SwiftUI
import DSHCore

struct QueueSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var editing: QueuedInput?
    @State private var removing: QueuedInput?
    @State private var editedText = ""
    @State private var busy = false
    @State private var problem: String?

    private var items: [QueuedInput] { model.directory[sessionID]?.queuedInputs ?? [] }

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if items.isEmpty {
                    ContentUnavailableView("暂无排队消息", systemImage: "text.line.first.and.arrowtriangle.forward")
                }
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.steering ? "引导当前任务" : "等待发送").font(DSHFont.meta).foregroundStyle(Theme.meta)
                            Text(item.text.isEmpty ? "附件消息" : item.text)
                                .font(DSHFont.content).textSelection(.enabled)
                        }
                        Spacer()
                        if model.canWrite {
                            Menu {
                                if item.textOnly && item.source["kind"].string == "user" {
                                    Button("编辑") { editedText = item.text; editing = item }
                                }
                                if !item.steering {
                                    Button("引导当前任务") { Task { await apply("steer", to: item) } }
                                }
                                Button("移除", role: .destructive) { removing = item }
                            } label: {
                                Image(systemName: "ellipsis.circle").frame(minWidth: 44, minHeight: 44)
                            }
                            .accessibilityLabel("排队消息操作")
                            .disabled(busy)
                        }
                    }
                }
            }
            .navigationTitle("排队消息").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .alert("编辑排队消息", isPresented: binding($editing), presenting: editing) { item in
                TextField("消息", text: $editedText)
                Button("保存") {
                    let value = editedText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !value.isEmpty { Task { await apply("edit", to: item, text: value) } }
                }
                Button("取消", role: .cancel) {}
            }
            .confirmationDialog("移除排队消息？", isPresented: binding($removing), titleVisibility: .visible, presenting: removing) { item in
                Button("移除", role: .destructive) { Task { await apply("remove", to: item) } }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func binding(_ item: Binding<QueuedInput?>) -> Binding<Bool> {
        Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })
    }

    private func apply(_ kind: String, to item: QueuedInput, text: String? = nil) async {
        guard !busy, items.contains(where: { $0.id == item.id }) else { return }
        busy = true; problem = nil
        defer { busy = false }
        var action: [String: JSON] = ["kind": .string(kind)]
        if let text { action["content"] = .array([.object(["type": .string("text"), "text": .string(text)])]) }
        do {
            try await model.mutate("session/updateQueue", fields: ["sessionId": .string(sessionID),
                "itemId": .string(item.id), "action": .object(action)])
        } catch { problem = error.localizedDescription }
    }
}
