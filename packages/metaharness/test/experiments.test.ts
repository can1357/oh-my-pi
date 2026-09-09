import { describe, expect, it } from "bun:test";
import {
	armOf,
	calibratedFinalPassPct,
	canonicalArmOf,
	experimentOf,
	pickMergedTrials,
	summarizeArm,
} from "../src/experiments";
import type { RunRow, TraceRow } from "../src/store";

/**
 * Contracts under test:
 *  - job names group by their first `-` token; arm labels strip that prefix.
 *  - summarizeArm computes observed metrics from decided trials only and
 *    projects running arms linearly (ETA, pass%, total cost).
 */

function runRow(overrides: Partial<RunRow>): RunRow {
	return {
		benchmark: "harbor",
		jobName: "exp-arm",
		dataset: "d",
		agent: "omp",
		models: "anthropic/claude-opus-4-8",
		label: "",
		prewalk: null,
		config: {},
		role: "",
		note: "",
		status: "running",
		pid: null,
		exitCode: null,
		createdAt: Date.now(),
		finishedAt: null,
		nTotal: 0,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		score: null,
		metrics: {},
		...overrides,
	};
}

function traceRow(overrides: Partial<TraceRow>): TraceRow {
	return {
		jobName: "exp-arm",
		name: "task__x",
		task: "task",
		status: "pass",
		reward: 1,
		costUsd: 1,
		durationMs: 60_000,
		detail: "",
		updatedAt: Date.now(),
		tracePath: null,
		...overrides,
	};
}

describe("experiment grouping", () => {
	it("groups by prefix and strips it from arm labels", () => {
		expect(experimentOf("sb2-n4p-fix")).toBe("sb2");
		expect(armOf("sb2-n4p-fix")).toBe("n4p-fix");
		expect(experimentOf("standalone")).toBe("standalone");
		expect(armOf("standalone")).toBe("standalone");
	});
});

describe("summarizeArm", () => {
	it("computes observed and projected stats from decided trials, not total spend", () => {
		const tenMinutesAgo = Date.now() - 10 * 60_000;
		// 10 decided trials (8 pass / 2 fail) at $0.50 each; run.costUsd = $15
		// includes in-flight spend that must NOT inflate $/task.
		const trials = Array.from({ length: 10 }, (_, i) =>
			traceRow({
				name: `t${i}__x`,
				task: `t${i}`,
				status: i < 8 ? "pass" : "fail",
				reward: i < 8 ? 1 : 0,
				costUsd: 0.5,
				durationMs: 120_000,
			}),
		);
		const running = summarizeArm(
			runRow({
				jobName: "sb2-n8",
				status: "running",
				createdAt: tenMinutesAgo,
				nTotal: 20,
				done: 10,
				pass: 8,
				costUsd: 15,
			}),
			trials,
		);
		expect(running.arm).toBe("n8");
		expect(running.projected).not.toBeNull();
		// 10 decided in 10 min → 1/min → 10 remaining ≈ 10 min out.
		const etaMin = ((running.projected?.etaMs ?? 0) - Date.now()) / 60_000;
		expect(etaMin).toBeGreaterThan(8);
		expect(etaMin).toBeLessThan(12);
		expect(running.projected?.passPct).toBeCloseTo(80, 5);
		// $/task from decided trials ($0.50), not costUsd/done ($1.50).
		expect(running.costPerTask).toBeCloseTo(0.5, 5);
		expect(running.projected?.costPerTask).toBeCloseTo(0.5, 5);
		// Projected total = committed spend + decided-rate estimate of the rest.
		expect(running.projected?.totalCostUsd).toBeCloseTo(15 + 0.5 * 10, 5);
		expect(running.passPct).toBeCloseTo(80, 5);
		expect(running.meanTrialMs).toBeCloseTo(120_000, 5);

		const finished = summarizeArm(
			runRow({ jobName: "sb2-opus", status: "complete", nTotal: 20, done: 20, pass: 15, costUsd: 30 }),
			[traceRow({})],
		);
		expect(finished.projected).toBeNull();
		// Decided-trace cost ($1 trial), not costUsd/done.
		expect(finished.costPerTask).toBeCloseTo(1, 5);
	});

	it("describes the prewalk config in the arm line", () => {
		const arm = summarizeArm(
			runRow({
				jobName: "sb2-nact",
				prewalk: JSON.stringify({ into: "google/gemini-3.5-flash" }),
			}),
			[],
		);
		expect(arm.config).toBe("harbor · anthropic/claude-opus-4-8 → google/gemini-3.5-flash at first action");
	});

	it("still labels legacy reasoning-slide rows", () => {
		const arm = summarizeArm(
			runRow({
				jobName: "sb2-nact",
				prewalk: JSON.stringify({ model: "google/gemini-3.5-flash", onAction: true, plan: true }),
			}),
			[],
		);
		expect(arm.config).toBe("harbor · anthropic/claude-opus-4-8 → google/gemini-3.5-flash on first edit/write +plan");
	});
});

describe("calibratedFinalPassPct", () => {
	const sib = (entries: Array<[string, number, number]>) =>
		new Map(entries.map(([task, passes, decided]) => [task, { passes, decided }]));

	it("discounts a perfect score earned on tasks every sibling also passes", () => {
		// Arm decided 3 easy tasks (5/5 siblings pass) at 100%; the remaining 5
		// tasks are hard (0/5 siblings pass). Naive projection says 100%.
		const projected = calibratedFinalPassPct({
			decided: [
				{ task: "e1", passed: true },
				{ task: "e2", passed: true },
				{ task: "e3", passed: true },
			],
			siblings: sib([
				["e1", 5, 5],
				["e2", 5, 5],
				["e3", 5, 5],
				["h1", 0, 5],
				["h2", 0, 5],
				["h3", 0, 5],
				["h4", 0, 5],
				["h5", 0, 5],
			]),
			remaining: ["h1", "h2", "h3", "h4", "h5"],
			nTotal: 8,
		});
		expect(projected).not.toBeNull();
		// Far below naive 100%: the hard remainder dominates.
		expect(projected as number).toBeLessThan(70);
		// But never below what it already banked (3/8 = 37.5%).
		expect(projected as number).toBeGreaterThanOrEqual(37.5);
	});

	it("projects the sibling mean when the arm performs exactly at sibling level", () => {
		// Arm decided a representative half: passed the easy task, failed the
		// hard one — exactly the sibling pattern. Projection ≈ sibling overall
		// rate (~50%), matching what a difficulty-aware estimate must return.
		const projected = calibratedFinalPassPct({
			decided: [
				{ task: "e1", passed: true },
				{ task: "h1", passed: false },
			],
			siblings: sib([
				["e1", 4, 4],
				["h1", 0, 4],
				["e2", 4, 4],
				["h2", 0, 4],
			]),
			remaining: ["e2", "h2"],
			nTotal: 4,
		});
		expect(projected).not.toBeNull();
		expect(projected as number).toBeGreaterThan(35);
		expect(projected as number).toBeLessThan(65);
	});

	it("returns null with nothing decided to calibrate on", () => {
		expect(calibratedFinalPassPct({ decided: [], siblings: new Map(), remaining: ["a"], nTotal: 4 })).toBeNull();
	});
});

describe("re-run merging", () => {
	it("strips stacked re-run suffixes down to the base arm", () => {
		expect(canonicalArmOf("sb3-n4p2-fix")).toBe("n4p2");
		expect(canonicalArmOf("sb3-n4p2-fix2")).toBe("n4p2");
		expect(canonicalArmOf("sb3-planyolo2-fix2")).toBe("planyolo2");
		expect(canonicalArmOf("sb3-nact-backfill")).toBe("nact");
		expect(canonicalArmOf("sb3-nact-fix-retry2")).toBe("nact");
		// Not a re-run suffix — stays intact.
		expect(canonicalArmOf("sb3-nbmrng")).toBe("nbmrng");
		expect(canonicalArmOf("sb2-opus48")).toBe("opus48");
	});

	it("prefers decided re-runs over errors but never downgrades a decided result", () => {
		const merged = pickMergedTrials([
			// errored in the base run, fixed by the re-run → fix wins
			traceRow({ name: "a__1", task: "a", status: "error", reward: null, updatedAt: 100 }),
			traceRow({ name: "a__2", task: "a", status: "pass", reward: 1, updatedAt: 50 }),
			// decided twice → latest decided wins
			traceRow({ name: "b__1", task: "b", status: "fail", reward: 0, updatedAt: 100 }),
			traceRow({ name: "b__2", task: "b", status: "pass", reward: 1, updatedAt: 200 }),
			// decided, then a later still-running retry → decided kept
			traceRow({ name: "c__1", task: "c", status: "pass", reward: 1, updatedAt: 100 }),
			traceRow({ name: "c__2", task: "c", status: "running", reward: null, updatedAt: 999 }),
		]);
		const byTask = Object.fromEntries(merged.map(t => [t.task, t.name]));
		expect(byTask).toEqual({ a: "a__2", b: "b__2", c: "c__1" });
	});
});
