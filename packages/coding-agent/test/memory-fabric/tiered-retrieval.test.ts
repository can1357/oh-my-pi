import { describe, expect, it } from "bun:test";
import {
	calculateScopeScore,
	candidateMatchesTier,
	classifyTaskCategory,
	deduplicateCandidates,
	extractEntities,
	inferRecordTier,
	isStatusEligible,
	selectExpansionTiers,
	selectMemoryLanes,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/lane-selection";
import {
	selectTierAware,
	TieredRetrievalBroker,
	tierRelevance,
	verificationMultiplier,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-broker";
import type {
	ExpansionSignals,
	MemoryLane,
	MemoryLaneAdapter,
	RetrievedMemoryCandidate,
	TieredRetrievalOptions,
	TieredRetrievalRequest,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-types";
import {
	CONTEXT_TIER_ORDER,
	DEFAULT_TIERED_RETRIEVAL_CONFIG,
	DEFAULT_TIERED_RETRIEVAL_OPTIONS,
	LANE_PRIORITY_ORDER,
	RETRIEVAL_LANE_TO_STORAGE_LANE,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-types";

/**
 * Build a candidate.
 *
 * The default `contentHash` is derived from `memoryId` rather than being a
 * shared constant: `deduplicateCandidates` collapses identical hashes, so a
 * shared default silently annihilated every multi-candidate fixture that did
 * not think to override it. Tests that *want* a collision now have to say so.
 */
function candidate(overrides: Partial<RetrievedMemoryCandidate> = {}): RetrievedMemoryCandidate {
	const memoryId = overrides.memoryId ?? "m1";
	return {
		memoryId,
		lane: "canonical",
		tier: "L1",
		type: "fact",
		content: "content",
		scope: { projectId: "p1" },
		scopeScore: 1,
		confidence: 0.9,
		freshness: 1,
		usefulness: 1,
		importance: 0.5,
		status: "active",
		verification: "user-confirmed",
		sourceReferences: [],
		contentHash: `hash:${memoryId}`,
		tokenEstimate: 10,
		...overrides,
	};
}

function request(overrides: Partial<TieredRetrievalRequest> = {}): TieredRetrievalRequest {
	return {
		query: "q",
		taskType: "normal",
		scope: { projectId: "p1" },
		entities: { files: [], symbols: [], errors: [], taskNames: [], commands: [] },
		requestedTiers: ["L1"],
		...overrides,
	};
}

function options(overrides: Partial<TieredRetrievalOptions> = {}): TieredRetrievalOptions {
	return { ...DEFAULT_TIERED_RETRIEVAL_OPTIONS, ...overrides };
}

function signals(overrides: Partial<ExpansionSignals> = {}): ExpansionSignals {
	return {
		taskComplexity: 0,
		graphImpact: 0,
		retrievalConfidence: 1,
		retrievalCoverage: 1,
		contradictionCount: 0,
		unresolvedIssueCount: 0,
		repeatedFailureCount: 0,
		unfamiliarSymbolCount: 0,
		missingProcedureCount: 0,
		planBreadth: 0,
		currentContextSaturation: 0,
		isCrashRecovery: false,
		isCompactionRecovery: false,
		isExternalWrite: false,
		isDestructiveOperation: false,
		modelRequestedExpansion: false,
		userRequestedHistory: false,
		...overrides,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

interface AdapterBehaviour {
	throws?: string;
	delayMs?: number;
}

function adapter(
	id: MemoryLane,
	candidates: RetrievedMemoryCandidate[],
	behaviour: AdapterBehaviour = {},
): MemoryLaneAdapter {
	return {
		id,
		name: id,
		async retrieve() {
			if (behaviour.delayMs !== undefined) await sleep(behaviour.delayMs);
			if (behaviour.throws !== undefined) throw new Error(behaviour.throws);
			return candidates;
		},
		async healthCheck() {
			return { healthy: true, latencyMs: 1 };
		},
	};
}

describe("lane selection", () => {
	it("always consults the continuity and canonical lanes", () => {
		const lanes = selectMemoryLanes({ taskType: "trivial", requestedTiers: [] });
		expect(lanes).toContain("working-state");
		expect(lanes).toContain("canonical");
	});

	it("adds the archival lanes for L4", () => {
		const lanes = selectMemoryLanes({ taskType: "normal", requestedTiers: ["L4"] });
		expect(lanes).toContain("memvid");
		expect(lanes).toContain("mempalace");
	});

	it("adds the graph lane for L3", () => {
		const lanes = selectMemoryLanes({ taskType: "normal", requestedTiers: ["L3"] });
		expect(lanes).toContain("graphify");
	});

	it("adds archival lanes for debugging and recovery work", () => {
		expect(selectMemoryLanes({ taskType: "debugging", requestedTiers: [] })).toContain("memvid");
		expect(selectMemoryLanes({ taskType: "recovery", requestedTiers: [] })).toContain("mempalace");
	});

	it("adds the graph lane for architecture and repository-wide work", () => {
		expect(selectMemoryLanes({ taskType: "architecture", requestedTiers: [] })).toContain("graphify");
		expect(selectMemoryLanes({ taskType: "repository-wide", requestedTiers: [] })).toContain("graphify");
	});

	it("infers the graph lane from concrete code context", () => {
		const withFiles = selectMemoryLanes({ taskType: "normal", requestedTiers: [], files: ["a.ts"] });
		const withSymbols = selectMemoryLanes({ taskType: "normal", requestedTiers: [], symbols: ["parse"] });
		expect(withFiles).toContain("graphify");
		expect(withSymbols).toContain("graphify");
	});

	it("honours explicitly preferred lanes", () => {
		const lanes = selectMemoryLanes({ taskType: "trivial", requestedTiers: [], preferredLanes: ["mempalace"] });
		expect(lanes).toContain("mempalace");
	});

	it("returns lanes in priority order, without duplicates", () => {
		const lanes = selectMemoryLanes({ taskType: "debugging", requestedTiers: ["L3", "L4"] });
		const indices = lanes.map(lane => LANE_PRIORITY_ORDER.indexOf(lane));
		expect(new Set(lanes).size).toBe(lanes.length);
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
	});

	it("is deterministic for a given input", () => {
		const input = { taskType: "debugging", requestedTiers: ["L3"] } as const;
		expect(selectMemoryLanes({ ...input, requestedTiers: ["L3"] })).toEqual(
			selectMemoryLanes({ ...input, requestedTiers: ["L3"] }),
		);
	});
});

describe("scope scoring", () => {
	it("returns zero across project boundaries", () => {
		const item = candidate({ scope: { projectId: "other" } });
		expect(calculateScopeScore(item, { projectId: "p1" })).toBe(0);
	});

	it("returns the base score for a bare project match", () => {
		expect(calculateScopeScore(candidate(), { projectId: "p1" })).toBe(0.5);
	});

	it("rewards finer-grained scope agreement", () => {
		const item = candidate({ scope: { projectId: "p1", branchId: "b1" } });
		expect(calculateScopeScore(item, { projectId: "p1", branchId: "b1" })).toBeCloseTo(0.65);
	});

	it("never exceeds one", () => {
		const scope = { projectId: "p1", worktreeId: "w", branchId: "b", taskId: "t", agentId: "a" };
		expect(calculateScopeScore(candidate({ scope }), scope)).toBe(1);
	});
});

describe("eligibility", () => {
	const base = { includeProvisional: false, includeHistorical: false, requestedTiers: [] };

	it("treats an empty tier list as no filter", () => {
		expect(candidateMatchesTier(candidate({ tier: "L4" }), [])).toBe(true);
		expect(candidateMatchesTier(candidate({ tier: "L4" }), ["L1"])).toBe(false);
	});

	it("never surfaces terminal states", () => {
		expect(isStatusEligible(candidate({ status: "quarantined" }), base)).toBe(false);
		expect(isStatusEligible(candidate({ status: "tombstoned" }), base)).toBe(false);
	});

	it("surfaces historical states only on request", () => {
		const superseded = candidate({ status: "superseded" });
		expect(isStatusEligible(superseded, base)).toBe(false);
		expect(isStatusEligible(superseded, { ...base, includeHistorical: true })).toBe(true);
	});

	it("surfaces model-proposed records only on request", () => {
		const provisional = candidate({ verification: "model-proposed" });
		expect(isStatusEligible(provisional, base)).toBe(false);
		expect(isStatusEligible(provisional, { ...base, includeProvisional: true })).toBe(true);
	});
});

describe("deduplication", () => {
	it("collapses identical content hashes to the first occurrence", () => {
		const first = candidate({ memoryId: "a", contentHash: "same" });
		const second = candidate({ memoryId: "b", contentHash: "same" });
		const kept = deduplicateCandidates([first, second]);
		expect(kept.map(item => item.memoryId)).toEqual(["a"]);
	});

	it("keeps distinct memories that merely cite the same source", () => {
		// Regression: an earlier revision dropped any candidate sharing a single
		// source reference with an earlier one, annihilating distinct memories
		// about the same file.
		const first = candidate({ memoryId: "a", sourceReferences: ["file:src/a.ts"] });
		const second = candidate({ memoryId: "b", sourceReferences: ["file:src/a.ts"] });
		const kept = deduplicateCandidates([first, second]);
		expect(kept.map(item => item.memoryId)).toEqual(["a", "b"]);
	});

	it("drops a record superseded by one that was kept", () => {
		const replacement = candidate({ memoryId: "new" });
		const old = candidate({ memoryId: "old", supersededBy: "new" });
		const kept = deduplicateCandidates([replacement, old]);
		expect(kept.map(item => item.memoryId)).toEqual(["new"]);
	});

	it("keeps a record whose successor is absent", () => {
		const old = candidate({ memoryId: "old", supersededBy: "missing" });
		expect(deduplicateCandidates([old]).map(item => item.memoryId)).toEqual(["old"]);
	});
});

describe("tier inference", () => {
	it("maps the working-state lane to L0", () => {
		expect(inferRecordTier(candidate({ lane: "working-state", type: "fact" }))).toBe("L0");
	});

	it("maps procedures to L2", () => {
		// Regression: `procedure` used to appear in the L1 list ahead of the L2
		// check, making the L2 branch unreachable for every procedure record.
		expect(inferRecordTier(candidate({ type: "procedure" }))).toBe("L2");
		expect(inferRecordTier(candidate({ type: "failure" }))).toBe("L2");
	});

	it("maps durable claims to L1", () => {
		expect(inferRecordTier(candidate({ type: "decision" }))).toBe("L1");
		expect(inferRecordTier(candidate({ type: "constraint" }))).toBe("L1");
	});

	it("maps structural detail to L3", () => {
		expect(inferRecordTier(candidate({ type: "evidence" }))).toBe("L3");
		expect(inferRecordTier(candidate({ lane: "graphify", type: "fact" }))).toBe("L3");
	});

	it("maps history to L4 regardless of type", () => {
		expect(inferRecordTier(candidate({ type: "episode" }))).toBe("L4");
		expect(inferRecordTier(candidate({ type: "decision", status: "superseded" }))).toBe("L4");
		expect(inferRecordTier(candidate({ type: "decision", status: "archived" }))).toBe("L4");
	});
});

describe("expansion tier selection", () => {
	it("never expands into nothing", () => {
		expect(selectExpansionTiers(signals())).toEqual(["L1"]);
	});

	it("expands to L2 on repeated failures", () => {
		expect(selectExpansionTiers(signals({ repeatedFailureCount: 2 }))).toContain("L2");
	});

	it("expands to L3 on wide structural impact", () => {
		expect(selectExpansionTiers(signals({ graphImpact: 0.8 }))).toContain("L3");
	});

	it("expands to L4 on contradictions or explicit history requests", () => {
		expect(selectExpansionTiers(signals({ contradictionCount: 1 }))).toContain("L4");
		expect(selectExpansionTiers(signals({ userRequestedHistory: true }))).toContain("L4");
	});

	it("returns tiers in canonical order", () => {
		const tiers = selectExpansionTiers(signals({ repeatedFailureCount: 1, graphImpact: 1, contradictionCount: 1 }));
		const indices = tiers.map(tier => CONTEXT_TIER_ORDER.indexOf(tier));
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
	});
});

describe("entity extraction", () => {
	it("extracts file paths", () => {
		expect(extractEntities("please open src/memory/index.ts now").files).toContain("src/memory/index.ts");
	});

	it("extracts camelCase and snake_case symbols", () => {
		const entities = extractEntities("call parseRequest and then read_config");
		expect(entities.symbols).toContain("parseRequest");
		expect(entities.symbols).toContain("read_config");
	});

	it("extracts and lowercases error keywords", () => {
		expect(extractEntities("it Failed with a TIMEOUT").errors).toEqual(["failed", "timeout"]);
	});

	it("deduplicates repeated matches", () => {
		expect(extractEntities("a.ts and a.ts again").files).toEqual(["a.ts"]);
	});
});

describe("task classification", () => {
	it("classifies short neutral prompts as trivial", () => {
		expect(classifyTaskCategory("rename a var")).toBe("trivial");
	});

	it("classifies recovery phrasing before anything else", () => {
		expect(classifyTaskCategory("restore the session from the last checkpoint")).toBe("recovery");
	});

	it("prefers repository-wide over debugging when both match", () => {
		// Regression: "fix all files" is repository-wide work that merely mentions
		// a fix; the debugging check used to win because it ran first.
		expect(classifyTaskCategory("fix all files that use the old logger")).toBe("repository-wide");
	});

	it("classifies architecture work", () => {
		expect(classifyTaskCategory("design the migration for the storage layer")).toBe("architecture");
	});

	it("classifies debugging work", () => {
		expect(classifyTaskCategory("the parser crashes on empty input, please look")).toBe("debugging");
	});
});

describe("retrieval-lane to storage-lane mapping", () => {
	it("routes both memvid ranking strategies to one storage lane", () => {
		expect(RETRIEVAL_LANE_TO_STORAGE_LANE["memvid-lexical"]).toBe("memvid");
		expect(RETRIEVAL_LANE_TO_STORAGE_LANE["memvid-temporal"]).toBe("memvid");
	});

	it("maps every retrieval lane to a known storage lane", () => {
		for (const storageLane of Object.values(RETRIEVAL_LANE_TO_STORAGE_LANE)) {
			expect(LANE_PRIORITY_ORDER).toContain(storageLane);
		}
	});
});

describe("quality multipliers", () => {
	it("orders verification levels by evidence strength", () => {
		expect(verificationMultiplier("user-confirmed")).toBeGreaterThan(verificationMultiplier("test-observed"));
		expect(verificationMultiplier("test-observed")).toBeGreaterThan(verificationMultiplier("episode-derived"));
		expect(verificationMultiplier("episode-derived")).toBeGreaterThan(verificationMultiplier("model-proposed"));
	});

	it("never down-weights the continuity tiers", () => {
		expect(tierRelevance("L0", [])).toBe(1);
		expect(tierRelevance("L1", [])).toBe(1);
	});

	it("discounts deep tiers that were not requested", () => {
		expect(tierRelevance("L3", [])).toBe(0.5);
		expect(tierRelevance("L3", ["L3"])).toBe(0.8);
	});
});

describe("tier-aware partitioning", () => {
	it("leads with continuity tiers and preserves order inside each group", () => {
		const items = [
			candidate({ memoryId: "deep", tier: "L3" }),
			candidate({ memoryId: "core", tier: "L1" }),
			candidate({ memoryId: "deeper", tier: "L4" }),
		];
		const selected = selectTierAware(items, ["L3", "L4"]);
		expect(selected.map(item => item.memoryId)).toEqual(["core", "deep", "deeper"]);
	});

	it("drops tiers that were neither continuity nor requested", () => {
		const items = [candidate({ memoryId: "deep", tier: "L4" })];
		expect(selectTierAware(items, ["L2"])).toEqual([]);
	});
});

describe("reciprocal rank fusion", () => {
	const broker = new TieredRetrievalBroker();

	it("scores a single first-place candidate as 1 / (k + 1)", () => {
		const scores = broker.reciprocalRankFusion([[candidate({ memoryId: "a" })]], 60);
		expect(scores.get("a")).toBeCloseTo(1 / 61);
	});

	it("accumulates across lists rather than producing NaN", () => {
		// Regression: the accumulator used `(a ?? 0) + map.get(id) ?? 0`, and `+`
		// binds tighter than `??`, so a first sighting produced NaN.
		const first = [candidate({ memoryId: "a" })];
		const second = [candidate({ memoryId: "b" }), candidate({ memoryId: "a" })];
		const scores = broker.reciprocalRankFusion([first, second], 60);
		const total = scores.get("a") ?? Number.NaN;
		expect(Number.isNaN(total)).toBe(false);
		expect(total).toBeCloseTo(1 / 61 + 1 / 62);
	});

	it("defaults k to the configured rank constant", () => {
		const scores = broker.reciprocalRankFusion([[candidate({ memoryId: "a" })]]);
		expect(scores.get("a")).toBeCloseTo(1 / (DEFAULT_TIERED_RETRIEVAL_CONFIG.rrfK + 1));
	});
});

describe("post-processing", () => {
	const broker = new TieredRetrievalBroker();

	it("does not mutate its inputs", () => {
		const input = candidate({ memoryId: "a", scopeScore: 0.123 });
		broker.postProcess([input], request());
		expect(input.finalScore).toBeUndefined();
		expect(input.scopeScore).toBe(0.123);
	});

	it("returns an empty list unchanged", () => {
		expect(broker.postProcess([], request())).toEqual([]);
	});

	it("zeroes candidates from another project", () => {
		const foreign = candidate({ memoryId: "a", scope: { projectId: "other" } });
		const [ranked] = broker.postProcess([foreign], request());
		expect(ranked?.finalScore).toBe(0);
	});

	it("ranks stronger provenance above weaker provenance", () => {
		const strong = candidate({ memoryId: "strong", verification: "user-confirmed" });
		const weak = candidate({ memoryId: "weak", verification: "episode-derived" });
		const ranked = broker.postProcess([weak, strong], request());
		expect(ranked[0]?.memoryId).toBe("strong");
	});
});

describe("broker registration", () => {
	it("registers, reads back, and unregisters adapters", () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", []));
		expect(broker.getRegisteredLanes()).toEqual(["canonical"]);
		expect(broker.getAdapter("canonical")?.id).toBe("canonical");

		broker.unregisterAdapter("canonical");
		expect(broker.getRegisteredLanes()).toEqual([]);
		expect(broker.getAdapter("canonical")).toBeUndefined();
	});
});

describe("broker retrieval", () => {
	it("fans out across registered lanes and fuses the results", async () => {
		const broker = new TieredRetrievalBroker();
		const local = candidate({ memoryId: "b", lane: "working-state" });
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })]));
		broker.registerAdapter(adapter("working-state", [local]));

		const result = await broker.retrieve(request({ requestedTiers: ["L0", "L1"] }), options());
		expect(result.candidates.map(item => item.memoryId).sort()).toEqual(["a", "b"]);
		expect(result.stats.totalCandidates).toBe(2);
	});

	it("actually applies the ranking pipeline", async () => {
		// Regression: `retrieve` used to return raw lane output because it never
		// called `postProcess`, leaving the whole fusion stage dead code.
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })]));

		const result = await broker.retrieve(request(), options());
		expect(result.candidates[0]?.finalScore).toBeGreaterThan(0);
		expect(result.candidates[0]?.fusedScore).toBeGreaterThan(0);
	});

	it("keeps a failing lane visible without failing the batch", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })]));
		broker.registerAdapter(adapter("working-state", [], { throws: "lane exploded" }));

		const result = await broker.retrieve(request({ requestedTiers: ["L0", "L1"] }), options());
		expect(result.candidates.map(item => item.memoryId)).toEqual(["a"]);
		expect(result.laneErrors["working-state"]).toBe("lane exploded");
		expect(result.lanesQueried).toContain("working-state");
	});

	it("times a slow lane out and records the deadline breach", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })], { delayMs: 80 }));

		const result = await broker.retrieve(request(), options({ deadlineMs: 10 }));
		expect(result.candidates).toEqual([]);
		expect(result.laneErrors.canonical).toContain("Lane timeout");
	});

	it("returns promptly when every lane is fast", async () => {
		// Regression: the deadline handle was never cleared, so a fast lane still
		// held the event loop open for the full `deadlineMs`.
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })]));

		const started = Date.now();
		await broker.retrieve(request(), options({ deadlineMs: 5_000 }));
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("reports a silent lane as queried with no candidates", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", []));

		const result = await broker.retrieve(request(), options());
		expect(result.lanesQueried).toContain("canonical");
		expect(result.laneLatencies.canonical).toBeGreaterThanOrEqual(0);
		expect(result.laneErrors.canonical).toBeUndefined();
	});

	it("honours the excluded memory list", async () => {
		const broker = new TieredRetrievalBroker();
		const items = [candidate({ memoryId: "a" }), candidate({ memoryId: "b" })];
		broker.registerAdapter(adapter("canonical", items));

		const result = await broker.retrieve(request({ excludeMemoryIds: ["a"] }), options());
		expect(result.candidates.map(item => item.memoryId)).toEqual(["b"]);
	});

	it("drops candidates below the confidence floor", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a", confidence: 0.1 })]));

		const result = await broker.retrieve(request(), options({ minConfidence: 0.5 }));
		expect(result.candidates).toEqual([]);
	});

	it("filters out tiers that were not requested", async () => {
		const broker = new TieredRetrievalBroker();
		const items = [candidate({ memoryId: "a" }), candidate({ memoryId: "deep", tier: "L4" })];
		broker.registerAdapter(adapter("canonical", items));

		const result = await broker.retrieve(request({ requestedTiers: ["L1"] }), options());
		expect(result.candidates.map(item => item.memoryId)).toEqual(["a"]);
	});

	it("applies the per-request total cap", async () => {
		const broker = new TieredRetrievalBroker();
		const items = [candidate({ memoryId: "a" }), candidate({ memoryId: "b" }), candidate({ memoryId: "c" })];
		broker.registerAdapter(adapter("canonical", items));

		const result = await broker.retrieve(request({ maximumTotalCandidates: 2 }), options());
		expect(result.candidates).toHaveLength(2);
	});

	it("counts results by lane and by tier", async () => {
		const broker = new TieredRetrievalBroker();
		const local = candidate({ memoryId: "b", lane: "working-state" });
		broker.registerAdapter(adapter("canonical", [candidate({ memoryId: "a" })]));
		broker.registerAdapter(adapter("working-state", [local]));

		const result = await broker.retrieve(request({ requestedTiers: ["L0", "L1"] }), options());
		expect(result.stats.byLane.canonical).toBe(1);
		expect(result.stats.byLane["working-state"]).toBe(1);
		expect(result.stats.byTier.L1).toBe(2);
	});

	it("reports a non-negative total time", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", []));

		const result = await broker.retrieve(request(), options());
		expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
	});
});

describe("broker health checks", () => {
	it("reports every registered lane", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter(adapter("canonical", []));

		const health = await broker.healthCheck();
		expect(health.canonical?.healthy).toBe(true);
	});

	it("reports a throwing lane as unhealthy instead of rejecting", async () => {
		const broker = new TieredRetrievalBroker();
		broker.registerAdapter({
			id: "graphify",
			name: "graphify",
			async retrieve() {
				return [];
			},
			async healthCheck(): Promise<never> {
				throw new Error("probe failed");
			},
		});

		const health = await broker.healthCheck();
		expect(health.graphify?.healthy).toBe(false);
		expect(health.graphify?.latencyMs).toBe(-1);
	});
});
