import { describe, expect, test } from "bun:test";
import {
	discoverExLlama3Models,
	discoverExLlama3ModelRuntimeMetadata,
	discoverLlamaCppModels,
	normalizeExLlama3BaseUrl,
} from "../src/config/model-discovery";
import type { DiscoveryContext, DiscoveryProviderConfig } from "../src/config/model-discovery";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

/**
 * TabbyAPI serves its OpenAI surface under `/v1` and `/props` at the root, and
 * implements both in llama-server's shape on purpose. A route probe asserts the
 * exact URL each caller builds, so a future change to either base cannot silently
 * point discovery at a path TabbyAPI does not serve.
 */
function tabbyContext(routes: Record<string, unknown>): DiscoveryContext {
	const seen: string[] = [];
	const fetch: FetchImpl = async input => {
		const url = typeof input === "string" ? input : String(input);
		seen.push(url);
		for (const [path, payload] of Object.entries(routes)) {
			if (url.endsWith(path)) {
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response("not found", { status: 404 });
	};
	return {
		fetch,
		getBearerApiKeyResolver: async () => undefined,
	} as unknown as DiscoveryContext;
}

function exl3Config(overrides?: Partial<DiscoveryProviderConfig>): DiscoveryProviderConfig {
	return {
		provider: "exllama3",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:5000/v1",
		discovery: { type: "exllama3" },
		...overrides,
	};
}

const MODELS_ROUTE = "/v1/models";
const PROPS_ROUTE = "/props";

describe("normalizeExLlama3BaseUrl", () => {
	test("roots the server by stripping the /v1 chat suffix", () => {
		expect(normalizeExLlama3BaseUrl("http://127.0.0.1:5000/v1")).toBe("http://127.0.0.1:5000");
		// A trailing slash and an already-root URL must land on the same base.
		expect(normalizeExLlama3BaseUrl("http://127.0.0.1:5000/v1/")).toBe("http://127.0.0.1:5000");
		expect(normalizeExLlama3BaseUrl("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
		expect(normalizeExLlama3BaseUrl()).toBe("http://127.0.0.1:5000");
	});
});

describe("discoverExLlama3Models", () => {
	test("probes /v1/models and root /props, and stamps the exllama3 backend", async () => {
		const requested: string[] = [];
		const ctx = {
			fetch: (async input => {
				const url = typeof input === "string" ? input : String(input);
				requested.push(url);
				if (url.endsWith(MODELS_ROUTE)) {
					return new Response(
						JSON.stringify({ data: [{ id: "Qwama-0.5B-Instruct", meta: { n_ctx: 8192 }, parameters: null }] }),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				}
				if (url.endsWith(PROPS_ROUTE)) {
					return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("nope", { status: 404 });
			}) as FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		} as unknown as DiscoveryContext;

		const models = await discoverExLlama3Models(exl3Config(), ctx);

		// The roster is OpenAI-routed; /props is not — the inverse of llama.cpp.
		expect(requested).toContain("http://127.0.0.1:5000/v1/models");
		expect(requested).toContain("http://127.0.0.1:5000/props");
		expect(requested).not.toContain("http://127.0.0.1:5000/models");

		const model = models[0];
		expect(model.contextWindow).toBe(8192);
		// Requests must post to the chat root, not the native root.
		expect(model.baseUrl).toBe("http://127.0.0.1:5000/v1");
		// The KDL cascade resolves provider rules against `providerType`, so anything
		// other than "exllama3" here would silently apply another backend's rules.
		expect(model.providerType).toBe("exllama3");
	});

	test("prefers the loaded window over the trained window", async () => {
		const ctx = tabbyContext({
			[MODELS_ROUTE]: {
				data: [
					{
						id: "Qwen3.8-27B-exl3",
						// 256K-trained checkpoint booted at 32K.
						meta: { n_ctx: 32768, n_ctx_train: 262144 },
						parameters: { max_seq_len: 32768 },
					},
				],
			},
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } },
		});

		const models = await discoverExLlama3Models(exl3Config(), ctx);
		expect(models[0]?.contextWindow).toBe(32768);
		expect(models[0]?.input).toEqual(["text"]);
	});

	test("reads vision from the model card, which the OpenAI schema has no field for", async () => {
		const ctx = tabbyContext({
			[MODELS_ROUTE]: {
				data: [{ id: "vision-exl3", parameters: { max_seq_len: 32768, use_vision: true } }],
			},
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } },
		});

		const models = await discoverExLlama3Models(exl3Config(), ctx);
		// The card is per-model and beats the server-wide /props modality flag.
		expect(models[0]?.input).toEqual(["text", "image"]);
	});

	test("drops HuggingFace's cache directory, which TabbyAPI lists as a model", async () => {
		// With an admin key TabbyAPI lists every subdirectory of `model_dir`, and
		// `iterdir()` filters nothing, so `.cache` arrives in the roster.
		const ctx = tabbyContext({
			[MODELS_ROUTE]: {
				data: [
					{ id: ".cache" },
					{ id: ".hidden-exl3" },
					{ id: "real-model-exl3", meta: { n_ctx: 8192 }, parameters: null },
				],
			},
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 8192 } },
		});

		const models = await discoverExLlama3Models(exl3Config(), ctx);
		expect(models.map(model => model.id)).toEqual(["real-model-exl3"]);
	});

	test("falls back to /props when the roster carries no context at all", async () => {
		const ctx = tabbyContext({
			[MODELS_ROUTE]: { data: [{ id: "bare-exl3", parameters: null }] },
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 65536 }, modalities: { vision: true } },
		});

		const models = await discoverExLlama3Models(exl3Config(), ctx);
		expect(models[0]?.contextWindow).toBe(65536);
		expect(models[0]?.input).toEqual(["text", "image"]);
	});
});

describe("discoverExLlama3ModelRuntimeMetadata", () => {
	test("re-reads the window a reloaded model is actually serving", async () => {
		// Roster captured before the load reported nothing useful; after loading at
		// 16K the server reports the real window.
		const ctx = tabbyContext({
			[MODELS_ROUTE]: {
				data: [{ id: "Qwen3.8-27B-exl3", meta: { n_ctx: 16384, n_ctx_train: 262144 }, parameters: null }],
			},
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 16384 } },
		});

		const metadata = await discoverExLlama3ModelRuntimeMetadata(
			{ provider: "exllama3", id: "Qwen3.8-27B-exl3", baseUrl: "http://127.0.0.1:5000/v1", headers: {} },
			ctx,
		);

		expect(metadata?.contextWindow).toBe(16384);
		// S1: the re-probe now returns maxTokens so a reload at a smaller window
		// re-clamps the selected model's maxTokens (not just its contextWindow).
		expect(metadata?.maxTokens).toBe(16384);
	});

	test("returns undefined for a model the server does not list", async () => {
		const ctx = tabbyContext({
			[MODELS_ROUTE]: { data: [{ id: "other-model", parameters: null }] },
			[PROPS_ROUTE]: { default_generation_settings: { n_ctx: 4096 } },
		});

		const metadata = await discoverExLlama3ModelRuntimeMetadata(
			{ provider: "exllama3", id: "Qwen3.8-27B-exl3", baseUrl: "http://127.0.0.1:5000/v1", headers: {} },
			ctx,
		);

		expect(metadata).toBeUndefined();
	});

	test("resolves undefined when the probe rejects (a stopped server must not break selection)", async () => {
		// The blocking-defect regression: a stopped TabbyAPI (ECONNREFUSED) or a
		// timeout abort must resolve undefined, not reject. The unguarded callers
		// (sdk.ts session creation, model-controls setModel) await this without a
		// catch, so a rejection here breaks session startup and /model switches.
		const ctx = {
			fetch: (async () => {
				throw new Error("Unable to connect");
			}) as FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		} as unknown as DiscoveryContext;

		const metadata = await discoverExLlama3ModelRuntimeMetadata(
			{ provider: "exllama3", id: "Qwen3.8-27B-exl3", baseUrl: "http://127.0.0.1:5000/v1", headers: {} },
			ctx,
		);

		expect(metadata).toBeUndefined();
	});
});

describe("exllama3 auth-rejection classification (M1)", () => {
	test("classifies a 401 as an auth rejection (the server wants a key)", async () => {
		const ctx = {
			fetch: (async () => new Response("unauthorized", { status: 401 })) as FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		} as unknown as DiscoveryContext;

		await expect(discoverExLlama3Models(exl3Config(), ctx)).rejects.toMatchObject({ status: 401 });
	});

	test("classifies a 403 as a plain failure, not an auth rejection (AirPlay on port 5000)", async () => {
		// macOS AirPlay Receiver answers 403 on port 5000. A real TabbyAPI never
		// 403s /v1/models for auth (it always 401s), so a 403 must surface as a
		// plain failure (unavailable), not an auth prompt (unauthenticated).
		const ctx = {
			fetch: (async () => new Response("forbidden", { status: 403 })) as FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		} as unknown as DiscoveryContext;

		const error = await discoverExLlama3Models(exl3Config(), ctx).catch(error => error);
		expect(error).toBeInstanceOf(Error);
		// A plain failure has no HTTP status; an auth rejection would carry one.
		expect((error as { status?: number }).status).toBeUndefined();
	});

	test("llama.cpp still classifies a 403 as an auth rejection (unchanged)", async () => {
		const ctx = {
			fetch: (async () => new Response("forbidden", { status: 403 })) as FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		} as unknown as DiscoveryContext;

		const config: DiscoveryProviderConfig = {
			provider: "llama.cpp",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8080/v1",
			discovery: { type: "llama.cpp" },
		};

		await expect(discoverLlamaCppModels(config, ctx)).rejects.toMatchObject({ status: 403 });
	});
});
