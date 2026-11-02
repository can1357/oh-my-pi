import { describe, expect, it } from "bun:test";
import { compileRuleCondition } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

/**
 * Regression coverage for issue #4796: a rule with a leading `(?i)` inline regex
 * flag and (separately) malformed `scope` frontmatter silently failed to
 * register, so it could never fire.
 */
describe("TTSR inline flags + scope quoting (#4796)", () => {
	it("translates leading (?i) into a case-insensitive RegExp", () => {
		const regex = compileRuleCondition("(?i)pre.existing");
		expect(regex.flags).toBe("i");
		expect(regex.test("These are Pre-existing failures")).toBe(true);
	});

	it("passes through patterns without a leading inline flag group verbatim", () => {
		const regex = compileRuleCondition("pre.existing");
		expect(regex.flags).toBe("");
		expect(regex.test("pre-existing")).toBe(true);
		expect(regex.test("PRE-EXISTING")).toBe(false);
	});

	it("does not treat a mid-pattern (?...) group as an inline flag prefix", () => {
		// `(?:...)` is a non-capturing group, not an inline flag directive.
		const regex = compileRuleCondition("foo(?:bar)");
		expect(regex.flags).toBe("");
		expect(regex.test("foobar")).toBe(true);
	});

	it("pins pure whole-buffer lookahead sequences to index zero", () => {
		// Exact high-cost condition from the profile attached to issue #12261.
		const pattern = String.raw`(?=[\s\S]*"op"\s*:\s*"wait")(?=[\s\S]*\b(?:[Cc][Ii]|[Pp]ipeline(?:s)?|[Pp]olic(?:y|ies)|[Pp][Rr]\s+[Cc]heck(?:s)?)\b)`;
		const regex = compileRuleCondition(pattern);

		expect(regex.sticky).toBe(true);
		expect(regex.test('prefix { "op": "wait", "reason": "CI pending" }')).toBe(true);
	});

	it("keeps the whole-buffer optimization equivalent across nested regex syntax", () => {
		const patterns = [
			String.raw`(?=[\s\S]*foo(?:bar|baz))`,
			String.raw`(?=[\s\S]*foo\(bar\))(?=[\s\S]*[()])`,
			String.raw`(?=[\s\S]*^heading$)`,
		];
		const samples = ["", "prefix foobar", "foo(baz)", "before\nheading\nafter", "unrelated"];
		for (const pattern of patterns) {
			const optimized = compileRuleCondition(`(?m)${pattern}`);
			const original = new RegExp(pattern, "m");
			expect(optimized.sticky).toBe(true);
			for (const sample of samples) {
				optimized.lastIndex = 0;
				original.lastIndex = 0;
				expect(optimized.test(sample)).toBe(original.test(sample));
			}
		}
	});

	it("does not pin conditions that consume input outside the lookaheads", () => {
		const regex = compileRuleCondition(String.raw`(?=[\s\S]*foo)bar`);

		expect(regex.sticky).toBe(false);
		expect(regex.test("prefix bar foo")).toBe(true);
	});

	it("does not pin lazy whole-buffer lookaheads whose captures depend on the start position", () => {
		const pattern = String.raw`(?=[\s\S]*?(a|b))(?=[\s\S]*\1c)`;
		const regex = compileRuleCondition(pattern);

		expect(regex.sticky).toBe(false);
		expect(regex.test("a x bc")).toBe(true);
	});

	it("registers and fires the reporter's exact rule end-to-end", () => {
		// Reporter's frontmatter verbatim: leading (?i) condition + malformed
		// `scope: "text","thinking"` (not valid YAML, forces the fallback path).
		const content = [
			"---",
			"name: fix-failures-now",
			"description: prohibits pre-existing classification.",
			'condition: "(?i)(pre.existing|also fails on master|check.*master.*first)"',
			'scope: "text","thinking"',
			"---",
			"body",
		].join("\n");

		const source = createSourceMeta("test", "fix-failures-now.md", "project");
		const rule = buildRuleFromMarkdown("fix-failures-now.md", content, "fix-failures-now.md", source);

		// Malformed scope recovers to canonical tokens (no literal quotes).
		expect(rule.scope).toEqual(["text", "thinking"]);
		// Condition survives the fallback without literal surrounding quotes.
		expect(rule.condition).toEqual(["(?i)(pre.existing|also fails on master|check.*master.*first)"]);

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		expect(
			manager
				.checkSnapshot("The CI failure was 4 pre-existing GPS map VR mismatches", { source: "thinking" })
				.map(r => r.name),
		).toEqual(["fix-failures-now"]);

		expect(
			manager.checkSnapshot("Everything also fails on master anyway", { source: "text" }).map(r => r.name),
		).toEqual(["fix-failures-now"]);
	});
});
