import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	closeDb,
	getCostTimeSeries,
	getOverallStats,
	getRecentRequests,
	getSessionRollups,
	getStatsByModel,
	getStatsByProvider,
	initDb,
	insertMessageStats,
} from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-");

function selectCodexReferenceModel() {
	const model = getBundledModels("openai")
		.sort((a, b) => a.id.localeCompare(b.id))
		.find(
			model =>
				model.id.startsWith("gpt-") &&
				model.cost.input > 0 &&
				model.cost.output > 0 &&
				getBundledModel("openai-codex", model.id) !== undefined,
		);
	if (!model) throw new Error("Expected a shared, priced OpenAI/Codex GPT model");
	return model;
}

const codexReferenceModel = selectCodexReferenceModel();

function selectFreeModel() {
	const model = getBundledModels("ollama-cloud").find(
		candidate =>
			candidate.cost.input === 0 &&
			candidate.cost.output === 0 &&
			candidate.cost.cacheRead === 0 &&
			candidate.cost.cacheWrite === 0,
	);
	if (!model) throw new Error("Expected a bundled zero-cost model");
	return model;
}

const freeModel = selectFreeModel();

function createCodexGptStats(entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: codexReferenceModel.id,
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
	const cost = codexReferenceModel.cost;
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

	it("marks SuperGrok usage without a reference price as unpriced", async () => {
		await initDb();
		const stats = createXaiOAuthStats("xai-unpriced");
		stats.model = "test-supergrok-without-reference-price";

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
			codexReferenceModel.id,
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

describe("stats scheduled response costs", () => {
	it("prices missing legacy costs at each response timestamp and retains the resulting history", async () => {
		const database = await initDb();
		const requests = [
			["peak", "2026-09-10T03:00:00Z"],
			["off-peak", "2026-09-10T04:00:00Z"],
			["new-rate", "2026-09-14T04:00:00Z"],
		].map(([entryId, timestamp]) => {
			const stats = createCodexGptStats(entryId);
			stats.provider = "deepseek";
			stats.model = "deepseek-v4-pro";
			stats.api = "openai-completions";
			stats.timestamp = Date.parse(timestamp);
			stats.usage = {
				input: 0,
				output: 0,
				cacheRead: 1_000_000,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			// Old session payloads may genuinely omit cost; zero is not absence.
			Reflect.deleteProperty(stats.usage, "cost");
			return stats;
		});
		insertMessageStats(requests);
		const stored = getRecentRequests(3);
		expect(stored.find(request => request.entryId === "peak")?.usage.cost.total).toBeCloseTo(0.044, 8);
		expect(stored.find(request => request.entryId === "off-peak")?.usage.cost.total).toBeCloseTo(0.022, 8);
		expect(stored.find(request => request.entryId === "new-rate")?.usage.cost.total).toBeCloseTo(0.003, 8);
		expect(getOverallStats().totalCost).toBeCloseTo(0.069, 8);
		expect(getOverallStats().cacheSavings).toBeCloseTo(1 - 0.069 / 2.13, 8);

		// Simulate a database predating the no-cache estimate column's backfill.
		database.run("UPDATE messages SET cost_no_cache_input = NULL");
		closeDb();
		await initDb();
		expect(getOverallStats().totalCost).toBeCloseTo(0.069, 8);
		expect(getOverallStats().cacheSavings).toBeCloseTo(1 - 0.069 / 2.13, 8);
	});

	it("reports a scheduled request with no recoverable timestamp as unpriced, not free", async () => {
		await initDb();
		// `timestamp: 0` is what the parser stores when neither the message
		// timestamp nor the entry timestamp parsed, which is exactly when
		// `resolveStoredCost` cannot select a tariff from a scheduled card.
		const undated = createCodexGptStats("undated-scheduled");
		undated.provider = "deepseek";
		undated.model = "deepseek-v4-flash";
		undated.api = "openai-completions";
		undated.timestamp = 0;
		undated.usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		Reflect.deleteProperty(undated.usage, "cost");

		// A dated request whose recorded price is an explicit zero is genuinely
		// free, so it must stay out of the unpriced count.
		const free = createCodexGptStats("dated-explicit-zero");
		free.provider = "deepseek";
		free.model = "deepseek-v4-flash";
		free.api = "openai-completions";
		free.timestamp = Date.parse("2026-09-10T03:00:00Z");
		free.usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		// A free flat card stores no billable price, so its zero is real: the
		// timestamp sentinel must not turn it into unknown spend.
		const freeFlat = createCodexGptStats("undated-free-flat");
		freeFlat.provider = freeModel.provider;
		freeFlat.model = freeModel.id;
		freeFlat.api = freeModel.api;
		freeFlat.timestamp = 0;
		freeFlat.usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		Reflect.deleteProperty(freeFlat.usage, "cost");

		// A recorded zero is a charge, not absent pricing, even on a scheduled
		// card whose timestamp never resolved.
		const recordedZero = createCodexGptStats("undated-recorded-zero");
		recordedZero.provider = "deepseek";
		recordedZero.model = "deepseek-v4-flash";
		recordedZero.api = "openai-completions";
		recordedZero.timestamp = 0;
		recordedZero.usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const priced = createCodexGptStats("priced");
		priced.model = "claude-sonnet-4-6";
		priced.provider = "anthropic";
		priced.api = "anthropic-messages";
		priced.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 };

		insertMessageStats([undated, free, freeFlat, recordedZero, priced]);

		const stored = getRecentRequests(5);
		expect(stored.find(request => request.entryId === "undated-scheduled")?.usage.cost.total).toBe(0);
		expect(stored.find(request => request.entryId === "undated-scheduled")?.costUnpriced).toBe(true);
		expect(stored.find(request => request.entryId === "dated-explicit-zero")?.usage.cost.total).toBe(0);
		expect(stored.find(request => request.entryId === "dated-explicit-zero")?.costUnpriced).toBe(false);
		expect(stored.find(request => request.entryId === "undated-free-flat")?.usage.cost.total).toBe(0);
		expect(stored.find(request => request.entryId === "undated-free-flat")?.costUnpriced).toBe(false);
		expect(stored.find(request => request.entryId === "undated-recorded-zero")?.usage.cost.total).toBe(0);
		expect(stored.find(request => request.entryId === "undated-recorded-zero")?.costUnpriced).toBe(false);
		expect(stored.find(request => request.entryId === "priced")?.usage.cost.total).toBeCloseTo(1.25, 8);

		expect(getOverallStats()).toMatchObject({ unpricedRequests: 1, totalRequests: 5 });
		expect(getOverallStats().totalCost).toBeCloseTo(1.25, 8);
		expect(getStatsByModel().find(model => model.model === "deepseek-v4-flash")).toMatchObject({
			totalCost: 0,
			unpricedRequests: 1,
		});
		expect(getStatsByModel().find(model => model.model === freeModel.id)).toMatchObject({
			totalCost: 0,
			unpricedRequests: 0,
		});
		expect(getStatsByProvider().find(provider => provider.provider === "anthropic")).toMatchObject({
			totalCost: 1.25,
			unpricedRequests: 0,
		});
		// The undated rows bucket at the epoch, so ask for the uncut series.
		const series = getCostTimeSeries(90, null);
		expect(series.reduce((sum, point) => sum + point.unpricedRequests, 0)).toBe(1);
		expect(series.reduce((sum, point) => sum + point.cost, 0)).toBeCloseTo(1.25, 8);
		// The Traces session list reads the same marker through the rollup.
		expect(getSessionRollups()).toMatchObject([{ unpricedRequests: 1, requests: 5 }]);

		closeDb();
		await initDb();
		expect(getOverallStats()).toMatchObject({ unpricedRequests: 1, totalCost: 1.25 });
		expect(getRecentRequests(5).find(request => request.entryId === "undated-scheduled")?.costUnpriced).toBe(true);
		expect(getRecentRequests(5).find(request => request.entryId === "undated-free-flat")?.costUnpriced).toBe(false);
	});

	it("preserves recorded scheduled charges, including explicit zero, on ingest and reopen", async () => {
		await initDb();
		const requests = [0, 0.75, 1.5].map((total, index) => {
			const stats = createCodexGptStats(`recorded-${index}`);
			stats.provider = "deepseek";
			stats.model = "deepseek-v4-flash";
			stats.api = "openai-completions";
			stats.timestamp = Date.parse("2026-09-10T03:00:00Z") + index;
			stats.usage.cost = { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total };
			return stats;
		});
		insertMessageStats(requests);
		expect(getOverallStats().totalCost).toBeCloseTo(2.25, 8);
		expect(getRecentRequests(3).find(request => request.entryId === "recorded-0")?.usage.cost.total).toBe(0);
		closeDb();
		await initDb();
		expect(getOverallStats().totalCost).toBeCloseTo(2.25, 8);
		expect(getRecentRequests(3).find(request => request.entryId === "recorded-0")?.usage.cost.total).toBe(0);
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
