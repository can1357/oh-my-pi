import { describe, expect, it } from "bun:test";
import {
	classifyItem,
	classifyItems,
	isPreserved,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/classify";
import type { ClassificationRule, ContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";

const clock = () => new Date("2026-07-22T12:00:00.000Z");
const opts = { now: clock };

function item(over: Partial<ContextItem> & { id: string; content: string }): ContextItem {
	return over;
}

describe("context-hygiene / F0 immutable-exact (safety core)", () => {
	it("classifies security warnings as F0 with no allowed transforms", () => {
		const c = classifyItem(
			item({ id: "1", content: "SECURITY WARNING: do not expose this", type: "security" }),
			opts,
		);
		expect(c.fidelity).toBe("F0");
		expect(c.allowedTransforms).toEqual(["none"]);
		expect(c.preserved).toBe(true);
	});

	it("classifies exit codes, destructive ops, secrets, rollback and validation status as F0", () => {
		expect(classifyItem(item({ id: "a", content: "process finished with exit code 1" }), opts).fidelity).toBe("F0");
		expect(classifyItem(item({ id: "b", content: "run rm -rf /tmp/build to clean" }), opts).fidelity).toBe("F0");
		expect(classifyItem(item({ id: "c", content: "the api key must be rotated" }), opts).fidelity).toBe("F0");
		expect(classifyItem(item({ id: "d", content: "rollback steps: revert migration" }), opts).fidelity).toBe("F0");
		expect(classifyItem(item({ id: "e", content: "validation failed on field x" }), opts).fidelity).toBe("F0");
	});

	it("keeps F0 even when the item also carries a reject flag (F0 beats F4)", () => {
		const c = classifyItem(
			item({ id: "2", content: "SECURITY WARNING: token leak", type: "security", reject: true }),
			opts,
		);
		expect(c.fidelity).toBe("F0");
		expect(c.ruleId).toBe("f0-safety");
	});
});

describe("context-hygiene / F1 authoritative-compactable", () => {
	it("classifies decisions, procedures and invariants as F1 (lossless only, never omitted)", () => {
		const decision = classifyItem(
			item({ id: "3", content: "We will adopt the new ranker.", type: "decision" }),
			opts,
		);
		expect(decision.fidelity).toBe("F1");
		expect(decision.allowedTransforms).toEqual(["lossless-compaction"]);
		expect(decision.preserved).toBe(true);
		expect(classifyItem(item({ id: "4", content: "Step 1 do a thing\nStep 2 do more" }), opts).fidelity).toBe("F1");
		const inv = classifyItem(item({ id: "5", content: "invariant: must not drop F0", type: "invariant" }), opts);
		expect(inv.fidelity).toBe("F1");
	});

	it("defaults unknown items to F1 (fail toward preservation)", () => {
		const c = classifyItem(item({ id: "6", content: "hello there, nothing notable here" }), opts);
		expect(c.fidelity).toBe("F1");
		expect(c.ruleId).toBe("default");
		expect(c.preserved).toBe(true);
	});
});

describe("context-hygiene / F2 evidence-backed projectable", () => {
	it("classifies code, diffs and stack traces as F2 with projection transforms", () => {
		const code = classifyItem(item({ id: "7", content: "```ts\nconst x = 1;\n```", type: "code" }), opts);
		expect(code.fidelity).toBe("F2");
		expect(code.allowedTransforms).toContain("expand-on-demand");
		expect(classifyItem(item({ id: "8", content: "diff --git a/x b/x\n@@ -1 +1 @@" }), opts).fidelity).toBe("F2");
		expect(code.preserved).toBe(false);
	});
});

describe("context-hygiene / F3 optional-compressible", () => {
	it("classifies episodic chatter and superseded notes as F3", () => {
		const chat = classifyItem(item({ id: "9", content: "chatting about lunch", type: "episodic" }), opts);
		expect(chat.fidelity).toBe("F3");
		expect(classifyItem(item({ id: "10", content: "this note is now superseded by v2" }), opts).fidelity).toBe("F3");
		expect(isPreserved("F3")).toBe(false);
	});
});

describe("context-hygiene / F4 reject-before-context", () => {
	it("drops explicitly rejected and out-of-scope content", () => {
		expect(classifyItem(item({ id: "11", content: "random spam", reject: true }), opts).fidelity).toBe("F4");
		const oos = classifyItem(item({ id: "12", content: "weather forecast", type: "out-of-scope" }), opts);
		expect(oos.fidelity).toBe("F4");
		expect(oos.allowedTransforms).toEqual(["drop"]);
	});
});

describe("context-hygiene / no-compression zones (rule #15)", () => {
	it("pins allowed transforms to none regardless of class", () => {
		const c = classifyItem(item({ id: "13", content: "chatter", type: "episodic", noCompression: true }), opts);
		expect(c.fidelity).toBe("F3"); // class is retained for ordering/coverage
		expect(c.allowedTransforms).toEqual(["none"]);
		expect(c.noCompression).toBe(true);
	});
});

describe("context-hygiene / provenance retention", () => {
	it("retains origin id, source and upstream chain, and stamps classifier metadata", () => {
		const c = classifyItem(
			item({
				id: "14",
				content: "decided to ship",
				source: "memory-fabric/decisions",
				provenance: { chain: ["a", "b"] },
			}),
			opts,
		);
		expect(c.provenance.originId).toBe("14");
		expect(c.provenance.source).toBe("memory-fabric/decisions");
		expect(c.provenance.chain).toEqual(["a", "b"]);
		expect(c.provenance.ruleId).toBe("f1-authoritative");
		expect(c.provenance.classifier).toBe("acf-fidelity-classifier");
		expect(c.provenance.classifiedAt).toBe("2026-07-22T12:00:00.000Z");
	});
});

describe("context-hygiene / fail-safe", () => {
	it("never throws and fails safe to F0 when a rule throws", () => {
		const boom: ClassificationRule[] = [
			{
				id: "boom",
				class: "F3",
				reason: "x",
				match: () => {
					throw new Error("boom");
				},
			},
		];
		const c = classifyItem(item({ id: "15", content: "anything" }), { rules: boom, now: clock });
		expect(c.fidelity).toBe("F0");
		expect(c.ruleId).toBe("fail-safe");
		expect(c.preserved).toBe(true);
	});
});

describe("context-hygiene / batch", () => {
	it("classifies a batch preserving input order", () => {
		const out = classifyItems(
			[item({ id: "x", content: "exit code 2" }), item({ id: "y", content: "chatter", type: "episodic" })],
			opts,
		);
		expect(out.map(o => o.id)).toEqual(["x", "y"]);
		expect(out.map(o => o.fidelity)).toEqual(["F0", "F3"]);
	});
});
