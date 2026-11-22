import SwiftUI
import DSHCore

private struct BackgroundJob: Identifiable, Equatable {
    let raw: JSON
    var id: String { raw["id"].string }
    var title: String { raw["label"].string.isEmpty ? id : raw["label"].string }
    var owner: String { raw["owner"].string }
    var status: String { raw["status"].string }
    var statusLabel: String {
        switch status {
        case "running": "进行中"
        case "stopping": "正在停止"
        case "completed": "已完成"
        case "killed": "已停止"
        case "failed": "失败"
        default: status
        }
    }
    var detail: String {
        raw["progress"].string.isEmpty ? raw["detail"].string : raw["progress"].string
    }
}

struct BackgroundJobsSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var jobs: [BackgroundJob] = []
    @State private var loaded = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if !model.isOnline {
                    Label("连接恢复后将重新同步", systemImage: "wifi.slash")
                } else if let problem {
                    Text(problem).foregroundStyle(Theme.warnText)
                } else if !loaded {
                    ProgressView("正在读取后台任务")
                } else if jobs.isEmpty {
                    ContentUnavailableView("暂无后台任务", systemImage: "list.bullet.rectangle")
                }
                ForEach(jobs) { job in
                    NavigationLink {
                        JobOutputView(job: job, sessionID: sessionID)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(job.title).font(.headline)
                            Text(job.detail.isEmpty ? job.statusLabel : "\(job.statusLabel) · \(job.detail)")
                                .font(DSHFont.meta).foregroundStyle(Theme.meta)
                        }
                    }
                }
            }
            .navigationTitle("后台任务").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task(id: model.isOnline) { await observe() }
        }
    }

    private func observe() async {
        guard model.isOnline else { return }
        problem = nil
        do {
            let frames = model.observe("job/list", args: ActionPayload.request(["sessionId": .string(sessionID)]))
            for try await frame in frames where frame["type"].string == "rows" {
                jobs = frame["jobs"].array.map { BackgroundJob(raw: $0) }.filter { !$0.id.isEmpty }
                loaded = true
            }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct JobOutputView: View {
    let job: BackgroundJob
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @State private var current: BackgroundJob?
    @State private var output = ""
    @State private var next: Int?
    @State private var problem: String?
    @State private var confirmation = false
    @State private var stopping = false

    private var row: BackgroundJob { current ?? job }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label(row.statusLabel, systemImage: "circle")
                if !row.detail.isEmpty { Text(row.detail).foregroundStyle(Theme.meta) }
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if output.isEmpty {
                    Text("暂无输出").foregroundStyle(Theme.meta)
                } else {
                    Text(output).font(DSHFont.code).textSelection(.enabled)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.codeBlock, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(row.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if row.status == "running", model.canWrite {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("停止", role: .destructive) { confirmation = true }.disabled(stopping)
                }
            }
        }
        .confirmationDialog("停止这个后台任务？", isPresented: $confirmation, titleVisibility: .visible) {
            Button("停止", role: .destructive) { Task { await stop() } }
            Button("取消", role: .cancel) {}
        }
        .task(id: model.isOnline) { await follow() }
    }

    private func follow() async {
        guard model.isOnline else { return }
        problem = nil
        var request: [String: JSON] = ["jobId": .string(job.id)]
        if !job.owner.isEmpty { request["sessionId"] = .string(job.owner) }
        if let next { request["from"] = .number(Double(next)) }
        do {
            for try await frame in model.observe("job/follow", args: ActionPayload.request(request)) {
                switch frame["type"].string {
                case "opened", "status":
                    current = BackgroundJob(raw: frame["job"])
                case "output":
                    if frame["lossy"].bool { output += "\n[更早的输出已被电脑清理]\n" }
                    for chunk in frame["chunks"].array {
                        output += chunk["text"].string
                    }
                    if output.count > 180_000 { output = String(output.suffix(150_000)) }
                    next = frame["next"].int
                default: break
                }
            }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func stop() async {
        guard !stopping else { return }
        stopping = true
        defer { stopping = false }
        do {
            try await model.mutate("job/kill", fields: ["sessionId": .string(sessionID), "jobId": .string(job.id)])
        } catch { problem = error.localizedDescription }
    }
}
