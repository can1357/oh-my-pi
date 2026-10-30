import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "../src/build";
import { calculateUsageCost, getEffectiveTokenCost, getTimeBasedPricingPeriod } from "../src/models";
import type { Api, Model, ModelSpec, Provider, TokenCost } from "../src/types";

const INTRO = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const LIST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
const UNPRICED = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Midnight US Pacific (PST) on 2026-12-01, when Cloud Billing's day starts.
const SWITCH = Date.parse("2026-12-01T08:00:00Z");

function argon(provider: Provider, api: Api, cost: TokenCost, id = "gemini-4-argon"): ModelSpec<Api> {
	return {
		id,
		name: "Gemini 4 Argon",
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

function buildAt(timestamp: number, spec: ModelSpec<Api>): Model<Api> {
	const clock = spyOn(Date, "now").mockReturnValue(timestamp);
	try {
		return buildModel(spec);
	} finally {
		clock.mockRestore();
	}
}

function costAt(timestamp: number, spec: ModelSpec<Api>): TokenCost {
	const { input, output, cacheRead, cacheWrite } = buildAt(timestamp, spec).cost;
	return { input, output, cacheRead, cacheWrite };
}

/** Rates billed for a request at `timestamp`: one million tokens in each priced bucket. */
function billedAt(model: Model<Api>, timestamp: number): TokenCost {
	const usage = {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 0,
		totalTokens: 3_000_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { input, output, cacheRead, cacheWrite } = calculateUsageCost(model.cost, usage, timestamp);
	return { input, output, cacheRead, cacheWrite };
}

describe("Gemini 4 Argon list-price schedule", () => {
	it("pins Google's introductory and list cards on Google-billed hosts, whatever upstream reports", () => {
		const hosts: ModelSpec<Api>[] = [
			// stencil.so's introductory price, or a list price it already caught up to.
			argon("google", "google-generative-ai", INTRO),
			argon("google-vertex", "google-vertex", LIST),
			// Antigravity discovery reports no price.
			argon("google-antigravity", "google-gemini-cli", UNPRICED),
			// Cursor bills Other Models at the model's API price.
			argon("cursor", "cursor-agent", UNPRICED),
		];
		for (const spec of hosts) {
			expect(costAt(SWITCH - 1, spec), `${spec.provider} before`).toEqual(INTRO);
			expect(costAt(SWITCH, spec), `${spec.provider} after`).toEqual(LIST);
		}
	});

	it("bills and shows each request at the card in force when it was made, whenever the row was built", () => {
		// A row built before the switch (bundled, cached, or held by a long session) bills later requests at list,
		// and price displays show list once it is due.
		const early = buildAt(SWITCH - 1, argon("google", "google-generative-ai", INTRO));
		expect(billedAt(early, SWITCH - 1)).toEqual(INTRO);
		expect(billedAt(early, SWITCH)).toEqual(LIST);
		const { input, output, cacheRead, cacheWrite } = getEffectiveTokenCost(early.cost, SWITCH);
		expect({ input, output, cacheRead, cacheWrite }).toEqual(LIST);
		// A row built after the switch, from an upstream already at list, still bills earlier requests at the intro price.
		const late = buildAt(SWITCH, argon("google", "google-generative-ai", LIST));
		expect(billedAt(late, SWITCH - 1)).toEqual(INTRO);
		expect(billedAt(late, SWITCH)).toEqual(LIST);
		// A dated change is not a peak/off-peak tariff.
		expect(getTimeBasedPricingPeriod(early.cost, SWITCH)).toBeUndefined();
	});

	it("leaves resellers that publish their own Argon price untouched", () => {
		const openrouter = argon("openrouter", "openrouter", INTRO, "google/gemini-4-argon");
		expect(costAt(SWITCH, openrouter)).toEqual(INTRO);
	});
});
