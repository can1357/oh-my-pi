/**
 * Tests for progressive context packets (tiered L0-L4 composition).
 */

import { describe, expect, it } from "bun:test";
import type { ContextExpansionRequest } from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/types";
import type { PacketDescriptor } from "@oh-my-pi/pi-coding-agent/memory-fabric/progressive-context";
import {
	composePacketItems,
	computeContextUtilization,
	computeHarmRate,
	computeMemoryPrecision,
	computeMemoryRecall,
	computeTokenUtilization,
	createInitialPacket,
	estimateTokens,
	expandPacket,
	renderCompact,
	renderStandard,
	selectRepresentation,
	summarizePacket,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/progressive-context";
import type { RetrievedMemoryCandidate } from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-types";

function candidate(overrides?: Partial<RetrievedMemoryCandidate>): RetrievedMemoryCandidate {
	return {
		memoryId: "mem-1",
		lane: "canonical",
		tier: "L1",
		type: "decision",
		content: "Use tabs for indentation across the repository.",
		scope: { projectId: "proj-a" },
		scopeScore: 1,
		confidence: 0.8,
		freshness: 0.9,
		usefulness: 0.5,
		importance: 0.7,
		status: "active",
		verification: "user-confirmed",
		sourceReferences: ["src-1"],
		contentHash: "hash-1",
		tokenEstimate: 12,
		...overrides,
	};
}

const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");
const IDS = { packetId: "pkt-test", turnId: "turn-test" };

function initialPacket(candidates: RetrievedMemoryCandidate[], allocatedTokens = 1000): PacketDescriptor {
	return createInitialPacket(candidates, {
		scope: { projectId: "proj-a" },
		allocatedTokens,
		ids: IDS,
		now: () => FIXED_NOW,
	});
}

function expansionRequest(overrides?: Partial<ContextExpansionRequest>): ContextExpansionRequest {
	return {
		packetId: "pkt-test",
		turnId: "turn-test",
		trigger: "repeated-failure",
		requestedTiers: ["L2"],
		topics: ["debugging"],
		maximumAdditionalTokens: 500,
		reason: "two consecutive failures",
		...overrides,
	};
}

describe("estimateTokens", () => {
	it("estimates roughly four characters per token, rounding up", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
		expect(estimateTokens("")).toBe(0);
	});
});

describe("rendering", () => {
	it("compact marks user-confirmed records and truncates content", () => {
		const text = renderCompact(candidate({ content: "x".repeat(200) }));
		expect(text).toContain("[user-confirmed]");
		expect(text).toContain("x".repeat(80));
		expect(text).not.toContain("x".repeat(81));
	});

	it("standard reports the real status instead of hardcoding active", () => {
		const text = renderStandard(candidate({ status: "superseded", supersededBy: "mem-9" }));
		expect(text).toContain("superseded");
		expect(text).toContain("Superseded by: mem-9");
	});
});

describe("selectRepresentation", () => {
	const estimates = { compact: 10, standard: 40, expanded: 100 };

	it("chooses expanded only when it fits half the remaining budget", () => {
		expect(selectRepresentation(estimates, 200)).toBe("expanded");
		expect(selectRepresentation(estimates, 199)).toBe("standard");
	});

	it("falls back to compact and then to null", () => {
		expect(selectRepresentation(estimates, 20)).toBe("compact");
		expect(selectRepresentation(estimates, 5)).toBeNull();
	});
});

describe("composePacketItems", () => {
	it("admits only candidates in the requested tiers", () => {
		const items = composePacketItems(
			[candidate({ memoryId: "a", tier: "L1" }), candidate({ memoryId: "b", tier: "L4", contentHash: "hash-b" })],
			{ tiers: ["L0", "L1"], tokenBudget: 1000 },
		);
		expect(items).toHaveLength(1);
		expect(items[0].memoryId).toBe("a");
	});

	it("deduplicates by memory id and by content hash", () => {
		const items = composePacketItems(
			[
				candidate({ memoryId: "a", contentHash: "same" }),
				candidate({ memoryId: "a", contentHash: "other" }),
				candidate({ memoryId: "b", contentHash: "same" }),
			],
			{ tiers: ["L1"], tokenBudget: 1000 },
		);
		expect(items).toHaveLength(1);
	});

	it("respects exclusion sets from already-loaded items", () => {
		const items = composePacketItems([candidate({ memoryId: "a" })], {
			tiers: ["L1"],
			tokenBudget: 1000,
			excludeMemoryIds: new Set(["a"]),
		});
		expect(items).toHaveLength(0);
	});

	it("ranks by final score before filling the budget", () => {
		const items = composePacketItems(
			[
				candidate({ memoryId: "low", finalScore: 0.2, contentHash: "h-low" }),
				candidate({ memoryId: "high", finalScore: 0.9, contentHash: "h-high" }),
			],
			{ tiers: ["L1"], tokenBudget: 1000 },
		);
		expect(items[0].memoryId).toBe("high");
	});

	it("downgrades to compact under pressure and stops when the budget is spent", () => {
		const long = "y".repeat(4000);
		const items = composePacketItems(
			[
				candidate({ memoryId: "a", content: long, contentHash: "h-a", finalScore: 0.9 }),
				candidate({ memoryId: "b", content: long, contentHash: "h-b", finalScore: 0.8 }),
			],
			{ tiers: ["L1"], tokenBudget: 30 },
		);
		expect(items).toHaveLength(1);
		expect(items[0].memoryId).toBe("a");
		expect(items[0].representation).toBe("compact");
	});
});

describe("createInitialPacket", () => {
	it("loads only L0 and L1 tiers with deterministic ids", () => {
		const packet = initialPacket([
			candidate({ memoryId: "a", tier: "L0", type: "working-state", contentHash: "h-a" }),
			candidate({ memoryId: "b", tier: "L1", contentHash: "h-b" }),
			candidate({ memoryId: "c", tier: "L4", contentHash: "h-c" }),
		]);
		expect(packet.packetId).toBe("pkt-test");
		expect(packet.createdAt).toBe("2026-01-15T12:00:00.000Z");
		expect(packet.tiersLoaded).toEqual(["L0", "L1"]);
		expect(packet.items.map(i => i.memoryId)).toEqual(["a", "b"]);
	});

	it("carries the composition scope on the descriptor", () => {
		const packet = initialPacket([candidate()]);
		expect(packet.scope.projectId).toBe("proj-a");
	});

	it("tracks used and remaining tokens against the full allocation", () => {
		const packet = initialPacket([candidate()], 1000);
		expect(packet.usedTokens).toBeGreaterThan(0);
		expect(packet.remainingTokens).toBe(1000 - packet.usedTokens);
	});

	it("caps the initial fill at the initial allocation, not the full budget", () => {
		const long = "z".repeat(12000);
		const packet = createInitialPacket(
			[
				candidate({ memoryId: "a", content: long, contentHash: "h-a" }),
				candidate({ memoryId: "b", content: long, contentHash: "h-b" }),
			],
			{
				scope: { projectId: "proj-a" },
				allocatedTokens: 100000,
				config: { initialAllocationTokens: 2000 },
				ids: IDS,
				now: () => FIXED_NOW,
			},
		);
		expect(packet.usedTokens).toBeLessThanOrEqual(2000);
	});
});

describe("expandPacket", () => {
	it("adds new-tier items and records the expansion", () => {
		const packet = initialPacket([candidate()]);
		const expanded = expandPacket(packet, expansionRequest(), [
			candidate({ memoryId: "proc-1", tier: "L2", type: "procedure", contentHash: "h-p" }),
		]);
		expect(expanded).toBeDefined();
		expect(expanded?.tiersLoaded).toEqual(["L0", "L1", "L2"]);
		expect(expanded?.expansionsApplied).toHaveLength(1);
		expect(expanded?.items.map(i => i.memoryId)).toContain("proc-1");
	});

	it("never re-admits already loaded memories or duplicate content", () => {
		const packet = initialPacket([candidate({ memoryId: "a", contentHash: "same" })]);
		const expanded = expandPacket(packet, expansionRequest(), [
			candidate({ memoryId: "a", tier: "L2", contentHash: "fresh" }),
			candidate({ memoryId: "dup", tier: "L2", contentHash: "same" }),
		]);
		expect(expanded).toBeNull();
	});

	it("returns null once the expansion limit is reached", () => {
		const packet: PacketDescriptor = { ...initialPacket([candidate()]), maxExpansions: 0 };
		expect(expandPacket(packet, expansionRequest(), [candidate({ memoryId: "x", tier: "L2" })])).toBeNull();
	});

	it("returns null when the remaining budget is exhausted", () => {
		const base = initialPacket([candidate()]);
		const packet: PacketDescriptor = { ...base, remainingTokens: 0 };
		expect(expandPacket(packet, expansionRequest(), [candidate({ memoryId: "x", tier: "L2" })])).toBeNull();
	});

	it("returns null when the step would be smaller than the minimum", () => {
		const packet = initialPacket([candidate()]);
		const request = expansionRequest({ maximumAdditionalTokens: 50 });
		expect(expandPacket(packet, request, [candidate({ memoryId: "x", tier: "L2" })])).toBeNull();
	});

	it("preserves the original scope so expansions cannot leak projects", () => {
		const packet = initialPacket([candidate()]);
		const expanded = expandPacket(packet, expansionRequest(), [
			candidate({ memoryId: "p", tier: "L2", contentHash: "h-p2" }),
		]);
		expect(expanded?.scope.projectId).toBe("proj-a");
	});
});

describe("summarizePacket", () => {
	it("reports items, tiers, tokens, and expansion count", () => {
		const summary = summarizePacket(initialPacket([candidate()]));
		expect(summary).toContain("pkt-test");
		expect(summary).toContain("tiers=[L0,L1]");
		expect(summary).toContain("expansions=0");
	});
});

describe("metric calculators", () => {
	it("computes precision and guards the zero denominator", () => {
		expect(computeMemoryPrecision(3, 4).precision).toBeCloseTo(0.75);
		expect(computeMemoryPrecision(0, 0).precision).toBe(0);
	});

	it("computes recall and guards the zero denominator", () => {
		expect(computeMemoryRecall(2, 8).recall).toBeCloseTo(0.25);
		expect(computeMemoryRecall(0, 0).recall).toBe(0);
	});

	it("clamps context utilization to one", () => {
		expect(computeContextUtilization(1500, 1000).utilization).toBe(1);
		expect(computeContextUtilization(0, 0).utilization).toBe(0);
	});

	it("computes token utilization across memory and non-memory tokens", () => {
		expect(computeTokenUtilization(300, 700).tokenUtilization).toBeCloseTo(0.3);
		expect(computeTokenUtilization(0, 0).tokenUtilization).toBe(0);
	});

	it("computes harm rate as a true ratio, not a binary flag", () => {
		expect(computeHarmRate(1, 4).harmRate).toBeCloseTo(0.25);
		expect(computeHarmRate(0, 0).harmRate).toBe(0);
	});
});
