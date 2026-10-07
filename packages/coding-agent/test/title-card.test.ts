import { describe, expect, it } from "bun:test";
import { formatCardTitle, parseCardTitleReply } from "@oh-my-pi/pi-coding-agent/utils/title-card";

describe("parseCardTitleReply", () => {
	it("splits the tag form into the title and a card with a catalog-verified Nerd Fonts name", () => {
		expect(
			parseCardTitleReply('<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>'),
		).toEqual({ title: "Fix flaky park tests", card: { code: "FLAKY", emoji: "🧪", nf: "nf-md-flask" } });
	});

	it("drops a Nerd Fonts name the catalog does not know and keeps the emoji", () => {
		// A real hallucination from the prompt workshop.
		expect(
			parseCardTitleReply(
				'<title nf="nf-dev-git_cherry_pick" emoji="🍒" code="CHERRY">Review and cherry-pick commit a6a017e</title>',
			),
		).toEqual({ title: "Review and cherry-pick commit a6a017e", card: { code: "CHERRY", emoji: "🍒" } });
	});

	it.each([
		["a decline", "<title/>"],
		["a decline with attributes", '<title emoji="🧪" code="X" />'],
		["a reply without a tag", "I'll start by reading the park tests."],
		["an unclosed tag", '<title emoji="🧪" code="FLAKY">Fix flaky park tests'],
		["a title the normalizer rejects", '<title emoji="🧪" code="DOTS">..</title>'],
	])("names no title for %s", (_case, reply) => {
		expect(parseCardTitleReply(reply)).toBeNull();
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
		expect(parseCardTitleReply(reply)).toEqual({ title: "Fix flaky tests" });
	});

	it("repairs a lowercase code and an emoji missing its variation selector", () => {
		expect(parseCardTitleReply('<title emoji="🗄" code="seed">Create seed data</title>')).toEqual({
			title: "Create seed data",
			card: { code: "SEED", emoji: "🗄️" },
		});
	});

	it("reads the line card form inside a plain tag, but not an ordinary title with a colon", () => {
		expect(parseCardTitleReply("<title>🗄️ Z3: Exclude z3 from bun test</title>")).toEqual({
			title: "Exclude z3 from bun test",
			card: { code: "Z3", emoji: "🗄️" },
		});
		expect(parseCardTitleReply("<title>Fix: the parser</title>")).toEqual({ title: "Fix: the parser" });
	});

	it("reconciles the title's casing against the user's message", () => {
		expect(
			parseCardTitleReply('<title emoji="🦀" code="VMM">Port tinyvmm to arm64</title>', "port TinyVMM to arm64"),
		).toEqual({ title: "Port TinyVMM to arm64", card: { code: "VMM", emoji: "🦀" } });
	});
});

describe("formatCardTitle", () => {
	const card = { code: "FLAKY", emoji: "🧪", nf: "nf-md-flask" };

	it("shows the icon the style allows", () => {
		expect(formatCardTitle("Fix flaky park tests", card, "nf+emoji")).toBe("\u{f0093} FLAKY: Fix flaky park tests");
		expect(formatCardTitle("Fix flaky park tests", card, "emoji")).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(formatCardTitle("Fix flaky park tests", card, "boring")).toBe("Fix flaky park tests");
	});

	it("falls back to the plain title when the card has no icon to show", () => {
		expect(formatCardTitle("Fix flaky park tests", { code: "FLAKY", nf: "nf-md-flask" }, "emoji")).toBe(
			"Fix flaky park tests",
		);
	});
});
