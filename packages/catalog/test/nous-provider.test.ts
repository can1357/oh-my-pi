import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { nousPortalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Nous Portal proxy discovery", () => {
	it("discovers OpenAI-compatible models through the local Hermes proxy", async () => {
		let requestedUrl: string | undefined;
		let authorization: string | null | undefined;
		const options = nousPortalModelManagerOptions({
			apiKey: "sk-unused",
			fetch: async (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization");
				return Response.json({
					data: [{ id: "nousresearch/hermes-4-70b" }, { id: "inclusionai/ling-3.0-flash-fin:free" }],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe("http://127.0.0.1:8645/v1/models");
		expect(authorization).toBe("Bearer sk-unused");
		expect(models?.map(model => model.id)).toEqual([
			"inclusionai/ling-3.0-flash-fin:free",
			"nousresearch/hermes-4-70b",
		]);
		expect(models?.every(model => model.api === "openai-completions")).toBe(true);
	});

	it("registers the proxy-backed provider and its stable default", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.nous).toBe("nousresearch/hermes-4-70b");
		expect(PROVIDER_DESCRIPTORS.some(descriptor => descriptor.providerId === "nous")).toBe(true);
	});
});
