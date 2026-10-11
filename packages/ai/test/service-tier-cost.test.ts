import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { applyOpenAIResponsesServiceTierCost } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// The standard (non-Codex) Responses path bills the tier OpenAI actually served:
// flex is half price, priority (Fast mode) is 2x, and ultrafast is 6x on the
// models with a published ultrafast price (GPT-6 Astra, GPT-6.1 Sol). A tier
// with no table entry stays at 1x rather than an invented multiplier.
function usage(): AssistantMessage["usage"] {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.00001, output: 0.00005, cacheRead: 0, cacheWrite: 0, total: 0.00006 },
	};
}

function model(id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

describe("standard OpenAI Responses service-tier cost", () => {
	it.each(["gpt-6-astra", "gpt-6.1-sol"])("bills %s ultrafast at its published 6x premium", id => {
		const ultrafastModel = model(id);
		expect(ultrafastModel.serviceTierCost).toEqual({ ultrafast: 6 });

		const billed = usage();
		// The returned tier is what the caller records on the message, so a
		// downgraded turn cannot be attributed to the requested tier.
		expect(applyOpenAIResponsesServiceTierCost(ultrafastModel, billed, "ultrafast", "ultrafast")).toBe("ultrafast");
		expect(billed.premiumRequests).toBe(1);
		expect(billed.cost.input).toBeCloseTo(0.00006);
		expect(billed.cost.output).toBeCloseTo(0.0003);
		expect(billed.cost.total).toBeCloseTo(0.00036);
	});

	it("leaves a model with no published ultrafast price at 1x", () => {
		const luna = model("gpt-6-luna");
		expect(luna.serviceTierCost).toBeUndefined();

		const billed = usage();
		applyOpenAIResponsesServiceTierCost(luna, billed, "ultrafast", "ultrafast");
		expect(billed.cost.input).toBeCloseTo(0.00001);
		expect(billed.cost.total).toBeCloseTo(0.00006);
		// Still a premium request: the tier reached the wire, only its price is unknown.
		expect(billed.premiumRequests).toBe(1);
	});

	it("keeps the generic flex/priority defaults and trusts the served tier echo", () => {
		const luna = model("gpt-6-luna");

		const priority = usage();
		applyOpenAIResponsesServiceTierCost(luna, priority, "priority", "priority");
		expect(priority.cost.input).toBeCloseTo(0.00002);

		const flex = usage();
		applyOpenAIResponsesServiceTierCost(luna, flex, "flex", "flex");
		expect(flex.cost.input).toBeCloseTo(0.000005);

		// A downgraded turn (requested ultrafast, served default) bills standard and
		// is not counted as a premium request.
		const downgraded = usage();
		expect(applyOpenAIResponsesServiceTierCost(model("gpt-6-astra"), downgraded, "default", "ultrafast")).toBe(
			"default",
		);
		expect(downgraded.cost.input).toBeCloseTo(0.00001);
		expect(downgraded.premiumRequests).toBe(0);
	});

	it("leaves the tier unrecorded for providers whose echo cannot be trusted", () => {
		const proxied = buildModel({
			id: "gpt-6-astra",
			name: "gpt-6-astra",
			api: "openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const billed = usage();
		expect(applyOpenAIResponsesServiceTierCost(proxied, billed, "ultrafast", "ultrafast")).toBeUndefined();
		expect(billed.premiumRequests).toBeUndefined();
		expect(billed.cost.input).toBeCloseTo(0.00001);
	});
});
