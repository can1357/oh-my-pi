import { describe, expect, test } from "bun:test";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	DIGITALOCEAN_STATIC_MODELS,
	digitalOceanModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("DigitalOcean Serverless Inference provider", () => {
	test("static seed covers the descriptor's default model", () => {
		// Regression for the empty-slice bug: generation has no
		// DIGITALOCEAN_API_KEY, so a regen without credentials bundles no
		// digitalocean models, and the declared defaultModel is unresolvable
		// at boot before async discovery fires.
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "digitalocean");
		expect(descriptor).toMatchObject({
			defaultModel: "glm-5.2",
			envVars: ["DIGITALOCEAN_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(DIGITALOCEAN_STATIC_MODELS.map(model => model.id)).toContain("glm-5.2");
	});

	// DigitalOcean's `/v1/models` lists non-chat SKUs (embeddings, rerankers,
	// image/video/TTS generators, router ids) with no per-model type field, so
	// the exclude-models rules filter them, bundled references supply DO's
	// published tariff for the seeded GLM ids, and entry context_length /
	// max_output_tokens hydrate limits for everything else.
	test("dynamic discovery filters non-chat ids and keeps entry-provided limits", async () => {
		const seen: { urls: string[]; authorization?: string } = { urls: [] };
		const stubFetch: FetchImpl = async (input, init) => {
			seen.urls.push(String(input));
			seen.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
			const payload = {
				object: "list",
				data: [
					// Chat models without limits — priced from the bundled reference.
					{ id: "glm-5.2", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "glm-5.3", object: "model", created: 0, owned_by: "digitalocean" },
					// Chat model with entry-provided limits.
					{
						id: "anthropic-claude-5-sonnet",
						object: "model",
						created: 0,
						owned_by: "digitalocean",
						context_length: 1_000_000,
						max_output_tokens: 128_000,
					},
					// Non-chat SKUs the provider also lists — all must be filtered.
					{ id: "bge-m3", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "qwen3-embedding-0.6b", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "router:general", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "openai-gpt-image-1", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "qwen3-tts-voicedesign", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "stable-diffusion-3.5-large", object: "model", created: 0, owned_by: "digitalocean" },
					{ id: "wan2-2-t2v-a14b", object: "model", created: 0, owned_by: "digitalocean" },
				],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = digitalOceanModelManagerOptions({ apiKey: "doo_v1_test", fetch: stubFetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const ids = models.map(model => model.id);

		// Every non-chat SKU is absent.
		for (const excluded of [
			"bge-m3",
			"qwen3-embedding-0.6b",
			"router:general",
			"openai-gpt-image-1",
			"qwen3-tts-voicedesign",
			"stable-diffusion-3.5-large",
			"wan2-2-t2v-a14b",
		]) {
			expect(ids).not.toContain(excluded);
		}
		expect(ids).toContain("glm-5.2");
		expect(ids).toContain("glm-5.3");
		expect(ids).toContain("anthropic-claude-5-sonnet");

		// Seeded GLM ids carry DigitalOcean's published tariff and limits from
		// the bundled reference even though the entry rows have no limits.
		const glm52 = models.find(model => model.id === "glm-5.2");
		expect(glm52?.reasoning).toBe(true);
		expect(glm52?.cost).toEqual({ input: 0.7, output: 2.2, cacheRead: 0.105, cacheWrite: 0 });
		expect(glm52?.contextWindow).toBe(1_000_000);
		expect(glm52?.maxTokens).toBe(131_072);
		expect(glm52?.provider).toBe("digitalocean");
		expect(glm52?.api).toBe("openai-completions");
		expect(glm52?.baseUrl).toBe("https://inference.do-ai.run/v1");

		const glm53 = models.find(model => model.id === "glm-5.3");
		expect(glm53?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });

		// Unreferenced entries keep the limits the endpoint reported rather than
		// fabricating params.
		const claude = models.find(model => model.id === "anthropic-claude-5-sonnet");
		expect(claude?.contextWindow).toBe(1_000_000);
		expect(claude?.maxTokens).toBe(128_000);
		// ...while pricing stays zeroed instead of borrowing another host's rate.
		expect(claude?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		expect(seen.urls).toContain("https://inference.do-ai.run/v1/models");
		expect(seen.authorization).toBe("Bearer doo_v1_test");
	});
});
