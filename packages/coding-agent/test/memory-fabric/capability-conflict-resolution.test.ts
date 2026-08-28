import { describe, expect, it } from "bun:test";

import {
	analyzeCapabilityConflicts,
	type ConflictCapabilityDescriptor,
	detectConflicts,
	resolveConflicts,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-conflict-resolution";

function desc(id: string, extra: Partial<ConflictCapabilityDescriptor> = {}): ConflictCapabilityDescriptor {
	return { id, ...extra };
}

describe("capability-conflict-resolution", () => {
	it("is inert when disabled", () => {
		const edges = [{ from: "a", to: "b", kind: "conflicts-with" }];
		expect(detectConflicts([desc("a"), desc("b")], edges)).toEqual([]);
		const result = analyzeCapabilityConflicts([desc("a"), desc("b")], edges);
		expect(result.enabled).toBe(false);
		expect(result.decisions).toEqual([]);
	});

	it("turns a declared conflicts-with edge into a hard mutually-exclusive conflict", () => {
		const edges = [{ from: "b", to: "a", kind: "conflicts-with" }];
		const conflicts = detectConflicts([desc("a"), desc("b")], edges, { enabled: true });
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]?.a).toBe("a"); // canonical pair order
		expect(conflicts[0]?.b).toBe("b");
		expect(conflicts[0]?.type).toBe("mutually-exclusive");
		expect(conflicts[0]?.severity).toBe("hard");
		expect(conflicts[0]?.provenance).toBe("declared");
	});

	it("detects write/write resource contention as a soft conflict", () => {
		const descriptors = [
			desc("a", { effects: { writes: ["db.users"] } }),
			desc("b", { effects: { writes: ["db.users"] } }),
		];
		const conflicts = detectConflicts(descriptors, [], { enabled: true });
		expect(conflicts.some(c => c.type === "resource-contention" && c.severity === "soft")).toBe(true);
	});

	it("detects delete-vs-read overlap as a hard effect-overlap conflict", () => {
		const descriptors = [
			desc("a", { effects: { deletes: ["cache"] } }),
			desc("b", { effects: { reads: ["cache"] } }),
		];
		const conflicts = detectConflicts(descriptors, [], { enabled: true });
		expect(conflicts.some(c => c.type === "effect-overlap" && c.severity === "hard")).toBe(true);
	});

	it("only reports env/schema incompatibility when the pair shares a resource", () => {
		const unrelated = [desc("a", { environment: "node" }), desc("b", { environment: "browser" })];
		expect(detectConflicts(unrelated, [], { enabled: true })).toEqual([]);

		const sharing = [
			desc("a", { environment: "node", effects: { writes: ["f"] } }),
			desc("b", { environment: "browser", effects: { writes: ["f"] } }),
		];
		const conflicts = detectConflicts(sharing, [], { enabled: true });
		expect(conflicts.some(c => c.type === "environment-incompatible")).toBe(true);
	});

	it("suppresses false conflicts between mutually-exclusive branches", () => {
		const descriptors = [
			desc("a", { branch: "on-success", effects: { writes: ["out"] } }),
			desc("b", { branch: "on-failure", effects: { writes: ["out"] } }),
		];
		expect(detectConflicts(descriptors, [], { enabled: true })).toEqual([]);
	});

	it("keeps both on a soft conflict and recommends the higher-authority primary", () => {
		const descriptors = [
			desc("a", { effects: { writes: ["r"] } }),
			desc("b", { supportedBy: ["user-instruction"], effects: { writes: ["r"] } }),
		];
		const result = analyzeCapabilityConflicts(descriptors, [], { enabled: true });
		const decision = result.decisions.find(d => d.action === "keep-both");
		expect(decision?.keep).toBe("b");
		expect(decision?.decidedBy).toBe("user-instruction");
	});

	it("never auto-resolves a hard conflict between two safety-critical capabilities", () => {
		const descriptors = [desc("a", { safetyCritical: true }), desc("b", { safetyCritical: true })];
		const edges = [{ from: "a", to: "b", kind: "conflicts-with" }];
		const result = analyzeCapabilityConflicts(descriptors, edges, { enabled: true });
		expect(result.decisions[0]?.action).toBe("ask-user");
		expect(result.decisions[0]?.decidedBy).toBe("safety-standoff");
		expect(result.needsUser).toHaveLength(1);
	});

	it("a safety-critical capability always wins a hard conflict", () => {
		const descriptors = [desc("a"), desc("b", { safetyCritical: true })];
		const edges = [{ from: "a", to: "b", kind: "conflicts-with" }];
		const result = analyzeCapabilityConflicts(descriptors, edges, { enabled: true });
		expect(result.decisions[0]?.action).toBe("keep-winner");
		expect(result.decisions[0]?.keep).toBe("b");
		expect(result.decisions[0]?.decidedBy).toBe("safety");
	});

	it("asks the user when a hard conflict has no precedence separation", () => {
		const descriptors = [desc("a"), desc("b")];
		const edges = [{ from: "a", to: "b", kind: "conflicts-with" }];
		const result = analyzeCapabilityConflicts(descriptors, edges, { enabled: true });
		expect(result.decisions[0]?.action).toBe("ask-user");
		expect(result.decisions[0]?.decidedBy).toBe("tie");
	});

	it("prefers a swap over a drop when the loser declares an alternative", () => {
		const descriptors = [
			desc("a", { supportedBy: ["workflow"], alternativeTo: ["c"] }),
			desc("b", { supportedBy: ["safety"] }),
		];
		const edges = [{ from: "a", to: "b", kind: "conflicts-with" }];
		const result = analyzeCapabilityConflicts(descriptors, edges, { enabled: true });
		expect(result.decisions[0]?.action).toBe("swap");
		expect(result.decisions[0]?.keep).toBe("b");
		expect(result.decisions[0]?.drop).toBe("a");
		expect(result.decisions[0]?.replaceWith).toBe("c");
	});

	it("resolveConflicts is deterministic and sorted by canonical pair", () => {
		const conflicts = detectConflicts(
			[desc("z"), desc("a"), desc("m")],
			[
				{ from: "z", to: "a", kind: "conflicts-with" },
				{ from: "m", to: "a", kind: "conflicts-with" },
			],
			{ enabled: true },
		);
		const result = resolveConflicts(conflicts, [desc("z"), desc("a"), desc("m")], { enabled: true });
		const pairs = result.decisions.map(d => `${d.a}|${d.b}`);
		expect(pairs).toEqual([...pairs].sort());
		expect(resolveConflicts(conflicts, [desc("z"), desc("a"), desc("m")], { enabled: true })).toEqual(result);
	});

	it("fails open on hostile descriptor input", () => {
		const hostile = new Proxy([], {
			get() {
				throw new Error("hostile");
			},
		}) as unknown as ConflictCapabilityDescriptor[];
		expect(detectConflicts(hostile, [], { enabled: true })).toEqual([]);
		expect(analyzeCapabilityConflicts(hostile, [], { enabled: true }).decisions).toEqual([]);
	});
});
