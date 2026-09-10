import { describe, expect, it } from "bun:test";
import {
	aggregateProcessTree,
	assertComparableFixtures,
	type BenchmarkFixture,
	calculateCpuPercent,
	compareFixtureParity,
	measureColdAndSteadyState,
	type ProcessSample,
	parseBenchmarkArgs,
	parseSmapsRollup,
	summarizeArchitectureSamples,
	summarizeLatencies,
} from "../scripts/daemon-bench";

describe("daemon benchmark Linux parsing", () => {
	it("parses PSS and RSS from smaps_rollup", () => {
		expect(
			parseSmapsRollup("Rss:                2048 kB\nPss:                1536 kB\nShared_Clean:        512 kB\n"),
		).toEqual({ rssKb: 2048, pssKb: 1536 });
	});

	it("rejects incomplete or non-kilobyte smaps data", () => {
		expect(() => parseSmapsRollup("Rss: 12 MB\nPss: 3 kB\n")).toThrow(/Rss/);
		expect(() => parseSmapsRollup("Rss: 12 kB\n")).toThrow(/Pss/);
	});

	it("aggregates only the root process tree and preserves a snapshot", () => {
		const samples: ProcessSample[] = [
			{ pid: 10, ppid: 1, pssKb: 100, rssKb: 120, cpuUserTicks: 4, cpuSystemTicks: 1, threads: 2, fds: 3 },
			{ pid: 11, ppid: 10, pssKb: 50, rssKb: 60, cpuUserTicks: 2, cpuSystemTicks: 1, threads: 1, fds: 2 },
			{ pid: 12, ppid: 11, pssKb: 25, rssKb: 30, cpuUserTicks: 1, cpuSystemTicks: 0, threads: 1, fds: 1 },
			{ pid: 99, ppid: 1, pssKb: 900, rssKb: 900, cpuUserTicks: 9, cpuSystemTicks: 9, threads: 9, fds: 9 },
		];
		expect(aggregateProcessTree(10, samples)).toMatchObject({
			processCount: 3,
			childProcessCount: 2,
			pssKb: 175,
			rssKb: 210,
			cpuUserTicks: 7,
			cpuSystemTicks: 2,
			threads: 4,
			fds: 6,
		});
		expect(aggregateProcessTree(10, samples).snapshot.map(sample => sample.pid)).toEqual([10, 11, 12]);
	});

	it("converts process CPU ticks into elapsed CPU percentage", () => {
		expect(
			calculateCpuPercent(
				{ cpuUserTicks: 10, cpuSystemTicks: 5 },
				{ cpuUserTicks: 20, cpuSystemTicks: 10 },
				1000,
				100,
			),
		).toBe(15);
	});

	it("rejects a negative aggregate CPU delta from a changing process tree", () => {
		expect(() =>
			calculateCpuPercent(
				{ cpuUserTicks: 20, cpuSystemTicks: 10 },
				{ cpuUserTicks: 10, cpuSystemTicks: 5 },
				1000,
				100,
			),
		).toThrow(/trial is invalid/);
	});
});

describe("daemon benchmark fixture parity", () => {
	const base: BenchmarkFixture = {
		cwd: "/tmp/project",
		profile: "none",
		model: "fixture-model",
		permissions: "read-only",
		mcpEnabled: false,
		lspEnabled: false,
		environment: { FIXTURE: "1" },
	};

	it("accepts identical MCP/LSP-disabled fixtures", () => {
		expect(compareFixtureParity(base, { ...base })).toEqual({ equivalent: true, differences: [] });
		expect(() => assertComparableFixtures(base, { ...base })).not.toThrow();
	});

	it("rejects differences that would invalidate a runtime comparison", () => {
		const different = { ...base, lspEnabled: true };
		const parity = compareFixtureParity(base, different);
		expect(parity.equivalent).toBe(false);
		expect(parity.differences).toContain("lspEnabled");
		expect(() => assertComparableFixtures(base, different)).toThrow(/lspEnabled/);
	});
});

describe("daemon benchmark CLI options", () => {
	it("accepts comma-separated N values and a trial count", () => {
		expect(parseBenchmarkArgs(["--n", "1,5,10", "--trials", "3"])).toEqual({
			n: [1, 5, 10],
			trials: 3,
			fairness: false,
			probes: 50,
		});
	});

	it("enables fairness mode with a custom probe count", () => {
		expect(parseBenchmarkArgs(["--fairness", "--n", "10", "--probes", "25"])).toEqual({
			n: [10],
			trials: 3,
			fairness: true,
			probes: 25,
		});
	});

	it("rejects invalid probe counts", () => {
		expect(() => parseBenchmarkArgs(["--probes", "0"])).toThrow(/--probes/);
	});

	it("rejects invalid trial counts instead of silently changing the workload", () => {
		expect(() => parseBenchmarkArgs(["--trials", "2,3"])).toThrow(/--trials/);
	});
});

describe("daemon benchmark latency summaries", () => {
	it("reports percentile values and raw samples", () => {
		expect(summarizeLatencies([10, 20, 30, 40])).toEqual({
			count: 4,
			minMs: 10,
			maxMs: 40,
			p50Ms: 20,
			p95Ms: 40,
			p99Ms: 40,
			rawMs: [10, 20, 30, 40],
		});
	});

	it("measures cold and steady-state paths independently", async () => {
		let coldCalls = 0;
		let steadyCalls = 0;
		const timing = await measureColdAndSteadyState(
			async () => {
				coldCalls += 1;
			},
			async () => {
				steadyCalls += 1;
			},
			2,
		);
		expect(coldCalls).toBe(2);
		expect(steadyCalls).toBe(2);
		expect(timing.cold.count).toBe(2);
		expect(timing.steadyState.count).toBe(2);
		expect(timing.cold.rawMs.every(sample => sample >= 0)).toBe(true);
	});
});

describe("daemon architecture benchmark summaries", () => {
	it("groups actual runtime samples by mode and concurrency", () => {
		const resources = {
			processCount: 2,
			childProcessCount: 1,
			pssKb: 100,
			rssKb: 200,
			cpuUserTicks: 3,
			cpuSystemTicks: 2,
			threads: 4,
			fds: 5,
		};
		const summaries = summarizeArchitectureSamples([
			{ mode: "direct", n: 2, trial: 0, startupMs: 100, steadySessionMs: 40, resources },
			{
				mode: "direct",
				n: 2,
				trial: 1,
				startupMs: 120,
				steadySessionMs: 60,
				resources: { ...resources, pssKb: 140 },
			},
		]);

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			mode: "direct",
			n: 2,
			startup: { count: 2, p50Ms: 100, p95Ms: 120 },
			steadySession: { count: 2, p50Ms: 40, p95Ms: 60 },
			resources: { pssKb: 120, rssKb: 200, processCount: 2 },
		});
	});
});
