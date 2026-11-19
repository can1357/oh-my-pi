import { describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createCodexModel } from "./helpers";

// End-to-end guard for the first-class `max` reasoning tier: a user-requested
// `reasoning: "max"` on a model whose ladder natively includes `Effort.Max`
// must reach every wire surface verbatim — no aliasing, no clamping. Fixtures
// use explicit thinking ladders and neutral ids so catalog detection cannot
// interfere.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const MAX_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function responsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("first-class max reasoning tier wire coverage", () => {
	it("sends reasoning_effort:max on Chat Completions", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "max-wire-chat",
			name: "Max Wire Chat",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://chat.example.test/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "openai",
				supportsReasoningParams: true,
				supportsReasoningEffort: true,
			},
			thinking: { mode: "effort", efforts: MAX_LADDER },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		let body: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return chatSse();
		});
		for await (const event of streamOpenAICompletions(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			reasoning: "max",
		})) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body?.reasoning_effort).toBe("max");
	});

	it("sends reasoning.effort:max on the Responses surface", async () => {
		const model: Model<"openai-responses"> = buildModel({
			id: "max-wire-responses",
			name: "Max Wire Responses",
			api: "openai-responses",
			provider: "custom-responses",
			baseUrl: "https://responses.example.test/v1",
			reasoning: true,
			compat: {
				supportsReasoningParams: true,
				supportsReasoningEffort: true,
			},
			thinking: { mode: "effort", efforts: MAX_LADDER },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		let body: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return responsesSse();
		});
		for await (const event of streamOpenAIResponses(model, context, {
			apiKey: "k",
			fetch: fetchMock,
			reasoning: "max",
		})) {
			if (event.type === "done" || event.type === "error") break;
		}
		const reasoningParam = body?.reasoning as { effort?: string } | undefined;
		expect(reasoningParam?.effort).toBe("max");
	});

	it("sends reasoning.effort:max through the Codex request transformer", async () => {
		const model = createCodexModel("codex-max-wire", {
			thinking: { mode: "effort", efforts: MAX_LADDER },
		});
		const transformed = await transformRequestBody({ model: model.id, input: [] }, model, {
			reasoningEffort: "max",
		});
		expect(transformed.reasoning?.effort).toBe("max");
	});

	it("sends output_config.effort:max on Anthropic adaptive thinking", async () => {
		const model = buildModel({
			id: "adaptive-max-wire",
			name: "Adaptive Max Wire",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinking: { mode: "anthropic-adaptive", efforts: MAX_LADDER },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const controller = new AbortController();
		controller.abort();
		streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			isOAuth: false,
			signal: controller.signal,
			thinkingEnabled: true,
			reasoning: Effort.Max,
			onPayload: payload => resolve(payload),
		});
		const payload = (await promise) as { output_config?: { effort?: string } };
		expect(payload.output_config).toEqual({ effort: "max" });
	});
});
