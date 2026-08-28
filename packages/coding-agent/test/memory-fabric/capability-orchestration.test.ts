/**
 * Tests for the capability orchestration core: registry, matching, planning.
 */

import { describe, expect, it } from "bun:test";
import type { CapabilityDescriptor } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-orchestration";
import { CapabilityCache, CapabilityPlanner } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-orchestration";

function descriptor(overrides: Partial<CapabilityDescriptor> & { id: string }): CapabilityDescriptor {
	return {
		kind: "tool",
		name: overrides.id,
		description: "",
		tags: [],
		version: 1,
		enabled: true,
		...overrides,
	};
}

describe("CapabilityCache", () => {
	it("registers and retrieves enabled capabilities only", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "a" }));
		cache.registerCapability(descriptor({ id: "b", enabled: false }));
		expect(cache.getCapability("a")?.id).toBe("a");
		expect(cache.getCapability("b")).toBeNull();
		expect(cache.getCapability("missing")).toBeNull();
	});

	it("bumps version on re-registration and normalizes bad declared versions", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "a", version: Number.NaN }));
		expect(cache.getCapability("a")?.version).toBe(1);
		cache.registerCapability(descriptor({ id: "a", version: 99 }));
		expect(cache.getCapability("a")?.version).toBe(2);
	});

	it("ranks matches by raw score so display rounding never reorders", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "hi", name: "alpha beta gamma", description: "delta epsilon zeta" }));
		cache.registerCapability(descriptor({ id: "lo", name: "alpha", description: "" }));
		const matches = cache.matchCapabilities("alpha beta gamma delta epsilon zeta");
		expect(matches[0].descriptor.id).toBe("hi");
		expect(matches[0].matchScore).toBe(1);
		expect(matches[1].matchScore).toBeLessThan(1);
	});

	it("respects kind filter and limit", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "t1", kind: "tool", name: "search files" }));
		cache.registerCapability(descriptor({ id: "s1", kind: "skill", name: "search notes" }));
		const tools = cache.matchCapabilities("search", { kind: "tool" });
		expect(tools.map(m => m.descriptor.id)).toEqual(["t1"]);
		cache.registerCapability(descriptor({ id: "t2", kind: "tool", name: "search web" }));
		expect(cache.matchCapabilities("search", { limit: 1 })).toHaveLength(1);
	});

	it("resolveCapabilitiesFailOpen falls back on zero hits", () => {
		const cache = new CapabilityCache();
		const fallback = [descriptor({ id: "fb" })];
		expect(cache.resolveCapabilitiesFailOpen("nothing matches", fallback)).toEqual(fallback);
	});

	it("invalidate removes one id or clears everything, bumping cache version", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "a" }));
		cache.registerCapability(descriptor({ id: "b" }));
		const v = cache.getCacheVersion();
		cache.invalidate("a");
		expect(cache.getCapability("a")).toBeNull();
		expect(cache.getCapability("b")?.id).toBe("b");
		cache.invalidate();
		expect(cache.listCapabilities()).toHaveLength(0);
		expect(cache.getCacheVersion()).toBe(v + 2);
	});
});

describe("CapabilityPlanner", () => {
	function plannerWith(...descs: CapabilityDescriptor[]): CapabilityPlanner {
		const cache = new CapabilityCache();
		for (const d of descs) cache.registerCapability(d);
		return new CapabilityPlanner(cache);
	}

	it("builds deterministic monotonic plan ids by default", () => {
		const planner = plannerWith(descriptor({ id: "a", name: "run tests" }));
		expect(planner.createExecutionPlan("run tests").planId).toBe("plan-1");
		expect(planner.createExecutionPlan("run tests").planId).toBe("plan-2");
	});

	it("returns an empty plan when rollout mode is off", () => {
		const planner = plannerWith(descriptor({ id: "a", name: "run tests" }));
		planner.setRolloutMode("off");
		const plan = planner.createExecutionPlan("run tests");
		expect(plan.steps).toHaveLength(0);
		expect(plan.rolloutMode).toBe("off");
	});

	it("marks approval-required steps and only auto-approves them in autonomous mode", () => {
		const planner = plannerWith(descriptor({ id: "risky", name: "deploy prod", requiresApproval: true }));
		const plan = planner.createExecutionPlan("deploy prod");
		expect(plan.steps[0].approvalRequired).toBe(true);

		const activeDecisions = planner.evaluatePlan(plan);
		expect(activeDecisions[0].approved).toBe(false);

		planner.setRolloutMode("autonomous");
		const autoDecisions = planner.evaluatePlan(plan);
		expect(autoDecisions[0].approved).toBe(true);
	});

	it("evaluatePlan reports every step unapproved in suggest mode", () => {
		const planner = plannerWith(descriptor({ id: "safe", name: "list files" }));
		planner.setRolloutMode("suggest");
		const plan = planner.createExecutionPlan("list files");
		const decisions = planner.evaluatePlan(plan);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].approved).toBe(false);
		expect(decisions[0].reason).toContain("suggest");
	});

	it("uses the injected clock for telemetry timestamps", () => {
		const cache = new CapabilityCache();
		cache.registerCapability(descriptor({ id: "a", name: "run tests" }));
		const planner = new CapabilityPlanner(cache, { nowIso: () => "2026-02-01T00:00:00.000Z" });
		planner.createExecutionPlan("run tests");
		const events = planner.getTelemetry();
		expect(events).toHaveLength(1);
		expect(events[0].timestamp).toBe("2026-02-01T00:00:00.000Z");
		expect(events[0].type).toBe("plan_created");
	});
});
