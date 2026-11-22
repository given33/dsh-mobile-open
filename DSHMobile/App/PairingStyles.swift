import SwiftUI
import DSHCore

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(Theme.primaryForeground)
            .background(Theme.primaryFill.opacity(configuration.isPressed ? 0.8 : 1),
                        in: RoundedRectangle(cornerRadius: 12))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout).frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(Theme.labelPrimary)
            .background(Theme.grouped.opacity(configuration.isPressed ? 0.7 : 1),
                        in: RoundedRectangle(cornerRadius: 12))
    }
}

extension Endpoint.Kind {
    var label: String {
        switch self {
        case .lan: "局域网"
        case .tailnet: "私有网络"
        case .loopback: "本机"
        case .other: "公网"
        }
    }
}
