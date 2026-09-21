import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { encodeResponse, encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import type {
	ToolSearchServerToolUseBlockParam,
	ToolSearchToolResultBlockParam,
	WebSearchServerToolUseBlockParam,
	WebSearchToolResultBlockParam,
} from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	queueMicrotask(() => {
		for (const ev of events) s.push(ev);
		s.end();
	});
	return s;
}

interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const out: SseEvent[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	for (const chunk of buf.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) dataLine = line.slice(6);
		}
		out.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
	}
	return out;
}

describe("anthropic-messages parseRequest", () => {
	it("parses system + user + assistant(thinking,text,tool_use) + tool_result", () => {
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 1024,
			temperature: 0.2,
			top_p: 0.9,
			stop_sequences: ["\n\n"],
			tool_choice: { type: "any" },
			thinking: { type: "enabled", budget_tokens: 2048 },
			output_config: { task_budget: { type: "tokens", total: 64_000, remaining: 60_000 } },
			system: [
				{ type: "text", text: "You are X" },
				{ type: "text", text: "Be brief." },
			],
			tools: [
				{
					name: "lookup",
					description: "find a thing",
					input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
				},
			],
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm", signature: "sig-1" },
						{ type: "redacted_thinking", data: "REDACTED" },
						{ type: "text", text: "calling tool" },
						{ type: "tool_use", id: "toolu_abc", name: "lookup", input: { q: "x" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_abc",
							content: [{ type: "text", text: "result text" }],
							is_error: false,
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_def",
							content: "string body",
							is_error: true,
						},
						{ type: "text", text: "and another result coming" },
					],
				},
			],
		});

		expect(parsed.modelId).toBe("claude-opus-4-7");
		expect(parsed.stream).toBe(false);
		expect(parsed.context.systemPrompt).toEqual(["You are X\n\nBe brief."]);
		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.2);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.explicitThinkingBudgetTokens).toBe(2048);
		expect(parsed.options.taskBudget).toEqual({ type: "tokens", total: 64_000, remaining: 60_000 });
		expect(parsed.options.extra).toBeUndefined();

		expect(parsed.context.tools).toHaveLength(1);
		const tool = parsed.context.tools![0]!;
		expect(tool.name).toBe("lookup");
		expect(tool.description).toBe("find a thing");
		expect(tool.parameters).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});

		// messages: user("hi"), assistant(4 blocks), toolResult(toolu_abc),
		// toolResult(toolu_def), user("and another result coming")
		const msgs = parsed.context.messages;
		expect(msgs).toHaveLength(5);

		expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });

		const asst = msgs[1];
		expect(asst.role).toBe("assistant");
		if (asst.role !== "assistant") throw new Error();
		expect(asst.content).toEqual([
			{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-1" },
			{ type: "redactedThinking", data: "REDACTED" },
			{ type: "text", text: "calling tool" },
			{ type: "toolCall", id: "toolu_abc", name: "lookup", arguments: { q: "x" } },
		]);
		expect(asst.api).toBe("anthropic-messages");
		expect(asst.provider).toBe("anthropic");
		expect(asst.model).toBe("claude-opus-4-7");

		const tr1 = msgs[2] as ToolResultMessage;
		expect(tr1.role).toBe("toolResult");
		expect(tr1.toolCallId).toBe("toolu_abc");
		expect(tr1.isError).toBe(false);
		expect(tr1.content).toEqual([{ type: "text", text: "result text" }]);

		const tr2 = msgs[3] as ToolResultMessage;
		expect(tr2.role).toBe("toolResult");
		expect(tr2.toolCallId).toBe("toolu_def");
		expect(tr2.isError).toBe(true);
		expect(tr2.content).toEqual([{ type: "text", text: "string body" }]);

		expect(msgs[4]).toMatchObject({ role: "user", content: "and another result coming" });
	});

	it("preserves thinking binding and mid-conversation controls", () => {
		const parsed = parseRequest({
			model: "claude-fable-5-1",
			max_tokens: 1024,
			thinking: {
				type: "adaptive",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			},
			tools: [
				{
					name: "lookup",
					description: "find a thing",
					input_schema: { type: "object", properties: {} },
					defer_loading: true,
				},
			],
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "system",
					clear_at: "next_user_message",
					output_config: { effort: "low" },
					content: [
						{ type: "text", text: "Use fewer tokens." },
						{
							type: "tool_addition",
							tool: { type: "tool_reference", name: "lookup" },
						},
					],
				},
			],
		});

		expect(parsed.options.anthropicPrefixMismatchBehavior).toBe("drop_block");
		expect(parsed.context.tools?.[0]?.deferLoading).toBe(true);
		const system = parsed.context.messages[1];
		if (system?.role !== "developer") throw new Error("expected developer message");
		expect(system.content).toEqual([{ type: "text", text: "Use fewer tokens." }]);
		expect(system.providerPayload).toEqual({
			type: "anthropicMessage",
			clearAt: "next_user_message",
			effort: "low",
			toolChanges: [{ type: "tool_addition", name: "lookup" }],
		});
	});

	it("maps tool_choice variants and suppresses user wrappers that hold only tool_result", () => {
		const auto = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "auto" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(auto.options.toolChoice).toBe("auto");

		const named = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "tool", name: "lookup" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(named.options.toolChoice).toEqual({ name: "lookup" });

		const onlyResult = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
				},
			],
		});
		// no user wrapper, just the toolResult
		expect(onlyResult.context.messages).toHaveLength(1);
		expect(onlyResult.context.messages[0]!.role).toBe("toolResult");
	});

	it("splits user text/image blocks into a separate UserMessage before a tool_result", () => {
		const parsed = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "preface text" },
						{ type: "tool_result", tool_use_id: "t1", content: "ok" },
					],
				},
			],
		});
		// Expect a flush before the tool result: user("preface text") then toolResult(t1).
		expect(parsed.context.messages).toHaveLength(2);
		expect(parsed.context.messages[0]).toMatchObject({ role: "user", content: "preface text" });
		expect(parsed.context.messages[1]!.role).toBe("toolResult");
	});

	it("maps inbound output_config.effort onto options.reasoning 1:1", () => {
		const cases = [
			["low", Effort.Low],
			["medium", Effort.Medium],
			["high", Effort.High],
			["xhigh", Effort.XHigh],
			["max", Effort.Max],
		] as const;
		for (const [wire, effort] of cases) {
			const parsed = parseRequest({
				model: "m",
				max_tokens: 8,
				output_config: { effort: wire },
				messages: [{ role: "user", content: "hi" }],
			});
			expect(parsed.options.reasoning).toBe(effort);
		}

		const absent = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(absent.options.reasoning).toBeUndefined();
	});

	it("rejects missing required fields and unsupported request controls", () => {
		expect(() => parseRequest({})).toThrow(/model/);
		expect(() => parseRequest({ model: "m", messages: [] })).toThrow(/max_tokens/);
		expect(() => parseRequest({ model: "m", max_tokens: 1 })).toThrow(/messages/);
		const topK = parseRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], top_k: 50 });
		expect(topK.options.topK).toBe(50);
		// `metadata` is tolerated permissively and surfaced on options for
		// downstream forwarding (Anthropic clients ship `metadata.user_id`).
		const withMetadata = parseRequest({
			model: "m",
			max_tokens: 1,
			messages: [{ role: "user", content: "hi" }],
			metadata: { user_id: "u_1" },
		});
		expect(withMetadata.options.extra).toBeUndefined();
		expect(withMetadata.options.metadata).toEqual({ user_id: "u_1" });
	});

	it("rejects malformed known-type blocks instead of passing them through the unknown-block catch-all", () => {
		// `{type:"text", text: 123}` fails the typed schema and must not fall
		// into the loose catch-all (would corrupt history and TypeError downstream).
		expect(() =>
			parseRequest({
				model: "m",
				max_tokens: 1,
				messages: [{ role: "user", content: [{ type: "text", text: 123 }] }],
			}),
		).toThrow();
		expect(() =>
			parseRequest({
				model: "m",
				max_tokens: 1,
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: [{ type: "tool_use", id: "", name: "lookup" }] },
				],
			}),
		).toThrow();
		// Genuinely unknown variants are still accepted and flattened.
		const unknown = parseRequest({
			model: "m",
			max_tokens: 1,
			messages: [
				{ role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }] },
			],
		});
		expect(unknown.context.messages).toHaveLength(1);
	});

	it("preserves inbound assistant web-search call/result blocks verbatim", () => {
		const serverToolUse: WebSearchServerToolUseBlockParam = {
			type: "server_tool_use",
			id: "srvtoolu_1",
			name: "web_search",
			input: { query: "weather" },
		};
		const searchResult: WebSearchToolResultBlockParam = {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [
				{
					type: "web_search_result",
					url: "https://example.com/weather",
					title: "Weather",
					encrypted_content: "encrypted-result",
				},
			],
		};
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 8,
			messages: [
				{ role: "user", content: "weather?" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "search", signature: "sig-1" },
						serverToolUse,
						searchResult,
						{ type: "text", text: "forecast ready" },
					],
				},
			],
		});
		const assistant = parsed.context.messages.find(message => message.role === "assistant");
		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "search", thinkingSignature: "sig-1" },
			{ type: "anthropicServerTool", block: serverToolUse },
			{ type: "anthropicServerTool", block: searchResult },
			{ type: "text", text: "forecast ready" },
		]);
	});

	it("preserves inbound assistant tool-search call/result blocks verbatim", () => {
		const serverToolUse: ToolSearchServerToolUseBlockParam = {
			type: "server_tool_use",
			id: "srvtoolu_search",
			name: "tool_search_tool_regex",
			input: { pattern: "read" },
		};
		const searchResult: ToolSearchToolResultBlockParam = {
			type: "tool_search_tool_result",
			tool_use_id: "srvtoolu_search",
			content: {
				type: "tool_search_tool_search_result",
				tool_references: [{ type: "tool_reference", tool_name: "_read" }],
			},
		};
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 8,
			messages: [
				{ role: "user", content: "read notes" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "find read", signature: "sig-1" },
						serverToolUse,
						searchResult,
						{ type: "text", text: "tool loaded" },
					],
				},
			],
		});
		const assistant = parsed.context.messages.find(message => message.role === "assistant");

		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "find read", thinkingSignature: "sig-1" },
			{ type: "anthropicServerTool", block: serverToolUse },
			{ type: "anthropicServerTool", block: searchResult },
			{ type: "text", text: "tool loaded" },
		]);
	});

	it("flattens malformed web-search history blocks instead of preserving invalid replay state", () => {
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 8,
			messages: [
				{ role: "user", content: "weather?" },
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", name: "web_search" },
						{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1" },
						{ type: "web_search_tool_result", content: [] },
					],
				},
			],
		});
		const assistant = parsed.context.messages.find(message => message.role === "assistant");
		expect(assistant?.content).toHaveLength(3);
		expect(assistant?.content.every(block => block.type === "text")).toBe(true);
		expect(assistant?.content.some(block => block.type === "anthropicServerTool")).toBe(false);
	});

	it("does not retain a partial code-execution server-tool history", () => {
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 8,
			messages: [
				{ role: "user", content: "run code" },
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_code",
							name: "bash_code_execution",
							input: { command: "printf ok" },
						},
						{
							type: "bash_code_execution_tool_result",
							tool_use_id: "srvtoolu_code",
							content: {
								type: "bash_code_execution_result",
								stdout: "ok",
								stderr: "",
								return_code: 0,
								content: [],
							},
						},
					],
				},
			],
		});
		const assistant = parsed.context.messages.find(message => message.role === "assistant");
		expect(assistant?.content).toHaveLength(2);
		expect(assistant?.content.every(block => block.type === "text")).toBe(true);
		expect(assistant?.content.some(block => block.type === "anthropicServerTool")).toBe(false);
	});

	it("stamps replayed assistant turns with the dispatched model id, not the wire alias", () => {
		const assistantTurn = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "answer" }],
		};
		const base = { max_tokens: 64, messages: [{ role: "user" as const, content: "hi" }, assistantTurn] };

		const prefixed = parseRequest({ ...base, model: "anthropic/claude-fable-5-1" });
		expect(prefixed.context.messages.find(m => m.role === "assistant")?.model).toBe("claude-fable-5-1");
		expect(prefixed.modelId).toBe("anthropic/claude-fable-5-1");

		const bare = parseRequest({ ...base, model: "claude-fable-5-1" });
		expect(bare.context.messages.find(m => m.role === "assistant")?.model).toBe("claude-fable-5-1");

		// Another provider's prefix does not describe this route, so it stays put.
		const foreign = parseRequest({ ...base, model: "zenmux/claude-opus-4-8" });
		expect(foreign.context.messages.find(m => m.role === "assistant")?.model).toBe("zenmux/claude-opus-4-8");
	});

	it("stamps a tool-calling replayed turn as toolUse", () => {
		const parsed = parseRequest({
			model: "anthropic/claude-fable-5-1",
			max_tokens: 64,
			messages: [
				{ role: "user", content: "check the shards" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "prior reasoning", signature: "sig-1" },
						{ type: "text", text: "checking" },
						{ type: "tool_use", id: "toolu_01", name: "bash", input: { cmd: "check" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "runs=63" }] },
				{ role: "assistant", content: [{ type: "text", text: "every ticker is one run" }] },
				{ role: "user", content: "so is it sorted?" },
			],
		});
		const assistants = parsed.context.messages.filter(message => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0].stopReason).toBe("toolUse");
		expect(assistants[1].stopReason).toBe("stop");

		const model: Model<"anthropic-messages"> = buildModel({
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5-1",
			name: "Claude Fable 5.1",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		});
		const wire = convertAnthropicMessages(parsed.context.messages, model, false);
		const replayed = wire.find(message => message.role === "assistant");
		expect(replayed?.content).toContainEqual({
			type: "thinking",
			thinking: "prior reasoning",
			signature: "sig-1",
		});
		expect(JSON.stringify(replayed?.content)).not.toContain('"text":"prior reasoning"');
	});
});

describe("anthropic-messages encodeResponse", () => {
	it("encodes text + thinking + tool_use with correct ordering and stop_reason mapping", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me think", thinkingSignature: "sig-xyz" },
				{ type: "text", text: "calling tool now" },
				{ type: "toolCall", id: "toolu_999", name: "lookup", arguments: { q: "hello" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 12, output: 34, cacheRead: 5, cacheWrite: 7, totalTokens: 58 },
			stopReason: "toolUse",
			timestamp: 1000,
		};
		const encoded = encodeResponse(message, "claude-opus-4-7");
		expect(encoded.type).toBe("message");
		expect(encoded.role).toBe("assistant");
		expect(encoded.model).toBe("claude-opus-4-7");
		expect(encoded.stop_reason).toBe("tool_use");
		expect(encoded.stop_sequence).toBeNull();
		expect(encoded.usage).toEqual({
			input_tokens: 12,
			output_tokens: 34,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 7,
		});
		expect(encoded.content).toEqual([
			{ type: "thinking", thinking: "let me think", signature: "sig-xyz" },
			{ type: "text", text: "calling tool now" },
			{ type: "tool_use", id: "toolu_999", name: "lookup", input: { q: "hello" } },
		]);
		expect(typeof encoded.id).toBe("string");
		expect((encoded.id as string).startsWith("msg_")).toBe(true);
	});

	it("maps stop reasons and rejects upstream terminal errors", () => {
		const base: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		expect(encodeResponse({ ...base, stopReason: "stop" }, "m").stop_reason).toBe("end_turn");
		expect(encodeResponse({ ...base, stopReason: "length" }, "m").stop_reason).toBe("max_tokens");
		expect(encodeResponse({ ...base, stopReason: "toolUse" }, "m").stop_reason).toBe("tool_use");
		expect(() => encodeResponse({ ...base, stopReason: "error", errorMessage: "upstream failed" }, "m")).toThrow(
			/upstream failed/,
		);
		expect(() => encodeResponse({ ...base, stopReason: "aborted", errorMessage: "request aborted" }, "m")).toThrow(
			/request aborted/,
		);
	});

	it("reports tool_use when a client-executed tool call ends the turn on `stop`", () => {
		// Cursor's exec protocol has no tool-use stop: it hands a tool the
		// caller declared back for the caller to run and then ends the turn,
		// leaving `stopReason: "stop"` with the call unpaired. An Anthropic
		// client runs tools while `stop_reason === "tool_use"`, so `end_turn`
		// here strands the call it was asked to execute.
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Checking the weather." },
				{ type: "toolCall", id: "toolu_handoff", name: "get_weather", arguments: { city: "Paris" } },
			],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const encoded = encodeResponse(message, "cursor/cursor-grok-4.6");
		expect(encoded.stop_reason).toBe("tool_use");
		expect(encoded.content).toContainEqual({
			type: "tool_use",
			id: "toolu_handoff",
			name: "get_weather",
			input: { city: "Paris" },
		});
	});

	it("keeps a Cursor-resolved native call out of the turn and off the wire", () => {
		// Cursor runs `todo` / `web_fetch` / `connect_scm` (and any native the
		// gateway declined) on its own exec channel and stamps the block
		// resolved. The client never declared those tools and the operation is
		// already committed, so reporting `tool_use` would make the canonical
		// loop repeat a side effect and post a result for a tool it does not
		// have.
		const resolved: ToolCall = { type: "toolCall", id: "call_todo", name: "todo", arguments: { todos: [] } };
		(resolved as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const message: AssistantMessage = {
			role: "assistant",
			content: [resolved, { type: "text", text: "Plan updated." }],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const encoded = encodeResponse(message, "cursor/cursor-grok-4.6");
		expect(encoded.stop_reason).toBe("end_turn");
		expect(encoded.content).toEqual([{ type: "text", text: "Plan updated." }]);
	});

	it("still hands back an unresolved call when a resolved one precedes it", () => {
		const resolved: ToolCall = { type: "toolCall", id: "call_todo", name: "todo", arguments: { todos: [] } };
		(resolved as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				resolved,
				{ type: "toolCall", id: "toolu_handoff", name: "get_weather", arguments: { city: "Paris" } },
			],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const encoded = encodeResponse(message, "cursor/cursor-grok-4.6");
		expect(encoded.stop_reason).toBe("tool_use");
		expect(encoded.content).toEqual([
			{ type: "tool_use", id: "toolu_handoff", name: "get_weather", input: { city: "Paris" } },
		]);
	});
});

describe("anthropic-messages encodeStream", () => {
	it("emits thinking_delta + signature_delta + text_delta + tool_use input_json_delta + message_stop", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 11, output: 42, cacheRead: 3, cacheWrite: 5 },
			stopReason: "toolUse",
			timestamp: 0,
		};

		const partialAfterThinkingEnd: AssistantMessage = {
			...finalMessage,
			content: [{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" }],
		};
		const partialAtToolStart: AssistantMessage = {
			...finalMessage,
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: {} },
			],
		};

		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "thinking_start", contentIndex: 0, partial: finalMessage },
			{ type: "thinking_delta", contentIndex: 0, delta: "thoughts", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "thoughts", partial: partialAfterThinkingEnd },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "hi ", partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "there", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "hi there", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 2, partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"x":', partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial: partialAtToolStart },
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
				partial: finalMessage,
			},
			{ type: "done", reason: "toolUse", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));

		// Sequence check
		const types = sse.map(e => e.event);
		expect(types).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta", // signature_delta
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);

		// message_start payload
		const start = sse[0]!.data as {
			type: string;
			message: { id: string; model: string; role: string; usage: Record<string, unknown> };
		};
		expect(start.type).toBe("message_start");
		expect(start.message.model).toBe("claude-opus-4-7");
		expect(start.message.role).toBe("assistant");
		expect(start.message.id.startsWith("msg_")).toBe(true);
		expect(start.message.usage).toEqual({
			input_tokens: 11,
			output_tokens: 42,
			cache_read_input_tokens: 3,
			cache_creation_input_tokens: 5,
		});

		// thinking block_start
		expect(sse[1]!.data).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		});
		expect(sse[2]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "thoughts" },
		});
		expect(sse[3]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "SIG" },
		});
		expect(sse[4]!.data).toEqual({ type: "content_block_stop", index: 0 });

		// text block
		expect(sse[5]!.data).toEqual({
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		});
		expect(sse[6]!.data).toEqual({
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "hi " },
		});

		// tool_use block
		expect(sse[9]!.data).toEqual({
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_1", name: "go", input: {} },
		});
		expect(sse[10]!.data).toEqual({
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: '{"x":' },
		});

		// message_delta with mapped stop_reason
		expect(sse[13]!.data).toEqual({
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: {
				input_tokens: 11,
				output_tokens: 42,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 5,
			},
		});

		expect(sse[14]!.data).toEqual({ type: "message_stop" });
	});

	it("emits persisted server-tool blocks before the next streamed content block", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "search first", thinkingSignature: "SIG" },
				{
					type: "anthropicServerTool",
					block: {
						type: "server_tool_use",
						id: "srvtoolu_1",
						name: "web_search",
						input: { query: "weather" },
					},
				},
				{
					type: "anthropicServerTool",
					block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_1",
						content: [
							{
								type: "web_search_result",
								url: "https://example.com/weather",
								title: "Weather",
								encrypted_content: "encrypted-result",
							},
						],
					},
				},
				{ type: "text", text: "forecast ready" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "thinking_start", contentIndex: 0, partial: finalMessage },
			{ type: "thinking_delta", contentIndex: 0, delta: "search first", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "search first", partial: finalMessage },
			{ type: "text_start", contentIndex: 3, partial: finalMessage },
			{ type: "text_delta", contentIndex: 3, delta: "forecast ready", partial: finalMessage },
			{ type: "text_end", contentIndex: 3, content: "forecast ready", partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		expect(sse.filter(event => event.event === "content_block_start").map(event => event.data)).toEqual([
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "web_search",
					input: { query: "weather" },
				},
			},
			{
				type: "content_block_start",
				index: 2,
				content_block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_1",
					content: [
						{
							type: "web_search_result",
							url: "https://example.com/weather",
							title: "Weather",
							encrypted_content: "encrypted-result",
						},
					],
				},
			},
			{
				type: "content_block_start",
				index: 3,
				content_block: { type: "text", text: "" },
			},
		]);
		expect(sse.filter(event => event.event === "content_block_stop").map(event => event.data.index)).toEqual([
			0, 1, 2, 3,
		]);
	});

	it("emits an error event when the upstream stream errors", async () => {
		const errMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: errMessage },
			{ type: "error", reason: "error", error: errMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "m"));
		const last = sse.at(-1)!;
		expect(last.event).toBe("error");
		expect(last.data).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
	});

	it("reports tool_use in message_delta when a client-executed tool call ends the turn on `stop`", async () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_handoff",
			name: "get_weather",
			arguments: { city: "Paris" },
		};
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 0, partial: finalMessage },
			{ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "cursor/cursor-grok-4.6"));
		const delta = sse.find(event => event.event === "message_delta")!.data as {
			delta: { stop_reason: string };
		};
		expect(delta.delta.stop_reason).toBe("tool_use");
	});

	it("drops a Cursor-resolved call from the stream and renumbers the blocks after it", async () => {
		const resolved: ToolCall = { type: "toolCall", id: "call_todo", name: "todo", arguments: { todos: [] } };
		(resolved as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const handoff: ToolCall = {
			type: "toolCall",
			id: "toolu_handoff",
			name: "get_weather",
			arguments: { city: "Paris" },
		};
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [resolved, { type: "text", text: "Plan updated." }, handoff],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 0, partial: finalMessage },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"todos":[]}', partial: finalMessage },
			{ type: "toolcall_end", contentIndex: 0, toolCall: resolved, partial: finalMessage },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "Plan updated.", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "Plan updated.", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 2, partial: finalMessage },
			{ type: "toolcall_end", contentIndex: 2, toolCall: handoff, partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "cursor/cursor-grok-4.6"));
		// The resolved `todo` never reaches the client, and every block after it
		// shifts down so the client's index-addressed snapshot stays aligned.
		const blocks = sse.filter(event => event.event === "content_block_start").map(event => event.data);
		expect(blocks).toEqual([
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "toolu_handoff", name: "get_weather", input: {} },
			},
		]);
		expect(sse.filter(event => event.event === "content_block_delta").map(event => event.data)).toEqual([
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Plan updated." } },
		]);
		expect(sse.filter(event => event.event === "content_block_stop").map(event => event.data.index)).toEqual([0, 1]);
		expect(sse.find(event => event.event === "message_delta")?.data.delta).toEqual({
			stop_reason: "tool_use",
			stop_sequence: null,
		});
	});

	it("ends the turn when every call in it was resolved by Cursor's exec channel", async () => {
		const resolved: ToolCall = { type: "toolCall", id: "call_todo", name: "todo", arguments: { todos: [] } };
		(resolved as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [resolved],
			api: "anthropic-messages",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 0, partial: finalMessage },
			{ type: "toolcall_end", contentIndex: 0, toolCall: resolved, partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "cursor/cursor-grok-4.6"));
		expect(sse.map(event => event.event)).toEqual(["message_start", "message_delta", "message_stop"]);
		expect(sse.find(event => event.event === "message_delta")?.data.delta).toEqual({
			stop_reason: "end_turn",
			stop_sequence: null,
		});
	});

	it("emits a complete envelope when the stream ends without an explicit done", async () => {
		const sse = await collectSse(encodeStream(makeStream([]), "m"));
		expect(sse.map(e => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
		const delta = sse[1]!.data as { delta: { stop_reason: string } };
		expect(delta.delta.stop_reason).toBe("end_turn");
	});
});
