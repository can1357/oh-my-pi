import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import {
	closeDb,
	getFileOffset,
	getOverallStats,
	getRecentRequests,
	initDb,
	insertMessageStats,
	insertToolCalls,
} from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-malformed-");

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(id: string, message: Record<string, unknown>): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-07-12T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			...message,
		},
	});
}

async function writeSession(lines: string[]): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--malformed");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

// Regression: a single persisted assistant message missing `stopReason` (or
// usage/token fields) used to bind NULL into stats.db's NOT NULL columns and
// crash the entire sync with SQLITE_CONSTRAINT_NOTNULL. The parser must
// coerce or skip malformed entries so the batch always inserts.
describe("malformed session entries", () => {
	it("coerces a missing stopReason instead of failing the NOT NULL insert", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [{ type: "text", text: "hi" }], usage: USAGE, timestamp: 1752000000000 }),
			assistantEntry("a2", {
				content: [],
				usage: USAGE,
				timestamp: 1752000001000,
				errorMessage: "boom",
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.stopReason)).toEqual(["aborted", "error"]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
	});

	it("zero-fills missing token counts and falls back to the entry timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				stopReason: "stop",
				usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);
		const stats = result.stats[0];
		expect(stats.usage.totalTokens).toBe(0);
		expect(stats.timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
	});

	// Regression: legacy session files can carry a partially-populated
	// `usage.cost` (e.g. only `total`). The parser passes such objects through
	// untouched, and the raw cost used to bind NULL into the cost_* NOT NULL
	// columns and crash the entire sync with SQLITE_CONSTRAINT_NOTNULL.
	it("normalises a partial legacy usage.cost instead of failing the NOT NULL insert", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				stopReason: "stop",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 1 } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 });
	});
	it("preserves partial legacy cost components when total is missing", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				model: "claude-sonnet-4-6",
				stopReason: "stop",
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 1 } },
			}),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.usage.cost).toEqual({
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1,
		});
	});

	it("skips assistant entries with no usage or model attribution", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [], stopReason: "stop" }),
			JSON.stringify({
				type: "message",
				id: "a2",
				timestamp: "2026-07-12T00:00:00.000Z",
				message: { role: "assistant", content: [], stopReason: "stop", usage: USAGE },
			}),
			assistantEntry("ok", { content: [], stopReason: "stop", usage: USAGE, timestamp: 1752000002000 }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["ok"]);
	});

	it("ignores malformed content blocks without aborting later entries", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [null, { type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
				usage: USAGE,
				timestamp: 1752000000000,
			}),
			assistantEntry("a2", { content: [], usage: USAGE, timestamp: 1752000001000 }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["a1", "a2"]);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
	});

	it("keeps tool_calls insertable when the turn lacks a message timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", name: "broken" }, // no id: unattributable, must be skipped
				],
				usage: USAGE,
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
		expect(result.toolCalls[0].timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertToolCalls(result.toolCalls)).toBe(1);
	});
});

// Thursday 02:00 UTC, inside DeepSeek's weekday [01:00, 04:00) peak window.
const DEEPSEEK_PEAK = Date.parse("2026-09-10T02:00:00Z");

function deepseekEntry(id: string, usage: Record<string, unknown>, timestamp?: number): string {
	return assistantEntry(id, {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		api: "openai-completions",
		stopReason: "stop",
		content: [],
		usage,
		...(timestamp === undefined ? {} : { timestamp }),
	});
}

// Regression: an entry that omits `usage.cost` outright was ingested with a
// synthesized zero, and `resolveStoredCost` freezes any recorded charge on a
// scheduled card — so legacy DeepSeek peak usage was stored as exactly $0 and
// `backfillMissingCatalogCosts` never revisits scheduled rows to repair it.
// Absence must stay absent until the request timestamp prices it.
describe("legacy entries without a recorded price", () => {
	it("estimates the stored cost at the request timestamp instead of freezing zero", async () => {
		const file = await writeSession([
			deepseekEntry("unpriced", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, DEEPSEEK_PEAK),
			deepseekEntry(
				"explicit-zero",
				{
					input: 1_000_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				DEEPSEEK_PEAK,
			),
		]);

		const result = await parseSessionFile(file);
		// The omitted counter is derived from the conversation buckets.
		expect(result.stats.map(s => s.usage.totalTokens)).toEqual([1_000_000, 1_000_000]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);

		const stored = getRecentRequests(2);
		// 1M uncached input tokens at the peak card's $0.30/M.
		expect(stored.find(request => request.entryId === "unpriced")?.usage.cost.total).toBeCloseTo(0.3, 8);
		// A recorded zero is a real charge and stays zero.
		expect(stored.find(request => request.entryId === "explicit-zero")?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBeCloseTo(0.3, 8);
		// Uncached-equivalent prompt cost 2 x $0.30 against $0.30 of recorded
		// prompt charges (the frozen zero row contributes none).
		expect(getOverallStats().cacheSavings).toBeCloseTo(0.5, 8);

		closeDb();
		await initDb();

		const reopened = getRecentRequests(2);
		expect(reopened.find(request => request.entryId === "unpriced")?.usage.cost.total).toBeCloseTo(0.3, 8);
		expect(reopened.find(request => request.entryId === "explicit-zero")?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBeCloseTo(0.3, 8);
	});

	it("leaves scheduled usage unpriced when the entry has no recoverable timestamp", async () => {
		const file = await writeSession([
			JSON.stringify({
				type: "message",
				id: "no-timestamp",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-flash",
					api: "openai-completions",
					stopReason: "stop",
					content: [],
					usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats[0].timestamp).toBe(0);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		// The parser's `0` sentinel is not a 1970 request: never bill a peak or
		// off-peak card from it, and never let the missing charge report savings.
		expect(getRecentRequests(1)[0]?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBe(0);
		expect(getOverallStats().cacheSavings).toBe(0);
	});

	it("recovers the entry timestamp when the message timestamp is the zero sentinel", async () => {
		const file = await writeSession([
			JSON.stringify({
				type: "message",
				id: "zero-sentinel",
				timestamp: "2026-09-10T02:00:00.000Z",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-flash",
					api: "openai-completions",
					stopReason: "stop",
					content: [],
					timestamp: 0,
					usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats[0].timestamp).toBe(DEEPSEEK_PEAK);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		// Recovered peak time prices at the peak card instead of unpriced.
		expect(getRecentRequests(1)[0]?.usage.cost.total).toBeCloseTo(0.3, 8);
		expect(getRecentRequests(1)[0]?.costUnpriced).toBe(false);
		expect(getOverallStats()).toMatchObject({ unpricedRequests: 0 });
		expect(getOverallStats().totalCost).toBeCloseTo(0.3, 8);
	});

	// Regression: the derived total is summed with `+` over runtime values a
	// foreign session can make any type. A string bucket passed the nullish
	// check and concatenated — `input: "10"` plus the six absent buckets became
	// "10000000", which SQLite coerced to ten million tokens for a ten-token
	// request. A non-numeric bucket is malformed input, not a number to parse.
	it("counts a non-numeric token bucket as absent instead of concatenating it", async () => {
		const file = await writeSession([
			deepseekEntry("string-bucket", { input: "10", output: 0, cacheRead: 0, cacheWrite: 0 }, DEEPSEEK_PEAK),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(typeof request?.usage.totalTokens).toBe("number");
		expect(request?.usage.totalTokens).toBe(0);
		expect(request?.usage.input).toBe(0);
	});

	// `1e999` is legal JSON and parses to `Infinity`, so a bucket can be a
	// number and still be unusable. It used to satisfy the "well-formed" fast
	// path, skipping the repair branch entirely and binding an infinite token
	// count into a NOT NULL column; a non-finite provider total did the same.
	it("counts a non-finite token bucket as absent instead of binding it", async () => {
		const peak = Date.parse("2026-09-10T02:00:00Z");
		const entry = (id: string, usage: string) =>
			`{"type":"message","id":"${id}","timestamp":"2026-09-10T02:00:00.000Z","message":{"role":"assistant","content":[],"provider":"deepseek","model":"deepseek-v4-flash","api":"openai-completions","stopReason":"stop","timestamp":${peak},"usage":${usage}}}`;
		const file = await writeSession([
			entry("infinite-bucket", '{"input":1e999,"output":0,"cacheRead":0,"cacheWrite":0}'),
			entry("infinite-total", '{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":1e999}'),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(2);
		expect(result.stats.map(s => [s.usage.input, s.usage.totalTokens])).toEqual([
			[0, 0],
			[10, 15],
		]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);

		const stored = getRecentRequests(2);
		const infiniteBucket = stored.find(request => request.entryId === "infinite-bucket");
		const infiniteTotal = stored.find(request => request.entryId === "infinite-total");
		expect(Number.isFinite(infiniteBucket?.usage.input)).toBe(true);
		expect(infiniteBucket?.usage.input).toBe(0);
		expect(infiniteBucket?.usage.totalTokens).toBe(0);
		// A finite provider total is authoritative; only a non-finite one is derived.
		expect(infiniteTotal?.usage.input).toBe(10);
		expect(infiniteTotal?.usage.totalTokens).toBe(15);
	});

	// Regression: the marker only reaches history through a re-parse, and every
	// earlier sentinel is already spent for an existing database. Without the
	// unpriced sentinel, a row ingested before the column existed keeps
	// `cost_unpriced = 0` forever and its unknown scheduled spend reports as free.
	it("re-parses history to mark pre-existing unpriced rows once, then leaves offsets alone", async () => {
		const file = await writeSession([
			JSON.stringify({
				type: "message",
				id: "no-timestamp",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-flash",
					api: "openai-completions",
					stopReason: "stop",
					content: [],
					usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			}),
		]);

		// Bootstrap the schema, then plant the pre-marker state directly.
		await initDb();
		closeDb();

		const sessionStats = await fs.stat(file);
		const raw = new Database(getStatsDbPath());
		raw.exec("DELETE FROM messages");
		raw.exec("DELETE FROM file_offsets");
		// A database from the previous release has never seen this key at all.
		raw.exec("DELETE FROM meta WHERE key = 'messages_cost_unpriced_v1'");
		// Every sentinel that also wipes `file_offsets` is spent, so only the
		// unpriced marker's sentinel can trigger the re-parse below.
		const spent = [
			"user_messages_v8",
			"tool_calls_v1",
			"user_message_links_v1",
			"premium_requests_priority_v1",
			"messages_cost_reingest_v1",
		];
		for (const key of spent) {
			raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, 'complete')").run(key);
		}
		raw.prepare(
			`INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_unpriced
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			file,
			"no-timestamp",
			"/tmp/malformed",
			"deepseek-v4-flash",
			"deepseek",
			"openai-completions",
			0,
			null,
			null,
			"stop",
			null,
			1_000_000,
			0,
			0,
			0,
			1_000_000,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			file,
			sessionStats.size,
			sessionStats.mtimeMs,
		);
		raw.close();

		// The unpriced sentinel is absent, so this sync wipes the offsets and the
		// UPSERT rewrites the row with the marker the ingest now derives.
		await syncAllSessions();

		const repaired = getRecentRequests(1)[0];
		expect(repaired?.entryId).toBe("no-timestamp");
		expect(repaired?.usage.cost.total).toBe(0);
		expect(repaired?.costUnpriced).toBe(true);
		expect(getOverallStats()).toMatchObject({ unpricedRequests: 1, totalCost: 0 });

		// The sync settled the sentinel, so reopening must not wipe the offsets it
		// just wrote — a stale enrolment would re-parse every session on every start.
		const offsets = getFileOffset(file);
		expect(offsets).not.toBeNull();
		closeDb();
		const meta = new Database(getStatsDbPath());
		expect(meta.prepare("SELECT value FROM meta WHERE key = ?").get("messages_cost_unpriced_v1")).toEqual({
			value: "complete",
		});
		meta.close();
		await initDb();
		expect(getFileOffset(file)).toEqual(offsets);
	});
});
