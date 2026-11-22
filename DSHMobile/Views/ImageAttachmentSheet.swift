import SwiftUI
import UIKit
import DSHCore

struct ImageAttachmentSheet: View {
    let reference: JSON
    let sessionID: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().scaledToFit().containerRelativeFrame(.horizontal)
                    }
                } else if let problem {
                    ContentUnavailableView {
                        Label("图片无法打开", systemImage: "photo.badge.exclamationmark")
                    } description: { Text(problem) } actions: { Button("重试") { Task { await load() } } }
                } else {
                    ProgressView("正在读取图片")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgBase)
            .navigationTitle(reference["name"].string.isEmpty ? "图片附件" : reference["name"].string)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async {
        problem = nil
        do {
            let result = try await model.read("session/attachment", args: ActionPayload.request([
                "sessionId": .string(sessionID), "attachment": reference,
            ]))
            guard let bytes = Data(base64Encoded: result["data"].string), let decoded = UIImage(data: bytes) else {
                throw LinkError.badResponse
            }
            image = decoded
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
