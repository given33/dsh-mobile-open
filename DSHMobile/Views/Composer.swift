import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import DSHCore

struct SessionComposer: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @State private var showModels = false
    @State private var showFiles = false
    @State private var showDictation = false
    @State private var photo: PhotosPickerItem?
    @State private var attachments: [Attachment] = []
    @State private var sending = false
    @State private var problem: String?
    @State private var receipt: (signature: [JSON], text: String, id: String)?
    @FocusState private var focused: Bool

    private struct Attachment: Identifiable {
        let id = UUID()
        let name: String
        let content: JSON
    }

    private var draft: Binding<String> {
        Binding(get: { model.drafts[sessionID, default: ""] }, set: { model.drafts[sessionID] = $0 })
    }
    private var canSend: Bool {
        model.canWrite && model.hasSnapshot && !sending &&
        (!draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }
    private var running: Bool { model.status(of: sessionID).isLive }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Hairline()
            if model.isOnline && !model.canWrite {
                Label("请在电脑的「手机连接」中开启「允许手机操作」。", systemImage: "lock")
                    .font(DSHFont.meta).foregroundStyle(Theme.meta)
                    .padding(.horizontal, 14).padding(.vertical, 9)
            } else if !model.isOnline {
                Label("连接恢复后即可继续操作", systemImage: "wifi.slash")
                    .font(DSHFont.meta).foregroundStyle(Theme.meta)
                    .padding(.horizontal, 14).padding(.vertical, 9)
            } else {
                controls
            }
        }
        .background(Theme.bgBase)
        .sheet(isPresented: $showModels) { ModelPickerSheet(sessionID: sessionID) }
        .sheet(isPresented: $showDictation) {
            DictationSheet { text in
                let previous = draft.wrappedValue
                draft.wrappedValue = previous.isEmpty ? text : previous + "\n" + text
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url): Task { await attachFile(url) }
            case .failure(let error): problem = error.localizedDescription
            }
        }
        .task(id: photo) {
            guard let photo else { return }
            await attachPhoto(photo)
            if !Task.isCancelled { self.photo = nil }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let problem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(DSHFont.meta).foregroundStyle(Theme.warnText)
                    .accessibilityIdentifier("composer-error")
            }
            if !attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(attachments) { item in
                            Button { attachments.removeAll { $0.id == item.id } } label: {
                                Label(item.name, systemImage: "xmark.circle")
                                    .font(DSHFont.meta)
                                    .lineLimit(1)
                                    .padding(.horizontal, 10).frame(minHeight: 44)
                                    .background(Theme.grouped, in: Capsule())
                            }
                            .accessibilityLabel("移除 \(item.name)")
                        }
                    }
                }
                .disabled(sending)
            }
            TextField("给 DSH 发送消息", text: draft, axis: .vertical)
                .focused($focused)
                .font(DSHFont.content).lineLimit(1...5)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.grouped, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("message-input")
                .disabled(sending)
            HStack(spacing: 6) {
                Menu {
                    PhotosPicker(selection: $photo, matching: .images) { Label("照片", systemImage: "photo") }
                    Button { showFiles = true } label: { Label("文件", systemImage: "doc") }
                    Button { focused = false; showDictation = true } label: { Label("语音输入", systemImage: "mic") }
                } label: {
                    Image(systemName: "plus.circle").font(.title3).frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("添加附件")
                .disabled(sending || !model.hasSnapshot)
                Button { focused = false; showModels = true } label: {
                    HStack(spacing: 4) {
                        Text(model.directory[sessionID]?.model.nonempty ?? "选择模型").lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                    }
                    .font(DSHFont.meta.weight(.medium))
                    .frame(minHeight: 44)
                }
                .accessibilityIdentifier("select-model")
                .disabled(sending)
                Spacer(minLength: 4)
                if running {
                    Button { Task { await stop() } } label: {
                        Image(systemName: "stop.circle").font(.title3).frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("停止当前任务").disabled(sending)
                    if canSend {
                        Menu {
                            Button("加入队列") { Task { await send() } }
                            Button("引导当前任务") { Task { await send(steer: true) } }
                        } label: { sendIcon }
                        .accessibilityLabel("发送选项")
                    }
                } else {
                    Button { Task { await send() } } label: { sendIcon }
                        .disabled(!canSend)
                        .accessibilityLabel("发送")
                        .accessibilityIdentifier("send-message")
                }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.top, 4)
        .frame(maxWidth: 720).frame(maxWidth: .infinity)
    }

    private var sendIcon: some View {
        Group {
            if sending { ProgressView() }
            else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 29)).foregroundStyle(canSend ? Theme.labelPrimary : Theme.mark) }
        }
        .frame(width: 44, height: 44)
    }

    private func send(steer: Bool = false) async {
        guard canSend else { return }
        sending = true; problem = nil
        defer { sending = false }
        let text = draft.wrappedValue
        let content = attachments.map(\.content)
        let signature = content + [.bool(steer)]
        let id = receipt?.text == text && receipt?.signature == signature ? receipt!.id : UUID().uuidString.lowercased()
        receipt = (signature, text, id)
        do {
            let result = try await model.action("session/prompt", args: ActionPayload.prompt(
                sessionID: sessionID, requestID: id, text: text, extraContent: content,
                steer: steer, timeZone: TimeZone.current.identifier))
            guard result["accepted"].bool else { throw LinkError.badResponse }
            draft.wrappedValue = ""; attachments = []; receipt = nil; focused = false
        } catch { problem = error.localizedDescription }
    }

    private func stop() async {
        guard !sending else { return }
        sending = true; problem = nil
        defer { sending = false }
        do { try await model.mutate("session/cancel", fields: ["sessionId": .string(sessionID)]) }
        catch { problem = error.localizedDescription }
    }

    private func attachPhoto(_ item: PhotosPickerItem) async {
        do {
            guard attachments.count < 4, let data = try await item.loadTransferable(type: Data.self),
                  data.count <= 16 * 1024 * 1024, let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.82), jpeg.count <= 2 * 1024 * 1024 else {
                throw ClientError.message("照片无法读取或过大。最多可添加四个附件，每张压缩后不超过 2 MB。")
            }
            guard !Task.isCancelled else { return }
            let name = "照片 \(attachments.count + 1).jpg"
            attachments.append(Attachment(name: name, content: .object([
                "type": .string("image"), "mediaType": .string("image/jpeg"),
                "data": .string(jpeg.base64EncodedString()), "name": .string(name),
            ])))
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }

    private func attachFile(_ url: URL) async {
        guard attachments.count < 4, !sending else { return }
        sending = true; problem = nil
        defer { sending = false }
        do {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let size = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard size.isRegularFile == true, let bytes = size.fileSize, bytes > 0, bytes <= 20 * 1024 * 1024 else {
                throw ClientError.message("请选择 20 MB 以内的非空文件。")
            }
            let id = try await model.uploadFile(url, sessionID: sessionID)
            attachments.append(Attachment(name: url.lastPathComponent, content: .object([
                "type": .string("file"), "receiptId": .string(id),
            ])))
        } catch { problem = error.localizedDescription }
    }
}

struct ModelPickerSheet: View {
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var options: [ModelOption] = []
    @State private var problem: String?
    @State private var loading = true
    @State private var busy = false
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    ProgressView("正在读取电脑上的模型")
                } else if let problem, options.isEmpty {
                    Text(problem).foregroundStyle(Theme.warnText)
                    Button("重试") { Task { await load() } }
                } else if options.isEmpty {
                    Text("电脑上没有可用模型。请检查 Harness 的模型配置。")
                } else {
                    if let problem { Text(problem).foregroundStyle(Theme.warnText) }
                    ForEach(providers, id: \.self) { provider in
                        Section {
                            ForEach(filtered.filter { $0.provider == provider }) { option in
                                if option.efforts.isEmpty {
                                    Button { Task { await choose(option) } } label: { modelLabel(option) }
                                } else {
                                    Menu {
                                        Button("使用默认推理强度") { Task { await choose(option) } }
                                        ForEach(option.efforts) { effort in
                                            Button(effort.name) { Task { await choose(option, effort: effort.id) } }
                                        }
                                    } label: { modelLabel(option) }
                                }
                            }
                        } header: { Text(filtered.first { $0.provider == provider }?.providerName ?? provider) }
                    }
                }
            }
            .searchable(text: $query, prompt: "搜索模型")
            .navigationTitle("选择模型").navigationBarTitleDisplayMode(.inline)
            .disabled(busy)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .task { await load() }
    }

    private var filtered: [ModelOption] {
        query.isEmpty ? options : options.filter {
            [$0.name, $0.model, $0.providerName].contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }
    private var providers: [String] {
        var seen = Set<String>()
        return filtered.map(\.provider).filter { seen.insert($0).inserted }
    }

    private func modelLabel(_ option: ModelOption) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(option.name).foregroundStyle(Theme.labelPrimary)
                if option.name != option.model { Text(option.model).font(DSHFont.meta).foregroundStyle(Theme.meta) }
            }
            Spacer()
            if model.directory[sessionID]?.model == option.model {
                Image(systemName: "checkmark").accessibilityLabel("当前模型")
            } else if !option.efforts.isEmpty {
                Image(systemName: "chevron.down").font(.caption).foregroundStyle(Theme.meta)
            }
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        loading = true; problem = nil
        defer { loading = false }
        do { options = try await model.modelCatalog() }
        catch { problem = error.localizedDescription }
    }

    private func choose(_ option: ModelOption, effort: String? = nil) async {
        guard !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        do {
            try await model.mutate("session/selectModel", fields: option.selection(sessionID: sessionID, effort: effort))
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

private extension String {
    var nonempty: String? { isEmpty ? nil : self }
}
