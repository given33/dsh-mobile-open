import AVFoundation
import SwiftUI
import UIKit

/// AVFoundation QR reader. Works on every iPhone that runs iOS 17 (VisionKit's
/// DataScanner needs an A12 and adds nothing for a single QR code).
final class QRCapture: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    enum Availability: Equatable { case unknown, ready, denied, noCamera }

    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.dshmobile.scanner")
    private var configured = false
    private var last: (value: String, at: Date)?
    /// Called on the main actor for each new code (the same code is ignored for 2 s).
    var onCode: (@MainActor (String) -> Void)?

    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }
    static var hasTorch: Bool { AVCaptureDevice.default(for: .video)?.hasTorch == true }

    /// Ask for camera access if needed.
    static func requestAvailability() async -> Availability {
        guard hasCamera else { return .noCamera }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .ready
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .ready : .denied
        default: return .denied
        }
    }

    func start() {
        queue.async { [self] in
            if !configured { configure(); configured = true }
            if !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in if session.isRunning { session.stopRunning() } }
    }

    func setTorch(_ on: Bool) {
        queue.async {
            guard let device = AVCaptureDevice.default(for: .video), device.hasTorch,
                  (try? device.lockForConfiguration()) != nil else { return }
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.beginConfiguration()
        session.sessionPreset = .high
        if session.canAddInput(input) { session.addInput(input) }
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        }
        session.commitConfiguration()
        if (try? device.lockForConfiguration()) != nil {
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
            device.unlockForConfiguration()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = objects.lazy.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        if let last, last.value == value, Date().timeIntervalSince(last.at) < 2 { return }
        last = (value, Date())
        MainActor.assumeIsolated { onCode?(value) }
    }
}

/// Live camera preview for a QRCapture session.
struct QRPreview: UIViewRepresentable {
    let capture: QRCapture

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = capture.session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
