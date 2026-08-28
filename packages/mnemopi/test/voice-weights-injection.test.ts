/**
 * Voice weights must be injectable so an A/B harness can run CHALLENGER weight configs
 * through the exact production path (combineVoices + diversityRerank + hydration) instead
 * of a re-implementation. The default stays the measured Phase-1 literal — an engine
 * constructed without the option is byte-identical to before.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { PolyphonicRecallEngine, type VoiceRecallResult } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

function makeEngine(weights?: Record<"vector" | "graph" | "fact" | "temporal", number>): PolyphonicRecallEngine {
	const db = new Database(":memory:");
	initBeam(db);
	return new PolyphonicRecallEngine({ db, sessionId: "bank-a", channelId: "bank-a", voiceWeights: weights });
}

function voiceHit(memoryId: string, voice: "vector" | "graph" | "fact" | "temporal"): VoiceRecallResult[] {
	return [{ memoryId, voice, score: 1, metadata: {} }];
}

describe("injectable voice weights", () => {
	test("default engine keeps the holdout-adopted round-3 weights", () => {
		const engine = makeEngine();
		expect(engine.voiceWeights).toEqual({ vector: 0.2, graph: 0.4, fact: 0.4, temporal: 0 });
	});
	test("injected weights flip fusion order between single-voice candidates", () => {
		const vectorHeavy = makeEngine({ vector: 0.9, graph: 0.05, fact: 0.03, temporal: 0.02 });
		const combinedVector = vectorHeavy.combineVoices(voiceHit("row-vec", "vector"), voiceHit("row-graph", "graph"));
		const rankedVector = [...combinedVector.values()].sort((a, b) => b.combinedScore - a.combinedScore);
		expect(rankedVector[0]?.memoryId).toBe("row-vec");

		const graphHeavy = makeEngine({ vector: 0.05, graph: 0.9, fact: 0.03, temporal: 0.02 });
		const combinedGraph = graphHeavy.combineVoices(voiceHit("row-vec", "vector"), voiceHit("row-graph", "graph"));
		const rankedGraph = [...combinedGraph.values()].sort((a, b) => b.combinedScore - a.combinedScore);
		expect(rankedGraph[0]?.memoryId).toBe("row-graph");
	});

	test("invalid injected weights are rejected loudly", () => {
		expect(() => makeEngine({ vector: Number.NaN, graph: 0.5, fact: 0.3, temporal: 0.2 })).toThrow(/voiceWeights/);
		expect(() => makeEngine({ vector: -0.1, graph: 0.6, fact: 0.3, temporal: 0.2 })).toThrow(/voiceWeights/);
	});
});
