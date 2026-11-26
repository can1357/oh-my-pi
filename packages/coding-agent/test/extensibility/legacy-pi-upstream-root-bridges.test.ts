import { describe, expect, it } from "bun:test";
import * as caShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

// Upstream pi-coding-agent exports `parseSkillBlock` from its package root
// (src/core/agent-session.ts). omp folds skill invocation into its own hook
// pipeline (no parser exported), so the name is ported into the compat layer;
// named imports of it from the aliased roots tripped Bun's static
// "Export named X not found" check (observed consumer: `pi-optchat`, which
// uses `parseSkillBlock` to match journaled skill invocations).
describe("legacy shim upstream-root bridges", () => {
	it("parseSkillBlock parses a skill block with its optional user message", () => {
		const parsed = caShim.parseSkillBlock('<skill name="commit" location="/skills/commit.md">\nbody text\n</skill>');
		expect(parsed).toEqual({
			name: "commit",
			location: "/skills/commit.md",
			content: "body text",
			userMessage: undefined,
		});
		const withMessage = caShim.parseSkillBlock(
			'<skill name="review" location="/skills/review.md">\nbody\n</skill>\n\nuser asked for review',
		);
		expect(withMessage?.userMessage).toBe("user asked for review");
		expect(caShim.parseSkillBlock("plain text")).toBeNull();
		expect(caShim.parseSkillBlock('<skill name="x" location="y">no trailing newline</skill>')).toBeNull();
	});

	it("formatSkillsForPrompt renders upstream's skills block and skips hidden skills", () => {
		const skill = (name: string, extra: Record<string, unknown> = {}) => ({
			name,
			description: 'uses <tags> and "quotes"',
			filePath: `/s/${name}/SKILL.md`,
			baseDir: `/s/${name}`,
			source: "user",
			...extra,
		});
		const skills = [skill("a&b"), skill("off", { disableModelInvocation: true }), skill("hidden", { hide: true })];
		// Upstream pi-coding-agent 1.3.0's layout; element text escapes `&`, `<` and `>` (quotes need none).
		expect(caShim.formatSkillsForPrompt(skills)).toBe(
			"\n\nThe following skills provide specialized instructions for specific tasks.\n" +
				"Use the read tool to load a skill's file when the task matches its description.\n" +
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n" +
				"\n" +
				"<available_skills>\n" +
				"  <skill>\n" +
				"    <name>a&amp;b</name>\n" +
				'    <description>uses &lt;tags&gt; and "quotes"</description>\n' +
				"    <location>/s/a&amp;b/SKILL.md</location>\n" +
				"  </skill>\n" +
				"</available_skills>",
		);
		expect(caShim.formatSkillsForPrompt(skills, "bash").split("\n")[3]).toBe(
			"Use bash to load a skill's file when the task matches its description.",
		);
		expect(caShim.formatSkillsForPrompt([])).toBe("");
		expect(caShim.formatSkillsForPrompt([skill("off", { disableModelInvocation: true })])).toBe("");
	});
});
