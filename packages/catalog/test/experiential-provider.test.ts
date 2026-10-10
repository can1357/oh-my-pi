import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { experientialModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { EXPERIENTIAL_API_BASE_URL, normalizeExperientialBaseUrl } from "@oh-my-pi/pi-catalog/wire/experiential";

/**
 * Rows copied from a live `GET https://api.experientiallabs.ai/v1/models`
 * response (2026-10-10), trimmed to the fields discovery reads.
 */
const ROWS = {
	glmAbliterated: {
		id: "glm-5.3-flash-abliterated",
		object: "model",
		owned_by: "exp",
		supports_completions: true,
		supports_embeddings: null,
		emits_images: false,
		supports_tools: true,
		supports_reasoning: true,
		reasoning_effort: "max",
		supported_reasoning_efforts: ["low", "high", "max"],
		chat_max_tokens_field: "max_tokens",
		context_window_tokens: 1048576,
		maximum_output_tokens: 131072,
		pricing: {
			input_nano_usd_per_million_tokens: 150000000,
			cached_input_nano_usd_per_million_tokens: 30000000,
			output_nano_usd_per_million_tokens: 500000000,
		},
	},
	lingFree: {
		id: "ling-3.1-flash",
		object: "model",
		owned_by: "exp",
		supports_completions: true,
		supports_embeddings: null,
		emits_images: false,
		supports_tools: true,
		supports_reasoning: true,
		reasoning_effort: "medium",
		supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		chat_max_tokens_field: null,
		context_window_tokens: 262144,
		maximum_output_tokens: 32768,
		pricing: {
			input_nano_usd_per_million_tokens: 0,
			cached_input_nano_usd_per_million_tokens: 0,
			output_nano_usd_per_million_tokens: 0,
		},
	},
	gpt5: {
		id: "gpt-5",
		object: "model",
		owned_by: "exp",
		supports_completions: true,
		supports_reasoning: true,
		reasoning_effort: "medium",
		supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
		chat_max_tokens_field: "max_completion_tokens",
		context_window_tokens: 400000,
		maximum_output_tokens: 128000,
		pricing: {
			input_nano_usd_per_million_tokens: 1250000000,
			output_nano_usd_per_million_tokens: 10000000000,
		},
	},
	nonReasoning: {
		id: "experiential-plain-chat",
		object: "model",
		owned_by: "exp",
		supports_completions: true,
		supports_tools: false,
		supports_reasoning: false,
		reasoning_effort: null,
		supported_reasoning_efforts: [],
		context_window_tokens: 131072,
		maximum_output_tokens: null,
		pricing: {
			input_nano_usd_per_million_tokens: 100000000,
			output_nano_usd_per_million_tokens: 200000000,
			cache_creation_input_nano_usd_per_million_tokens: 125000000,
		},
	},
	embedding: {
		id: "text-embedding-3-small",
		object: "model",
		owned_by: "exp",
		supports_completions: false,
		supports_embeddings: true,
		emits_images: false,
		context_window_tokens: 8192,
	},
	imageOutput: {
		id: "gemini-2.5-flash-image",
		object: "model",
		owned_by: "exp",
		supports_completions: true,
		emits_images: true,
		context_window_tokens: 32768,
		maximum_output_tokens: 8192,
	},
	bare: { id: "glm-5.2-fast", object: "model", owned_by: "exp" },
} as const;

function fetchReturning(rows: readonly unknown[], seen?: Array<{ url: string; authorization: string | null }>) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		seen?.push({ url: input.toString(), authorization: new Headers(init?.headers).get("Authorization") });
		return Response.json({ object: "list", data: rows });
	};
}

describe("Experiential Labs built-in provider", () => {
	test("maps live limits, ladders, tool flags and nano-USD tariffs, and drops non-chat rows", async () => {
		const seen: Array<{ url: string; authorization: string | null }> = [];
		const options = experientialModelManagerOptions({
			apiKey: "xpl_test",
			fetch: fetchReturning(Object.values(ROWS), seen),
		});
		const models = await options.fetchDynamicModels?.();

		expect(seen).toEqual([{ url: `${EXPERIENTIAL_API_BASE_URL}/models`, authorization: "Bearer xpl_test" }]);
		expect(models?.map(model => model.id)).toEqual([
			"experiential-plain-chat",
			"glm-5.2-fast",
			"glm-5.3-flash-abliterated",
			"gpt-5",
			"ling-3.1-flash",
		]);

		const glm = models?.find(model => model.id === "glm-5.3-flash-abliterated");
		expect(glm?.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		expect(glm?.contextWindow).toBe(1048576);
		expect(glm?.maxTokens).toBe(131072);
		expect(glm?.reasoning).toBe(true);
		expect(glm?.supportsTools).toBe(true);
		expect(glm?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
		});
		expect(glm?.compat?.reasoningDisableMode).toBeUndefined();
		expect(glm?.compat?.maxTokensField).toBe("max_tokens");

		// `none` is the off switch, not a rung.
		const ling = models?.find(model => model.id === "ling-3.1-flash");
		expect(ling?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(ling?.compat?.reasoningDisableMode).toBe("none-effort");
		expect(ling?.compat?.maxTokensField).toBeUndefined();

		expect(models?.find(model => model.id === "gpt-5")?.compat?.maxTokensField).toBe("max_completion_tokens");

		// Live `false` and an empty ladder stay non-reasoning; cache-creation
		// pricing is the cache-write rate when no cache-write field is sent.
		const plain = models?.find(model => model.id === "experiential-plain-chat");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.thinking).toBeUndefined();
		expect(plain?.compat?.trustExplicitThinkingOnly).toBe(true);
		expect(plain?.supportsTools).toBe(false);
		expect(plain?.maxTokens).toBeNull();
		expect(plain?.cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0.125 });

		// A metadata-less row is kept but never borrows another host's price.
		const bare = models?.find(model => model.id === "glm-5.2-fast");
		expect(bare?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(bare?.compat?.trustExplicitThinkingOnly).toBeUndefined();
	});

	test("keeps a live zero tariff and the live ladder through the production manager and cache reload", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "experiential-refresh-"));
		let fetches = 0;
		const options = {
			...experientialModelManagerOptions({
				apiKey: "xpl_test",
				fetch: async (input: string | URL | Request, init?: RequestInit) => {
					fetches++;
					return fetchReturning([ROWS.lingFree, ROWS.glmAbliterated])(input, init);
				},
			}),
			cacheDbPath: path.join(tempDir, "models.db"),
		};
		try {
			for (const strategy of ["online", "offline"] as const) {
				const { models } = await resolveProviderModels(options, strategy);
				const ling = models.find(model => model.id === "ling-3.1-flash");
				expect(ling?.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
				const glm = models.find(model => model.id === "glm-5.3-flash-abliterated");
				expect(glm?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
				expect(glm?.thinking?.defaultLevel).toBe(Effort.Max);
			}
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("resolves the per-row max-tokens field through buildModel", async () => {
		const options = experientialModelManagerOptions({
			apiKey: "xpl_test",
			fetch: fetchReturning([ROWS.gpt5, ROWS.glmAbliterated]),
		});
		const specs = (await options.fetchDynamicModels?.()) ?? [];
		const built = Object.fromEntries(specs.map(spec => [spec.id, buildModel(spec)]));
		expect(built["gpt-5"]?.compat?.maxTokensField).toBe("max_completion_tokens");
		expect(built["glm-5.3-flash-abliterated"]?.compat?.maxTokensField).toBe("max_tokens");
		expect(built["glm-5.3-flash-abliterated"]?.compat?.supportsDeveloperRole).toBe(false);
		expect(built["glm-5.3-flash-abliterated"]?.compat?.supportsStore).toBe(false);
	});

	test("gates discovery on a key and scopes the cache per key and endpoint", () => {
		expect(experientialModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
		expect(experientialModelManagerOptions({ apiKey: "xpl_a" }).fetchDynamicModels).toBeDefined();

		const a = resolveModelCacheProviderId("experiential", { apiKey: "xpl_a" });
		expect(resolveModelCacheProviderId("experiential", { apiKey: "xpl_b" })).not.toBe(a);
		// Host-only, trailing-slash and canonical spellings share one namespace.
		expect(
			resolveModelCacheProviderId("experiential", { apiKey: "xpl_a", baseUrl: "https://api.experientiallabs.ai/" }),
		).toBe(a);
		expect(
			experientialModelManagerOptions({ apiKey: "xpl_a", baseUrl: "https://api.experientiallabs.ai" })
				.cacheProviderId,
		).toBe(a);
		expect(
			resolveModelCacheProviderId("experiential", { apiKey: "xpl_a", baseUrl: "https://gw.example/v1" }),
		).not.toBe(a);
	});

	test("normalizes configured base URLs onto the /v1 surface", () => {
		expect(normalizeExperientialBaseUrl(undefined)).toBe(EXPERIENTIAL_API_BASE_URL);
		expect(normalizeExperientialBaseUrl("   ")).toBe(EXPERIENTIAL_API_BASE_URL);
		expect(normalizeExperientialBaseUrl("https://gw.example/")).toBe("https://gw.example/v1");
		expect(normalizeExperientialBaseUrl("https://gw.example/v1/")).toBe("https://gw.example/v1");
	});
});
