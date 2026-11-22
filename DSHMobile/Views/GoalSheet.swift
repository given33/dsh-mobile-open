import SwiftUI
import DSHCore

struct GoalSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var goal: JSON = .null
    @State private var loaded = false
    @State private var editing = false
    @State private var clearing = false
    @State private var saving = false
    @State private var objective = ""
    @State private var rounds = ""
    @State private var editRef: JSON = .null
    @State private var problem: String?

    private var active: Bool { !goal["id"].string.isEmpty }
    private var phase: String { goal["phase"].string }
    private var allowed: Bool { model.canWrite && loaded && !saving }
    private var ref: JSON { .object(["id": goal["id"], "revision": goal["revision"]]) }
    private var projection: JSON { model.directory[sessionID]?.projection["goal"] ?? .null }
    private var cleanObjective: String { objective.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cap: Int? { Int(rounds) }

    var body: some View {
        NavigationStack {
            Form {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if !loaded && problem == nil { ProgressView("正在读取会话目标") }
                if active {
                    Section("当前目标") {
                        Text(goal["objective"].string).textSelection(.enabled)
                        LabeledContent("状态", value: status)
                        LabeledContent("已开始的轮次", value: "\(goal["roundsStarted"].int) / \(goal["maxGoalRounds"].int)")
                        if !goal["blockedReason"]["message"].string.isEmpty {
                            Text(goal["blockedReason"]["message"].string).foregroundStyle(Theme.warnText)
                        }
                    }
                    if model.canWrite {
                        Section("目标操作") {
                            if phase != "complete" {
                                Button("编辑目标") { begin() }
                                if phase == "active" && goal["activation"].string != "disarmed" {
                                    Button("暂停") { perform("pause", ref: ref) }
                                } else if phase == "paused" || phase == "active" {
                                    Button("继续") { perform("resume", ref: ref) }
                                }
                                Button("标记为完成") { perform("complete", ref: ref) }
                            }
                            Button("清除目标", role: .destructive) { clearing = true }
                        }.disabled(!allowed)
                    }
                } else if loaded {
                    Section {
                        Text("这个会话没有目标。").foregroundStyle(Theme.meta)
                        if model.canWrite { Button("创建目标") { begin() }.disabled(!allowed) }
                    }
                }
                if loaded && !model.canWrite { Label("当前仅可查看", systemImage: "lock") }
            }
            .navigationTitle("会话目标").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task(id: model.isOnline) { if model.isOnline { await load() } }
            .onChange(of: projection) { _, _ in
                if model.isOnline && !saving { Task { await load() } }
            }
            .refreshable { await load() }
            .confirmationDialog("清除当前目标？", isPresented: $clearing, titleVisibility: .visible) {
                Button("清除", role: .destructive) { perform("clear", ref: ref) }
                Button("取消", role: .cancel) {}
            }
            .sheet(isPresented: $editing) {
                NavigationStack {
                    Form {
                        Section("目标描述") {
                            TextField("希望完成什么？", text: $objective, axis: .vertical).lineLimit(4...10)
                        }
                        Section("最大轮次") {
                            TextField("留空使用默认值", text: $rounds).keyboardType(.numberPad)
                        }
                        if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                    }
                    .navigationTitle(editRef == .null ? "创建目标" : "编辑目标")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { editing = false }.disabled(saving) }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("保存") { save() }
                                .disabled(!allowed || cleanObjective.isEmpty || (!rounds.isEmpty && (cap ?? 0) < 1))
                        }
                    }
                }
                .interactiveDismissDisabled(saving)
            }
        }
    }

    private var status: String {
        switch phase {
        case "active": goal["activation"].string == "disarmed" ? "等待继续" : "进行中"
        case "paused": "已暂停"
        case "blocked": "受阻"
        case "complete": "已完成"
        default: phase
        }
    }

    private func begin() {
        objective = active ? goal["objective"].string : ""
        rounds = active ? String(goal["maxGoalRounds"].int) : ""
        editRef = active ? ref : .null
        problem = nil
        editing = true
    }

    private func save() {
        var fields: [String: JSON] = ["objective": .string(cleanObjective)]
        if let cap { fields["maxGoalRounds"] = .number(Double(cap)) }
        perform(editRef == .null ? "create" : "edit", ref: editRef, request: .object(fields))
    }

    private func perform(_ action: String, ref: JSON, request: JSON = .null) {
        guard allowed else { return }
        saving = true
        problem = nil
        var args: [String: JSON] = ["agentId": .string(sessionID)]
        if ref != .null { args["ref"] = ref }
        if request != .null { args["request"] = request }
        Task {
            defer { saving = false }
            do {
                try await model.action("goals/\(action)", args: .object(args))
                editing = false
                await load()
            } catch { problem = error.localizedDescription }
        }
    }

    private func load() async {
        do {
            let value = try await model.read("goals/get", args: .object(["agentId": .string(sessionID)]))
            guard !Task.isCancelled else { return }
            goal = value
            loaded = true
            if !editing { problem = nil }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
