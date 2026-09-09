import { afterEach, describe, expect, it } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const beams: BeamMemory[] = [];

function makeBeam(): BeamMemory {
	const beam = new BeamMemory({
		sessionId: "fidelity",
		dbPath: ":memory:",
		config: { localLlmEnabled: false, vecWeight: 0, ftsWeight: 1, importanceWeight: 0 },
	});
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

describe("pre-experiment no-LLM fidelity", () => {
	it("recalls deterministic FTS-only memories without extraction or embeddings", async () => {
		const beam = makeBeam();
		beam.remember("The Nimbus launch checklist lives in the release binder.", {
			source: "fixture",
			importance: 0.5,
			extract: false,
			extractEntities: false,
		});
		beam.remember("The Atlas lunch checklist is unrelated office trivia.", {
			source: "fixture",
			importance: 0.9,
			extract: false,
			extractEntities: false,
		});

		const results = await beam.recall("Nimbus launch checklist", 2, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.content).toContain("Nimbus launch checklist");
		expect(results[0]?.dense_score).toBe(0);
		expect(results[0]?.fts_score ?? 0).toBeGreaterThan(0);
	});

	it("does not let high importance override an exact FTS-only match when configured for lexical fidelity", async () => {
		const beam = makeBeam();
		beam.remember("low priority: cedar backup target is vault-seven", {
			source: "fixture",
			importance: 0.1,
		});
		beam.remember("high priority: cedar backup target is stale-vault", {
			source: "fixture",
			importance: 1.0,
		});

		const results = await beam.recall("cedar backup target vault-seven", 2, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results[0]?.content).toContain("vault-seven");
	});

	it("upgrades duplicate veracity from unknown to a stronger supplied label", () => {
		const beam = makeBeam();
		const content = "same content reasserted with stronger veracity";
		const memoryId = beam.remember(content, { source: "conversation", veracity: "unknown" });

		beam.remember(content, { source: "conversation", veracity: "true" });
		const row = beam.db.query("SELECT veracity FROM working_memory WHERE id = ?").get(memoryId) as {
			veracity: string;
		} | null;

		expect(row?.veracity).toBe("true");
	});

	it("does not downgrade duplicate veracity when the new ingest has no trust signal", () => {
		const beam = makeBeam();
		const content = "stated content that gets backfilled later";
		const memoryId = beam.remember(content, { source: "conversation", veracity: "true" });

		beam.remember(content, { source: "conversation", veracity: "unknown" });
		const row = beam.db.query("SELECT veracity FROM working_memory WHERE id = ?").get(memoryId) as {
			veracity: string;
		} | null;

		expect(row?.veracity).toBe("true");
	});
});
