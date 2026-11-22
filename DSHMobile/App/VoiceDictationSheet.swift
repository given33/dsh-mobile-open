import AVFoundation
import Speech
import SwiftUI
import DSHCore

struct VoiceDictationSheet: View {
    let insert: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scene
    @StateObject private var speech = LocalDictation()
    @State private var locale = Locale.current.identifier

    var body: some View {
        NavigationStack {
            Form {
                Picker("识别语言", selection: $locale) {
                    if !["zh-CN", "en-US"].contains(Locale.current.identifier) {
                        Text("跟随系统").tag(Locale.current.identifier)
                    }
                    Text("中文（普通话）").tag("zh-CN")
                    Text("英语").tag("en-US")
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

@MainActor private final class LocalDictation: ObservableObject {
    @Published var text = ""
    @Published var problem: String?
    @Published var active = false
    @Published var requesting = false

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tap = false
    private var audioActive = false
    private var generation = UUID()

    func start(locale: String) async {
        guard !active, !requesting else { return }
        cancel()
        let token = UUID()
        generation = token
        requesting = true
        problem = nil
        defer { if generation == token { requesting = false } }

        let status = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard generation == token else { return }
        guard status == .authorized else {
            problem = "请在 iOS 设置里允许 DSH Mobile 使用语音识别。"
            return
        }

        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard generation == token else { return }
        guard microphone else {
            problem = "请在 iOS 设置里允许 DSH Mobile 使用麦克风。"
            return
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            problem = "当前语音识别服务不可用，请稍后重试或切换系统听写。"
            return
        }

        let audio = AVAudioSession.sharedInstance()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
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
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
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
                        if failed && self.active && self.text == existing {
                            self.problem = "语音识别未完成，请重试。"
                        }
                        self.stop()
                    }
                }
            }
            engine.prepare()
            try engine.start()
            active = true
        } catch {
            cancel()
            problem = error.localizedDescription
        }
    }

    func stop() {
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
        requesting = false
        stop()
        task?.cancel()
        task = nil
        recognizer = nil
    }
}
