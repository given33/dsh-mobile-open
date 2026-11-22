import Foundation
import XCTest
@testable import DSHCore

final class ActionTests: XCTestCase {
    func testModelCatalogPreservesProviderRoutesAndOptionalReasoning() throws {
        let catalog = try JSON.parse(Data("""
        {"groups":[
          {"id":"work","name":"工作模型","models":[{"id":"deepseek","name":"DeepSeek","reasoning":{"efforts":[{"id":"high","name":"高"}]}}]},
          {"id":"personal","models":[{"id":"deepseek"}]}
        ]}
        """.utf8))
        let options = ModelOption.catalog(catalog)
        XCTAssertEqual(options.map(\.id), [["work", "deepseek"], ["personal", "deepseek"]])
        XCTAssertEqual(options.first?.efforts.first?.name, "高")
        XCTAssertEqual(options.first?.selection(sessionID: "s1", effort: "high")["reasoningEffort"], .string("high"))
        XCTAssertNil(options.last?.selection(sessionID: "s1")["reasoningEffort"])
    }

    func testPromptKeepsFileReceiptAndSteeringMode() {
        let attachment = JSON.object(["type": .string("file"), "receiptId": .string("receipt-1")])
        let args = ActionPayload.prompt(sessionID: "s1", requestID: "request-1", text: "继续", extraContent: [attachment],
                                        steer: true, timeZone: "Asia/Shanghai")
        XCTAssertEqual(args["request"]["sessionId"], .string("s1"))
        XCTAssertEqual(args["request"]["requestId"], .string("request-1"))
        XCTAssertEqual(args["request"]["mode"], .string("steer"))
        XCTAssertEqual(args["request"]["content"].array, [.object(["type": .string("text"), "text": .string("继续")]), attachment])
    }

    func testPlanUsesOrdinaryQuestionResultAndEventCorrelation() throws {
        let frame = try JSON.parse(Data("""
        {"type":"waterfall","event":"user-questions/request","eventId":"e","agentId":"s1","request":{
          "questions":[{"id":"review","question":"Review?","intent":{"kind":"plan-review","approve":"继续"}}]
        }}
        """.utf8))
        let pending = try XCTUnwrap(PendingInteraction(frame))
        XCTAssertEqual(pending.kind, .planReview)
        let value = ActionPayload.answers([QuestionAnswer(id: "review", selected: ["继续"])])
        let args = ActionPayload.eventResult(clientID: "client-1", eventID: pending.id, value: value)
        XCTAssertEqual(args["clientId"], .string("client-1"))
        XCTAssertEqual(args["eventId"], .string("e"))
        XCTAssertEqual(args["outcome"]["value"]["answers"].array.first?["selected"], .array([.string("继续")]))
    }
}
