/**
 * Tests for execution-complete bundle expansion.
 */

import { describe, expect, it } from "bun:test";
import { expandExecutionComplete } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-bundle";
import { createCapabilityGraph } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-graph";
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

describe("expandExecutionComplete", () => {
	it("returns a seeds-only bundle over a disabled graph", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["b"] })]); // disabled by default
		const bundle = expandExecutionComplete(graph, ["a", "a", ""]);
		expect(bundle.mode).toBe("observe");
		expect(bundle.seeds).toEqual(["a"]);
		expect(bundle.included).toEqual(["a"]);
		expect(bundle.prerequisites).toEqual([]);
	});

	it("orders the requires closure prerequisites-first", () => {
		const graph = createCapabilityGraph(
			[
				descriptor("deploy", { requires: ["build"] }),
				descriptor("build", { requires: ["lint"] }),
				descriptor("lint"),
			],
			{ enabled: true },
		);
		const bundle = expandExecutionComplete(graph, ["deploy"]);
		expect(bundle.included).toEqual(["lint", "build", "deploy"]);
		expect(bundle.prerequisites).toEqual(["lint", "build"]);
	});

	it("collects validation and rollback companions and makes them runnable", () => {
		const graph = createCapabilityGraph(
			[
				descriptor("deploy", { validates: ["smoke"], rollsBack: ["restore"] }),
				descriptor("smoke", { requires: ["env"] }),
				descriptor("restore"),
				descriptor("env"),
			],
			{ enabled: true },
		);
		const bundle = expandExecutionComplete(graph, ["deploy"]);
		expect(bundle.validations).toEqual(["smoke"]);
		expect(bundle.rollbacks).toEqual(["restore"]);
		// Companion requires are expanded by default, prerequisites-first.
		expect(bundle.included.indexOf("env")).toBeLessThan(bundle.included.indexOf("smoke"));
	});

	it("marks truncated when a companion is dropped under includeCompanionRequires: false", () => {
		const graph = createCapabilityGraph(
			[descriptor("a", { validates: ["v1", "v2"] }), descriptor("v1"), descriptor("v2")],
			{ enabled: true },
		);
		const bundle = expandExecutionComplete(graph, ["a"], { maxNodes: 2, includeCompanionRequires: false });
		expect(bundle.included).toEqual(["a", "v1"]);
		expect(bundle.truncated).toBe(true);
	});

	it("survives requires cycles and reports the participants", () => {
		const graph = createCapabilityGraph(
			[descriptor("a", { requires: ["b"] }), descriptor("b", { requires: ["a"] })],
			{ enabled: true },
		);
		const bundle = expandExecutionComplete(graph, ["a"]);
		expect(bundle.included.sort()).toEqual(["a", "b"]);
		expect(bundle.cycles.sort()).toEqual(["a", "b"]);
	});

	it("reports conflicts among included capabilities without dropping anything", () => {
		const graph = createCapabilityGraph(
			[descriptor("seed", { requires: ["x", "y"] }), descriptor("x", { conflictsWith: ["y"] }), descriptor("y")],
			{ enabled: true },
		);
		const bundle = expandExecutionComplete(graph, ["seed"]);
		expect(bundle.conflicts).toEqual([{ a: "x", b: "y" }]);
		expect(bundle.included).toContain("x");
		expect(bundle.included).toContain("y");
	});

	it("reports dangling requires targets as missing", () => {
		const graph = createCapabilityGraph([descriptor("a", { requires: ["ghost"] })], { enabled: true });
		const bundle = expandExecutionComplete(graph, ["a"]);
		expect(bundle.included).toContain("ghost");
		expect(bundle.missing).toEqual(["ghost"]);
	});

	it("truncates the requires closure at maxNodes", () => {
		const descs: CapabilityDescriptor[] = [];
		for (let i = 0; i < 10; i++) {
			descs.push(descriptor(`n${i}`, i + 1 < 10 ? { requires: [`n${i + 1}`] } : undefined));
		}
		const graph = createCapabilityGraph(descs, { enabled: true });
		const bundle = expandExecutionComplete(graph, ["n0"], { maxNodes: 3 });
		expect(bundle.included.length).toBeLessThanOrEqual(3);
		expect(bundle.truncated).toBe(true);
	});
});
