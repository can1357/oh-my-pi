import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import { huggingfaceModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";

interface RouterProvider {
	provider: string;
	status: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: { input: number; output: number };
	is_free?: boolean;
	supports_tools?: boolean;
}

interface RouterModel {
	id: string;
	architecture: { input_modalities: string[] };
	providers: RouterProvider[];
}

function routerResponse(models: RouterModel[]): Response {
	return new Response(JSON.stringify({ data: models }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const GLM: RouterModel = {
	id: "zai-org/GLM-5.3",
	architecture: { input_modalities: ["text"] },
	providers: [
		{
			provider: "novita",
			status: "live",
			context_length: 1_048_576,
			pricing: { input: 1.4, output: 4.4 },
			supports_tools: true,
		},
		{ provider: "together", status: "live", context_length: 1_048_575, pricing: { input: 1.4, output: 4.4 } },
		// A dead deployment must contribute neither limits nor pricing.
		{
			provider: "fireworks-ai",
			status: "error",
			context_length: 9_999_999,
			pricing: { input: 0.01, output: 0.01 },
		},
	],
};

describe("huggingface provider catalog", () => {
	it("discovers the live router catalog with per-provider limits, pricing, and modalities", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const fetchImpl: FetchImpl = (input, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			requests.push({ url: String(input), authorization: headers?.Authorization });
			return Promise.resolve(
				routerResponse([
					GLM,
					{
						id: "Qwen/Qwen4-VL-8B",
						architecture: { input_modalities: ["text", "image"] },
						providers: [
							{
								provider: "hf-inference",
								status: "live",
								context_length: 262_144,
								max_completion_tokens: 32_768,
								is_free: true,
								supports_tools: false,
							},
						],
					},
				]),
			);
		};

		const fetchDynamicModels = huggingfaceModelManagerOptions({
			apiKey: "hf_token",
			fetch: fetchImpl,
		}).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Hugging Face dynamic discovery is not configured");

		const models = await fetchDynamicModels();

		expect(requests).toEqual([{ url: "https://router.huggingface.co/v1/models", authorization: "Bearer hf_token" }]);
		expect(models).not.toBeNull();
		expect(models?.map(model => model.id)).toEqual(["Qwen/Qwen4-VL-8B", "zai-org/GLM-5.3"]);

		const glm = models?.find(model => model.id === "zai-org/GLM-5.3");
		// Largest live context wins; cheapest live price wins; one tool-capable
		// deployment keeps the model tool-capable (no supportsTools downgrade).
		expect(glm).toMatchObject({
			api: "openai-completions",
			provider: "huggingface",
			baseUrl: "https://router.huggingface.co/v1",
			input: ["text"],
			contextWindow: 1_048_576,
			cost: { input: 1.4, output: 4.4 },
		});
		if (!glm) throw new Error("GLM 5.3 was not discovered");
		expect(glm.supportsTools).toBeUndefined();

		const vision = models?.find(model => model.id === "Qwen/Qwen4-VL-8B");
		expect(vision).toMatchObject({
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			// A single free live deployment makes the model runnable at zero cost.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Every live deployment refuses tools → the model refuses tools.
			supportsTools: false,
		});
	});

	it("lists models with no live deployment metadata using neutral defaults", async () => {
		const fetchImpl: FetchImpl = async () =>
			routerResponse([
				{
					id: "allenai/Olmo-4-64B",
					architecture: { input_modalities: ["text"] },
					providers: [{ provider: "together", status: "error", context_length: 65_536 }],
				},
			]);

		const fetchDynamicModels = huggingfaceModelManagerOptions({
			apiKey: "hf_token",
			fetch: fetchImpl,
		}).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Hugging Face dynamic discovery is not configured");

		const models = await fetchDynamicModels();
		expect(models).toEqual([
			expect.objectContaining({
				id: "allenai/Olmo-4-64B",
				input: ["text"],
				contextWindow: null,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		]);
	});

	it("returns null on router failures so the manager falls back to cached models", async () => {
		const fetchDynamicModels = huggingfaceModelManagerOptions({
			apiKey: "hf_token",
			fetch: async () => new Response(null, { status: 503 }),
		}).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Hugging Face dynamic discovery is not configured");

		expect(await fetchDynamicModels()).toBeNull();
	});

	it("prunes static-only models after a successful fetch and keeps them when the router is unreachable", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-hf-"));
		const dbPath = path.join(tempDir, "models.db");
		// An id the bundled catalog does not carry, so the static overlay is the
		// only reference source and live limits/pricing must win the merge.
		const curatedGlimmer: ModelSpec<"openai-completions"> = {
			id: "meta-models/Muse-Glimmer-30B",
			name: "Muse Glimmer 30B",
			api: "openai-completions",
			provider: "huggingface",
			baseUrl: "https://router.huggingface.co/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		};
		const retiredOlmo: ModelSpec<"openai-completions"> = {
			...curatedGlimmer,
			id: "allenai/Olmo-3-7B-Instruct",
			name: "Olmo 3 7B",
			reasoning: false,
		};
		const liveGlimmer: RouterModel = {
			id: "meta-models/Muse-Glimmer-30B",
			architecture: { input_modalities: ["text"] },
			providers: [
				{
					provider: "novita",
					status: "live",
					context_length: 262_144,
					pricing: { input: 0.3, output: 0.9 },
					supports_tools: true,
				},
			],
		};
		try {
			const online = await resolveProviderModels(
				{
					...huggingfaceModelManagerOptions({
						apiKey: "hf_token",
						fetch: async () => routerResponse([liveGlimmer]),
					}),
					staticModels: [curatedGlimmer, retiredOlmo],
					cacheDbPath: dbPath,
				},
				"online",
			);

			// The router list is authoritative: the retired model disappears, and
			// the curated entry adopts live limits/pricing while keeping its name.
			expect(online.models.map(model => model.id)).toEqual(["meta-models/Muse-Glimmer-30B"]);
			expect(online.stale).toBe(false);
			expect(online.models[0]).toMatchObject({
				name: "Muse Glimmer 30B",
				reasoning: true,
				contextWindow: 262_144,
				cost: { input: 0.3, output: 0.9 },
			});

			// A fresh authoritative cache row serves cold boots without the network.
			let networkCalled = false;
			const cached = await resolveProviderModels(
				{
					...huggingfaceModelManagerOptions({
						apiKey: "hf_token",
						fetch: async () => {
							networkCalled = true;
							return routerResponse([]);
						},
					}),
					staticModels: [curatedGlimmer, retiredOlmo],
					cacheDbPath: dbPath,
				},
				"online-if-uncached",
			);
			expect(networkCalled).toBe(false);
			expect(cached.stale).toBe(false);
			expect(cached.models.map(model => model.id)).toEqual(["meta-models/Muse-Glimmer-30B"]);

			// When the router is unreachable, static entries stay visible so the
			// user is not left with an empty picker.
			const unreachable = await resolveProviderModels(
				{
					...huggingfaceModelManagerOptions({
						apiKey: "hf_token",
						fetch: async () => new Response(null, { status: 503 }),
					}),
					staticModels: [curatedGlimmer, retiredOlmo],
					cacheDbPath: path.join(tempDir, "failure.db"),
				},
				"online",
			);
			expect(unreachable.stale).toBe(true);
			expect(unreachable.models.map(model => model.id).sort()).toEqual([
				"allenai/Olmo-3-7B-Instruct",
				"meta-models/Muse-Glimmer-30B",
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes huggingface as an authoritative runtime catalog provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "huggingface");
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-R1");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);

		const manager = descriptor?.createModelManagerOptions({
			apiKey: "hf_token",
			fetch: async () => routerResponse([]),
		});
		expect(manager?.providerId).toBe("huggingface");
		expect(manager?.dynamicModelsAuthoritative).toBe(true);
		expect(typeof manager?.fetchDynamicModels).toBe("function");
	});

	it("gates discovery on an API key without dropping the authoritative flag", () => {
		const manager = huggingfaceModelManagerOptions();
		expect(manager.fetchDynamicModels).toBeUndefined();
		expect(manager.dynamicModelsAuthoritative).toBe(true);
	});
});
