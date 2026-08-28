import { describe, expect, it } from "bun:test";
import { classifyItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/classify";
import {
	type CoverageOptions,
	needFromId,
	needFromKeywords,
	needFromPredicate,
	validateCoverage,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/coverage";
import type {
	ClassifiedContextItem,
	FidelityClass,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";

const NOW = () => new Date("2026-07-22T12:00:00.000Z");

/** Build a classified item directly (bypassing rule heuristics) for coverage tests. */
function classified(
	id: string,
	content: string,
	fidelity: FidelityClass,
	noCompression = false,
): ClassifiedContextItem {
	const base = classifyItem({ id, content }, { now: NOW });
	return {
		...base,
		fidelity,
		preserved: fidelity === "F0" || fidelity === "F1",
		noCompression,
		allowedTransforms: noCompression ? ["none"] : base.allowedTransforms,
	};
}

function run(items: ClassifiedContextItem[], needs: Parameters<typeof validateCoverage>[1], options?: CoverageOptions) {
	return validateCoverage(items, needs, { now: NOW, ...options });
}

describe("context-hygiene required-need coverage (ACF CH6)", () => {
	it("reports a required need already covered by a kept item", () => {
		const r = run([classified("a", "runbook step 1", "F1")], [needFromId("n1", "a")]);
		expect(r.results[0].action).toBe("already-covered");
		expect(r.allRequiredCovered).toBe(true);
		expect(r.expansions.length).toBe(0);
		expect(r.neverWorse.violation).toBe(false);
	});

	it("expands fidelity rather than shipping a gap when the only match is omitted (rule #6)", () => {
		const r = run([classified("a", "the answer is 42", "F3")], [needFromKeywords("n1", ["answer"])], {
			omittedIds: ["a"],
		});
		expect(r.results[0].action).toBe("expanded");
		expect(r.allRequiredCovered).toBe(true);
		expect(r.expansions[0].fromFidelity).toBe("F3");
		expect(r.expansions[0].toFidelity).toBe("F1");
		expect(r.items[0].disposition).toBe("keep");
		expect(r.items[0].fidelity).toBe("F1");
		expect(r.items[0].preserved).toBe(true);
		expect(r.items[0].escalated?.forNeed).toBe("n1");
	});

	it("records a hard gap when no candidate matches at all", () => {
		const r = run([classified("a", "unrelated", "F2")], [needFromKeywords("n1", ["nonexistent"])]);
		expect(r.results[0].action).toBe("gap");
		expect(r.gaps).toEqual(["n1"]);
		expect(r.allRequiredCovered).toBe(false);
		expect(r.neverWorse.violation).toBe(false);
	});

	it("does not let a rejected (F4) item cover a need by default", () => {
		const r = run([classified("a", "malicious secret dump", "F4")], [needFromKeywords("n1", ["secret"])]);
		expect(r.results[0].matchedCandidateIds).toEqual([]);
		expect(r.results[0].action).toBe("gap");
	});

	it("allows F4 to cover only when explicitly opted in", () => {
		const r = run([classified("a", "secret", "F4")], [needFromKeywords("n1", ["secret"])], {
			allowRejectedToCover: true,
		});
		expect(r.results[0].action).toBe("expanded");
		expect(r.items[0].fidelity).toBe("F1");
	});

	it("never downgrades F0 when escalating to cover a need", () => {
		const r = run([classified("a", "exit code 1", "F0")], [needFromKeywords("n1", ["exit code"])], {
			omittedIds: ["a"],
		});
		expect(r.items[0].fidelity).toBe("F0");
		expect(r.items[0].disposition).toBe("keep");
		expect(r.expansions[0].toFidelity).toBe("F0");
	});

	it("reports an optional uncovered need without failing required coverage", () => {
		const r = run([classified("a", "x", "F2")], [needFromKeywords("opt", ["zzz"], false)]);
		expect(r.results[0].action).toBe("optional-uncovered");
		expect(r.allRequiredCovered).toBe(true);
		expect(r.gaps).toEqual([]);
	});

	it("escalates the highest-fidelity candidate", () => {
		const r = run(
			[classified("a", "match me", "F3"), classified("b", "match me too", "F2")],
			[needFromKeywords("n1", ["match me"])],
			{ omittedIds: ["a", "b"] },
		);
		expect(r.expansions[0].itemId).toBe("b");
	});

	it("upholds the never-worse coverage guarantee after expansion", () => {
		const r = run([classified("a", "critical value", "F3")], [needFromKeywords("n1", ["critical value"])], {
			omittedIds: ["a"],
		});
		expect(r.neverWorse.requiredCoverableCount).toBe(1);
		expect(r.neverWorse.requiredCoveredCount).toBe(1);
		expect(r.neverWorse.violation).toBe(false);
	});

	it("does not mutate the input items", () => {
		const items = [classified("a", "keep me", "F3")];
		const snapshot = JSON.stringify(items);
		run(items, [needFromKeywords("n1", ["keep me"])], { omittedIds: ["a"] });
		expect(JSON.stringify(items)).toBe(snapshot);
	});

	it("treats a throwing predicate as a no-match instead of crashing", () => {
		const need = needFromPredicate("n1", () => {
			throw new Error("boom");
		});
		const r = run([classified("a", "x", "F2")], [need]);
		expect(r.results[0].action).toBe("gap");
		expect(r.failedOpen).toBe(false);
	});

	it("handles multiple needs with mixed outcomes", () => {
		const items = [classified("a", "alpha decision", "F1"), classified("b", "beta evidence", "F2")];
		const needs = [
			needFromKeywords("n1", ["alpha"]),
			needFromKeywords("n2", ["beta"], true),
			needFromKeywords("n3", ["gamma"]),
		];
		const r = run(items, needs, { omittedIds: ["b"] });
		expect(r.results.map(x => x.action)).toEqual(["already-covered", "expanded", "gap"]);
		expect(r.allRequiredCovered).toBe(false);
		expect(r.gaps).toEqual(["n3"]);
	});
});
