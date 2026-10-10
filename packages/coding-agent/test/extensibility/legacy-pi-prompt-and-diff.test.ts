import { describe, expect, it } from "bun:test";
import {
	formatSkillsForPrompt,
	generateDiffString,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy Pi skill prompt", () => {
	const skills = [
		{ name: "review&fix", description: `Check <changes> & "quotes" 'here'`, filePath: "/tmp/a&b/SKILL.md" },
		{
			name: "manual",
			description: "Explicit invocation only",
			filePath: "/tmp/manual/SKILL.md",
			disableModelInvocation: true,
		},
	];

	it("formats visible skills with Pi's XML contract and escapes every XML metacharacter", () => {
		const result = formatSkillsForPrompt(skills);
		// pi-claude-bridge rewrites this prefix to name its MCP read tool.
		expect(
			result.replace(
				"Use the read tool to load a skill's file",
				"Use the read tool (mcp__custom-tools__read) to load a skill's file",
			),
		).toContain("Use the read tool (mcp__custom-tools__read) to load a skill's file");
		expect(result).toContain("<available_skills>\n  <skill>");
		expect(result).toContain("<name>review&amp;fix</name>");
		expect(result).toContain(
			"<description>Check &lt;changes&gt; &amp; &quot;quotes&quot; &apos;here&apos;</description>",
		);
		expect(result).toContain("<location>/tmp/a&amp;b/SKILL.md</location>");
		expect(result).toMatch(/  <\/skill>\n<\/available_skills>$/);
		expect(result).not.toContain("manual");
	});

	it("selects bash when requested and omits skills disabled for model invocation", () => {
		expect(formatSkillsForPrompt(skills, "bash")).toContain("Use bash to load a skill's file");
		expect(formatSkillsForPrompt(skills.slice(1))).toBe("");
	});
});

describe("legacy Pi numbered diff", () => {
	it("returns the first new-file change line, bounded context, and old/new line numbers", () => {
		const oldText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
		const newText = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n";
		expect(generateDiffString(oldText, newText, 1)).toEqual({
			diff: "  1 one\n- 2 two\n+ 2 TWO\n  3 three\n    ...\n  8 eight\n- 9 nine\n+ 9 NINE\n 10 ten",
			firstChangedLine: 2,
		});
	});

	it("reports no change for identical texts and locates an insertion in the new file", () => {
		expect(generateDiffString("one\ntwo\n", "one\ntwo\n")).toEqual({ diff: "", firstChangedLine: undefined });
		expect(generateDiffString("one\ntwo\n", "one\ninserted\ntwo\n", 0)).toEqual({
			diff: "   ...\n+2 inserted\n   ...",
			firstChangedLine: 2,
		});
	});
});
