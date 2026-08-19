import { describe, expect, test } from "bun:test";
import { composeTaskSpawnPolicyResult, createSpawnPlan } from "../../src/task/spawn-plan";

describe("createSpawnPlan", () => {
	test("builds a frozen plan without invoking allocation callbacks", () => {
		let allocations = 0;
		const bump = () => {
			allocations += 1;
		};

		const result = createSpawnPlan({
			correlationId: "corr-1",
			agentName: "explore",
			assignment: "Find the login handler",
			modelPatterns: ["pi/smol", "pi/task"],
			softRequestBudget: 40,
			maxRuntimeMs: 30_000,
			onAllocateId: bump,
			onAllocateJob: bump,
			onAllocateWorktree: bump,
			onAllocateSession: bump,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(allocations).toBe(0);
		expect(Object.isFrozen(result.plan)).toBe(true);
		expect(Object.isFrozen(result.plan.eligible)).toBe(true);
		expect(result.plan.eligible.map(candidate => candidate.selector)).toEqual(["pi/smol", "pi/task"]);
		expect(result.plan.maxRequests).toBe(40);
		expect(result.plan.maxRuntimeMs).toBe(30_000);
	});

	test("invalid profile/model inputs produce diagnostics without allocation", () => {
		let allocations = 0;
		const bump = () => {
			allocations += 1;
		};

		const result = createSpawnPlan({
			correlationId: "",
			agentName: "",
			assignment: "",
			eligible: [{ selector: "", tier: "light", maxRequests: 10, maxRuntimeMs: 1000 }],
			profileInput: {
				override: { workClass: "judgment", tier: "light" },
				judgmentFloor: "reject",
			},
			onAllocateId: bump,
			onAllocateJob: bump,
			onAllocateWorktree: bump,
			onAllocateSession: bump,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(allocations).toBe(0);
		expect(result.diagnostics.some(diagnostic => diagnostic.code === "judgment-tier-floor")).toBe(true);
	});

	test("unavailable selectors are rejected without allocation", () => {
		let allocations = 0;
		const result = createSpawnPlan({
			correlationId: "corr-2",
			agentName: "task",
			assignment: "Implement feature",
			eligible: [
				{ selector: "pi/smol", tier: "light", maxRequests: 20, maxRuntimeMs: 0 },
				{ selector: "missing/model", tier: "mid", maxRequests: 20, maxRuntimeMs: 0 },
			],
			isSelectorAvailable: selector => selector === "pi/smol",
			onAllocateId: () => {
				allocations += 1;
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(allocations).toBe(0);
		expect(result.plan.eligible.map(candidate => candidate.selector)).toEqual(["pi/smol"]);
	});

	test("composeTaskSpawnPolicyResult intersects selectors and takes budget minima", () => {
		const planned = createSpawnPlan({
			correlationId: "corr-3",
			agentName: "task",
			assignment: "Classify difficulty",
			eligible: [
				{ selector: "pi/smol", tier: "light", maxRequests: 40, maxRuntimeMs: 60_000 },
				{ selector: "pi/task", tier: "mid", maxRequests: 40, maxRuntimeMs: 60_000 },
			],
		});
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;

		const composed = composeTaskSpawnPolicyResult(planned.plan, {
			allow: true,
			candidateSelectors: ["pi/task", "unknown/model"],
			maxRequests: 10,
			maxRuntimeMs: 5_000,
			routeLabel: "mid",
		});

		expect(composed.ok).toBe(false);
		if (composed.ok) return;
		expect(composed.diagnostics.some(diagnostic => diagnostic.code === "unknown-selector")).toBe(true);
	});

	test("composeTaskSpawnPolicyResult intersects known selectors and takes budget minima", () => {
		const planned = createSpawnPlan({
			correlationId: "corr-3b",
			agentName: "task",
			assignment: "Classify difficulty",
			eligible: [
				{ selector: "pi/smol", tier: "light", maxRequests: 40, maxRuntimeMs: 60_000 },
				{ selector: "pi/task", tier: "mid", maxRequests: 40, maxRuntimeMs: 60_000 },
			],
		});
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;

		const composed = composeTaskSpawnPolicyResult(planned.plan, {
			allow: true,
			candidateSelectors: ["pi/task"],
			maxRequests: 10,
			maxRuntimeMs: 5_000,
			routeLabel: "mid",
		});

		expect(composed.ok).toBe(true);
		if (!composed.ok) return;
		expect(composed.plan.eligible.map(candidate => candidate.selector)).toEqual(["pi/task"]);
		expect(composed.plan.maxRequests).toBe(10);
		expect(composed.plan.maxRuntimeMs).toBe(5_000);
	});

	test("createSpawnPlan revalidates supplied profiles against the judgment floor", () => {
		const result = createSpawnPlan({
			correlationId: "corr-profile",
			agentName: "task",
			assignment: "Judge carefully",
			eligible: [{ selector: "pi/task", tier: "light", maxRequests: 10, maxRuntimeMs: 0 }],
			profile: {
				tier: "light",
				autonomy: "independent",
				collaboration: "self-coordinate",
				workClass: "judgment",
				editMode: "hashline",
				maxRequests: 10,
				maxRuntimeMs: 0,
				modelPool: ["pi/task"],
				modelPoolConstrained: true,
			},
			profileInput: { judgmentFloor: "reject" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(diagnostic => diagnostic.code === "judgment-tier-floor")).toBe(true);
	});

	test("createSpawnPlan rejects empty eligibility", () => {
		const result = createSpawnPlan({
			correlationId: "corr-empty",
			agentName: "task",
			assignment: "No models",
			eligible: [],
			modelPatterns: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(diagnostic => diagnostic.code === "no-eligible-candidates")).toBe(true);
	});

	test("composeTaskSpawnPolicyResult keeps denial sticky", () => {
		const planned = createSpawnPlan({
			correlationId: "corr-4",
			agentName: "task",
			assignment: "Do work",
			eligible: [{ selector: "pi/task", tier: "mid", maxRequests: 20, maxRuntimeMs: 0 }],
		});
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;

		const denied = composeTaskSpawnPolicyResult(planned.plan, {
			allow: false,
			reasonCode: "router-denied",
		});
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.diagnostics[0]?.code).toBe("router-denied");
	});

	test("difficulty-profile routing intersects concrete candidateSelectors with a restricted model pool", () => {
		let allocations = 0;
		const bump = () => {
			allocations += 1;
		};

		const result = createSpawnPlan({
			correlationId: "corr-pool-overlap",
			agentName: "task",
			assignment: "Do the hard part",
			// Symbolic role token, exactly what resolveSubagentModelRouting hands
			// back for a difficulty route -- must NOT be exact-string-matched
			// against a concrete pool.
			modelPatterns: ["pi/slow"],
			modelRouting: {
				requestedDifficulty: "high",
				source: "difficulty-profile",
				role: "slow",
				candidateSelectors: ["anthropic/claude-other", "anthropic/claude-approved"],
			},
			profile: {
				tier: "frontier",
				autonomy: "independent",
				collaboration: "self-coordinate",
				workClass: "judgment",
				editMode: "hashline",
				maxRequests: 20,
				maxRuntimeMs: 0,
				modelPool: ["anthropic/claude-approved"],
				modelPoolConstrained: true,
			},
			onAllocateId: bump,
			onAllocateJob: bump,
			onAllocateWorktree: bump,
			onAllocateSession: bump,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(allocations).toBe(0);
		// Only the overlap survives -- the disjoint candidate never leaks in,
		// and the pool never silently substitutes an unrequested model.
		expect(result.plan.eligible.map(candidate => candidate.selector)).toEqual(["anthropic/claude-approved"]);
	});

	test("difficulty-profile routing fails preallocation when the restricted pool is fully disjoint", () => {
		let allocations = 0;
		const bump = () => {
			allocations += 1;
		};

		const result = createSpawnPlan({
			correlationId: "corr-pool-disjoint",
			agentName: "task",
			assignment: "Do the hard part",
			modelPatterns: ["pi/slow"],
			modelRouting: {
				requestedDifficulty: "high",
				source: "difficulty-profile",
				role: "slow",
				candidateSelectors: ["anthropic/claude-expensive"],
			},
			profile: {
				tier: "frontier",
				autonomy: "independent",
				collaboration: "self-coordinate",
				workClass: "judgment",
				editMode: "hashline",
				maxRequests: 20,
				maxRuntimeMs: 0,
				modelPool: ["cheap-provider/cheap-model"],
				modelPoolConstrained: true,
			},
			onAllocateId: bump,
			onAllocateJob: bump,
			onAllocateWorktree: bump,
			onAllocateSession: bump,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Never allocates before validation rejects the spawn, and never
		// silently substitutes a cheaper pool member for the requested one.
		expect(allocations).toBe(0);
		expect(result.diagnostics.some(diagnostic => diagnostic.code === "model-pool-disjoint")).toBe(true);
		expect(result.diagnostics.some(diagnostic => diagnostic.selector === "cheap-provider/cheap-model")).toBe(false);
	});
});
