/**
 * Tests for the capability approval policy and its planner gate.
 */

import { describe, expect, it } from "bun:test";
import type { GateContext } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-planner-adapter";
import type { PolicyCapability } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-policy";
import {
	createWriteApprovalGate,
	evaluateCapabilityApproval,
	formatUserConflictQuestion,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-policy";

const ctx = (overrides: Partial<GateContext> = {}): GateContext => ({
	tier: null,
	rank: 0,
	score: 0,
	riskFlagged: false,
	recommendedExclusion: false,
	...overrides,
});

describe("evaluateCapabilityApproval", () => {
	it("auto-allows read-only capabilities", () => {
		const result = evaluateCapabilityApproval({ id: "read", mutability: "read-only", risk: "low" });
		expect(result.decision).toBe("allow");
		expect(result.requiresApproval).toBe(false);
	});

	it("fails safe on unknown input: defaults to workspace-write/medium → needs approval", () => {
		const result = evaluateCapabilityApproval({});
		expect(result.capabilityId).toBe("unknown");
		expect(result.decision).toBe("needs-approval");
	});

	it("destructive and external-write ALWAYS require approval — even when pre-authorized", () => {
		for (const mutability of ["destructive", "external-write"] as const) {
			const result = evaluateCapabilityApproval(
				{ id: "danger", mutability, risk: "low" },
				{ preAuthorizedIds: ["danger"], allowedWriteScope: "external-write" },
			);
			expect(result.decision).toBe("needs-approval");
			expect(result.requiresApproval).toBe(true);
		}
	});

	it("critical risk ALWAYS requires approval — no override flag unlocks it", () => {
		const result = evaluateCapabilityApproval(
			{ id: "crit", mutability: "read-only", risk: "critical" },
			{ allowHighRiskWithoutApproval: true, preAuthorizedIds: ["crit"] },
		);
		expect(result.decision).toBe("needs-approval");
	});

	it("high risk requires approval unless explicitly overridden", () => {
		const node: PolicyCapability = { id: "hot", mutability: "read-only", risk: "high" };
		expect(evaluateCapabilityApproval(node).decision).toBe("needs-approval");
		expect(evaluateCapabilityApproval(node, { allowHighRiskWithoutApproval: true }).decision).toBe("allow");
	});

	it("pre-authorization allows a workspace-write under read-only scope", () => {
		const node: PolicyCapability = { id: "ws", mutability: "workspace-write", risk: "medium" };
		expect(evaluateCapabilityApproval(node).decision).toBe("needs-approval");
		expect(evaluateCapabilityApproval(node, { preAuthorizedIds: new Set(["ws"]) }).decision).toBe("allow");
		expect(evaluateCapabilityApproval(node, { preAuthorizedIds: ["ws"] }).decision).toBe("allow");
	});

	it("workspace-write is allowed by a workspace-write (or wider) session scope", () => {
		const node: PolicyCapability = { id: "ws", mutability: "workspace-write", risk: "low" };
		expect(evaluateCapabilityApproval(node, { allowedWriteScope: "workspace-write" }).decision).toBe("allow");
		expect(evaluateCapabilityApproval(node, { allowedWriteScope: "external-write" }).decision).toBe("allow");
		expect(evaluateCapabilityApproval(node, { allowedWriteScope: "read-only" }).decision).toBe("needs-approval");
	});
});

describe("createWriteApprovalGate", () => {
	const nodes = new Map<string, PolicyCapability>([
		["reader", { id: "reader", mutability: "read-only", risk: "low" }],
		["writer", { id: "writer", mutability: "workspace-write", risk: "medium" }],
	]);

	it("denies recommended exclusions and pauses risk-flagged capabilities", () => {
		const gate = createWriteApprovalGate(nodes);
		expect(gate("reader", ctx({ recommendedExclusion: true })).decision).toBe("deny");
		expect(gate("reader", ctx({ riskFlagged: true })).decision).toBe("needs-approval");
	});

	it("delegates clean capabilities to the policy", () => {
		const gate = createWriteApprovalGate(nodes);
		expect(gate("reader", ctx()).decision).toBe("allow");
		expect(gate("writer", ctx()).decision).toBe("needs-approval");
		expect(createWriteApprovalGate(nodes, { allowedWriteScope: "workspace-write" })("writer", ctx()).decision).toBe(
			"allow",
		);
	});

	it("treats unknown capabilities fail-safe (needs approval)", () => {
		const gate = createWriteApprovalGate(nodes);
		expect(gate("ghost", ctx()).decision).toBe("needs-approval");
	});
});

describe("formatUserConflictQuestion", () => {
	it("formats a two-option question and never picks a side", () => {
		const q = formatUserConflictQuestion({ a: "alpha", b: "beta" });
		expect(q.id).toBe("conflict_alpha_vs_beta");
		expect(q.options).toHaveLength(2);
		expect(q.options[0].label).toBe("alpha");
		expect(q.options[1].label).toBe("beta");
		expect(q.recommended).toBeUndefined();
	});
});
