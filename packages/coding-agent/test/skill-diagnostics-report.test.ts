import { expect, it } from "bun:test";
import type { Skill, SkillDiagnostic } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { formatSkillDiagnostics } from "@oh-my-pi/pi-coding-agent/modes/utils/skill-diagnostics";

it("counts conflicts separately from copies and safely explains defaults, aliases, and redundancy", () => {
	const skill = (name: string, filePath: string): Skill => ({
		name,
		filePath,
		baseDir: "/skill-store",
		description: "Fixture instructions",
		source: "custom:user",
	});
	const hostileName = "\x1b]0;spoofed title\x07design\nINJECTED";
	const selected = skill(hostileName, "/skill-store/default/SKILL.md");
	const variant = skill(`fork/${hostileName}`, "/skill-store/variant/SKILL.md");
	const retained = skill("review", "/skill-store/retained/SKILL.md");
	const diagnostics: SkillDiagnostic[] = [
		{ name: hostileName, reason: "custom-directory", skills: [selected, variant], duplicates: [] },
		{
			name: "review",
			reason: "source-order",
			skills: [retained],
			duplicates: [
				{ skill: skill("review", "/skill-store/mirror-one/SKILL.md"), retained },
				{ skill: skill("review", "/skill-store/mirror-two/SKILL.md"), retained },
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
	const report = formatSkillDiagnostics(diagnostics);
	expect(report).toContain("2 conflicting names; 2 redundant copies");
	expect(report).toMatch(/Selection:.*[Cc]ustom directory/);
	expect(report).toContain("Identical to: review (/skill-store/retained/SKILL.md)");
	expect(report).toContain("No bare default");
	expect(report).toContain("Variant: first/testing");
	expect(report).toContain("Variant: second/testing");
	expect(report).not.toContain("Default: testing");
	expect(report).not.toMatch(/[\x1b\x07\t\r]/);
	expect(report.split("\n")).not.toContain("INJECTED");
	expect(report).toContain("design INJECTED");
	expect(report).not.toContain("spoofed title");
});
