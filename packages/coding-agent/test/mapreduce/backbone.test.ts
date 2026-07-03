import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildReducerTreePlan,
	buildSignalGraph,
	computeEffectiveParallelism,
	computeRecursionLeafCapacity,
	mergeReducerOutputs,
	normalizeConcurrencyCap,
	planShards,
	runLexicalSelectors,
	runShardQueue,
	type SelectorSignal,
	type SignalGraph,
	selectorLedgerComplete,
} from "@pk-nerdsaver-ai/pi-coding-agent/mapreduce";
import { Semaphore } from "@pk-nerdsaver-ai/pi-coding-agent/task/parallel";

function signal(id: string, file: string, tags: string[] = []): SelectorSignal {
	return {
		id,
		selectorId: "selector",
		type: "lexical",
		file,
		line: 1,
		evidence: id,
		reason: "test signal",
		tags,
	};
}

describe("mapreduce concurrency math", () => {
	it("treats non-positive concurrency caps as unbounded", async () => {
		expect(normalizeConcurrencyCap(0)).toBe(Number.POSITIVE_INFINITY);
		expect(normalizeConcurrencyCap(-1)).toBe(Number.POSITIVE_INFINITY);

		const semaphore = new Semaphore(0);
		let resolved = 0;
		const acquisitions = [semaphore.acquire(), semaphore.acquire(), semaphore.acquire(), semaphore.acquire()];
		for (const acquisition of acquisitions) {
			acquisition.then(() => {
				resolved += 1;
			});
		}
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(4);
		for (let index = 0; index < acquisitions.length; index += 1) {
			semaphore.release();
		}
	});

	it("uses shard duration to convert provider rate limits into active concurrency", () => {
		const result = computeEffectiveParallelism({
			taskMaxConcurrency: 32,
			providerRequestsPerMinute: 60,
			expectedRequestsPerShard: 2,
			expectedShardDurationMs: 30_000,
			providerTokensPerMinute: 120_000,
			expectedTokensPerShard: 10_000,
		});

		expect(result.concurrency).toBe(6);
		expect(result.limitingFactors).toEqual(["provider_tpm"]);
		expect(result.maxAffordableShards).toBeUndefined();

		const affordable = computeEffectiveParallelism({
			taskMaxConcurrency: 32,
			expectedShardDurationMs: 30_000,
			totalCostBudget: 10,
			expectedCostPerShard: 2,
		});
		expect(affordable.concurrency).toBe(32);
		expect(affordable.maxAffordableShards).toBe(5);

		const throttled = computeEffectiveParallelism({
			taskMaxConcurrency: 32,
			providerRequestsPerMinute: 1,
			expectedRequestsPerShard: 2,
			expectedShardDurationMs: 30_000,
		});
		expect(throttled.rawConcurrency).toBe(0.25);
		expect(throttled.concurrency).toBe(1);
		expect(throttled.capacityLimited).toBe(true);
		expect(throttled.minInterStartDelayMs).toBe(120_000);
	});

	it("models recursion leaf capacity separately from flat queue size", () => {
		expect(computeRecursionLeafCapacity({ maxRecursionDepth: 2, branchingFactor: 8 })).toBe(64);
		expect(computeRecursionLeafCapacity({ maxRecursionDepth: 0, branchingFactor: 8 })).toBe(0);
		expect(computeRecursionLeafCapacity({ maxRecursionDepth: -1, branchingFactor: 8 })).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});

describe("evidence graph partitioning", () => {
	it("keeps related signals together while satisfying shard limits", () => {
		const graph = buildSignalGraph({
			signals: [
				signal("a", "packages/auth/src/a.ts"),
				signal("b", "packages/auth/src/a.ts"),
				signal("c", "packages/api/src/c.ts"),
			],
			weights: { a: 5, b: 5, c: 5 },
			tokens: { a: 10, b: 10, c: 10 },
		});

		const plan = planShards({
			graph,
			limits: { maxShardTokens: 20, maxShardSignals: 2, maxShardFiles: 1, targetWeight: 10 },
			effectiveConcurrency: 1,
			reducerFanIn: 2,
		});

		expect(plan.feasible).toBe(true);
		expect(plan.infeasibleSignals).toEqual([]);
		expect(plan.shards).toHaveLength(2);
		expect(plan.shards.map(shard => shard.signalIds).sort()).toEqual([["a", "b"], ["c"]]);
		expect(
			plan.shards.every(shard => shard.tokens <= 20 && shard.signalIds.length <= 2 && shard.files.length <= 1),
		).toBe(true);
	});

	it("marks atomic signals infeasible instead of violating constraints", () => {
		const graph = buildSignalGraph({
			signals: [signal("oversized", "packages/auth/src/a.ts")],
			weights: { oversized: 50 },
			tokens: { oversized: 100 },
		});

		const plan = planShards({
			graph,
			limits: { maxShardTokens: 10, maxShardSignals: 2, maxShardFiles: 1, targetWeight: 10 },
		});

		expect(plan.feasible).toBe(false);
		expect(plan.shards).toEqual([]);
		expect(plan.infeasibleSignals).toEqual([
			{ id: "oversized", reasons: ["tokens exceed maxShardTokens", "weight exceeds targetWeight"] },
		]);
	});

	it("uses reducer input weight to trade extra shards against packed work", () => {
		const graph = buildSignalGraph({
			signals: [signal("a", "packages/auth/src/a.ts"), signal("b", "packages/api/src/b.ts")],
			weights: { a: 1, b: 1 },
			tokens: { a: 1, b: 1 },
		});
		const limits = { maxShardTokens: 100, maxShardSignals: 10, maxShardFiles: 10, targetWeight: 10 };

		const split = planShards({
			graph,
			limits,
			objectiveWeights: { cutEdges: 0, duplicateContext: 0, reducerInput: 0, failureRisk: 0 },
		});
		const packed = planShards({
			graph,
			limits,
			objectiveWeights: { cutEdges: 0, duplicateContext: 0, reducerInput: 10, failureRisk: 0 },
		});

		expect(split.shards).toHaveLength(2);
		expect(packed.shards).toHaveLength(1);
	});

	it("scores cut edges by projected hyperedge delta, not assigned-neighbor affinity", () => {
		const graph: SignalGraph = {
			nodes: [
				{ id: "a", signal: signal("a", "packages/auth/src/a.ts"), weight: 1, tokens: 1 },
				{ id: "b", signal: signal("b", "packages/api/src/b.ts"), weight: 1, tokens: 1 },
				{ id: "c", signal: signal("c", "packages/auth/src/a.ts"), weight: 1, tokens: 1 },
			],
			edges: [{ id: "wide-edge", kind: "same-symbol", signalIds: ["a", "b", "c"], weight: 100 }],
		};

		const plan = planShards({
			graph,
			limits: { maxShardTokens: 100, maxShardSignals: 10, maxShardFiles: 1, targetWeight: 10 },
			objectiveWeights: { cutEdges: 100, duplicateContext: 0, reducerInput: 0, failureRisk: 0 },
		});

		expect(plan.shards.map(shard => shard.signalIds)).toEqual([["a"], ["b"], ["c"]]);
		expect(plan.metrics.cutEdgeWeight).toBe(100);
	});

	it("uses failure risk as a concentration penalty", () => {
		const graph: SignalGraph = {
			nodes: [
				{ id: "a", signal: signal("a", "packages/auth/src/a.ts"), weight: 1, tokens: 1, failureRisk: 0.9 },
				{ id: "b", signal: signal("b", "packages/api/src/b.ts"), weight: 1, tokens: 1, failureRisk: 0.9 },
			],
			edges: [],
		};
		const limits = { maxShardTokens: 100, maxShardSignals: 10, maxShardFiles: 10, targetWeight: 10 };

		const concentrated = planShards({
			graph,
			limits,
			objectiveWeights: { cutEdges: 0, duplicateContext: 0, reducerInput: 1, failureRisk: 0 },
		});
		const spread = planShards({
			graph,
			limits,
			objectiveWeights: { cutEdges: 0, duplicateContext: 0, reducerInput: 1, failureRisk: 1 },
		});

		expect(concentrated.shards).toHaveLength(1);
		expect(concentrated.metrics.failureRisk).toBeCloseTo(3.24);
		expect(spread.shards).toHaveLength(2);
		expect(spread.metrics.failureRisk).toBeCloseTo(1.62);
	});
});

describe("associative reducer tree primitives", () => {
	it("merges coverage additively, findings by key, severity by max, and ledger validity by AND", () => {
		const left = mergeReducerOutputs([
			{
				coverage: { signalsAssigned: 2, signalsCleared: 1, signalsConfirmed: 1 },
				processedSignalIds: ["a", "b"],
				findings: [{ id: "finding", severity: "medium" }],
				ledgerValid: true,
			},
		]);
		const right = mergeReducerOutputs([
			{
				coverage: { signalsAssigned: 1, signalsCleared: 0, signalsConfirmed: 1 },
				processedSignalIds: ["c"],
				findings: [{ id: "finding", severity: "high" }],
				ledgerValid: false,
			},
		]);

		const merged = mergeReducerOutputs([left, right]);
		expect(merged.coverage).toEqual({ signalsAssigned: 3, signalsCleared: 1, signalsConfirmed: 2 });
		expect(merged.processedSignalIds).toEqual(["a", "b", "c"]);
		expect(merged.findings).toEqual([{ id: "finding", severity: "high" }]);
		expect(merged.severity).toBe("high");
		expect(merged.ledgerValid).toBe(false);
	});

	it("merges equal-severity duplicates deterministically across reducer orderings", () => {
		const first = {
			coverage: { signalsAssigned: 1, signalsCleared: 0, signalsConfirmed: 1 },
			processedSignalIds: ["a"],
			findings: [{ id: "left", duplicateOf: "root", severity: "high" as const, title: "Z title", files: ["b.ts"] }],
			ledgerValid: true,
		};
		const second = {
			coverage: { signalsAssigned: 1, signalsCleared: 0, signalsConfirmed: 1 },
			processedSignalIds: ["b"],
			findings: [{ id: "right", duplicateOf: "root", severity: "high" as const, title: "A title", files: ["a.ts"] }],
			ledgerValid: true,
		};

		expect(mergeReducerOutputs([first, second]).findings).toEqual(mergeReducerOutputs([second, first]).findings);
		expect(mergeReducerOutputs([first, second]).findings).toEqual([
			{ id: "root", duplicateOf: "root", severity: "high", title: "A title", files: ["a.ts", "b.ts"] },
		]);
	});

	it("normalizes reducer fan-in without producing empty reducer groups", () => {
		const fallback = buildReducerTreePlan(3, Number.NaN);
		expect(fallback.fanIn).toBe(2);
		expect(fallback.layers[0]?.groups).toEqual([
			{ id: "reduce_0_0", inputIndexes: [0, 1] },
			{ id: "reduce_0_1", inputIndexes: [2] },
		]);

		const unbounded = buildReducerTreePlan(3, Number.POSITIVE_INFINITY);
		expect(unbounded.fanIn).toBe(3);
		expect(unbounded.layers).toEqual([
			{
				level: 0,
				groups: [{ id: "reduce_0_0", inputIndexes: [0, 1, 2] }],
			},
		]);
	});
});

describe("bounded shard scheduler", () => {
	it("keeps active work under the effective concurrency cap", async () => {
		let active = 0;
		let maxActive = 0;
		let started = 0;
		const firstWindow = Promise.withResolvers<void>();
		const releaseWorkers = Promise.withResolvers<void>();
		const queueRun = runShardQueue({
			concurrency: 2,
			shards: [
				{ id: "a", priority: 1 },
				{ id: "b", priority: 4 },
				{ id: "c", priority: 3 },
				{ id: "d", priority: 2 },
			],
			worker: async shard => {
				active += 1;
				started += 1;
				maxActive = Math.max(maxActive, active);
				if (started === 2) firstWindow.resolve();
				await releaseWorkers.promise;
				active -= 1;
				return shard.id;
			},
		});
		await firstWindow.promise;
		expect(maxActive).toBe(2);
		releaseWorkers.resolve();
		const result = await queueRun;

		expect(result.completed).toBe(4);
		expect(result.failed).toBe(0);
		expect(result.maxActive).toBeLessThanOrEqual(2);
		expect(maxActive).toBeLessThanOrEqual(2);
	});
});

describe("selector ledger accounting", () => {
	it("fails closed when selectors were truncated or oversized files were skipped", () => {
		expect(
			selectorLedgerComplete([
				{
					id: "selector",
					type: "lexical",
					filesSearched: 1,
					filesWithMatches: 1,
					observedMatches: 1,
					returnedMatches: 1,
					limitReached: false,
					skippedOversized: 0,
				},
			]),
		).toBe(true);
		expect(
			selectorLedgerComplete([
				{
					id: "selector",
					type: "lexical",
					filesSearched: 1,
					filesWithMatches: 1,
					observedMatches: 1,
					returnedMatches: 1,
					limitReached: true,
					skippedOversized: 0,
				},
			]),
		).toBe(false);
		expect(
			selectorLedgerComplete([
				{
					id: "selector",
					type: "lexical",
					filesSearched: 1,
					filesWithMatches: 1,
					observedMatches: 1,
					returnedMatches: 1,
					limitReached: false,
					skippedOversized: 1,
				},
			]),
		).toBe(false);
	});

	it("attributes selectors before applying evidence line truncation", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapreduce-selector-"));
		try {
			const fullLine = `${"x".repeat(600)}MATCH_TOKEN`;
			await Bun.write(path.join(tempDir, "long.txt"), `${fullLine}\n`);

			const result = await runLexicalSelectors({
				cwd: tempDir,
				includeGlob: "*.txt",
				gitignore: false,
				maxColumns: 20,
				selectors: [
					{
						id: "late-literal",
						type: "lexical",
						pattern: "MATCH_TOKEN",
						reason: "test late literal line match",
					},
					{
						id: "late-regex",
						type: "lexical",
						pattern: "MATCH_[A-Z]+",
						reason: "test late regex line match",
					},
				],
			});

			expect(result.signals).toHaveLength(2);
			const literalSignal = result.signals.find(signal => signal.selectorId === "late-literal");
			const regexSignal = result.signals.find(signal => signal.selectorId === "late-regex");
			expect(literalSignal?.evidence).toContain("MATCH_TOKEN");
			expect(literalSignal?.evidence.length).toBeLessThan(fullLine.length);
			expect(regexSignal?.evidence).toBe(fullLine);
			expect(selectorLedgerComplete(result.selectorLedger)).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
