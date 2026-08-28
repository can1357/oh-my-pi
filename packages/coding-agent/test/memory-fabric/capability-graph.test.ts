/**
 * Tests for the read-only capability dependency graph.
 */

import { describe, expect, it } from "bun:test";
import { CapabilityGraph, createCapabilityGraph } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-graph";
import type { CapabilityDescriptor } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-orchestration";

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

describe("CapabilityGraph", () => {
	it("is disabled by default: nothing ingested, all queries empty", () => {
		const graph = new CapabilityGraph().ingest([descriptor("a", { requires: ["b"] })]);
		expect(graph.isEnabled).toBe(false);
		expect(graph.listEdges()).toEqual([]);
		expect(graph.neighbors("a", "requires")).toEqual([]);
		expect(graph.getNodeCount()).toBe(0);
		expect(graph.getCycleCount()).toBe(0);
	});

	it("parses shorthand metadata fields into typed edges", () => {
		const graph = createCapabilityGraph(
			[
				descriptor("deploy", { requires: ["build"], validates: ["smoke-test"], rollsBack: ["restore"] }),
				descriptor("build"),
				descriptor("smoke-test"),
				descriptor("restore"),
			],
			{ enabled: true },
		);
		expect(graph.neighbors("deploy", "requires")).toEqual(["build"]);
		expect(graph.neighbors("deploy", "validates")).toEqual(["smoke-test"]);
		expect(graph.neighbors("deploy", "rolls-back")).toEqual(["restore"]);
		expect(graph.getEdgeCount()).toBe(3);
	});

	it("parses canonical metadata.edges with weights and skips malformed entries", () => {
		const graph = createCapabilityGraph(
			[
				descriptor("a", {
					edges: [
						{ to: "b", kind: "commonly-used-with", weight: 0.8 },
						{ to: "", kind: "requires" },
						{ to: "c", kind: "not-a-kind" },
						"just a string",
						null,
					],
				}),
				descriptor("b"),
			],
			{ enabled: true },
		);
		const edges = graph.listEdges();
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ from: "a", to: "b", kind: "commonly-used-with", weight: 0.8 });
	});

	it("mirrors symmetric edges from both endpoints and answers hasConflict both ways", () => {
		const graph = createCapabilityGraph([descriptor("x", { conflictsWith: ["y"] }), descriptor("y")], {
			enabled: true,
		});
		expect(graph.neighbors("x", "conflicts-with")).toEqual(["y"]);
		expect(graph.neighbors("y", "conflicts-with")).toEqual(["x"]);
		expect(graph.hasConflict("x", "y")).toBe(true);
		expect(graph.hasConflict("y", "x")).toBe(true);
		expect(graph.getConflictCount()).toBe(1);
	});

	it("ignores self-edges and reports dangling targets", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["a", "ghost"] })], { enabled: true });
		expect(graph.neighbors("a", "requires")).toEqual(["ghost"]);
		expect(graph.danglingTargets()).toEqual(["ghost"]);
	});

	it("counts back-edges iteratively without stack overflow on a long chain", () => {
		const chain: CapabilityDescriptor[] = [];
		const n = 20000;
		for (let i = 0; i < n; i++) {
			chain.push(descriptor(`n${i}`, i + 1 < n ? { requires: [`n${i + 1}`] } : { requires: ["n0"] }));
		}
		const graph = createCapabilityGraph(chain, { enabled: true });
		expect(graph.getCycleCount()).toBe(1);
	});

	it("optionally rejects registration edges that would complete a requires cycle", () => {
		const graph = new CapabilityGraph({ enabled: true, rejectRegistrationCycles: true }).ingest([
			descriptor("a", { requires: ["b"] }),
			descriptor("b", { requires: ["a"] }),
		]);
		expect(graph.rejectedRegistrationEdges).toEqual([{ from: "b", to: "a", kind: "requires" }]);
		expect(graph.neighbors("a", "requires")).toEqual(["b"]);
		expect(graph.neighbors("b", "requires")).toEqual([]);
		expect(graph.getCycleCount()).toBe(0);
	});

	it("getIncomingEdges returns directional incoming edges", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["b"] }), descriptor("b")], { enabled: true });
		const incoming = graph.getIncomingEdges("b", "requires");
		expect(incoming).toHaveLength(1);
		expect(incoming[0].from).toBe("a");
	});

	it("toJSON provides a read-only snapshot", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["b"] })], { enabled: true });
		const snapshot = graph.toJSON();
		expect(snapshot.enabled).toBe(true);
		expect(snapshot.edgeCount).toBe(1);
		expect(snapshot.danglingTargets).toEqual(["b"]);
	});
});
