/**
 * Wire-contract tests for CoralBricks' OpenAI-compatible chat endpoint,
 * grounded in Coral's API reference (https://www.coralbricks.ai/docs.md,
 * 2026-10-02) and the reference Coral pi provider extension's synbad-validated
 * runs (2026-09): plain Chat Completions at https://inference.coralbricks.ai/v1,
 * `reasoning_effort` as the only thinking control, reasoning streamed back as
 * `delta.reasoning_content`, and free cached reads with per-model cache-write
 * rates.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

const CORALBRICKS_BASE_URL = "https://inference.coralbricks.ai/v1";

function requireBundled(id: string): Model<"openai-completions"> {
	const models = getBundledModels("coralbricks") as readonly Model<"openai-completions">[];
	const model = models.find(candidate => candidate.id === id);
	if (!model) throw new Error(`bundled coralbricks model ${id} is missing`);
	return model;
}

const capturedUserTurn: Context = {
	messages: [{ role: "user", content: "What is 2+2? Answer with just the number.", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function deltaChunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-coralbricks-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta }],
	};
}

function usageChunk(model: Model<"openai-completions">, usage: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-coralbricks-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage,
	};
}

async function captureRequest(
	model: Model<"openai-completions">,
	options: { reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; disableReasoning?: boolean },
): Promise<{ url: string; authorization: string | null; payload: Record<string, unknown> }> {
	let url = "";
	let authorization: string | null = null;
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			url = input.toString();
			authorization = new Headers(init?.headers).get("authorization");
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([deltaChunk(model, { content: "4" }), usageChunk(model, {}), "[DONE]"]);
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(model, capturedUserTurn, {
		apiKey: "cb-test-key",
		fetch: fetchMock,
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected a captured request payload");
	return { url, authorization, payload };
}

describe("CoralBricks wire contract", () => {
	it("routes requests to Coral's chat-completions endpoint with the resolved key", async () => {
		const { url, authorization, payload } = await captureRequest(requireBundled("glm-5.3-fp4"), {});
		expect(url).toBe(`${CORALBRICKS_BASE_URL}/chat/completions`);
		expect(authorization).toBe("Bearer cb-test-key");
		expect(payload.model).toBe("glm-5.3-fp4");
		// Gateway dialect: no `store`, no `max_completion_tokens`.
		expect(payload.store).toBeUndefined();
		expect(payload.max_completion_tokens).toBeUndefined();
	});

	it("gates thinking on via bare reasoning_effort with no zai-dialect fields", async () => {
		const { payload } = await captureRequest(requireBundled("glm-5.3-fp4"), { reasoning: "high" });
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.thinking).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
		expect(payload.enable_thinking).toBeUndefined();
	});

	it("clamps a thinking-off request to the lowest effort (thinking cannot be disabled)", async () => {
		// The session represents an off selection as `disableReasoning: true`
		// (agent-session). Coral advertises no disable-shaped effort for the
		// GLM 5.3 SKUs (low/high/max only), so the effort-format default maps
		// the disable request to the ladder minimum instead of sending a value
		// the gateway does not accept.
		const { payload } = await captureRequest(requireBundled("glm-5.3-fp4"), { disableReasoning: true });
		expect(payload.reasoning_effort).toBe("low");
		expect(payload.thinking).toBeUndefined();
	});

	it("omits reasoning_effort when unrequested and maps thinking-off to Coral's advertised none effort", async () => {
		const unrequested = await captureRequest(requireBundled("deepseek-v4.1-flash-fast-fp4"), {});
		expect(unrequested.payload.reasoning_effort).toBeUndefined();
		// DeepSeek V4.1 Flash is the one CoralBricks SKU with a genuine off
		// value (`none`), so an off selection disables reasoning instead of
		// clamping to the lowest effort like the GLM SKUs.
		const off = await captureRequest(requireBundled("deepseek-v4.1-flash-fast-fp4"), { disableReasoning: true });
		expect(off.payload.reasoning_effort).toBe("none");
	});

	it("parses streamed reasoning_content into a thinking block ahead of content", async () => {
		const model = requireBundled("glm-5.3-fp4");
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse([
					deltaChunk(model, { reasoning_content: '1. The user asks "What is 2+2?"' }),
					deltaChunk(model, { content: "4" }),
					usageChunk(model, {}),
					"[DONE]",
				]),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(model, capturedUserTurn, {
			apiKey: "cb-test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: '1. The user asks "What is 2+2?"',
				thinkingSignature: "reasoning_content",
			},
			{ type: "text", text: "4" },
		]);
	});

	it("normalizes Coral's cache-token usage into the free-read and cache-write buckets", async () => {
		const model = requireBundled("glm-5.3-flash-fp4");
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> =>
				createSseResponse([
					deltaChunk(model, { content: "4" }),
					// Coral's usage shape: cached reads are free on every model,
					// cache writes bill at the per-model cache-write rate.
					usageChunk(model, {
						prompt_tokens: 1000,
						prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 90 },
						completion_tokens: 10,
					}),
					"[DONE]",
				]),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(model, capturedUserTurn, {
			apiKey: "cb-test-key",
			fetch: fetchMock,
		}).result();
		expect(result.usage.cacheRead).toBe(900);
		expect(result.usage.cacheWrite).toBe(90);
		expect(result.usage.cost.cacheRead).toBe(0);
		// 90 cache-write tokens at the GLM 5.3 Flash rate of $0.23/M.
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.0000207, 9);
	});
});
