/**
 * Deterministic tests for CH10 anti-burial ordering (plan §5 "order by decision
 * importance", §7 CH10). Exercises the real classifier types + orderer, and the
 * `makeOrderer` seam that drops into the Adaptive Context Hygiene Gate.
 */

import { describe, expect, it } from "bun:test";
import type { OrderedContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/order";
import { makeOrderer, planOrdering } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/order";
import { runContextHygieneGate } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/pipeline";
import type {
	ClassifiedContextItem,
	ContextItem,
	FidelityClass,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";

const fixedNow = () => new Date("2026-07-22T13:20:00.000Z");

const PRESERVED = new Set<FidelityClass>(["F0", "F1"]);

function ci(id: string, fidelity: FidelityClass): ClassifiedContextItem {
	return {
		id,
		content: `content-${id}`,
		fidelity,
		allowedTransforms: [],
		reason: "test",
		ruleId: "test",
		matchedSignals: [],
		provenance: {
			originId: id,
			classifier: "test-classifier",
			classifierVersion: "test",
			classifiedAt: "t",
			ruleId: "test",
		},
		preserved: PRESERVED.has(fidelity),
		noCompression: false,
	};
}

// F0 deliberately buried in the middle of the input.
function mixed(): ClassifiedContextItem[] {
	return [ci("a", "F3"), ci("b", "F2"), ci("c", "F0"), ci("d", "F1"), ci("e", "F4")];
}

describe("planOrdering — anti-burial", () => {
	it("puts the most-important item at the front and the second at the back", () => {
		const r = planOrdering(mixed(), { now: fixedNow });
		expect(r.strategy).toBe("anti-burial");
		expect(r.items[0].id).toBe("c");
		expect(r.items[0].placement).toBe("edge-start");
		expect(r.items[r.items.length - 1].id).toBe("d");
		expect(r.items[r.items.length - 1].placement).toBe("edge-end");
	});

	it("never buries F0/F1 in the middle when lower-fidelity items exist", () => {
		const r = planOrdering(mixed(), { now: fixedNow });
		const preservedInMiddle = r.items.filter(i => PRESERVED.has(i.fidelity)).some(i => i.placement === "middle");
		expect(preservedInMiddle).toBe(false);
		expect(r.preservedInMiddle).toBe(false);
		expect(r.items.find(i => i.placement === "middle")?.id).toBe("e");
	});
});

describe("planOrdering — scoring", () => {
	it("lets caller importance lift a lower class above a higher one", () => {
		const r = planOrdering(mixed(), { now: fixedNow, importance: item => (item.id === "a" ? 100 : 0) });
		expect(r.items.find(i => i.id === "a")?.orderRank).toBe(0);
		expect(r.items[0].id).toBe("a");
	});

	it("importance-desc sorts most-important-first with monotonic ranks", () => {
		const r = planOrdering(mixed(), { now: fixedNow, strategy: "importance-desc" });
		expect(r.items.map(i => i.id).join(",")).toBe("c,d,b,a,e");
		expect(r.items.map(i => i.orderRank).join(",")).toBe("0,1,2,3,4");
	});

	it("breaks ties on original index (deterministic, stable)", () => {
		const items = [ci("x1", "F2"), ci("x2", "F2"), ci("x3", "F2")];
		const r1 = planOrdering(items, { now: fixedNow, strategy: "importance-desc" });
		const r2 = planOrdering(items, { now: fixedNow, strategy: "importance-desc" });
		expect(r1.items.map(i => i.id).join(",")).toBe("x1,x2,x3");
		expect(r2.items.map(i => i.id).join(",")).toBe(r1.items.map(i => i.id).join(","));
	});
});

describe("planOrdering — safety", () => {
	it("does not mutate the caller's input", () => {
		const input = mixed();
		const before = input.map(i => i.id).join(",");
		const snap = JSON.stringify(input[0]);
		planOrdering(input, { now: fixedNow });
		expect(input.map(i => i.id).join(",")).toBe(before);
		expect(JSON.stringify(input[0])).toBe(snap);
		expect((input[0] as Partial<OrderedContextItem>).orderRank).toBeUndefined();
	});

	it("absorbs a throwing importance signal as 0 (never crashes)", () => {
		const r = planOrdering(mixed(), {
			now: fixedNow,
			importance: () => {
				throw new Error("boom");
			},
		});
		expect(r.failedOpen).toBe(false);
		expect(r.items[0].id).toBe("c");
	});

	it("handles empty input", () => {
		const r = planOrdering([], { now: fixedNow });
		expect(r.items).toHaveLength(0);
		expect(r.moved).toBe(0);
		expect(r.failedOpen).toBe(false);
	});

	it("annotates originalIndex + placement on every item", () => {
		const r = planOrdering(mixed(), { now: fixedNow });
		expect(r.items.find(i => i.id === "c")?.originalIndex).toBe(2);
		expect(r.items.every(i => ["edge-start", "edge-end", "middle"].includes(i.placement))).toBe(true);
	});
});

describe("makeOrderer — pipeline seam", () => {
	it("produces the same order as planOrdering", () => {
		const orderer = makeOrderer({ now: fixedNow });
		const viaSeam = orderer(mixed())
			.map(i => i.id)
			.join(",");
		const viaPlan = planOrdering(mixed(), { now: fixedNow })
			.items.map(i => i.id)
			.join(",");
		expect(viaSeam).toBe(viaPlan);
	});

	it("drops into runContextHygieneGate's orderItems seam and moves F0 to an edge", () => {
		const items: ContextItem[] = [
			{ id: "note", content: "episodic note from last week", type: "episodic" }, // F3
			{ id: "sec", content: "security warning: rotate the leaked api key", type: "security" }, // F0
			{ id: "dec", content: "verified decision: we will use bun", type: "decision" }, // F1
		];
		const r = runContextHygieneGate(items, [], {
			mode: "enforce",
			now: fixedNow,
			orderItems: makeOrderer({ now: fixedNow }),
		});
		expect(r.classified[0].id).toBe("sec");
		expect(r.failedOpen).toBe(false);
	});
});
