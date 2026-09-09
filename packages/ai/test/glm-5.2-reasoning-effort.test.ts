import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

// GLM-5.2 reasoning-effort dialects diverge per host (verified against live
// endpoints): a direct GLM host (Fireworks) exposes a real `max` top tier and
// keeps its distinct lower tiers (with the `minimal -> none` host quirk),
// whereas OpenRouter rejects `max` (HTTP 400) and treats `xhigh` as its own
// max tier. The catalog bakes the right ladder/`thinking.effortMap`; these
// tests pin the resulting wire value so a future change can't silently 400
// either host.
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

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

async function captureChatEffort(model: Model<"openai-completions">, reasoning: Effort): Promise<unknown> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchMock, reasoning })) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured chat-completions request");
	return body.reasoning_effort;
}

async function captureResponsesEffort(model: Model<"openrouter">, reasoning: Effort): Promise<unknown> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return responsesSse();
	});
	// OpenRouter is a pseudo-API driven through the Responses surface (stream.ts
	// defaults `api: "openrouter"` to streamOpenAIResponses).
	const responsesModel = model as unknown as Model<"openai-responses">;
	for await (const event of streamOpenAIResponses(responsesModel, context, {
		apiKey: "k",
		fetch: fetchMock,
		reasoning,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured Responses request");
	const reasoningParam = body.reasoning;
	return reasoningParam && typeof reasoningParam === "object" && "effort" in reasoningParam
		? reasoningParam.effort
		: undefined;
}

const fireworks = buildModel({
	id: "glm-5.2",
	name: "GLM-5.2",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 131_072,
} as ModelSpec<"openai-completions">) as Model<"openai-completions">;

const openRouter = buildModel({
	id: "z-ai/glm-5.2",
	name: "GLM 5.2",
	api: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 131_072,
} as ModelSpec<"openrouter">) as Model<"openrouter">;

describe("GLM-5.2 reasoning effort wire mapping", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends reasoning_effort:max for the real max tier on a direct GLM host (Fireworks), lower tiers literal", async () => {
		expect(await captureChatEffort(fireworks, Effort.Max)).toBe("max");
		expect(await captureChatEffort(fireworks, Effort.High)).toBe("high");
		expect(await captureChatEffort(fireworks, Effort.Medium)).toBe("medium");
		// Fireworks rejects literal `minimal`; the host quirk merge keeps `minimal -> none`.
		expect(await captureChatEffort(fireworks, Effort.Minimal)).toBe("none");
	});

	it("sends the literal xhigh tier to OpenRouter (which rejects max) via the Responses surface", async () => {
		expect(await captureResponsesEffort(openRouter, Effort.XHigh)).toBe("xhigh");
	});
});
