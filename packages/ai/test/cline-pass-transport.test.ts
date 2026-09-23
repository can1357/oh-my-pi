import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, Tool, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/**
 * Mirrors what `fetchClinePassModels` produces for a free-bucket entry with a
 * bundled upstream reference: full OpenRouter-style id, raw wire mode, Cline
 * effort ladder. Synthetic so the transport contract is pinned independently
 * of the current bundled roster.
 */
const freeTierDeepseek = buildModel({
	id: "deepseek/deepseek-v4-flash",
	name: "DeepSeek V4 Flash (free)",
	api: "openai-completions",
	provider: "cline-pass",
	baseUrl: "https://api.cline.bot/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 393_216,
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		effortMap: { minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	compat: { wireModelIdMode: "raw" },
}) as Model<"openai-completions">;

const markerTool: Tool = {
	name: "get_marker",
	description: "Return a marker",
	parameters: {
		type: "object",
		properties: { value: { type: "number" } },
		required: ["value"],
	} as Tool["parameters"],
};

const context: Context = {
	systemPrompt: ["Use the provided tool."],
	messages: [{ role: "user", content: "Get marker 42", timestamp: 0 }],
	tools: [markerTool],
};

function completionResponse(model: string, usage?: Record<string, unknown>): Response {
	const events = [
		{
			id: "cline-pass-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "cline-pass-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			...(usage ? { usage } : {}),
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function toolCompletionResponse(model: string): Response {
	const events = [
		{
			id: "cline-pass-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [
				{
					index: 0,
					delta: {
						reasoning: "Inspect the marker.",
						tool_calls: [
							{
								index: 0,
								id: "call_marker",
								type: "function",
								function: { name: "get_marker", arguments: '{"value":42}' },
							},
						],
					},
				},
			],
		},
		{
			id: "cline-pass-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function capturePayload(options: {
	modelId?: string;
	model?: Model<"openai-completions">;
	context?: Context;
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: { type: "tool"; name: string };
	sessionId?: string;
	rawUsage?: Record<string, unknown>;
}): Promise<{ payload: Record<string, unknown>; headers: Record<string, string>; usage: Usage }> {
	const model =
		options.model ??
		(getBundledModel<"openai-completions">(
			"cline-pass",
			options.modelId ?? "kimi-k3",
		) as Model<"openai-completions">);
	let payload: Record<string, unknown> | undefined;
	let headers: Record<string, string> = {};
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			return completionResponse(model.id, options.rawUsage);
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(model, options.context ?? context, {
		apiKey: "test-key",
		fetch: fetchMock,
		maxTokens: 64,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
		toolChoice: options.toolChoice,
		sessionId: options.sessionId,
	}).result();
	if (!payload) throw new Error("Expected ClinePass request payload");
	return { payload, headers, usage: result.usage };
}

describe("ClinePass OpenAI transport", () => {
	it("sends Cline's wire model ID, token field, max effort, and forced tool choice", async () => {
		const { payload } = await capturePayload({
			reasoning: Effort.Max,
			toolChoice: { type: "tool", name: "get_marker" },
		});

		expect(payload.model).toBe("cline-pass/kimi-k3");
		expect(payload.max_completion_tokens).toBe(64);
		expect(payload.max_tokens).toBeUndefined();
		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toBeUndefined();
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "get_marker" } });
	});

	it("disables ClinePass reasoning with the gateway's nested switch", async () => {
		const { payload } = await capturePayload({ disableReasoning: true });

		expect(payload.reasoning).toEqual({ enabled: false });
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.model).toBe("cline-pass/kimi-k3");
	});

	it("mirrors the Cline CLI client-identity headers", async () => {
		// The gateway gates part of the roster (some free-tier models) to Cline
		// product surfaces; this header set is the contract that identifies a Cline
		// client (sdk/packages/llms/src/providers/request-headers.ts). Sent on
		// every ClinePass request, mirrored with Cline's blessing.
		const { headers } = await capturePayload({ model: freeTierDeepseek, sessionId: "session-123" });

		expect(headers).toMatchObject({
			"http-referer": "https://cline.bot",
			"x-title": "Cline",
			"x-is-multiroot": "false",
			"x-client-type": "cline-sdk",
			"x-client-version": "3.0.58",
			"x-platform": process.platform,
			"x-platform-version": "3.0.54",
			"x-core-version": "0.0.79",
			"x-task-id": "session-123",
			"user-agent": "Cline/3.0.58",
		});
		expect(headers.authorization).toBe("Bearer test-key");
	});

	it("sends free-tier ids unprefixed on the wire", async () => {
		// Free models ride usage billing under full OpenRouter-style ids; the
		// bucket-derived raw wire tag keeps the cline-pass prefix off them. Built
		// as a synthetic spec so the test pins the transport contract, not the
		// current bundle contents.
		const { payload } = await capturePayload({ model: freeTierDeepseek, reasoning: Effort.Low });

		expect(payload.model).toBe("deepseek/deepseek-v4-flash");
		expect(payload.reasoning_effort).toBe("low");
		expect(payload.max_completion_tokens).toBe(64);
	});

	it("replays reasoning on free-tier DeepSeek tool continuations with the gateway field", async () => {
		const firstFetch: FetchImpl = Object.assign(async () => toolCompletionResponse(freeTierDeepseek.id), {
			preconnect: fetch.preconnect,
		});
		const assistant = await streamOpenAICompletions(freeTierDeepseek, context, {
			apiKey: "test-key",
			fetch: firstFetch,
			maxTokens: 64,
			reasoning: Effort.Low,
		}).result();
		const { payload } = await capturePayload({
			model: freeTierDeepseek,
			context: {
				...context,
				messages: [
					...context.messages,
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_marker",
						toolName: "get_marker",
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			reasoning: Effort.Low,
		});
		const messages = payload.messages as Array<Record<string, unknown>>;
		const wireAssistant = messages.find(message => message.role === "assistant");

		expect(payload.model).toBe("deepseek/deepseek-v4-flash");
		// DeepSeek family requires reasoning replay on tool continuations even on
		// the free tier; the gateway field is `reasoning`, not `reasoning_content`.
		expect(wireAssistant?.reasoning).toBe("Inspect the marker.");
		expect(wireAssistant?.reasoning_content).toBeUndefined();
	});

	it("downgrades a forced ClinePass Qwen tool choice to auto while preserving reasoning", async () => {
		const { payload } = await capturePayload({
			modelId: "qwen3.7-max",
			reasoning: Effort.High,
			toolChoice: { type: "tool", name: "get_marker" },
		});

		expect(payload.model).toBe("cline-pass/qwen3.7-max");
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.tool_choice).toBe("auto");
	});

	it("maps Qwen budget reasoning to Cline's nested max_tokens field", async () => {
		const { payload } = await capturePayload({
			modelId: "qwen3.7-plus",
			reasoning: Effort.High,
		});

		expect(payload.reasoning).toEqual({ max_tokens: 104_857 });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("marks Cline Qwen prompt content for gateway caching", async () => {
		const { payload } = await capturePayload({
			modelId: "qwen3.8-max",
			reasoning: Effort.High,
		});
		const messages = payload.messages as Array<{ role: string; content: unknown }>;
		const user = messages.find(message => message.role === "user");

		expect(user?.content).toEqual([{ type: "text", text: "Get marker 42", cache_control: { type: "ephemeral" } }]);
	});

	it("uses Cline's billed gateway cost instead of catalog pricing", async () => {
		const { usage } = await capturePayload({
			rawUsage: {
				prompt_tokens: 1_000,
				completion_tokens: 100,
				cost: 0.001,
				market_cost: 0.02,
			},
		});

		expect(usage.cost.total).toBe(0.001);
		expect(usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite).toBeCloseTo(0.001);
	});

	it("serializes a Qwen tool continuation without requiring reasoning replay", async () => {
		const model = getBundledModel<"openai-completions">("cline-pass", "qwen3.7-max") as Model<"openai-completions">;
		const firstFetch: FetchImpl = Object.assign(async () => toolCompletionResponse(model.id), {
			preconnect: fetch.preconnect,
		});
		const assistant = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: firstFetch,
			maxTokens: 64,
			reasoning: Effort.High,
		}).result();
		const { payload } = await capturePayload({
			modelId: "qwen3.7-max",
			context: {
				...context,
				messages: [
					...context.messages,
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_marker",
						toolName: "get_marker",
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			reasoning: Effort.High,
		});
		const messages = payload.messages as Array<Record<string, unknown>>;
		const wireAssistant = messages.find(message => message.role === "assistant");

		expect(assistant.content).toContainEqual({
			type: "thinking",
			thinking: "Inspect the marker.",
			thinkingSignature: "reasoning",
		});
		expect(wireAssistant?.tool_calls).toBeArray();
		expect(wireAssistant?.reasoning).toBeUndefined();
	});
});
