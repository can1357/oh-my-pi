import { afterEach, describe, expect, it } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { parseQueryTime, temporalBoost } from "@oh-my-pi/pi-mnemopi/core/beam/recall";

const beams: BeamMemory[] = [];

function makeBeam(): BeamMemory {
	const beam = new BeamMemory({ sessionId: "temporal", dbPath: ":memory:" });
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function iso(date: string): string {
	return new Date(date).toISOString();
}

describe("temporal recall scoring", () => {
	it("computes temporal boost with decay, invalid timestamps, and future clamping", () => {
		const queryTime = new Date("2026-04-29T12:00:00.000Z");

		expect(temporalBoost("2026-04-28T12:00:00.000Z", queryTime, 24)).toBeGreaterThan(0.36);
		expect(temporalBoost("2026-04-28T12:00:00.000Z", queryTime, 24)).toBeLessThan(0.38);
		expect(temporalBoost("2026-04-26T12:00:00.000Z", queryTime, 24)).toBeLessThan(0.06);
		expect(temporalBoost("not-a-date", queryTime, 24)).toBe(0);
		expect(temporalBoost("2026-04-29T15:00:00.000Z", queryTime, 24)).toBe(1);
		expect(temporalBoost("2026-04-29T09:00:00+00:00", queryTime, 3)).toBeGreaterThan(0.36);
	});

	it("parses query time inputs and rejects invalid values", () => {
		expect(parseQueryTime("2026-04-29").toISOString()).toBe("2026-04-29T00:00:00.000Z");
		expect(parseQueryTime("2026-04-29T12:00:00").toISOString()).toBe("2026-04-29T12:00:00.000Z");
		expect(parseQueryTime("2026-04-29T15:00:00+03:00").toISOString()).toBe("2026-04-29T12:00:00.000Z");
		expect(parseQueryTime(new Date("2026-04-29T12:00:00.000Z")).toISOString()).toBe("2026-04-29T12:00:00.000Z");
		expect(() => parseQueryTime("not-a-date")).toThrow();
		expect(() => parseQueryTime(12345 as never)).toThrow();
	});

	it("boosts recent memories over older matches when temporal scoring is enabled", async () => {
		const beam = makeBeam();
		beam.remember("Meeting about project alpha", { source: "test", importance: 0.5 });
		beam.remember("Meeting about project beta", { source: "test", importance: 0.5 });
		beam.db
			.prepare("UPDATE working_memory SET timestamp = ? WHERE content LIKE ?")
			.run(iso("2026-05-25T12:00:00.000Z"), "%alpha%");
		beam.db
			.prepare("UPDATE working_memory SET timestamp = ? WHERE content LIKE ?")
			.run(iso("2026-05-30T10:00:00.000Z"), "%beta%");

		const noTemporal = await beam.recall("meeting", 5, {
			temporalWeight: 0,
			queryTime: "2026-05-30T12:00:00.000Z",
		});
		const temporal = await beam.recall("meeting", 5, {
			temporalWeight: 0.5,
			temporalHalflife: 24,
			queryTime: "2026-05-30T12:00:00.000Z",
		});
		const beta = temporal.find(result => result.content.includes("beta"));
		const alpha = temporal.find(result => result.content.includes("alpha"));

		expect(noTemporal.map(result => result.id).sort()).toEqual(temporal.map(result => result.id).sort());
		expect(beta?.score ?? 0).toBeGreaterThan(alpha?.score ?? 0);
		expect(beta?.temporal_score ?? 0).toBeGreaterThan(alpha?.temporal_score ?? 0);
	});

	it("leaves ordering stable when temporal weight is zero", async () => {
		const beam = makeBeam();
		beam.remember("Test content A", { source: "test", importance: 0.5 });
		beam.remember("Test content B", { source: "test", importance: 0.5 });

		const implicit = await beam.recall("test content", 5, { queryTime: "2026-05-30T12:00:00.000Z" });
		const explicit = await beam.recall("test content", 5, {
			temporalWeight: 0,
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(explicit.map(result => result.id)).toEqual(implicit.map(result => result.id));
		expect(explicit.map(result => result.score)).toEqual(implicit.map(result => result.score));
	});

	it("uses per-call temporal halflife overrides", async () => {
		const beam = makeBeam();
		beam.remember("Memory from two days ago", { source: "test", importance: 0.5 });
		beam.db
			.prepare("UPDATE working_memory SET timestamp = ? WHERE content LIKE ?")
			.run("2026-05-28T12:00:00.000Z", "%two days ago%");

		const short = await beam.recall("memory", 1, {
			temporalWeight: 0.5,
			temporalHalflife: 6,
			queryTime: "2026-05-30T12:00:00.000Z",
		});
		const long = await beam.recall("memory", 1, {
			temporalWeight: 0.5,
			temporalHalflife: 168,
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(long[0]?.score ?? 0).toBeGreaterThan(short[0]?.score ?? 0);
	});

	it("infers temporal query targets from natural language", async () => {
		const beam = makeBeam();
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type, event_date) VALUES (?, ?, 'test', ?, ?, 0.5, 'global', 'unknown', 'general', ?)",
			)
			.run(
				"em-old",
				"incident alpha resolved by rotating credentials",
				"2026-05-10T09:00:00.000Z",
				beam.sessionId,
				"2026-05-10",
			);
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type, event_date) VALUES (?, ?, 'test', ?, ?, 0.5, 'global', 'unknown', 'general', ?)",
			)
			.run(
				"em-target",
				"incident alpha resolved by rotating credentials",
				"2026-05-29T09:00:00.000Z",
				beam.sessionId,
				"2026-05-29",
			);

		const results = await beam.recall("incident alpha on 2026-05-29", 2, {
			includeWorking: false,
			temporalHalflife: 12,
		});

		expect(results[0]?.id).toBe("em-target");
		expect(results[0]?.temporal_score ?? 0).toBeGreaterThan(results[1]?.temporal_score ?? 0);
	});
});
