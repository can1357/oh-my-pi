import { describe, expect, it } from "bun:test";
import { kiloModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

async function discoverKiloModels(payload: unknown) {
	const options = kiloModelManagerOptions({
		fetch: async () => Response.json(payload),
	});
	const models = await options.fetchDynamicModels?.();
	if (!models) throw new Error("kilo discovery failed");
	return models;
}

describe("kilo discovery pricing", () => {
	it("prices rows from the gateway's per-token pricing and leaves router-priced rows unpriced", async () => {
		const models = await discoverKiloModels({
			data: [
				{
					id: "google/gemini-4-argon",
					pricing: {
						prompt: "0.000002000000",
						completion: "0.000010000000",
						input_cache_read: "0.000000100000",
						input_cache_write: "0.000000187500",
						discount: 0,
					},
				},
				// Routers publish `-1`: no fixed rate, so the row stays unpriced and
				// the model manager falls back to its reference sources.
				{ id: "kilo-auto/efficient", pricing: { prompt: "-1", completion: "-1" } },
			],
		});

		const argon = models.find(model => model.id === "google/gemini-4-argon");
		expect(argon?.cost.input).toBeCloseTo(2, 10);
		expect(argon?.cost.output).toBeCloseTo(10, 10);
		expect(argon?.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(argon?.cost.cacheWrite).toBeCloseTo(0.1875, 10);
		expect(models.find(model => model.id === "kilo-auto/efficient")?.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});
