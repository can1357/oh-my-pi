/**
 * Deterministic tests for the Adaptive Context Hygiene Gate wiring (plan §5).
 *
 * These exercise the REAL CH2 (dedup) + CH3 (classify) + CH6 (coverage) + CH0
 * (token accounting) modules composed by runContextHygieneGate — so they are an
 * integration test of the whole pre-model gate, not just the orchestrator.
 *
 * Covered: observe vs enforce, dedup in-pipeline, F4 drop, F0-beats-F4 survival,
 * coverage escalation (expand rather than gap), hard gap, per-stage telemetry to
 * the sink, fail-open on a throwing hook, pre-reject, non-mutation, empty input.
 */

import { describe, expect, it } from "bun:test";
import type { RequiredNeed } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/coverage";
import { needFromKeywords } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/coverage";
import { runContextHygieneGate } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/pipeline";
import type { ContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";
import { InMemoryTelemetrySink } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";

const fixedNow = () => new Date("2026-07-22T13:05:00.000Z");

function baseItems(): ContextItem[] {
	return [
		{ id: "a", content: "verified decision: we will use bun", type: "decision" }, // F1
		{ id: "b", content: "verified decision: we will use bun", type: "decision" }, // dup of a
		{ id: "c", content: "security warning: rotate the leaked api key", type: "security" }, // F0
		{ id: "d", content: "irrelevant chatter about lunch", type: "out-of-scope" }, // F4
		{ id: "e", content: "episodic note from last week", type: "episodic" }, // F3
	];
}

describe("runContextHygieneGate — modes", () => {
	it("observe mode returns the original items unchanged but still proposes", () => {
		const r = runContextHygieneGate(baseItems(), [], { now: fixedNow });
		expect(r.mode).toBe("observe");
		expect(r.items).toHaveLength(5);
		expect((r.items[0] as ContextItem).id).toBe("a");
		expect(r.dedup.removedCount).toBe(1);
		// proposal dedups b and drops F4 d -> a, c, e
		expect(r.proposal.map(i => i.id).sort()).toEqual(["a", "c", "e"]);
		expect(r.failedOpen).toBe(false);
	});

	it("enforce mode returns the transformed kept packet", () => {
		const r = runContextHygieneGate(baseItems(), [], { mode: "enforce", now: fixedNow });
		expect(r.items).toHaveLength(3);
		expect(r.items.map(i => (i as { id: string }).id).sort()).toEqual(["a", "c", "e"]);
		expect(r.rejected.some(x => x.id === "d" && x.stage === "f4-drop")).toBe(true);
	});
});

describe("runContextHygieneGate — safety", () => {
	it("keeps F0 content even when it also looks out-of-scope (F0 before F4)", () => {
		const tricky = baseItems().concat([
			{ id: "f", content: "security warning: rollback required, may look out of scope", type: "security" },
		]);
		const r = runContextHygieneGate(tricky, [], { mode: "enforce", now: fixedNow });
		expect(r.classified.find(i => i.id === "f")?.fidelity).toBe("F0");
		expect(r.items.some(i => (i as { id: string }).id === "f")).toBe(true);
	});
});

describe("runContextHygieneGate — coverage", () => {
	it("escalates an omitted-but-needed item rather than shipping a gap", () => {
		const need: RequiredNeed = needFromKeywords("n-bun", ["use bun"]);
		const r = runContextHygieneGate(baseItems(), [need], {
			mode: "enforce",
			now: fixedNow,
			coverageOptions: { omittedIds: ["a"] },
		});
		expect(r.coverage.expansions.some(e => e.needId === "n-bun")).toBe(true);
		expect(r.items.some(i => (i as { id: string }).id === "a")).toBe(true);
		expect(r.coverage.allRequiredCovered).toBe(true);
		expect(r.coverage.neverWorse.violation).toBe(false);
	});

	it("reports a hard gap when only an F4 item could satisfy a required need", () => {
		const need: RequiredNeed = needFromKeywords("n-lunch", ["lunch"]);
		const r = runContextHygieneGate(baseItems(), [need], { mode: "enforce", now: fixedNow });
		expect(r.coverage.gaps).toContain("n-lunch");
		expect(r.coverage.allRequiredCovered).toBe(false);
	});
});

describe("runContextHygieneGate — telemetry", () => {
	it("emits every stage to the sink incl. a gate-total, dedup saves tokens", () => {
		const sink = new InMemoryTelemetrySink();
		const r = runContextHygieneGate(baseItems(), [], { sink, now: fixedNow });
		const names = r.stages.map(s => s.stage);
		for (const stage of ["dedup", "classify", "coverage", "gate"]) {
			expect(names).toContain(stage);
		}
		expect(sink.events.length).toBe(r.stages.length);
		expect(r.stages.find(s => s.stage === "dedup")!.event.saved).toBeGreaterThan(0);
		const gate = r.stages.find(s => s.stage === "gate")!.event;
		expect(gate.before).toBeGreaterThanOrEqual(gate.after);
		expect(r.stages.find(s => s.stage === "classify")!.event.saved).toBe(0);
	});
});

describe("runContextHygieneGate — resilience", () => {
	it("fails open (original items untouched) when a hook throws", () => {
		const withEvidence = baseItems().concat([{ id: "g", content: "```ts\nconst x = 1;\n```", type: "code" }]);
		const r = runContextHygieneGate(withEvidence, [], {
			mode: "enforce",
			now: fixedNow,
			projectItem: () => {
				throw new Error("boom");
			},
		});
		expect(r.failedOpen).toBe(true);
		expect(r.items).toHaveLength(withEvidence.length);
		expect(r.proposal).toHaveLength(0);
	});

	it("honors an optional pre-reject hook", () => {
		const r = runContextHygieneGate(baseItems(), [], {
			mode: "enforce",
			now: fixedNow,
			preReject: item => item.id === "e",
		});
		expect(r.rejected.some(x => x.id === "e" && x.stage === "pre-reject")).toBe(true);
		expect(r.items.some(i => (i as { id: string }).id === "e")).toBe(false);
	});

	it("does not mutate the caller's input", () => {
		const input = baseItems();
		const ids = input.map(i => i.id).join(",");
		const first = JSON.stringify(input[0]);
		runContextHygieneGate(input, [needFromKeywords("n", ["use bun"])], {
			mode: "enforce",
			now: fixedNow,
			coverageOptions: { omittedIds: ["a"] },
		});
		expect(input).toHaveLength(5);
		expect(input.map(i => i.id).join(",")).toBe(ids);
		expect(JSON.stringify(input[0])).toBe(first);
	});

	it("handles empty input safely", () => {
		const r = runContextHygieneGate([], [], { now: fixedNow });
		expect(r.proposal).toHaveLength(0);
		expect(r.failedOpen).toBe(false);
		expect(r.stages.some(s => s.stage === "gate")).toBe(true);
	});
});
