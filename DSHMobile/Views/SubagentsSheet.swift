import SwiftUI
import PhotosUI
import DSHCore

private struct ChildTask: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["label"].string.isEmpty ? id : raw["label"].string }
    var mode: String { raw["mode"].string }
    var continuable: Bool { mode == "continuable" }
    var external: Bool { mode == "external" }
}

struct SubagentsSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                SubagentRows(parent: sessionID, catalog: model.directory[sessionID]?.projection["subagentCatalog"].array ?? [])
            }
            .navigationTitle("子任务").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        }
    }
}

private struct SubagentRows: View {
    let parent: String
    let catalog: [JSON]
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if catalog.isEmpty { ContentUnavailableView("暂无子任务", systemImage: "point.3.connected.trianglepath.dotted") }
        ForEach(catalog.map(ChildTask.init).filter { !$0.id.isEmpty }) { child in
            if child.external {
                Label("\(child.name) · 外部任务", systemImage: "arrow.up.forward.app")
            } else {
                NavigationLink {
                    ChildConversation(parent: parent, child: child)
                } label: {
                    LabeledContent(child.name, value: label(child))
                }
            }
        }
    }

    private func label(_ child: ChildTask) -> String {
        if model.status(of: child.id).needsAttention { return model.status(of: child.id).label }
        if model.directory[child.id]?.running == true || child.raw["activity"].string == "running" { return "进行中" }
        return child.continuable ? "可继续" : "单次"
    }
}

private struct ChildConversation: View {
    let parent: String
    let child: ChildTask
    @EnvironmentObject private var model: AppModel
    @State private var transcript = Transcript()
    @State private var turns: [Turn] = []
    @State private var catalog: [JSON] = []
    @State private var cwd = ""
    @State private var loaded = false
    @State private var draft = ""
    @State private var busy = false
    @State private var loadingHistory = false
    @State private var problem: String?
    @State private var retry = 0
    @State private var showChildren = false
    @State private var stopConfirm = false
    @State private var groupOpen: [String: Bool] = [:]
    @State private var fold: [Int: Bool] = [:]
    @State private var tool: ToolRow?
    @State private var selectedInteraction: PendingInteraction?
    @State private var photo: PhotosPickerItem?
    @State private var image: Data?
    @State private var loadingPhoto = false

    private var address: JSON {
        .object(["kind": .string("subagent"), "parentSessionId": .string(parent),
                 "childSessionId": .string(child.id), "mode": .string(["continuable", "one-shot"].contains(child.mode) ? child.mode : "unknown")])
    }

    private var promptFields: [String: JSON] {
        ["parentSessionId": .string(parent), "childSessionId": .string(child.id), "mode": .string("continuable")]
    }

    private var pending: [PendingInteraction] { model.pending(for: child.id) }
    private var nested: [JSON] { model.directory[child.id]?.projection["subagentCatalog"].array ?? catalog }
    private var clean: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { model.canWrite && loaded && !busy && !loadingPhoto && (!clean.isEmpty || image != nil) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                if !model.isOnline { Label("连接恢复后自动同步", systemImage: "wifi.slash") }
                if !loaded && problem == nil { ProgressView("正在读取子任务") }
                if transcript.hasMore {
                    Button("加载更早") { Task { await earlier() } }.disabled(loadingHistory)
                }
                ForEach(turns) { turn in
                    TurnView(turn: turn, mode: model.displayMode, cwd: cwd, attachmentSessionID: child.id, open: Binding(
                        get: { fold[turn.id] ?? !turn.foldable },
                        set: { fold[turn.id] = $0 }), groupOpen: $groupOpen) { tool = $0 }
                }
                if loaded && turns.isEmpty { ContentUnavailableView("暂无消息", systemImage: "bubble.left") }
            }
            .padding(14).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .navigationTitle(child.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if !nested.isEmpty { Button { showChildren = true } label: { Label("子任务", systemImage: "point.3.connected.trianglepath.dotted") } }
                if child.continuable && model.canWrite {
                    Button { stopConfirm = true } label: { Label("停止子任务", systemImage: "stop.circle") }.disabled(busy)
                }
                if problem != nil { Button { retry += 1 } label: { Label("重新连接", systemImage: "arrow.clockwise") } }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .sheet(item: $tool) { ToolDetailSheet(tool: $0, cwd: cwd) }
        .sheet(item: $selectedInteraction) { InteractionSheet(interaction: $0) }
        .sheet(isPresented: $showChildren) {
            NavigationStack { List { SubagentRows(parent: child.id, catalog: nested) }.navigationTitle("子任务") }
        }
        .confirmationDialog("停止这个子任务？", isPresented: $stopConfirm, titleVisibility: .visible) {
            Button("停止", role: .destructive) { Task { await stop() } }
            Button("取消", role: .cancel) {}
        }
        .task(id: "\(model.isOnline)-\(retry)") { if model.isOnline { await follow() } }
        .task(id: photo) { await importPhoto() }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(pending) { request in
                Button { selectedInteraction = request } label: { PendingCard(interaction: request, compact: true) }.buttonStyle(.plain)
            }
            if child.continuable {
                if image != nil {
                    Button { image = nil; photo = nil } label: { Label("移除所选图片", systemImage: "xmark.circle") }
                }
                HStack(alignment: .bottom) {
                    PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo").accessibilityLabel("选择图片") }
                        .disabled(!model.canWrite || busy)
                    TextField("给子任务发消息", text: $draft, axis: .vertical).lineLimit(1...5)
                    Menu {
                        Button("发送") { Task { await send(steer: false) } }
                        Button("引导当前任务") { Task { await send(steer: true) } }
                    } label: { Image(systemName: "arrow.up.circle.fill").font(.title2).accessibilityLabel("发送给子任务") }
                        .disabled(!canSend)
                }.padding(8)
            }
        }
        .padding(.horizontal, 12)
        .background(.regularMaterial)
    }

    private func follow() async {
        problem = nil
        let args = ActionPayload.request(["address": address, "assistantStream": .bool(true), "maxMessages": .number(100)])
        do {
            for try await frame in model.observe("session/follow", args: args) {
                if Task.isCancelled { return }
                transcript.receive(frame)
                if let fault = transcript.fault { problem = fault; return }
                if frame["type"].string == "snapshot" {
                    loaded = true; cwd = frame["header"]["cwd"].string
                    catalog = frame["projections"]["values"]["subagentCatalog"].array
                }
                turns = ConversationBuilder.build(transcript)
            }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func earlier() async {
        guard !loadingHistory, transcript.hasMore else { return }
        loadingHistory = true; defer { loadingHistory = false }
        do {
            let page = try await model.read("session/page", args: ActionPayload.request([
                "address": address, "throughSeq": .number(Double(transcript.cursor)),
                "beforeSeq": .number(Double(transcript.events.first?.id ?? transcript.cursor)), "maxMessages": .number(100)
            ]))
            transcript.merge(page["records"].array)
            transcript.hasMore = page["hasMore"].bool
            turns = ConversationBuilder.build(transcript)
        } catch { problem = error.localizedDescription }
    }

    private func importPhoto() async {
        guard let photo else { return }
        loadingPhoto = true; defer { loadingPhoto = false }
        do {
            guard let data = try await photo.loadTransferable(type: Data.self),
                  let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.78), jpeg.count < 5 * 1024 * 1024 else {
                throw ClientError.message("无法读取图片，或图片超过 5 MiB。")
            }
            if !Task.isCancelled { image = jpeg }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func send(steer: Bool) async {
        guard canSend else { return }
        busy = true; problem = nil; defer { busy = false }
        var fields = promptFields
        var parts: [JSON] = clean.isEmpty ? [] : [.object(["type": .string("text"), "text": .string(clean)])]
        if let image { parts.append(.object(["type": .string("image"), "mediaType": .string("image/jpeg"), "data": .string(image.base64EncodedString())])) }
        fields["content"] = .array(parts); fields["requestId"] = .string(UUID().uuidString.lowercased())
        fields["delivery"] = .string(steer ? "steer" : "queue"); fields["clientTimeZone"] = .string(TimeZone.current.identifier)
        do {
            let receipt = try await model.mutate("subagents/prompt", fields: fields)
            guard !receipt["messageId"].string.isEmpty else { throw LinkError.badResponse }
            draft = ""; image = nil; photo = nil
        } catch { problem = error.localizedDescription }
    }

    private func stop() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do { try await model.action("subagents/interruptByParent", args: .object(promptFields)) }
        catch { problem = error.localizedDescription }
    }
}
