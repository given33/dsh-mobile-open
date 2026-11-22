import ActivityKit
import SwiftUI
import WidgetKit

@main struct DSHTaskIsland: Widget {
    func icon(_ s: DSHTaskAttributes.ContentState) -> String {
        switch s.phase {
        case "completed": return "checkmark.circle.fill"
        case "question": return "questionmark.bubble.fill"
        case "approval": return "hand.raised.fill"
        case "retry": return "arrow.clockwise.circle"
        default: return s.terminal ? "exclamationmark.circle.fill" : "waveform.path.ecg"
        }
    }
    func tint(_ s: DSHTaskAttributes.ContentState) -> Color {
        s.phase == "completed" ? .green : (s.terminal || ["approval","question"].contains(s.phase)) ? .orange : .cyan
    }
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DSHTaskAttributes.self) { ctx in
            HStack(spacing: 12) {
                Image(systemName: icon(ctx.state)).foregroundStyle(tint(ctx.state)).font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(ctx.state.label).font(.headline)
                    Text("第 \(ctx.state.turn) 轮 · 第 \(ctx.state.step) 步" + (ctx.state.detail.isEmpty ? "" : " · " + ctx.state.detail)).font(.caption)
                }
                Spacer(); Text(ctx.isStale ? "待同步" : "DSH").font(.caption)
            }.padding().widgetURL(ctx.attributes.link)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label("DSH", systemImage: icon(ctx.state)).foregroundStyle(tint(ctx.state)) }
                DynamicIslandExpandedRegion(.trailing) { Text("第 \(ctx.state.step) 步").monospacedDigit() }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading) { Text(ctx.state.label).font(.headline); Text(ctx.isStale ? "等待电脑同步" : ctx.state.detail.isEmpty ? "第 \(ctx.state.turn) 轮 · 点按查看会话" : ctx.state.detail).font(.caption) }.frame(maxWidth:.infinity,alignment:.leading)
                }
            } compactLeading: { Image(systemName: icon(ctx.state)).foregroundStyle(tint(ctx.state)) }
              compactTrailing: { Text(ctx.isStale ? "…" : "\(ctx.state.step)").monospacedDigit() }
              minimal: { Image(systemName: icon(ctx.state)).foregroundStyle(tint(ctx.state)) }
              .widgetURL(ctx.attributes.link).keylineTint(tint(ctx.state))
        }
    }
}
