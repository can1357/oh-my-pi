import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb } from "@oh-my-pi/omp-stats/db";
import { buildSessionTrace } from "@oh-my-pi/omp-stats/trace";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-withdrawn-");

// DeepSeek's Flash card for V4 Pro started 2026-09-14T04:00Z in v18.1.17
// through v18.12.6, and #16881 withdrew it. Tuesday 2026-09-15 06:30Z is
// inside the 06:00-10:00 peak window; 12:00Z is off-peak (half price).
const PEAK = Date.parse("2026-09-15T06:30:00Z");
const OFF_PEAK = Date.parse("2026-09-15T12:00:00Z");
// Monday 2026-09-14 03:30Z: peak, but before the withdrawn card started.
const BEFORE_CARD = Date.parse("2026-09-14T03:30:00Z");

type Cost = MessageStats["usage"]["cost"];
type Tokens = Pick<MessageStats["usage"], "input" | "output" | "cacheRead" | "cacheWrite">;

const STANDARD: Tokens = { input: 200_000, output: 20_000, cacheRead: 800_000, cacheWrite: 0 };
const SMALL: Tokens = { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 };

// What those releases recorded for STANDARD tokens on V4 Pro: Flash rates
// ($0.30 / $1.20 / $0.006 per 1M) under the 50% off-peak tariff.
const RELEASED_PEAK = { input: 0.06, output: 0.024, cacheRead: 0.0048, cacheWrite: 0, total: 0.0888 };
const RELEASED_OFF_PEAK = { input: 0.03, output: 0.012, cacheRead: 0.0024, cacheWrite: 0, total: 0.0444 };
// The same requests at the Pro card ($1.32 / $3.96 / $0.044 per 1M).
const PRO_PEAK = { input: 0.264, output: 0.0792, cacheRead: 0.0352, cacheWrite: 0, total: 0.3784 };
const PRO_OFF_PEAK = { input: 0.132, output: 0.0396, cacheRead: 0.0176, cacheWrite: 0, total: 0.1892 };
// A models.yml price is flat: it never applies the off-peak tariff. Card A
// equals the withdrawn Flash card's rates; card C is a price no catalog ever
// produced ({ input 9, output 9, cache-read 9 } per 1M on STANDARD tokens).
const CARD_A_PEAK = RELEASED_PEAK;
const CARD_A_SMALL = { input: 0.03, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.042 };
const CARD_C = { input: 1.8, output: 0.18, cacheRead: 7.2, cacheWrite: 0, total: 9.18 };

/** An assistant entry as the coding agent writes it; `cost` undefined omits `usage.cost`. */
function assistantEntry(
	id: string,
	parentId: string | null,
	timestamp: number,
	cost: Cost | undefined,
	tokens: Tokens = STANDARD,
) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp + 1000).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: {
				...tokens,
				totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
				orchestration: null,
				...(cost && { cost }),
			},
			stopReason: "stop",
			timestamp,
			duration: 1000,
			ttft: 100,
		},
	};
}

/**
 * A role-model attempt as the coding agent journals it: usage and outcome,
 * no request or response payload. stats.db stores it as a request of the same
 * model; the trace shows no span for it.
 */
function modelUsageEntry(id: string, parentId: string | null, timestamp: number, cost: Cost) {
	return {
		type: "model_usage",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		purpose: "judge",
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			...STANDARD,
			totalTokens: 1_020_000,
			cost,
		},
		stopReason: "stop",
	};
}

let transcriptSeq = 0;

async function writeTranscript(name: string, entries: unknown[]): Promise<string> {
	const projectDir = path.join(getSessionsDir(), "--tmp--withdrawn-rate");
	await fs.mkdir(projectDir, { recursive: true });
	// Name order is ingest order within a recency tier: a fork follows its parent.
	const file = path.join(projectDir, `${1789459800000 + transcriptSeq++}_${name}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: name,
		timestamp: new Date(PEAK).toISOString(),
		cwd: "/tmp/project",
	};
	await Bun.write(file, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

async function append(file: string, entry: unknown): Promise<void> {
	await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
}

const round12 = (value: number) => Math.round(value * 1e12) / 1e12;

/** What `omp stats` reads for each request, by entry id. */
function readCosts(): Record<string, number> {
	return Object.fromEntries(getRecentRequests(100).map(row => [row.entryId, round12(row.usage.cost.total)]));
}

/** What the database stores, by entry id: the transcript's own cost, never a derived one. */
async function storedCosts(): Promise<Record<string, number>> {
	const rows = (await initDb()).query("SELECT entry_id, cost_total FROM messages").all() as {
		entry_id: string;
		cost_total: number;
	}[];
	return Object.fromEntries(rows.map(row => [row.entry_id, round12(row.cost_total)]));
}

/** The whole-history total the summary prints, through the aggregate query path it uses. */
async function summaryTotal(): Promise<number> {
	return round12((await getDashboardStats("all")).overall.totalCost);
}

/** The trace's model-span totals by entry id, for spans that show a cost. */
async function tracedCosts(file: string): Promise<Record<string, number>> {
	const trace = await buildSessionTrace(file);
	const costs: Record<string, number> = {};
	for (const track of trace.tracks) {
		for (const span of track.spans) {
			if (span.kind === "model" && span.entryId !== undefined && span.cost !== undefined) {
				costs[span.entryId] = round12(span.cost);
			}
		}
	}
	return costs;
}

async function clearMeta(key: string): Promise<void> {
	(await initDb()).query("DELETE FROM meta WHERE key = ?").run(key);
	closeDb();
}

function rawRows(database: Database): Record<string, number | string | null>[] {
	return database.query("SELECT * FROM messages ORDER BY entry_id").all() as Record<string, number | string | null>[];
}

describe("costs recorded at a withdrawn rate card", () => {
	it("re-prices a transcript the catalog priced in both tariff periods, and the trace agrees", async () => {
		const file = await writeTranscript("catalog", [
			assistantEntry("c1", null, PEAK, RELEASED_PEAK),
			assistantEntry("c2", "c1", OFF_PEAK, RELEASED_OFF_PEAK),
			// Before the card's start the released catalog charged the Pro card,
			// so this cost is neither the card's price nor evidence against it.
			assistantEntry("c3", "c2", BEFORE_CARD, RELEASED_PEAK),
		]);
		const bytes = await Bun.file(file).text();
		await syncAllSessions({ workers: 1 });

		const read = { c1: 0.3784, c2: 0.1892, c3: 0.0888 };
		expect(readCosts()).toEqual(read);
		expect(await tracedCosts(file)).toEqual(read);
		expect(await summaryTotal()).toBeCloseTo(0.6564, 12);

		// Nothing derived is stored: the transcript's own costs stand in the row.
		expect(await storedCosts()).toEqual({ c1: 0.0888, c2: 0.0444, c3: 0.0888 });
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	it("keeps every cost a single request, a flat card or a third price recorded", async () => {
		const single = await writeTranscript("single", [assistantEntry("s1", null, PEAK, RELEASED_PEAK)]);
		// Card A in both periods: a flat models.yml price charges one rate per leg.
		const flat = await writeTranscript("flat-card", [
			assistantEntry("f1", null, PEAK, CARD_A_PEAK),
			assistantEntry("f2", "f1", OFF_PEAK, CARD_A_PEAK),
			assistantEntry("f3", "f2", PEAK + 60_000, CARD_A_SMALL, SMALL),
		]);
		// The catalog in both periods plus a third price: nothing is attributable.
		const third = await writeTranscript("third-price", [
			assistantEntry("t1", null, PEAK, RELEASED_PEAK),
			assistantEntry("t2", "t1", OFF_PEAK, RELEASED_OFF_PEAK),
			assistantEntry("t3", "t2", OFF_PEAK + 60_000, CARD_C),
		]);
		await syncAllSessions({ workers: 1 });

		const recorded = {
			s1: 0.0888,
			f1: 0.0888,
			f2: 0.0888,
			f3: 0.042,
			t1: 0.0888,
			t2: 0.0444,
			t3: 9.18,
		};
		expect(readCosts()).toEqual(recorded);
		expect(await storedCosts()).toEqual(recorded);
		expect(await tracedCosts(single)).toEqual({ s1: 0.0888 });
		expect(await tracedCosts(flat)).toEqual({ f1: 0.0888, f2: 0.0888, f3: 0.042 });
		expect(await tracedCosts(third)).toEqual({ t1: 0.0888, t2: 0.0444, t3: 9.18 });
	});

	it("never counts a cost stats estimated as evidence", async () => {
		// The second request records no cost, so stats prices it at the current
		// catalog: a neutral price, not the card's, in the other tariff period.
		const file = await writeTranscript("estimated", [
			assistantEntry("e1", null, PEAK, CARD_A_PEAK),
			assistantEntry("e2", "e1", OFF_PEAK, undefined),
		]);
		await syncAllSessions({ workers: 1 });
		expect(readCosts()).toEqual({ e1: 0.0888, e2: 0.1892 });
		expect(await tracedCosts(file)).toEqual({ e1: 0.0888 });
	});

	it("reads one cost for a request a billed model_usage record contradicts", async () => {
		// Blocker 2: the trace and the database read the same evidence, so a
		// record only stats.db stores cannot leave them disagreeing.
		const file = await writeTranscript("model-usage", [
			assistantEntry("m1", null, PEAK, RELEASED_PEAK),
			assistantEntry("m2", "m1", OFF_PEAK, RELEASED_OFF_PEAK),
			modelUsageEntry("m3", "m2", OFF_PEAK + 60_000, CARD_C),
		]);
		await syncAllSessions({ workers: 1 });

		const recorded = { m1: 0.0888, m2: 0.0444, m3: 9.18 };
		expect(readCosts()).toEqual(recorded);
		expect(await summaryTotal()).toBeCloseTo(9.3132, 12);
		// The trace shows no span for a model_usage record; the two requests it
		// does show read exactly what the database reads for them.
		expect(await tracedCosts(file)).toEqual({ m1: 0.0888, m2: 0.0444 });
	});

	it("withdraws a correction when an appended request contradicts it, whichever writer ingests it", async () => {
		// Blocker 3: an older writer stores what the transcript recorded, and
		// nothing stored is derived, so the correction follows the bytes.
		const file = await writeTranscript("appended", [
			assistantEntry("a1", null, PEAK, RELEASED_PEAK),
			assistantEntry("a2", "a1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await syncAllSessions({ workers: 1 });
		expect(readCosts()).toEqual({ a1: 0.3784, a2: 0.1892 });

		await append(file, assistantEntry("a3", "a2", OFF_PEAK + 60_000, CARD_C));
		await syncAllSessions({ workers: 1 });
		const recorded = { a1: 0.0888, a2: 0.0444, a3: 9.18 };
		expect(readCosts()).toEqual(recorded);
		expect(await summaryTotal()).toBeCloseTo(9.3132, 12);
		expect(await tracedCosts(file)).toEqual(recorded);

		// A marker reset and a full re-ingest of the same bytes end where they began.
		await clearMeta("withdrawn_rate_restore_v1");
		await syncAllSessions({ workers: 1 });
		expect(readCosts()).toEqual(recorded);
		await clearMeta("messages_cost_reingest_v1");
		await syncAllSessions({ workers: 1 });
		expect(readCosts()).toEqual(recorded);
		expect(await summaryTotal()).toBeCloseTo(9.3132, 12);
	});

	it("reads one cost for a request a fork repeats, in either ingest order", async () => {
		// Blocker 4: the fork guard stores the shared request once, under
		// whichever transcript was ingested first. The link it records puts both
		// transcripts in one evidence group, so the answer does not depend on it.
		const parent = await writeTranscript("fork-parent", [assistantEntry("p1", null, PEAK, RELEASED_PEAK)]);
		const forkEntries = [
			assistantEntry("p1", null, PEAK, RELEASED_PEAK),
			assistantEntry("k2", "p1", OFF_PEAK, RELEASED_OFF_PEAK),
		];
		await syncAllSessions({ workers: 1 });
		// Incrementally: the parent already owns the shared request.
		const fork = await writeTranscript("fork-child", forkEntries);
		await syncAllSessions({ workers: 1 });

		const repriced = { p1: 0.3784, k2: 0.1892 };
		expect(readCosts()).toEqual(repriced);
		expect(await summaryTotal()).toBeCloseTo(0.5676, 12);
		expect(await tracedCosts(parent)).toEqual({ p1: 0.3784 });
		expect(await tracedCosts(fork)).toEqual(repriced);

		// The same bytes ingested from scratch, the fork first: the other owner.
		const database = await initDb();
		database.run("DELETE FROM messages");
		database.run("DELETE FROM message_copies");
		database.run("DELETE FROM file_offsets");
		closeDb();
		await syncAllSessions({ workers: 1, files: [fork, parent] });
		expect(readCosts()).toEqual(repriced);
		expect(await summaryTotal()).toBeCloseTo(0.5676, 12);
		expect(await tracedCosts(parent)).toEqual({ p1: 0.3784 });
		expect(await tracedCosts(fork)).toEqual(repriced);
	});

	it("corrects a user's own card that recorded the withdrawn card's peak price, the documented residual", async () => {
		// In the recorded bytes a models.yml card equal to the withdrawn peak
		// price, followed by the catalog's off-peak price, cannot be told apart
		// from the catalog pricing both. It reads corrected; the recorded cost
		// stays readable in the row, and a later catalog can revise the view.
		const file = await writeTranscript("residual", [
			assistantEntry("r1", null, PEAK, CARD_A_PEAK),
			assistantEntry("r2", "r1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await syncAllSessions({ workers: 1 });

		expect(readCosts()).toEqual({ r1: 0.3784, r2: 0.1892 });
		expect(await tracedCosts(file)).toEqual({ r1: 0.3784, r2: 0.1892 });
		expect(await storedCosts()).toEqual({ r1: 0.0888, r2: 0.0444 });
	});

	it("restores a database an earlier build corrected in place, and keeps reading it corrected", async () => {
		const file = await writeTranscript("restored", [
			assistantEntry("u1", null, PEAK, RELEASED_PEAK),
			assistantEntry("u2", "u1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await syncAllSessions({ workers: 1 });

		// The rows that build left: the catalog price in `cost`, the recorded
		// cost beside it, and its own marker.
		const legacy = await initDb();
		legacy.run("ALTER TABLE messages ADD COLUMN recorded_cost TEXT");
		const age = legacy.query(
			`UPDATE messages SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?,
			 cost_total = ?, recorded_cost = ? WHERE entry_id = ?`,
		);
		for (const [entryId, derived, recorded] of [
			["u1", PRO_PEAK, RELEASED_PEAK],
			["u2", PRO_OFF_PEAK, RELEASED_OFF_PEAK],
		] as const) {
			age.run(
				derived.input,
				derived.output,
				derived.cacheRead,
				derived.cacheWrite,
				derived.total,
				JSON.stringify(recorded),
				entryId,
			);
		}
		legacy.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('withdrawn_rate_repair', '18.0.0')").run();
		legacy.query("DELETE FROM meta WHERE key = 'withdrawn_rate_restore_v1'").run();
		closeDb();

		const restored = await initDb();
		expect(await storedCosts()).toEqual({ u1: 0.0888, u2: 0.0444 });
		expect(
			(restored.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(column => column.name),
		).not.toContain("recorded_cost");
		expect(restored.query("SELECT value FROM meta WHERE key = 'withdrawn_rate_repair'").get()).toBeNull();
		expect(readCosts()).toEqual({ u1: 0.3784, u2: 0.1892 });
		expect(await tracedCosts(file)).toEqual({ u1: 0.3784, u2: 0.1892 });

		// A sync after the restore changes no row, and a second one changes nothing again.
		await syncAllSessions({ workers: 1 });
		const rows = rawRows(await initDb());
		closeDb();
		await syncAllSessions({ workers: 1 });
		expect(rawRows(await initDb())).toEqual(rows);
	});

	it("restores a database an earlier build corrected before it kept the recorded cost", async () => {
		// That build wrote the derived cost with no column beside it, so the
		// transcripts are the only record left: one re-parse recovers them.
		await writeTranscript("reparsed", [
			assistantEntry("v1", null, PEAK, RELEASED_PEAK),
			assistantEntry("v2", "v1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await syncAllSessions({ workers: 1 });
		const legacy = await initDb();
		const age = legacy.query(
			"UPDATE messages SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ? WHERE entry_id = ?",
		);
		for (const [entryId, derived] of [
			["v1", PRO_PEAK],
			["v2", PRO_OFF_PEAK],
		] as const) {
			age.run(derived.input, derived.output, derived.cacheRead, derived.cacheWrite, derived.total, entryId);
		}
		legacy.query("DELETE FROM meta WHERE key = 'withdrawn_rate_restore_v1'").run();
		closeDb();

		await initDb();
		await syncAllSessions({ workers: 1 });
		expect(await storedCosts()).toEqual({ v1: 0.0888, v2: 0.0444 });
		expect(readCosts()).toEqual({ v1: 0.3784, v2: 0.1892 });
	});

	it("reads the same costs from concurrent syncs and from a second sync", async () => {
		const file = await writeTranscript("concurrent", [
			assistantEntry("n1", null, PEAK, RELEASED_PEAK),
			assistantEntry("n2", "n1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await Promise.all([syncAllSessions({ workers: 1 }), syncAllSessions({ workers: 1 })]);
		const repriced = { n1: 0.3784, n2: 0.1892 };
		expect(readCosts()).toEqual(repriced);
		await syncAllSessions({ workers: 1 });
		expect(readCosts()).toEqual(repriced);
		expect(await tracedCosts(file)).toEqual(repriced);
		expect(await summaryTotal()).toBeCloseTo(0.5676, 12);
	});

	it("traces a transcript whose usage carries a null orchestration", async () => {
		const projectDir = path.join(getSessionsDir(), "--tmp--null-orchestration");
		await fs.mkdir(projectDir, { recursive: true });
		const file = path.join(projectDir, "1789459800000_null.jsonl");
		const entries = [
			{ type: "session", version: 3, id: "n", timestamp: new Date(PEAK).toISOString(), cwd: "/tmp/project" },
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: new Date(PEAK + 1000).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "openai",
					model: "gpt-4o",
					usage: {
						input: 1000,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1100,
						orchestration: null,
						cost: { input: 0.0025, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0035 },
					},
					stopReason: "stop",
					timestamp: PEAK,
					duration: 1000,
				},
			},
		];
		await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const { summary } = await buildSessionTrace(file);
		expect(summary.costTotal).toBeCloseTo(0.0035, 12);
	});
});
