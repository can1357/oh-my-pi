import Foundation
import FoundationModels

/// Tiny-title sidecar for Apple SystemLanguageModel.
/// Speaks one JSON object on stdout.
///
/// status -> {available, reason?, contextSize?}
/// complete <- stdin JSON {instructions?, prompt, maxTokens?} or raw text
///         -> {text} | {error, reason}
///
/// Compiles against the macOS 26 SDK. The OS picks Advanced when it has it.

@main
struct OmpAppleFmTiny {
	static func main() async {
		let command = CommandLine.arguments.dropFirst().first ?? "status"
		do {
			switch command {
			case "status":
				try printStatus()
			case "complete":
				try await printComplete()
			default:
				try printJSON(["error": "usage", "reason": "expected status|complete"])
				exit(2)
			}
		} catch {
			try? printJSON(["error": "apple_fm_failed", "reason": error.localizedDescription])
			exit(1)
		}
	}
}

private struct Request {
	var instructions: String
	var prompt: String
	var maxTokens: Int?
}

private func readRequest() -> Request {
	let data = FileHandle.standardInput.readDataToEndOfFile()
	let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
	if raw.isEmpty {
		return Request(instructions: "", prompt: "", maxTokens: nil)
	}
	if let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] {
		return Request(
			instructions: object["instructions"] as? String ?? "",
			prompt: object["prompt"] as? String ?? raw,
			maxTokens: intValue(object["maxTokens"]),
		)
	}
	return Request(instructions: "", prompt: raw, maxTokens: nil)
}

private func intValue(_ value: Any?) -> Int? {
	if let number = value as? Int, number > 0 { return number }
	if let number = value as? NSNumber, number.intValue > 0 { return number.intValue }
	return nil
}

private func printJSON(_ object: [String: Any]) throws {
	let data = try JSONSerialization.data(withJSONObject: object, options: [])
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write(Data("\n".utf8))
}

@available(macOS 26.0, *)
private func unavailableReasonName(
	_ reason: SystemLanguageModel.Availability.UnavailableReason,
) -> String {
	switch reason {
	case .deviceNotEligible:
		return "deviceNotEligible"
	case .appleIntelligenceNotEnabled:
		return "appleIntelligenceNotEnabled"
	case .modelNotReady:
		return "modelNotReady"
	@unknown default:
		return "unavailable"
	}
}

private func printStatus() throws {
	guard #available(macOS 26.0, *) else {
		try printJSON(["available": false, "reason": "unsupported_os"])
		return
	}
	let model = SystemLanguageModel.default
	switch model.availability {
	case .available:
		try printJSON(["available": true, "contextSize": model.contextSize])
	case .unavailable(let reason):
		try printJSON(["available": false, "reason": unavailableReasonName(reason)])
	}
}

@available(macOS 26.0, *)
private func requireReadyModel() throws -> SystemLanguageModel {
	let model = SystemLanguageModel.default
	guard model.isAvailable else {
		if case .unavailable(let reason) = model.availability {
			try printJSON(["error": "apple_fm_failed", "reason": unavailableReasonName(reason)])
			exit(1)
		}
		try printJSON(["error": "apple_fm_failed", "reason": "unavailable"])
		exit(1)
	}
	return model
}

private func printComplete() async throws {
	guard #available(macOS 26.0, *) else {
		try printJSON(["error": "apple_fm_failed", "reason": "unsupported_os"])
		exit(1)
	}
	let model = try requireReadyModel()
	let request = readRequest()
	let session: LanguageModelSession
	if request.instructions.isEmpty {
		session = LanguageModelSession(model: model)
	} else {
		session = LanguageModelSession(model: model, tools: [], instructions: request.instructions)
	}
	let content: String
	if let maxTokens = request.maxTokens {
		let response = try await session.respond(
			to: request.prompt,
			options: GenerationOptions(maximumResponseTokens: maxTokens),
		)
		content = stringContent(response.content)
	} else {
		let response = try await session.respond(to: request.prompt)
		content = stringContent(response.content)
	}
	try printJSON(["text": content])
}

private func stringContent(_ value: some Any) -> String {
	if let text = value as? String {
		return text
	}
	return String(describing: value)
}
