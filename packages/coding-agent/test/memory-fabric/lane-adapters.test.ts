import { describe, expect, it } from "bun:test";

import {
	CanonicalLaneAdapter,
	type CanonicalRecordLike,
	fnv1a32,
	GraphifyLaneAdapter,
	inferCanonicalTier,
	MemPalaceLaneAdapter,
	MemvidLaneAdapter,
	WorkingStateLaneAdapter,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/lane-adapters";
import type {
	TieredRetrievalOptions,
	TieredRetrievalRequest,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-types";

function request(overrides: Partial<TieredRetrievalRequest> = {}): TieredRetrievalRequest {
	return {
		query: "how do we retry",
		taskType: "normal",
		scope: { projectId: "proj-1" },
		entities: { files: [], symbols: [], errors: [], taskNames: [], commands: [] },
		requestedTiers: ["L0", "L1", "L2"],
		...overrides,
	};
}

function options(overrides: Partial<TieredRetrievalOptions> = {}): TieredRetrievalOptions {
	return {
		maximumCandidatesPerLane: 30,
		deadlineMs: 250,
		minConfidence: 0,
		includeProvisional: false,
		maxSensitivity: "project",
		...overrides,
	};
}

function record(overrides: Partial<CanonicalRecordLike> = {}): CanonicalRecordLike {
	return {
		id: "rec-1",
		type: "fact",
		content: "retry limit is 3",
		scope: { projectId: "proj-1" },
		confidence: 0.9,
		importance: 0.7,
		status: "active",
		verification: "user-confirmed",
		sourceReferences: ["file:src/retry.ts"],
		contentHash: "h1",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("lane-adapters", () => {
	it("hashes deterministically", () => {
		expect(fnv1a32("abc")).toBe(fnv1a32("abc"));
		expect(fnv1a32("abc")).not.toBe(fnv1a32("abd"));
		expect(fnv1a32("abc")).toMatch(/^[0-9a-f]{8}$/);
	});

	it("projects working state into tiered candidates with stable ids", async () => {
		const adapter = new WorkingStateLaneAdapter({
			getCurrent: async () => ({
				objective: "ship the retry fix",
				currentStep: "write tests",
				constraints: ["never touch main"],
				unresolvedErrors: ["ECONNRESET in fetch"],
			}),
		});
		const first = await adapter.retrieve(request(), options());
		const second = await adapter.retrieve(request(), options());
		expect(first.map(c => c.tier)).toEqual(["L0", "L0", "L1", "L2"]);
		expect(first.map(c => c.memoryId)).toEqual(second.map(c => c.memoryId));
		expect(first[0]?.scope.projectId).toBe("proj-1");
		expect(first[0]?.contentHash).toMatch(/^[0-9a-f]{8}$/);
	});

	it("returns nothing when there is no working state", async () => {
		const adapter = new WorkingStateLaneAdapter({ getCurrent: async () => undefined });
		expect(await adapter.retrieve(request(), options())).toEqual([]);
	});

	it("filters provisional canonical records unless included", async () => {
		const store = {
			getRecordsByScope: () => [record({ id: "a" }), record({ id: "b", verification: "model-proposed" as const })],
		};
		const adapter = new CanonicalLaneAdapter(store);
		const excluded = await adapter.retrieve(request(), options());
		expect(excluded.map(c => c.memoryId)).toEqual(["a"]);
		const included = await adapter.retrieve(request(), options({ includeProvisional: true }));
		expect(included.map(c => c.memoryId)).toEqual(["a", "b"]);
	});

	it("computes freshness with an injected clock", async () => {
		const dayMs = 24 * 60 * 60 * 1000;
		const created = Date.parse("2026-01-01T00:00:00Z");
		const adapter = new CanonicalLaneAdapter(
			{ getRecordsByScope: () => [record()] },
			{ now: () => created + 45 * dayMs },
		);
		const [candidate] = await adapter.retrieve(request(), options());
		expect(candidate?.freshness).toBeCloseTo(0.5, 5);
	});

	it("infers canonical tiers with lifecycle taking precedence", () => {
		expect(inferCanonicalTier({ type: "fact", status: "superseded" })).toBe("L4");
		expect(inferCanonicalTier({ type: "evidence", status: "active" })).toBe("L3");
		expect(inferCanonicalTier({ type: "episode", status: "active" })).toBe("L4");
		expect(inferCanonicalTier({ type: "working-state", status: "active" })).toBe("L0");
		expect(inferCanonicalTier({ type: "decision", status: "active" })).toBe("L1");
		expect(inferCanonicalTier({ type: "failure", status: "active" })).toBe("L2");
	});

	it("skips memvid unless L4 or history is requested, then maps results", async () => {
		let calls = 0;
		const adapter = new MemvidLaneAdapter({
			recall: async () => {
				calls++;
				return [
					{ id: "mv1", content: "stack trace evidence", type: "evidence" },
					{ id: "mv2", content: "", type: "episode" },
				];
			},
		});
		expect(await adapter.retrieve(request(), options())).toEqual([]);
		expect(calls).toBe(0);
		const results = await adapter.retrieve(request({ requestedTiers: ["L4"] }), options());
		expect(calls).toBe(1);
		expect(results.map(c => c.memoryId)).toEqual(["mv1"]);
		expect(results[0]?.tier).toBe("L3");
	});

	it("deduplicates mutual graph edges by direction-normalised id", async () => {
		const adapter = new GraphifyLaneAdapter({
			findCallers: async () => [],
			findCallees: async () => [],
			findDependencies: async (file: string) => (file === "a.ts" ? ["b.ts"] : ["a.ts"]),
			findDependents: async (file: string) => (file === "a.ts" ? ["b.ts"] : ["a.ts"]),
		});
		const results = await adapter.retrieve(request({ files: ["a.ts", "b.ts"], requestedTiers: ["L3"] }), options());
		expect(results).toHaveLength(2);
		const subjects = results.map(c => c.subject).sort();
		expect(subjects).toEqual(["dependency: a.ts -> b.ts", "dependency: b.ts -> a.ts"]);
	});

	it("maps call edges for requested symbols", async () => {
		const adapter = new GraphifyLaneAdapter({
			findCallers: async () => ["main"],
			findCallees: async () => ["log"],
			findDependencies: async () => [],
			findDependents: async () => [],
		});
		const results = await adapter.retrieve(request({ symbols: ["retry"], requestedTiers: ["L3"] }), options());
		expect(results.map(c => c.content).sort()).toEqual(["main calls retry", "retry calls log"]);
		expect(results.every(c => c.tier === "L3")).toBe(true);
	});

	it("enforces the confidence floor and per-lane cap uniformly", async () => {
		const store = {
			getRecordsByScope: () => [
				record({ id: "hi", confidence: 0.9 }),
				record({ id: "lo", confidence: 0.1 }),
				record({ id: "mid", confidence: 0.6 }),
			],
		};
		const adapter = new CanonicalLaneAdapter(store);
		const results = await adapter.retrieve(request(), options({ minConfidence: 0.5, maximumCandidatesPerLane: 1 }));
		expect(results.map(c => c.memoryId)).toEqual(["hi"]);
	});

	it("recalls mempalace episodes only for historical requests", async () => {
		const adapter = new MemPalaceLaneAdapter({
			recallEpisode: async () => [{ episodeId: "ep1", content: "we fixed this before", timestamp: "2026-01-01" }],
		});
		expect(await adapter.retrieve(request(), options())).toEqual([]);
		const results = await adapter.retrieve(request({ includeHistorical: true }), options());
		expect(results[0]?.memoryId).toBe("ep1");
		expect(results[0]?.tier).toBe("L4");
		expect(results[0]?.verification).toBe("episode-derived");
	});

	it("reports lane health from the probe outcome", async () => {
		const healthy = new WorkingStateLaneAdapter({ getCurrent: async () => undefined }, { now: () => 100 });
		expect((await healthy.healthCheck()).healthy).toBe(true);
		const failing = new WorkingStateLaneAdapter(
			{
				getCurrent: async () => {
					throw new Error("down");
				},
			},
			{ now: () => 100 },
		);
		const result = await failing.healthCheck();
		expect(result.healthy).toBe(false);
		expect(result.latencyMs).toBe(0);
	});
});
