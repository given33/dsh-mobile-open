import XCTest
@testable import DSHCore

final class ProtocolTests: XCTestCase {
    func json(_ text: String) throws -> JSON { try JSON.parse(Data(text.utf8)) }
    func testJSONRoundTripPreservesUnknownFields() throws {
        let value = try json(#"{"plugin":{"enabled":true,"rows":[1,null,"x"]}}"#)
        XCTAssertEqual(try JSON.parse(value.encoded()), value)
    }
    func testOldProjectionCannotOverwriteNewState() throws {
        var row = SessionRow(try json(#"{"sessionId":"s","projections":{"asOfSeq":20,"values":{"title":"new"}}}"#))
        row.baseline(try json(#"{"asOfSeq":19,"values":{"title":"old"}}"#))
        row.patch(try json(#"{"seq":21,"changes":[{"key":"goal","val":{"status":"active"}}]}"#))
        XCTAssertEqual(row.title, "new"); XCTAssertEqual(row.projection["goal"]["status"].string, "active")
    }
    func testSnapshotReplacesAndHistoryDeduplicates() throws {
        var state = Transcript()
        let snapshot = try json(#"{"type":"snapshot","cursor":3,"records":[{"type":"event","event":{"seq":3,"type":"turn/end"}}],"hasMore":true}"#)
        state.receive(snapshot); state.receive(snapshot)
        state.merge(try json(#"[{"type":"event","event":{"seq":1,"type":"turn/start"}},{"type":"event","event":{"seq":3,"type":"turn/end"}}]"#).array)
        XCTAssertEqual(state.events.map(\.id), [1, 3]); XCTAssertEqual(state.cursor, 3)
        state.receive(snapshot); XCTAssertEqual(state.events.map(\.id), [3])
    }
    func testStreamSettlementRetiresPreview() throws {
        var state = Transcript()
        state.receive(try json(#"{"type":"assistant-stream","frame":{"type":"start","attemptId":"a","revision":1,"turn":1,"step":1,"startedAfterSeq":0}}"#))
        state.receive(try json(#"{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":2,"index":0,"chunk":{"type":"text-delta","index":0,"text":"你好"}}}"#))
        XCTAssertEqual(state.liveBlocks.first?["text"].string, "你好")
        state.receive(try json(#"{"type":"event","event":{"seq":1,"type":"assistant/message","data":{"turn":1,"step":1,"message":{"content":[{"type":"text","text":"你好"}]}}}}"#))
        XCTAssertTrue(state.liveBlocks.isEmpty); XCTAssertEqual(state.events.count, 1)
    }
    func testReconnectRestoresLivePrefix() throws {
        var state = Transcript()
        state.receive(try json(#"{"type":"snapshot","cursor":2,"records":[],"assistantStream":{"revision":7,"activeAttempt":{"attemptId":"a","turn":1,"step":1,"startedAfterSeq":2,"nextIndex":2,"stream":[{"type":"text-chunks","index":0,"texts":["你","好"]}]}}}"#))
        state.receive(try json(#"{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":8,"index":2,"chunk":{"type":"text-delta","index":0,"text":"！"}}}"#))
        XCTAssertEqual(state.liveBlocks.first?["text"].string, "你好！")
    }
    func testMissingFrameRequestsResync() throws {
        var state = Transcript()
        state.receive(try json(#"{"type":"assistant-stream","frame":{"type":"start","attemptId":"a","revision":1}}"#))
        state.receive(try json(#"{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":3,"index":1,"chunk":{"type":"text-delta","text":"lost"}}}"#))
        XCTAssertNotNil(state.fault); XCTAssertTrue(state.liveBlocks.isEmpty)
    }
}
