import { describe, expect, it } from "bun:test";

import {
	type CapabilityRetrieval,
	type RetrieverPorts,
	retrieveCapabilities,
	summarizeRetrieval,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-retriever";

describe("capability-retriever", () => {
	it("is inert when disabled", () => {
		const result = retrieveCapabilities({ seedIds: ["a"] });
		expect(result.enabled).toBe(false);
		expect(result.seeds).toEqual([]);
		expect(result.stages).toEqual([]);
	});

	it("passes seed ids through (deduped, sorted) when no ports are wired", () => {
		const result = retrieveCapabilities({ seedIds: ["b", "a", "b", ""] }, {}, { enabled: true });
		expect(result.seeds).toEqual(["a", "b"]);
		expect(result.included).toEqual(["a", "b"]);
		expect(result.stages).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it("caps seeds at maxSeeds and reports truncation", () => {
		const result = retrieveCapabilities({ seedIds: ["a", "b", "c", "d"] }, {}, { enabled: true, maxSeeds: 2 });
		expect(result.seeds).toEqual(["a", "b"]);
		expect(result.truncated).toBe(true);
	});

	it("uses the fuse-seeds port when provided and records the stage", () => {
		const ports: RetrieverPorts = {
			fuseSeeds: () => [{ capabilityId: "z" }, { capabilityId: "a" }],
		};
		const result = retrieveCapabilities({ seedIds: ["ignored"] }, ports, { enabled: true });
		expect(result.seeds).toEqual(["a", "z"]);
		expect(result.stages).toContain("fuse-seeds");
	});

	it("fails open when the fuse-seeds port throws", () => {
		const ports: RetrieverPorts = {
			fuseSeeds: () => {
				throw new Error("boom");
			},
		};
		const result = retrieveCapabilities({ seedIds: ["a"] }, ports, { enabled: true });
		expect(result.seeds).toEqual([]);
		expect(result.stages).not.toContain("fuse-seeds");
	});

	it("unions bundle output into included and propagates missing/truncated", () => {
		const ports: RetrieverPorts = {
			expandBundle: () => ({
				included: ["b"],
				prerequisites: ["c"],
				missing: ["ghost"],
				truncated: true,
			}),
		};
		const result = retrieveCapabilities({ seedIds: ["a"] }, ports, { enabled: true });
		expect(result.included).toEqual(["a", "b", "c"]);
		expect(result.missing).toEqual(["ghost"]);
		expect(result.truncated).toBe(true);
		expect(result.stages).toContain("expand-bundle");
	});

	it("only feeds edges among included ids to cycle analysis", () => {
		let seenEdges: unknown;
		const ports: RetrieverPorts = {
			analyzeCycles: edges => {
				seenEdges = edges;
				return { acyclic: true, topologicalOrder: [] };
			},
		};
		const request = {
			seedIds: ["a", "b"],
			edges: [
				{ from: "a", to: "b", kind: "requires" },
				{ from: "a", to: "outsider", kind: "requires" },
			],
		};
		retrieveCapabilities(request, ports, { enabled: true });
		expect(seenEdges).toEqual([{ from: "a", to: "b", kind: "requires" }]);
	});

	it("blocks ordering and raises flags on a mandatory cycle", () => {
		const ports: RetrieverPorts = {
			analyzeCycles: () => ({
				acyclic: false,
				hasMandatoryCycle: true,
				topologicalOrder: null,
				mandatoryCycles: [{ nodeIds: ["b", "a"] }],
			}),
		};
		const result = retrieveCapabilities({ seedIds: ["a", "b"] }, ports, { enabled: true });
		expect(result.blocked).toBe(true);
		expect(result.order).toBeNull();
		expect(result.needsUser[0]?.kind).toBe("mandatory-cycle");
		expect(result.needsUser[0]?.ids).toEqual(["a", "b"]);
	});

	it("adopts the topological order when the graph is acyclic", () => {
		const ports: RetrieverPorts = {
			analyzeCycles: () => ({ acyclic: true, topologicalOrder: ["a", "", "b"] }),
		};
		const result = retrieveCapabilities({ seedIds: ["a", "b"] }, ports, { enabled: true });
		expect(result.blocked).toBe(false);
		expect(result.order).toEqual(["a", "b"]);
	});

	it("surfaces conflict decisions and maps needsUser entries to flags", () => {
		const ports: RetrieverPorts = {
			resolveConflicts: () => ({
				decisions: [{ a: "a", b: "b", action: "keep-winner", keep: "a", drop: "b" }],
				needsUser: [{ a: "a", b: "b", action: "ask-user", reason: "hard tie" }],
			}),
		};
		const result = retrieveCapabilities({ seedIds: ["a", "b"] }, ports, { enabled: true });
		expect(result.decisions).toHaveLength(1);
		expect(result.needsUser[0]?.kind).toBe("conflict");
		expect(result.needsUser[0]?.reason).toBe("hard tie");
		expect(result.needsUser[0]?.ids).toEqual(["a", "b"]);
	});

	it("lists cycle flags before conflict flags in needsUser", () => {
		const ports: RetrieverPorts = {
			analyzeCycles: () => ({ hasMandatoryCycle: true, mandatoryCycles: [{ nodeIds: ["a", "b"] }] }),
			resolveConflicts: () => ({ needsUser: [{ a: "a", b: "b", action: "ask-user" }] }),
		};
		const result = retrieveCapabilities({ seedIds: ["a", "b"] }, ports, { enabled: true });
		expect(result.needsUser.map(f => f.kind)).toEqual(["mandatory-cycle", "conflict"]);
	});

	it("is deterministic across calls", () => {
		const ports: RetrieverPorts = {
			fuseSeeds: () => [{ capabilityId: "b" }, { capabilityId: "a" }],
			expandBundle: () => ({ included: ["c"] }),
			analyzeCycles: () => ({ acyclic: true, topologicalOrder: ["a", "b", "c"] }),
		};
		const first = retrieveCapabilities({}, ports, { enabled: true });
		const second = retrieveCapabilities({}, ports, { enabled: true });
		expect(second).toEqual(first);
	});

	it("summarizeRetrieval handles disabled and absent input", () => {
		expect(summarizeRetrieval(retrieveCapabilities({}))).toBe("retrieval: disabled");
		expect(summarizeRetrieval(undefined as unknown as CapabilityRetrieval)).toBe("retrieval: disabled");
	});

	it("summarizeRetrieval reports counts for an enabled retrieval", () => {
		const result = retrieveCapabilities({ seedIds: ["a", "b"] }, {}, { enabled: true });
		expect(summarizeRetrieval(result)).toBe("retrieval: seeds=2 included=2 order=blocked needsUser=0 missing=0");
	});
});
