import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamGrokBot } from "../../src/providers/grokbot";
import * as grokbotAuth from "../../src/providers/grokbot/auth";
import {
	advertisedNamesForJsonTextToolCall,
	assistantTextForJsonPromotion,
	parseGeminiInbandToolCall,
	parseJsonTextToolCall,
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
		expect(parseJsonTextToolCall('{"name":"bash","arguments":{"command":"echo hi"}}', ["Shell", "Read"])).toEqual({
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
		expect(
			parseGeminiInbandToolCall('default_api.Shell(command="echo hi")', ["Shell", "bash"]),
		).toEqual({ name: "Shell", arguments: { command: "echo hi" } });
		expect(parseGeminiInbandToolCall("just thinking about files", advertised)).toBeUndefined();
	});

	test("assistantTextForJsonPromotion joins thinking so thought-only JSON can promote", () => {
		expect(
			assistantTextForJsonPromotion([
				{ type: "thinking", thinking: '{"name":"bash","arguments":{"command":"echo hi"}}' },
			]),
		).toBe('{"name":"bash","arguments":{"command":"echo hi"}}');
	});

	test("advertisedNamesForJsonTextToolCall unions wire + omp aliases", () => {
		const names = advertisedNamesForJsonTextToolCall([{ name: "Shell" }], [{ name: "bash" }, { name: "read" }]);
		expect(names.has("Shell")).toBe(true);
		expect(names.has("bash")).toBe(true);
		expect(names.has("Read")).toBe(true);
		expect(names.has("read")).toBe(true);
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

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
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

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "bash",
				arguments: { command: "echo tools-pong-think" },
			}),
		]);
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
});
