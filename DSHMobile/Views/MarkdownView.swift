import SwiftUI
import UIKit
import DSHCore

/// Assistant Markdown, laid out like the desktop's AssistantMarkdown: 16 pt body, 16 pt block gap,
/// code blocks on the code surface with a language banner, tables with hairline rules.
struct MarkdownView: View {
    let text: String

    var body: some View {
        let blocks = Markdown.parse(text)
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(Inline.render(text))
                .font(level == 1 ? DSHFont.h1 : level == 2 ? DSHFont.h2 : DSHFont.h3)
                .foregroundStyle(Theme.labelPrimary)
                .padding(.top, level <= 2 ? 6 : 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(Inline.render(text))
                .font(DSHFont.content)
                .foregroundStyle(Theme.labelPrimary)
                .lineSpacing(5)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(ordered ? "\(start + index)." : "•")
                            .font(DSHFont.content)
                            .monospacedDigit()
                            .foregroundStyle(Theme.labelSecondary)
                            .frame(minWidth: ordered ? 18 : 10, alignment: .leading)
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(item.enumerated()), id: \.offset) { _, child in MarkdownBlockView(block: child) }
                        }
                    }
                }
            }
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .table(let header, let alignments, let rows):
            TableBlockView(header: header, alignments: alignments, rows: rows)
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 14) {
                Rectangle().fill(Theme.labelCaption).frame(width: 2)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, child in MarkdownBlockView(block: child) }
                }
                .foregroundStyle(Theme.labelSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Hairline().padding(.vertical, 16)
        }
    }
}

/// Inline Markdown (emphasis, code spans, links) with the desktop's styling.
enum Inline {
    static func render(_ source: String, codeSize: Font.TextStyle = .subheadline) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        var text = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        for run in text.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                text[run.range].font = .system(codeSize, design: .monospaced)
                text[run.range].backgroundColor = Theme.hover
            }
            if run.link != nil {
                text[run.range].foregroundColor = Theme.link
                text[run.range].underlineStyle = nil
            }
        }
        return text
    }

    /// Paths in narrow table cells may break after a slash, never inside a name.
    static func breakablePaths(_ source: String) -> String {
        var out = "", inCode = false
        for ch in source {
            if ch == "`" { inCode.toggle() }
            out.append(ch)
            if inCode && ch == "/" { out.append("\u{200B}") }
        }
        return out
    }
}

struct CodeBlockView: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "text" : language)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.labelPrimary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    if copied { DSHIcon("check-outline") } else { DSHIcon("copy-outline") }
                }
                .foregroundStyle(Theme.labelSecondary)
                .frame(width: 44, height: 38)
                .contentShape(Rectangle())
                .accessibilityLabel(copied ? "已复制" : "复制代码")
            }
            .padding(.leading, 14)
            .frame(height: 38)
            .background(Theme.codeBanner)
            Hairline(color: Theme.borderL1)
            highlighted
                .font(DSHFont.code)
                .lineSpacing(5)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 14)
        }
        .background(Theme.codeBlock)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var highlighted: Text {
        CodeHighlight.segments(code.hasSuffix("\n") ? String(code.dropLast()) : code, language: language).reduce(Text("")) { result, segment in
            let color: Color = switch segment.kind {
            case .plain: Theme.labelPrimary
            case .keyword: Theme.codeKeyword
            case .string: Theme.codeString
            case .comment: Theme.codeComment
            case .number: Theme.codeNumber
            case .function: Theme.codeFunction
            }
            return result + Text(segment.text).foregroundColor(color)
        }
    }
}

struct TableBlockView: View {
    let header: [String]
    let alignments: [MarkdownBlock.Alignment]
    let rows: [[String]]

    var body: some View {
        // Up to three columns wrap inside the screen; wider tables scroll sideways, as on the desktop.
        if header.count <= 3 {
            grid(minCell: 0).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView(.horizontal, showsIndicators: false) { grid(minCell: 100) }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }

    private func grid(minCell: CGFloat) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(header.enumerated()), id: \.offset) { index, text in
                    cell(text, column: index, head: true, minWidth: minCell)
                }
            }
            GridRow { Hairline(color: Theme.borderL3).gridCellColumns(max(1, header.count)) }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, text in
                        cell(text, column: index, head: false, minWidth: minCell)
                    }
                }
                GridRow { Hairline().gridCellColumns(max(1, header.count)) }
            }
        }
    }

    private func cell(_ text: String, column: Int, head: Bool, minWidth: CGFloat) -> some View {
        let alignment: Alignment = switch column < alignments.count ? alignments[column] : .leading {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
        return Text(Inline.render(Inline.breakablePaths(text), codeSize: .footnote))
            .font(head ? DSHFont.secondary.weight(.medium) : DSHFont.secondary)
            .foregroundStyle(Theme.labelPrimary)
            .lineSpacing(3)
            .padding(.vertical, 10)
            .padding(.trailing, 12)
            .frame(minWidth: minWidth, maxWidth: minWidth > 0 ? 320 : .infinity, alignment: alignment)
    }
}
