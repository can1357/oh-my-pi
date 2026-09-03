import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { zaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
const DISCOVERY_URL = `${ZAI_ANTHROPIC_BASE_URL}/v1/models`;

/** One entry in Z.AI's Anthropic-surface `/v1/models` response shape. */
function anthropicModelsResponse(entries: Record<string, unknown>[]): Response {
	return Response.json({ data: entries });
}

describe("Z.AI built-in provider", () => {
	test("registers catalog descriptor with ZAI_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "zai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("glm-5.3");
		expect(descriptor?.catalogDiscovery).toEqual({ label: "zAI", envVars: ["ZAI_API_KEY"] });
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.zai).toBe("glm-5.3");

		// The bundled seed is what discovery merges references from. Rows ride
		// either Z.AI transport: glm-5.3 on the Anthropic-compatible proxy, the
		// natively multimodal glm-5.3-flash on the native PAAS endpoint.
		const bundled = getBundledModels("zai");
		expect(bundled.map(model => model.id)).toContain("glm-5.3");
		const bundledGlm53 = bundled.find(model => model.id === "glm-5.3");
		expect(bundledGlm53?.api).toBe("anthropic-messages");
		expect(bundledGlm53?.baseUrl).toBe(ZAI_ANTHROPIC_BASE_URL);
		const bundledFlash = bundled.find(model => model.id === "glm-5.3-flash");
		expect(bundledFlash?.api).toBe("openai-completions");
		expect(bundledFlash?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
	});

	test("keeps the bundled catalog when no API key is configured", () => {
		const options = zaiModelManagerOptions();
		expect(options.providerId).toBe("zai");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("marks live discovery authoritative so retired bundled ids cannot linger", () => {
		// The runtime merge path reads this flag from the manager options, not
		// the catalog descriptor — without it a successful /v1/models response
		// merges over the bundled seed instead of replacing it.
		expect(zaiModelManagerOptions({ apiKey: "zai-test-key" }).dynamicModelsAuthoritative).toBe(true);
	});

	test("prunes bundled ids the live catalog omits", async () => {
		// With the authoritative option the production manager replaces the
		// static rows with the wire catalog, so ids the endpoint retired (or
		// never served, like the curated glm-5.3 seed if /v1/models drops it)
		// must not stay selectable.
		const fetch: FetchImpl = async () =>
			anthropicModelsResponse([{ id: "glm-5.3", object: "model", display_name: "GLM-5.3" }]);
		const manager = createModelManager({
			...zaiModelManagerOptions({ apiKey: "zai-test-key", fetch }),
			cacheDbPath: ":memory:",
		});
		const { models } = await manager.refresh("online");

		expect(models.map(model => model.id)).toEqual(["glm-5.3"]);
	});

	test("maps the anthropic /v1/models catalog and merges bundled references for known ids", async () => {
		const requests: Array<{ url: string; apiKey: string | null; anthropicVersion: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: input.toString(),
				apiKey: headers.get("x-api-key"),
				anthropicVersion: headers.get("anthropic-version"),
			});
			return anthropicModelsResponse([
				{ id: "glm-5.3-flash", object: "model", display_name: "GLM-5.3-Flash" },
				{ id: "glm-5.3", object: "model", display_name: "GLM-5.3" },
			]);
		};

		const options = zaiModelManagerOptions({ apiKey: "zai-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requests).toEqual([{ url: DISCOVERY_URL, apiKey: "zai-test-key", anthropicVersion: "2023-06-01" }]);
		// Mapped ids sort lexically regardless of endpoint order.
		expect(models?.map(item => item.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);

		// Known id: the bundled reference merges pricing, limits, and effort tiers.
		const glm = models?.find(item => item.id === "glm-5.3");
		expect(glm?.provider).toBe("zai");
		expect(glm?.api).toBe("anthropic-messages");
		expect(glm?.baseUrl).toBe(ZAI_ANTHROPIC_BASE_URL);
		expect(glm?.name).toBe("GLM-5.3");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		expect(glm?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(glm?.contextWindow).toBe(1_000_000);
		expect(glm?.maxTokens).toBe(131_072);

		// Newly announced id: the curated bundled reference seeds limits,
		// modalities, and the family effort ladder so discovery alone never
		// surfaces a text-only, null-context row.
		const flash = models?.find(item => item.id === "glm-5.3-flash");
		expect(flash?.provider).toBe("zai");
		expect(flash?.baseUrl).toBe(ZAI_ANTHROPIC_BASE_URL);
		expect(flash?.name).toBe("GLM-5.3-Flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.input).toEqual(["text", "image"]);
		expect(flash?.contextWindow).toBe(1_000_000);
		expect(flash?.maxTokens).toBe(131_072);
		expect(flash?.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		expect(flash?.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
	});

	test("derives GLM thinking metadata for an unbundled newly launched id", async () => {
		// A future GLM id (no bundled reference yet) must not surface as
		// non-reasoning: every GLM SKU is a hybrid reasoning model, so
		// `transformModel` floors `reasoning` and the build-time policy derives
		// thinking controls from the identity. The uniform low/high/max ladder
		// applies to the taxonomy-enumerated 5.3-family ids (asserted above via
		// the glm-5.3 reference merge); an id the taxonomy has not enumerated
		// yet derives the provider-default ladder.
		const fetchMock: FetchImpl = async () =>
			anthropicModelsResponse([{ id: "glm-5.4", object: "model", display_name: "GLM-5.4" }]);
		const manager = createModelManager({
			...zaiModelManagerOptions({ apiKey: "zai-test-key", fetch: fetchMock }),
			cacheDbPath: ":memory:",
		});
		const { models } = await manager.refresh("online");

		const glm54 = models.find(model => model.id === "glm-5.4");
		expect(glm54).toBeDefined();
		expect(glm54?.reasoning).toBe(true);
		expect(glm54?.thinking?.mode).toBe("anthropic-budget-effort");
		expect(glm54?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});

	test("builds discovered glm-5.3-flash with the full Model contract", async () => {
		// The picker consumes built Models, not mapped specs: prove the merged
		// reference survives createModelManager's authoritative replace path.
		const fetchMock: FetchImpl = async () =>
			anthropicModelsResponse([{ id: "glm-5.3-flash", object: "model", display_name: "GLM-5.3-Flash" }]);
		const manager = createModelManager({
			...zaiModelManagerOptions({ apiKey: "zai-test-key", fetch: fetchMock }),
			cacheDbPath: ":memory:",
		});
		const { models } = await manager.refresh("online");

		const flash = models.find(model => model.id === "glm-5.3-flash");
		expect(flash).toBeDefined();
		expect(flash?.api).toBe("anthropic-messages");
		expect(flash?.contextWindow).toBe(1_000_000);
		expect(flash?.maxTokens).toBe(131_072);
		expect(flash?.input).toEqual(["text", "image"]);
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.mode).toBe("anthropic-budget-effort");
		expect(flash?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(flash?.thinking?.defaultLevel).toBe(Effort.Max);
	});

	test("drops unusable context-tier ids from the authoritative discovered catalog", async () => {
		// `/v1/models` advertises `[1m]` context-tier variants (a Claude
		// Code-side convention) that the inference endpoint rejects; the
		// generator strips them from the bundle, so an authoritative refresh
		// must not resurrect them over the filtered bundled catalog.
		const fetchMock: FetchImpl = async () =>
			anthropicModelsResponse([
				{ id: "glm-5.2", object: "model", display_name: "GLM-5.2" },
				{ id: "glm-5.2[1m]", object: "model", display_name: "GLM-5.2 (1M)" },
				{ id: "glm-5.3-flash", object: "model", display_name: "GLM-5.3-Flash" },
			]);
		const manager = createModelManager({
			...zaiModelManagerOptions({ apiKey: "zai-test-key", fetch: fetchMock }),
			cacheDbPath: ":memory:",
		});
		const { models } = await manager.refresh("online");

		const ids = models.map(model => model.id);
		expect(ids).toContain("glm-5.2");
		expect(ids).toContain("glm-5.3-flash");
		expect(ids.filter(id => id.endsWith("[1m]"))).toEqual([]);
	});

	test("resolves null on discovery failure so the bundled catalog survives", async () => {
		const fetchMock: FetchImpl = async (): Promise<Response> => {
			throw new Error("network unreachable");
		};

		const options = zaiModelManagerOptions({ apiKey: "zai-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeNull();
	});
});
