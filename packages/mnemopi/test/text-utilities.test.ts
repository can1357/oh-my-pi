import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractionRate, normalizeBatch, normalizeChat } from "@oh-my-pi/pi-mnemopi/core/chat-normalize";
import { getCostStats, initCostLog, logCost } from "@oh-my-pi/pi-mnemopi/core/cost-log";
import { estimateCost, estimateTokens } from "@oh-my-pi/pi-mnemopi/core/token-counter";

describe("token counter", () => {
	it("uses the Python fallback token estimate and pricing table", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcdefghijkl")).toBe(3);
		expect(estimateTokens("abc")).toBe(0);
		expect(estimateCost(1_000_000, "gpt-4o-mini")).toEqual({
			tokens: 1_000_000,
			model: "gpt-4o-mini",
			cost_usd: 0.15,
			rate_per_1m: 0.15,
		});
		expect(estimateCost(333, "unknown-model")).toEqual({
			tokens: 333,
			model: "unknown-model",
			cost_usd: 0.000999,
			rate_per_1m: 3.0,
		});
	});
});

describe("cost log", () => {
	it("initializes the sqlite table and aggregates all and per-session stats", () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "mnemopi-cost-")), "cost_log.db");

		initCostLog(dbPath);
		logCost("session-a", 2, 100, 0.0003, "default", dbPath);
		logCost("session-a", 3, 200, 0.0006, "claude-sonnet-4", dbPath);
		logCost("session-b", 5, 400, 0.0012, "gpt-4o", dbPath);

		expect(getCostStats("session-a", dbPath)).toEqual({
			total_calls: 2,
			total_memories_injected: 5,
			total_tokens: 300,
			total_estimated_cost_usd: 0.0009,
		});
		expect(getCostStats(undefined, dbPath)).toEqual({
			total_calls: 3,
			total_memories_injected: 10,
			total_tokens: 700,
			total_estimated_cost_usd: 0.0021,
		});
		expect(getCostStats("missing", dbPath)).toEqual({
			total_calls: 0,
			total_memories_injected: 0,
			total_tokens: 0,
			total_estimated_cost_usd: 0,
		});
	});
});

describe("chat normalization", () => {
	it("expands contractions, strips fillers, collapses repeated chars, and removes non-ascii", () => {
		expect(normalizeChat("LOL u gonna loooove this 🚀")).toBe("you going to love this");
		expect(normalizeChat("omggg!!!")).toBeNull();
		expect(normalizeChat("DUNNO whyyyy")).toBe("don't know why");
	});

	it("drops fragments but preserves long single words and optional implicit subjects", () => {
		expect(normalizeChat("hi")).toBeNull();
		expect(normalizeChat("memoria")).toBe("memoria");
		expect(normalizeChat("going home")).toBe("i am going home");
		expect(normalizeChat("going home", { add_implicit_subjects: false })).toBe("going home");
		expect(normalizeChat("working on parser")).toBe("working on parser");
	});

	it("normalizes batches and reports extraction rate with dropped samples", () => {
		expect(normalizeBatch(["lol", "building cache", "OpenWebUI"])).toEqual([
			null,
			"i am building cache",
			"openwebui",
		]);
		expect(extractionRate(["lol", "brb", "building cache", "OpenWebUI"])).toEqual({
			total: 4,
			survived: 2,
			dropped: 2,
			rate: 0.5,
			dropped_samples: ["lol", "brb"],
		});
	});
});
