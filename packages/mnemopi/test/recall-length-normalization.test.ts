import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as beamRecall from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";

type RecallLengthNormalization = "none" | "log" | "bm25";
type NormalizeRecallScore = (
	score: number,
	contentLength: number,
	mode: RecallLengthNormalization,
	meanLength?: number,
) => number;

type TestBeam = BeamMemoryState & { close(): void };
const beams: TestBeam[] = [];

function normalizer(): NormalizeRecallScore {
	const candidate = (beamRecall as unknown as { normalizeRecallScore?: unknown }).normalizeRecallScore;
	expect(typeof candidate).toBe("function");
	if (typeof candidate !== "function") throw new Error("normalizeRecallScore is not implemented");
	return candidate as NormalizeRecallScore;
}

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "length-normalization",
		authorId: null,
		authorType: null,
		channelId: "length-normalization",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

function insertWorking(beam: TestBeam, id: string, content: string, importance: number): void {
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, scope, veracity, memory_type)
		 VALUES (?, ?, 'test', '2026-08-24T00:00:00.000Z', ?, ?, 'global', 'unknown', 'general')`,
		[id, content, beam.sessionId, importance],
	);
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

describe("recall length normalization", () => {
	it("implements the none, logarithmic and BM25-style formulas with finite boundary behavior", () => {
		const normalize = normalizer();

		expect(normalize(0.8, 400, "none", 200)).toBe(0.8);
		expect(normalize(0.8, 400, "log", 200)).toBeCloseTo(0.8 / Math.log2(402), 12);
		expect(normalize(0.8, 400, "bm25", 200)).toBeCloseTo(0.8 / (0.25 + 0.75 * 2), 12);
		expect(normalize(0.8, 0, "log", 0)).toBe(0.8);
		expect(normalize(0.8, 0, "bm25", 0)).toBe(3.2);
		expect(Number.isFinite(normalize(Number.NaN, Number.NaN, "bm25", Number.NaN))).toBe(true);
	});

	it("penalizes a long candidate more strongly under bm25 than log", () => {
		const normalize = normalizer();
		const shortLength = 1_000;
		const longLength = 30_000;
		const meanLength = 5_000;
		const logRelative = normalize(1, longLength, "log", meanLength) / normalize(1, shortLength, "log", meanLength);
		const bm25Relative = normalize(1, longLength, "bm25", meanLength) / normalize(1, shortLength, "bm25", meanLength);

		expect(bm25Relative).toBeLessThan(logRelative);
	});

	it("reorders the final enhanced candidate pool without changing the none control", async () => {
		const beam = makeBeam();
		const long = `quokka protocol ${"background ".repeat(2_000)}`;
		insertWorking(beam, "long", long, 0.95);
		insertWorking(beam, "short", "quokka protocol concise answer", 0.25);

		const none = await beamRecall.recallEnhanced(beam, "quokka protocol", 2, {
			queryTime: "2026-08-24T00:00:00.000Z",
			useMmr: false,
			lengthNormalization: "none",
		} as never);
		const log = await beamRecall.recallEnhanced(beam, "quokka protocol", 2, {
			queryTime: "2026-08-24T00:00:00.000Z",
			useMmr: false,
			lengthNormalization: "log",
		} as never);
		const bm25 = await beamRecall.recallEnhanced(beam, "quokka protocol", 2, {
			queryTime: "2026-08-24T00:00:00.000Z",
			useMmr: false,
			lengthNormalization: "bm25",
		} as never);

		expect(none[0]?.id).toBe("long");
		expect(log[0]?.id).toBe("short");
		expect(bm25[0]?.id).toBe("short");
		expect(log.find(result => result.id === "long")?.score).toBeLessThan(
			none.find(result => result.id === "long")?.score ?? 0,
		);
	});

	it("can abstain when every normalized candidate is below the score floor", async () => {
		const beam = makeBeam();
		insertWorking(beam, "weak", "quokka protocol incidental note", 0.1);

		const results = await beamRecall.recallEnhanced(beam, "quokka protocol", 8, {
			queryTime: "2026-08-24T00:00:00.000Z",
			lengthNormalization: "none",
			scoreFloor: 1,
		} as never);

		expect(results).toEqual([]);
	});
});
