import XCTest
@testable import DSHCore

final class SessionsTests: XCTestCase {
    func directory() -> SessionDirectory {
        let f = ConversationTests.fixture
        var d = SessionDirectory()
        for frame in f["streams"]["$events"].array { d.receiveEvent(frame["value"]) }
        d.receiveList(f["rpc"]["session/list"])
        for frame in f["streams"]["session/control"].array { d.receiveControl(frame["value"]) }
        for frame in f["streams"]["workspace/follow"].array { d.receiveWorkspace(frame["value"]) }
        return d
    }
    func id(_ d: SessionDirectory, _ prefix: String) -> String { d.visible.first { $0.title.hasPrefix(prefix) }!.id }

    func testStatusesMirrorTheDesktopSidebar() {
        let d = directory()
        XCTAssertEqual(d.count, 5)
        XCTAssertEqual(d.status(of: id(d, "撰写")), .waitingAnswer, "the pending question outranks running")
        XCTAssertEqual(d.status(of: id(d, "撰写")).compactLabel, "待回答")
        XCTAssertEqual(d.status(of: id(d, "重构")), .running)
        XCTAssertEqual(d.status(of: id(d, "梳理")), .idle)
        XCTAssertEqual(d.pending(for: id(d, "撰写")).first?.summary, "发布说明用哪种语言？")
        XCTAssertTrue(d.rows[id(d, "梳理")]!.todos! == (3, 3))
    }

    func testGroupsFallBackToUngrouped() {
        let d = directory()
        XCTAssertEqual(d.groups.map(\.title), ["未分组"])
        XCTAssertEqual(d.groups[0].sessions.first?.title, "重构存储层，拆出同步队列", "newest first")
    }

    func testWorkspacesPinsAndArchive() {
        var d = directory()
        let review = id(d, "梳理"), api = id(d, "解释")
        d.receiveWorkspace(.object(["type": .string("baseline"), "value": .object([
            "items": .array([.object(["workspaceId": .string("w1"), "path": .string("C:\\Users\\demo\\Projects\\lumen-notes"), "title": .string("")])]),
            "archivedSessionIds": .array([.string(api)]), "pinnedSessionIds": .array([.string(review)])])]))
        XCTAssertEqual(d.groups.map(\.title), ["lumen-notes"])
        XCTAssertEqual(d.groups[0].sessions.first?.id, review, "pinned first")
        XCTAssertFalse(d.visible.contains { $0.id == api }, "archived rows are hidden")
    }

    func testDurableMembershipAndOrderDoNotDependOnCurrentDirectory() {
        var d = directory()
        let first = id(d, "梳理"), second = id(d, "重构"), pinned = id(d, "解释")
        let remote: JSON = .object([
            "workspaceId": .string("w2"), "path": .string("/different/working/directory"),
            "title": .string("Work"), "sessionIds": .array([.string(first), .string(second), .string(pinned)])
        ])
        d.receiveWorkspace(.object(["type": .string("baseline"), "value": .object([
            "items": .array([remote]), "pinnedSessionIds": .array([.string(pinned)])
        ])]))
        XCTAssertEqual(d.manualSessionOrder(in: "w2"), [first, second, pinned])
        XCTAssertEqual(d.groups.first?.sessions.map(\.id), [pinned, first, second])
        d.receiveWorkspace(.object(["type": .string("upsert"), "workspace": .object(
            remote.object.merging(["sessionIds": .array([.string(second), .string(first), .string(pinned)])]) { _, new in new }
        )]))
        XCTAssertEqual(d.groups.first?.sessions.map(\.id), [pinned, second, first])
    }

    func testLiveEventsUpdateTheList() {
        var d = directory()
        let slow = id(d, "重构")
        d.receiveEvent(.object(["type": .string("emit"), "event": .string("api-session/status"), "args": .array([.string(slow), .bool(false)])]))
        XCTAssertEqual(d.status(of: slow), .completed, "finished while not viewed")
        d.markViewed(slow)
        XCTAssertEqual(d.status(of: slow), .idle)
        let ask = id(d, "撰写")
        let eventId = d.pending(for: ask)[0].id
        d.receiveEvent(.object(["type": .string("cancel"), "eventId": .string(eventId)]))
        XCTAssertEqual(d.status(of: ask), .running)
        // 0.2.1 sends one projection key per frame; later builds batch them.
        d.receiveControl(.object(["type": .string("projection"), "sessionId": .string(slow), "key": .string("title"), "value": .string("新标题"), "seq": .number(999)]))
        XCTAssertEqual(d.rows[slow]?.title, "新标题")
        d.receiveControl(.object(["type": .string("projection"), "sessionId": .string(slow), "seq": .number(1000),
                                  "changes": .array([.object(["key": .string("title"), "val": .string("批量标题")])])]))
        XCTAssertEqual(d.rows[slow]?.title, "批量标题")
        d.receiveControl(.object(["type": .string("projection"), "sessionId": .string(slow), "key": .string("title"), "value": .string("旧的"), "seq": .number(5)]))
        XCTAssertEqual(d.rows[slow]?.title, "批量标题", "older changes are ignored")
    }

    func testTodoDockProgress() {
        let d = directory()
        let slow = d.rows[id(d, "重构")]!
        XCTAssertEqual(slow.todoProgress, "1 进行中 · 3 待处理")
        XCTAssertEqual(slow.todoItems.first?.label, "进行中")
        XCTAssertEqual(d.rows[id(d, "梳理")]!.todoProgress, "3 已完成")
        XCTAssertNil(d.rows[id(d, "解释")]!.todoProgress)
    }

    func testRetryKeepsTheFailureReason() {
        let (_, turns) = ConversationTests.session("把 main")
        guard case .retry(let retry)? = turns[0].elements.first(where: { if case .retry = $0 { return true }; return false }) else { return XCTFail() }
        XCTAssertTrue(retry.failure.hasPrefix("503"), retry.failure)
        XCTAssertEqual(retry.status(settled: true), "已重试模型请求（5/5） · 8s")
    }
}
