import { describe, expect, it } from "bun:test";
import {
	buildModelRows,
	groupErrors,
	normalizeErrorMessage,
	providerFailureTone,
	sortModelRows,
	sortProviderRows,
	sortRequests,
} from "../src/client/data/view-models";
import type { MessageStats, ModelStats, ProviderAggregate } from "../src/shared-types";

function msg(
	overrides: Partial<MessageStats> & { errorMessage: string | null; provider: string; model: string },
): MessageStats {
	return {
		id: overrides.id ?? Math.floor(Math.random() * 100000),
		sessionFile: "/tmp/test.jsonl",
		entryId: "e1",
		folder: "-tmp",
		api: "openai-completions",
		timestamp: overrides.timestamp ?? Date.now(),
		duration: overrides.duration ?? 1000,
		ttft: null,
		stopReason: overrides.errorMessage ? "error" : "stop",
		errorMessage: overrides.errorMessage,
		provider: overrides.provider,
		model: overrides.model,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			premiumRequests: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
	};
}

function modelStats(overrides: Partial<ModelStats> & { model: string; provider: string }): ModelStats {
	return {
		model: overrides.model,
		provider: overrides.provider,
		totalRequests: overrides.totalRequests ?? 1,
		successfulRequests: overrides.successfulRequests ?? 1,
		failedRequests: overrides.failedRequests ?? 0,
		errorRate: overrides.errorRate ?? 0,
		totalInputTokens: overrides.totalInputTokens ?? 100,
		totalOutputTokens: overrides.totalOutputTokens ?? 50,
		totalCacheReadTokens: overrides.totalCacheReadTokens ?? 0,
		totalCacheWriteTokens: overrides.totalCacheWriteTokens ?? 0,
		cacheRate: overrides.cacheRate ?? 0,
		cacheSavings: overrides.cacheSavings ?? 0,
		totalCost: overrides.totalCost ?? 0,
		unpricedRequests: overrides.unpricedRequests ?? 0,
		totalPremiumRequests: overrides.totalPremiumRequests ?? 0,
		avgDuration: overrides.avgDuration ?? null,
		avgTtft: overrides.avgTtft ?? null,
		avgTokensPerSecond: overrides.avgTokensPerSecond ?? null,
		firstTimestamp: 0,
		lastTimestamp: 0,
	};
}

describe("normalizeErrorMessage", () => {
	it("collapses whitespace and takes first line", () => {
		expect(normalizeErrorMessage("  403   Key limit   exceeded\nsecond line ignored  ")).toBe(
			"403 Key limit exceeded",
		);
	});
	it("returns Unknown error for null/empty", () => {
		expect(normalizeErrorMessage(null)).toBe("Unknown error");
		expect(normalizeErrorMessage("   ")).toBe("Unknown error");
	});
	it("truncates long messages to 160 chars", () => {
		const long = "a".repeat(300);
		expect(normalizeErrorMessage(long).length).toBeLessThanOrEqual(160);
	});
});

describe("groupErrors", () => {
	it("groups same provider+normalized message into one row with count", () => {
		const messages = [
			msg({ errorMessage: "403 Key limit exceeded", provider: "openrouter", model: "m1", timestamp: 1000 }),
			msg({ errorMessage: "403   Key limit   exceeded  ", provider: "openrouter", model: "m1", timestamp: 2000 }),
			msg({ errorMessage: "403 Key limit exceeded", provider: "openrouter", model: "m2", timestamp: 1500 }),
			msg({ errorMessage: "Rate limit", provider: "openrouter", model: "m1", timestamp: 500 }),
			msg({ errorMessage: null, provider: "openrouter", model: "m1", timestamp: 600 }),
		];
		const groups = groupErrors(messages, "error");
		expect(groups.length).toBe(2);
		const main = groups.find(g => g.signature === "403 Key limit exceeded");
		expect(main?.count).toBe(3);
		expect(main?.items.length).toBe(3);
		// Within group, newest first
		expect(main?.items[0].timestamp).toBe(2000);
		expect(groups[0].count).toBeGreaterThanOrEqual(groups[1].count);
	});
	it("groupBy provider collapses distinct messages per provider", () => {
		const messages = [
			msg({ errorMessage: "A", provider: "openrouter", model: "m1" }),
			msg({ errorMessage: "B", provider: "openrouter", model: "m1" }),
			msg({ errorMessage: "C", provider: "anthropic", model: "m1" }),
		];
		const groups = groupErrors(messages, "provider");
		expect(groups.length).toBe(2);
		const openrouter = groups.find(g => g.signature === "openrouter");
		expect(openrouter?.count).toBe(2);
	});
	it("groupBy model collapses across providers", () => {
		const messages = [
			msg({ errorMessage: "Error A", provider: "p1", model: "m1" }),
			msg({ errorMessage: "Error B", provider: "p2", model: "m1" }),
			msg({ errorMessage: "Error C", provider: "p1", model: "m2" }),
		];
		const groups = groupErrors(messages, "model");
		expect(groups.length).toBe(2);
		expect(groups.find(g => g.signature === "m1")?.count).toBe(2);
	});
});

describe("sortModelRows", () => {
	it("sorts by requests desc by default and toggles asc", () => {
		const rows = buildModelRows([
			modelStats({ model: "a", provider: "p", totalRequests: 10, totalCost: 5, cacheRate: 0.5, errorRate: 0.01 }),
			modelStats({ model: "b", provider: "p", totalRequests: 30, totalCost: 1, cacheRate: 0.9, errorRate: 0.2 }),
			modelStats({ model: "c", provider: "p", totalRequests: 20, totalCost: 10, cacheRate: 0.1, errorRate: 0 }),
		]);
		const byReqDesc = sortModelRows(rows, "requests", "desc");
		expect(byReqDesc.map(r => r.model)).toEqual(["b", "c", "a"]);
		const byReqAsc = sortModelRows(rows, "requests", "asc");
		expect(byReqAsc.map(r => r.model)).toEqual(["a", "c", "b"]);
		expect(sortModelRows(rows, "cost", "desc").map(r => r.model)).toEqual(["c", "a", "b"]);
		expect(sortModelRows(rows, "cache", "desc").map(r => r.model)).toEqual(["b", "a", "c"]);
	});
	it("shares computed correctly", () => {
		const rows = buildModelRows([
			modelStats({ model: "a", provider: "p", totalRequests: 3 }),
			modelStats({ model: "b", provider: "p", totalRequests: 1 }),
		]);
		expect(rows.find(r => r.model === "a")?.share).toBeCloseTo(0.75);
		expect(rows.find(r => r.model === "b")?.share).toBeCloseTo(0.25);
	});
});

describe("providerFailureTone", () => {
	it("returns danger/warning/ok at thresholds", () => {
		expect(providerFailureTone(0.09)).toBe("danger");
		expect(providerFailureTone(0.08)).toBe("danger");
		expect(providerFailureTone(0.05)).toBe("warning");
		expect(providerFailureTone(0.03)).toBe("warning");
		expect(providerFailureTone(0.02)).toBe("ok");
		expect(providerFailureTone(0)).toBe("ok");
	});
});

describe("sortProviderRows", () => {
	it("sorts by failure rate correctly", () => {
		const rows: ProviderAggregate[] = [
			{
				provider: "a",
				totalRequests: 100,
				failedRequests: 10,
				models: 1,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 0,
				totalCost: 0,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgTokensPerSecond: null,
			},
			{
				provider: "b",
				totalRequests: 100,
				failedRequests: 3,
				models: 1,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 0,
				totalCost: 0,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgTokensPerSecond: null,
			},
			{
				provider: "c",
				totalRequests: 100,
				failedRequests: 0,
				models: 1,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 0,
				totalCost: 0,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgTokensPerSecond: null,
			},
		];
		const sorted = sortProviderRows(rows, "failure", "desc");
		expect(sorted.map(r => r.provider)).toEqual(["a", "b", "c"]);
	});
});

describe("sortRequests", () => {
	it("sorts by tokens and timestamp", () => {
		const base = [
			msg({ errorMessage: null, provider: "p", model: "m1", timestamp: 100 }) as MessageStats,
			msg({ errorMessage: null, provider: "p", model: "m2", timestamp: 200 }) as MessageStats,
		];
		// tweak tokens
		base[0].usage.totalTokens = 50;
		base[0].usage.cost.total = 1;
		base[0].duration = 1000;
		base[1].usage.totalTokens = 200;
		base[1].usage.cost.total = 5;
		base[1].duration = 500;

		expect(sortRequests(base, "tokens", "desc").map(m => m.model)).toEqual(["m2", "m1"]);
		expect(sortRequests(base, "timestamp", "asc").map(m => m.model)).toEqual(["m1", "m2"]);
		expect(sortRequests(base, "cost", "desc").map(m => m.model)).toEqual(["m2", "m1"]);
		expect(sortRequests(base, "duration", "asc").map(m => m.model)).toEqual(["m2", "m1"]);
	});
});
