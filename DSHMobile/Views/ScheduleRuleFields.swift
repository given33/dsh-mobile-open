import SwiftUI
import DSHCore

struct ScheduleRuleFields: View {
    @Binding var rule: ScheduleRule
    var includeDelay = true
    var body: some View {
        Picker("触发规则", selection: $rule.kind) {
            ForEach(ScheduleRule.Kind.allCases.filter { includeDelay || $0 != .after }) { kind in
                Text(kind.label).tag(kind)
            }
        }
        switch rule.kind {
        case .after, .every:
            TextField(rule.kind == .after ? "延迟秒数" : "间隔秒数（至少 60）", text: $rule.seconds)
                .keyboardType(.numberPad)
        case .at:
            DatePicker("时间", selection: $rule.instant, in: Date.now...)
        case .daily, .weekly:
            TextField("时间（HH:mm:ss）", text: $rule.wallTime).keyboardType(.numbersAndPunctuation)
            zone
            if rule.kind == .weekly {
                ForEach(1...7, id: \.self) { day in
                    Toggle(["周一", "周二", "周三", "周四", "周五", "周六", "周日"][day - 1],
                           isOn: Binding(get: { rule.days.contains(day) }, set: {
                               if $0 { rule.days.insert(day) } else { rule.days.remove(day) }
                           }))
                }
            }
        case .cron:
            TextField("分 时 日 月 星期", text: $rule.expression)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            zone
        }
    }

    private var zone: some View {
        TextField("时区（例如 Asia/Shanghai）", text: $rule.zone)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}

struct ScheduleRule {
    enum Kind: String, CaseIterable, Identifiable {
        case at, after, every, daily, weekly, cron
        var id: String { rawValue }
        var label: String {
            switch self {
            case .at: "指定时间"
            case .after: "延迟一次"
            case .every: "固定间隔"
            case .daily: "每天"
            case .weekly: "每周"
            case .cron: "Cron"
            }
        }
    }
    var kind: Kind = .at
    var instant = Date.now.addingTimeInterval(3600)
    var seconds = ""
    var wallTime = "09:00:00"
    var zone = TimeZone.current.identifier
    var days: Set<Int> = [1]
    var expression = ""

    init() {}
    init(record: JSON) {
        kind = Kind(rawValue: record["kind"].string) ?? .at
        if kind == .after { kind = .at }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: record["scheduledAt"].string), date > .now { instant = date }
        if record["everySeconds"].int > 0 { seconds = String(record["everySeconds"].int) }
        if !record["time"].string.isEmpty { wallTime = record["time"].string }
        if !record["timeZone"].string.isEmpty { zone = record["timeZone"].string }
        let weekdays = Set(record["weekdays"].array.map(\.int))
        if !weekdays.isEmpty { days = weekdays }
        expression = record["expression"].string
    }

    var selector: [String: JSON]? {
        let zoneID = zone.trimmingCharacters(in: .whitespacesAndNewlines)
        let time = wallTime.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .after, .every:
            guard let n = Int(seconds), n >= (kind == .after ? 1 : 60), n <= 31_536_000 else { return nil }
            return [kind == .after ? "after_seconds" : "every_seconds": .number(Double(n))]
        case .at:
            guard instant > .now else { return nil }
            return ["at": .string(ISO8601DateFormatter().string(from: instant))]
        case .daily, .weekly:
            guard TimeZone(identifier: zoneID) != nil,
                  time.range(of: #"^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$"#, options: .regularExpression) != nil else { return nil }
            var fields: [String: JSON] = ["time": .string(time), "time_zone": .string(zoneID)]
            if kind == .weekly {
                guard !days.isEmpty else { return nil }
                fields["weekdays"] = .array(days.sorted().map { .number(Double($0)) })
            }
            return [kind.rawValue: .object(fields)]
        case .cron:
            guard TimeZone(identifier: zoneID) != nil else { return nil }
            let fields = expression.split(whereSeparator: \.isWhitespace)
            guard fields.count == 5 else { return nil }
            return ["cron": .object(["expression": .string(fields.joined(separator: " ")), "time_zone": .string(zoneID)])]
        }
    }

    var change: JSON? {
        guard kind != .after, var selector else { return nil }
        selector["kind"] = .string(kind.rawValue)
        return .object(selector)
    }
}

struct NewScheduleSheet: View {
    let completed: () async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var session = ""
    @State private var title = ""
    @State private var prompt = ""
    @State private var rule = ScheduleRule()
    @State private var saving = false
    @State private var problem: String?

    private var cleanTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                Section("投递到") {
                    Picker("会话", selection: $session) {
                        Text("请选择").tag("")
                        ForEach(model.directory.visible.sorted { $0.updatedAt > $1.updatedAt }) { row in
                            Text(row.title).tag(row.id)
                        }
                    }
                }
                Section("任务") {
                    TextField("名称", text: $title)
                    TextField("投递内容", text: $prompt, axis: .vertical).lineLimit(3...8)
                }
                Section("时间") { ScheduleRuleFields(rule: $rule) }
            }
            .navigationTitle("新建定时任务").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { Task { await create() } }
                        .disabled(!model.canWrite || saving || session.isEmpty || cleanTitle.isEmpty ||
                                  cleanTitle.count > 120 || cleanPrompt.isEmpty || rule.selector == nil)
                }
            }
            .onAppear { if let id = model.selection, model.directory.visible.contains(where: { $0.id == id }) { session = id } }
        }
        .interactiveDismissDisabled(saving)
    }

    private func create() async {
        guard !saving, var fields = rule.selector else { return }
        saving = true; problem = nil
        defer { saving = false }
        fields["sessionId"] = .string(session)
        fields["title"] = .string(cleanTitle); fields["prompt"] = .string(cleanPrompt)
        do {
            let result = try await model.mutate("mobileSchedule/create", fields: fields)
            guard !result["id"].string.isEmpty else { throw LinkError.badResponse }
            await completed()
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}
