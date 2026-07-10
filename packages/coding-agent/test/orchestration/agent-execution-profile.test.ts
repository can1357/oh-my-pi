import { describe, expect, test } from "bun:test";
import {
	JudgmentTierViolationError,
	composeAgentPolicyFields,
	resolveAgentExecutionProfile,
} from "../../src/orchestration/agent-execution-profile";

describe("resolveAgentExecutionProfile", () => {
	test("legacy/no-policy input preserves unrestricted defaults", () => {
		const profile = resolveAgentExecutionProfile();
		expect(profile.tier).toBe("frontier");
		expect(profile.autonomy).toBe("independent");
		expect(profile.collaboration).toBe("self-coordinate");
		expect(profile.workClass).toBe("mechanical");
		expect(profile.editMode).toBe("hashline");
		expect(profile.maxRequests).toBe(0);
		expect(profile.maxRuntimeMs).toBe(0);
	});

	test("tier and autonomy remain independent axes", () => {
		const lightIndependent = resolveAgentExecutionProfile({
			override: { tier: "light", autonomy: "independent" },
		});
		expect(lightIndependent.tier).toBe("light");
		expect(lightIndependent.autonomy).toBe("independent");

		const frontierBound = resolveAgentExecutionProfile({
			override: { tier: "frontier", autonomy: "bound" },
		});
		expect(frontierBound.tier).toBe("frontier");
		expect(frontierBound.autonomy).toBe("bound");
	});

	test("restrictive layers compose by intersection/minimum and never widen", () => {
		const profile = resolveAgentExecutionProfile({
			workflowPolicy: {
				tier: "frontier",
				autonomy: "independent",
				collaboration: "self-coordinate",
				editMode: "apply-patch",
				maxRequests: 90,
				maxRuntimeMs: 60_000,
				modelPool: ["pi/smol", "pi/task", "pi/slow"],
			},
			agentTypePolicy: {
				tier: "mid",
				autonomy: "supervised",
				collaboration: "message-peers",
				editMode: "hashline",
				maxRequests: 40,
				modelPool: ["pi/smol", "pi/task"],
			},
			agentIdPolicy: {
				tier: "light",
				maxRuntimeMs: 15_000,
				modelPool: ["pi/smol", "pi/slow"],
			},
		});

		expect(profile.tier).toBe("light");
		expect(profile.autonomy).toBe("supervised");
		expect(profile.collaboration).toBe("message-peers");
		expect(profile.editMode).toBe("hashline");
		expect(profile.maxRequests).toBe(40);
		expect(profile.maxRuntimeMs).toBe(15_000);
		expect(profile.modelPool).toEqual(["pi/smol"]);
	});

	test("judgment with light raises to mid by default", () => {
		const profile = resolveAgentExecutionProfile({
			override: { workClass: "judgment", tier: "light" },
		});
		expect(profile.workClass).toBe("judgment");
		expect(profile.tier).toBe("mid");
	});

	test("judgment with light rejects when judgmentFloor is reject", () => {
		expect(() =>
			resolveAgentExecutionProfile({
				override: { workClass: "judgment", tier: "light" },
				judgmentFloor: "reject",
			}),
		).toThrow(JudgmentTierViolationError);
	});

	test("resolved profile arrays cannot be mutated by callers", () => {
		const profile = resolveAgentExecutionProfile({
			override: { modelPool: ["pi/smol", "pi/task"] },
		});
		expect(Object.isFrozen(profile)).toBe(true);
		expect(Object.isFrozen(profile.modelPool)).toBe(true);
		expect(() => {
			(profile as { tier: string }).tier = "light";
		}).toThrow();
		expect(() => {
			(profile.modelPool as string[]).push("pi/slow");
		}).toThrow();
		expect(profile.modelPool).toEqual(["pi/smol", "pi/task"]);
	});

	test("agent-id policy takes precedence over agent-type and workflow layers for narrowing", () => {
		const profile = resolveAgentExecutionProfile({
			workflowPolicy: { autonomy: "independent" },
			agentTypePolicy: { autonomy: "supervised" },
			agentIdPolicy: { autonomy: "bound" },
		});
		expect(profile.autonomy).toBe("bound");
	});

	test("explicit empty modelPool remains restrictive", () => {
		const profile = resolveAgentExecutionProfile({
			workflowPolicy: { modelPool: ["pi/smol"] },
			agentIdPolicy: { modelPool: [] },
		});
		expect(profile.modelPool).toEqual([]);
		expect(profile.modelPoolConstrained).toBe(true);
	});

	test("composeAgentPolicyFields layers id/type/workflow without first-match-wins", () => {
		const composed = composeAgentPolicyFields({
			workflowPolicy: { autonomy: "independent", maxRequests: 9 },
			agentTypePolicy: { autonomy: "bound", maxRequests: 5 },
			agentIdPolicy: { tier: "light" },
		});
		expect(composed.tier).toBe("light");
		expect(composed.autonomy).toBe("bound");
		expect(composed.maxRequests).toBe(5);
	});

	test("invalid budgets are rejected", () => {
		expect(() =>
			resolveAgentExecutionProfile({
				override: { maxRequests: -1 },
			}),
		).toThrow(/Invalid maxRequests/);
		expect(() =>
			resolveAgentExecutionProfile({
				override: { maxRuntimeMs: Number.NaN },
			}),
		).toThrow(/Invalid maxRuntimeMs/);
	});

});
