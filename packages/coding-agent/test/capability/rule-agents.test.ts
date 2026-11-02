import { describe, expect, it } from "bun:test";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

describe("agents frontmatter normalization", () => {
	it("lowercases a YAML sequence", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: [Scout, "foreman-*"]\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toEqual(["scout", "foreman-*"]);
	});

	it("splits a comma-separated string the same way", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: "scout, foreman-*"\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toEqual(["scout", "foreman-*"]);
	});

	it("normalizes an empty list to undefined", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: []\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toBeUndefined();
	});

	it("tolerates whitespace around commas inside a brace group", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: "{scout, reviewer}"\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toEqual(["{scout,reviewer}"]);
	});
});
