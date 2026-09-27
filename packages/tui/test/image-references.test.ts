import { describe, expect, it } from "bun:test";
import {
	chipLabel,
	collapseImageMarkers,
	collapseModelMentions,
	collapseSkillTokens,
	compactImageMarkers,
	composerTokenRegex,
	modelMentionChipLabel,
	type PlaceholderKind,
	renderPlaceholders,
	shiftImageMarkers,
	skillChipLabel,
} from "@oh-my-pi/pi-tui/prompt/composer-attachments";

function capture(
	text: string,
	mentionLabels: readonly string[] = [],
): {
	out: string;
	refs: Array<{ label: string; kind: PlaceholderKind; index: number; form: "marker" | "chip" }>;
	skills: string[];
	mentions: string[];
} {
	const refs: Array<{ label: string; kind: PlaceholderKind; index: number; form: "marker" | "chip" }> = [];
	const skills: string[] = [];
	const mentions: string[] = [];
	const out = renderPlaceholders(
		text,
		{
			renderText: t => t,
			renderReference: (label, kind, index, form) => {
				refs.push({ label, kind, index, form });
				return `<${kind}:${index}>`;
			},
			renderSkill: (_label, name) => {
				skills.push(name);
				return `<skill:${name}>`;
			},
			renderMention: label => {
				mentions.push(label);
				return `<model:${label}>`;
			},
		},
		composerTokenRegex(mentionLabels),
	);
	return { out, refs, skills, mentions };
}

describe("renderPlaceholders", () => {
	it("classifies image and paste markers with their index and full label", () => {
		const { out, refs } = capture("see [Image #1, 800x600] then [Paste #2, +30 lines] done");
		expect(refs).toEqual([
			{ label: "[Image #1, 800x600]", kind: "image", index: 1, form: "marker" },
			{ label: "[Paste #2, +30 lines]", kind: "paste", index: 2, form: "marker" },
		]);
		expect(out).toBe("see <image:1> then <paste:2> done");
	});

	it("matches the bare image form and the char-count paste form", () => {
		expect(capture("[Image #3]").refs[0]).toMatchObject({ kind: "image", index: 3 });
		expect(capture("[Paste #4, 1500 chars]").refs[0]).toMatchObject({ kind: "paste", index: 4 });
	});

	it("passes plain text straight through renderText with no references", () => {
		const { out, refs } = capture("no markers here");
		expect(refs).toHaveLength(0);
		expect(out).toBe("no markers here");
	});

	it("does not treat an unterminated marker as a reference", () => {
		// This is the half-eaten state atomic deletion prevents — it must render as plain text.
		const { refs } = capture("[Paste #1, +30 lines");
		expect(refs).toHaveLength(0);
	});

	it("preserves the adjacent attachment URI as plain text", () => {
		expect(capture("[Image #1, 800x600] attachment://1").out).toBe("<image:1> attachment://1");
	});

	it("classifies compact chip tokens with their kind, index, and chip form", () => {
		const { out, refs } = capture(`see ${chipLabel("image", 2)} and ${chipLabel("paste", 1)} done`);
		expect(refs).toEqual([
			{ label: chipLabel("image", 2), kind: "image", index: 2, form: "chip" },
			{ label: chipLabel("paste", 1), kind: "paste", index: 1, form: "chip" },
		]);
		expect(out).toBe("see <image:2> and <paste:1> done");
	});

	it("reports bracketed markers as marker form", () => {
		expect(capture("[Image #1]").refs[0]?.form).toBe("marker");
	});

	it("recognizes chip tokens from every symbol preset", () => {
		// A draft written under the nerd or ascii preset must stay a reference after
		// the user switches presets — otherwise atomic deletion and styling break.
		expect(capture("\uf03e #3").refs[0]).toMatchObject({ kind: "image", index: 3, form: "chip" });
		expect(capture("img #3").refs[0]).toMatchObject({ kind: "image", index: 3, form: "chip" });
		expect(capture("txt #2").refs[0]).toMatchObject({ kind: "paste", index: 2, form: "chip" });
	});

	it("does not treat a word ending in an ascii icon as a chip token", () => {
		expect(capture("boximg #1").refs).toHaveLength(0);
	});

	it("routes skill chips to renderSkill with the bare name, stopping at punctuation", () => {
		const { out, skills, refs } = capture(`use ${skillChipLabel("stencil-design")}, then ${skillChipLabel("v2.1")}.`);
		expect(skills).toEqual(["stencil-design", "v2.1"]);
		expect(refs).toHaveLength(0);
		expect(out).toBe("use <skill:stencil-design>, then <skill:v2.1>.");
	});

	it("recognizes skill chips from every symbol preset", () => {
		expect(capture("\uf0eb reviewer").skills).toEqual(["reviewer"]);
		expect(capture("SK reviewer").skills).toEqual(["reviewer"]);
		expect(capture("TASK reviewer").skills).toHaveLength(0);
	});

	it("routes registered model labels with spaces and parentheses as whole tokens", () => {
		const short = modelMentionChipLabel("Claude");
		const long = modelMentionChipLabel("Claude (Fast)");
		const { out, mentions, refs } = capture(`ask ${long} then ${short}`, [short, long]);
		expect(mentions).toEqual([long, short]);
		expect(refs).toHaveLength(0);
		expect(out).toBe(`ask <model:${long}> then <model:${short}>`);
	});

	it("dispatches an ASCII model label before bracketed attachment markers", () => {
		const label = "[M] Claude (Fast)";
		const { out, mentions, refs } = capture(`ask ${label} now`, [label]);
		expect(mentions).toEqual([label]);
		expect(refs).toHaveLength(0);
		expect(out).toBe(`ask <model:${label}> now`);
	});
});

describe("collapseModelMentions", () => {
	const labelFor = (selector: string) => (selector === "a/x" ? modelMentionChipLabel("X One") : undefined);

	it("collapses known whitespace-delimited selectors and registers their canonical expansion", () => {
		const registered: Array<[string, string]> = [];
		const out = collapseModelMentions("ask ^a/x now", labelFor, (label, expansion) =>
			registered.push([label, expansion]),
		);
		expect(out).toBe(`ask ${modelMentionChipLabel("X One")} now`);
		expect(registered).toEqual([[modelMentionChipLabel("X One"), "^a/x"]]);
	});

	it("keeps unknown and punctuation-attached selectors literal", () => {
		expect(collapseModelMentions("^nope/z and ^a/x,", labelFor, () => {})).toBe("^nope/z and ^a/x,");
	});

	it("allows slash prompts but not local-execution drafts", () => {
		expect(collapseModelMentions("/plan ask ^a/x now", labelFor, () => {})).toBe(
			`/plan ask ${modelMentionChipLabel("X One")} now`,
		);
		expect(collapseModelMentions("!echo ^a/x", labelFor, () => {})).toBe("!echo ^a/x");
		expect(collapseModelMentions("$ echo ^a/x", labelFor, () => {})).toBe("$ echo ^a/x");
	});
});

describe("collapseSkillTokens", () => {
	const known = (name: string) => name === "reviewer";

	it("collapses known skill tokens into chips and registers the canonical token as expansion", () => {
		const registered: Array<[string, string]> = [];
		const out = collapseSkillTokens("fix it /skill:reviewer now", known, (label, expansion) =>
			registered.push([label, expansion]),
		);
		expect(out).toBe(`fix it ${skillChipLabel("reviewer")} now`);
		expect(registered).toEqual([[skillChipLabel("reviewer"), "/skill:reviewer"]]);
	});

	it("leaves unknown skills and glued tokens as literal text", () => {
		expect(collapseSkillTokens("/skill:nope and x/skill:reviewer", known, () => {})).toBe(
			"/skill:nope and x/skill:reviewer",
		);
	});

	it("does not collapse inside a bash or foreign slash-command draft", () => {
		expect(collapseSkillTokens("!echo /skill:reviewer", known, () => {})).toBe("!echo /skill:reviewer");
		expect(collapseSkillTokens("/compact /skill:reviewer", known, () => {})).toBe("/compact /skill:reviewer");
	});
});

describe("collapseImageMarkers", () => {
	it("collapses bracketed markers into chip tokens and registers their expansions", () => {
		const registered: Array<[string, string]> = [];
		const out = collapseImageMarkers("see [Image #1, 800x600] end", 1, (label, expansion) =>
			registered.push([label, expansion]),
		);
		expect(out).toBe(`see ${chipLabel("image", 1)} end`);
		expect(registered).toEqual([[chipLabel("image", 1), "[Image #1, 800x600]"]]);
	});

	it("strips a legacy trailing attachment URI while collapsing", () => {
		const out = collapseImageMarkers("[Image #1] attachment://1 tail", 1, () => {});
		expect(out).toBe(`${chipLabel("image", 1)} tail`);
	});

	it("leaves markers beyond the pending image count as plain text", () => {
		// Prose about an earlier message's image must not become a live chip.
		const out = collapseImageMarkers("[Image #2] is from before", 1, () => {});
		expect(out).toBe("[Image #2] is from before");
	});
});

describe("compactImageMarkers", () => {
	it("returns null when every pending image is still referenced", () => {
		expect(compactImageMarkers("[Image #1] [Image #2]", 2)).toBeNull();
	});

	it("renumbers surviving markers densely and reports kept indices after a middle deletion", () => {
		const result = compactImageMarkers("[Image #1, 10x10] and [Image #3]", 3);
		expect(result).toEqual({ text: "[Image #1, 10x10] and [Image #2]", keep: [0, 2] });
	});

	it("drops every image when no marker references one", () => {
		expect(compactImageMarkers("no references", 2)).toEqual({ text: "no references", keep: [] });
	});

	it("leaves out-of-range references untouched while compacting", () => {
		const result = compactImageMarkers("[Image #2] mentions [Image #9]", 2);
		expect(result).toEqual({ text: "[Image #1] mentions [Image #9]", keep: [1] });
	});

	it("renumbers a legacy attachment URI alongside its marker", () => {
		const result = compactImageMarkers("[Image #2] attachment://2", 2);
		expect(result).toEqual({ text: "[Image #1] attachment://1", keep: [1] });
	});
});

describe("shiftImageMarkers", () => {
	it("returns text unchanged when the offset is zero", () => {
		const text = "[Image #1] attachment://1 then [Image #2, 100x100] attachment://2";
		expect(shiftImageMarkers(text, 0)).toBe(text);
	});

	it("renumbers an image marker and its attachment URI by the offset", () => {
		expect(shiftImageMarkers("see [Image #1, 800x600] attachment://1", 3)).toBe(
			"see [Image #4, 800x600] attachment://4",
		);
	});

	it("does not shift unrelated attachment URI text", () => {
		expect(shiftImageMarkers("attachment://1 then [Image #1] attachment://9 and attachment://2", 3)).toBe(
			"attachment://1 then [Image #4] attachment://9 and attachment://2",
		);
	});

	it("shifts multiple image marker and URI pairs exactly once", () => {
		expect(shiftImageMarkers("[Image #1] attachment://1 then [Image #2, 100x100] attachment://2", 2)).toBe(
			"[Image #3] attachment://3 then [Image #4, 100x100] attachment://4",
		);
	});

	it("never touches Paste markers", () => {
		expect(shiftImageMarkers("[Image #1] [Paste #1, +5 lines]", 2)).toBe("[Image #3] [Paste #1, +5 lines]");
	});
});
