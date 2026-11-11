import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import type { SpotlightAgentScope, SpotlightDashboardStats } from "@oh-my-pi/omp-stats/shared-types";
import { buildSpotlightDashboard, getSpotlightSessionContext } from "@oh-my-pi/omp-stats/spotlight-aggregator";
import { argumentTokens } from "@oh-my-pi/omp-stats/spotlight-ingest";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { SpotlightSessionBuilder } from "./helpers/spotlight-session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-spotlight-");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-20T10:00:00Z");

async function write(rel: string, b: SpotlightSessionBuilder): Promise<string> {
	const file = path.join(getSessionsDir(), "--repo--", rel);
	await Bun.write(file, b.text());
	return file;
}

async function dashboard(scope: SpotlightAgentScope = "all"): Promise<SpotlightDashboardStats> {
	await syncAllSessions({ workers: 1 });
	return buildSpotlightDashboard(await initDb(), { cutoff: null, bucketMs: DAY }, scope);
}

/** A shaped read of `file` lines 100-200 that hid lines 120-178 behind artifact://0. */
function shortenedRead(b: SpotlightSessionBuilder, saved = 2000): string {
	const [id] = b.request({
		cacheRead: 10_000,
		cacheWrite: 500,
		calls: [{ name: "read", args: { path: "src/a.ts:100-200" } }],
	});
	b.result(id, {
		text: "100\tconst a = 1;\n… [120-178] (read artifact://0:21-79)\n179\tconst z = 2;",
		shape: {
			inTokens: saved + 1000,
			outTokens: 1000,
			costUsd: 0.002,
			original: {
				url: "artifact://0",
				lines: 101,
				start: 100,
				path: "src/a.ts",
				kept: [
					[1, 20],
					[80, 101],
				],
			},
		},
	});
	return id;
}

function call(b: SpotlightSessionBuilder, name: string, args: Record<string, unknown>, text = "ok"): string {
	const [id] = b.request({ cacheRead: 12_000, cacheWrite: 300, calls: [{ name, args }] });
	b.result(id, { text });
	return id;
}

/** A whole-file read of `file` shaping would have cut by `saved` tokens, held out: the model saw it all. */
function heldOutRead(b: SpotlightSessionBuilder, file: string, saved = 3000): string {
	const [id] = b.request({ cacheRead: 10_000, cacheWrite: 500, calls: [{ name: "read", args: { path: file } }] });
	b.result(id, {
		text: "1\tconst whole = true;\n".repeat(60),
		shape: {
			inTokens: saved + 1000,
			outTokens: 1000,
			costUsd: 0.001,
			holdout: { shapedUrl: "artifact://9" },
			original: { url: "artifact://8", lines: 60, path: file, kept: [[1, 10]] },
		},
	});
	return id;
}

/** A read shaping evaluated and left unchanged. */
function unchangedRead(b: SpotlightSessionBuilder, file: string, inTokens: number): string {
	const [id] = b.request({ cacheRead: 10_000, cacheWrite: 500, calls: [{ name: "read", args: { path: file } }] });
	b.result(id, { text: "1\tok", shape: { inTokens, outTokens: inTokens } });
	return id;
}

/** A shortened `cargo test -p tern` that hid lines 11-50 behind artifact://1. */
function shortenedBash(b: SpotlightSessionBuilder, shape: { holdout?: boolean } = {}): string {
	const [id] = b.request({
		cacheRead: 11_000,
		cacheWrite: 300,
		calls: [{ name: "bash", args: { command: "cargo test -p tern" } }],
	});
	b.result(id, {
		text: shape.holdout ? "running 40 tests\n".repeat(50) : "running 40 tests\n… [11-50] (read artifact://1:11-50)",
		shape: {
			inTokens: 1500,
			outTokens: 300,
			original: { url: "artifact://1", lines: 50, kept: [[1, 10]] },
			...(shape.holdout ? { holdout: { shapedUrl: "artifact://2" } } : {}),
		},
	});
	return id;
}

describe("Spotlight recovery detection", () => {
	it("attributes artifact dives, re-reads and reruns to the result they recover, and nothing else", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo", "recoveries").marker();
		b.user("investigate");
		const read = shortenedRead(b);
		call(b, "read", { path: "src/b.ts:120-130" }); // different file
		call(b, "read", { path: "src/a.ts:100-110" }); // same file, kept lines only
		const [reread] = b.request({
			cacheRead: 12_000,
			cacheWrite: 300,
			calls: [
				{ name: "read", args: { path: "/repo/src/a.ts:150-160" } },
				{ name: "eval", args: { language: "py", code: "print(1)" } },
			],
		});
		b.result(reread, { text: "150\tline" });

		const [cargo] = b.request({
			cacheRead: 13_000,
			cacheWrite: 300,
			calls: [{ name: "bash", args: { command: "cargo test -p tern" } }],
		});
		b.result(cargo, {
			text: "running 40 tests\n… [11-50] (read artifact://1:11-50)",
			shape: {
				inTokens: 1500,
				outTokens: 300,
				original: { url: "artifact://1", lines: 50, kept: [[1, 10]] },
			},
		});
		call(b, "bash", { command: "ls -la" }); // unrelated command
		const dive = call(b, "read", { path: "artifact://1:10-40" }, "x".repeat(400));
		const rerun = call(b, "bash", { command: "cargo test -p tern | grep FAILED" }, "y".repeat(80));

		const [rg] = b.request({
			cacheRead: 14_000,
			cacheWrite: 300,
			calls: [{ name: "bash", args: { command: "rg -n foo src" } }],
		});
		b.result(rg, {
			text: "src/a.ts:1:foo\n… [2-60]",
			shape: {
				inTokens: 900,
				outTokens: 100,
				original: { url: "artifact://2", lines: 60, kept: [[1, 1]] },
			},
		});
		for (let i = 0; i < 12; i++) call(b, "eval", { language: "py", code: `step(${i})` });
		call(b, "bash", { command: "rg -n foo src" }); // a repeat 13 calls later: beyond the rerun window
		await write("recoveries.jsonl", b);

		const stats = await dashboard();
		expect(stats.clawback.events).toBe(3);
		expect(stats.clawback.byKind.artifact.events).toBe(1);
		expect(stats.clawback.byKind.reread.events).toBe(1);
		expect(stats.clawback.byKind.rerun.events).toBe(1);
		// The dive's 400 chars and the rerun's 80 chars come back as chars / 4; the re-read's "150\tline" as 2.
		expect(stats.clawback.tokens).toBe(100 + 20 + 2);
		expect(stats.clawback.withHidden).toBe(3);
		expect(stats.clawback.recovered).toBe(2);

		const byId = new Map(stats.recent.map(row => [row.toolCallId, row]));
		expect(byId.get(read)?.recoveries.map(r => [r.kind, r.turn])).toEqual([["reread", false]]);
		expect(byId.get(cargo)?.recoveries.map(r => [r.kind, r.toolCallId, r.turn])).toEqual([
			["artifact", dive, true],
			["rerun", rerun, true],
		]);
		expect(byId.get(rg)?.recoveries).toEqual([]);
		expect(byId.get(cargo)?.netTokens).toBe(1200 - 100 - 20);
		// Two recovery requests issued nothing else: their cost is the clawback's extra turns.
		expect(stats.clawback.turns).toBe(2);
		expect(stats.clawback.turnsUsd).toBeGreaterThan(0);
	});

	it("never attributes a parallel call of the same request to the cut it could not have seen", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("read both");
		const [cut, parallel] = b.request({
			cacheRead: 10_000,
			cacheWrite: 500,
			calls: [
				{ name: "read", args: { path: "src/a.ts:100-200" } },
				{ name: "read", args: { path: "src/a.ts:150-160" } },
			],
		});
		b.result(cut, {
			text: "100\tconst a = 1;\n… [120-178]",
			shape: {
				inTokens: 3000,
				outTokens: 1000,
				original: {
					url: "artifact://0",
					lines: 101,
					start: 100,
					path: "src/a.ts",
					kept: [
						[1, 20],
						[80, 101],
					],
				},
			},
		});
		b.result(parallel, { text: "150\tline" });
		const later = call(b, "read", { path: "src/a.ts:150-160" }, "150\tline");
		await write("parallel.jsonl", b);

		const stats = await dashboard();
		const row = stats.recent.find(r => r.toolCallId === cut);
		expect(row?.recoveries.map(r => [r.kind, r.toolCallId])).toEqual([["reread", later]]);
		expect(stats.clawback.events).toBe(1);
	});
});

describe("Spotlight holdout", () => {
	it("never counts a held-out result as a saving but measures its fetch-backs like a cut's", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo", "holdout").marker();
		b.user("go");
		const cut = shortenedRead(b);
		call(b, "read", { path: "src/a.ts:150-160" }, "z".repeat(40));
		const held = heldOutRead(b, "src/h.ts");
		call(b, "eval", { language: "py", code: "print(1)" });
		call(b, "read", { path: "src/h.ts:30-40" });
		// The held-out result's original artifact was never shown: reading it recovers nothing.
		call(b, "read", { path: "artifact://8" });
		await write("holdout.jsonl", b);

		const stats = await dashboard();
		expect(stats.holdouts).toBe(1);
		expect([stats.gross.results, stats.gross.shaped, stats.gross.savedTokens]).toEqual([2, 1, 2000]);
		expect(stats.gross.outTokens).toBe(1000 + 4000);
		expect(stats.clawback.events).toBe(1);
		expect(stats.series.reduce((sum, point) => sum + point.savedTokens, 0)).toBe(2000);
		expect(stats.sessionList[0].savedTokens).toBe(2000);
		expect(stats.economics.map(e => [e.tool, e.cuts, e.savedTokens])).toEqual([["read", 1, 2000]]);
		expect(stats.recent.map(row => [row.toolCallId, row.holdout, row.savedTokens])).toEqual([
			[held, true, 3000],
			[cut, false, 2000],
		]);

		const cell = (group: string) => stats.fetchBack.find(c => c.tool === "read" && c.group === group);
		expect(cell("applied")).toMatchObject({ results: 1, sessions: 1, rate: { value: 1 } });
		expect(cell("holdout")).toMatchObject({ results: 1, sessions: 1, rate: { value: 1 } });
		expect(stats.gaps.find(g => g.tool === "read" && g.gap === "2")).toMatchObject({ applied: 0, holdout: 1 });
		expect(stats.overhead).toMatchObject({ results: 2, spotlightUsd: 0.003 });
	});
});

describe("Spotlight overhead", () => {
	it("breaks failed results down by cause, as shares of the results that called Spotlight", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo", "failures").marker();
		b.user("go");
		const failedBash = (shape: { failures: number; failureCauses?: Record<string, number> }) => {
			const [id] = b.request({
				cacheRead: 10_000,
				cacheWrite: 500,
				calls: [{ name: "bash", args: { command: "ls" } }],
			});
			b.result(id, { text: "ok", shape: { inTokens: 3000, outTokens: 3000, ...shape } });
		};
		failedBash({ failures: 2, failureCauses: { no_credential: 2 } });
		failedBash({ failures: 1, failureCauses: { no_credential: 1 } });
		failedBash({ failures: 2, failureCauses: { timeout: 1, rate_limited: 1 } });
		// Journaled before pi recorded causes.
		failedBash({ failures: 1 });
		shortenedRead(b);
		await write("failures.jsonl", b);

		const { overhead } = await dashboard();

		expect(overhead.failureRate).toBe(4 / 5);
		expect(overhead.failureCauses).toEqual([
			{ cause: "no_credential", results: 2, share: 2 / 5 },
			{ cause: "rate_limited", results: 1, share: 1 / 5 },
			{ cause: "timeout", results: 1, share: 1 / 5 },
			{ cause: "unrecorded", results: 1, share: 1 / 5 },
		]);
	});
});

describe("Spotlight edits", () => {
	it("does not count a re-read after an edit of the file, or a rerun after any edit, as fetching back", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const first = shortenedRead(b);
		call(b, "edit", { input: "*** Edit File: src/a.ts\n*** Find\nconst a = 1;\n*** Replace\nconst a = 2;" });
		call(b, "read", { path: "src/a.ts:150-160" });
		const bash = shortenedBash(b);
		call(b, "write", { path: "src/other.ts", content: "x" });
		call(b, "bash", { command: "cargo test -p tern" });
		const second = shortenedRead(b);
		// An edit of another file (ast_edit through `write xd://ast_edit`) excuses nothing; a write to an internal
		// URL edits no file.
		call(b, "write", { path: "xd://ast_edit", content: JSON.stringify({ paths: ["src/b.ts"], ops: [] }) });
		call(b, "write", { path: "proc://job/kill" });
		const reread = call(b, "read", { path: "src/a.ts:150-160" });
		await write("edits.jsonl", b);

		const check = (stats: SpotlightDashboardStats) => {
			const byId = new Map(stats.recent.map(row => [row.toolCallId, row]));
			expect(byId.get(first)?.recoveries).toEqual([]);
			expect(byId.get(bash)?.recoveries).toEqual([]);
			expect(byId.get(second)?.recoveries.map(r => r.toolCallId)).toEqual([reread]);
			expect(stats.clawback.events).toBe(1);
			const cell = (tool: string) => stats.fetchBack.find(c => c.tool === tool && c.group === "applied");
			expect(cell("read")).toMatchObject({ results: 2, rate: { value: 0.5 } });
			expect(cell("bash")).toMatchObject({ results: 1, rate: { value: 0 } });
		};
		check(await dashboard());

		// A database whose experiment sessions were parsed before edits were recorded re-parses them once.
		const db = await initDb();
		db.run("UPDATE spotlight_calls SET edits = NULL");
		db.run("DELETE FROM meta WHERE key = 'spotlight_v3_edits'");
		// Blind to edits, both re-reads of src/a.ts (the second cut is one too) and the rerun read as recoveries.
		expect(buildSpotlightDashboard(db, { cutoff: null, bucketMs: DAY }).clawback.events).toBe(4);
		closeDb();
		check(await dashboard());
	});
});

describe("Spotlight fetch-back reference", () => {
	it("standardizes unchanged results to the applied cuts' size mix, dropping bins either side lacks", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		// Applied cuts: two of 5000 tokens, one of 1500 (a bin no unchanged result shares).
		shortenedRead(b, 4000);
		shortenedRead(b, 4000);
		shortenedRead(b, 500);
		for (const [file, tokens, fetched] of [
			["src/c.ts", 500, true],
			["src/d.ts", 600, true],
			["src/e.ts", 5000, true],
			["src/f.ts", 4500, false],
			["src/g.ts", 3000, false],
		] as const) {
			unchangedRead(b, file, tokens);
			if (fetched) call(b, "read", { path: `${file}:5-9` });
		}
		await write("reference.jsonl", b);

		const stats = await dashboard();
		// Crude: 3 of 5 fetched back. Standardized: only the ≥4K bin is shared, where 1 of 2 was.
		expect(stats.fetchBack.find(c => c.tool === "read" && c.group === "reference")).toEqual({
			tool: "read",
			group: "reference",
			results: 2,
			sessions: 1,
			rate: { value: 0.5, lo: null, hi: null },
		});
	});
});

describe("Spotlight cut economics", () => {
	it("splits a request that only fetched back cut output among the cuts it recovered", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shortenedRead(b);
		shortenedBash(b);
		const [dive, rerun] = b.request({
			cacheRead: 12_000,
			cost: 0.08,
			calls: [
				{ name: "read", args: { path: "artifact://0:21-79" } },
				{ name: "bash", args: { command: "cargo test -p tern | grep FAILED" } },
			],
		});
		b.result(dive, { text: "x".repeat(400) });
		b.result(rerun, { text: "y".repeat(80) });
		// A recovery issued beside other work is no extra turn.
		const [reread, other] = b.request({
			cacheRead: 13_000,
			cost: 0.05,
			calls: [
				{ name: "read", args: { path: "src/a.ts:150-160" } },
				{ name: "bash", args: { command: "ls" } },
			],
		});
		b.result(reread, { text: "z".repeat(40) });
		b.result(other, { text: "ok" });
		await write("economics.jsonl", b);

		const stats = await dashboard();
		const cell = (tool: string) => stats.economics.find(e => e.tool === tool);
		expect(cell("read")).toMatchObject({ cuts: 1, recoveredTokens: 110, extraTurns: 0.5, extraTurnsPer100Cuts: 50 });
		expect(cell("bash")).toMatchObject({ cuts: 1, recoveredTokens: 20, extraTurns: 0.5 });
		expect(cell("read")?.turnUsd).toBeCloseTo(0.04, 10);
		expect(cell("bash")?.turnUsd).toBeCloseTo(0.04, 10);
		const read = cell("read");
		expect(read?.netUsd).toBeCloseTo(
			(read?.savedUsd ?? 0) - (read?.recoveryUsd ?? 0) - (read?.turnUsd ?? 0) - 0.002,
			10,
		);
		expect(stats.clawback.turns).toBe(1);
	});
});

describe("Spotlight fetch-back gaps", () => {
	it("bins the calls between a result and its first fetch-back, up to 12", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shortenedRead(b);
		for (let i = 0; i < 3; i++) call(b, "eval", { language: "py", code: `step(${i})` });
		call(b, "read", { path: "src/a.ts:150-160" });
		call(b, "read", { path: "src/a.ts:150-160" }); // a later one: only the first counts
		shortenedBash(b, { holdout: true });
		call(b, "bash", { command: "cargo test -p tern 2>&1 | tail -20" });
		const [late] = b.request({ cacheRead: 12_000, calls: [{ name: "bash", args: { command: "make" } }] });
		b.result(late, {
			text: "built\n… [3-40]",
			shape: {
				inTokens: 900,
				outTokens: 100,
				original: { url: "artifact://5", lines: 40, kept: [[1, 2]] },
			},
		});
		for (let i = 0; i < 12; i++) call(b, "eval", { language: "py", code: `wait(${i})` });
		call(b, "bash", { command: "make" }); // 13 calls later: too late
		await write("gaps.jsonl", b);

		const stats = await dashboard();
		// Every bin of each tool with a fetch-back (eval has none), the larger saving first.
		expect(stats.gaps).toHaveLength(10);
		expect(stats.gaps.filter(g => g.applied + g.holdout > 0)).toEqual([
			{ tool: "read", gap: "4–6", applied: 1, holdout: 0 },
			{ tool: "bash", gap: "1", applied: 0, holdout: 1 },
		]);
	});
});

describe("Spotlight generic tools", () => {
	it("normalizes arguments to tokens: leaves flattened, paths whole, the intent note left out", () => {
		expect(
			argumentTokens({
				i: "why this call",
				pattern: "fetch  back",
				path: "src/my dir/x.ts",
				limit: 5,
				options: { ignoreCase: true, i: "nested stays" },
				list: [{ items: ["a b"] }],
				none: null,
			}),
		).toEqual([
			"pattern=fetch",
			"pattern=back",
			"path=src/my dir/x.ts",
			"limit=5",
			"ignoreCase=true",
			"i=nested",
			"i=stays",
			"items=a",
			"items=b",
		]);
	});

	it("measures any tool's cuts from the data: a grep rerun and artifact dive, tools ordered by saving", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo", "generic").marker();
		b.user("find the fetch-back code");
		const [findCut] = b.request({
			cacheRead: 10_000,
			calls: [{ name: "find", args: { i: "locate", query: "fetch back rule", path: "src" } }],
		});
		// No `plainTokens`: only read/bash/eval estimate it; any other tool's input is what plain shows.
		b.result(findCut, {
			text: "src/a.ts:1-40\n… [3-30]",
			shape: {
				inTokens: 900,
				outTokens: 400,
				original: { url: "artifact://2", lines: 30, kept: [[1, 2]] },
			},
		});
		const [grep] = b.request({
			cacheRead: 11_000,
			calls: [{ name: "grep", args: { i: "where is it", pattern: "fetchBack", path: "src" } }],
		});
		b.result(grep, {
			text: "src/a.ts:12: fetchBack\n… [21-120] (read artifact://3:21-120)",
			shape: {
				inTokens: 2400,
				plainTokens: 2400,
				outTokens: 400,
				steps: ["dump"],
				original: { url: "artifact://3", lines: 120, kept: [[1, 20]] },
			},
		});
		call(b, "grep", { i: "unrelated", pattern: "TODO", path: "docs" });
		const rerun = call(
			b,
			"grep",
			{ i: "narrow it down", pattern: "fetchBack", path: "src", glob: "*.ts" },
			"x".repeat(200),
		);
		const dive = call(b, "read", { path: "artifact://3:30-60" }, "y".repeat(400));
		const [search] = b.request({ cacheRead: 12_000, calls: [{ name: "web_search", args: { query: "jaccard" } }] });
		b.result(search, { text: "results", shape: { inTokens: 300, plainTokens: 300, outTokens: 300 } });
		await write("generic.jsonl", b);

		const stats = await dashboard();
		expect(stats.gross.byTool.map(t => [t.tool, t.results, t.shaped, t.plainTokens, t.savedTokens])).toEqual([
			["grep", 1, 1, 2400, 2000],
			["find", 1, 1, 900, 500],
			["web_search", 1, 0, 300, 0],
		]);
		expect(stats.gross.estimatedPlain).toBe(0);
		const row = stats.recent.find(r => r.toolCallId === grep);
		expect(row?.tool).toBe("grep");
		expect(row?.recoveries.map(r => [r.kind, r.toolCallId, r.tokens])).toEqual([
			["rerun", rerun, 50],
			["artifact", dive, 100],
		]);
		expect(row?.netTokens).toBe(2000 - 150);
		expect(stats.clawback.byKind.rerun.events).toBe(1);
		expect(stats.clawback.byKind.artifact.events).toBe(1);

		expect(stats.fetchBack.find(c => c.tool === "grep" && c.group === "applied")).toMatchObject({
			results: 1,
			rate: { value: 1 },
		});
		expect(stats.fetchBack.find(c => c.tool === "find" && c.group === "applied")).toMatchObject({
			results: 1,
			rate: { value: 0 },
		});
		// The unrelated grep sits between the cut and its rerun.
		expect(stats.gaps.filter(g => g.applied + g.holdout > 0)).toEqual([
			{ tool: "grep", gap: "2", applied: 1, holdout: 0 },
		]);
		expect([...new Set(stats.gaps.map(g => g.tool))]).toEqual(["grep"]);
		expect(stats.economics.map(e => [e.tool, e.cuts, e.recoveredTokens])).toEqual([
			["grep", 1, 150],
			["find", 1, 0],
		]);
		expect(stats.adjusted.byTool.map(t => t.tool)).toEqual(["grep", "find", "web_search"]);
		expect([...new Set(stats.steps.map(s => s.tool))]).toEqual(["grep", "find"]);
		const shaped = new Map(stats.coverage.map(c => [c.tool, c.shaped]));
		expect(Object.fromEntries(shaped)).toEqual({ grep: true, find: true, web_search: true, read: false });
	});
});

describe("Spotlight experiment sessions", () => {
	it("counts sessions marked by spotlight:session or a legacy shipped-arm assignment, never another legacy arm", async () => {
		const marked = new SpotlightSessionBuilder(T0).header("/repo").marker();
		marked.user("go");
		shortenedRead(marked);
		const markedFile = await write("marked.jsonl", marked);
		// A legacy session of the arm that shipped (the literal is the persisted arm value).
		const shipped = new SpotlightSessionBuilder(T0 + 60_000).header("/repo").legacyAssignment("vylv5");
		shipped.user("go");
		shortenedRead(shipped);
		const shippedFile = await write("legacy-shipped.jsonl", shipped);
		// A legacy control session: its traces describe what shaping would have done, but nothing was shaped.
		const plain = new SpotlightSessionBuilder(T0 + 120_000).header("/repo").legacyAssignment("plain");
		plain.user("go");
		shortenedRead(plain);
		await write("legacy-plain.jsonl", plain);

		const stats = await dashboard();
		expect(stats.sessions).toBe(2);
		expect(stats.sessionList.map(s => s.sessionFile).toSorted()).toEqual([shippedFile, markedFile].toSorted());
		expect([stats.gross.results, stats.gross.shaped, stats.gross.savedTokens]).toEqual([2, 2, 4000]);
		expect(stats.experimentStart).not.toBeNull();
	});

	it("drops a database's legacy control sessions when it drops the arm columns", async () => {
		const marked = new SpotlightSessionBuilder(T0).header("/repo").marker();
		marked.user("go");
		shortenedRead(marked);
		const markedFile = await write("marked.jsonl", marked);
		await syncAllSessions({ workers: 1 });

		// The schema of a database written while sessions drew arms, holding a `plain` session.
		const db = await initDb();
		db.run("ALTER TABLE spotlight_sessions RENAME COLUMN marked_at TO assigned_at");
		db.run("ALTER TABLE spotlight_sessions ADD COLUMN arm TEXT NOT NULL DEFAULT 'vylv5'");
		db.run("ALTER TABLE spotlight_sessions ADD COLUMN find_ranker TEXT");
		db.run("ALTER TABLE spotlight_sessions ADD COLUMN source TEXT");
		db.run("ALTER TABLE spotlight_results ADD COLUMN arm TEXT NOT NULL DEFAULT 'vylv5'");
		db.run(
			"INSERT INTO spotlight_sessions (session_file, folder, assigned_at, arm) VALUES ('/x/plain.jsonl', 'x', 1, 'plain')",
		);
		db.run(
			`INSERT INTO spotlight_results (session_file, tool_call_id, timestamp, tool, arm, in_chars, out_chars, in_tokens,
			 out_tokens, steps, has_details) VALUES ('/x/plain.jsonl', 'c1', ${T0}, 'read', 'plain', 40, 4, 10, 1, '[]', 1)`,
		);
		closeDb();

		const migrated = await initDb();
		const columns = (table: string) =>
			migrated
				.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
				.all()
				.map(c => c.name);
		expect(columns("spotlight_sessions")).not.toContain("arm");
		expect(columns("spotlight_sessions")).toContain("marked_at");
		expect(columns("spotlight_results")).not.toContain("arm");
		const stats = buildSpotlightDashboard(migrated, { cutoff: null, bucketMs: DAY });
		expect(stats.sessionList.map(s => s.sessionFile)).toEqual([markedFile]);
		expect(stats.gross.results).toBe(1);
	});
});

describe("Spotlight compounding", () => {
	it("carries a saving until the next compaction and prices it at the carrying requests' cache rates", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shortenedRead(b, 1000); // request 1 issues it, the result lands after
		b.request({ cacheRead: 21_000, cacheWrite: 500 });
		b.sideRequest(300); // a small side request is not a compaction
		b.request({ cacheRead: 22_000, cacheWrite: 500 });
		b.compaction();
		b.request({ input: 100, cacheRead: 8000, cacheWrite: 500 });
		b.request({ cacheRead: 9000, cacheWrite: 500 });
		const file = await write("compacted.jsonl", b);

		const stats = await dashboard();
		expect(stats.compounding.avoidedTokens).toBe(2000);
		// One cache write and two cache reads at the builder's $6.25/M and $0.50/M.
		expect(stats.compounding.savedUsd).toBeCloseTo(1000 * (6.25e-6 + 2 * 0.5e-6), 10);

		const context = await getSpotlightSessionContext(file);
		expect(context?.points.map(p => p.compacted)).toEqual([false, false, false, true, false]);
		expect(context?.points.map(p => p.withoutTokens - p.contextTokens)).toEqual([0, 1000, 1000, 0, 0]);
	});
});

describe("Spotlight tool-output share", () => {
	it("splits every session's context into shaped and outside groups", async () => {
		const sessions = [
			{
				rel: "shaped.jsonl",
				marker: (b: SpotlightSessionBuilder) => b.marker(),
				chars: 800,
				output: 100,
				prompt: 40,
			},
			{
				rel: "legacy-plain.jsonl",
				marker: (b: SpotlightSessionBuilder) => b.legacyAssignment("plain"),
				chars: 400,
				output: 300,
				prompt: 80,
			},
			{ rel: "outside.jsonl", marker: null, chars: 1200, output: 50, prompt: 120 },
		];
		for (const s of sessions) {
			const b = new SpotlightSessionBuilder(T0).header("/repo");
			s.marker?.(b);
			b.user("p".repeat(s.prompt));
			const [id] = b.request({
				input: 1000,
				cacheRead: 5000,
				cacheWrite: 0,
				output: s.output,
				calls: [{ name: "bash", args: { command: "ls" } }],
			});
			b.result(id, { text: "r".repeat(s.chars) });
			await write(s.rel, b);
		}
		const stats = await dashboard();
		const day = Math.floor(T0 / DAY) * DAY;
		const context = (s: (typeof sessions)[number]) => s.chars / 4 + s.output + s.prompt / 4 + 6000;
		expect(stats.share.filter(p => p.timestamp === day)).toEqual([
			{
				timestamp: day,
				group: "shaped",
				sessions: 1,
				toolTokens: sessions[0].chars / 4,
				contextTokens: context(sessions[0]),
			},
			// The legacy control session is outside the experiment.
			{
				timestamp: day,
				group: "outside",
				sessions: 2,
				toolTokens: (sessions[1].chars + sessions[2].chars) / 4,
				contextTokens: context(sessions[1]) + context(sessions[2]),
			},
		]);
	});
});

describe("Spotlight session scope", () => {
	it("leaves a resumed session's history before its marker outside the experiment", async () => {
		const b = new SpotlightSessionBuilder(T0 - 2 * DAY).header("/repo");
		b.user("before the experiment");
		const [old] = b.request({
			cacheRead: 30_000,
			cacheWrite: 1000,
			calls: [{ name: "bash", args: { command: "ls" } }],
		});
		b.result(old, { text: "o".repeat(4000) });
		b.request({ cacheRead: 32_000, cacheWrite: 500 });
		b.wait(2 * DAY);
		b.marker();
		const markedAt = b.now;
		b.user("resumed");
		const [fresh] = b.request({
			cacheRead: 40_000,
			cacheWrite: 800,
			calls: [{ name: "bash", args: { command: "pwd" } }],
		});
		b.result(fresh, { text: "n".repeat(400) });
		const file = await write("resumed.jsonl", b);

		const stats = await dashboard();
		const day = (t: number) => Math.floor(t / DAY) * DAY;
		const before = stats.share.filter(p => p.timestamp === day(T0 - 2 * DAY));
		expect(before.find(p => p.group === "outside")).toMatchObject({ sessions: 1, toolTokens: 1000 });
		expect(before.find(p => p.group === "shaped")).toMatchObject({ sessions: 0, toolTokens: 0, contextTokens: 0 });
		expect(stats.share.find(p => p.timestamp === day(markedAt) && p.group === "shaped")).toMatchObject({
			sessions: 1,
			toolTokens: 100,
		});
		expect(stats.sessionList[0]).toMatchObject({ sessionFile: file, startedAt: markedAt, requests: 1 });
		expect((await getSpotlightSessionContext(file))?.points.map(p => p.contextTokens)).toEqual([500 + 40_000 + 800]);
	});

	it("filters every metric by the transcript's agent type", async () => {
		const sessions = [
			{ rel: "main.jsonl", experiment: true, chars: 800 },
			{ rel: "main/Worker.jsonl", experiment: true, chars: 400 },
			{ rel: "other.jsonl", experiment: false, chars: 1200 },
			{ rel: "other/Helper.jsonl", experiment: false, chars: 2000 },
		];
		for (const s of sessions) {
			const b = new SpotlightSessionBuilder(T0).header("/repo");
			if (s.experiment) b.marker();
			b.user("go");
			const [id] = b.request({ cacheRead: 5000, calls: [{ name: "bash", args: { command: "ls" } }] });
			b.result(id, { text: "r".repeat(s.chars) });
			await write(s.rel, b);
		}
		const day = Math.floor(T0 / DAY) * DAY;
		const toolTokens = (stats: SpotlightDashboardStats, group: string) =>
			stats.share.find(p => p.timestamp === day && p.group === group)?.toolTokens;

		const main = await dashboard("main");
		expect(main.sessions).toBe(1);
		expect(main.sessionList.map(s => s.agentType)).toEqual(["main"]);
		expect([toolTokens(main, "shaped"), toolTokens(main, "outside")]).toEqual([200, 300]);

		const sub = await dashboard("subagent");
		expect(sub.sessions).toBe(1);
		expect(sub.sessionList.map(s => s.agentType)).toEqual(["subagent"]);
		expect([toolTokens(sub, "shaped"), toolTokens(sub, "outside")]).toEqual([100, 500]);

		const all = await dashboard("all");
		expect(all.sessions).toBe(2);
		expect([toolTokens(all, "shaped"), toolTokens(all, "outside")]).toEqual([300, 800]);
	});
});

describe("Spotlight ingest", () => {
	it("joins a shape entry and its result across tail parses and keeps recording calls", async () => {
		const file = path.join(getSessionsDir(), "--repo--", "tail.jsonl");
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		const [id] = b.request({
			cacheRead: 10_000,
			cacheWrite: 500,
			calls: [{ name: "bash", args: { command: "make" } }],
		});
		const text = "built\n… [3-40] (read artifact://4:3-40)";
		const shape = {
			inTokens: 1200,
			outTokens: 200,
			costUsd: 0.0031,
			original: { url: "artifact://4", lines: 40, kept: [[1, 2]] as [number, number][] },
		};
		b.shapeEntry(id, shape, text);
		const head = b.text();
		await Bun.write(file, head);
		await syncAllSessions({ workers: 1 });

		b.resultMessage(id, { text, shape });
		const dive = call(b, "read", { path: "artifact://4:3-40" });
		await fs.appendFile(file, b.text().slice(head.length));

		const stats = await dashboard();
		expect(stats.recent).toHaveLength(1);
		const row = stats.recent[0];
		expect(row.spotlightUsd).toBeCloseTo(0.0031, 10);
		expect(row.hiddenLines).toBe(38);
		expect(row.savedTokens).toBe(1000);
		expect(row.recoveries.map(r => [r.kind, r.toolCallId])).toEqual([["artifact", dive]]);
	});

	it("does not count a fork's copied results twice", async () => {
		const b = new SpotlightSessionBuilder(T0).header("/repo").marker();
		b.user("go");
		shortenedRead(b);
		await write("parent.jsonl", b);
		await dashboard();
		await write("parent-fork.jsonl", b);

		const stats = await dashboard();
		expect(stats.gross.results).toBe(1);
		expect(stats.sessions).toBe(1);
	});

	it("backfills by re-parsing only transcripts modified since the experiment shipped", async () => {
		const fresh = new SpotlightSessionBuilder(T0).header("/repo").marker();
		fresh.user("go");
		shortenedRead(fresh);
		const freshFile = await write("fresh.jsonl", fresh);
		const old = new SpotlightSessionBuilder(T0 + DAY).header("/repo").marker();
		old.user("go");
		shortenedRead(old);
		const oldFile = await write("old.jsonl", old);
		const longAgo = new Date("2026-01-01T00:00:00Z");
		await fs.utimes(oldFile, longAgo, longAgo);
		await syncAllSessions({ workers: 1 });

		// A database ingested before the Spotlight tables existed.
		const db = await initDb();
		for (const table of ["spotlight_sessions", "spotlight_results", "spotlight_calls", "spotlight_requests"]) {
			db.run(`DELETE FROM ${table}`);
		}
		db.run("DELETE FROM meta WHERE key = 'spotlight_v1'");
		closeDb();

		const stats = await dashboard();
		expect(stats.sessionList.map(s => s.sessionFile)).toEqual([freshFile]);
	});
});
