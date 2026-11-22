import Foundation

/// Block structure of an assistant reply. Inline markup (emphasis, code spans,
/// links) stays in the strings; the app renders it with AttributedString.
public enum MarkdownBlock: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
    case code(language: String, text: String)
    case table(header: [String], alignments: [Alignment], rows: [[String]])
    case quote([MarkdownBlock])
    case rule
}

/// A small CommonMark + GFM-table block parser: enough for model replies,
/// tolerant of text that is still streaming (an open fence runs to the end).
public enum Markdown {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var parser = BlockParser(lines: normalized.components(separatedBy: "\n"))
        return parser.blocks()
    }
}

struct BlockParser {
    let lines: [String]
    var i = 0

    init(lines: [String]) { self.lines = lines }

    mutating func blocks() -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let fence = Self.fence(line) { flush(); out.append(code(fence)); continue }
            if let heading = Self.heading(line) { flush(); out.append(heading); i += 1; continue }
            if Self.isRule(line) { flush(); out.append(.rule); i += 1; continue }
            if trimmed.hasPrefix(">") { flush(); out.append(quote()); continue }
            if line.contains("|"), i + 1 < lines.count, let alignments = Self.delimiterRow(lines[i + 1]),
               Self.splitRow(line).count == alignments.count {
                flush(); out.append(table(alignments)); continue
            }
            if let marker = Self.listMarker(line) { flush(); out.append(list(marker)); continue }
            paragraph.append(trimmed)
            i += 1
        }
        flush()
        return out
    }

    // MARK: Fenced code

    struct Fence { let char: Character; let count: Int; let info: String; let indent: Int }

    static func fence(_ line: String) -> Fence? {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        guard let c = rest.first, c == "`" || c == "~" else { return nil }
        let count = rest.prefix { $0 == c }.count
        guard count >= 3 else { return nil }
        let info = rest.dropFirst(count).trimmingCharacters(in: .whitespaces)
        if c == "`" && info.contains("`") { return nil }
        return Fence(char: c, count: count, info: info, indent: indent)
    }

    mutating func code(_ fence: Fence) -> MarkdownBlock {
        i += 1
        var body: [String] = []
        while i < lines.count {
            let line = lines[i]
            let indent = line.prefix { $0 == " " }.count
            let rest = line.dropFirst(indent)
            let run = rest.prefix { $0 == fence.char }.count
            if indent <= 3, run >= fence.count, rest.dropFirst(run).trimmingCharacters(in: .whitespaces).isEmpty { i += 1; break }
            body.append(String(line.dropFirst(min(fence.indent, indent))))
            i += 1
        }
        let language = fence.info.split(separator: " ").first.map(String.init) ?? ""
        return .code(language: language, text: body.joined(separator: "\n"))
    }

    // MARK: Headings, rules, quotes

    static func heading(_ line: String) -> MarkdownBlock? {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        let level = rest.prefix { $0 == "#" }.count
        guard (1...6).contains(level) else { return nil }
        let after = rest.dropFirst(level)
        guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
        var text = after.trimmingCharacters(in: .whitespaces)
        if text.allSatisfy({ $0 == "#" }) { text = "" }
        else if let closing = text.range(of: #"[ \t]+#+$"#, options: .regularExpression) { text.removeSubrange(closing) }
        return .heading(level: level, text: text)
    }

    static func isRule(_ line: String) -> Bool {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return false }
        let marks = line.filter { $0 != " " && $0 != "\t" }
        guard let c = marks.first, "-*_".contains(c), marks.count >= 3 else { return false }
        return marks.allSatisfy { $0 == c }
    }

    mutating func quote() -> MarkdownBlock {
        var inner: [String] = []
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(">") else { break }
            var content = trimmed.dropFirst()
            if content.first == " " { content = content.dropFirst() }
            inner.append(String(content))
            i += 1
        }
        var parser = BlockParser(lines: inner)
        return .quote(parser.blocks())
    }

    // MARK: Tables (GFM)

    static func delimiterRow(_ line: String) -> [MarkdownBlock.Alignment]? {
        guard line.contains("-") else { return nil }
        let cells = splitRow(line)
        var out: [MarkdownBlock.Alignment] = []
        for cell in cells {
            guard !cell.isEmpty, cell.contains("-"), cell.allSatisfy({ $0 == "-" || $0 == ":" }) else { return nil }
            let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
            out.append(left && right ? .center : right ? .trailing : .leading)
        }
        return out.isEmpty ? nil : out
    }

    /// Cells of a pipe row; `\|` is a literal pipe and pipes inside code spans do not split.
    static func splitRow(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
        var cells: [String] = [], current = "", inCode = false, escape = false
        for ch in text {
            if escape {
                if ch != "|" { current.append("\\") }
                current.append(ch); escape = false; continue
            }
            if ch == "\\" { escape = true; continue }
            if ch == "`" { inCode.toggle() }
            if ch == "|" && !inCode { cells.append(current.trimmingCharacters(in: .whitespaces)); current = ""; continue }
            current.append(ch)
        }
        if escape { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    mutating func table(_ alignments: [MarkdownBlock.Alignment]) -> MarkdownBlock {
        let header = Self.splitRow(lines[i])
        i += 2
        var rows: [[String]] = []
        while i < lines.count {
            let line = lines[i]
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty, line.contains("|") else { break }
            var cells = Self.splitRow(line)
            if cells.count < header.count { cells += Array(repeating: "", count: header.count - cells.count) }
            rows.append(Array(cells.prefix(header.count)))
            i += 1
        }
        return .table(header: header, alignments: alignments, rows: rows)
    }

    // MARK: Lists

    struct ListMarker { let ordered: Bool; let start: Int; let indent: Int; let contentOffset: Int; let symbol: Character }

    static func listMarker(_ line: String) -> ListMarker? {
        let indent = line.prefix { $0 == " " }.count
        let rest = Array(line.dropFirst(indent))
        guard let first = rest.first else { return nil }
        func padding(after n: Int) -> Int? {
            guard n < rest.count else { return 1 }
            guard rest[n] == " " || rest[n] == "\t" else { return nil }
            let spaces = rest[n...].prefix { $0 == " " }.count
            return (1...4).contains(spaces) ? spaces : 1
        }
        if "-*+".contains(first) {
            guard let pad = padding(after: 1) else { return nil }
            return ListMarker(ordered: false, start: 1, indent: indent, contentOffset: indent + 1 + pad, symbol: first)
        }
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard (1...9).contains(digits.count), digits.count < rest.count, rest[digits.count] == "." || rest[digits.count] == ")" else { return nil }
        guard let pad = padding(after: digits.count + 1) else { return nil }
        return ListMarker(ordered: true, start: Int(String(digits)) ?? 1, indent: indent,
                          contentOffset: indent + digits.count + 1 + pad, symbol: rest[digits.count])
    }

    mutating func list(_ first: ListMarker) -> MarkdownBlock {
        var items: [[String]] = []
        var current: [String]?
        var afterBlank = false
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { afterBlank = true; current?.append(""); i += 1; continue }
            let indent = line.prefix { $0 == " " }.count
            if let marker = Self.listMarker(line), indent < first.contentOffset {
                guard marker.ordered == first.ordered, marker.symbol == first.symbol, !Self.isRule(line) else { break }
                if let current { items.append(current) }
                current = [String(line.dropFirst(min(marker.contentOffset, line.count)))]
                afterBlank = false; i += 1; continue
            }
            if indent >= first.contentOffset, current != nil {
                current!.append(String(line.dropFirst(first.contentOffset)))
                afterBlank = false; i += 1; continue
            }
            if afterBlank { break }
            // Lazy continuation: plain text right under an item.
            if current != nil, Self.heading(line) == nil, Self.fence(line) == nil, !Self.isRule(line), !trimmed.hasPrefix(">") {
                current!.append(trimmed); i += 1; continue
            }
            break
        }
        if let current { items.append(current) }
        let parsed = items.map { body -> [MarkdownBlock] in
            var body = body
            while body.last == "" { body.removeLast() }
            var parser = BlockParser(lines: body)
            return parser.blocks()
        }
        return .list(ordered: first.ordered, start: first.start, items: parsed)
    }
}
