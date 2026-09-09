/**
 * Wafer Serverless provider wiring.
 *
 * Wafer Serverless exposes an OpenAI-compatible base URL
 * (`https://pass.wafer.ai/v1`) and routes through `openai-completions`. The
 * catalog id matches the wire id (no rewrite). These tests defend the bundled
 * catalog contract and the case-sensitive id pass-through against the wire.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { waferServerlessModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Wafer Serverless provider", () => {
	it("ships the documented Serverless catalog (GLM-5.1, Qwen3.5, Qwen3.6, Qwen3.7-Max, Kimi-K2.6, DeepSeek V4 Flash/Pro)", () => {
		const glm = getBundledModel<"openai-completions">("wafer-serverless", "GLM-5.1");
		expect(glm).toBeDefined();
		expect(glm.provider).toBe("wafer-serverless");
		expect(glm.baseUrl).toBe("https://pass.wafer.ai/v1");
		expect(glm.compatConfig?.thinkingFormat).toBe("zai");

		const qwen35 = getBundledModel<"openai-completions">("wafer-serverless", "Qwen3.5-397B-A17B");
		expect(qwen35).toBeDefined();
		expect(qwen35.provider).toBe("wafer-serverless");

		const kimi = getBundledModel<"openai-completions">("wafer-serverless", "Kimi-K2.6");
		expect(kimi).toBeDefined();
		expect(kimi.contextWindow).toBe(262144);
		// Kimi-K2.6 routes to Moonshot upstream, which uses zai-style binary
		// `thinking: { type: "enabled" | "disabled" }`. Locked in explicitly so a
		// future regen with credentials cannot silently strip it (auto-detect
		// would mis-pick "openai" because the Wafer baseUrl/provider doesn't match
		// the api.moonshot.ai / api.kimi.com URL patterns in `buildOpenAICompat`).
		expect(kimi.compatConfig?.thinkingFormat).toBe("zai");
		// Kimi-K2.6's retail Serverless rate per wafer.ai (= API cents × 0.0125):
		// $1.425 in / $6.00 out / $0.2375 cached.
		expect(kimi.cost).toEqual({ input: 1.425, output: 6, cacheRead: 0.2375, cacheWrite: 0 });

		const qwen36 = getBundledModel<"openai-completions">("wafer-serverless", "Qwen3.6-35B-A3B");
		expect(qwen36).toBeDefined();
		// Qwen3.6 advertises 256k context and vision per the live /v1/models response.
		expect(qwen36.contextWindow).toBe(256000);
		expect(qwen36.input).toEqual(["text", "image"]);

		const qwen37max = getBundledModel<"openai-completions">("wafer-serverless", "qwen3.7-max");
		expect(qwen37max).toBeDefined();
		// Wafer's canonical id is lowercase `qwen3.7-max` — must round-trip verbatim.
		expect(qwen37max.id).toBe("qwen3.7-max");
		expect(qwen37max.name).toBe("Qwen3.7 Max");
		expect(qwen37max.reasoning).toBe(true);
		// qwen3.7-max routes to Alibaba upstream; native wire format is `enable_thinking`.
		// The bundled entry leaves `thinkingFormat` unset so the build-time detection
		// in `buildOpenAICompat` picks "qwen" from the lowercase id.
		expect(qwen37max.compatConfig?.thinkingFormat).toBeUndefined();

		const dsFlash = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-flash");
		expect(dsFlash).toBeDefined();
		// DeepSeek V4 family uses `reasoning_effort`, not zai's `thinking: {type}`.
		// Bundled entry must NOT pin `thinkingFormat: "zai"` — `buildOpenAICompat`
		// auto-picks "openai" (default) from the deepseek-* id pattern at build time.
		expect(dsFlash.compatConfig?.thinkingFormat).toBeUndefined();
		expect(dsFlash.contextWindow).toBe(1000000);
		expect(dsFlash.reasoning).toBe(true);
		expect(dsFlash.compat.reasoningContentField).toBe("reasoning_content");

		const dsPro = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-pro");
		expect(dsPro).toBeDefined();
		expect(dsPro.contextWindow).toBe(1000000);
		expect(dsPro.reasoning).toBe(true);
		expect(dsPro.compatConfig?.thinkingFormat).toBeUndefined();
	});

	it("preserves the catalog id verbatim on the wire (no rewrite, case-sensitive)", async () => {
		const model = getBundledModel<"openai-completions">("wafer-serverless", "GLM-5.1");
		const captured: { url: string | null; body: string | null } = { url: null, body: null };
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse(["[DONE]"]);
		};

		const context: Context = {
			systemPrompt: ["t"],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "wfr_test",
			fetch: fetchMock,
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.url).toBe("https://pass.wafer.ai/v1/chat/completions");
		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { model?: unknown };
		// Wafer's docs note model names are case-insensitive on input, but the
		// canonical id has mixed case; we must round-trip it unchanged so users
		// who pin `GLM-5.1` don't end up with usage rows under `glm-5.1` or
		// hitting the upstream 404 path.
		expect(parsed.model).toBe("GLM-5.1");
	});
});

describe("Wafer dynamic discovery mapper", () => {
	// Synthetic /v1/models response that exercises every upstream provider Wafer
	// announces, including a deliberately-unknown one. The mapper must:
	//  - pin `thinkingFormat: "zai"` for upstreams whose native API uses the
	//    z.ai-style binary thinking parameter (zai, moonshotai),
	//  - pin `thinkingFormat: "qwen"` for Alibaba qwen models,
	//  - leave `thinkingFormat` unset for deepseek (uses `reasoning_effort`)
	//    and unknown upstreams, so `detectOpenAICompat` picks the safe default
	//    from the id pattern at request time.
	function mockWaferModelsResponse(entries: Array<Record<string, unknown>>): FetchImpl {
		return async () =>
			new Response(JSON.stringify({ object: "list", data: entries }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
	}

	function makeWaferEntry(id: string, upstream: string, opts: { reasoning?: boolean; vision?: boolean } = {}) {
		return {
			id,
			object: "model",
			max_model_len: 100000,
			wafer: {
				display_name: id,
				tier: "serverless_only",
				provider: upstream,
				context_length: 100000,
				capabilities: {
					vision: opts.vision === true,
					tools: true,
					reasoning: opts.reasoning === true,
				},
				pricing: {
					currency: "usd",
					input_cents_per_million: 100,
					output_cents_per_million: 300,
					cache_read_cents_per_million: 10,
				},
			},
		};
	}

	it("picks thinkingFormat from the wafer.provider envelope per upstream", async () => {
		const fetchMock = mockWaferModelsResponse([
			makeWaferEntry("GLM-fake", "zai", { reasoning: true }),
			makeWaferEntry("Kimi-fake", "moonshotai", { reasoning: true }),
			makeWaferEntry("qwen-fake", "qwen", { reasoning: true }),
			makeWaferEntry("deepseek-fake", "deepseek", { reasoning: true }),
			makeWaferEntry("mystery-fake", "future-provider", { reasoning: true }),
			makeWaferEntry("nothink-fake", "zai", { reasoning: false }),
		]);

		const manager = createModelManager(waferServerlessModelManagerOptions({ apiKey: "wfr_test", fetch: fetchMock }));
		const { models } = await manager.refresh("online");

		const byId = new Map(models.map(m => [m.id, m as Model<"openai-completions">]));
		expect(byId.get("GLM-fake")?.compatConfig?.thinkingFormat).toBe("zai");
		expect(byId.get("Kimi-fake")?.compatConfig?.thinkingFormat).toBe("zai");
		expect(byId.get("qwen-fake")?.compatConfig?.thinkingFormat).toBe("qwen");
		// deepseek and unknown upstreams: thinkingFormat unset so `buildOpenAICompat`
		// picks from the id pattern at build time (deepseek → "openai" effort).
		expect(byId.get("deepseek-fake")?.compatConfig?.thinkingFormat).toBeUndefined();
		expect(byId.get("mystery-fake")?.compatConfig?.thinkingFormat).toBeUndefined();
		// Non-reasoning entries never receive a thinkingFormat hint regardless of upstream.
		expect(byId.get("nothink-fake")?.compatConfig?.thinkingFormat).toBeUndefined();
		expect(byId.get("nothink-fake")?.reasoning).toBe(false);
		// All entries keep reasoning_content as the canonical field for reasoning models.
		for (const id of ["GLM-fake", "Kimi-fake", "qwen-fake", "deepseek-fake", "mystery-fake"]) {
			expect(byId.get(id)?.compatConfig?.reasoningContentField).toBe("reasoning_content");
		}
	});

	it("applies retail × 0.0125 for Serverless pricing", async () => {
		// `wafer.pricing` is in Wafer's internal cents/M unit. Serverless is
		// pay-as-you-go and applies the empirical × 0.0125 conversion to match
		// wafer.ai's published retail rates (120 cents → $1.50/M).
		const sharedEntry = {
			id: "Shared-fake",
			object: "model",
			max_model_len: 100000,
			wafer: {
				display_name: "Shared-fake",
				tier: "pass_included",
				provider: "zai",
				context_length: 100000,
				capabilities: { vision: false, tools: true, reasoning: true },
				pricing: {
					currency: "usd",
					input_cents_per_million: 120,
					output_cents_per_million: 360,
					cache_read_cents_per_million: 12,
				},
			},
		};

		const srvFetchMock = mockWaferModelsResponse([sharedEntry]);
		const srvManager = createModelManager(
			waferServerlessModelManagerOptions({ apiKey: "wfr_test", fetch: srvFetchMock }),
		);
		const srvResult = await srvManager.refresh("online");
		const srvModel = srvResult.models.find(m => m.id === "Shared-fake");
		expect(srvModel).toBeDefined();
		// 120 × 0.0125 = 1.50, 360 × 0.0125 = 4.50, 12 × 0.0125 = 0.15 — matches
		// the wafer.ai Serverless rate card for GLM-5.1.
		expect(srvModel?.cost).toEqual({ input: 1.5, output: 4.5, cacheRead: 0.15, cacheWrite: 0 });
	});
});
