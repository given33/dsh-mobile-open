import XCTest
@testable import DSHCore

final class MarkdownTests: XCTestCase {
    func testFixtureReplyBlocks() {
        let (_, turns) = ConversationTests.session("梳理")
        guard case .reply(let reply)? = turns[0].elements.last else { return XCTFail("no final reply") }
        let blocks = Markdown.parse(reply.text)
        XCTAssertEqual(blocks.count, 6)
        XCTAssertEqual(blocks[0], MarkdownBlock.heading(level: 2, text: "结论"))
        XCTAssertEqual(blocks[1], MarkdownBlock.paragraph("项目结构清晰，共 3 个模块、12 个源文件。最需要先处理的是**同步冲突**："))
        guard case .table(let header, let alignments, let rows) = blocks[2] else { return XCTFail("\(blocks[2])") }
        XCTAssertEqual(header, ["优先级", "位置", "建议"])
        XCTAssertEqual(alignments, [MarkdownBlock.Alignment.leading, .leading, .leading])
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0], ["高", "`src/store/sync.ts`", "冲突时保留两份副本，并在界面上提示"])
        guard case .code(let language, let code) = blocks[4] else { return XCTFail("\(blocks[4])") }
        XCTAssertEqual(language, "ts")
        XCTAssertTrue(code.hasPrefix("it('keeps both copies on conflict'"))
        XCTAssertTrue(code.hasSuffix("})"))
        XCTAssertEqual(blocks[5], MarkdownBlock.paragraph("需要的话，我可以接着实现冲突副本的保存逻辑。"))
    }

    func testListsNestAndContinue() {
        let blocks = Markdown.parse("""
        - `limit`：每页条数
        - `cursor`：上一页的
          `nextCursor`
          1. 第一页不传
          2. 之后照传

        3) 编号从三开始
        """)
        XCTAssertEqual(blocks.count, 2)
        guard case .list(false, _, let items) = blocks[0] else { return XCTFail("\(blocks[0])") }
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0], [MarkdownBlock.paragraph("`limit`：每页条数")])
        XCTAssertEqual(items[1].first, MarkdownBlock.paragraph("`cursor`：上一页的\n`nextCursor`"))
        guard case .list(true, 1, let nested)? = items[1].last else { return XCTFail("\(items[1])") }
        XCTAssertEqual(nested.count, 2)
        guard case .list(true, 3, _) = blocks[1] else { return XCTFail("\(blocks[1])") }
    }

    func testStreamingFenceQuoteRuleAndEscapes() {
        let blocks = Markdown.parse("> 引用\n> 第二行\n\n---\n\n| a | b \\| c | `x|y` |\n|:-:|--:|---|\n| 1 |\n\n```swift\nlet a = 1\n")
        XCTAssertEqual(blocks[0], MarkdownBlock.quote([.paragraph("引用\n第二行")]))
        XCTAssertEqual(blocks[1], MarkdownBlock.rule)
        XCTAssertEqual(blocks[2], MarkdownBlock.table(header: ["a", "b | c", "`x|y`"], alignments: [.center, .trailing, .leading], rows: [["1", "", ""]]))
        XCTAssertEqual(blocks[3], MarkdownBlock.code(language: "swift", text: "let a = 1\n"))
        XCTAssertEqual(Markdown.parse("# 标题 ##\n正文"), [.heading(level: 1, text: "标题"), .paragraph("正文")])
        XCTAssertEqual(Markdown.parse("#不是标题"), [MarkdownBlock.paragraph("#不是标题")])
        XCTAssertEqual(Markdown.parse(""), [])
    }

    func testUsageMatchesTheDesktopPills() {
        let (row, _) = ConversationTests.session("梳理")
        let usage = row.usage
        XCTAssertEqual(usage.counts, "1 轮 6 步")
        XCTAssertNotNil(usage.speed)
        XCTAssertTrue(usage.tokens?.hasSuffix("K tok") == true, usage.tokens ?? "nil")
        XCTAssertEqual(usage.cacheHit, "缓存命中 0%")
        XCTAssertEqual(usage.context, "2%")
        XCTAssertEqual(row.permissionLabel, "工作区内修改")
        XCTAssertEqual(SessionUsage.tokens(950), "950")
        XCTAssertEqual(SessionUsage.tokens(15_340), "15.3K")
        XCTAssertEqual(SessionUsage.tokens(184_200), "184K")
        XCTAssertEqual(SessionUsage.perSecond(88.4), "88")
        XCTAssertEqual(SessionUsage.perSecond(5.26), "5.3")
        XCTAssertEqual(SessionUsage.percent(999, of: 1000), "99.9")
        XCTAssertEqual(SessionUsage.percent(1000, of: 1000), "100")
    }

    func testSafetyCodeMatchesTheDesktopPanel() {
        XCTAssertEqual(Fingerprint.display("37xy7YxSjXOStXHwa32paYJ4De6vIBFnfvTZklusQNE"), "DFBC 72ED 8C52 8D73")
    }

    func testHighlighterRoles() {
        let source = "it('keeps both', async () => {\n  const n = await sync(1) // done\n})"
        let segments = CodeHighlight.segments(source, language: "ts")
        func kind(_ text: String) -> CodeHighlight.Kind? { segments.first { $0.text == text }?.kind }
        XCTAssertEqual(kind("it"), .function)
        XCTAssertEqual(kind("'keeps both'"), .string)
        XCTAssertEqual(kind("async"), .keyword)
        XCTAssertEqual(kind("const"), .keyword)
        XCTAssertEqual(kind("sync"), .function)
        XCTAssertEqual(kind("1"), .number)
        XCTAssertEqual(kind("// done"), .comment)
        XCTAssertEqual(segments.map(\.text).joined(), source)
        XCTAssertEqual(CodeHighlight.segments("# 注释\necho \"hi\"", language: "bash").map(\.kind), [.comment, .plain, .keyword, .plain, .string])
    }
}
