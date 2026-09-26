import { describe, expect, test } from "bun:test";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { recoversCanonicalParams } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import {
	isCredentialScopedModelCacheProvider,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { nousPortalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const NOUS_PORTAL_BASE_URL = "https://inference-api.nousresearch.com/v1";

describe("Nous Portal provider", () => {
	test("catalog policy declares account-scoped canonical recovery", () => {
		const descriptor = providerEntry("nous-portal");
		expect(descriptor).toMatchObject({
			id: "nous-portal",
			defaultModel: "anthropic/claude-sonnet-4.6",
			envVars: ["NOUS_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.discovery).toBeUndefined();
		expect(recoversCanonicalParams("nous-portal")).toBe(true);
		expect(isCredentialScopedModelCacheProvider("nous-portal")).toBe(true);
	});

	test("dynamic discovery recovers intrinsic params without pricing or foreign thinking routes", async () => {
		const index = getBundledModelReferenceIndex();
		const resold = [...index.exact.values()].find(model => {
			if (model.provider === "nous-portal" || !model.id.includes("/")) return false;
			const ref = resolveModelReference(model.id, index);
			return ref?.reasoning === true && ref.thinking !== undefined && (ref.contextWindow ?? 0) > 0;
		});
		if (!resold) throw new Error("no bundled reasoning model with thinking metadata for recovery test");

		const fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [resold.id, "nous-portal/only-on-this-gateway"].map(id => ({
						id,
						object: "model",
						created: 0,
						owned_by: "nous",
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;

		const options = nousPortalModelManagerOptions({ apiKey: "sk-nous-test", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));
		const canonical = resolveModelReference(resold.id, index);
		const recovered = byId.get(resold.id);

		expect(recovered?.baseUrl).toBe(NOUS_PORTAL_BASE_URL);
		expect(recovered?.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered?.reasoning).toBe(true);
		expect(recovered?.thinking).toBeUndefined();
		expect(recovered?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const unknown = byId.get("nous-portal/only-on-this-gateway");
		expect(unknown?.contextWindow).toBeNull();
		expect(unknown?.reasoning).toBe(false);
	});

	test("cache namespace follows both credential and normalized endpoint", () => {
		const first = nousPortalModelManagerOptions({
			apiKey: "sk-nous-a",
			baseUrl: "https://proxy.example/v1/",
		});
		const same = nousPortalModelManagerOptions({
			apiKey: "sk-nous-a",
			baseUrl: "https://proxy.example/v1",
		});
		const otherKey = nousPortalModelManagerOptions({
			apiKey: "sk-nous-b",
			baseUrl: "https://proxy.example/v1",
		});
		const otherHost = nousPortalModelManagerOptions({
			apiKey: "sk-nous-a",
			baseUrl: "https://other.example/v1",
		});

		expect(first.cacheProviderId).toBe(same.cacheProviderId);
		expect(first.cacheProviderId).not.toBe(otherKey.cacheProviderId);
		expect(first.cacheProviderId).not.toBe(otherHost.cacheProviderId);
		expect(first.cacheProviderId).toBe(
			resolveModelCacheProviderId("nous-portal", {
				apiKey: "sk-nous-a",
				baseUrl: "https://proxy.example/v1/",
			}),
		);
	});
});
