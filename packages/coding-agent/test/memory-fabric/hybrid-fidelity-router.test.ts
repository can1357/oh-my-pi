import { describe, expect, it } from "bun:test";

import type { RoutableItem, RouterFidelityTier } from "@oh-my-pi/pi-coding-agent/memory-fabric/hybrid-fidelity-router";
import {
	REPRESENTATION_LANES,
	routeFidelity,
	summarizeRouter,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/hybrid-fidelity-router";

describe("hybrid-fidelity-router", () => {
	it("returns an inert result when disabled", () => {
		const result = routeFidelity([{ id: "a" }]);
		expect(result.enabled).toBe(false);
		expect(result.mode).toBe("observe");
		expect(result.assignments).toEqual([]);
		for (const lane of REPRESENTATION_LANES) expect(result.lanes[lane]).toEqual([]);
	});

	it("routes evicted items to deferred-handle even when protected", () => {
		const result = routeFidelity([{ id: "a", tier: "evicted", protected: true }], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("deferred-handle");
	});

	it("routes protected items to exact-local ahead of evidence and summarization", () => {
		const item: RoutableItem = { id: "a", protected: true, evidence: true, tier: "summarized" };
		const result = routeFidelity([item], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("exact-local");
	});

	it("routes evidence items to projected-evidence", () => {
		const result = routeFidelity([{ id: "a", evidence: true }], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("projected-evidence");
	});

	it("routes summarized items to compact-global even when local", () => {
		const result = routeFidelity([{ id: "a", tier: "summarized", local: true }], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("compact-global");
	});

	it("routes full local items to exact-local", () => {
		const result = routeFidelity([{ id: "a", local: true }], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("exact-local");
	});

	it("routes full non-local items to compact-global by default", () => {
		const result = routeFidelity([{ id: "a" }], { enabled: true });
		expect(result.assignments[0]?.lane).toBe("compact-global");
	});

	it("treats an unknown tier as full", () => {
		const bogus = { id: "a", tier: "bogus" as unknown as RouterFidelityTier, local: true };
		const result = routeFidelity([bogus], { enabled: true });
		expect(result.assignments[0]?.tier).toBe("full");
		expect(result.assignments[0]?.lane).toBe("exact-local");
	});

	it("dedupes by id keeping the first occurrence", () => {
		const result = routeFidelity(
			[
				{ id: "a", local: true },
				{ id: "a", tier: "evicted" },
			],
			{ enabled: true },
		);
		expect(result.assignments).toHaveLength(1);
		expect(result.assignments[0]?.lane).toBe("exact-local");
	});

	it("skips null entries and blank ids", () => {
		const entries = [null as unknown as RoutableItem, { id: "  " }, { id: "ok" }];
		const result = routeFidelity(entries, { enabled: true });
		expect(result.assignments.map(a => a.id)).toEqual(["ok"]);
	});

	it("returns id-sorted assignments and lane buckets", () => {
		const result = routeFidelity([{ id: "c" }, { id: "a" }, { id: "b" }], { enabled: true });
		expect(result.assignments.map(a => a.id)).toEqual(["a", "b", "c"]);
		expect(result.lanes["compact-global"]).toEqual(["a", "b", "c"]);
	});

	it("groups ids into the correct lane buckets", () => {
		const items: RoutableItem[] = [
			{ id: "p", protected: true },
			{ id: "e", evidence: true },
			{ id: "s", tier: "summarized" },
			{ id: "d", tier: "evicted" },
		];
		const result = routeFidelity(items, { enabled: true });
		expect(result.lanes["exact-local"]).toEqual(["p"]);
		expect(result.lanes["projected-evidence"]).toEqual(["e"]);
		expect(result.lanes["compact-global"]).toEqual(["s"]);
		expect(result.lanes["deferred-handle"]).toEqual(["d"]);
	});

	it("summarizes a disabled result", () => {
		expect(summarizeRouter(routeFidelity([]))).toBe("router: disabled");
	});

	it("summarizes lane counts in canonical order", () => {
		const result = routeFidelity([{ id: "a", local: true }, { id: "b" }], { enabled: true });
		const line = summarizeRouter(result);
		expect(line).toBe("router: exact-local=1 compact-global=1 projected-evidence=0 deferred-handle=0");
	});
});
