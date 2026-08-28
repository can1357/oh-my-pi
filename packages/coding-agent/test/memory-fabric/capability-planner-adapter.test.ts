/**
 * Tests for the approval-gated capability planner adapter.
 */

import { describe, expect, it } from "bun:test";
import { createCapabilityGraph } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-graph";
import type { CapabilityDescriptor } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-orchestration";
import type { CapabilityGate } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-planner-adapter";
import { planCapabilityBundle } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-planner-adapter";

function descriptor(id: string, metadata?: Record<string, unknown>): CapabilityDescriptor {
	return {
		id,
		kind: "tool",
		name: id,
		description: "",
		tags: [],
		version: 1,
		enabled: true,
		metadata,
	};
}

const allowAll: CapabilityGate = () => ({ decision: "allow" });

describe("planCapabilityBundle", () => {
	it("is off and inert when not enabled", () => {
		const graph = createCapabilityGraph([descriptor("a")], { enabled: true });
		const plan = planCapabilityBundle(graph, ["a"]);
		expect(plan.mode).toBe("off");
		expect(plan.approved).toEqual([]);
		expect(plan.decisions).toEqual([]);
		expect(plan.bundle.included).toEqual(["a"]);
	});

	it("observe mode without a gate: everything needs approval, nothing approved", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["b"] }), descriptor("b")], { enabled: true });
		const plan = planCapabilityBundle(graph, ["a"], { enabled: true });
		expect(plan.mode).toBe("observe");
		expect(plan.approved).toEqual([]);
		expect(plan.requiresApproval.sort()).toEqual(["a", "b"]);
		expect(plan.denied).toEqual([]);
	});

	it("active mode routes every capability through the injected gate", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["b"] }), descriptor("b")], { enabled: true });
		const seen: string[] = [];
		const gate: CapabilityGate = id => {
			seen.push(id);
			return id === "b" ? { decision: "deny", reason: "not trusted" } : { decision: "allow" };
		};
		const plan = planCapabilityBundle(graph, ["a"], { enabled: true, gate });
		expect(plan.mode).toBe("active");
		expect(seen.sort()).toEqual(["a", "b"]);
		expect(plan.approved).toEqual(["a"]);
		expect(plan.denied).toEqual(["b"]);
	});

	it("fails closed when the gate throws", () => {
		const graph = createCapabilityGraph([descriptor("a")], { enabled: true });
		const gate: CapabilityGate = () => {
			throw new Error("boom");
		};
		const plan = planCapabilityBundle(graph, ["a"], { enabled: true, gate });
		expect(plan.denied).toEqual(["a"]);
		expect(plan.decisions[0].reason).toContain("failing closed");
	});

	it("conservative override: a gate-allowed recommended exclusion is downgraded to needs-approval", () => {
		const graph = createCapabilityGraph([descriptor("risky")], { enabled: true });
		const plan = planCapabilityBundle(graph, ["risky"], {
			enabled: true,
			gate: allowAll,
			fidelity: { risk: { risky: { risk: "high" } } },
		});
		expect(plan.approved).toEqual([]);
		expect(plan.requiresApproval).toEqual(["risky"]);
		expect(plan.decisions[0].reason).toContain("risk override");
	});

	it("assigns execution conditions: rollbacks on-failure, validations on-success", () => {
		const graph = createCapabilityGraph(
			[
				descriptor("deploy", { validates: ["smoke"], rollsBack: ["restore"] }),
				descriptor("smoke"),
				descriptor("restore"),
			],
			{ enabled: true },
		);
		const plan = planCapabilityBundle(graph, ["deploy"], { enabled: true, gate: allowAll });
		const byId = new Map(plan.decisions.map(d => [d.id, d]));
		expect(byId.get("deploy")?.executionCondition).toBe("always");
		expect(byId.get("smoke")?.executionCondition).toBe("on-success");
		expect(byId.get("restore")?.executionCondition).toBe("on-failure");
	});

	it("sanitizes seed input and stays inert (off) on garbage", () => {
		const graph = createCapabilityGraph([], { enabled: true });
		const plan = planCapabilityBundle(graph, ["", "ok"], { enabled: false });
		expect(plan.seeds).toEqual(["ok"]);
		expect(plan.mode).toBe("off");
	});

	it("gate context carries tier, rank, and risk flags", () => {
		const graph = createCapabilityGraph([descriptor("a", { rollsBack: ["rb"] }), descriptor("rb")], {
			enabled: true,
		});
		const contexts: Array<{ id: string; tier: string | null; rank: number }> = [];
		const gate: CapabilityGate = (id, ctx) => {
			contexts.push({ id, tier: ctx.tier, rank: ctx.rank });
			return { decision: "allow" };
		};
		planCapabilityBundle(graph, ["a"], { enabled: true, gate });
		const rb = contexts.find(c => c.id === "rb");
		expect(rb?.tier).toBe("L0"); // rollback → safety-critical tier
		expect(contexts.map(c => c.rank)).toEqual([0, 1]);
	});
});
