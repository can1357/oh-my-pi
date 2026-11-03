import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
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
const INPUT_ONLY: Tokens = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 };
const INPUT_OUTPUT: Tokens = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

// What those releases recorded for STANDARD tokens on V4 Pro: Flash rates
// ($0.30 / $1.20 / $0.006 per 1M) under the 50% off-peak tariff.
const RELEASED_PEAK = { input: 0.06, output: 0.024, cacheRead: 0.0048, cacheWrite: 0, total: 0.0888 };
const RELEASED_OFF_PEAK = { input: 0.03, output: 0.012, cacheRead: 0.0024, cacheWrite: 0, total: 0.0444 };
// The same requests at the Pro card ($1.32 / $3.96 / $0.044 per 1M).
const PRO_PEAK = { input: 0.264, output: 0.0792, cacheRead: 0.0352, cacheWrite: 0, total: 0.3784 };
const PRO_OFF_PEAK = { input: 0.132, output: 0.0396, cacheRead: 0.0176, cacheWrite: 0, total: 0.1892 };

// A models.yml price is flat: it never applies the off-peak tariff.
// Card A equals the withdrawn Flash card; card B is { input 0.3, output 9, cache-read 2, cache-write 1 }.
const CARD_A_STANDARD = RELEASED_PEAK;
const CARD_A_SMALL = { input: 0.03, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.042 };
const CARD_B_INPUT_ONLY = { input: 0.0003, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0003 };
const CARD_B_INPUT_OUTPUT = { input: 0.0003, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.0012 };
const TOTAL_ONLY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0888 };

function request(
	session: string,
	entryId: string,
	timestamp: number,
	cost: Cost,
	tokens: Tokens = STANDARD,
	provider = "deepseek",
	model = "deepseek-v4-pro",
): MessageStats {
	return {
		sessionFile: `/tmp/withdrawn-${session}.jsonl`,
		entryId,
		folder: "/tmp/project",
		model,
		provider,
		api: "openai-completions",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			...tokens,
			totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			cost: { ...cost },
		},
		agentType: "main",
	};
}

// One transcript per scenario: the repair proves where a price came from per transcript.
function requests(): MessageStats[] {
	return [
		// The released catalog in both tariff periods: only a schedule charges two rates.
		request("released", "released-peak", PEAK, RELEASED_PEAK),
		request("released", "released-off-peak", OFF_PEAK, RELEASED_OFF_PEAK),
		request("released", "released-before-card", BEFORE_CARD, RELEASED_PEAK),
		// The released catalog in one period only: the same costs a flat card A records.
		request("peak-only", "peak-only-1", PEAK, RELEASED_PEAK),
		request("peak-only", "peak-only-2", PEAK + 60_000, CARD_A_SMALL, SMALL),
		// Reviewer case 1: models.yml card A, the withdrawn card's own rates, flat.
		request("card-a", "card-a-peak", PEAK, CARD_A_STANDARD),
		request("card-a", "card-a-peak-small", PEAK + 60_000, CARD_A_SMALL, SMALL),
		request("card-a", "card-a-off-peak", OFF_PEAK, CARD_A_STANDARD),
		// Reviewer case 2: card B, one billed leg that the withdrawn card prices the same.
		request("card-b-one-leg", "card-b-one-leg", PEAK, CARD_B_INPUT_ONLY, INPUT_ONLY),
		// Reviewer case 3: card B, two billed legs.
		request("card-b-two-legs", "card-b-two-legs", PEAK, CARD_B_INPUT_OUTPUT, INPUT_OUTPUT),
		// The catalog and card A in one transcript: no row can be attributed.
		request("mixed", "mixed-released-peak", PEAK, RELEASED_PEAK),
		request("mixed", "mixed-released-off-peak", OFF_PEAK, RELEASED_OFF_PEAK),
		request("mixed", "mixed-card-a-peak", PEAK + 60_000, CARD_A_STANDARD),
		request("mixed", "mixed-card-b", PEAK + 120_000, CARD_B_INPUT_OUTPUT, INPUT_OUTPUT),
		// A provider-reported total, another model, and a provider the card did not cover.
		request("total-only", "total-only-peak", PEAK, TOTAL_ONLY),
		request("total-only", "total-only-off-peak", OFF_PEAK, { ...TOTAL_ONLY, total: 0.0444 }),
		request("flash", "flash-peak", PEAK, RELEASED_PEAK, STANDARD, "deepseek", "deepseek-v4-flash"),
		request("flash", "flash-off-peak", OFF_PEAK, RELEASED_OFF_PEAK, STANDARD, "deepseek", "deepseek-v4-flash"),
		request("fireworks", "fireworks-peak", PEAK, RELEASED_PEAK, STANDARD, "fireworks"),
		request("fireworks", "fireworks-off-peak", OFF_PEAK, RELEASED_OFF_PEAK, STANDARD, "fireworks"),
	];
}

const RECORDED: Record<string, Cost> = Object.fromEntries(requests().map(stats => [stats.entryId, stats.usage.cost]));
const REPAIRED: Record<string, Cost> = {
	...RECORDED,
	"released-peak": PRO_PEAK,
	"released-off-peak": PRO_OFF_PEAK,
};

// Twelve decimal places: far below any price difference, far above float noise.
function rounded(cost: Cost): Cost {
	const round = (value: number) => Math.round(value * 1e12) / 1e12;
	return {
		input: round(cost.input),
		output: round(cost.output),
		cacheRead: round(cost.cacheRead),
		cacheWrite: round(cost.cacheWrite),
		total: round(cost.total),
	};
}

function expectCosts(expected: Record<string, Cost>): void {
	const stored = Object.fromEntries(getRecentRequests(100).map(row => [row.entryId, rounded(row.usage.cost)]));
	expect(stored).toEqual(
		Object.fromEntries(Object.entries(expected).map(([entryId, cost]) => [entryId, rounded(cost)])),
	);
}

type RawRow = Record<string, number | string | null>;

function rawRows(database: Database): RawRow[] {
	return database.query("SELECT * FROM messages ORDER BY entry_id").all() as RawRow[];
}

// Card C, { input 9, output 9, cache-read 9 }, for STANDARD tokens: a price no catalog produced.
const OTHER_CARD_STANDARD = { input: 1.8, output: 0.18, cacheRead: 7.2, cacheWrite: 0, total: 9.18 };

/** An assistant entry as the coding agent writes it; `cost` undefined omits `usage.cost`. */
function assistantEntry(id: string, parentId: string | null, timestamp: number, cost: Cost | undefined) {
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
			usage: { ...STANDARD, totalTokens: 1_020_000, orchestration: null, ...(cost && { cost }) },
			stopReason: "stop",
			timestamp,
			duration: 1000,
			ttft: 100,
		},
	};
}

async function writeTranscript(name: string, entries: unknown[]): Promise<string> {
	const projectDir = path.join(getSessionsDir(), "--tmp--withdrawn-rate");
	await fs.mkdir(projectDir, { recursive: true });
	const file = path.join(projectDir, `1789459800000_${name}.jsonl`);
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

const round12 = (value: number) => Math.round(value * 1e12) / 1e12;

/** Stored totals by entry id. */
function storedCosts(): Record<string, number> {
	return Object.fromEntries(getRecentRequests(100).map(row => [row.entryId, round12(row.usage.cost.total)]));
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

describe("stats costs from a withdrawn rate card", () => {
	it("re-prices a transcript whose costs follow the withdrawn card's tariff, and keeps every other recorded cost", async () => {
		const database = await initDb();
		insertMessageStats(requests());
		expectCosts(REPAIRED);

		// Re-ingesting the unchanged transcripts must not bring the Flash prices back.
		const repaired = rawRows(database);
		insertMessageStats(requests());
		expect(rawRows(database)).toEqual(repaired);
		closeDb();
		await initDb();
		expectCosts(REPAIRED);
	});

	it("re-prices a request appended to a repaired transcript", async () => {
		await initDb();
		insertMessageStats(requests().filter(stats => stats.entryId.startsWith("released-")));
		insertMessageStats([request("released", "released-later", PEAK + 60_000, CARD_A_SMALL, SMALL)]);
		const later = getRecentRequests(10).find(row => row.entryId === "released-later");
		expect(rounded(later!.usage.cost)).toEqual(
			rounded({ input: 0.132, output: 0.0396, cacheRead: 0, cacheWrite: 0, total: 0.1716 }),
		);
	});

	it("re-prices a synced catalog transcript in both tariff periods, and its trace agrees", async () => {
		const file = await writeTranscript("catalog", [
			assistantEntry("c1", null, PEAK, RELEASED_PEAK),
			assistantEntry("c2", "c1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		const transcript = await Bun.file(file).text();
		const repaired = { c1: 0.3784, c2: 0.1892 };

		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(repaired);
		expect(await tracedCosts(file)).toEqual(repaired);

		await clearMeta("messages_cost_reingest_v1");
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(repaired);
		expect(await Bun.file(file).text()).toBe(transcript);
	});

	it("keeps a models.yml price equal to the withdrawn card when the other request is at the current catalog", async () => {
		// Card A at peak, then the override removed: the current catalog at peak.
		const file = await writeTranscript("override-removed", [
			assistantEntry("o1", null, PEAK, CARD_A_STANDARD),
			assistantEntry("o2", "o1", PEAK + 60_000, PRO_PEAK),
		]);
		const recorded = { o1: 0.0888, o2: 0.3784 };
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(recorded);
		expect(await tracedCosts(file)).toEqual(recorded);
	});

	it("never counts an estimated cost as evidence", async () => {
		// A legacy request with no recorded cost: stats estimates it at the current catalog.
		const file = await writeTranscript("estimated", [
			assistantEntry("e1", null, PEAK, CARD_A_STANDARD),
			assistantEntry("e2", "e1", OFF_PEAK, undefined),
		]);
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual({ e1: 0.0888, e2: 0.1892 });
		expect(await tracedCosts(file)).toEqual({ e1: 0.0888 });
	});

	it("withdraws a repair when an appended request contradicts it, and every later sync agrees", async () => {
		const file = await writeTranscript("appended", [
			assistantEntry("a1", null, PEAK, RELEASED_PEAK),
			assistantEntry("a2", "a1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual({ a1: 0.3784, a2: 0.1892 });

		// A third price in the transcript: no request in it can be attributed any more.
		await fs.appendFile(
			file,
			`${JSON.stringify(assistantEntry("a3", "a2", OFF_PEAK + 60_000, OTHER_CARD_STANDARD))}\n`,
		);
		const recorded = { a1: 0.0888, a2: 0.0444, a3: 9.18 };
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(recorded);
		expect(await tracedCosts(file)).toEqual(recorded);

		await clearMeta("withdrawn_rate_repair");
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(recorded);

		await clearMeta("messages_cost_reingest_v1");
		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual(recorded);
	});

	it("repairs a database an affected release wrote, and a second sync changes nothing", async () => {
		await writeTranscript("upgrade-catalog", [
			assistantEntry("u1", null, PEAK, RELEASED_PEAK),
			assistantEntry("u2", "u1", OFF_PEAK, RELEASED_OFF_PEAK),
		]);
		await writeTranscript("upgrade-card-a", [
			assistantEntry("u3", null, PEAK, CARD_A_STANDARD),
			assistantEntry("u4", "u3", OFF_PEAK, CARD_A_STANDARD),
		]);
		await syncAllSessions({ workers: 1 });
		// The schema and rows an affected release left: no recorded-cost column,
		// Flash-rate costs, and cache savings measured against the Flash input rate.
		const database = await initDb();
		const age = database.query(
			"UPDATE messages SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?, cost_no_cache_input = ? WHERE entry_id = ?",
		);
		for (const [entryId, cost, noCacheInput] of [
			["u1", RELEASED_PEAK, 0.3],
			["u2", RELEASED_OFF_PEAK, 0.15],
		] as const) {
			age.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, noCacheInput, entryId);
		}
		database.run("ALTER TABLE messages DROP COLUMN recorded_cost");
		database.run("DELETE FROM meta WHERE key = 'withdrawn_rate_repair'");
		closeDb();

		await syncAllSessions({ workers: 1 });
		expect(storedCosts()).toEqual({ u1: 0.3784, u2: 0.1892, u3: 0.0888, u4: 0.0888 });
		const upgraded = await initDb();
		const noCacheInput = Object.fromEntries(
			(
				upgraded
					.query("SELECT entry_id, cost_no_cache_input FROM messages WHERE entry_id IN ('u1', 'u2')")
					.all() as { entry_id: string; cost_no_cache_input: number }[]
			).map(row => [row.entry_id, row.cost_no_cache_input]),
		);
		expect(noCacheInput.u1).toBeCloseTo(1.32, 12);
		expect(noCacheInput.u2).toBeCloseTo(0.66, 12);

		const rows = rawRows(upgraded);
		closeDb();
		await syncAllSessions({ workers: 1 });
		expect(rawRows(await initDb())).toEqual(rows);
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
