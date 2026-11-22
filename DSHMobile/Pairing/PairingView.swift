import SwiftUI
import UIKit
import DSHCore

struct PairingView: View {
    var initialLink: String?
    var onDone: () -> Void

    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var camera = QRCapture()
    @State private var availability: QRCapture.Availability = .unknown
    @State private var offer: PairingOffer?
    @State private var pendingLink = ""
    @State private var pasted = ""
    @State private var showingPaste = false
    @State private var problem: String?
    @State private var pairing = false
    @State private var torch = false

    var body: some View {
        Group {
            if let offer { confirmation(offer) }
            else { scanner }
        }
        .background(Theme.bgBase)
        .interactiveDismissDisabled(pairing)
        .onChange(of: initialLink, initial: true) { _, link in
            if let link { read(link) }
        }
        .sheet(isPresented: $showingPaste) { pasteSheet }
    }

    private var scanner: some View {
        ZStack {
            if availability == .ready { QRPreview(capture: camera).ignoresSafeArea() }
            else { Color(white: 0.13).ignoresSafeArea() }
            ScrollView {
                VStack(spacing: 20) {
                    if model.desktop != nil {
                        Button("关闭", action: onDone)
                            .frame(minHeight: 44)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    Text("扫描电脑上的二维码").font(.title2.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text("在电脑上的 DSH 里点左下角「手机连接」，打开「允许手机连接」后会出现二维码。")
                        .font(.callout)
                        .multilineTextAlignment(.center)
                    cameraTarget
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(DSHFont.secondary)
                            .padding(12)
                            .background(Color.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("pairing-error")
                    }
                    Button {
                        pasted = ""
                        showingPaste = true
                    } label: {
                        Label("粘贴配对链接", systemImage: "link")
                            .font(.headline)
                            .padding(.horizontal, 20)
                            .frame(minHeight: 48)
                            .background(.white.opacity(0.18), in: Capsule())
                    }
                    .accessibilityIdentifier("paste-pairing-link")
                }
                .frame(maxWidth: 440)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(Color.black.opacity(0.24).ignoresSafeArea())
            .foregroundStyle(.white)
            .tint(.white)
        }
        .task(id: CameraState(phase: scenePhase, showingPaste: showingPaste)) {
            guard scenePhase == .active, !showingPaste else { stopCamera(); return }
            let state = await QRCapture.requestAvailability()
            guard !Task.isCancelled else { return }
            availability = state
            guard state == .ready else { return }
            camera.onCode = { value in
                guard !showingPaste else { return }
                read(value)
            }
            camera.start()
        }
        .onDisappear { stopCamera() }
    }

    @ViewBuilder private var cameraTarget: some View {
        switch availability {
        case .ready:
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(.white.opacity(0.9), lineWidth: 2)
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: 240)
                .accessibilityHidden(true)
            if QRCapture.hasTorch {
                Button {
                    torch.toggle()
                    camera.setTorch(torch)
                } label: {
                    Label(torch ? "关闭手电筒" : "打开手电筒", systemImage: torch ? "flashlight.on.fill" : "flashlight.off.fill")
                        .frame(minHeight: 44)
                }
            }
        case .denied:
            Text("相机权限已关闭。可在 iOS 设置中允许访问相机，或直接粘贴配对链接。")
                .font(.callout)
                .multilineTextAlignment(.center)
            Button("打开 iOS 设置") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .frame(minHeight: 44)
        case .noCamera:
            Label("此设备没有可用的相机，请粘贴配对链接。", systemImage: "qrcode.viewfinder")
                .font(.callout)
        case .unknown:
            ProgressView().tint(.white)
        }
    }

    private func confirmation(_ offer: PairingOffer) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                DSHIcon("followsystem-outline", size: 32)
                    .frame(width: 68, height: 68)
                    .background(Theme.grouped, in: RoundedRectangle(cornerRadius: 18))
                Text("连接这台电脑？").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Text(offer.desktopName).font(.headline).foregroundStyle(Theme.meta)
                VStack(spacing: 8) {
                    Text("安全码").font(DSHFont.meta)
                    Text(offer.safetyCode).font(.system(.title3, design: .monospaced).weight(.semibold))
                        .textSelection(.enabled)
                        .accessibilityIdentifier("pairing-safety-code")
                    Text("核对电脑「手机连接」里的安全码，一致再连接。")
                        .font(DSHFont.secondary).foregroundStyle(Theme.meta)
                }
                .multilineTextAlignment(.center)
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Theme.grouped, in: RoundedRectangle(cornerRadius: 14))
                ForEach(offer.orderedEndpoints, id: \.self) { endpoint in
                    LabeledContent(endpoint.kind == .other ? "公网地址" : endpoint.kind.label) {
                        Text(endpoint.authority).font(DSHFont.code).textSelection(.enabled)
                    }
                    .font(DSHFont.secondary)
                }
                if let problem {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .font(DSHFont.secondary).foregroundStyle(Theme.warnText)
                        .accessibilityIdentifier("pairing-error")
                }
                Button {
                    Task { await connect() }
                } label: {
                    if pairing { ProgressView().tint(Theme.primaryForeground).accessibilityLabel("正在连接") }
                    else { Text("连接") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("confirm-pairing")
                Button("取消") { self.offer = nil; pendingLink = ""; problem = nil }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .disabled(pairing)
            .padding(24)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(Theme.labelPrimary)
    }

    private var pasteSheet: some View {
        NavigationStack {
            Form {
                Section("从电脑的「手机连接」复制链接") {
                    TextField("dshmobile://pair…", text: $pasted, axis: .vertical)
                        .lineLimit(3...5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("pairing-link-input")
                    PasteButton(payloadType: String.self) { items in
                        if let first = items.first { pasted = first }
                    }
                }
            }
            .navigationTitle("粘贴配对链接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { showingPaste = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("继续") { showingPaste = false; read(pasted); pasted = "" }
                        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private struct CameraState: Equatable { let phase: ScenePhase; let showingPaste: Bool }

    private func stopCamera() {
        camera.onCode = nil
        if torch { camera.setTorch(false); torch = false }
        camera.stop()
    }

    private func read(_ link: String) {
        guard !pairing else { return }
        do {
            let parsed = try PairingOffer(link: link)
            guard !parsed.isExpired() else { throw PairingError.expired }
            pendingLink = link; problem = nil; offer = parsed
        } catch { problem = error.localizedDescription }
    }

    private func connect() async {
        guard !pairing, !pendingLink.isEmpty else { return }
        pairing = true; problem = nil
        defer { pairing = false }
        do { try await model.pair(link: pendingLink); pendingLink = ""; onDone() }
        catch {
            problem = error.localizedDescription
            if (error as? LinkError) == .codeRejected("code-expired") || (error as? PairingError) == .expired {
                offer = nil; pendingLink = ""
            }
        }
    }
}
