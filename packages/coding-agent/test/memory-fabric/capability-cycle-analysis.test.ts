import { describe, expect, it } from "bun:test";

import {
	analyzeCapabilityCycles,
	type CapabilityEdgeInput,
	validateGraphAtRegistration,
	validateSeedsAtRetrieval,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-cycle-analysis";

function edge(from: string, to: string, kind = "requires"): CapabilityEdgeInput {
	return { from, to, kind };
}

describe("capability-cycle-analysis", () => {
	it("is inert when disabled", () => {
		const result = analyzeCapabilityCycles([edge("a", "b")]);
		expect(result.enabled).toBe(false);
		expect(result.acyclic).toBe(true);
		expect(result.cycles).toEqual([]);
		expect(result.topologicalOrder).toEqual([]);
	});

	it("orders an acyclic requires chain dependency-first", () => {
		// c requires b, b requires a  =>  a runs before b runs before c.
		const result = analyzeCapabilityCycles([edge("c", "b"), edge("b", "a")], { enabled: true });
		expect(result.acyclic).toBe(true);
		expect(result.hasMandatoryCycle).toBe(false);
		expect(result.topologicalOrder).toEqual(["a", "b", "c"]);
	});

	it("tie-breaks topological order by id", () => {
		const result = analyzeCapabilityCycles([edge("z", "a"), edge("y", "a")], { enabled: true });
		expect(result.topologicalOrder).toEqual(["a", "y", "z"]);
	});

	it("detects a mandatory two-node cycle and blocks ordering", () => {
		const result = analyzeCapabilityCycles([edge("a", "b"), edge("b", "a")], { enabled: true });
		expect(result.acyclic).toBe(false);
		expect(result.hasMandatoryCycle).toBe(true);
		expect(result.topologicalOrder).toBeNull();
		expect(result.mandatoryCycles.length).toBeGreaterThan(0);
	});

	it("normalizes cycle node ids so the smallest id is first", () => {
		const result = analyzeCapabilityCycles([edge("b", "a"), edge("a", "b")], { enabled: true });
		const cycle = result.cycles[0];
		expect(cycle?.nodeIds[0]).toBe("a");
	});

	it("treats advisory-only cycles as non-blocking", () => {
		const edges = [edge("a", "b", "recommended-after"), edge("b", "a", "recommended-after")];
		const result = analyzeCapabilityCycles(edges, { enabled: true });
		expect(result.hasMandatoryCycle).toBe(false);
		expect(result.acyclic).toBe(true);
		expect(result.advisoryCycles.length).toBeGreaterThan(0);
		expect(result.topologicalOrder).toEqual(["a", "b"]);
	});

	it("ignores self-loops, malformed edges and unknown kinds", () => {
		const edges = [edge("a", "a"), { from: "", to: "b", kind: "requires" }, edge("a", "b", "totally-unknown-kind")];
		const result = analyzeCapabilityCycles(edges, { enabled: true });
		expect(result.acyclic).toBe(true);
		expect(result.cycles).toEqual([]);
	});

	it("sets truncated when the node budget is exceeded", () => {
		const edges: CapabilityEdgeInput[] = [];
		for (let i = 0; i < 10; i++) edges.push(edge(`n${i}`, `n${i + 1}`));
		const result = analyzeCapabilityCycles(edges, { enabled: true, maxNodes: 3 });
		expect(result.truncated).toBe(true);
	});

	it("is deterministic across calls", () => {
		const edges = [edge("c", "b"), edge("b", "a"), edge("x", "y"), edge("y", "x")];
		const first = analyzeCapabilityCycles(edges, { enabled: true });
		const second = analyzeCapabilityCycles(edges, { enabled: true });
		expect(second).toEqual(first);
	});

	it("validateGraphAtRegistration matches analyzeCapabilityCycles", () => {
		const edges = [edge("a", "b"), edge("b", "a")];
		expect(validateGraphAtRegistration(edges, { enabled: true })).toEqual(
			analyzeCapabilityCycles(edges, { enabled: true }),
		);
	});

	it("validateSeedsAtRetrieval only inspects the reachable sub-graph", () => {
		// A mandatory cycle exists between x and y, but seed "a" cannot reach it.
		const edges = [edge("b", "a"), edge("x", "y"), edge("y", "x")];
		const result = validateSeedsAtRetrieval(edges, ["a"], { enabled: true });
		expect(result.hasMandatoryCycle).toBe(false);
		expect(result.topologicalOrder).toEqual(["a", "b"]);
	});

	it("validateSeedsAtRetrieval flags a cycle reachable from the seeds", () => {
		const edges = [edge("a", "b"), edge("b", "a")];
		const result = validateSeedsAtRetrieval(edges, ["a"], { enabled: true });
		expect(result.hasMandatoryCycle).toBe(true);
		expect(result.topologicalOrder).toBeNull();
	});

	it("validateSeedsAtRetrieval is inert when disabled", () => {
		const result = validateSeedsAtRetrieval([edge("a", "b")], ["a"]);
		expect(result.enabled).toBe(false);
	});

	it("never mutates its input edges", () => {
		const edges = [edge("a", "b"), edge("b", "a")];
		const snapshot = JSON.stringify(edges);
		analyzeCapabilityCycles(edges, { enabled: true });
		expect(JSON.stringify(edges)).toBe(snapshot);
	});
});
