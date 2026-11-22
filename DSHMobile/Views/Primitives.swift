import SwiftUI
import DSHCore

/// DSH StateDot: a filled circle inset 20 % in its box.
struct StateDot: View {
    enum Kind { case done, warning, error, idle }
    let kind: Kind
    var size: CGFloat = 16
    init(_ kind: Kind, size: CGFloat = 16) { self.kind = kind; self.size = size }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size * 0.6, height: size * 0.6)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch kind {
        case .done: Theme.success
        case .warning: Theme.warn
        case .error: Theme.error
        case .idle: Theme.idle
        }
    }
}

/// DSH StateDot spinner: a faint track and a 12-unit arc turning every 1.5 s.
struct Spinner: View {
    var size: CGFloat = 16
    var color: Color = Theme.mark
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.5) / 1.5
            ZStack {
                Circle().stroke(color.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: 0.22)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(reduceMotion ? -90 : turn * 360 - 90))
            }
            .frame(width: size * 0.75, height: size * 0.75)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The running indicator's icon: DSH `loading-outline`, turning.
struct LoadingIcon: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
            DSHIcon("loading-outline").rotationEffect(.degrees(reduceMotion ? 0 : turn * 360))
        }
    }
}

/// TextShimmer: a highlight sweeps across a live label every 1.8 s (1.5 s sweep, .3 s rest).
struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .lineLimit(1)
            .overlay {
                if !reduceMotion {
                    TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                        let cycle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8)
                        let progress = min(1, max(0, (cycle - 0.3) / 1.5))
                        GeometryReader { geo in
                            let band = max(40, geo.size.width * 0.45)
                            LinearGradient(colors: [.clear, Theme.shimmer, .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + (geo.size.width + band) * progress)
                        }
                    }
                    .mask(Text(text).lineLimit(1))
                    .allowsHitTesting(false)
                }
            }
    }
}

/// The 2 pt separator dot between a row's title and summary.
struct SeparatorDot: View {
    var body: some View {
        Circle().fill(Theme.labelCaption).frame(width: 2.5, height: 2.5).padding(.horizontal, 8).accessibilityHidden(true)
    }
}

/// Durations with digits in the code face, as `.durationNumber` on the desktop.
enum DurationText {
    static func text(_ value: String) -> Text {
        var out = Text("")
        var run = "", digits = false
        func flush() {
            guard !run.isEmpty else { return }
            out = out + (digits ? Text(run).font(.system(.callout, design: .monospaced)) : Text(run))
            run = ""
        }
        for ch in value {
            let isDigit = ch.isASCII && ch.isNumber
            if isDigit != digits { flush(); digits = isDigit }
            run.append(ch)
        }
        flush()
        return out
    }
}

/// Clock text for a message: HH:mm today, M月d日 HH:mm earlier this year, then the full date.
enum MessageTime {
    static func label(_ ms: Int, now: Date = Date()) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let calendar = Calendar.current
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        if calendar.isDate(date, inSameDayAs: now) { format.dateFormat = "HH:mm" }
        else if calendar.isDate(date, equalTo: now, toGranularity: .year) { format.dateFormat = "M月d日 HH:mm" }
        else { format.dateFormat = "yyyy年M月d日 HH:mm" }
        return format.string(from: date)
    }
}

/// Large primary button: DSH primary fill (near-black in light, near-white in dark).
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Theme.primaryForeground)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.primaryFill.opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(Theme.labelPrimary.opacity(configuration.isPressed ? 0.6 : 1))
            .frame(maxWidth: .infinity, minHeight: 50)
            .contentShape(Rectangle())
    }
}
