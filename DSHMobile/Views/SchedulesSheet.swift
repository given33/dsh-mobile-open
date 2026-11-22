import SwiftUI
import DSHCore

private struct ScheduleItem: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
    var sessionID: String { raw["sessionId"].string }
    var title: String { raw["title"].string.isEmpty ? id : raw["title"].string }
    var isActive: Bool { raw["status"].string == "active" }
    var expected: JSON {
        var fields = raw.object
        for key in ["sessionId", "status", "lastDelivery", "lastScheduledAt"] { fields[key] = nil }
        // Pass only the durable record, as expected by schedule/update.
        let keys = Set(["id", "title", "prompt", "kind", "scheduledAt", "afterSeconds", "everySeconds",
                        "time", "timeZone", "weekdays", "expression"])
        return .object(fields.filter { keys.contains($0.key) })
    }
}

struct SchedulesSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [ScheduleItem] = []
    @State private var ready = false
    @State private var error: String?
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(Theme.warnText) }
                if !ready && error == nil { ProgressView("正在读取定时任务") }
                if ready && rows.isEmpty { ContentUnavailableView("暂无定时任务", systemImage: "calendar.badge.clock") }
                ForEach(rows) { item in
                    NavigationLink {
                        ScheduleDetail(item: item, refresh: reload)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title).font(.headline)
                            Text(model.directory[item.sessionID]?.title ?? item.sessionID)
                                .font(DSHFont.secondary).foregroundStyle(Theme.meta)
                            LabeledContent(item.isActive ? "下次触发" : "已结束") {
                                ScheduleDate(value: item.raw["scheduledAt"].string)
                            }.font(DSHFont.meta).foregroundStyle(Theme.meta)
                        }
                    }
                }
            }
            .navigationTitle("定时任务").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { Label("新建定时任务", systemImage: "plus") }.disabled(!model.canWrite)
                }
            }
            .sheet(isPresented: $adding) { NewScheduleSheet(completed: reload) }
            .task(id: model.isOnline) { if model.isOnline { await reload() } }
            .refreshable { await reload() }
        }
    }

    private func reload() async {
        do {
            let values = try await model.read("schedule/catalog", args: .object([:]))
            guard !Task.isCancelled else { return }
            rows = values.array.map(ScheduleItem.init).filter { !$0.id.isEmpty && !$0.sessionID.isEmpty }
            ready = true
            error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct ScheduleDetail: View {
    @State var item: ScheduleItem
    let refresh: () async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var history: [JSON] = []
    @State private var next = ""
    @State private var historyReady = false
    @State private var busy = false
    @State private var problem: String?
    @State private var edit = false
    @State private var confirmDelete = false
    @State private var title = ""
    @State private var prompt = ""
    @State private var changeTime = false
    @State private var rule = ScheduleRule()

    private var cleanTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var address: [String: JSON] { ["sessionId": .string(item.sessionID), "id": .string(item.id)] }

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(Theme.warnText) }
            Section("任务详情") {
                Text(item.raw["prompt"].string).textSelection(.enabled)
                LabeledContent("触发时间") { ScheduleDate(value: item.raw["scheduledAt"].string) }
                LabeledContent("规则", value: recurrence)
                LabeledContent("状态", value: item.isActive ? "启用" : "已结束")
            }
            Section("投递记录") {
                if !historyReady && problem == nil { ProgressView() }
                if historyReady && history.isEmpty { Text("暂无记录").foregroundStyle(Theme.meta) }
                ForEach(Array(history.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 6) {
                        ScheduleDate(value: row["deliveredAt"].string).font(.headline)
                        if !row["prompt"].string.isEmpty { Text(row["prompt"].string).textSelection(.enabled) }
                    }
                }
                if !next.isEmpty {
                    Button("加载更早") { Task { await loadHistory(before: next) } }.disabled(busy)
                }
            }
            if model.canWrite {
                Section {
                    if item.isActive {
                        Button("编辑任务") {
                            title = item.title; prompt = item.raw["prompt"].string
                            changeTime = false
                            rule = ScheduleRule(record: item.raw)
                            problem = nil; edit = true
                        }
                    }
                    Button("删除任务", role: .destructive) { confirmDelete = true }
                }.disabled(busy)
            }
        }
        .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
        .task { await loadHistory() }
        .confirmationDialog("删除此定时任务？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) { Task { await remove() } }
            Button("取消", role: .cancel) {}
        }
        .sheet(isPresented: $edit) {
            NavigationStack {
                Form {
                    Section("任务") {
                        TextField("名称", text: $title)
                        TextField("投递内容", text: $prompt, axis: .vertical).lineLimit(4...10)
                    }
                    Section("触发时间") {
                        Toggle("修改触发规则", isOn: $changeTime)
                        if changeTime { ScheduleRuleFields(rule: $rule, includeDelay: false) }
                    }
                    if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                }
                .navigationTitle("编辑定时任务").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { edit = false }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") { Task { await save() } }
                            .disabled(busy || !model.canWrite || cleanTitle.isEmpty || cleanTitle.count > 120 ||
                                      cleanPrompt.isEmpty || (changeTime && rule.change == nil))
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private var recurrence: String {
        let time = item.raw["time"].string
        let zone = item.raw["timeZone"].string
        switch item.raw["kind"].string {
        case "every": return "每 \(item.raw["everySeconds"].int) 秒"
        case "daily": return "每天 \(time) · \(zone)"
        case "weekly":
            let days = item.raw["weekdays"].array.map { String($0.int) }.joined(separator: "、")
            return "每周 \(days) · \(time) · \(zone)"
        case "cron": return "\(item.raw["expression"].string) · \(zone)"
        default: return "一次"
        }
    }

    fileprivate static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func loadHistory(before: String = "") async {
        guard !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        var fields = address
        fields["limit"] = .number(20)
        if !before.isEmpty { fields["before"] = .string(before) }
        do {
            let result = try await model.read("schedule/history", args: ActionPayload.request(fields))
            guard !Task.isCancelled else { return }
            guard result["code"].string.isEmpty else { throw ClientError.message(result["code"].string) }
            if before.isEmpty { history = [] }
            history += result["records"].array
            historyReady = true
            next = result["nextBefore"].string
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func save() async {
        guard !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        var fields = address
        fields["expected"] = item.expected
        fields["title"] = .string(cleanTitle)
        fields["prompt"] = .string(cleanPrompt)
        if changeTime { fields["change"] = rule.change }
        do {
            let result = try await model.mutate("schedule/update", fields: fields)
            guard result["updated"].bool else {
                let detail = result["message"].string
                throw ClientError.message(detail.isEmpty ? "这项任务可能已变化，请返回列表刷新后重试。" : detail)
            }
            var updated = result["record"].object
            updated["sessionId"] = .string(item.sessionID)
            updated["status"] = .string("active")
            item = ScheduleItem(raw: .object(updated))
            edit = false
            await refresh()
        } catch { problem = error.localizedDescription }
    }

    private func remove() async {
        guard !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        do {
            let result = try await model.mutate("schedule/delete", fields: address)
            guard result["deleted"].bool else { throw ClientError.message("该任务已不在电脑的列表中。") }
            await refresh()
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

private struct ScheduleDate: View {
    let value: String
    var body: some View {
        if let date = ScheduleDetail.date(value) {
            Text(date.formatted(date: .abbreviated, time: .shortened))
        } else {
            Text(value.isEmpty ? "—" : value)
        }
    }
}
