import SwiftUI
import UIKit
import DSHCore

/// DSH 0.2.1-rc.3 theme tokens (`@deepseek-ai/dsh-client-ui-theme`, MIT, Copyright (c) 2026 DeepSeek)
/// and the phone's own additions.
/// Every color resolves per trait collection, so light and dark differ only by token values.
enum Theme {
    static func color(_ light: UInt32, _ dark: UInt32, alpha: (light: CGFloat, dark: CGFloat) = (1, 1)) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: alpha.dark) : UIColor(hex: light, alpha: alpha.light)
        })
    }

    // Surfaces
    static let bgBase = color(0xffffff, 0x151517)
    static let sidebarFill = color(0xf9fafb, 0x1b1b1c)
    static let sheet = color(0xffffff, 0x232324)
    static let grouped = color(0xf2f3f5, 0x151517)
    static let groupedCell = color(0xffffff, 0x232324)
    static let bubble = color(0xedf3fe, 0x2c2c2e)
    static let codeBlock = color(0xf9fafb, 0x1b1b1c)
    static let codeBanner = color(0xf9fafb, 0x2c2c2e)
    static let navActive = color(0xebeef2, 0x43454a)
    static let hover = color(0x263148, 0xffffff, alpha: (0.059, 0.078))
    static let active = color(0x263148, 0xffffff, alpha: (0.102, 0.141))
    static let menu = color(0xf8f9fa, 0x43454a, alpha: (0.58, 0.451))
    static let toast = color(0x353638, 0x43454a)
    static let warnTertiary = color(0xfef5e7, 0x27241f)

    // Labels
    static let labelPrimary = color(0x0f1115, 0xf9fafb)
    static let labelSecondary = color(0x61666b, 0xcfd3d6)
    static let labelTertiary = color(0x81858c, 0xadb2b8)
    static let labelCaption = color(0xadb2b8, 0x81858c)
    static let primaryFill = color(0x0f1115, 0xf9fafb)
    static let primaryForeground = color(0xffffff, 0x0f1115)
    static let link = color(0x4176e6, 0x7aaaff)
    static let business = link
    static let deepDiving = color(0x345eba, 0x7d9ade)
    static let shimmer = color(0x000000, 0xffffff, alpha: (0.3, 0.45))

    // Borders (DSH draws them .5 px; see `hairline`)
    static let borderL1 = color(0x000000, 0xffffff, alpha: (0.039, 0.059))
    static let borderL2 = color(0x000000, 0xffffff, alpha: (0.102, 0.122))
    static let borderL3 = color(0x000000, 0xffffff, alpha: (0.122, 0.161))
    static let borderL4 = color(0x000000, 0xffffff, alpha: (0.161, 0.2))

    // States
    static let success = color(0x22c55e, 0x22c55e)
    static let error = color(0xec1313, 0xf25a5a)
    static let warn = color(0xf59e0b, 0xf59e0b)
    static let warnLabel = color(0xdd8629, 0xdd8629)
    /// Dark uses #626365: the desktop's #545557 reaches only 2.44:1 there.
    static let idle = color(0xd4d4d4, 0x626365)

    // Phone roles (intentional additions)
    /// Process rows, times and meta. Light uses label-secondary (5.80:1) where the desktop uses tertiary (3.71:1).
    static let process = color(0x61666b, 0xadb2b8)
    static let meta = process
    /// Meaningful marks the desktop draws in label-caption.
    static let mark = color(0x81858c, 0x81858c)
    /// Warning text: amber has no passing step on white, so light uses the primary label.
    static let warnText = color(0x0f1115, 0xdd8629)

    // Code highlighting: shiki tokens, light values corrected for 4.5:1 on the code block.
    static let codeKeyword = color(0xd4306a, 0xfaa2c1)
    static let codeString = color(0x00852b, 0x69db7c)
    static let codeComment = color(0x6d747c, 0xadb5bd)
    static let codeNumber = color(0x0c75cd, 0x4dabf7)
    static let codeFunction = color(0x6741d9, 0xb197fc)
}

/// DSH content type plus the +2 pt phone delta, mapped to Dynamic Type styles.
enum DSHFont {
    /// Replies, bubbles, process headers: 16 pt.
    static let content = Font.callout
    /// Tool rows, retry rows, table cells: 15 pt.
    static let secondary = Font.subheadline
    static let meta = Font.footnote
    static let caption = Font.caption
    static let code = Font.system(.footnote, design: .monospaced)
    static let h1 = Font.title2.weight(.bold)
    static let h2 = Font.title3.weight(.bold)
    static let h3 = Font.headline
    static let rowTitle = Font.callout
}

/// The DSH ease, cubic-bezier(.4, 0, .2, 1).
extension Animation {
    static func dsh(_ duration: Double = 0.2) -> Animation { .timingCurve(0.4, 0, 0.2, 1, duration: duration) }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }
}

/// DSH's own 16 px line icons (`@deepseek-ai/dsh-client-ui-primitives`, MIT), shipped as template SVGs.
struct DSHIcon: View {
    let name: String
    var size: CGFloat
    @ScaledMetric(relativeTo: .callout) private var scale: CGFloat = 1

    init(_ name: String, size: CGFloat = 16) { self.name = name; self.size = size }

    var body: some View {
        Group {
            if let image = UIImage(named: "dsh-" + name) {
                Image(uiImage: image).renderingMode(.template).resizable().scaledToFit()
            } else {
                Image(systemName: fallback).font(.system(size: size * scale))
            }
        }
        .frame(width: size * scale, height: size * scale)
        .accessibilityHidden(true)
    }

    private var fallback: String {
        switch name {
        case "check-outline": "checkmark"
        case "copy-outline": "doc.on.doc"
        case "flat-list-outline": "list.bullet"
        case "sparkle": "sparkles"
        case "globe-outline": "globe"
        case "warning-outline": "exclamationmark.triangle"
        case "chevron-right-outline": "chevron.right"
        case "question-outline": "questionmark.circle"
        case "plan-outline": "list.clipboard"
        default: "circle"
        }
    }
}

extension ToolCategory {
    /// The process-group icon, as `PROCESS_ICONS` in the desktop Chat.
    var icon: String {
        switch self {
        case .read, .readImage, .webFetch: "browse-outline"
        case .search: "search-outline"
        case .write, .edit: "edit-outline"
        case .commands: "api-outline"
        case .code: "code-outline"
        case .webSearch: "globe-outline"
        case .subagents: "agent-preset-outline"
        case .plan: "plan-outline"
        case .questions: "question-outline"
        case .tools: "sparkle"
        }
    }
}

/// A .5 pt line, as the desktop's `.5px` borders.
struct Hairline: View {
    var color: Color = Theme.borderL2
    @Environment(\.displayScale) private var scale
    var body: some View { Rectangle().fill(color).frame(height: max(0.5, 1 / scale)) }
}

extension View {
    /// DSH `--dsw-elevation-panel`: a .5 pt stroke and two soft shadows.
    func panelElevation(radius: CGFloat = 16, stroke: Color = Theme.borderL2) -> some View {
        self
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(stroke, lineWidth: 0.5))
            .shadow(color: .black.opacity(0.05), radius: 4, y: 3)
            .shadow(color: .black.opacity(0.03), radius: 8)
    }
}
