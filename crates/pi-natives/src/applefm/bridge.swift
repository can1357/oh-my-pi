// Apple Foundation Models bridge for omp, linked into the pi-natives addon.
//
// Drives the on-device system language model through the stateless
// `LanguageModelExecutor` API (macOS 27+): every generation request carries the
// full transcript (instructions + tool definitions, prompts, responses, tool
// calls, tool outputs) and streams exactly one model turn back. Tool calls are
// surfaced to the caller instead of being executed, so omp's agent loop owns
// tool execution and resumes by sending the tool outputs in the next request.
//
// C ABI (declared in `mod.rs`):
//   char *omp_applefm_availability(void);                  // JSON, free with omp_applefm_free
//   void  omp_applefm_generate(uint64_t handle, const char *request_json,
//                              void *context, omp_applefm_emit emit);
//   typedef void (*omp_applefm_emit)(void *context, const char *event_json, bool final);
//   void  omp_applefm_cancel(uint64_t handle);
//   void  omp_applefm_free(char *);
//
// `emit` runs on arbitrary threads, strictly sequentially per request. Events:
// text · reasoning · toolCall · usage, then exactly one terminal `done` or
// `error` delivered with `final = true`, after which `context` is never used
// again.
//
// The executor streams opaque `LanguageModelExecutorGenerationChannel.Event`
// values whose discriminators are internal enums; they are decoded through
// `Mirror` while every payload is cast back to its public type.
//
// The library targets the addon's minimum macOS; everything touching
// FoundationModels is gated on macOS 27 and the framework is weak-linked.

import CoreGraphics
import Foundation
import FoundationModels
import ImageIO

// MARK: - Wire types

struct Part: Decodable {
	var type: String
	var text: String?
	var data: String?
	/// Attachment label the model can use to refer to an image.
	var label: String?
}

struct WireToolCall: Decodable {
	var id: String
	var name: String
	var arguments: String
}

struct Entry: Decodable {
	var kind: String
	var parts: [Part]?
	var calls: [WireToolCall]?
	var id: String?
	var name: String?
}

struct WireTool: Decodable {
	var name: String
	var description: String
	var parameters: String
}

struct Request: Decodable {
	var instructions: String?
	var entries: [Entry]?
	var tools: [WireTool]?
	var temperature: Double?
	var maxTokens: Int?
	var toolChoice: String?
	/// `greedy`, or random sampling bounded by `topK` / `topP`.
	var greedy: Bool?
	var topK: Int?
	var topP: Double?
	/// `light` · `moderate` · `deep`; ignored by models without reasoning.
	var reasoningLevel: String?
}

struct Event: Encodable {
	var type: String
	var text: String?
	var callId: String?
	var name: String?
	var arguments: String?
	var code: String?
	var message: String?
	var input: Int?
	var cachedInput: Int?
	var output: Int?
	var reasoning: Int?
	var available: Bool?
	var reason: String?
	var contextSize: Int?
	var variant: String?
	var vision: Bool?
	var toolCalling: Bool?
	var reasoningCapable: Bool?

	init(_ type: String) {
		self.type = type
	}

	static func failure(_ error: BridgeError) -> Event {
		var event = Event("error")
		event.code = error.code
		event.message = error.message
		return event
	}

	var json: String {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.withoutEscapingSlashes]
		guard let data = try? encoder.encode(self) else { return #"{"type":"error","code":"runtime"}"# }
		return String(decoding: data, as: UTF8.self)
	}
}

struct BridgeError: Error {
	var code: String
	var message: String
}

public typealias EmitFunction = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>, Bool) -> Void

/// The caller's event sink for one request.
struct Emitter: @unchecked Sendable {
	// SAFETY: `context` is owned by the Rust caller until the terminal event and
	// is only passed back to `function`, which the caller made thread-safe.
	let context: UnsafeMutableRawPointer?
	let function: EmitFunction

	func callAsFunction(_ event: Event) {
		let final = event.type == "done" || event.type == "error"
		event.json.withCString { function(context, $0, final) }
	}
}

// MARK: - Scheduling

/// FIFO gate: the on-device model serves one generation at a time.
actor Gate {
	private var busy = false
	private var waiters: [CheckedContinuation<Void, Never>] = []

	func acquire() async {
		if !busy {
			busy = true
			return
		}
		await withCheckedContinuation { waiters.append($0) }
	}

	func release() {
		if waiters.isEmpty {
			busy = false
		} else {
			waiters.removeFirst().resume()
		}
	}
}

/// In-flight requests by caller-assigned handle, for cancellation.
actor Registry {
	private var tasks: [UInt64: Task<Void, Never>] = [:]
	/// Handles cancelled before their task was registered.
	private var cancelled: Set<UInt64> = []

	func start(_ handle: UInt64, _ operation: @escaping @Sendable () async -> Void) {
		let task = Task {
			await operation()
			self.remove(handle)
		}
		if cancelled.remove(handle) != nil { task.cancel() }
		tasks[handle] = task
	}

	func cancel(_ handle: UInt64) {
		if let task = tasks[handle] {
			task.cancel()
		} else {
			cancelled.insert(handle)
		}
	}

	private func remove(_ handle: UInt64) { tasks[handle] = nil }
}

let gate = Gate()
let registry = Registry()

// MARK: - Availability

@available(macOS 27, *)
func availability() -> Event {
	var event = Event("availability")
	let model = SystemLanguageModel.default
	switch model.availability {
	case .available:
		event.available = true
	case .unavailable(let reason):
		event.available = false
		switch reason {
		case .deviceNotEligible: event.reason = "device_not_eligible"
		case .appleIntelligenceNotEnabled: event.reason = "apple_intelligence_not_enabled"
		case .modelNotReady: event.reason = "model_not_ready"
		@unknown default: event.reason = "unavailable"
		}
	}
	event.contextSize = model.contextSize
	event.variant = model.variant.displayName
	event.vision = model.capabilities.contains(.vision)
	event.toolCalling = model.capabilities.contains(.toolCalling)
	event.reasoningCapable = model.capabilities.contains(.reasoning)
	return event
}

// MARK: - Transcript lowering

func image(_ base64: String) throws -> CGImage {
	guard let data = Data(base64Encoded: base64),
		let source = CGImageSourceCreateWithData(data as CFData, nil),
		let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
	else {
		throw BridgeError(code: "invalid_request", message: "image attachment could not be decoded")
	}
	return image
}

@available(macOS 27, *)
func segments(_ parts: [Part]?) throws -> [Transcript.Segment] {
	try (parts ?? []).map { part in
		switch part.type {
		case "text":
			return .text(Transcript.TextSegment(content: part.text ?? ""))
		case "image":
			let attachment = Transcript.ImageAttachment(try image(part.data ?? ""))
			return .attachment(Transcript.AttachmentSegment(content: .image(attachment), label: part.label))
		default:
			throw BridgeError(code: "invalid_request", message: "unknown part type '\(part.type)'")
		}
	}
}

@available(macOS 27, *)
func toolDefinitions(_ tools: [WireTool]) throws -> [Transcript.ToolDefinition] {
	try tools.map { tool in
		do {
			let schema = try JSONDecoder().decode(GenerationSchema.self, from: Data(tool.parameters.utf8))
			return Transcript.ToolDefinition(name: tool.name, description: tool.description, parameters: schema)
		} catch {
			throw BridgeError(code: "invalid_tool_schema", message: "tool '\(tool.name)': \(error)")
		}
	}
}

@available(macOS 27, *)
func transcript(_ request: Request, tools: [Transcript.ToolDefinition]) throws -> Transcript {
	var entries: [Transcript.Entry] = []
	if request.instructions != nil || !tools.isEmpty {
		let text = request.instructions.map { [Transcript.Segment.text(.init(content: $0))] } ?? []
		entries.append(.instructions(.init(segments: text, toolDefinitions: tools)))
	}
	for entry in request.entries ?? [] {
		switch entry.kind {
		case "prompt":
			entries.append(.prompt(.init(segments: try segments(entry.parts))))
		case "response":
			entries.append(.response(.init(segments: try segments(entry.parts))))
		case "toolCalls":
			let calls = try (entry.calls ?? []).map { call in
				do {
					return Transcript.ToolCall(
						id: call.id, toolName: call.name, arguments: try GeneratedContent(json: call.arguments))
				} catch {
					throw BridgeError(code: "invalid_request", message: "tool call '\(call.id)' arguments: \(error)")
				}
			}
			entries.append(.toolCalls(.init(calls)))
		case "toolOutput":
			entries.append(
				.toolOutput(.init(id: entry.id ?? "", toolName: entry.name ?? "", segments: try segments(entry.parts))))
		default:
			throw BridgeError(code: "invalid_request", message: "unknown entry kind '\(entry.kind)'")
		}
	}
	return Transcript(entries: entries)
}

@available(macOS 27, *)
func samplingMode(_ request: Request) -> GenerationOptions.SamplingMode? {
	if request.greedy == true { return .greedy }
	if let k = request.topK { return .random(top: k) }
	if let p = request.topP { return .random(probabilityThreshold: p) }
	return nil
}

/// Models without the reasoning capability (the on-device model) leak raw
/// chain-of-thought into the response when asked to reason, so the level is
/// only forwarded to models that advertise it.
@available(macOS 27, *)
func reasoningLevel(_ level: String?, model: SystemLanguageModel) -> ContextOptions.ReasoningLevel? {
	guard model.capabilities.contains(.reasoning) else { return nil }
	switch level {
	case "light": return .light
	case "moderate": return .moderate
	case "deep": return .deep
	default: return nil
	}
}

@available(macOS 27, *)
func toolCallingMode(_ choice: String?) -> GenerationOptions.ToolCallingMode? {
	switch choice {
	case "none": .disallowed
	case "required": .required
	case "auto": .allowed
	default: nil
	}
}

// MARK: - Channel decoding

/// Returns the active case label and payload of an opaque `{ kind: enum }` wrapper.
func variant(_ value: Any) -> (label: String, payload: Any)? {
	guard let kind = Mirror(reflecting: value).children.first(where: { $0.label == "kind" })?.value,
		let child = Mirror(reflecting: kind).children.first,
		let label = child.label
	else { return nil }
	return (label, child.value)
}

@available(macOS 27, *)
typealias Channel = LanguageModelExecutorGenerationChannel

/// Converts executor channel events into wire events for one request.
@available(macOS 27, *)
struct ChannelDecoder {
	/// Text already emitted per `entryID/segmentID`, so segment replacements can
	/// be reduced to appended suffixes.
	var emitted: [String: String] = [:]

	mutating func decode(_ event: Channel.Event) -> [Event] {
		guard let (label, payload) = variant(event) else {
			log("unrecognized channel event")
			return []
		}
		switch (label, payload) {
		case ("response", let response as Channel.Response):
			return action(response.action, entry: response.entryID, type: "text")
		case ("reasoning", let reasoning as Channel.Reasoning):
			return action(reasoning.action, entry: reasoning.entryID, type: "reasoning")
		case ("toolCalls", let calls as Channel.ToolCalls):
			return toolCalls(calls.action)
		default:
			log("unhandled channel event '\(label)'")
			return []
		}
	}

	private mutating func action(_ action: Any, entry: String?, type: String) -> [Event] {
		guard let (label, payload) = variant(action) else { return [] }
		switch payload {
		case let fragment as Channel.TextFragment:
			return text(type, key: "\(entry ?? "")/\(fragment.segmentID ?? "")", append: fragment.content)
		case let replacement as Channel.TextSegmentReplacement:
			let key = "\(entry ?? "")/\(replacement.segmentID ?? "")"
			let previous = emitted[key] ?? ""
			guard replacement.content.hasPrefix(previous) else {
				log("dropped non-append replacement of segment \(key)")
				emitted[key] = replacement.content
				return []
			}
			return text(type, key: key, append: String(replacement.content.dropFirst(previous.count)))
		case let usage as Channel.Usage:
			return [Self.usage(usage)]
		default:
			if label != "updateMetadata" { log("ignored \(type) action '\(label)'") }
			return []
		}
	}

	private mutating func text(_ type: String, key: String, append: String) -> [Event] {
		guard !append.isEmpty else { return [] }
		emitted[key, default: ""] += append
		var event = Event(type)
		event.text = append
		return [event]
	}

	private func toolCalls(_ action: Any) -> [Event] {
		guard let (label, payload) = variant(action) else { return [] }
		switch payload {
		case let call as Channel.ToolCalls.ToolCall:
			var event = Event("toolCall")
			event.callId = call.id
			event.name = call.name
			if let (_, fragment) = variant(call.action),
				let fragment = fragment as? Channel.ToolCalls.ToolCall.ArgumentsFragment
			{
				event.arguments = fragment.content
			}
			return [event]
		case let usage as Channel.Usage:
			return [Self.usage(usage)]
		default:
			if label != "updateMetadata" { log("ignored tool call action '\(label)'") }
			return []
		}
	}

	private static func usage(_ usage: Channel.Usage) -> Event {
		var event = Event("usage")
		event.input = usage.input.totalTokenCount
		event.cachedInput = usage.input.cachedTokenCount
		event.output = usage.output.totalTokenCount
		event.reasoning = usage.output.reasoningTokenCount
		return event
	}
}

// MARK: - Generation

let sentinel = "omp.end"

@available(macOS 27, *)
func generate(_ request: Request, emit: Emitter) async throws {
	let model = SystemLanguageModel.default
	guard case .available = model.availability else {
		throw BridgeError(
			code: "unavailable",
			message: "Apple Foundation Models is not available (\(availability().reason ?? "unknown"))")
	}
	let tools = try toolDefinitions(request.tools ?? [])
	let generation = LanguageModelExecutorGenerationRequest(
		id: UUID(),
		transcript: try transcript(request, tools: tools),
		enabledTools: tools,
		generationOptions: GenerationOptions(
			samplingMode: samplingMode(request),
			temperature: request.temperature,
			maximumResponseTokens: request.maxTokens,
			toolCallingMode: toolCallingMode(request.toolChoice)),
		contextOptions: ContextOptions(reasoningLevel: reasoningLevel(request.reasoningLevel, model: model)),
		metadata: [:])
	let executor = SystemLanguageModel.Executor(configuration: model.executorConfiguration)
	let channel = Channel()
	// The channel never finishes on its own; a sentinel sent after `respond`
	// returns marks the end, and FIFO delivery guarantees every model event
	// precedes it.
	let consumer = Task {
		var decoder = ChannelDecoder()
		do {
			for try await event in channel {
				if let (_, payload) = variant(event), let response = payload as? Channel.Response,
					response.entryID == sentinel
				{
					return
				}
				for wire in decoder.decode(event) { emit(wire) }
			}
		} catch {
			log("channel failed: \(error)")
		}
	}
	var failure: (any Error)?
	do {
		try await executor.respond(to: generation, model: model, streamingInto: channel)
	} catch {
		failure = error
	}
	await channel.send(.response(entryID: sentinel, action: .updateMetadata([:])))
	await consumer.value
	if let failure { throw failure }
}

// MARK: - Errors

@available(macOS 27, *)
func classify(_ error: any Error) -> BridgeError {
	if let error = error as? BridgeError { return error }
	if error is CancellationError { return BridgeError(code: "cancelled", message: "Request was cancelled") }
	if let error = error as? LanguageModelError {
		let message = error.errorDescription ?? String(describing: error)
		switch error {
		case .contextSizeExceeded(let detail):
			return BridgeError(
				code: "context_size_exceeded",
				message:
					"Prompt is too long: \(detail.tokenCount) tokens exceed the \(detail.contextSize) token context window")
		case .rateLimited: return BridgeError(code: "rate_limited", message: message)
		case .guardrailViolation: return BridgeError(code: "guardrail_violation", message: message)
		case .refusal: return BridgeError(code: "refusal", message: message)
		case .unsupportedCapability: return BridgeError(code: "unsupported_capability", message: message)
		case .unsupportedTranscriptContent: return BridgeError(code: "unsupported_transcript_content", message: message)
		case .unsupportedGenerationGuide: return BridgeError(code: "unsupported_generation_guide", message: message)
		case .unsupportedLanguageOrLocale: return BridgeError(code: "unsupported_language", message: message)
		case .timeout: return BridgeError(code: "timeout", message: message)
		@unknown default: return BridgeError(code: "runtime", message: message)
		}
	}
	if let error = error as? SystemLanguageModel.Error {
		return BridgeError(code: "assets_unavailable", message: error.errorDescription ?? String(describing: error))
	}
	if let overflow = find(error as NSError, domain: generativeErrorDomain, code: generativeErrorTooManyTokens) {
		return BridgeError(code: "context_size_exceeded", message: "Prompt is too long: \(overflow.localizedDescription)")
	}
	return BridgeError(code: "runtime", message: describe(error as NSError))
}

/// Oversized transcripts fail inside the executor's tokenizer with this error
/// ("Provided N tokens, but the maximum allowed is M") rather than
/// `LanguageModelError.contextSizeExceeded`.
let generativeErrorDomain = "com.apple.GenerativeFunctionsFoundation.GenerativeError"
let generativeErrorTooManyTokens = 4_050_000

/// Depth-first search of an `NSError` and its underlying errors.
func find(_ error: NSError, domain: String, code: Int) -> NSError? {
	if error.domain == domain && error.code == code { return error }
	let underlying = (error.userInfo[NSMultipleUnderlyingErrorsKey] as? [NSError]) ?? []
	for inner in underlying + [error.userInfo[NSUnderlyingErrorKey] as? NSError].compactMap({ $0 }) {
		if let match = find(inner, domain: domain, code: code) { return match }
	}
	return nil
}

/// Flattens an `NSError` and its underlying chain into one line.
func describe(_ error: NSError) -> String {
	var parts = ["\(error.domain) \(error.code): \(error.localizedDescription)"]
	let underlying = (error.userInfo[NSMultipleUnderlyingErrorsKey] as? [NSError]) ?? []
	for inner in underlying + [error.userInfo[NSUnderlyingErrorKey] as? NSError].compactMap({ $0 }) {
		parts.append(describe(inner))
	}
	return parts.joined(separator: " <- ")
}

func log(_ message: String) {
	FileHandle.standardError.write(Data("omp-applefm: \(message)\n".utf8))
}

let unsupportedOS = BridgeError(code: "unsupported_os", message: "Apple Foundation Models requires macOS 27 or later")

// MARK: - C ABI

@_cdecl("omp_applefm_availability")
public func ompAppleFmAvailability() -> UnsafeMutablePointer<CChar>? {
	var event: Event
	if #available(macOS 27, *) {
		event = availability()
	} else {
		event = Event("availability")
		event.available = false
		event.reason = unsupportedOS.code
	}
	return strdup(event.json)
}

@_cdecl("omp_applefm_generate")
public func ompAppleFmGenerate(
	_ handle: UInt64,
	_ requestJSON: UnsafePointer<CChar>,
	_ context: UnsafeMutableRawPointer?,
	_ function: EmitFunction
) {
	let emit = Emitter(context: context, function: function)
	let request: Request
	do {
		request = try JSONDecoder().decode(Request.self, from: Data(String(cString: requestJSON).utf8))
	} catch {
		emit(.failure(BridgeError(code: "invalid_request", message: "malformed request: \(error)")))
		return
	}
	guard #available(macOS 27, *) else {
		emit(.failure(unsupportedOS))
		return
	}
	Task {
		await registry.start(handle) {
			await gate.acquire()
			do {
				try Task.checkCancellation()
				try await generate(request, emit: emit)
				emit(Event("done"))
			} catch {
				// The executor reports cancellation as an opaque runtime error.
				emit(.failure(Task.isCancelled ? classify(CancellationError()) : classify(error)))
			}
			await gate.release()
		}
	}
}

@_cdecl("omp_applefm_cancel")
public func ompAppleFmCancel(_ handle: UInt64) {
	Task { await registry.cancel(handle) }
}

@_cdecl("omp_applefm_free")
public func ompAppleFmFree(_ pointer: UnsafeMutablePointer<CChar>?) {
	free(pointer)
}
