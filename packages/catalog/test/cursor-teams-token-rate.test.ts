import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { calculateCost, getBundledModel, getModelTokenCost } from "@oh-my-pi/pi-catalog/models";

const sampleUsage = (input: number, cacheRead = 0): Usage => ({
	input,
	output: 0,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("Cursor Teams token rate", () => {
	it("adds the configured per-million surcharge on third-party Cursor models", () => {
		const model = {
			...getBundledModel("cursor", "gemini-3.8-flash"),
			teamsTokenRatePerMillion: 0.25,
		};
		const usage = sampleUsage(1_000_000, 1_000_000);
		calculateCost(model, usage);
		// List $0.75/M input and $0.075/M cache read, each plus the $0.25/M token rate.
		expect(usage.cost.input).toBeCloseTo(1.0, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.325, 8);
	});

	it.each(["grok-4.7", "composer-2.5", "composer-1"])("does not surcharge Cursor first-party %s", id => {
		// Built from a priced spec, not read from the bundle: the exemption must
		// come from the catalog rules, and bundled rows like composer-1 are
		// unpriced, which would pass with no exemption at all. Cursor's own cost
		// patches may replace the spec's card, so compare against the same model
		// without the rate.
		const model = buildModel({
			id,
			name: id,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const listed = sampleUsage(10_000);
		const rated = sampleUsage(10_000);
		calculateCost(model, listed);
		calculateCost({ ...model, teamsTokenRatePerMillion: 0.25 }, rated);
		expect(listed.cost.input).toBeGreaterThan(0);
		expect(rated.cost.input).toBe(listed.cost.input);
	});

	it("does not add a surcharge-only cost on unpriced Cursor rows", () => {
		const model = {
			...getBundledModel("cursor", "default"),
			teamsTokenRatePerMillion: 0.25,
		};
		const usage = sampleUsage(1_000_000);
		calculateCost(model, usage);
		expect(usage.cost.total).toBe(0);
	});

	it("adds the rate once to one-hour cache writes", () => {
		// One-hour writes bill at twice the list input price; the token rate is a
		// flat per-token addition and must not be doubled with it.
		const listed = getBundledModel("cursor", "gemini-3.8-flash");
		const writes = (): Usage => ({
			...sampleUsage(0),
			cacheWrite: 1_000_000,
			cttl: { ephemeral5m: 0, ephemeral1h: 1_000_000 },
		});
		const atList = writes();
		const rated = writes();
		calculateCost(listed, atList);
		calculateCost({ ...listed, teamsTokenRatePerMillion: 0.25 }, rated);
		expect(rated.cost.cacheWrite - atList.cost.cacheWrite).toBeCloseTo(0.25, 8);
	});

	it("adds the rate outside an off-peak tariff", () => {
		// The tariff discounts the provider's list price; Cursor's token rate is
		// its own flat charge and stays whole off-peak.
		const offPeak = {
			...getBundledModel("cursor", "gemini-3.8-flash"),
			cost: {
				input: 1,
				output: 1,
				cacheRead: 1,
				cacheWrite: 1,
				timeBased: { offPeakMultiplier: 0.5, peakWindows: [] },
			},
			teamsTokenRatePerMillion: 0.25,
		};
		const usage = sampleUsage(1_000_000);
		calculateCost(offPeak, usage, Date.UTC(2026, 9, 18));
		expect(usage.cost.input).toBeCloseTo(0.75, 8);
	});

	it("displays the per-million price that billing records", () => {
		// Model pickers and `omp models --json` read the displayed card; it must
		// not advertise the list price while sessions record the surcharge.
		for (const id of ["gemini-3.8-flash", "grok-4.7"]) {
			const model = { ...getBundledModel("cursor", id), teamsTokenRatePerMillion: 0.25 };
			// Below every long-context tier, where the per-million card applies as displayed.
			const usage = sampleUsage(10_000);
			calculateCost(model, usage);
			expect((getModelTokenCost(model).input * 10_000) / 1e6).toBeCloseTo(usage.cost.input, 10);
		}
	});
});
