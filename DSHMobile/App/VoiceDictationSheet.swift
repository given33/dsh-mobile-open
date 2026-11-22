import AVFoundation
import Speech
import SwiftUI
import DSHCore

struct VoiceDictationSheet: View {
    let insert: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scene
    @StateObject private var speech = LocalDictation()
    @AppStorage("dsh.voice.locale") private var locale = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("识别语言", selection: $locale) {
                    Text("跟随系统首选语言").tag("")
                    ForEach(LocalDictation.availableLocales, id: \.identifier) { language in
                        Text(Locale.current.localizedString(forIdentifier: language.identifier) ?? language.identifier)
                            .tag(language.identifier)
                    }
                }
                .disabled(speech.active || speech.requesting)

                Section {
                    TextEditor(text: $speech.text)
                        .frame(minHeight: 160)
                        .disabled(speech.active)
                } header: {
                    HStack {
                        Text("转写预览")
                        Spacer()
                        if !speech.text.isEmpty && !speech.active {
                            Button("清空") { speech.text = "" }
                                .font(.caption)
                        }
                    }
                }

                if let problem = speech.problem {
                    Text(problem)
                        .foregroundStyle(Theme.warnText)
                }
                if speech.requesting {
                    ProgressView("正在请求语音权限…")
                }

                Button {
                    if speech.active { speech.stop() }
                    else { Task { await speech.start(locale: locale) } }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: speech.active ? "stop.circle.fill" : "mic.fill")
                            .foregroundStyle(speech.active ? Theme.error : Theme.business)
                        Text(speech.active ? "停止录音" : (speech.text.isEmpty ? "开始录音" : "继续追加录音"))
                    }
                }
                .disabled(speech.requesting)
            }
            .navigationTitle("语音输入")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        speech.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("插入草稿") {
                        let value = speech.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        speech.cancel()
                        if !value.isEmpty { insert(value) }
                        dismiss()
                    }
                    .disabled(speech.active || speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onDisappear { speech.cancel() }
            .onChange(of: scene) { _, state in
                if state == .background { speech.cancel() }
            }
        }
    }
}

@MainActor final class LocalDictation: ObservableObject {
    @Published var text = ""
    @Published var problem: String?
    @Published var active = false
    @Published var requesting = false
    var event: ((String, String?, Double?) -> Void)?
    static let availableLocales = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tap = false
    private var audioActive = false
    private var generation = UUID()
    private var deadline: Task<Void, Never>?
    private var settle: Task<Void, Never>?

    private func deviceRecognizer(_ locale: String) -> SFSpeechRecognizer? {
        let preferences = locale.isEmpty ? Locale.preferredLanguages + [Locale.current.identifier] : [locale]
        for id in preferences {
            let candidate = Locale(identifier: id)
            // Prefer the exact region, then a supported dialect of the same language/script.
            let matches = Self.availableLocales.filter {
                $0.language.languageCode == candidate.language.languageCode &&
                    (candidate.language.script == nil || $0.language.script == candidate.language.script)
            }
            for language in [candidate] + matches {
                if let engine = SFSpeechRecognizer(locale: language), engine.isAvailable, engine.supportsOnDeviceRecognition {
                    return engine
                }
            }
        }
        return nil
    }

    private func fail(_ message: String) {
        problem = message
        event?("error", message, nil)
    }

    func start(locale: String, freshGestureAfterPermissions: Bool = false) async {
        guard !active, !requesting else { return }
        cancel()
        let token = UUID()
        generation = token
        requesting = true
        problem = nil
        defer { if generation == token { requesting = false } }

        let previous = SFSpeechRecognizer.authorizationStatus()
        let audioPermission = AVAudioApplication.shared.recordPermission
        let status: SFSpeechRecognizerAuthorizationStatus = previous == .notDetermined
            ? await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            } : previous
        guard generation == token else { return }
        guard status == .authorized else {
            fail("请在 iOS 设置里允许 DSH Mobile 使用语音识别。")
            return
        }

        let microphone: Bool = audioPermission == .undetermined
            ? await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            } : audioPermission == .granted
        guard generation == token else { return }
        guard microphone else {
            fail("请在 iOS 设置里允许 DSH Mobile 使用麦克风。")
            return
        }
        if freshGestureAfterPermissions && (previous == .notDetermined || audioPermission == .undetermined) {
            event?("permission-ready", "已授权，请重新按住麦克风说话", nil)
            return
        }
        guard let recognizer = deviceRecognizer(locale) else {
            fail("当前语言的设备端识别不可用，请在语音设置中切换语言，或使用系统键盘听写。")
            return
        }

        let audio = AVAudioSession.sharedInstance()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true

        let existing = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = existing.isEmpty ? "" : existing + "\n"
        do {
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            audioActive = true
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw ClientError.message("当前没有可用的麦克风输入。")
            }
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                request.append(buffer)
                guard let samples = buffer.floatChannelData?.pointee else { return }
                var peak: Float = 0
                for i in stride(from: 0, to: Int(buffer.frameLength), by: 12) { peak = max(peak, abs(samples[i])) }
                let level = Double(min(1, peak * 5))
                Task { @MainActor [weak self] in
                    guard let self, self.generation == token, self.active else { return }
                    self.event?("level", nil, level)
                }
            }
            tap = true
            self.recognizer = recognizer
            self.request = request
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let words = result?.bestTranscription.formattedString
                let isFinal = result?.isFinal == true
                let failed = error != nil
                Task { @MainActor [weak self] in
                    guard let self, self.generation == token else { return }
                    if let words, !words.isEmpty { self.text = prefix + words }
                    if isFinal || failed {
                        if failed && self.active && self.text == existing { self.fail("语音识别未完成，请重试。") }
                        else { self.event?("final", self.text, nil) }
                        self.cancel()
                    }
                }
            }
            engine.prepare()
            try engine.start()
            active = true
            event?("recording", nil, nil)
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(55))
                guard !Task.isCancelled else { return }
                self?.stop()
            }
        } catch {
            cancel()
            fail(error.localizedDescription)
        }
    }

    func stop() {
        let hadAudio = active
        releaseAudio()
        if hadAudio, event != nil {
            settle?.cancel()
            settle = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(1800))
                guard !Task.isCancelled, let self else { return }
                self.event?("final", self.text, nil)
                self.cancel()
            }
        }
    }

    private func releaseAudio() {
        active = false
        if engine.isRunning { engine.stop() }
        if tap {
            engine.inputNode.removeTap(onBus: 0)
            tap = false
        }
        request?.endAudio()
        request = nil
        if audioActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioActive = false
        }
    }

    func cancel() {
        generation = UUID()
        deadline?.cancel(); deadline = nil
        settle?.cancel(); settle = nil
        requesting = false
        releaseAudio()
        task?.cancel()
        task = nil
        recognizer = nil
    }
}
