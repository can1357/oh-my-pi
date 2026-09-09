import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

interface BedrockToolConfigPayload {
	toolConfig?: {
		tools?: Array<{ toolSpec?: { name?: string } }>;
		toolChoice?: { auto?: Record<string, never> };
	};
}

function isBedrockToolConfigPayload(payload: unknown): payload is BedrockToolConfigPayload {
	return typeof payload === "object" && payload !== null;
}

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buffer = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buffer.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	buffer.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	buffer.set(valueBytes, offset);
	return buffer;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const chunk of headerChunks) {
		headerBytes.set(chunk, offset);
		offset += chunk.length;
	}
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function encodeBedrockEvent(eventType: string, payload: string): Uint8Array {
	return encodeFrame({ ":message-type": "event", ":event-type": eventType }, new TextEncoder().encode(payload));
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}

function sentinelToolUseFetch(): FetchImpl {
	const frames = [
		encodeBedrockEvent("messageStart", '{"role":"assistant"}'),
		encodeBedrockEvent(
			"contentBlockStart",
			'{"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"sentinel_1","name":"__no_tools__"}}}',
		),
		encodeBedrockEvent("contentBlockDelta", '{"contentBlockIndex":0,"delta":{"toolUse":{"input":"{}"}}}'),
		encodeBedrockEvent("contentBlockStop", '{"contentBlockIndex":0}'),
		encodeBedrockEvent("messageStop", '{"stopReason":"tool_use"}'),
		encodeBedrockEvent("metadata", '{"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'),
	];
	return Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) =>
			new Response(streamFrom(frames), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
		{ preconnect: fetch.preconnect },
	);
}

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		name: "Claude 3.5 Sonnet",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function toolHistoryContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Read the file", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "Side-channel question", timestamp: 1 },
		],
		tools: [],
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureBedrockPayload(context: Context): Promise<BedrockToolConfigPayload> {
	const { promise, resolve } = Promise.withResolvers<BedrockToolConfigPayload>();
	void streamBedrock(model(), context, {
		signal: abortedSignal(),
		toolChoice: "none",
		onPayload: payload => {
			resolve(isBedrockToolConfigPayload(payload) ? payload : {});
			return undefined;
		},
	});
	return promise;
}

describe("issue #3124 — Bedrock /btw with tool history", () => {
	it("keeps toolConfig when a no-tool ephemeral turn replays toolUse/toolResult history", async () => {
		const payload = await captureBedrockPayload(toolHistoryContext());

		expect(payload.toolConfig?.tools?.[0]?.toolSpec?.name).toBe("__no_tools__");
		expect(payload.toolConfig?.toolChoice?.auto).toEqual({});
	});

	it("filters sentinel toolUse blocks before they reach normal tool execution", async () => {
		const result = await streamBedrock(model(), toolHistoryContext(), {
			toolChoice: "none",
			fetch: sentinelToolUseFetch(),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.some(block => block.type === "toolCall")).toBe(false);
	});

	it("preserves a real caller tool literally named __no_tools__ on normal turns", async () => {
		const userTool: Tool = {
			name: "__no_tools__",
			description: "Caller-registered tool that collides with the sentinel name.",
			parameters: type({ query: type("string") }),
		};
		const context: Context = {
			messages: [{ role: "user", content: "Use my tool", timestamp: 0 }],
			tools: [userTool],
		};

		const result = await streamBedrock(model(), context, {
			toolChoice: "auto",
			fetch: sentinelToolUseFetch(),
		}).result();

		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter(
			(block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
		);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.name).toBe("__no_tools__");
	});
});
