import { describe, expect, it } from "bun:test";
import {
	auditReasoningPlan,
	computeReasoningPlanDigest,
	computeTaskContractDigest,
	isPlanCurrentForContract,
	parseReasoningPlan,
	REASONING_PLAN_VERSION,
} from "../../src/orchestration/reasoning-plan";
import type { TaskContractV1 } from "../../src/orchestration/task-contract";
import { TASK_CONTRACT_VERSION } from "../../src/orchestration/task-contract";

function makeContract(overrides?: Partial<TaskContractV1>): TaskContractV1 {
	return Object.freeze({
		version: TASK_CONTRACT_VERSION,
		objective: "Build a thing",
		deliverables: ["D1"],
		completionCriteria: [{ id: "C1", description: "thing works" }],
		nonSolutions: [],
		knownFailureModes: [],
		evidenceRequirements: [],
		constraints: [],
		assumptions: [],
		verificationPolicy: { requireTargetedChecks: true, allowNarrativeOnly: false },
		orchestrationPolicy: { preferIndependence: true },
		...overrides,
	});
}

function makeMinimalPlan(overrides?: Record<string, unknown>): unknown {
	const contract = makeContract();
	const digest = computeTaskContractDigest(contract);
	return {
		id: "plan-1",
		version: REASONING_PLAN_VERSION,
		taskContractId: "contract-1",
		taskContractDigest: digest,
		taskProfile: {
			taskClass: "implementation",
			complexity: "moderate",
			uncertainty: 0.4,
			consequence: "medium",
			expectedHorizon: "multi_step",
		},
		selectedModules: [
			{
				instanceId: "m1",
				moduleId: "implementation",
				version: "1.0",
				purpose: "implement the thing",
				reasonSelected: "primary deliverable",
				workerMode: "implement",
				contextPolicy: "shared",
				inputs: [],
				expectedOutputs: ["D1"],
				criteriaSupported: ["C1"],
				evidenceRequired: ["test output"],
				dependencies: [],
				stopConditions: [],
				estimatedCost: "medium",
				estimatedValue: "high",
			},
		],
		dependencyEdges: [],
		executionPolicy: {
			orchestrationMode: "single_specialist",
			schedulingPolicy: "critical_path",
			maxConcurrentWorkers: 1,
			maxRounds: 3,
			maxSameBlockerRetries: 1,
		},
		verificationPlan: {
			criterionIds: ["C1"],
			requiredAudits: [],
			requireFreshContextVerifier: false,
		},
		stopConditions: [{ type: "criteria_satisfied", description: "C1 verified" }],
		...overrides,
	};
}

describe("parseReasoningPlan", () => {
	it("parses a valid minimal plan and computes digest", () => {
		const result = parseReasoningPlan(makeMinimalPlan());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.version).toBe(REASONING_PLAN_VERSION);
		expect(result.plan.id).toBe("plan-1");
		expect(result.plan.selectedModules).toHaveLength(1);
		expect(result.plan.digest).toBeString();
		expect(result.plan.digest.length).toBe(64);
	});

	it("rejects a non-object input", () => {
		const result = parseReasoningPlan("not an object");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0].code).toBe("invalid_type");
	});

	it("rejects wrong version", () => {
		const result = parseReasoningPlan(makeMinimalPlan({ version: "wrong/v1" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "invalid_version")).toBe(true);
	});

	it("rejects missing taskContractId", () => {
		const result = parseReasoningPlan(makeMinimalPlan({ taskContractId: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects missing taskContractDigest", () => {
		const result = parseReasoningPlan(makeMinimalPlan({ taskContractDigest: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects selectedModules empty array", () => {
		const result = parseReasoningPlan(makeMinimalPlan({ selectedModules: [] }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "empty_value")).toBe(true);
	});

	it("rejects invalid workerMode in a module", () => {
		const plan = makeMinimalPlan() as Record<string, unknown>;
		const modules = [...(plan.selectedModules as unknown[])];
		(modules[0] as Record<string, unknown>).workerMode = "teleport";
		const result = parseReasoningPlan({ ...plan, selectedModules: modules });
		expect(result.ok).toBe(false);
	});

	it("rejects invalid contextPolicy in a module", () => {
		const plan = makeMinimalPlan() as Record<string, unknown>;
		const modules = [...(plan.selectedModules as unknown[])];
		(modules[0] as Record<string, unknown>).contextPolicy = "hidden";
		const result = parseReasoningPlan({ ...plan, selectedModules: modules });
		expect(result.ok).toBe(false);
	});

	it("rejects a supplied digest that does not match computed", () => {
		const result = parseReasoningPlan(makeMinimalPlan({ digest: "deadbeef".repeat(8) }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0].code).toBe("digest_mismatch");
	});

	it("accepts a supplied digest that matches computed", () => {
		const raw = makeMinimalPlan() as Record<string, unknown>;
		const first = parseReasoningPlan(raw);
		if (!first.ok) throw new Error("setup failed");
		const result = parseReasoningPlan({ ...raw, digest: first.plan.digest });
		expect(result.ok).toBe(true);
	});

	it("digest is stable across two parses of the same input", () => {
		const first = parseReasoningPlan(makeMinimalPlan());
		const second = parseReasoningPlan(makeMinimalPlan());
		if (!first.ok || !second.ok) throw new Error("setup failed");
		expect(first.plan.digest).toBe(second.plan.digest);
	});

	it("digest changes when moduleId changes", () => {
		const raw = makeMinimalPlan() as Record<string, unknown>;
		const modules = [...(raw.selectedModules as unknown[])];
		const modified = { ...(modules[0] as Record<string, unknown>), moduleId: "source-discovery" };
		const alt = parseReasoningPlan({ ...raw, selectedModules: [modified] });
		const base = parseReasoningPlan(makeMinimalPlan());
		if (!base.ok || !alt.ok) throw new Error("setup failed");
		expect(base.plan.digest).not.toBe(alt.plan.digest);
	});
});

describe("auditReasoningPlan", () => {
	it("returns no findings for a valid plan", () => {
		const result = parseReasoningPlan(makeMinimalPlan());
		if (!result.ok) throw new Error("setup failed");
		const findings = auditReasoningPlan(result.plan);
		expect(findings.filter(f => f.severity === "blocking")).toHaveLength(0);
	});

	it("blocks on duplicate instanceId", () => {
		const raw = makeMinimalPlan() as Record<string, unknown>;
		const m = (raw.selectedModules as unknown[])[0];
		const result = parseReasoningPlan({ ...raw, selectedModules: [m, m] });
		if (!result.ok) throw new Error("setup failed");
		const findings = auditReasoningPlan(result.plan);
		expect(findings.some(f => f.severity === "blocking" && f.code === "duplicate_instance_id")).toBe(true);
	});

	it("blocks on unknown dependency source", () => {
		const raw = makeMinimalPlan({
			dependencyEdges: [{ fromModuleInstanceId: "does-not-exist", toModuleInstanceId: "m1", kind: "requires" }],
		}) as Record<string, unknown>;
		const result = parseReasoningPlan(raw);
		if (!result.ok) throw new Error("setup failed");
		const findings = auditReasoningPlan(result.plan);
		expect(findings.some(f => f.code === "unknown_dependency_source")).toBe(true);
	});

	it("warns when complex plan has no falsifier or auditor", () => {
		const raw = makeMinimalPlan({
			taskProfile: {
				taskClass: "system-design",
				complexity: "complex",
				uncertainty: 0.7,
				consequence: "high",
				expectedHorizon: "long_horizon",
			},
		});
		const result = parseReasoningPlan(raw);
		if (!result.ok) throw new Error("setup failed");
		const findings = auditReasoningPlan(result.plan);
		expect(findings.some(f => f.severity === "warning" && f.code === "no_independent_verification")).toBe(true);
	});

	it("does not warn about missing verifier for simple plan", () => {
		const raw = makeMinimalPlan({
			taskProfile: {
				taskClass: "bugfix",
				complexity: "simple",
				uncertainty: 0.2,
				consequence: "low",
				expectedHorizon: "single_step",
			},
		});
		const result = parseReasoningPlan(raw);
		if (!result.ok) throw new Error("setup failed");
		const findings = auditReasoningPlan(result.plan);
		expect(findings.some(f => f.code === "no_independent_verification")).toBe(false);
	});
});

describe("isPlanCurrentForContract", () => {
	it("returns true when plan digest matches contract", () => {
		const contract = makeContract();
		const digest = computeTaskContractDigest(contract);
		const result = parseReasoningPlan(makeMinimalPlan({ taskContractDigest: digest }));
		if (!result.ok) throw new Error("setup failed");
		expect(isPlanCurrentForContract(result.plan, contract)).toBe(true);
	});

	it("returns false when contract changes", () => {
		const contract = makeContract();
		const digest = computeTaskContractDigest(contract);
		const result = parseReasoningPlan(makeMinimalPlan({ taskContractDigest: digest }));
		if (!result.ok) throw new Error("setup failed");
		const changedContract = makeContract({ objective: "Do something completely different" });
		expect(isPlanCurrentForContract(result.plan, changedContract)).toBe(false);
	});

	it("computeReasoningPlanDigest is stable", () => {
		const result = parseReasoningPlan(makeMinimalPlan());
		if (!result.ok) throw new Error("setup failed");
		const { digest: _, ...rest } = result.plan;
		expect(computeReasoningPlanDigest(rest)).toBe(result.plan.digest);
	});
});
