import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamGrokBot } from "../../src/providers/grokbot";
import * as grokbotAuth from "../../src/providers/grokbot/auth";
import { streamSimple } from "../../src/stream";
import {
	advertisedNamesForJsonTextToolCall,
	assistantTextForJsonPromotion,
	looksLikePromotableToolText,
	parseGeminiInbandToolCall,
	parseGeminiInbandToolCalls,
	parseJsonTextToolCall,
	promoteJsonTextToolCallsFromContent,
	shouldHoldPromotableToolText,
	shouldPromoteJsonTextToolCall,
} from "../../src/providers/grokbot/json-text-tool-call";
import {
	CONNECT_END_STREAM_FLAG,
	encodeInferenceStreamResponse,
	frameConnectProto,
} from "../../src/providers/grokbot/proto";
import type { Context, FetchImpl, Model, Tool } from "../../src/types";

describe("parseJsonTextToolCall", () => {
	const advertised = ["Shell", "Read", "Write", "bash", "read", "write"];

	test("promotes the sand-automation grok-4.5-high fenced Shell dump", () => {
		const text = '```json\n{"name":"Shell","arguments":{"command":"echo tools-pong-sand-automation"}}\n```';
		expect(parseJsonTextToolCall(text, advertised)).toEqual({
			name: "Shell",
			arguments: { command: "echo tools-pong-sand-automation" },
		});
	});

	test("accepts bare JSON and omp bash name against product advertisements", () => {
		// Owner aliases come from advertisedNamesForJsonTextToolCall — not a raw
		// toSandField2Name fallback that would also revive collision losers.
		const names = advertisedNamesForJsonTextToolCall(
			[{ name: "Shell" }, { name: "Read" }],
			[{ name: "bash" }, { name: "read" }],
		);
		expect(parseJsonTextToolCall('{"name":"bash","arguments":{"command":"echo hi"}}', names)).toEqual({
			name: "bash",
			arguments: { command: "echo hi" },
		});
		expect(parseJsonTextToolCall('{"name":"Shell","arguments":{"command":"echo hi"}}', names)).toEqual({
			name: "Shell",
			arguments: { command: "echo hi" },
		});
	});

	test("rejects prose, mixed fences, and tools that were not advertised", () => {
		expect(parseJsonTextToolCall("Use Shell please", advertised)).toBeUndefined();
		expect(
			parseJsonTextToolCall(
				'Here you go:\n```json\n{"name":"Shell","arguments":{"command":"echo hi"}}\n```\n',
				advertised,
			),
		).toBeUndefined();
		expect(parseJsonTextToolCall('{"name":"WebSearch","arguments":{"q":"x"}}', advertised)).toBeUndefined();
		expect(parseJsonTextToolCall('{"name":"Shell","arguments":{"command":"x"}}', [])).toBeUndefined();
	});

	test("unwraps Gemini functionCall wrappers and tool_code fences", () => {
		expect(
			parseJsonTextToolCall(
				'```tool_code\n{"functionCall":{"name":"bash","args":{"command":"echo hi"}}}\n```',
				advertised,
			),
		).toEqual({ name: "bash", arguments: { command: "echo hi" } });
	});

	test("promotes Gemini default_api.bash tool_code (gemini-3-flash empty-body)", () => {
		expect(
			parseGeminiInbandToolCall(
				'```tool_code\nprint(default_api.bash(command="echo tools-pong-gemini"))\n```',
				advertised,
			),
		).toEqual({ name: "bash", arguments: { command: "echo tools-pong-gemini" } });
		expect(parseGeminiInbandToolCall('default_api.Shell(command="echo hi")', ["Shell", "bash"])).toEqual({
			name: "Shell",
			arguments: { command: "echo hi" },
		});
		expect(parseGeminiInbandToolCall("just thinking about files", advertised)).toBeUndefined();
	});

	test("promotes every advertised call inside one tool_code fence", () => {
		// Parallel default_api expressions must all become tool calls — returning
		// only the first would drop sibling Shell/Read work from the fence.
		expect(
			parseGeminiInbandToolCalls(
				'```tool_code\ndefault_api.bash(command="echo a")\ndefault_api.read(path="notes/a.txt")\n```',
				["bash", "read", "Shell", "Read"],
			),
		).toEqual([
			{ name: "bash", arguments: { command: "echo a" } },
			{ name: "read", arguments: { path: "notes/a.txt" } },
		]);
	});

	test("rejects prose that merely mentions a call-shaped expression", () => {
		expect(
			parseGeminiInbandToolCall('You can run bash(command="echo hi") to list files', ["bash", "Shell"]),
		).toBeUndefined();
		expect(
			parseGeminiInbandToolCall(
				'Here is an example:\n```tool_code\ndefault_api.bash(command="echo hi")\n```\n',
				advertised,
			),
		).toBeUndefined();
		expect(looksLikePromotableToolText('{"name":"Shell","arguments":{}}')).toBe(true);
		expect(looksLikePromotableToolText("```json\n{")).toBe(true);
		expect(looksLikePromotableToolText("```\n{")).toBe(true);
		expect(looksLikePromotableToolText("pong42")).toBe(false);
		expect(shouldHoldPromotableToolText("")).toBe(true);
		expect(shouldHoldPromotableToolText("```")).toBe(true);
		expect(shouldHoldPromotableToolText("```\n{")).toBe(true);
		expect(shouldHoldPromotableToolText("pong42")).toBe(false);
	});

	test("assistantTextForJsonPromotion joins thinking so thought-only JSON can promote", () => {
		expect(
			assistantTextForJsonPromotion([
				{ type: "thinking", thinking: '{"name":"bash","arguments":{"command":"echo hi"}}' },
			]),
		).toBe('{"name":"bash","arguments":{"command":"echo hi"}}');
	});

	test("promoteJsonTextToolCallsFromContent tries blocks before joining reasoning prose", () => {
		const advertised = new Set(["Shell", "bash"]);
		const promoted = promoteJsonTextToolCallsFromContent(
			[
				{ type: "thinking", thinking: "I should run a shell command next." },
				{ type: "text", text: '{"name":"Shell","arguments":{"command":"echo hi"}}' },
			],
			advertised,
		);
		expect(promoted.calls).toEqual([{ name: "Shell", arguments: { command: "echo hi" } }]);
		expect(promoted.sourceIndexes).toEqual([1]);
		// Combined candidate would start with prose and fail — individual text wins.
		expect(
			parseJsonTextToolCall(
				assistantTextForJsonPromotion([
					{ type: "thinking", thinking: "I should run a shell command next." },
					{ type: "text", text: '{"name":"Shell","arguments":{"command":"echo hi"}}' },
				]),
				advertised,
			),
		).toBeUndefined();
	});

	test("promoteJsonTextToolCallsFromContent still promotes thought-only JSON via fallback", () => {
		const advertised = new Set(["bash"]);
		expect(
			promoteJsonTextToolCallsFromContent(
				[{ type: "thinking", thinking: '{"name":"bash","arguments":{"command":"echo hi"}}' }],
				advertised,
			),
		).toEqual({
			calls: [{ name: "bash", arguments: { command: "echo hi" } }],
			sourceIndexes: [0],
		});
	});

	test("promoteJsonTextToolCallsFromContent accumulates calls across multiple blocks", () => {
		const advertised = new Set(["Shell", "Read"]);
		expect(
			promoteJsonTextToolCallsFromContent(
				[
					{ type: "thinking", thinking: "I'll read then shell." },
					{ type: "text", text: '{"name":"Read","arguments":{"path":"a.ts"}}' },
					{ type: "text", text: '{"name":"Shell","arguments":{"command":"echo hi"}}' },
				],
				advertised,
			),
		).toEqual({
			calls: [
				{ name: "Read", arguments: { path: "a.ts" } },
				{ name: "Shell", arguments: { command: "echo hi" } },
			],
			sourceIndexes: [1, 2],
		});
	});

	test("promoteJsonTextToolCallsFromContent prefers text over matching thinking duplicates", () => {
		const advertised = new Set(["Shell", "Write"]);
		const shell = '{"name":"Shell","arguments":{"command":"echo once"}}';
		const promoted = promoteJsonTextToolCallsFromContent(
			[
				{ type: "thinking", thinking: shell },
				{ type: "text", text: shell },
			],
			advertised,
		);
		// One intended action mirrored in thinking + text must not become two tool calls.
		expect(promoted.calls).toEqual([{ name: "Shell", arguments: { command: "echo once" } }]);
		expect(promoted.sourceIndexes).toEqual([0, 1]);
	});

	test("promoteJsonTextToolCallsFromContent dedupes thinking/text when argument key order differs", () => {
		const advertised = new Set(["Write"]);
		const thinking = '{"name":"Write","arguments":{"path":"a","content":"x"}}';
		const textDump = '{"name":"Write","arguments":{"content":"x","path":"a"}}';
		const promoted = promoteJsonTextToolCallsFromContent(
			[
				{ type: "thinking", thinking },
				{ type: "text", text: textDump },
			],
			advertised,
		);
		expect(promoted.calls).toEqual([{ name: "Write", arguments: { content: "x", path: "a" } }]);
		expect(promoted.sourceIndexes).toEqual([0, 1]);
	});

	test("promoteJsonTextToolCallsFromContent keeps distinct thinking calls alongside text", () => {
		const advertised = new Set(["Shell", "Write"]);
		const promoted = promoteJsonTextToolCallsFromContent(
			[
				{ type: "thinking", thinking: '{"name":"Write","arguments":{"path":"a.ts","contents":"x"}}' },
				{ type: "text", text: '{"name":"Shell","arguments":{"command":"echo hi"}}' },
			],
			advertised,
		);
		expect(promoted.calls).toEqual([
			{ name: "Write", arguments: { path: "a.ts", contents: "x" } },
			{ name: "Shell", arguments: { command: "echo hi" } },
		]);
		expect(promoted.sourceIndexes).toEqual([0, 1]);
	});

	test("advertisedNamesForJsonTextToolCall aliases only from advertised wire tools", () => {
		const names = advertisedNamesForJsonTextToolCall(
			[{ name: "Shell" }, { name: "Write" }],
			[{ name: "bash" }, { name: "read" }, { name: "write" }, { name: "edit" }],
		);
		expect(names.has("Shell")).toBe(true);
		expect(names.has("bash")).toBe(true);
		expect(names.has("Write")).toBe(true);
		expect(names.has("write")).toBe(true);
		// Collision loser `edit` and unadvertised `read` must not promote.
		expect(names.has("edit")).toBe(false);
		expect(names.has("read")).toBe(false);
		expect(names.has("Read")).toBe(false);
	});

	test("advertisedNamesForJsonTextToolCall aliases the surviving custom Shell owner, not bash", () => {
		const names = advertisedNamesForJsonTextToolCall(
			[{ name: "Shell" }],
			[{ name: "customThing", customWireName: "Shell" }],
		);
		expect(names.has("Shell")).toBe(true);
		expect(names.has("customThing")).toBe(true);
		expect(names.has("bash")).toBe(false);
	});

	test("advertisedNamesForJsonTextToolCall does not invent Shell for native bash wire", () => {
		// Catalog-opted native rows advertise bash/read/write. Inventing Shell would
		// let JSON promotion accept a name upsertTool cannot resolve on the native index.
		const names = advertisedNamesForJsonTextToolCall(
			[{ name: "bash" }, { name: "read" }, { name: "write" }],
			[{ name: "bash" }, { name: "read" }, { name: "write" }],
		);
		expect(names.has("bash")).toBe(true);
		expect(names.has("read")).toBe(true);
		expect(names.has("write")).toBe(true);
		expect(names.has("Shell")).toBe(false);
		expect(names.has("Read")).toBe(false);
		expect(names.has("Write")).toBe(false);
		expect(parseJsonTextToolCall('{"name":"Shell","arguments":{"command":"echo hi"}}', names)).toBeUndefined();
		expect(parseJsonTextToolCall('{"name":"bash","arguments":{"command":"echo hi"}}', names)).toEqual({
			name: "bash",
			arguments: { command: "echo hi" },
		});
	});

	test("parseJsonTextToolCall rejects collision-loser edit/bash when write/custom owns the wire slot", () => {
		const writeOwns = advertisedNamesForJsonTextToolCall(
			[{ name: "Write" }, { name: "Shell" }],
			[{ name: "write" }, { name: "edit" }, { name: "bash" }],
		);
		expect(writeOwns.has("write")).toBe(true);
		expect(writeOwns.has("edit")).toBe(false);
		expect(parseJsonTextToolCall('{"name":"edit","arguments":{"path":"a.ts"}}', writeOwns)).toBeUndefined();
		expect(parseJsonTextToolCall('{"name":"Write","arguments":{"path":"a.ts","content":"x"}}', writeOwns)).toEqual({
			name: "Write",
			arguments: { path: "a.ts", content: "x" },
		});
		// Extension owns Shell (bash not among omp tools) — raw "bash" must not
		// promote via toSandField2Name fallback onto the extension slot.
		const customShell = advertisedNamesForJsonTextToolCall(
			[{ name: "Shell" }],
			[{ name: "customThing", customWireName: "Shell" }],
		);
		expect(customShell.has("bash")).toBe(false);
		expect(customShell.has("customThing")).toBe(true);
		expect(parseJsonTextToolCall('{"name":"bash","arguments":{"command":"echo hi"}}', customShell)).toBeUndefined();
		expect(parseJsonTextToolCall('{"name":"customThing","arguments":{"command":"echo hi"}}', customShell)).toEqual({
			name: "customThing",
			arguments: { command: "echo hi" },
		});
	});

	test("advertisedNamesForJsonTextToolCall falls back to omp tools when wire tools absent", () => {
		const names = advertisedNamesForJsonTextToolCall(undefined, [{ name: "bash" }, { name: "edit" }]);
		expect(names.has("bash")).toBe(true);
		expect(names.has("Shell")).toBe(true);
		expect(names.has("edit")).toBe(true);
		expect(names.has("Write")).toBe(true);
	});

	test("shouldPromoteJsonTextToolCall requires catalog fact or product wire profiles", () => {
		expect(shouldPromoteJsonTextToolCall({})).toBe(false);
		expect(shouldPromoteJsonTextToolCall({ sandPromoteJsonTextTools: true })).toBe(true);
		expect(shouldPromoteJsonTextToolCall({ wireMode: "automation" })).toBe(true);
		expect(shouldPromoteJsonTextToolCall({ wireMode: "parent-chat" })).toBe(true);
		expect(shouldPromoteJsonTextToolCall({ wireMode: "keep-model" })).toBe(true);
		expect(shouldPromoteJsonTextToolCall({ wireMode: "native" })).toBe(false);
	});
});

describe("streamGrokBot JSON-as-text promotion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const model: Model<"grokbot-sand"> = buildModel({
		id: "sand-automation",
		name: "sand-automation",
		api: "grokbot-sand",
		provider: "grokbot",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		sandToolsWire: "automation",
		sandParameterIds: [],
	});

	const bashTool = {
		name: "bash",
		description: "Run a shell command.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	} as Tool;

	function connectBody(...frames: Buffer[]): Response {
		return new Response(Buffer.concat(frames), {
			status: 200,
			headers: { "content-type": "application/connect+proto" },
		});
	}

	test("automation wire fenced Shell JSON becomes a bash toolCall (matrix no-tool-call regression)", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const fenced = '```json\n{"name":"Shell","arguments":{"command":"echo tools-pong-sand-automation"}}\n```';
		const text = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: fenced, isFinal: true } }));
		const routed = frameConnectProto(
			encodeInferenceStreamResponse({ responseInfo: { model: "cursor-grok-4.5-high" } }),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(text, routed, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "Use the Shell tool", timestamp: 1 }],
			tools: [bashTool],
		};

		const stream = streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl });
		const textEvents: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
				textEvents.push(event.type);
			}
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.upstreamModel).toBe("cursor-grok-4.5-high");
		expect(result.content.some(b => b.type === "text")).toBe(false);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo tools-pong-sand-automation" },
			}),
		]);
		// Promotable JSON must stay buffered until classification — no leaked text lifecycle.
		expect(textEvents).toEqual([]);
	});

	test("promotes JSON-as-text hidden in a thinking-only turn", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinking = frameConnectProto(
			encodeInferenceStreamResponse({
				thinkingPart: {
					text: '{"name":"bash","arguments":{"command":"echo tools-pong-think"}}',
					isFinal: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(thinking, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
			tools: [bashTool],
		};

		const stream = streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl });
		const thinkingEvents: string[] = [];
		for await (const event of stream) {
			if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end") {
				thinkingEvents.push(event.type);
			}
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo tools-pong-think" },
			}),
		]);
		// Promoted call must not flush the discarded thinking buffer as reasoning.
		expect(thinkingEvents).toEqual([]);
	});

	test("promotes Gemini default_api tool_code hidden in thinking", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinking = frameConnectProto(
			encodeInferenceStreamResponse({
				thinkingPart: {
					text: '```tool_code\ndefault_api.bash(command="echo tools-pong-flash")\n```',
					isFinal: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(thinking, trailer)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		const context: Context = {
			messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo tools-pong-flash" },
			}),
		]);
	});

	test("retries a thinking-only empty tool turn and accepts the second toolCall", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "planning", isFinal: true },
				}),
			),
			frameConnectProto(
				encodeInferenceStreamResponse({
					responseInfo: { id: "abandoned-resp", model: "abandoned-model" },
				}),
			),
			frameConnectProto(
				encodeInferenceStreamResponse({
					usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolCall = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					toolCallPart: {
						toolCallId: "c-retry",
						toolName: "bash",
						args: '{"command":"echo retried"}',
						isComplete: true,
					},
				}),
			),
			frameConnectProto(
				encodeInferenceStreamResponse({
					usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return connectBody(...(calls === 1 ? [thinkingOnly] : [toolCall]));
		}) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
		});
		const context: Context = {
			messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo retried" },
			}),
		]);
		// Abandoned first-attempt responseInfo must not stick on the accepted retry.
		expect(result.responseId).toBeUndefined();
		expect(result.upstreamModel).toBeUndefined();
		// Abandoned attempt usage is preserved and added to the successful attempt.
		expect(result.usage.input).toBe(31);
		expect(result.usage.output).toBe(12);
		expect(result.usage.totalTokens).toBe(43);
	});

	test("merges abandoned attempt usage into the error when the empty-tool retry fails", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "planning", isFinal: true },
				}),
			),
			frameConnectProto(
				encodeInferenceStreamResponse({
					usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const err = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					error: { errorType: 7 },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return connectBody(...(calls === 1 ? [thinkingOnly] : [err]));
		}) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandEmptyToolsRetryWire: "keep-model",
		});
		const context: Context = {
			messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/errorType=7/);
		// Abandoned first-attempt usage must survive onto the error message after retry reset.
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(7);
		expect(result.usage.totalTokens).toBe(18);
	});

	test("buffers a later promotable JSON block after ordinary prose already went live", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const prose = frameConnectProto(
			encodeInferenceStreamResponse({ textPart: { text: "Looking into it.", isFinal: true } }),
		);
		const fenced = '```json\n{"name":"Shell","arguments":{"command":"echo tools-pong-after-prose"}}\n```';
		const dump = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: fenced, isFinal: true } }));
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(prose, dump, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "Use the Shell tool", timestamp: 1 }],
			tools: [bashTool],
		};

		const stream = streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl });
		const textDeltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: "Looking into it." }),
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo tools-pong-after-prose" },
			}),
		]);
		// Prose streams live and stays on the final message; only the JSON dump is dropped.
		expect(textDeltas.join("")).toBe("Looking into it.");
		expect(textDeltas.join("")).not.toContain("tools-pong-after-prose");
	});

	test("toolChoice none omits tools even when context.tools is retained", async () => {
		// Handoff keeps live tools for prompt-cache reuse while forcing toolChoice none.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");
		const text = Buffer.concat([
			frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: "handoff", isFinal: true } })),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		let advertised: unknown;
		const fetchImpl = (async () => connectBody(...[text])) as FetchImpl;
		const model = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
		});
		const result = await streamGrokBot(
			model as Model<"grokbot-sand">,
			{
				messages: [{ role: "user", content: "Summarize", timestamp: 1 }],
				tools: [bashTool],
			},
			{
				apiKey: "renew",
				fetch: fetchImpl,
				toolChoice: "none",
				onPayload: body => {
					advertised = (body as { tools?: unknown }).tools;
					return body;
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(advertised).toEqual([]);
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("streamSimple forwards toolChoice none into Grok Bot provider options", async () => {
		// Handoff / generateHandoffFromContext go through streamSimple → mapOptionsForApi;
		// dropping toolChoice there left the provider advertising live tools.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");
		const text = Buffer.concat([
			frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: "handoff", isFinal: true } })),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		let advertised: unknown;
		const fetchImpl = (async () => connectBody(...[text])) as FetchImpl;
		const model = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
		});
		const result = await streamSimple(
			model as Model<"grokbot-sand">,
			{
				messages: [{ role: "user", content: "Summarize", timestamp: 1 }],
				tools: [bashTool],
			},
			{
				apiKey: "renew",
				fetch: fetchImpl,
				toolChoice: "none",
				onPayload: body => {
					advertised = (body as { tools?: unknown }).tools;
					return body;
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(advertised).toEqual([]);
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("rejects unsupported required toolChoice (no sand wire field)", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");
		const model = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
		});
		const result = await streamGrokBot(
			model as Model<"grokbot-sand">,
			{
				messages: [{ role: "user", content: "Extract", timestamp: 1 }],
				tools: [bashTool],
			},
			{ apiKey: "renew", toolChoice: "required" },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/toolChoice "required"/);
		expect(result.errorMessage ?? "").toMatch(/auto|none/);
	});

	test("empty-tool retry uses catalog sandEmptyToolsRetryWire keep-model product tools", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "planning", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolCall = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					toolCallPart: {
						toolCallId: "c-retry",
						toolName: "Shell",
						args: '{"command":"echo retried"}',
						isComplete: true,
					},
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolNameSnapshots: string[][] = [];
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return connectBody(...(calls === 1 ? [thinkingOnly] : [toolCall]));
		}) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			// Catalog fact (also applied via KDL for gemini-*); set explicitly so the
			// contract does not depend on class === "gemini" in the streamer.
			sandEmptyToolsRetryWire: "keep-model",
		});
		expect(gemini.sandEmptyToolsRetryWire).toBe("keep-model");
		const result = await streamGrokBot(
			gemini as Model<"grokbot-sand">,
			{
				messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
				tools: [bashTool],
			},
			{
				apiKey: "renew",
				fetch: fetchImpl,
				maxTokens: 512,
				onPayload: body => {
					const tools = (body as { tools?: Array<{ name?: string }> }).tools ?? [];
					toolNameSnapshots.push(tools.map(t => String(t.name ?? "")));
					return body;
				},
			},
		).result();
		expect(calls).toBe(2);
		expect(toolNameSnapshots).toHaveLength(2);
		expect(toolNameSnapshots[0]).toContain("bash");
		expect(toolNameSnapshots[0]).not.toContain("Shell");
		expect(toolNameSnapshots[1]).toContain("Shell");
		expect(result.stopReason).toBe("toolUse");
	});

	test("empty-tool retry without sandEmptyToolsRetryWire keeps the original tool wire", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "planning", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolCall = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					toolCallPart: {
						toolCallId: "c-retry",
						toolName: "bash",
						args: '{"command":"echo retried"}',
						isComplete: true,
					},
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolNameSnapshots: string[][] = [];
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return connectBody(...(calls === 1 ? [thinkingOnly] : [toolCall]));
		}) as FetchImpl;
		// Non-Gemini row with no catalog retry wire — must not invent keep-model.
		const model = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
		});
		expect(model.sandEmptyToolsRetryWire).toBeUndefined();
		await streamGrokBot(
			model as Model<"grokbot-sand">,
			{
				messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
				tools: [bashTool],
			},
			{
				apiKey: "renew",
				fetch: fetchImpl,
				maxTokens: 512,
				onPayload: body => {
					const tools = (body as { tools?: Array<{ name?: string }> }).tools ?? [];
					toolNameSnapshots.push(tools.map(t => String(t.name ?? "")));
					return body;
				},
			},
		).result();
		expect(calls).toBe(2);
		expect(toolNameSnapshots).toHaveLength(2);
		expect(toolNameSnapshots[0]).toEqual(toolNameSnapshots[1]);
		expect(toolNameSnapshots[0]).toContain("bash");
		expect(toolNameSnapshots[0]).not.toContain("Shell");
	});

	test("empty-tool retry clears effort defaults when forcing thinking off", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "planning", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const toolCall = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					toolCallPart: {
						toolCallId: "c-retry",
						toolName: "bash",
						args: '{"command":"echo retried"}',
						isComplete: true,
					},
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const paramSnapshots: Array<Record<string, string>> = [];
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return connectBody(...(calls === 1 ? [thinkingOnly] : [toolCall]));
		}) as FetchImpl;
		const model = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandParameterIds: ["thinking", "context", "effort", "fast"],
			sandParameterDefaults: { thinking: "true", context: "200k", effort: "high", fast: "false" },
		});
		const context: Context = {
			messages: [{ role: "user", content: "Use bash", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(model as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
			onPayload: body => {
				const params = (body as { requestedModel?: { parameters?: Array<{ id: string; value: string }> } })
					.requestedModel?.parameters;
				const map: Record<string, string> = {};
				for (const p of params ?? []) map[p.id] = p.value;
				paramSnapshots.push(map);
				return body;
			},
		}).result();
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("toolUse");
		expect(paramSnapshots).toHaveLength(2);
		expect(paramSnapshots[0]).toMatchObject({ thinking: "true", effort: "high" });
		expect(paramSnapshots[1]?.thinking).toBe("false");
		expect(paramSnapshots[1]?.effort).toBeUndefined();
		expect(paramSnapshots[1]?.reasoning).toBeUndefined();
	});

	test("accepts an empty follow-up after a Write tool result (gemini-3-flash write)", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "done writing", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		expect(gemini.sandAcceptEmptyWriteFollowup).toBe(true);
		const writeTool = {
			name: "write",
			description: "Write a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Write ping to /tmp/x", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "w1",
							name: "write",
							arguments: { path: "/tmp/x", content: "ping" },
						},
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "w1",
					toolName: "write",
					content: [{ type: "text", text: "ping" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [writeTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("accepts an empty follow-up after a product-wire edit tool result", async () => {
		// edit is advertised as Write on the product wire but decoded back to omp `edit`.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "done editing", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		const editTool = {
			name: "edit",
			description: "Edit a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
				required: ["path", "oldText", "newText"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit /tmp/x", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "e1",
							name: "edit",
							arguments: { path: "/tmp/x", oldText: "a", newText: "b" },
						},
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "e1",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [editTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("accepts empty follow-up after customWireName Write extension owner", async () => {
		// Extension `{ name: "save", customWireName: "Write" }` must win Write ownership
		// so empty Gemini follow-ups after that tool result are accepted.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "done writing", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		expect(gemini.sandAcceptEmptyWriteFollowup).toBe(true);
		const saveTool = {
			name: "save",
			description: "extension write",
			customWireName: "Write",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Write ping to /tmp/x", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "w1",
							name: "save",
							arguments: { path: "/tmp/x", content: "ping" },
						},
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "w1",
					toolName: "save",
					content: [{ type: "text", text: "ping" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [saveTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("rejects empty follow-up after edit when write owns the product-wire Write slot", async () => {
		// Collision policy: write owns Write; historical edit results keep omp `edit`
		// and must not trigger the empty Write follow-up workaround.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "done editing", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		const editTool = {
			name: "edit",
			description: "Edit a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
				required: ["path", "oldText", "newText"],
			},
		} as Tool;
		const writeTool = {
			name: "write",
			description: "Write a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit /tmp/x", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "e1",
							name: "edit",
							arguments: { path: "/tmp/x", oldText: "a", newText: "b" },
						},
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "e1",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [editTool, writeTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/no text or tool call/i);
	});

	test("rejects empty follow-up after a non-Write tool result", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "done reading", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		const readTool = {
			name: "read",
			description: "Read a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Read /tmp/x", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "/tmp/x" } }],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "r1",
					toolName: "read",
					content: [{ type: "text", text: "ping" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [readTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/no text or tool call/i);
	});

	test("rejects empty follow-up when toolResult is not the current turn", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "no answer", isFinal: true },
				}),
			),
			frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG),
		]);
		const fetchImpl = (async () => connectBody(thinkingOnly)) as FetchImpl;
		const gemini = buildModel({
			id: "gemini-3-flash",
			name: "gemini-3-flash",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 512,
			sandToolsWire: "keep-model",
		});
		const writeTool = {
			name: "write",
			description: "Write a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		} as Tool;
		const context: Context = {
			messages: [
				{ role: "user", content: "Write ping", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "w1",
							name: "write",
							arguments: { path: "/tmp/x", content: "ping" },
						},
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "gemini-3-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "w1",
					toolName: "write",
					content: [{ type: "text", text: "ping" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "What is 2+2?", timestamp: 3 },
			],
			tools: [writeTool],
		};

		const result = await streamGrokBot(gemini as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			maxTokens: 512,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/no text or tool call/i);
	});

	test("does not promote ordinary assistant text when tools were advertised", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const text = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: "pong42", isFinal: true } }));
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(text, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "pong42" })]);
	});

	test("native models without catalog promote fact keep example Shell JSON as text", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const native = buildModel({
			id: "grok-4.6",
			name: "grok-4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandParameterIds: ["effort", "fast"],
		});
		const fenced = '```json\n{"name":"Shell","arguments":{"command":"echo example-only"}}\n```';
		const text = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: fenced, isFinal: true } }));
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(text, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "Show an example Shell JSON payload", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(native as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: fenced })]);
	});

	test("preserves output-token-limit stopReason when only thinking was emitted", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const thinking = frameConnectProto(
			encodeInferenceStreamResponse({
				thinkingPart: { text: "still thinking", isFinal: true },
			}),
		);
		const limit = frameConnectProto(
			encodeInferenceStreamResponse({
				error: { isOutputTokenLimitError: true },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(thinking, limit, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [],
		};

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
	});

	test("prefers toolUse when a completed tool call survives an output-token limit", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const tool = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "bash",
					args: '{"command":"echo hi"}',
					isComplete: true,
				},
			}),
		);
		const limit = frameConnectProto(
			encodeInferenceStreamResponse({
				error: { isOutputTokenLimitError: true },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(tool, limit, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.some(b => b.type === "toolCall")).toBe(true);
		expect(result.errorMessage).toBeUndefined();
	});

	test("throws when a stream error frame has only errorType", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const text = frameConnectProto(
			encodeInferenceStreamResponse({
				textPart: { text: "partial", isFinal: true },
			}),
		);
		const err = frameConnectProto(
			encodeInferenceStreamResponse({
				error: { errorType: 7 },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(text, err, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [],
		};

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/errorType=7/);
	});

	test("synthetic parent-chat SendToUser becomes assistant text", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const call = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu1",
					toolName: "SendToUser",
					args: '{"type":"text","content":"hello-visible"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(call, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "hello-visible" })]);
	});

	test("sequential SendToUser calls each emit full text independently", async () => {
		// Response-wide accumulators must reset on isComplete — otherwise a second
		// identical message is dropped and a prefixed message only emits its suffix.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const first = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu1",
					toolName: "SendToUser",
					args: '{"type":"text","content":"same-message"}',
					isComplete: true,
				},
			}),
		);
		const secondSame = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu2",
					toolName: "SendToUser",
					args: '{"type":"text","content":"same-message"}',
					isComplete: true,
				},
			}),
		);
		const thirdPrefixed = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu3",
					toolName: "SendToUser",
					args: '{"type":"text","content":"same-message and more"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(first, secondSame, thirdPrefixed, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		const texts = result.content.filter(b => b.type === "text").map(b => (b.type === "text" ? b.text : ""));
		expect(texts.join("")).toBe("same-messagesame-messagesame-message and more");
	});

	test("correlates name-less SendToUser continuation frames by call id", async () => {
		// Initial frame carries toolName; later frames may omit it and only update
		// args by id/index — must stay on synthetic text, not upsertTool → unknown.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const start = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-stream",
					toolName: "SendToUser",
					toolIndex: 0,
					args: '{"type":"text","content":"hel"}',
					isComplete: false,
				},
			}),
		);
		const contById = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-stream",
					args: '{"type":"text","content":"hello"}',
					isComplete: false,
				},
			}),
		);
		const doneByIndex = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolIndex: 0,
					args: '{"type":"text","content":"hello world"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(start, contById, doneByIndex, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "hello world" })]);
	});

	test("keeps concurrent SendToUser streams independent when frames interleave", async () => {
		// Completing call A must not clear call B's open keys / args accumulators —
		// a later name-less continuation for B would otherwise fall through to upsertTool.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const startA = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-a",
					toolName: "SendToUser",
					toolIndex: 0,
					args: '{"type":"text","content":"alpha"}',
					isComplete: false,
				},
			}),
		);
		const startB = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-b",
					toolName: "SendToUser",
					toolIndex: 1,
					args: '{"type":"text","content":"beta"}',
					isComplete: false,
				},
			}),
		);
		const doneA = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-a",
					toolIndex: 0,
					args: '{"type":"text","content":"alpha-done"}',
					isComplete: true,
				},
			}),
		);
		const contBNameless = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-b",
					args: '{"type":"text","content":"beta-final"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(startA, startB, doneA, contBNameless, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		// Without per-call state, completing A clears B's open keys and the
		// name-less B continuation falls through to upsertTool as a toolCall.
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b.type === "text" ? b.text : ""))
			.join("");
		// Interleaved deltas share one text stream: A("alpha")+B("beta")+A("-done")+B("-final").
		expect(text).toBe("alphabeta-done-final");
	});

	test("SendToUser text that looks like a tool JSON stays visible text", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const jsonExample = '{"name":"Shell","arguments":{"command":"echo demo"}}';
		const call = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-json",
					toolName: "SendToUser",
					args: JSON.stringify({ type: "text", content: jsonExample }),
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(call, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "show example", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: jsonExample })]);
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});

	test("remaps SendToUser indexes after dropping incomplete leftover so JSON example stays text", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
			sandPromoteJsonTextTools: true,
		});
		const jsonExample = '{"name":"Shell","arguments":{"command":"echo demo-after-drop"}}';
		// Incomplete tool at index 0, SendToUser text at index 1. Dropping the
		// leftover shifts text to 0 — sendToUserTextIndexes must remap or
		// promotion would execute the user-visible JSON example.
		const leftover = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "hang", toolName: "Write", args: '{"path":', isComplete: false },
			}),
		);
		const sendToUser = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-json-drop",
					toolName: "SendToUser",
					args: JSON.stringify({ type: "text", content: jsonExample }),
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(leftover, sendToUser, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "show example", timestamp: 1 }],
			tools: [bashTool],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: jsonExample })]);
	});

	test("promotes thinking JSON while remapping retained SendToUser text indices", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const thinking = frameConnectProto(
			encodeInferenceStreamResponse({
				thinkingPart: {
					text: '```json\n{"name":"Shell","arguments":{"command":"echo from-thought"}}\n```',
					isFinal: true,
				},
			}),
		);
		const sendToUser = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-after-thought",
					toolName: "SendToUser",
					args: '{"type":"text","content":"visible-after-thought"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(thinking, sendToUser, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "run", timestamp: 1 }],
			tools: [bashTool],
		};

		const stream = streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		});
		const events: Array<{ type: string; contentIndex?: number }> = [];
		for await (const event of stream) {
			if (
				event.type === "thinking_start" ||
				event.type === "thinking_delta" ||
				event.type === "thinking_end" ||
				event.type === "text_start" ||
				event.type === "text_delta" ||
				event.type === "text_end" ||
				event.type === "toolcall_start" ||
				event.type === "toolcall_end"
			) {
				events.push({
					type: event.type,
					contentIndex: "contentIndex" in event ? event.contentIndex : undefined,
				});
			}
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: "visible-after-thought" }),
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: expect.objectContaining({ command: "echo from-thought" }),
			}),
		]);
		// Retained SendToUser text lifecycle must land at compacted index 0, not stale 1.
		expect(events.some(e => e.type.startsWith("text_") && e.contentIndex === 0)).toBe(true);
		expect(events.some(e => e.type.startsWith("thinking_"))).toBe(false);
	});

	test("extension-owned SendToUser is dispatched as a tool call", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const extensionSendToUser = {
			name: "SendToUser",
			description: "Extension-owned SendToUser",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string" },
					content: { type: "string" },
				},
				required: ["type", "content"],
			},
		} as Tool;
		const call = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-ext",
					toolName: "SendToUser",
					args: '{"type":"text","content":"should-dispatch"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(call, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool, extensionSendToUser],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "SendToUser",
				arguments: { type: "text", content: "should-dispatch" },
			}),
		]);
	});

	test("internal SendToUser aliased away still treats wire SendToUser as synthetic text", async () => {
		// Extension named SendToUser but advertised as Other does not own the
		// injected parent-chat SendToUser slot — wire SendToUser must stay text.
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const parent = buildModel({
			id: "sand-default",
			name: "sand-default",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
			sandToolsWire: "parent-chat",
			sandParameterIds: [],
		});
		const aliasedAway = {
			name: "SendToUser",
			customWireName: "Other",
			description: "extension other",
			parameters: {
				type: "object",
				properties: {
					payload: { type: "string" },
				},
			},
		} as Tool;
		const call = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "stu-syn",
					toolName: "SendToUser",
					args: '{"type":"text","content":"visible-not-extension"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(call, trailer)) as FetchImpl;
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [bashTool, aliasedAway],
		};

		const result = await streamGrokBot(parent as Model<"grokbot-sand">, context, {
			apiKey: "renew",
			fetch: fetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: "visible-not-extension",
			}),
		]);
	});
});
