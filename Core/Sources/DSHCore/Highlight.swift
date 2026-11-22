import Foundation

/// A light lexical highlighter for code blocks: comments, strings, numbers,
/// keywords and call names. It stands in for the desktop's shiki themes with
/// the same token roles; unknown languages get the common C-family rules.
public enum CodeHighlight {
    public enum Kind: Equatable, Sendable { case plain, keyword, string, comment, number, function }
    public struct Segment: Equatable, Sendable {
        public let text: String
        public let kind: Kind
    }

    private enum Family { case cLike, hash, markup }

    private static func family(_ language: String) -> Family {
        switch language.lowercased() {
        case "py", "python", "sh", "bash", "zsh", "shell", "console", "yaml", "yml", "toml", "rb", "ruby", "ps1", "pwsh", "powershell", "r", "dockerfile", "make", "makefile":
            return .hash
        case "html", "xml", "md", "markdown", "text", "txt", "plaintext", "diff", "csv":
            return .markup
        default:
            return .cLike
        }
    }

    static let keywords: Set<String> = [
        // JavaScript / TypeScript
        "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export",
        "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "interface", "let", "new", "of",
        "return", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "yield",
        "true", "false", "null", "undefined", "enum", "implements", "private", "protected", "public", "readonly", "as",
        // Swift / Rust / Go / Kotlin
        "func", "guard", "struct", "protocol", "extension", "init", "self", "Self", "nil", "fileprivate", "internal", "mutating",
        "fn", "impl", "mut", "pub", "use", "mod", "match", "trait", "where", "loop", "crate", "package", "go", "defer", "chan",
        "map", "range", "select", "val", "fun", "object", "when", "is",
        // Python / shell
        "def", "elif", "except", "lambda", "pass", "raise", "with", "None", "True", "False", "and", "or", "not", "global",
        "then", "fi", "done", "esac", "echo", "export", "local", "function",
    ]

    public static func segments(_ code: String, language: String) -> [Segment] {
        let family = family(language)
        guard family != .markup else { return [Segment(text: code, kind: .plain)] }
        let chars = Array(code)
        var out: [Segment] = []
        var plain = ""
        func emit(_ text: String, _ kind: Kind) {
            if !plain.isEmpty { out.append(Segment(text: plain, kind: .plain)); plain = "" }
            out.append(Segment(text: text, kind: kind))
        }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            // Comments
            if (family == .cLike && c == "/" && next == "/") || (family == .hash && c == "#") {
                var j = i
                while j < chars.count && chars[j] != "\n" { j += 1 }
                emit(String(chars[i..<j]), .comment); i = j; continue
            }
            if family == .cLike && c == "/" && next == "*" {
                var j = i + 2
                while j < chars.count && !(chars[j] == "*" && j + 1 < chars.count && chars[j + 1] == "/") { j += 1 }
                j = min(chars.count, j + 2)
                emit(String(chars[i..<j]), .comment); i = j; continue
            }
            // Strings
            if c == "\"" || c == "'" || c == "`" {
                var j = i + 1
                while j < chars.count {
                    if chars[j] == "\\" { j += 2; continue }
                    if chars[j] == c { j += 1; break }
                    if chars[j] == "\n" && c != "`" { break }
                    j += 1
                }
                j = min(j, chars.count)
                emit(String(chars[i..<j]), .string); i = j; continue
            }
            // Numbers
            if c.isASCII && c.isNumber && !(i > 0 && isWord(chars[i - 1])) {
                var j = i
                while j < chars.count && (isWord(chars[j]) || chars[j] == ".") { j += 1 }
                emit(String(chars[i..<j]), .number); i = j; continue
            }
            // Words
            if isWordStart(c) {
                var j = i
                while j < chars.count && isWord(chars[j]) { j += 1 }
                let word = String(chars[i..<j])
                if keywords.contains(word) { emit(word, .keyword) }
                else if j < chars.count && chars[j] == "(" { emit(word, .function) }
                else { plain += word }
                i = j; continue
            }
            plain.append(c); i += 1
        }
        if !plain.isEmpty { out.append(Segment(text: plain, kind: .plain)) }
        return out
    }

    private static func isWordStart(_ c: Character) -> Bool { c == "_" || c == "$" || (c.isLetter && c.isASCII) }
    private static func isWord(_ c: Character) -> Bool { isWordStart(c) || (c.isASCII && c.isNumber) }
}
