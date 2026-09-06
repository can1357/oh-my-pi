import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { exllamav3ModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "http://127.0.0.1:5000/v1";

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function tabbyFetch(modelsPayload: unknown, modelCard: (() => Response) | null): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/models")) return jsonResponse(modelsPayload);
		if (url.endsWith("/model")) return modelCard ? modelCard() : new Response("not found", { status: 404 });
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
}

describe("ExLlamaV3 (TabbyAPI) provider discovery", () => {
	test("keeps only the loaded model, enriched from the /v1/model card", async () => {
		// An admin key makes /v1/models enumerate every directory plus dummy
		// OpenAI compatibility ids; only the loaded card is servable, and its
		// parameters (absent from list entries) carry the context window.
		const fetchMock = tabbyFetch(
			{
				data: [
					{ id: "Qwen3.8-Flash-Next-exl3", object: "model", owned_by: "tabbyAPI", parameters: null },
					{ id: "unloaded-directory-model", object: "model", owned_by: "tabbyAPI", parameters: null },
					{ id: "gpt-4", object: "model", owned_by: "tabbyAPI", parameters: null },
				],
			},
			() =>
				jsonResponse({
					id: "Qwen3.8-Flash-Next-exl3",
					parameters: { max_seq_len: 262144, use_vision: true },
				}),
		);

		const models = await exllamav3ModelManagerOptions({ baseUrl: BASE_URL, fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["Qwen3.8-Flash-Next-exl3"]);
		expect(models?.[0]).toMatchObject({
			provider: "exllamav3",
			api: "openai-completions",
			contextWindow: 262144,
			input: ["text", "image"],
			reasoning: true,
		});
	});

	test("falls back to the raw list and entry parameters when no model card answers", async () => {
		const fetchMock = tabbyFetch(
			{
				data: [
					{ id: "qwen3.8-27b", object: "model", parameters: { max_seq_len: 131072 } },
					{ id: "qwen2.5-coder-7b", object: "model", parameters: null },
				],
			},
			null,
		);

		const models = await exllamav3ModelManagerOptions({ baseUrl: BASE_URL, fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.find(model => model.id === "qwen3.8-27b")).toMatchObject({ contextWindow: 131072 });
		// Qwen 3.8+ open weights always think, so the effort dial lights up
		// despite silent capability metadata; older Qwen keeps the default.
		expect(models?.find(model => model.id === "qwen3.8-27b")?.reasoning).toBe(true);
		expect(models?.find(model => model.id === "qwen2.5-coder-7b")?.reasoning).toBe(false);
	});

	test("recovers when the loaded model changes between the card and list requests", async () => {
		// TabbyAPI reloads A → B after discovery fetched A's card: the first
		// pass filters everything out, and an authoritative empty result would
		// prune the catalog even though B is servable.
		let modelCardCalls = 0;
		const fetchMock: FetchImpl = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith("/models")) {
				return jsonResponse({ data: [{ id: "GLM-5.2-exl3", object: "model", parameters: null }] });
			}
			modelCardCalls++;
			return jsonResponse({
				id: modelCardCalls === 1 ? "Qwen3.8-Flash-Next-exl3" : "GLM-5.2-exl3",
				parameters: { max_seq_len: modelCardCalls === 1 ? 262_144 : 131_072, use_vision: false },
			});
		}) as FetchImpl;

		const models = await exllamav3ModelManagerOptions({ baseUrl: BASE_URL, fetch: fetchMock }).fetchDynamicModels?.();

		expect(modelCardCalls).toBe(2);
		expect(models?.map(model => model.id)).toEqual(["GLM-5.2-exl3"]);
		expect(models?.[0]?.contextWindow).toBe(131_072);
	});

	test("reports failed discovery when the card persistently names a reloaded-away model", async () => {
		// Two card/list rounds disagree (reload storm or admin-key directory
		// churn). Mapping the admin-key list would publish unservable
		// directory/dummy ids as an authoritative catalog; a null result keeps
		// the last cached catalog instead.
		const fetchMock: FetchImpl = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith("/models")) {
				return jsonResponse({
					data: [{ id: "GLM-5.2-exl3", object: "model", parameters: { max_seq_len: 131_072 } }],
				});
			}
			return jsonResponse({ id: "Qwen3.8-Flash-Next-exl3", parameters: { max_seq_len: 262_144 } });
		}) as FetchImpl;

		const models = await exllamav3ModelManagerOptions({ baseUrl: BASE_URL, fetch: fetchMock }).fetchDynamicModels?.();

		expect(models).toBeNull();
	});

	test("retains the cache when the revalidation card probe fails after a mismatch", async () => {
		// First round: valid card A, list B (mismatch — filtering is required).
		// Second card probe fails (timeout/401/404): the raw admin-key list
		// must NOT be published as an authoritative catalog; report failed
		// discovery and keep the last cached catalog.
		let modelCardCalls = 0;
		const fetchMock: FetchImpl = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith("/models")) {
				return jsonResponse({ data: [{ id: "GLM-5.2-exl3", object: "model", parameters: null }] });
			}
			modelCardCalls++;
			if (modelCardCalls === 1) {
				return jsonResponse({ id: "Qwen3.8-Flash-Next-exl3", parameters: { max_seq_len: 262_144 } });
			}
			return new Response("not found", { status: 404 });
		}) as FetchImpl;

		const models = await exllamav3ModelManagerOptions({ baseUrl: BASE_URL, fetch: fetchMock }).fetchDynamicModels?.();

		expect(modelCardCalls).toBe(2);
		expect(models).toBeNull();
	});

	test("publishes an empty catalog only for TabbyAPI's own no-models 503, not unrelated 503s", async () => {
		// TabbyAPI's check_model_container raises 503 with detail "No models
		// currently loaded."; an unrelated 503 (transient failure, reverse
		// proxy) is a probe failure and keeps the raw-list fallback.
		const directoryListing = {
			data: [
				{ id: "unloaded-directory-model", object: "model", parameters: null },
				{ id: "gpt-4", object: "model", parameters: null },
			],
		};
		const probe = async (cardStatus: Response) => {
			let listCalls = 0;
			const fetchMock: FetchImpl = (async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.endsWith("/models")) {
					listCalls++;
					return jsonResponse(directoryListing);
				}
				return cardStatus;
			}) as FetchImpl;
			const models = await exllamav3ModelManagerOptions({
				baseUrl: BASE_URL,
				fetch: fetchMock,
			}).fetchDynamicModels?.();
			return { models, listCalls };
		};

		const tabbyNoModels = await probe(
			new Response(JSON.stringify({ detail: "No models are currently loaded." }), { status: 503 }),
		);
		expect(tabbyNoModels.models).toEqual([]);
		expect(tabbyNoModels.listCalls).toBe(0);

		const proxyError = await probe(new Response("Service Unavailable", { status: 503 }));
		expect(proxyError.models?.map(model => model.id)).toEqual(["gpt-4", "unloaded-directory-model"]);
	});

	test("routes thinking through the flat enable_thinking dialect like llama.cpp", () => {
		// TabbyAPI accepts top-level enable_thinking / reasoning_effort
		// directly (forwarded into the chat template), so exllamav3 rides the
		// llama.cpp dialect rather than vLLM's chat_template_kwargs one.
		const model = buildModel({
			id: "qwen3.8-27b-exl3",
			name: "qwen3.8-27b-exl3",
			api: "openai-completions",
			provider: "exllamav3",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: null,
		});
		expect(model.compat.thinkingFormat).toBe("qwen");
		expect(model.compat.reasoningDisableMode).toBe("qwen-enable-thinking-false");
		// Local OpenAI-compat backend: replay reasoning_content so the chat
		// template rebuilds <think> blocks, and named tool_choice is native.
		expect(model.compat.replayReasoningContent).toBe(true);
		expect(model.compat.supportsNamedToolChoice).toBe(true);
	});
});
