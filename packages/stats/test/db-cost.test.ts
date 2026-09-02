import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	closeDb,
	getCostTimeSeries,
	getOverallStats,
	getRecentRequests,
	getStatsByModel,
	getStatsByProvider,
	initDb,
	insertMessageStats,
} from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-");

function createCodexGptStats(entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
	};
}

function expectedCodexGptCost() {
	const cost = getBundledModel("openai-codex", "gpt-5.4").cost;
	const input = (cost.input / 1_000_000) * 1000;
	const output = (cost.output / 1_000_000) * 500;
	const cacheRead = (cost.cacheRead / 1_000_000) * 200;
	return {
		input,
		output,
		cacheRead,
		total: input + output + cacheRead,
	};
}

function createXaiOAuthStats(entryId: string): MessageStats {
	const stats = createCodexGptStats(entryId);
	return {
		...stats,
		model: "grok-4.6",
		provider: "xai-oauth",
		api: "openai-responses",
	};
}

function expectedXaiGrokCost() {
	const cost = getBundledModel("xai", "grok-4.6").cost;
	const input = (cost.input / 1_000_000) * 1000;
	const output = (cost.output / 1_000_000) * 500;
	const cacheRead = (cost.cacheRead / 1_000_000) * 200;
	return {
		input,
		output,
		cacheRead,
		total: input + output + cacheRead,
	};
}

function createAnthropicCacheStats(entryId: string, cacheRead: number, cacheWrite: number): MessageStats {
	const input = 1_000 - cacheRead - cacheWrite;
	return {
		sessionFile: "/tmp/anthropic-session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input,
			output: 0,
			cacheRead,
			cacheWrite,
			totalTokens: 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
	};
}

describe("stats subscription cost correction", () => {
	it("stores catalog-derived cost when OpenAI Codex session usage has zero cost", async () => {
		await initDb();

		insertMessageStats([createCodexGptStats("inserted")]);

		const expected = expectedCodexGptCost();
		const request = getRecentRequests(1)[0];
		expect(expected.total).toBeGreaterThan(0);
		expect(request?.usage.cost.input).toBeCloseTo(expected.input, 8);
		expect(request?.usage.cost.output).toBeCloseTo(expected.output, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 8);
		expect(request?.usage.cost.total).toBeCloseTo(expected.total, 8);
	});

	it("stores xAI API-equivalent cost when SuperGrok session usage has zero cost", async () => {
		await initDb();

		insertMessageStats([createXaiOAuthStats("xai-inserted")]);

		const expected = expectedXaiGrokCost();
		const request = getRecentRequests(1)[0];
		expect(expected.total).toBeGreaterThan(0);
		expect(request?.usage.cost.input).toBeCloseTo(expected.input, 8);
		expect(request?.usage.cost.output).toBeCloseTo(expected.output, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 8);
		expect(request?.usage.cost.total).toBeCloseTo(expected.total, 8);
	});

	it("uses xAI's higher rate for SuperGrok prompts reaching 200K tokens", async () => {
		await initDb();
		const stats = createXaiOAuthStats("xai-long-context");
		stats.usage = {
			input: 100_000,
			output: 1_000,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 201_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		insertMessageStats([stats]);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.input).toBeCloseTo(0.4, 8);
		expect(request?.usage.cost.output).toBeCloseTo(0.012, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(request?.usage.cost.total).toBeCloseTo(0.512, 8);
	});

	it("marks subscription-only SuperGrok usage as unpriced", async () => {
		await initDb();
		const stats = createXaiOAuthStats("xai-unpriced");
		stats.model = "grok-composer-2.5-fast";

		insertMessageStats([stats]);

		expect(getRecentRequests(1)[0]?.usage.cost.total).toBe(0);
		expect(getStatsByModel()[0]).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
		expect(getStatsByProvider()[0]).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
		expect(getCostTimeSeries()[0]).toMatchObject({ cost: 0, unpricedRequests: 1 });
	});

	it("backfills existing zero-cost subscription rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
		const insert = database.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"/tmp/session.jsonl",
			"codex-backfilled",
			"/tmp/project",
			"gpt-5.4",
			"openai-codex",
			"openai-codex-responses",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			1000,
			500,
			200,
			0,
			1700,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		insert.run(
			"/tmp/session.jsonl",
			"xai-backfilled",
			"/tmp/project",
			"grok-4.6",
			"xai-oauth",
			"openai-responses",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			1000,
			500,
			200,
			0,
			1700,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		database.close();

		await initDb();

		const requests = getRecentRequests(2);
		expect(requests.find(request => request.entryId === "codex-backfilled")?.usage.cost.total).toBeCloseTo(
			expectedCodexGptCost().total,
			8,
		);
		expect(requests.find(request => request.entryId === "xai-backfilled")?.usage.cost.total).toBeCloseTo(
			expectedXaiGrokCost().total,
			8,
		);
	});

	it("refreshes a historically zero-cost multi-agent row with orchestration usage on re-ingest", async () => {
		await initDb();
		closeDb();

		// Simulate a pre-fix ingest: the row was priced from the four stored
		// token buckets only, so its orchestration usage was dropped and the
		// cost persisted as $0.
		const database = new Database(getStatsDbPath());
		database
			.prepare(`
				INSERT INTO messages (
					session_file, entry_id, folder, model, provider, api, timestamp,
					duration, ttft, stop_reason, error_message,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
					cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				"/tmp/session.jsonl",
				"multi-agent",
				"/tmp/project",
				"grok-4.20-multi-agent-0309",
				"xai-oauth",
				"openai-responses",
				Date.now(),
				1000,
				100,
				"stop",
				null,
				1000,
				500,
				200,
				0,
				302_700,
				0,
				0,
				0,
				0,
				0,
				0,
			);
		database.close();

		await initDb();

		// Re-ingest the same row with the orchestration counters the parser
		// recovers from source; the cost-refreshing UPSERT must reprice it.
		insertMessageStats([
			{
				...createXaiOAuthStats("multi-agent"),
				model: "grok-4.20-multi-agent-0309",
				usage: {
					input: 1000,
					output: 500,
					cacheRead: 200,
					cacheWrite: 0,
					orchestration: { input: 300_000, output: 1000 },
					totalTokens: 302_700,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);

		// Prompt input (1000 + 200 + 300000) crosses the inclusive 200K tier, so
		// the whole request bills at 4/12/0.4; orchestration input/output are
		// priced alongside the conversation buckets.
		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.input).toBeCloseTo((4 / 1e6) * 301_000, 8);
		expect(request?.usage.cost.output).toBeCloseTo((12 / 1e6) * 1_500, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo((0.4 / 1e6) * 200, 8);
		expect(request?.usage.cost.total).toBeCloseTo(1.22208, 8);
	});
});

describe("stats cache metrics", () => {
	it("subtracts 5-minute writes from the savings produced by cache reads", async () => {
		await initDb();
		insertMessageStats([createAnthropicCacheStats("mixed-cache", 800, 100)]);

		// 100 uncached + 800 reads at 0.1x + 100 writes at 1.25x = 305,
		// versus 1,000 tokens at the uncached input rate.
		expect(getOverallStats().cacheSavings).toBeCloseTo(0.695, 8);
		expect(getOverallStats().cacheRate).toBeCloseTo(800 / 900, 8);
	});

	it("reports cache writes without reads as negative savings", async () => {
		await initDb();
		insertMessageStats([createAnthropicCacheStats("cache-write", 0, 1_000)]);

		expect(getOverallStats().cacheSavings).toBeCloseTo(-0.25, 8);
	});

	it("charges 1-hour cache writes at their full overhead", async () => {
		await initDb();
		const stats = createAnthropicCacheStats("one-hour-write", 0, 1_000);
		stats.usage.cost = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0.006,
			total: 0.006,
		};
		insertMessageStats([stats]);

		expect(getOverallStats().cacheSavings).toBeCloseTo(-1, 8);
	});

	it("excludes unpriced custom models from the savings ratio", async () => {
		await initDb();
		const known = createAnthropicCacheStats("known", 800, 100);
		const unpriced = createAnthropicCacheStats("unpriced", 0, 0);
		unpriced.provider = "custom";
		unpriced.model = "custom-model";
		unpriced.usage.cost = {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1,
		};
		insertMessageStats([known, unpriced]);

		expect(getOverallStats().cacheSavings).toBeCloseTo(0.695, 8);
	});
});
