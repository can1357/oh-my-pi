import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
	buildFtsQuery,
	cjkFtsTerms,
	containsSpacelessCjk,
	decodeVector,
	detectLanguage,
	encodeVector,
	ftsQueryTerms,
	generateId,
	generateStableId,
	inMemoryVecSearch,
	lexicalRelevance,
	normalizeImportance,
	normalizeMetadata,
	normalizeWeights,
	recallTokens,
	recencyDecay,
	strictFactMatches,
	temporalBoost,
	workingMemoryVecSearch,
} from "@oh-my-pi/pi-mnemopi/core/beam/helpers";

describe("beam helper ids, weights, and metadata", () => {
	it("generates unique timed ids and deterministic stable ids", () => {
		const now = new Date("2024-01-02T03:04:05.000Z");

		expect(generateId("hello", now)).toHaveLength(16);
		expect(generateId("hello", now)).not.toBe(generateId("hello", now));
		expect(generateId("hello", now)).not.toBe(generateId("hello", new Date("2024-01-02T03:04:06.000Z")));
		expect(generateStableId("hello", "conversation")).toBe(generateStableId("hello", "conversation"));
		expect(generateStableId("hello", "conversation")).not.toBe(generateStableId("hello", "other"));
	});

	it("normalizes hybrid weights and clamps importance metadata inputs", () => {
		expect(normalizeWeights(2, 1, 1)).toEqual([0.5, 0.25, 0.25]);
		expect(normalizeWeights(-1, 0, 0)).toEqual([0.5, 0.3, 0.2]);
		expect(normalizeImportance(1.5)).toBe(1);
		expect(normalizeImportance(-0.1)).toBe(0);
		expect(normalizeMetadata('{"ok":true,"bad":null,"nan":null,"nested":{"n":2}}')).toEqual({
			ok: true,
			bad: null,
			nan: null,
			nested: { n: 2 },
		});
	});
});

describe("beam lexical and FTS helpers", () => {
	it("builds stopword-filtered FTS terms with query-side synonyms", () => {
		expect(recallTokens("What is my branding preference for the professional URL? 123")).toEqual([
			"branding",
			"preference",
			"professional",
			"url",
		]);
		expect(ftsQueryTerms("branding preference")).toEqual([
			'"branding"',
			'"brand"',
			'"positioning"',
			'"identity"',
			'"wording"',
			'"preference"',
			'"prefer"',
			'"prefers"',
			'"want"',
			'"wants"',
			'"reject"',
			'"rejects"',
			'"avoid"',
			'"grounded"',
		]);
		expect(buildFtsQuery('say "hello"')).toBe('"say" OR "hello"');
	});

	it("matches lexical, strict fact, and CJK queries conservatively", () => {
		const tokens = recallTokens("telemetry api latency");
		expect(lexicalRelevance(tokens, "telemetry_api_latency_ms should stay below 200", "telemetry api latency")).toBe(
			1,
		);
		expect(
			lexicalRelevance(recallTokens("purple quantum oatmeal"), "telemetry_api_latency_ms", "purple quantum oatmeal"),
		).toBe(0);
		expect(strictFactMatches("where is hermes profile", "Hermes profile URL is https://example.test/hermes")).toBe(
			true,
		);
		expect(
			strictFactMatches("where is the unrelated thing", "Hermes profile URL is https://example.test/hermes"),
		).toBe(false);
		expect(containsSpacelessCjk("東京で会う")).toBe(true);
		expect(cjkFtsTerms("東京東京")).toEqual(["東", "京", '"東京"', '"京東"']);
		expect(lexicalRelevance([], "明日は東京で会議", "東京")).toBe(1);
	});
});

describe("beam temporal and language helpers", () => {
	it("computes recency decay and temporal boost from UTC timestamps", () => {
		const now = new Date("2024-01-02T12:00:00.000Z");
		expect(recencyDecay("2024-01-02T06:00:00.000Z", 6, now)).toBeCloseTo(Math.exp(-1), 12);
		expect(recencyDecay(null, 6, now)).toBe(0.5);
		expect(temporalBoost("2024-01-02T06:00:00.000Z", now, 6)).toBeCloseTo(Math.exp(-1), 12);
		expect(temporalBoost("2024-01-03T06:00:00.000Z", now, 6)).toBe(1);
		expect(temporalBoost("not-a-date", now, 6)).toBe(0);
	});

	it("detects supported languages without external dependencies", () => {
		expect(detectLanguage("Привет, это мой проект и это важно")).toBe("ru");
		expect(detectLanguage("ich bin sehr gern dabei und das ist gut")).toBe("de");
		expect(detectLanguage("recuerda que siempre usa este estilo")).toBe("es");
		expect(detectLanguage("plain English text")).toBe("en");
	});
});

describe("beam vector fallback helpers", () => {
	it("encodes, decodes, and searches episodic fallback vectors", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE episodic_memory (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, content TEXT)");
			db.run("CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT)");
			db.query("INSERT INTO episodic_memory (id, content) VALUES (?, ?)").run("same", "same vector");
			db.query("INSERT INTO episodic_memory (id, content) VALUES (?, ?)").run("orthogonal", "orthogonal vector");
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"same",
				encodeVector([1, 0]),
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"orthogonal",
				encodeVector([0, 1]),
			);

			expect(decodeVector("[1,0]")).toEqual([1, 0]);
			expect(decodeVector("[1,null]")).toBeNull();
			expect(inMemoryVecSearch(db, [1, 0], 2)).toEqual([
				{ rowid: 1, distance: 0 },
				{ rowid: 2, distance: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("searches working-memory fallback vectors and skips expired rows", () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, superseded_by TEXT, valid_until TEXT)",
			);
			db.run("CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT)");
			db.query("INSERT INTO working_memory (id, content, superseded_by, valid_until) VALUES (?, ?, NULL, NULL)").run(
				"same",
				"same",
			);
			db.query("INSERT INTO working_memory (id, content, superseded_by, valid_until) VALUES (?, ?, NULL, ?)").run(
				"expired",
				"expired",
				"2024-01-01T00:00:00.000Z",
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"same",
				encodeVector([1, 0]),
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"expired",
				encodeVector([1, 0]),
			);

			expect(workingMemoryVecSearch(db, [1, 0], 10, new Date("2024-01-02T00:00:00.000Z"))).toEqual([
				{ id: "same", sim: 1 },
			]);
		} finally {
			db.close();
		}
	});
});
