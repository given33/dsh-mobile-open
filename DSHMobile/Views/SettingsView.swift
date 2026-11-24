import SwiftUI
import DSHCore

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingForget = false

    var body: some View {
        NavigationStack {
            Form {
                if let desktop = model.desktop {
                    Section("电脑") {
                        HStack(spacing: 12) {
                            DSHIcon("followsystem-outline", size: 23)
                                .frame(width: 40, height: 40)
                                .background(Theme.grouped, in: RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 4) {
                                Text(desktop.name).font(.headline)
                                HStack(spacing: 6) {
                                    StateDot(model.isOnline ? .done : .idle)
                                    Text(connection).font(DSHFont.meta).foregroundStyle(Theme.meta)
                                }
                            }
                        }
                        LabeledContent("安全码") {
                            Text(desktop.safetyCode).font(DSHFont.code).textSelection(.enabled)
                        }
                        LabeledContent("配对时间") {
                            Text(desktop.pairedAt, format: .dateTime.month().day().hour().minute())
                        }
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("工作步骤展示")
                        ViewThatFits(in: .horizontal) {
                            modes.pickerStyle(.segmented)
                            modes.pickerStyle(.menu)
                        }
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("显示")
                } footer: {
                    Text("跟桌面「工作步骤展示」的四档一致。")
                }
                Section("桌面配置") {
                    NavigationLink("桌面设置") { HostSettingsList() }
                    NavigationLink("模型供应商与凭据") { ProvidersView() }
                    NavigationLink("插件管理") { PluginManagerView() }.accessibilityIdentifier("plugin-manager")
                }
                Section("连接") {
                    ForEach(model.otherDesktops) { desktop in
                        Button { model.use(desktop); dismiss() } label: {
                            Label(desktop.name, systemImage: "laptopcomputer")
                        }
                    }
                    Button { dismiss(); model.presentPairing() } label: {
                        Label("连接另一台电脑", systemImage: "qrcode.viewfinder")
                    }
                }
                Section {
                    Button("忘记这台电脑", role: .destructive) { confirmingForget = true }
                } footer: {
                    Text("忘记后需要重新扫码。电脑上的配对记录在「手机连接」里移除。")
                }
                Section {
                    Text("DSH Mobile \(version) · \(model.canWrite ? "允许手机操作" : "只读连接")")
                        .font(DSHFont.meta).foregroundStyle(Theme.meta)
                        .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.grouped)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.accessibilityIdentifier("settings-done") } }
            .confirmationDialog("忘记这台电脑？", isPresented: $confirmingForget, titleVisibility: .visible) {
                Button("忘记这台电脑", role: .destructive) { if model.removeCurrent() { dismiss() } }
                Button("取消", role: .cancel) {}
            } message: { Text("下次连接需要重新扫码。") }
            .alert("无法更新配对记录", isPresented: Binding(
                get: { model.storageError != nil }, set: { if !$0 { model.storageError = nil } }
            )) { Button("好", role: .cancel) {} } message: {
                Text(model.storageError ?? "")
            }
        }
    }

    private var modes: some View {
        Picker("工作步骤展示", selection: $model.displayMode) {
            ForEach(DisplayMode.allCases, id: \.self) { mode in Text(mode.label).tag(mode) }
        }
        .accessibilityIdentifier("display-mode")
    }

    private var connection: String {
        if model.isOnline, let endpoint = model.endpoint { return "已连接 · \(endpoint.kind.label) \(endpoint.host)" }
        return model.notice != nil ? "重新连接中" : "未连接"
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.3.2"
    }
}
