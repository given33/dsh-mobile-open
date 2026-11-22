import XCTest
@testable import DSHCore

/// Uses the synthetic fixture recorded from an isolated DSH 0.2.1-rc.3 host
/// (desktop/test/fixtures/demo.json): five sessions covering a finished
/// multi-step turn, a plain answer, a failed turn with retries, a pending
/// question and a turn still streaming when the recording stopped.
final class ConversationTests: XCTestCase {
    static let fixture: JSON = {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try! Data(contentsOf: root.appendingPathComponent("desktop/test/fixtures/demo.json"))
        return try! JSON.parse(data)
    }()

    func session(_ titlePrefix: String) -> (row: SessionRow, turns: [Turn]) { Self.session(titlePrefix) }

    static func session(_ titlePrefix: String) -> (row: SessionRow, turns: [Turn]) {
        let item = fixture["rpc"]["session/list"]["items"].array.first { $0["projections"]["values"]["title"].string.hasPrefix(titlePrefix) }!
        let row = SessionRow(item)
        var transcript = Transcript()
        for frame in fixture["streams"]["session/follow:\(row.id)"].array { transcript.receive(frame["value"]) }
        return (row, ConversationBuilder.build(transcript))
    }

    func groups(_ turn: Turn) -> [ProcessGroup] { turn.elements.compactMap { if case .group(let g) = $0 { return g }; return nil } }
    func replies(_ turn: Turn) -> [Reply] { turn.elements.compactMap { if case .reply(let r) = $0 { return r }; return nil } }

    func testFinishedTurnGroupsAndTitles() {
        let (row, turns) = session("梳理")
        XCTAssertEqual(turns.count, 1)
        let turn = turns[0]
        XCTAssertEqual(turn.opening.map(\.text), ["梳理一下这个项目的结构，找出还没做完的地方，给出改进建议"])
        XCTAssertEqual(turn.outcome, .completed)
        // reasoning+plan+glob+read | stage reply | grep+pwsh+read+plan×2 | final answer
        XCTAssertEqual(turn.elements.map { e -> String in
            switch e { case .group: "G"; case .reply: "R"; case .input: "I"; case .retry: "Y" }
        }, ["G", "R", "G", "R"])
        let g = groups(turn)
        XCTAssertTrue(g.allSatisfy(\.closed))
        XCTAssertEqual(g[0].title(mode: .standard), "更新了计划，已搜索代码，已读取文件")
        XCTAssertEqual(g[1].title(mode: .standard), "更新了计划，已搜索代码，执行了命令等")
        XCTAssertEqual(replies(turn)[0].text, "项目分为编辑器、存储与同步、界面三个模块，结构清晰。接下来看看还有哪些未完成的工作。")
        XCTAssertTrue(replies(turn)[1].text.hasPrefix("## 结论"))
        XCTAssertTrue(turn.foldable)
        XCTAssertEqual(turn.finalReplyID, replies(turn)[1].id)
        XCTAssertEqual(turn.controlLabel, "已完成，用时 ")
        XCTAssertNotNil(turn.durationLabel)
        XCTAssertEqual(turn.toolCallCount, 8)

        let tools = g.flatMap(\.tools)
        let read = tools.first { $0.name == "read" }!
        XCTAssertEqual(read.title, "读取")
        XCTAssertEqual(read.summary(cwd: row.cwd), "README.md")
        XCTAssertEqual(read.state, .ok)
        let pwsh = tools.first { $0.name == "pwsh" }!
        XCTAssertEqual(pwsh.title, "运行命令")
        XCTAssertEqual(pwsh.summary(cwd: row.cwd), "统计源码行数")
        XCTAssertEqual(pwsh.exitCode, 0)
        XCTAssertEqual(tools.first { $0.name == "grep" }!.summary(), "TODO")
        let plan = tools.first { $0.name == "todo_write" }!
        XCTAssertEqual(plan.title, "更新任务清单")
        XCTAssertEqual(plan.summary(), "0/3 已完成")
        XCTAssertEqual(tools.last { $0.name == "todo_write" }!.summary(), "3/3 已完成")
    }

    func testPlainAnswerIsAnalysisPlusReply() {
        let (_, turns) = session("解释")
        let turn = turns[0]
        XCTAssertEqual(groups(turn).count, 1)
        XCTAssertEqual(groups(turn)[0].title(mode: .standard), "已完成分析")
        XCTAssertTrue(replies(turn)[0].text.contains("游标分页"))
        XCTAssertEqual(turn.outcome, .completed)
    }

    func testFailedTurnWithRetries() {
        let (_, turns) = session("把 main")
        let turn = turns[0]
        guard case .failed(_, let code) = turn.outcome else { return XCTFail("\(turn.outcome)") }
        XCTAssertEqual(code, "SERVER")
        XCTAssertEqual(turn.controlLabel, "处理失败")
        XCTAssertFalse(turn.foldable)
        let retries = turn.elements.compactMap { if case .retry(let r) = $0 { return r }; return nil }
        XCTAssertEqual(retries.count, 1)
        XCTAssertEqual(retries[0].retry, 5)
        XCTAssertEqual(retries[0].maximum, 5)
    }

    func testPendingQuestionKeepsTheGroupOpen() {
        let (row, turns) = session("撰写")
        XCTAssertTrue(row.running)
        let turn = turns[0]
        XCTAssertEqual(turn.outcome, .running)
        let g = groups(turn)[0]
        XCTAssertFalse(g.closed)
        XCTAssertEqual(g.title(mode: .standard), "等待你的操作 · 发布说明用哪种语言？")
        XCTAssertEqual(g.title(mode: .compact), "等待你的操作")
        XCTAssertEqual(g.tools[0].summary(), "发布说明用哪种语言？")
    }

    func testLiveTurnFollowsTheStream() {
        let (row, turns) = session("重构")
        XCTAssertTrue(row.running)
        let turn = turns.last!
        XCTAssertEqual(turn.outcome, .running)
        let open = groups(turn).last!
        XCTAssertFalse(open.closed)
        XCTAssertTrue(open.title(mode: .compact).hasPrefix("准备运行命令"), open.title(mode: .compact))
        XCTAssertEqual(open.tools.last?.state, .preparing)
        // The stage reply streamed before the edit is already a settled reply.
        XCTAssertTrue(replies(turn).contains { $0.text.contains("独立的队列类") })
    }

    func testCategoryNamesAndJoins() {
        XCTAssertEqual(ToolCategory(toolName: "terminal_inspect"), .search)
        XCTAssertEqual(ToolCategory(toolName: "subagent_codex"), .subagents)
        XCTAssertEqual(ToolCategory(toolName: "send_message"), .tools)
        XCTAssertEqual(ToolCategory(toolName: "functions.read"), .tools)
        let two = ProcessGroup(id: "x", items: [.tool(ToolRow(id: "a", name: "read", argsRaw: "{}", state: .ok)), .tool(ToolRow(id: "b", name: "grep", argsRaw: "{}", state: .ok))], closed: true)
        XCTAssertEqual(two.title(mode: .standard), "已读取文件并搜索代码")
        let mixed = ProcessGroup(id: "y", items: [.tool(ToolRow(id: "a", name: "bash", argsRaw: "{}", state: .ok)), .tool(ToolRow(id: "b", name: "read", argsRaw: "{}", state: .ok))], closed: true)
        XCTAssertEqual(mixed.title(mode: .standard), "执行了命令并已读取文件")
        XCTAssertEqual(Elapsed.compact(8_400), "8秒")
        XCTAssertEqual(Elapsed.compact(125_000), "2分5秒")
        XCTAssertEqual(Elapsed.running(since: 1_000, now: 13_000), "深度求索中，用时 12秒 ···")
    }
}
