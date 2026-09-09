import { afterEach, describe, expect, it } from "bun:test";
import { normalizedRecallWeights } from "@oh-my-pi/pi-mnemopi/config";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const beams: BeamMemory[] = [];
const ORIGINAL_ENV = {
	MNEMOPI_VEC_WEIGHT: process.env.MNEMOPI_VEC_WEIGHT,
	MNEMOPI_FTS_WEIGHT: process.env.MNEMOPI_FTS_WEIGHT,
	MNEMOPI_IMPORTANCE_WEIGHT: process.env.MNEMOPI_IMPORTANCE_WEIGHT,
};

function restoreEnv(): void {
	for (const key in ORIGINAL_ENV) {
		const value = ORIGINAL_ENV[key as keyof typeof ORIGINAL_ENV];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function makeBeam(): BeamMemory {
	const beam = new BeamMemory({ sessionId: "scoring", dbPath: ":memory:" });
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
	restoreEnv();
});

describe("configurable recall scoring", () => {
	it("normalizes defaults, explicit weights, zeros, and negative inputs", () => {
		delete process.env.MNEMOPI_VEC_WEIGHT;
		delete process.env.MNEMOPI_FTS_WEIGHT;
		delete process.env.MNEMOPI_IMPORTANCE_WEIGHT;
		expect(normalizedRecallWeights()).toEqual([0.5, 0.3, 0.2]);
		expect(normalizedRecallWeights(1, 1, 1)).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(normalizedRecallWeights(0.6, 0.3, 0.1)).toEqual([0.6, 0.3, 0.1]);
		expect(normalizedRecallWeights(0, 0, 0)).toEqual([0.5, 0.3, 0.2]);
		const clamped = normalizedRecallWeights(-0.5, 1, 0.5);
		expect(clamped[0]).toBe(0);
		expect(clamped[1]).toBeGreaterThan(clamped[2]);
		expect(clamped[0] + clamped[1] + clamped[2]).toBeGreaterThan(0.999);
		expect(clamped[0] + clamped[1] + clamped[2]).toBeLessThan(1.001);
	});

	it("reads environment weights when no explicit config is supplied", () => {
		process.env.MNEMOPI_VEC_WEIGHT = "0.7";
		process.env.MNEMOPI_FTS_WEIGHT = "0.2";
		process.env.MNEMOPI_IMPORTANCE_WEIGHT = "0.1";

		expect(normalizedRecallWeights()).toEqual([0.7, 0.2, 0.1]);
	});

	it("uses explicit per-call weights for recall scoring", async () => {
		const beam = makeBeam();
		beam.remember("alpha exact text match low priority", { importance: 0.1, source: "test" });
		beam.remember("alpha exact text match critical priority", { importance: 0.9, source: "test" });

		const highImportance = await beam.recall("alpha exact text match", 2, {
			vecWeight: 0,
			ftsWeight: 0.1,
			importanceWeight: 0.9,
		});
		const textDominant = await beam.recall("critical priority", 2, {
			vecWeight: 0,
			ftsWeight: 1,
			importanceWeight: 0,
		});

		expect(highImportance[0]?.importance ?? 0).toBeGreaterThan(0.5);
		expect(textDominant[0]?.content).toContain("critical priority");
		expect(highImportance[0]?.score ?? 0).toBeGreaterThan(highImportance[1]?.score ?? 0);
	});

	it("lets environment weights affect BeamMemory defaults", async () => {
		process.env.MNEMOPI_VEC_WEIGHT = "0.1";
		process.env.MNEMOPI_FTS_WEIGHT = "0.1";
		process.env.MNEMOPI_IMPORTANCE_WEIGHT = "0.8";
		const beam = makeBeam();
		beam.remember("Content A shared lexical anchor", { importance: 0.2, source: "test" });
		beam.remember("Content B shared lexical anchor", { importance: 0.9, source: "test" });

		const results = await beam.recall("shared lexical anchor", 2, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results.length).toBe(2);
		expect(results[0]?.content).toContain("Content B");
		expect(results[0]?.importance ?? 0).toBeGreaterThan(results[1]?.importance ?? 0);
	});

	it("explicit BeamMemory config overrides environment weights", async () => {
		process.env.MNEMOPI_VEC_WEIGHT = "0.1";
		process.env.MNEMOPI_FTS_WEIGHT = "0.1";
		process.env.MNEMOPI_IMPORTANCE_WEIGHT = "0.8";
		const beam = new BeamMemory({
			sessionId: "scoring",
			dbPath: ":memory:",
			config: { vecWeight: 0, ftsWeight: 1, importanceWeight: 0 },
		});
		beams.push(beam);
		beam.remember("Exact text match phrase low", { importance: 0.1, source: "test" });
		beam.remember("Exact text distraction high", { importance: 0.9, source: "test" });

		const results = await beam.recall("exact text match phrase", 2, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results[0]?.content).toContain("match phrase");
	});

	it("includes score breakdown fields and coexists with temporal scoring", async () => {
		const beam = makeBeam();
		beam.remember("Recent event happened today", { importance: 0.5, source: "test" });
		const results = await beam.recall("event", 1, {
			vecWeight: 0.4,
			ftsWeight: 0.3,
			importanceWeight: 0.3,
			temporalWeight: 0.5,
			queryTime: "2099-01-01T00:00:00.000Z",
		});
		const top = results[0];

		expect(top).toBeDefined();
		expect(typeof top?.dense_score).toBe("number");
		expect(typeof top?.fts_score).toBe("number");
		expect(typeof top?.importance).toBe("number");
		expect(typeof top?.temporal_score).toBe("number");
	});
});
