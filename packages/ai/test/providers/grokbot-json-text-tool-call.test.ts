import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamGrokBot } from "../../src/providers/grokbot";
import * as grokbotAuth from "../../src/providers/grokbot/auth";
import {
	advertisedNamesForJsonTextToolCall,
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
		expect(
			parseJsonTextToolCall('{"name":"bash","arguments":{"command":"echo hi"}}', ["Shell", "Read"]),
		).toEqual({
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

	test("does not promote ordinary assistant text when tools were advertised", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const text = frameConnectProto(
			encodeInferenceStreamResponse({ textPart: { text: "pong42", isFinal: true } }),
		);
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
