import SwiftUI
import DSHCore

@main
struct DSHMobileApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Theme.labelPrimary)
                .preferredColorScheme(resolvedColorScheme)
        }
        .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
    }

    private var resolvedColorScheme: ColorScheme? {
        switch ProcessInfo.processInfo.environment["DSH_APPEARANCE"] {
        case "dark": return .dark
        case "light": return .light
        default: break
        }
        if let dark = model.pageTheme.dark {
            return dark ? .dark : .light
        }
        return nil
    }
}

private struct DeviceButtonBounds: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showForget = false
    @State private var showConnectionInfo = false
    @State private var showDictation = false
    private var surfaceBackground: Color {
        model.pageTheme.backgroundColor ?? Theme.bgBase
    }

    private var showSnapshotCover: Bool {
        model.needsLaunchSelection && model.resumeFrame != nil && !model.revoked
    }

    var body: some View {
        Group {
            if model.desktop == nil {
                PairingView(initialLink: model.incomingLink) { model.closePairing() }
            } else {
                VStack(spacing: 0) {
                    connectionBar
                        .zIndex(1)
                    ZStack {
                        if let session = model.browser {
                            OfficialWebView(
                                session: session,
                                reloadID: model.reloadID,
                                launchRoute: model.launchRoute,
                                command: model.pendingCommand,
                                backgroundColor: model.pageTheme.backgroundUIColor,
                                onRestoring: model.restoringDocument,
                                onLoaded: model.pageLoaded,
                                onError: model.pageFailed,
                                onAuthExpired: model.pageAuthExpired,
                                onProcessTerminated: model.pageProcessTerminated,
                                onBridgeMessage: { message in
                                    guard model.desktop?.id == session.desktopID else { return }
                                    model.handleBridgeMessage(message)
                                },
                                onFrame: model.captureFrame
                            )
                            .id(session.desktopID)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .clipped()
                            .ignoresSafeArea(.all, edges: .bottom)
                        } else if !showSnapshotCover {
                            connectionState
                        } else {
                            surfaceBackground
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .ignoresSafeArea(.all, edges: .bottom)
                        }

                        if let image = model.resumeFrame, !model.revoked {
                            GeometryReader { proxy in
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                                    .background(surfaceBackground)
                                    .clipped()
                                    .accessibilityHidden(true)
                            }
                            .ignoresSafeArea(.all, edges: .bottom)
                            .overlay(alignment: .bottom) {
                                if showSnapshotCover && !model.documentRecoveryNeeded && model.problem != nil && model.recoveryFailures >= 2 {
                                    snapshotReconnectBanner
                                        .transition(.move(edge: .bottom).combined(with: .opacity))
                                }
                            }
                            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86), value: showSnapshotCover)
                            .opacity(showSnapshotCover ? 1 : 0)
                            .allowsHitTesting(showSnapshotCover)
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if model.documentRecoveryNeeded && model.browser != nil && !model.revoked {
                            documentRecoveryBanner
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                    .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86), value: model.documentRecoveryNeeded)
                    .ignoresSafeArea(.all, edges: .bottom)
                }
                .background(surfaceBackground.ignoresSafeArea())
                .ignoresSafeArea(.all, edges: .bottom)
            }
        }
        .overlay(alignment: .top) {
            if let notice = model.failoverNotice {
                Button(action: model.dismissFailoverNotice) {
                    HStack(spacing: 7) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text(notice).font(.footnote.weight(.medium))
                        Image(systemName: "xmark").font(.caption2)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.regularMaterial, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(notice))
                .accessibilityHint("轻点关闭提示")
                .accessibilityIdentifier("failover-notice")
                .padding(.top, 48)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.failoverNotice)
        .overlayPreferenceValue(DeviceButtonBounds.self) { anchor in
            ZStack(alignment: .topLeading) {
                if model.showDeviceMenu, let anchor {
                    GeometryReader { proxy in
                        let trigger = proxy[anchor]
                        let paired = model.localHost != nil && model.cloudHost != nil
                        let width = max(0, min(paired ? max(280, trigger.width) : trigger.width, proxy.size.width - 16))
                        let left = max(8, min(trigger.minX, proxy.size.width - width - 8))
                        let top = trigger.maxY + 6
                        ZStack(alignment: .topLeading) {
                            Color.black.opacity(0.08).contentShape(Rectangle()).ignoresSafeArea()
                                .onTapGesture { dismissDeviceMenu() }
                                .accessibilityHidden(true)
                                .transition(.opacity)
                            ViewThatFits(in: .vertical) {
                                deviceOptions
                                ScrollView { deviceOptions }
                            }
                            .frame(width: width)
                            .background(Theme.sheet, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.borderL2, lineWidth: 0.5) }
                            .shadow(color: .black.opacity(0.14), radius: 14, y: 6)
                            .shadow(color: .black.opacity(0.05), radius: 3, y: 1)
                            .frame(maxHeight: max(0, proxy.size.height - top - 8), alignment: .top)
                            .offset(x: left, y: top)
                            .accessibilityAction(.escape) { dismissDeviceMenu() }
                            .transition(
                                .asymmetric(
                                    insertion: .scale(scale: 0.92, anchor: .topLeading).combined(with: .opacity),
                                    removal: .scale(scale: 0.95, anchor: .topLeading).combined(with: .opacity)
                                )
                            )
                        }
                    }
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.84), value: model.showDeviceMenu)
        }
        .overlay {
            ZStack {
                if model.offerCloud {
                    Color.black.opacity(0.36).ignoresSafeArea()
                        .transition(.opacity)
                    VStack(alignment: .leading, spacing: 14) {
                        Text("电脑暂时连不上").font(.headline)
                        Text("继续重连，或打开云端工作区。不会重新执行电脑上的指令。")
                            .font(.subheadline).foregroundStyle(Theme.labelSecondary)
                        Button("切换到云端") {
                            if let cloud = model.cloudHost {
                                withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.84)) {
                                    model.setDeviceMenu(true)
                                }
                                model.chooseDevice(cloud)
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        Button("继续重连") { model.dismissCloudOffer() }.buttonStyle(SecondaryButtonStyle())
                    }.padding(20).frame(maxWidth: 340).background(Theme.sheet, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .padding(.horizontal, 16).accessibilityAddTraits(.isModal)
                        .transition(.scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86), value: model.offerCloud)
        }
        .onOpenURL { url in
            guard url.scheme?.lowercased() == "dshmobile" else { return }
            if url.host?.lowercased() == "task" { model.openTaskURL(url) }
            else if url.host?.lowercased() == "pair" { model.presentPairing(url.absoluteString) }
        }
        .sheet(isPresented: Binding(get: { model.desktop != nil && model.showPairing },
                                    set: { if !$0 { model.closePairing() } })) {
            PairingView(initialLink: model.incomingLink) { model.closePairing() }
                .environmentObject(model)
        }
        .sheet(isPresented: $showConnectionInfo) {
            ConnectionDetailSheet()
                .environmentObject(model)
        }
        .sheet(isPresented: $showDictation) {
            VoiceDictationSheet { text in
                model.insertDraft(text)
            }
        }
        .confirmationDialog("忘记这台电脑？", isPresented: $showForget, titleVisibility: .visible) {
            Button("忘记这台电脑", role: .destructive) { model.removeCurrent() }
        } message: { Text("之后需要用电脑「手机连接」里的新二维码重新配对。") }
    }

    private func dismissDeviceMenu() {
        withAnimation(reduceMotion ? nil : .spring(response: 0.24, dampingFraction: 0.88)) {
            model.setDeviceMenu(false)
        }
    }

    private var extraDesktops: [PairedDesktop] {
        let familyIDs = Set([model.localHost?.id, model.cloudHost?.id].compactMap { $0 })
        return model.savedDesktops.filter { !familyIDs.contains($0.id) }
    }

    private func deviceDisplayName(for host: PairedDesktop) -> String {
        if let cloud = model.cloudHost, cloud.id == host.id { return cloud.name }
        return model.savedDesktops.first { $0.id == host.id }?.name ?? host.name
    }

    private var currentDeviceName: String {
        guard let host = model.selectedDevice ?? model.desktop else { return "DSH" }
        return deviceDisplayName(for: host)
    }

    private func resolvedDeviceStatus(for host: PairedDesktop) -> DeviceProbeStatus {
        if let probed = model.deviceStatuses[host.id] {
            return probed
        }
        if model.desktop?.id == host.id {
            if model.switchTargetID == host.id || model.connecting || model.reconnecting || model.wsHealth == .connecting {
                return .connecting
            }
            if !model.linkInterrupted && model.browser != nil && model.wsHealth == .connected {
                let route = model.browser?.endpoint.kind.label ?? host.preferred?.kind.label
                return .online(route: route, latencyMs: model.lastLatencyMs)
            }
            return .offline(nil)
        }
        if model.switchTargetID == host.id {
            return .connecting
        }
        if let preferred = host.preferred {
            return .online(route: preferred.kind.label, latencyMs: nil)
        }
        return .checking
    }

    private func deviceStatusColor(for status: DeviceProbeStatus) -> Color {
        switch status {
        case .online: return Theme.success
        case .checking, .connecting: return Theme.warn
        case .offline: return Theme.error
        }
    }

    private func deviceStatusLabel(for status: DeviceProbeStatus, isCloud: Bool) -> String {
        switch status {
        case .online(let route, let latencyMs):
            var parts = ["在线"]
            if let route, !route.isEmpty { parts.append(route) }
            if let latencyMs { parts.append("\(latencyMs) ms") }
            return parts.joined(separator: " · ")
        case .connecting:
            return "正在连接…"
        case .checking:
            return "正在检测状态…"
        case .offline(let reason):
            if let reason, !reason.isEmpty { return reason }
            return isCloud ? "云端暂不可达" : "当前离线"
        }
    }

    private func deviceRowView(for host: PairedDesktop, isCloud: Bool, selected: Bool, action: @escaping () -> Void) -> some View {
        let status = resolvedDeviceStatus(for: host)
        let dotColor = deviceStatusColor(for: status)
        let isSwitching = model.switchTargetID == host.id
        return Button(action: action) {
            HStack(spacing: 5) {
                Circle().fill(dotColor).frame(width: 7, height: 7).fixedSize()
                VStack(alignment: .leading, spacing: 2) {
                    Text(deviceDisplayName(for: host))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.labelPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    HStack(spacing: 4) {
                        Text(isCloud ? "云端" : "本机")
                            .foregroundStyle(isCloud ? Theme.business : Theme.meta)
                            .fixedSize()
                        Text(deviceStatusLabel(for: status, isCloud: isCloud))
                            .foregroundStyle(status.isHealthy ? Theme.meta : dotColor)
                            .lineLimit(1)
                    }
                    .font(.caption2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if isSwitching {
                    ProgressView().controlSize(.mini).fixedSize()
                } else if selected {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.business)
                        .fixedSize()
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? Theme.hover.opacity(0.65) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .disabled(model.switchingDevice)
        .buttonStyle(.plain)
    }

    private var deviceOptions: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach([model.localHost, model.cloudHost].compactMap { $0 }) { host in
                let isCloud = host.id == model.cloudHost?.id
                let selected = host.id == model.selectedDevice?.id
                deviceRowView(for: host, isCloud: isCloud, selected: selected) {
                    model.chooseDevice(host)
                }
                .accessibilityIdentifier(isCloud ? "choose-cloud-device" : "choose-local-device")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            if model.localHost != nil && model.cloudHost != nil {
                Divider()
                Toggle(isOn: Binding(get: { model.autoFailoverEnabled }, set: { model.setAutoFailoverEnabled($0) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("断线无感自动接力").font(.subheadline.weight(.medium))
                        Text("当前设备离线时自动切到另一端继续").font(.caption).foregroundStyle(Theme.meta)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .accessibilityIdentifier("auto-failover-toggle")
            }
            if let issue = model.deviceIssue {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.warnText)
                    Text(issue)
                        .font(.footnote)
                        .foregroundStyle(Theme.warnText)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warnTertiary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.top, 2)
            }
            if !extraDesktops.isEmpty {
                Divider().padding(.vertical, 2)
                Text("其他已配对设备")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.meta)
                    .padding(.horizontal, 10)
                    .padding(.top, 2)
                ForEach(extraDesktops) { other in
                    deviceRowView(for: other, isCloud: false, selected: false) {
                        dismissDeviceMenu()
                        model.use(other)
                    }
                }
            }
        }
        .padding(2)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var statusColor: Color {
        if model.connecting || model.reconnecting || model.wsHealth == .connecting { return Theme.warn }
        if model.browser != nil && model.wsHealth == .connected { return Theme.success }
        return Theme.error
    }

    private var connectionBar: some View {
        HStack(spacing: 6) {
            if model.browser != nil {
                Button { model.toggleSidebar() } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(model.drawerOpen ? Theme.business : Theme.labelPrimary)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .fixedSize()
                .layoutPriority(2)
                .accessibilityLabel("切换会话侧边栏")
                .accessibilityIdentifier("toggle-sidebar")
                .accessibilityValue(model.drawerOpen ? "展开" : "收起")
            }

            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.84)) {
                    model.toggleDeviceMenu()
                }
            } label: {
                HStack(spacing: 5) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 7, height: 7)
                        .fixedSize()
                        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: statusColor)
                    Text(currentDeviceName)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.labelPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(-1)
                    if let route = (model.selectedDevice?.id == model.desktop?.id ? model.browser?.endpoint : model.selectedDevice?.preferred)?.kind.label {
                        Text(route)
                            .font(.caption2)
                            .foregroundStyle(Theme.meta)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.hover, in: Capsule())
                            .lineLimit(1)
                            .fixedSize()
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.meta)
                        .rotationEffect(.degrees(model.showDeviceMenu ? 180 : 0))
                        .animation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.82), value: model.showDeviceMenu)
                        .accessibilityHidden(true)
                    if model.browser != nil && !model.actionsEnabled {
                        Text("只读")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(Theme.warnText)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.warnTertiary, in: Capsule())
                            .lineLimit(1)
                            .fixedSize()
                            .accessibilityIdentifier("readonly-badge")
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(model.showDeviceMenu ? Theme.active : Theme.hover.opacity(0.65), in: Capsule())
                .contentShape(Rectangle())
                .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.showDeviceMenu)
            }
            .buttonStyle(.plain)
            .frame(minWidth: 0, minHeight: 36, alignment: .leading)
            .accessibilityIdentifier("connection-status-pill")
            .accessibilityValue(model.fixtureObservation ?? syncAccessibilityStatus)
            .accessibilityHint("展开或收起设备列表")
            .anchorPreference(key: DeviceButtonBounds.self, value: .bounds) { $0 }

            if model.pendingApprovalsCount > 0 {
                Button { model.openHub("tasks") } label: {
                    Text("待确认 \(model.pendingApprovalsCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.warnText)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.warnTertiary, in: Capsule())
                        .lineLimit(1)
                        .fixedSize()
                }
                .buttonStyle(.plain)
                .transition(.scale(scale: 0.86).combined(with: .opacity))
                .accessibilityIdentifier("pending-approval-badge")
            }

            Spacer(minLength: 4)

            if model.browser != nil, let badge = model.secondaryHubBadge, !showSnapshotCover, !model.drawerOpen {
                Button { model.openHub("tasks") } label: {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 15, weight: .medium))
                        .overlay(alignment: .topTrailing) {
                            if !badge.isEmpty {
                                Circle().fill(badge == "approval" ? Theme.warn : Theme.success)
                                    .frame(width: 6, height: 6).offset(x: 3, y: -2)
                            }
                        }
                        .frame(width: 34, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.labelPrimary)
                .fixedSize()
                .layoutPriority(2)
                .transition(.scale(scale: 0.88).combined(with: .opacity))
                .accessibilityLabel("移动端工具箱")
                .accessibilityIdentifier("secondary-hub-button")
            }

            if model.browser != nil, model.actionsEnabled {
                Button { model.startNewSession() } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.labelPrimary)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("新建会话")
                .accessibilityIdentifier("new-session-button")
            }

            Menu {
                if model.browser != nil {
                    Button { model.openHub("tasks") } label: {
                        Label("移动端工具箱", systemImage: "square.grid.2x2")
                    }
                    Button { model.openHub("git") } label: {
                        Label("工作区 Git 变更", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                    }
                    if model.actionsEnabled {
                        Button { showDictation = true } label: {
                            Label("语音语言与辅助输入", systemImage: "mic")
                        }
                        Button { model.startNewSession() } label: {
                            Label("新建会话", systemImage: "square.and.pencil")
                        }
                    }
                    Button { model.toggleSidebar() } label: {
                        Label(model.drawerOpen ? "收起会话侧边栏" : "打开会话侧边栏", systemImage: "sidebar.left")
                    }
                    Button { model.toggleRightPanel() } label: {
                        Label("文件与预览栏", systemImage: "sidebar.right")
                    }
                    Button { model.scrollToTop() } label: {
                        Label("回到对话顶部", systemImage: "arrow.up.to.line")
                    }
                    Button {
                        model.setFollowDesktop(!model.followDesktop)
                    } label: {
                        Label(
                            model.followDesktop ? "关闭自动跟随桌面会话" : "自动跟随桌面当前会话",
                            systemImage: model.followDesktop ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"
                        )
                    }
                    if let focus = model.desktopFocus, !focus.sessionId.isEmpty {
                        Button { model.jumpToDesktopFocus() } label: {
                            Label(focus.title.isEmpty ? "跳转到桌面当前会话" : "跳转：\(focus.title)", systemImage: "laptopcomputer")
                        }
                    }
                    Divider()
                }
                if model.linkInterrupted {
                    Button("立即重连", systemImage: "arrow.clockwise") { model.retryNow() }
                }
                Button("刷新 DSH 页面", systemImage: "arrow.clockwise") { model.reloadPage() }
                Button("重新连接（切换局域网/公网）", systemImage: "network") { model.forceSwitchEndpoint() }
                if !(model.desktop?.wakeEndpoints ?? []).isEmpty && model.wsHealth != .connected {
                    Button("启动电脑 DSH", systemImage: "power") { model.launchDesktopNow() }
                }
                Button("连接详情", systemImage: "info.circle") { showConnectionInfo = true }
                if model.savedDesktops.count > 1 {
                    Section("已配对的电脑") {
                        ForEach(model.savedDesktops) { desktop in
                            Button(desktop.name) { model.use(desktop) }
                        }
                    }
                }
                Divider()
                Button("配对另一台电脑", systemImage: "qrcode.viewfinder") { model.presentPairing() }
                Button("忘记这台电脑", systemImage: "trash", role: .destructive) { showForget = true }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body)
                    .foregroundStyle(Theme.labelSecondary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .layoutPriority(2)
            .accessibilityLabel("连接选项")
            .accessibilityIdentifier("connection-help")
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 38, maxHeight: 38)
        .animation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.84), value: model.pendingApprovalsCount)
        .animation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.84), value: model.secondaryHubBadge)
        .background { surfaceBackground.ignoresSafeArea(.container, edges: .top) }
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var syncAccessibilityStatus: String { model.wsHealth == .connected ? "已连接" : "正在连接" }

    private var documentRecoveryBanner: some View {
        HStack(spacing: 12) {
            Text("会话还未加载完成")
                .font(.subheadline)
                .accessibilityIdentifier("document-recovery")
            Button("重新加载") { model.reloadPage() }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.business)
                .frame(minHeight: 44)
                .accessibilityIdentifier("document-reload")
        }
        .padding(.horizontal, 16)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.borderL2, lineWidth: 0.5))
        .padding(.bottom, 26)
    }

    private var snapshotReconnectBanner: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("正在后台重连…")
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.labelPrimary)
                .lineLimit(1)
            Button("重试") { model.retryNow() }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.business)
            if !(model.desktop?.wakeEndpoints ?? []).isEmpty {
                Button("启动电脑") { model.launchDesktopNow() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.business)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.borderL2, lineWidth: 0.5))
        .padding(.bottom, 26)
    }

    private var connectionState: some View {
        VStack(spacing: 18) {
            if !model.revoked && (model.problem == nil || model.recoveryFailures < 2) {
                // Silent automatic reconnect on matching DSH background — never flash an error screen while retrying.
                Color.clear
            } else {
                Image(systemName: "network").font(.largeTitle).foregroundStyle(Theme.meta)
                Text(model.problem ?? "连接已断开")
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("connection-error")
                Button((model.desktop?.wakeEndpoints ?? []).isEmpty ? "重试" : "重试并在需要时启动电脑 DSH") { model.retryNow() }.buttonStyle(PrimaryButtonStyle())
                if !(model.desktop?.wakeEndpoints ?? []).isEmpty {
                    Button("启动电脑 DSH") { model.launchDesktopNow() }.buttonStyle(SecondaryButtonStyle())
                }
                Button("重新配对") { model.presentPairing() }.buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(surfaceBackground)
    }
}

private struct ConnectionDetailSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let desktop = model.desktop {
                    Section("已连接电脑") {
                        LabeledContent("名称", value: desktop.name)
                        LabeledContent("实时同步", value: syncText)
                        if let session = model.browser {
                            LabeledContent("当前网络", value: "\(session.endpoint.kind.label) · \(session.endpoint.authority)")
                            if let latency = model.lastLatencyMs {
                                LabeledContent("连接延迟", value: "\(latency) ms")
                            }
                            if !session.appVersion.isEmpty {
                                LabeledContent("桌面插件版本", value: session.appVersion)
                            }
                        }
                        LabeledContent("安全码") {
                            Text(desktop.safetyCode)
                                .font(DSHFont.code)
                                .textSelection(.enabled)
                        }
                    }
                    Section("同步权限（在电脑端「手机连接」控制）") {
                        LabeledContent("手机操作", value: model.actionsEnabled ? "已允许（双向同步）" : "仅只读观看")
                        LabeledContent("手机终端", value: model.terminalEnabled ? "已允许" : "未开启")
                        LabeledContent("任务防息屏", value: model.taskRunning ? "运行中已保持常亮" : "空闲（跟随系统）")
                        Toggle("后台任务完成与审批提醒", isOn: Binding(
                            get: { model.notificationsEnabled },
                            set: { model.setNotificationsEnabled($0) }
                        ))
                        if model.browser != nil {
                            Button { model.measureLatencyNow() } label: {
                                HStack {
                                    Text(model.pinging ? "正在测速…" : "立即测速连接延迟")
                                    Spacer()
                                    if model.pinging { ProgressView().controlSize(.small) }
                                }
                            }
                            .disabled(model.pinging)
                        }
                    }
                    TaskPushSection(settings:model.taskPush)
                    Section("桌面端同步") {
                        Toggle("自动跟随桌面当前会话", isOn: Binding(
                            get: { model.followDesktop },
                            set: { model.setFollowDesktop($0) }
                        ))
                        if let focus = model.desktopFocus, !focus.sessionId.isEmpty {
                            Button {
                                dismiss()
                                model.jumpToDesktopFocus()
                            } label: {
                                LabeledContent("桌面当前会话", value: focus.title.isEmpty ? focus.sessionId : focus.title)
                            }
                        }
                    }
                }
            }
            .navigationTitle("连接详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private var syncText: String {
        switch model.wsHealth {
        case .connected: return "实时同步中"
        case .connecting: return "正在连接…"
        case .disconnected: return "连接已断开"
        }
    }
}
