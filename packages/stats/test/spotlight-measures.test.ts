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
	opts: { lines?: number; kept?: [number, number][]; heat?: string; artifact?: number } & Partial<
		Pick<ShapeSpec, "holdout" | "scoreFree" | "inTokens" | "outTokens" | "gated" | "editLikely">
	> = {},
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
			...(opts.editLikely === undefined ? {} : { editLikely: opts.editLikely }),
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

describe("Spotlight edit-aware gate", () => {
	it("classifies unmarked reads by pi's rule: code files of a main agent, or files the session already read or edited", async () => {
		const main = new SpotlightSessionBuilder(T0).header("/repo").marker();
		main.user("go");
		shapedRead(main, "src/a.ts");
		// Not a code file: never edit-likely.
		shapedRead(main, "docs/readme.md");
		await write("main.jsonl", main);

		const sub = new SpotlightSessionBuilder(T0 + 60_000).header("/repo").marker();
		sub.user("task");
		// A subagent's first read of a file is not edit-likely; its second read is.
		shapedRead(sub, "src/b.ts");
		shapedRead(sub, "src/b.ts");
		// Edited (an absolute path, resolved alike) before its first read.
		edit(sub, "/repo/src/c.ts", ["line 1"]);
		shapedRead(sub, "src/c.ts");
		// Read before with a selector (selectors are stripped), by a call shaping left alone.
		call(sub, "read", { path: "src/d.py:1-5" });
		shapedRead(sub, "src/d.py");
		call(sub, "read", { path: "notes.txt" });
		shapedRead(sub, "notes.txt");
		await write("main/Sub.jsonl", sub);

		const mainStats = await dashboard("main");
		expect(mainStats.editGate.reads?.cut).toBe(1);
		expect(mainStats.editGate.editLikelyShare).toBe(1 / 2);
		const subStats = await dashboard("subagent");
		expect(subStats.editGate.reads?.cut).toBe(3);
		expect(subStats.editGate.editLikelyShare).toBeCloseTo(3 / 5, 12);
		const stats = await dashboard();
		expect(stats.editGate.reads?.cut).toBe(4);
		expect(stats.editGate.editLikelyShare).toBeCloseTo(4 / 7, 12);
	});

	it("prefers pi's mark over the rule", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shapedRead(b, "src/x.ts", { editLikely: false });
		shapedRead(b, "docs/plan.md", { editLikely: true });
		await write("marked.jsonl", b);

		const stats = await dashboard();
		expect(stats.editGate.reads?.cut).toBe(1);
		expect(stats.editGate.editLikelyShare).toBe(0.5);
	});

	it("never counts a gated read as a cut and compares edit-likely cuts with the reads shown whole", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		// Gated (the model saw it whole): its would-be hidden lines are read again (100 tokens) in a request of its own.
		const gated = shapedRead(b, "src/g.ts", { gated: true, editLikely: true });
		call(b, "read", { path: "src/g.ts:20-30" }, "x".repeat(400));
		// Cut: one fetched back (200 tokens recovered), one not.
		shapedRead(b, "src/c.ts", { editLikely: true });
		call(b, "read", { path: "src/c.ts:20-30" }, "y".repeat(800));
		shapedRead(b, "src/d.ts", { editLikely: true });
		// Held out: shown whole, nothing fetched.
		shapedRead(b, "src/h.ts", { editLikely: true, holdout: { shapedUrl: "artifact://9" } });
		await write("gate.jsonl", b);

		const stats = await dashboard();
		expect(stats.gated).toBe(1);
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
		expect(fetchBack("gated")).toMatchObject({ results: 1, sessions: 1, rate: { value: 1 } });
		expect(fetchBack("applied")).toMatchObject({ results: 2, rate: { value: 0.5 } });
		expect(fetchBack("holdout")).toMatchObject({ results: 1, rate: { value: 0 } });

		const row = stats.editGate.reads;
		expect(row).toMatchObject({
			cut: 2,
			gated: 1,
			heldOut: 1,
			cutFetchBack: { value: 0.5 },
			wholeFetchBack: { value: 0.5 },
			cutTurnsPer100: 50,
			wholeTurnsPer100: 50,
		});
		// One held-out edit-likely read is under 30: the baseline falls back to all held-out reads, which fetched
		// nothing back, so all 200 recovered tokens are excess (the gated read's re-read is not a holdout). Whole
		// reads take half a fetch-back-only request each, as many as the two cuts took: no excess request cost.
		const { savedUsd } = stats.compounding;
		const carriedUsd = stats.clawback.usd;
		expect(carriedUsd).toBeGreaterThan(0);
		expect(row?.cutNetUsdPer100.value).toBeCloseTo(((savedUsd - carriedUsd - 0.002) * 100) / 2, 12);
		expect(stats.editGate.editLikelyShare).toBe(1);
	});

	it("measures edit-likely read cuts against edit-likely holdouts and other read cuts against the rest", async () => {
		// 30 edit-likely holdouts, each fetched back by 100 tokens anyway; 2 edit-likely cuts, one recovered 200.
		const a = new SpotlightSessionBuilder(T0).header("/repo").marker();
		a.user("go");
		for (let i = 0; i < 30; i++) {
			shapedRead(a, `src/h${i}.ts`, { holdout: { shapedUrl: "artifact://9" } });
			call(a, "read", { path: `src/h${i}.ts:20-30` }, "x".repeat(400));
		}
		shapedRead(a, "src/c1.ts");
		call(a, "read", { path: "src/c1.ts:20-30" }, "y".repeat(800));
		shapedRead(a, "src/c2.ts");
		await write("edit-likely.jsonl", a);
		// 30 other holdouts, never fetched back; 1 other cut that recovered 200. A subagent's, so the main agent's
		// economics price the edit-likely cuts alone.
		const b = new SpotlightSessionBuilder(T0 + 60_000).header("/repo").marker();
		b.user("go");
		for (let i = 0; i < 30; i++) shapedRead(b, `docs/n${i}.md`, { holdout: { shapedUrl: "artifact://9" } });
		shapedRead(b, "docs/x.md");
		call(b, "read", { path: "docs/x.md:20-30" }, "z".repeat(800));
		await write("edit-likely/Other.jsonl", b);

		const stats = await dashboard();
		// Pooled, every cut would be charged 3000 / 60 = 50 tokens of baseline: 400 − 150 = 250 excess. By stratum:
		// edit-likely 200 − 100 × 2 → 0, other 200 − 0 × 1 = 200.
		const read = stats.adjusted.byTool.find(t => t.tool === "read");
		expect(read).toMatchObject({ cuts: 3, holdouts: 60, recoveredTokens: 400, baselinePerCut: { value: 50 } });
		expect(read?.excessTokens.value).toBe(200);
		expect(stats.steps.map(cell => [cell.tool, cell.cuts, cell.recoveredTokens, cell.excessTokens])).toEqual([
			["read", 3, 400, 200],
		]);
		// The edit-likely cuts recovered no more than edit-likely holdouts fetch anyway, and took one fetch-back-only
		// request where 2 whole reads take 2: only their saving and Spotlight's bill remain.
		const row = stats.editGate.reads;
		expect(row).toMatchObject({ cut: 2, heldOut: 30, gated: 0 });
		const mainStats = await dashboard("main");
		const savedUsd = mainStats.economics.find(c => c.tool === "read")?.savedUsd ?? 0;
		expect(savedUsd).toBeGreaterThan(0);
		expect(row?.cutNetUsdPer100.value).toBeCloseTo(((savedUsd - 0.002) * 100) / 2, 12);
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
