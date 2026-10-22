import { expect, it } from "bun:test";
import type { Skill, SkillDiagnostic } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { summarizeSkillDiagnostics } from "@oh-my-pi/pi-coding-agent/modes/utils/skill-diagnostics";

it("counts conflicting names separately from redundant copies", () => {
	const skill = (name: string, filePath: string): Skill => ({
		name,
		filePath,
		baseDir: "/skill-store",
		description: "Fixture instructions",
		source: "custom:user",
	});
	const retained = skill("review", "/skill-store/retained/SKILL.md");
	const diagnostics: SkillDiagnostic[] = [
		{
			name: "design",
			reason: "custom-directory",
			skills: [
				skill("design", "/skill-store/default/SKILL.md"),
				skill("fork/design", "/skill-store/variant/SKILL.md"),
			],
			duplicates: [],
		},
		{
			name: "review",
			reason: "source-order",
			skills: [retained],
			duplicates: [
				{ skill: skill("review", "/skill-store/mirror-one/SKILL.md"), retained, match: "content" },
				{ skill: skill("review", "/skill-store/mirror-two/SKILL.md"), retained, match: "content" },
			],
		},
		{
			name: "testing",
			reason: "source-order",
			skills: [
				skill("first/testing", "/skill-store/first/SKILL.md"),
				skill("second/testing", "/skill-store/second/SKILL.md"),
			],
			duplicates: [],
		},
	];
	expect(summarizeSkillDiagnostics(diagnostics).conflicts).toBe(2);
});
