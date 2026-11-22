import SwiftUI
import DSHCore

struct AgentPresetsSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var presets: [JSON]?
    @State private var selected: String?
    @State private var problem: String?

    private var active: String { selected ?? model.directory[sessionID]?.raw["agentPreset"].string ?? "" }

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if presets == nil && problem == nil { ProgressView("正在读取智能体预设") }
                ForEach(presets ?? [], id: \.self) { row in
                    NavigationLink {
                        PresetDetail(sessionID: sessionID, row: row, selected: $selected,
                                     isCurrent: active == row["id"].string || (active.isEmpty && row["isDefault"].bool))
                    } label: {
                        LabeledContent(row["name"].string.isEmpty ? row["id"].string : row["name"].string,
                                       value: active == row["id"].string || (active.isEmpty && row["isDefault"].bool) ? "当前" : "")
                    }
                }
            }
            .navigationTitle("智能体预设").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
            .task { await load() }.refreshable { await load() }
        }
    }

    private func load() async {
        do { presets = try await model.read("agentPresets/list", args: .object([:]))["presets"].array; problem = nil }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct PresetDetail: View {
    let sessionID: String
    let row: JSON
    @Binding var selected: String?
    let isCurrent: Bool
    @EnvironmentObject private var model: AppModel
    @State private var document: JSON?
    @State private var problem: String?
    @State private var busy = false
    @State private var confirm = false

    private var id: String { row["id"].string }
    private var name: String { row["name"].string.isEmpty ? id : row["name"].string }

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            if !row["description"].string.isEmpty { Text(row["description"].string) }
            if !row["broken"].string.isEmpty { Text(row["broken"].string).foregroundStyle(Theme.warnText) }
            if let document { Text(document["content"].string).font(DSHFont.code).textSelection(.enabled) }
            if isCurrent || selected == id { Text("此会话正在使用该预设。") }
            else { Button("用于当前会话") { confirm = true }.disabled(!model.canWrite || busy || !row["broken"].string.isEmpty) }
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .task {
            do { document = try await model.read("agentPresets/read", args: .object(["agentPreset": .string(id)])) }
            catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
        .confirmationDialog("切换智能体预设？", isPresented: $confirm, titleVisibility: .visible) {
            Button("使用「\(name)」") { Task { await apply() } }
            Button("取消", role: .cancel) {}
        }
    }

    private func apply() async {
        guard !busy else { return }
        busy = true; problem = nil; defer { busy = false }
        do {
            let result = try await model.action("agentPresets/select", args: .object(["agentId": .string(sessionID), "agentPreset": .string(id)]))
            selected = result.string.isEmpty ? id : result.string
        } catch { problem = error.localizedDescription }
    }
}
