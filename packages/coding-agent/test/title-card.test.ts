import { describe, expect, it } from "bun:test";
import {
	keepTitleCard,
	parseCardReply,
	parseCardTitleReply,
	splitCardTitle,
} from "@oh-my-pi/pi-coding-agent/utils/title-card";

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

describe("parseCardReply", () => {
	it("picks the icon the style allows", () => {
		expect(parseCardReply("nf-md-flask 🧪 FLAKY", "nf+emoji")).toEqual({ icon: "\u{f0093}", code: "FLAKY" });
		expect(parseCardReply("nf-md-flask 🧪 FLAKY", "emoji")).toEqual({ icon: "🧪", code: "FLAKY" });
		expect(parseCardReply("nf-md-not-a-glyph 🧪 FLAKY", "nf+emoji")).toEqual({ icon: "🧪", code: "FLAKY" });
	});

	it("finds a Nerd Fonts name written with dashes for underscores", () => {
		expect(parseCardReply("nf-md-text-box 📝 BLUR", "nf+emoji")).toEqual({ icon: "\u{f021a}", code: "BLUR" });
	});

	it("repairs a lowercase code and ignores the title echoed after it", () => {
		expect(parseCardReply("🗄 seed: Create seed data", "emoji")).toEqual({ icon: "🗄️", code: "SEED" });
	});

	it.each([
		["no icon", "FLAKY"],
		["no code", "🧪"],
		["a code longer than 6", "🧪 FLAKIEST"],
		["a word before the icon", "Card 🧪 FLAKY"],
	])("names no card for %s", (_case, reply) => {
		expect(parseCardReply(reply, "emoji")).toBeUndefined();
	});

	it("names no card when the style is boring", () => {
		expect(parseCardReply("🧪 FLAKY", "boring")).toBeUndefined();
	});
});

describe("keepTitleCard", () => {
	it("heads the new title with the current card, replacing one the new title brings", () => {
		expect(keepTitleCard("🧪 CACHE: Fix cache writes", "Repair cache")).toBe("🧪 CACHE: Repair cache");
		expect(keepTitleCard("🧪 CACHE: Fix cache writes", "🔥 NEW: Repair cache")).toBe("🧪 CACHE: Repair cache");
	});

	it("leaves the new title alone when the current title has no card", () => {
		expect(keepTitleCard("Fix cache writes", "🔥 NEW: Repair cache")).toBe("🔥 NEW: Repair cache");
		expect(keepTitleCard(undefined, "Repair cache")).toBe("Repair cache");
	});
});
