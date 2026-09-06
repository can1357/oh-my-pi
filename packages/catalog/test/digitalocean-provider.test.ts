import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { digitalOceanModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("DigitalOcean Serverless Inference provider", () => {
	test("fresh bundle resolves the descriptor's default model without discovery", () => {
		// Regression for the empty-slice bug: a credential-less
		// `bun run gen:models` regen bundles no digitalocean slice unless the
		// generator's guard pushes DIGITALOCEAN_STATIC_MODELS, and the declared
		// defaultModel is then unresolvable at boot before async discovery
		// fires.
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "digitalocean");
		expect(descriptor).toMatchObject({
			defaultModel: "glm-5.2",
			envVars: ["DIGITALOCEAN_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		// Exercise the generated bundle: without the guard the provider slice is
		// absent and the default resolution fails here.
		const bundled = getBundledModels("digitalocean");
		expect(bundled.length).toBeGreaterThan(0);
		expect(bundled.some(model => model.id === descriptor?.defaultModel)).toBe(true);
		// Observable consumer contract on the generated bundle: seeded rows
		// resolve reasoning flags, live limits, and DO's per-million-token
		// pricing through the runtime accessor (not the TS seed constant).
		const glm = bundled.find(model => model.id === "glm-5.2");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.contextWindow).toBe(262_144);
		expect(glm?.cost).toEqual({ input: 0.7, output: 2.2, cacheRead: 0.105, cacheWrite: 0 });
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
					// Vendor-prefixed passthrough id — canonical metadata resolves
					// after prefix stripping, but entry-provided limits still win.
					{
						id: "anthropic-claude-opus-4.5",
						object: "model",
						created: 0,
						owned_by: "digitalocean",
						context_length: 123_456,
						max_output_tokens: 23_456,
					},
					// Vendor-prefixed o-series — canonical metadata resolves
					// after prefix stripping.
					{
						id: "openai-o3",
						object: "model",
						created: 0,
						owned_by: "digitalocean",
						context_length: 200_000,
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
		expect(ids).toContain("anthropic-claude-opus-4.5");
		expect(ids).toContain("openai-o3");

		// Seeded GLM ids carry DigitalOcean's published tariff and limits from
		// the bundled reference even though the entry rows have no limits.
		const glm52 = models.find(model => model.id === "glm-5.2");
		expect(glm52?.reasoning).toBe(true);
		expect(glm52?.cost).toEqual({ input: 0.7, output: 2.2, cacheRead: 0.105, cacheWrite: 0 });
		// Limits come from DigitalOcean's own supported-models table, which lists
		// GLM-5.2 at 262,144 tokens rather than Z.AI's generic 1M figure.
		expect(glm52?.contextWindow).toBe(262_144);
		expect(glm52?.maxTokens).toBe(262_144);
		expect(glm52?.provider).toBe("digitalocean");
		expect(glm52?.api).toBe("openai-completions");
		expect(glm52?.baseUrl).toBe("https://inference.do-ai.run/v1");

		const glm53 = models.find(model => model.id === "glm-5.3");
		expect(glm53?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });

		// Vendor-prefixed family-order rows recover canonical reasoning/vision
		// metadata via `claude-5-sonnet` → `claude-sonnet-5`…
		const claude = models.find(model => model.id === "anthropic-claude-5-sonnet");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.input).toContain("image");
		expect(claude?.thinking).toBeDefined();
		// …while entry-provided limits still beat the canonical consensus and
		// pricing stays zeroed.
		expect(claude?.contextWindow).toBe(1_000_000);
		expect(claude?.maxTokens).toBe(128_000);
		expect(claude?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		// Vendor-prefixed o-series rows also resolve after prefix stripping.
		const o3 = models.find(model => model.id === "openai-o3");
		expect(o3?.reasoning).toBe(true);
		expect(o3?.thinking).toBeDefined();
		expect(o3?.contextWindow).toBe(200_000);
		expect(o3?.maxTokens).toBe(128_000);

		// Vendor-prefixed passthrough rows recover canonical reasoning/vision
		// metadata after prefix normalization (`anthropic-claude-opus-4.5` →
		// bundled `claude-opus-4-5`)…
		const opus = models.find(model => model.id === "anthropic-claude-opus-4.5");
		expect(opus?.reasoning).toBe(true);
		expect(opus?.input).toContain("image");
		expect(opus?.thinking).toBeDefined();
		// …but DO's own deployment limits still beat the canonical consensus
		// tables (1M context / 64K output), and pricing stays zeroed.
		expect(opus?.contextWindow).toBe(123_456);
		expect(opus?.maxTokens).toBe(23_456);
		expect(opus?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		expect(seen.urls).toContain("https://inference.do-ai.run/v1/models");
		expect(seen.authorization).toBe("Bearer doo_v1_test");
	});
});
