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
