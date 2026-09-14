import { describe, expect, test } from "bun:test";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { nousPortalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const NOUS_PORTAL_BASE_URL = "https://inference-api.nousresearch.com/v1";

describe("Nous Portal provider", () => {
	test("catalog descriptor points at the public inference API", () => {
		const descriptor = providerEntry("nous-portal");
		expect(descriptor).toMatchObject({
			id: "nous-portal",
			defaultModel: "anthropic/claude-sonnet-4.6",
			envVars: ["NOUS_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.discovery).toBeUndefined();
	});

	test("dynamic discovery recovers canonical params without borrowing pricing", async () => {
		const index = getBundledModelReferenceIndex();
		const resold = [...index.exact.values()].find(model => {
			if (model.provider === "nous-portal" || !model.id.includes("/")) return false;
			const ref = resolveModelReference(model.id, index);
			return ref?.reasoning === true && (ref.contextWindow ?? 0) > 0;
		});
		if (!resold) {
			throw new Error("no bundled resold reasoning model available to exercise canonical recovery");
		}

		const discoveredIds = [resold.id, "nous-portal/only-on-this-gateway"];
		const fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: discoveredIds.map(id => ({ id, object: "model", created: 0, owned_by: "nous" })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;

		const options = nousPortalModelManagerOptions({ apiKey: "sk-nous-test", fetch });
		expect(options.providerId).toBe("nous-portal");
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		const recovered = byId.get(resold.id);
		const canonical = resolveModelReference(resold.id, index);
		expect(recovered?.baseUrl).toBe(NOUS_PORTAL_BASE_URL);
		expect(recovered?.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered?.reasoning).toBe(true);
		expect(recovered?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const unknown = byId.get("nous-portal/only-on-this-gateway");
		expect(unknown?.baseUrl).toBe(NOUS_PORTAL_BASE_URL);
		expect(unknown?.contextWindow).toBeNull();
		expect(unknown?.reasoning).toBe(false);
	});
});
