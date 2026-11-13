import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import type { SpotlightAgentScope, SpotlightDashboardStats } from "@oh-my-pi/omp-stats/shared-types";
import { buildSpotlightDashboard } from "@oh-my-pi/omp-stats/spotlight-aggregator";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { type ShapeSpec, SpotlightSessionBuilder } from "./helpers/spotlight-session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-spotlight-measures-");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-20T10:00:00Z");
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

function sessionPath(rel: string): string {
	return path.join(getSessionsDir(), "--repo--", rel);
}

async function write(rel: string, b: SpotlightSessionBuilder): Promise<string> {
	const file = sessionPath(rel);
	await Bun.write(file, b.text());
	return file;
}

async function dashboard(scope: SpotlightAgentScope = "all"): Promise<SpotlightDashboardStats> {
	await syncAllSessions({ workers: 1 });
	return buildSpotlightDashboard(await initDb(), { cutoff: null, bucketMs: DAY }, scope);
}

function call(b: SpotlightSessionBuilder, name: string, args: Record<string, unknown>, text = "ok"): string {
	const [id] = b.request({ cacheRead: 12_000, cacheWrite: 300, calls: [{ name, args }] });
	b.result(id, { text });
	return id;
}

/** A shaped call whose result the experiment evaluated with `shape`. */
function shaped(b: SpotlightSessionBuilder, name: string, args: Record<string, unknown>, shape: ShapeSpec): string {
	const [id] = b.request({ cacheRead: 10_000, cacheWrite: 500, calls: [{ name, args }] });
	b.result(id, { text: "shaped", shape });
	return id;
}

/** A shaped whole-file read of `file` (`lines` lines, original `artifact://N`) that kept `kept`. */
function shapedRead(
	b: SpotlightSessionBuilder,
	file: string,
	opts: {
		lines?: number;
		kept?: [number, number][];
		heat?: string;
		artifact?: number;
	} & Partial<Pick<ShapeSpec, "holdout" | "scoreFree" | "inTokens" | "outTokens" | "gated">> = {},
): string {
	return shaped(
		b,
		"read",
		{ path: file },
		{
			inTokens: opts.inTokens ?? 3000,
			outTokens: opts.outTokens ?? 1000,
			costUsd: 0.001,
			...(opts.holdout ? { holdout: opts.holdout } : {}),
			...(opts.scoreFree ? { scoreFree: true } : {}),
			...(opts.gated ? { gated: true } : {}),
			original: {
				url: `artifact://${opts.artifact ?? 0}`,
				lines: opts.lines ?? 60,
				path: file,
				kept: opts.kept ?? [[1, 10]],
				...(opts.heat ? { heat: opts.heat } : {}),
			},
		},
	);
}

/** An edit of `file` replacing the `find` lines. */
function edit(b: SpotlightSessionBuilder, file: string, find: string[]): void {
	call(b, "edit", { input: [`*** Edit File: ${file}`, "*** Find", ...find, "*** Replace", "changed"].join("\n") });
}

describe("Spotlight savings against plain", () => {
	it("prefers the logged plain size, estimates older traces from the inline cap, and counts a cut wider than plain as a loss", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const original = { url: "artifact://0", lines: 4000, kept: [[1, 10]] as [number, number][] };
		// 120,000 chars over bash's 52 KiB cap: plain shows 30,000 × 53,248 / 120,000 = 13,312 tokens.
		shaped(b, "bash", { command: "make all" }, { inTokens: 30_000, outTokens: 1000, original });
		const logged = shaped(
			b,
			"bash",
			{ command: "make test" },
			{ inTokens: 30_000, outTokens: 1000, plainTokens: 12_000, original },
		);
		// A read under the cap: plain is the whole input.
		shaped(
			b,
			"read",
			{ path: "src/a.ts" },
			{ inTokens: 2000, outTokens: 500, original: { ...original, lines: 200, path: "src/a.ts" } },
		);
		// A score-free cut showing more than plain would have: 8,000 tokens lost.
		shaped(
			b,
			"bash",
			{ command: "make lint" },
			{ inTokens: 30_000, outTokens: 20_000, plainTokens: 12_000, scoreFree: true, original },
		);
		// A cut wider than plain pi did not apply: the model got plain's text, nothing saved, not a cut.
		shaped(
			b,
			"bash",
			{ command: "make docs" },
			{
				inTokens: 30_000,
				outTokens: 12_000,
				plainTokens: 12_000,
				cappedTokens: 20_000,
				steps: ["window", "plain-cap"],
			},
		);
		await write("plain.jsonl", b);

		const stats = await dashboard();
		expect(stats.gross.savedTokens).toBe(12_312 + 11_000 + 1500 - 8000);
		expect(stats.gross.shaped).toBe(4);
		expect(stats.gross.widerThanPlain).toBe(2);
		expect(stats.gross.fullSavedTokens).toBe(29_000 + 29_000 + 1500 + 10_000);
		expect(stats.gross.plainTokens).toBe(13_312 + 12_000 + 2000 + 12_000 + 12_000);
		expect(stats.gross.estimatedPlain).toBe(2);
		expect(stats.gross.byTool.find(t => t.tool === "bash")?.savedTokens).toBe(12_312 + 11_000 - 8000);
		expect(stats.scoreFree).toBe(1);
		const row = stats.recent.find(r => r.toolCallId === logged);
		expect(row).toMatchObject({ plainTokens: 12_000, savedTokens: 11_000, scoreFree: false });
		const bash = (group: string) => stats.fetchBack.find(c => c.tool === "bash" && c.group === group)?.results;
		expect([bash("applied"), bash("scoreFree")]).toEqual([2, 1]);
	});
});

describe("Spotlight needed lines", () => {
	it("records re-read selections and edit Find spans from a subagent's artifact in its parent's directory, until the first edit", async () => {
		const parent = new SpotlightSessionBuilder(T0).header("/repo");
		parent.user("delegate");
		await write("main.jsonl", parent);
		await Bun.write(sessionPath("main/3.spotlight-read.log"), TEN_LINES.join("\n"));

		const b = new SpotlightSessionBuilder(T0 + 60_000).header("/repo").marker();
		b.user("task");
		shapedRead(b, "src/x.ts", { lines: 10, kept: [[1, 3]], artifact: 3 });
		call(b, "read", { path: "src/x.ts:5-6" });
		call(b, "read", { path: "src/other.ts:1-2" });
		edit(b, "/repo/src/x.ts", ["line 7", "line 8"]);
		// After the file's first edit: new content, not the original's lines.
		call(b, "read", { path: "src/x.ts:9-10" });
		await write("main/Sub.jsonl", b);

		const stats = await dashboard();
		expect(stats.ranking.sources).toEqual({ reread: 1, edit: 1 });
		const cell = stats.ranking.cells.find(c => c.group === "applied");
		expect(cell).toMatchObject({ results: 1, neededLines: 4 });
		// None of lines 5–8 was kept: a random cut of the same size would have kept 3/10 of them.
		expect(cell?.keptLift.value).toBe(0);
	});

	it("keeps collecting a shaped read's needs across tail parses", async () => {
		const file = sessionPath("tail.jsonl");
		await Bun.write(sessionPath("tail/0.spotlight-read.log"), TEN_LINES.join("\n"));
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shapedRead(b, "src/x.ts", { lines: 10, kept: [[1, 2]] });
		let written = b.text();
		await Bun.write(file, written);
		await syncAllSessions({ workers: 1 });

		call(b, "read", { path: "src/x.ts:3-4" });
		await fs.appendFile(file, b.text().slice(written.length));
		written = b.text();
		await syncAllSessions({ workers: 1 });

		edit(b, "src/x.ts", ["line 9", "…", "line 10"]);
		await fs.appendFile(file, b.text().slice(written.length));

		const stats = await dashboard();
		expect(stats.ranking.sources).toEqual({ reread: 1, edit: 1 });
		expect(stats.ranking.cells.find(c => c.group === "applied")?.neededLines).toBe(4);
	});
});

describe("Spotlight ranking quality", () => {
	it("scores a heat that puts the needed lines first at AUC 1 and one that puts them last at AUC 0", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shapedRead(b, "src/good.ts", { lines: 40, kept: [[1, 2]], heat: `99${"0".repeat(38)}` });
		call(b, "read", { path: "src/good.ts:1-2" });
		await write("good.jsonl", b);
		// The bad heat runs in a subagent, so each heat aggregates alone under the agent-type filter.
		const r = new SpotlightSessionBuilder(T0 + DAY).header("/repo").marker();
		r.user("go");
		shapedRead(r, "src/bad.ts", { lines: 40, kept: [[3, 40]], heat: `00${"9".repeat(38)}` });
		call(r, "read", { path: "src/bad.ts:1-2" });
		await write("good/Bad.jsonl", r);

		const cell = (stats: SpotlightDashboardStats) => stats.ranking.cells.find(c => c.group === "applied");
		const good = cell(await dashboard("main"));
		// The hottest 10% (4 lines) hold both needed lines: 2 / (4 × 2/40) = 10; the 2 kept lines too: 2 / (2 × 2/40).
		expect(good).toMatchObject({ results: 1, neededLines: 2, auc: { value: 1 } });
		expect(good?.topLift.value).toBeCloseTo(10, 12);
		expect(good?.keptLift.value).toBeCloseTo(20, 12);
		expect(cell(await dashboard("subagent"))).toMatchObject({
			results: 1,
			neededLines: 2,
			auc: { value: 0 },
			topLift: { value: 0 },
			keptLift: { value: 0 },
		});
		const stats = await dashboard();
		expect(stats.ranking.position.find(p => p.label === "line 1")).toMatchObject({ meanHeat: 4.5, lines: 2 });
	});
});

describe("Spotlight holdout-adjusted net", () => {
	it("charges cuts only the recoveries beyond what held-out results got fetched back anyway", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		// Held out (the model saw them whole): one re-read of a would-be hidden line (100 tokens), one nothing.
		shapedRead(b, "src/a.ts", { holdout: { shapedUrl: "artifact://9" } });
		call(b, "read", { path: "src/a.ts:20-30" }, "x".repeat(400));
		shapedRead(b, "src/b.ts", { holdout: { shapedUrl: "artifact://9" } });
		// Applied: one recovered (200 tokens), one not.
		shapedRead(b, "src/c.ts");
		call(b, "read", { path: "src/c.ts:20-30" }, "y".repeat(800));
		shapedRead(b, "src/d.ts");
		await write("adjusted.jsonl", b);

		const stats = await dashboard();
		const read = stats.adjusted.byTool.find(t => t.tool === "read");
		expect(read).toMatchObject({
			cuts: 2,
			recoveredTokens: 200,
			holdouts: 2,
			baselinePerCut: { value: 50 },
			excessTokens: { value: 100 },
		});
		expect(stats.gross.savedTokens).toBe(4000);
		expect(stats.adjusted.excessTokens.value).toBe(100);
		expect(stats.adjusted.netTokens.value).toBe(3900);
		const { savedUsd, recoveryUsd, spotlightUsd } = stats.compounding;
		expect(stats.adjusted.netUsd.value).toBeCloseTo(savedUsd - recoveryUsd * (100 / 200) - spotlightUsd, 12);
		expect(stats.adjusted.minHoldouts).toBe(30);
		// The request that only re-read the cut's hidden lines is the one fetch-back turn (4 s of 6 requests' 24 s).
		const time = stats.timeCost;
		expect(time).toMatchObject({ fetchBackTurns: 1, fetchBackMs: 4000, agentMs: 24_000 });
		expect(time.share).toBeCloseTo((4000 + time.shapeMs) / 24_000, 12);
	});
});

describe("Spotlight historical gated reads", () => {
	it("never counts a gated read as a cut and fetches it back as a group of its own", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		// Gated (the model saw it whole): its would-be hidden lines are read again (100 tokens) in a request of its own.
		const gated = shapedRead(b, "src/g.ts", { gated: true });
		call(b, "read", { path: "src/g.ts:20-30" }, "x".repeat(400));
		// Cut: one fetched back (200 tokens recovered), one not.
		shapedRead(b, "src/c.ts");
		call(b, "read", { path: "src/c.ts:20-30" }, "y".repeat(800));
		shapedRead(b, "src/d.ts");
		// Held out: shown whole, nothing fetched.
		shapedRead(b, "src/h.ts", { holdout: { shapedUrl: "artifact://9" } });
		await write("gate.jsonl", b);

		const stats = await dashboard();
		expect(stats.holdouts).toBe(1);
		// Gated reads save nothing and show plain's page: not in the gross, steps, economics or the adjusted net.
		expect(stats.gross).toMatchObject({ results: 4, shaped: 2, savedTokens: 4000, outTokens: 2000 + 3000 + 3000 });
		expect(stats.steps.reduce((sum, cell) => sum + cell.cuts, 0)).toBe(2);
		expect(stats.economics.find(cell => cell.tool === "read")?.cuts).toBe(2);
		expect(stats.adjusted.byTool.find(t => t.tool === "read")).toMatchObject({
			cuts: 2,
			holdouts: 1,
			recoveredTokens: 200,
		});
		expect(stats.recent.map(row => row.toolCallId)).not.toContain(gated);
		const fetchBack = (group: string) => stats.fetchBack.find(c => c.tool === "read" && c.group === group);
		expect(fetchBack("gated")).toMatchObject({
			results: 1,
			sessions: 1,
			rate: { value: 1 },
		});
		expect(fetchBack("applied")).toMatchObject({
			results: 2,
			rate: { value: 0.5 },
		});
		expect(fetchBack("holdout")).toMatchObject({
			results: 1,
			rate: { value: 0 },
		});
	});
});

describe("Spotlight step economics", () => {
	it("splits cuts by step combination and saved size, folding rare combinations into other", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const original = { url: "artifact://0", lines: 100, kept: [[1, 5]] as [number, number][] };
		for (let i = 0; i < 10; i++) {
			shaped(
				b,
				"bash",
				{ command: `job${i} run` },
				{ inTokens: 1300, outTokens: 1000, steps: ["window"], original },
			);
		}
		call(b, "bash", { command: "job9 run | grep FAILED" }, "z".repeat(240));
		for (const [i, steps] of [["dump"], ["dump"], ["seen"]].entries()) {
			shaped(b, "bash", { command: `dump${i} list` }, { inTokens: 6000, outTokens: 500, steps, original });
		}
		await write("steps.jsonl", b);

		const stats = await dashboard();
		expect(stats.steps.map(c => [c.tool, c.steps, c.size, c.cuts, c.savedTokens, c.recoveredTokens])).toEqual([
			["bash", "window", "250–1k", 10, 3000, 60],
			["bash", "other", "≥4k", 3, 16_500, 0],
		]);
		// No held-out bash results: the whole recovery is excess.
		expect(stats.steps[0].keptShare).toBeCloseTo((3000 - 60) / 3000, 12);
		expect(stats.steps[0].fetchBackRate.value).toBeCloseTo(1 / 10, 12);
	});
});

describe("Spotlight needs backfill", () => {
	it("re-parses only experiment sessions to restore heat, plain sizes and needed lines", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shapedRead(b, "src/x.ts", { lines: 40, heat: `99${"0".repeat(38)}` });
		call(b, "read", { path: "src/x.ts:1-2" });
		const experiment = await write("experiment.jsonl", b);
		const o = new SpotlightSessionBuilder(T0).header("/repo");
		o.user("hello");
		o.request({ cacheRead: 1000 });
		const other = await write("other.jsonl", o);
		await syncAllSessions({ workers: 1 });

		// A database ingested before needed lines existed.
		const db = await initDb();
		db.run("DELETE FROM spotlight_needs");
		db.run("UPDATE spotlight_results SET heat = NULL, kept = NULL");
		db.run("DELETE FROM meta WHERE key = 'spotlight_v4_needs'");
		closeDb();

		const reopened = await initDb();
		const cursors = reopened.query<{ session_file: string }, []>("SELECT session_file FROM file_offsets").all();
		expect(cursors.map(row => row.session_file)).toEqual([other]);
		expect(cursors.map(row => row.session_file)).not.toContain(experiment);
		const stats = await dashboard();
		expect(stats.ranking.sources.reread).toBe(1);
		// The restored heat ranks the two needed lines first.
		expect(stats.ranking.cells.find(c => c.group === "applied")?.auc.value).toBe(1);
		expect(stats.ranking.position.find(p => p.label === "line 1")?.meanHeat).toBe(9);
	});
});

describe("Spotlight list reads' windows", () => {
	/** A shaped `a.py;b.py` read: `a.py` (10 lines) first, then `b.py` (`bLines` lines), each its own window. */
	function listRead(
		b: SpotlightSessionBuilder,
		opts: { kept: [number, number][]; bLines?: number; heat?: string; bWhole?: true },
	): string {
		const bLines = opts.bLines ?? 40;
		return shaped(
			b,
			"read",
			{ path: "a.py;b.py" },
			{
				inTokens: 3000,
				outTokens: 1000,
				costUsd: 0.001,
				original: {
					url: "artifact://0",
					lines: 10 + bLines,
					kept: opts.kept,
					...(opts.heat ? { heat: opts.heat } : {}),
					windows: [
						{ at: 0, lines: 10, start: 1, path: "a.py" },
						{ at: 10, lines: bLines, start: 1, path: "b.py", ...(opts.bWhole ? { wholeFile: opts.bWhole } : {}) },
					],
				},
			},
		);
	}

	async function need(id: string): Promise<{ open: number; reread: string; edit: string } | null> {
		const db = await initDb();
		return db
			.query<{ open: number; reread: string; edit: string }, [string]>(
				"SELECT open, reread, edit FROM spotlight_needs WHERE tool_call_id = ?",
			)
			.get(id);
	}

	it("ranks a list's cut window as that read alone, and needs nothing of a window shown unchanged", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		// `a.py` shown whole (unscored); `b.py` cut to its two hottest lines, as `src/good.ts` alone above.
		listRead(b, {
			kept: [
				[1, 10],
				[11, 12],
			],
			heat: `${"-".repeat(10)}99${"0".repeat(38)}`,
		});
		call(b, "read", { path: "b.py:1-2" });
		call(b, "read", { path: "a.py:1-6" });
		await write("list-rank.jsonl", b);

		const cell = (await dashboard()).ranking.cells.find(c => c.group === "applied");
		expect(cell).toMatchObject({ results: 1, neededLines: 2, auc: { value: 1 } });
		expect(cell?.topLift.value).toBeCloseTo(10, 12);
		expect(cell?.keptLift.value).toBeCloseTo(20, 12);
	});

	it("fetches back a list's whole-file part on a tail read of its file", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		listRead(b, {
			kept: [
				[1, 10],
				[11, 20],
			],
			bWhole: true,
		});
		call(b, "read", { path: "b.py:-5" });
		await write("list-tail.jsonl", b);

		const stats = await dashboard();
		expect(stats.fetchBack.find(c => c.tool === "read" && c.group === "applied")).toMatchObject({
			results: 1,
			rate: { value: 1 },
		});
	});

	it("locates an edit's Find in its own window and records it past the windows before", async () => {
		// Both windows hold the same ten lines: only `b.py`'s own window places the Find once.
		await Bun.write(sessionPath("list-edit/0.spotlight-read.log"), [...TEN_LINES, ...TEN_LINES].join("\n"));
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const list = listRead(b, {
			kept: [
				[1, 2],
				[11, 12],
			],
			bLines: 10,
		});
		edit(b, "b.py", ["line 7", "line 8"]);
		await write("list-edit.jsonl", b);
		await dashboard();

		expect(JSON.parse((await need(list))?.edit ?? "null")).toEqual([[17, 18]]);
	});

	it("keeps a list's needs open until its last window stops collecting", async () => {
		const file = sessionPath("list-open.jsonl");
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const list = listRead(b, {
			kept: [
				[1, 2],
				[11, 12],
			],
		});
		call(b, "read", { path: "a.py" });
		const written = b.text();
		await Bun.write(file, written);
		await syncAllSessions({ workers: 1 });
		expect((await need(list))?.open).toBe(1);

		call(b, "read", { path: "b.py" });
		await fs.appendFile(file, b.text().slice(written.length));
		await syncAllSessions({ workers: 1 });
		expect((await need(list))?.open).toBe(0);
	});

	it("reads an open read persisted before windows as one at the original's start", async () => {
		const file = sessionPath("list-state.jsonl");
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const read = shapedRead(b, "src/x.ts", { lines: 10, kept: [[1, 2]] });
		const written = b.text();
		await Bun.write(file, written);
		await syncAllSessions({ workers: 1 });
		// The cursor as a stats build before windows wrote it: its open reads carry no `at`.
		const db = await initDb();
		const row = db
			.query<{ parser_state: string }, [string]>("SELECT parser_state FROM file_offsets WHERE session_file = ?")
			.get(file);
		const state = JSON.parse(row?.parser_state ?? "null", (key, value) => (key === "at" ? undefined : value));
		db.query("UPDATE file_offsets SET parser_state = ? WHERE session_file = ?").run(JSON.stringify(state), file);

		call(b, "read", { path: "src/x.ts:3-4" });
		await fs.appendFile(file, b.text().slice(written.length));
		await syncAllSessions({ workers: 1 });

		expect(JSON.parse((await need(read))?.reread ?? "null")).toEqual([[3, 4]]);
	});
});
