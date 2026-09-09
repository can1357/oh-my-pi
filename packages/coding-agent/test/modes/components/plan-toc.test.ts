import { describe, expect, it } from "bun:test";
import {
	joinPlanSections,
	type PlanSection,
	parsePlanSections,
	sectionDeletionSpan,
	stripInlineMarkdown,
} from "@oh-my-pi/pi-coding-agent/modes/components/plan-toc";

const titles = (sections: readonly PlanSection[]): string[] => sections.map(s => s.title);
const levels = (sections: readonly PlanSection[]): number[] => sections.map(s => s.level);

describe("parsePlanSections", () => {
	it("splits a preamble and one section per ATX heading, tracking depth", () => {
		const sections = parsePlanSections("intro\n\n# Overview\n\nbody\n\n## Goal\n\ngoal\n\n# Risks\n\nrisk\n");
		expect(levels(sections)).toEqual([0, 1, 2, 1]);
		expect(titles(sections)).toEqual(["", "Overview", "Goal", "Risks"]);
		// Preamble is the only level-0 section; it carries no title.
		expect(sections[0]!.raw).toBe("intro\n\n");
	});

	it("emits no preamble section when the document opens with a heading", () => {
		const sections = parsePlanSections("# Top\n\nbody\n");
		expect(levels(sections)).toEqual([1]);
		expect(sections[0]!.title).toBe("Top");
	});

	it("does not treat '#' inside fenced code blocks as a heading", () => {
		const sections = parsePlanSections("# Real\n\n```\n# not a heading\n```\n\n~~~\n## also not\n~~~\n");
		expect(levels(sections)).toEqual([1]);
		expect(titles(sections)).toEqual(["Real"]);
	});

	it("requires whitespace after the hashes, so '#tag' is body text", () => {
		const sections = parsePlanSections("#tag is not a heading\nmore body\n");
		expect(levels(sections)).toEqual([0]);
	});

	it("strips inline markdown and closing hashes from titles", () => {
		const sections = parsePlanSections("## **Goal** & [docs](http://x) ##\n\nbody\n");
		expect(sections[0]!.title).toBe("Goal & docs");
	});
});

describe("joinPlanSections", () => {
	it("round-trips a newline-terminated document", () => {
		const text = "intro\n\n# A\n\nbody a\n\n## A1\n\nnested\n\n# B\n\nbody b\n";
		expect(joinPlanSections(parsePlanSections(text))).toBe(text);
	});

	it("guarantees a single trailing newline when the source lacks one", () => {
		expect(joinPlanSections(parsePlanSections("# A\n\nbody"))).toBe("# A\n\nbody\n");
	});

	it("returns an empty string for an empty document", () => {
		expect(joinPlanSections(parsePlanSections(""))).toBe("");
	});
});

describe("sectionDeletionSpan", () => {
	const sections = parsePlanSections("intro\n\n# A\n\na\n\n## A1\n\na1\n\n## A2\n\na2\n\n# B\n\nb\n");
	// Indices: 0 preamble, 1 A(L1), 2 A1(L2), 3 A2(L2), 4 B(L1)

	it("removes a heading together with its deeper-nested children", () => {
		expect(sectionDeletionSpan(sections, 1)).toEqual([1, 2, 3]);
	});

	it("removes only a leaf section", () => {
		expect(sectionDeletionSpan(sections, 2)).toEqual([2]);
	});

	it("never targets the preamble", () => {
		expect(sectionDeletionSpan(sections, 0)).toEqual([]);
	});

	it("joining the surviving sections drops the deleted subtree", () => {
		const span = new Set(sectionDeletionSpan(sections, 1));
		const survivors = sections.filter((_, i) => !span.has(i));
		const result = joinPlanSections(survivors);
		expect(result).toContain("# B");
		expect(result).not.toContain("# A");
		expect(result).not.toContain("## A1");
	});
});

describe("stripInlineMarkdown", () => {
	it("collapses emphasis, code, links, and whitespace to readable text", () => {
		expect(stripInlineMarkdown("**bold** _it_ `code` [t](u)")).toBe("bold it code t");
		expect(stripInlineMarkdown("a   b\tc")).toBe("a b c");
	});
});
