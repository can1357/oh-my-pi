import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import * as cascade from "@oh-my-pi/pi-catalog/compat/cascade";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function openAiModel(id: string): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-responses">);
}

describe("resolveDelegationBias cache", () => {
	afterEach(() => vi.restoreAllMocks());

	it("resolves the cascade once for repeated calls on an unchanged model", () => {
		const model = openAiModel("gpt-5.6");
		const resolve = spyOn(cascade, "resolveCascade");

		expect(resolveDelegationBias(model)).toBe("gated");
		expect(resolveDelegationBias(model)).toBe("gated");
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("invalidates when policy-relevant model identity mutates in place", () => {
		const model = openAiModel("gpt-5.6");
		expect(resolveDelegationBias(model)).toBe("gated");

		model.id = "gpt-6";
		model.identity.revision = "6.0.0";

		expect(resolveDelegationBias(model)).toBe("restrained");
	});

	it("does not share a cached decision across replacement model objects", () => {
		const gated = openAiModel("gpt-5.6");
		const restrained = openAiModel("gpt-6");

		expect(resolveDelegationBias(gated)).toBe("gated");
		expect(resolveDelegationBias(restrained)).toBe("restrained");
	});
});
