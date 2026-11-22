import Foundation

/// Model choices are routes from the connected desktop, including its reasoning controls.
public struct ModelOption: Identifiable, Equatable, Sendable {
    public struct Effort: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
    }

    public let provider: String
    public let providerName: String
    public let model: String
    public let name: String
    public let efforts: [Effort]
    public let defaultEffort: String?
    public var id: [String] { [provider, model] }

    public static func catalog(_ value: JSON) -> [ModelOption] {
        value["groups"].array.flatMap { group -> [ModelOption] in
            let provider = group["id"].string
            guard !provider.isEmpty else { return [] }
            let label = group["name"].string
            return group["models"].array.compactMap { item in
                let id = item["id"].string
                guard !id.isEmpty else { return nil }
                let name = item["name"].string
                let reasoning = item["reasoning"]
                let efforts: [Effort] = reasoning["efforts"].array.compactMap {
                    let id = $0["id"].string
                    return id.isEmpty ? nil : Effort(id: id, name: $0["name"].string.isEmpty ? id : $0["name"].string)
                }
                let preferred = reasoning["defaultEffort"].string
                return ModelOption(provider: provider, providerName: label.isEmpty ? provider : label, model: id,
                                   name: name.isEmpty ? id : name, efforts: efforts,
                                   defaultEffort: preferred.isEmpty ? nil : preferred)
            }
        }
    }

    public func selection(sessionID: String, effort: String? = nil) -> [String: JSON] {
        var fields: [String: JSON] = ["sessionId": .string(sessionID), "provider": .string(provider), "model": .string(model)]
        if let effort { fields["reasoningEffort"] = .string(effort) }
        return fields
    }
}

public enum ActionPayload {
    public static func request(_ fields: [String: JSON]) -> JSON {
        .object(["request": .object(fields)])
    }

    public static func prompt(sessionID: String, requestID: String, text: String, extraContent: [JSON] = [],
                              steer: Bool = false, timeZone: String) -> JSON {
        var content: [JSON] = []
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            content.append(.object(["type": .string("text"), "text": .string(text)]))
        }
        content += extraContent
        return request(["sessionId": .string(sessionID), "requestId": .string(requestID), "content": .array(content),
                        "mode": .string(steer ? "steer" : "queue"), "clientTimeZone": .string(timeZone)])
    }

    public static func eventResult(clientID: String, eventID: String, value: JSON) -> JSON {
        .object(["clientId": .string(clientID), "eventId": .string(eventID),
                 "outcome": .object(["kind": .string("result"), "value": value])])
    }

    public static func answers(_ items: [QuestionAnswer]) -> JSON {
        .object(["answers": .array(items.map(\.json))])
    }
}

public struct QueuedInput: Identifiable, Equatable, Sendable {
    public let id: String
    public let content: [JSON]
    public let source: JSON
    public let steering: Bool
    public var text: String { content.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined(separator: "\n") }
    public var textOnly: Bool { !content.isEmpty && content.allSatisfy { $0["type"].string == "text" } }
}

public extension SessionRow {
    var queuedInputs: [QueuedInput] {
        let inbox = projection["inbox"]
        return ["next-step", "next-turn"].flatMap { key in
            inbox[key].array.compactMap { item -> QueuedInput? in
                let id = item["id"].string
                guard !id.isEmpty, ["user", "user-question-reply"].contains(item["source"]["kind"].string) else { return nil }
                return QueuedInput(id: id, content: item["content"].array, source: item["source"], steering: key == "next-step")
            }
        }
    }
}

public struct QuestionAnswer: Sendable, Equatable {
    public let id: String
    public var selected: [String]
    public var custom: String

    public init(id: String, selected: [String] = [], custom: String = "") {
        self.id = id; self.selected = selected; self.custom = custom
    }

    var json: JSON {
        var fields: [String: JSON] = ["id": .string(id), "selected": .array(selected.map(JSON.string))]
        let text = custom.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { fields["custom"] = .string(text) }
        return .object(fields)
    }
}
