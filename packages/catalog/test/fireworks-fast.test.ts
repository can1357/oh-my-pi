import { describe, expect, it } from "bun:test";
import { FIREWORKS_FAST_SUFFIX, isFireworksFastModelId, toFireworksBaseModelId } from "../src/fireworks-model-id";
import { buildFireworksFastSeed } from "../src/provider-models/openai-compat";

describe("fireworks fast id helpers", () => {
	it("detects the -fast serving-path suffix", () => {
		expect(FIREWORKS_FAST_SUFFIX).toBe("-fast");
		expect(isFireworksFastModelId("kimi-k2.6-fast")).toBe(true);
		expect(isFireworksFastModelId("glm-5.1-fast")).toBe(true);
		expect(isFireworksFastModelId("kimi-k2.6")).toBe(false);
		expect(isFireworksFastModelId("kimi-k2.7-code")).toBe(false);
	});

	it("recovers the base id and is idempotent on non-fast ids", () => {
		expect(toFireworksBaseModelId("kimi-k2.6-fast")).toBe("kimi-k2.6");
		expect(toFireworksBaseModelId("kimi-k2.7-code-fast")).toBe("kimi-k2.7-code");
		expect(toFireworksBaseModelId("glm-5.1-fast")).toBe("glm-5.1");
		expect(toFireworksBaseModelId("kimi-k2.6")).toBe("kimi-k2.6");
	});
});

describe("buildFireworksFastSeed", () => {
	const seed = buildFireworksFastSeed();
	const byId = new Map(seed.map(model => [model.id, model]));

	it("emits one fireworks fast variant per curated base", () => {
		expect([...byId.keys()].sort()).toEqual(["glm-5.2-fast", "glm-5.3-fast", "kimi-k3-fast"]);
		for (const model of seed) {
			expect(model.provider).toBe("fireworks");
			expect(isFireworksFastModelId(model.id)).toBe(true);
		}
	});

	it("overrides cost with the Fast pricing and zeroes cache-write", () => {
		expect(byId.get("kimi-k3-fast")?.cost).toEqual({ input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 });
		expect(byId.get("glm-5.3-fast")?.cost).toEqual({ input: 2.1, output: 6.6, cacheRead: 0.39, cacheWrite: 0 });
		expect(byId.get("glm-5.2-fast")?.cost).toEqual({ input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 });
	});

	it("inherits limits and modalities from the base model", () => {
		const kimi = byId.get("kimi-k3-fast");
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.contextWindow).toBe(1048576);
		expect(kimi?.reasoning).toBe(true);
		expect(byId.get("glm-5.3-fast")?.input).toEqual(["text"]);
	});
});
