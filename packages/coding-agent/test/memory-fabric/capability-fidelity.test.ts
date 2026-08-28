/**
 * Tests for fidelity tier mapping and the flag-only risk/health policy.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionCompleteBundle } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-bundle";
import { fidelityTiers, mapBundleToFidelity } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-fidelity";

function bundle(overrides: Partial<ExecutionCompleteBundle> = {}): ExecutionCompleteBundle {
	return {
		mode: "observe",
		seeds: ["seed"],
		included: ["seed"],
		prerequisites: [],
		validations: [],
		rollbacks: [],
		conflicts: [],
		missing: [],
		truncated: false,
		cycles: [],
		...overrides,
	};
}

describe("mapBundleToFidelity", () => {
	it("is inert when disabled", () => {
		const plan = mapBundleToFidelity(bundle());
		expect(plan.enabled).toBe(false);
		expect(plan.assignments).toEqual([]);
		expect(plan.riskFlags).toEqual([]);
	});

	it("assigns tiers per policy: rollback/conflicted L0, prerequisites L1, seeds/validations L2, rest L3", () => {
		const plan = mapBundleToFidelity(
			bundle({
				seeds: ["seed"],
				included: ["seed", "prereq", "validate", "rollback", "conflA", "conflB", "other"],
				prerequisites: ["prereq"],
				validations: ["validate"],
				rollbacks: ["rollback"],
				conflicts: [{ a: "conflA", b: "conflB" }],
			}),
			{ enabled: true },
		);
		const tierOf = new Map(plan.assignments.map(a => [a.id, a.tier]));
		expect(tierOf.get("rollback")).toBe("L0");
		expect(tierOf.get("conflA")).toBe("L0");
		expect(tierOf.get("conflB")).toBe("L0");
		expect(tierOf.get("prereq")).toBe("L1");
		expect(tierOf.get("seed")).toBe("L2");
		expect(tierOf.get("validate")).toBe("L2");
		expect(tierOf.get("other")).toBe("L3");
		expect(plan.byTier.L4).toEqual([]);
	});

	it("flags high risk and unhealthy capabilities without dropping them", () => {
		const plan = mapBundleToFidelity(bundle({ included: ["seed", "risky", "sick"], seeds: ["seed"] }), {
			enabled: true,
			risk: { risky: { risk: "high" }, sick: { health: "unhealthy" } },
		});
		expect(plan.recommendedExclusions.sort()).toEqual(["risky", "sick"]);
		// Nothing removed — assignments still cover every included id.
		expect(plan.assignments).toHaveLength(3);
		const flagged = plan.riskFlags.filter(f => f.recommendExclude).map(f => f.id);
		expect(flagged.sort()).toEqual(["risky", "sick"]);
	});

	it("skips flags when both risk and health are unknown, notes non-excluding signals", () => {
		const plan = mapBundleToFidelity(bundle({ included: ["seed", "meh"], seeds: ["seed"] }), {
			enabled: true,
			risk: { meh: { risk: "medium" } },
		});
		expect(plan.riskFlags).toHaveLength(1);
		expect(plan.riskFlags[0]).toMatchObject({ id: "meh", recommendExclude: false });
	});

	it("honors custom exclusion policies", () => {
		const plan = mapBundleToFidelity(bundle({ included: ["seed", "m"], seeds: ["seed"] }), {
			enabled: true,
			risk: { m: { risk: "medium", health: "degraded" } },
			excludeRisk: ["medium", "high"],
			excludeHealth: ["degraded", "unhealthy"],
		});
		expect(plan.recommendedExclusions).toEqual(["m"]);
		expect(plan.riskFlags[0].reason).toContain("risk=medium");
		expect(plan.riskFlags[0].reason).toContain("health=degraded");
	});
});

describe("fidelityTiers", () => {
	it("exposes the full tier vocabulary as a fresh copy", () => {
		const tiers = fidelityTiers();
		expect(tiers).toEqual(["L0", "L1", "L2", "L3", "L4"]);
		tiers.pop();
		expect(fidelityTiers()).toHaveLength(5);
	});
});
