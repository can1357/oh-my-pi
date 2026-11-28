import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Type } from "@sinclair/typebox";
import { bedrockEvent, bedrockTestModel, withSkippedBedrockAuth } from "./helpers/bedrock-stream";

const context: Context = {
	systemPrompt: ["be terse"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
	tools: [
		{
			name: "echo",
			description: "Echo text",
			parameters: Type.Object({ t: Type.String() }),
		},
	],
};

interface ToolChoicePayload {
	toolConfig?: { toolChoice?: Record<string, unknown> };
	additionalModelRequestFields?: { thinking?: unknown };
}

/** Every Converse request carries `messages`; tools in context imply a `toolConfig` object. */
function isToolChoicePayload(payload: unknown): payload is ToolChoicePayload {
	if (typeof payload !== "object" || payload === null) return false;
	if (!("messages" in payload) || !Array.isArray(payload.messages)) return false;
	return "toolConfig" in payload && typeof payload.toolConfig === "object" && payload.toolConfig !== null;
}

async function capture(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions,
): Promise<ToolChoicePayload> {
	const controller = new AbortController();
	const { promise, resolve, reject } = Promise.withResolvers<ToolChoicePayload>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		signal: controller.signal,
		...options,
		onPayload: payload => {
			if (isToolChoicePayload(payload)) resolve(payload);
			else reject(new Error("expected a Bedrock request payload with toolConfig"));
			controller.abort();
			return undefined;
		},
	});
	return promise;
}

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
	if (!model) throw new Error(`missing bundled model ${id}`);
	return model;
}

describe("Bedrock forced tool choice", () => {
	// Opus/Sonnet 5.5 reject `toolChoice: {any}` / `{tool}` with 400 "tool_choice:
	// type \"tool\" and \"any\" are not supported for this model" regardless of thinking.
	for (const id of ["us.anthropic.claude-opus-5-5", "global.anthropic.claude-sonnet-5-5"]) {
		test(`downgrades forced choice to auto for ${id} and keeps thinking`, async () => {
			const model = bedrockModel(id);
			expect(model.compat.supportsForcedToolChoice).toBe(false);

			const anyPayload = await capture(model, { toolChoice: "any", reasoning: Effort.Low });
			expect(anyPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
			expect(anyPayload.additionalModelRequestFields?.thinking).toBeDefined();

			const namedPayload = await capture(model, {
				toolChoice: { type: "tool", name: "echo" },
				reasoning: Effort.Low,
			});
			expect(namedPayload.toolConfig?.toolChoice).toEqual({ auto: {} });
			expect(namedPayload.additionalModelRequestFields?.thinking).toBeDefined();
		});
	}

	test("still forces the tool on Opus 5, dropping thinking instead", async () => {
		const payload = await capture(bedrockModel("us.anthropic.claude-opus-5"), {
			toolChoice: "any",
			reasoning: Effort.Low,
		});
		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
	});
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
		bedrockEvent("messageStart", '{"role":"assistant"}'),
		bedrockEvent(
			"contentBlockStart",
			'{"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"sentinel_1","name":"__no_tools__"}}}',
		),
		bedrockEvent("contentBlockDelta", '{"contentBlockIndex":0,"delta":{"toolUse":{"input":"{}"}}}'),
		bedrockEvent("contentBlockStop", '{"contentBlockIndex":0}'),
		bedrockEvent("messageStop", '{"stopReason":"tool_use"}'),
		bedrockEvent("metadata", '{"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'),
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

function captureBedrockPayload(context: Context): Promise<BedrockToolConfigPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<BedrockToolConfigPayload>();
	void streamBedrock(bedrockTestModel(), context, {
		signal: controller.signal,
		toolChoice: "none",
		onPayload: payload => {
			resolve(isBedrockToolConfigPayload(payload) ? payload : {});
			return undefined;
		},
	});
	return promise;
}

// Bedrock rejects toolUse/toolResult history without a non-empty `toolConfig`, so a
// tool-less turn over such history advertises a `__no_tools__` sentinel instead.
describe("Bedrock tool-less turns over tool history", () => {
	test("keeps toolConfig when a no-tool ephemeral turn replays toolUse/toolResult history", async () => {
		let payload: BedrockToolConfigPayload = {};
		await withSkippedBedrockAuth(async () => {
			payload = await captureBedrockPayload(toolHistoryContext());
		});

		expect(payload.toolConfig?.tools?.[0]?.toolSpec?.name).toBe("__no_tools__");
		expect(payload.toolConfig?.toolChoice?.auto).toEqual({});
	});

	test("filters sentinel toolUse blocks before they reach normal tool execution", async () => {
		await withSkippedBedrockAuth(async () => {
			const result = await streamBedrock(bedrockTestModel(), toolHistoryContext(), {
				toolChoice: "none",
				fetch: sentinelToolUseFetch(),
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content.some(block => block.type === "toolCall")).toBe(false);
		});
	});

	test("preserves a real caller tool literally named __no_tools__ on normal turns", async () => {
		const userTool: Tool = {
			name: "__no_tools__",
			description: "Caller-registered tool that collides with the sentinel name.",
			parameters: type({ query: type("string") }),
		};
		const context: Context = {
			messages: [{ role: "user", content: "Use my tool", timestamp: 0 }],
			tools: [userTool],
		};

		await withSkippedBedrockAuth(async () => {
			const result = await streamBedrock(bedrockTestModel(), context, {
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
});
