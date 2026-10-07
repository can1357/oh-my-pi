import { describe, expect, it } from "bun:test";
import { parseCardTitleReply, splitCardTitle } from "@oh-my-pi/pi-coding-agent/utils/title-card";

describe("parseCardTitleReply", () => {
	const reply = '<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>';

	it("heads the title with the icon the style allows", () => {
		expect(parseCardTitleReply(reply, "nf+emoji")).toBe("\u{f0093} FLAKY: Fix flaky park tests");
		expect(parseCardTitleReply(reply, "emoji")).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(parseCardTitleReply(reply, "boring")).toBe("Fix flaky park tests");
	});

	it("falls back to the emoji for a Nerd Fonts name the catalog does not know", () => {
		// A real hallucination from the prompt workshop.
		expect(
			parseCardTitleReply(
				'<title nf="nf-dev-git_cherry_pick" emoji="🍒" code="CHERRY">Review and cherry-pick commit a6a017e</title>',
				"nf+emoji",
			),
		).toBe("🍒 CHERRY: Review and cherry-pick commit a6a017e");
	});

	it("keeps the plain title when the card has no icon the style shows", () => {
		expect(parseCardTitleReply('<title nf="nf-md-flask" code="FLAKY">Fix flaky park tests</title>', "emoji")).toBe(
			"Fix flaky park tests",
		);
	});

	it.each([
		["a decline", "<title/>"],
		["a decline with attributes", '<title emoji="🧪" code="X" />'],
		["a reply without a tag", "I'll start by reading the park tests."],
		["an unclosed tag", '<title emoji="🧪" code="FLAKY">Fix flaky park tests'],
		["a title the normalizer rejects", '<title emoji="🧪" code="DOTS">..</title>'],
	])("names no title for %s", (_case, reply) => {
		expect(parseCardTitleReply(reply, "emoji")).toBeNull();
	});

	it.each([
		["a code longer than 6", '<title nf="nf-md-flask" emoji="🧪" code="FLAKIEST">Fix flaky tests</title>'],
		["a code with punctuation", '<title emoji="🧪" code="FL-KY">Fix flaky tests</title>'],
		[
			"no icon the card form can show",
			'<title nf="nf-md-not_a_glyph" emoji="flask" code="FLAKY">Fix flaky tests</title>',
		],
		["a keycap emoji, which starts with ASCII", '<title emoji="#️⃣" code="HASH">Fix flaky tests</title>'],
		["two emoji", '<title emoji="🧪🧪" code="FLAKY">Fix flaky tests</title>'],
	])("keeps a plain title for %s", (_case, reply) => {
		expect(parseCardTitleReply(reply, "nf+emoji")).toBe("Fix flaky tests");
	});

	it("repairs a lowercase code and an emoji missing its variation selector", () => {
		expect(parseCardTitleReply('<title emoji="🗄" code="seed">Create seed data</title>', "emoji")).toBe(
			"🗄️ SEED: Create seed data",
		);
	});

	it("reads the line card form inside a plain tag, but not an ordinary title with a colon", () => {
		expect(parseCardTitleReply("<title>🗄️ Z3: Exclude z3 from bun test</title>", "emoji")).toBe(
			"🗄️ Z3: Exclude z3 from bun test",
		);
		expect(parseCardTitleReply("<title>Fix: the parser</title>", "emoji")).toBe("Fix: the parser");
	});

	it("reconciles the title's casing against the user's message", () => {
		expect(
			parseCardTitleReply(
				'<title emoji="🦀" code="VMM">Port tinyvmm to arm64</title>',
				"emoji",
				"port TinyVMM to arm64",
			),
		).toBe("🦀 VMM: Port TinyVMM to arm64");
	});
});

describe("splitCardTitle", () => {
	it("takes apart a card title headed by an emoji or a Nerd Fonts glyph", () => {
		expect(splitCardTitle("🧪 FLAKY: Fix flaky park tests")).toEqual({
			icon: "🧪",
			code: "FLAKY",
			title: "Fix flaky park tests",
		});
		expect(splitCardTitle("\u{f0093} FLAKY: Fix flaky park tests")?.icon).toBe("\u{f0093}");
	});

	it.each([
		["a plain title", "Fix flaky park tests"],
		["an ASCII prefix before a colon", "Fix BUG: the parser"],
		["a lowercase code", "🧪 flaky: Fix flaky park tests"],
		["a code longer than 6", "🧪 FLAKIEST: Fix flaky park tests"],
	])("leaves %s whole", (_case, title) => {
		expect(splitCardTitle(title)).toBeUndefined();
	});
});
