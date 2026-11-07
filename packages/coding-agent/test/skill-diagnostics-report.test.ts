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

it("names a plugin's declared origin and tells same-origin variants apart from identical copies", () => {
	const pluginSkill = (name: string, filePath: string, repository: string, version: string): Skill => ({
		name,
		filePath,
		baseDir: "/plugins",
		description: "Fixture instructions",
		source: "omp-plugins:user",
		_source: {
			provider: "omp-plugins",
			providerName: "OMP Plugins",
			path: filePath,
			level: "user",
			provenance: { repository, version },
		},
	});
	const upstream = pluginSkill("brainstorm", "/plugins/upstream/SKILL.md", "github.com/acme/tools", "2.0.0");
	const fork = pluginSkill("fork/brainstorm", "/plugins/fork/SKILL.md", "github.com/acme/tools", "1.9.0");
	const unrelated = pluginSkill("other/brainstorm", "/plugins/other/SKILL.md", "github.com/else/kit", "1.0.0");
	const hidden = pluginSkill("review", "/plugins/old/SKILL.md", "github.com/acme/tools", "1.0.0");
	const kept = pluginSkill("review", "/plugins/new/SKILL.md", "github.com/acme/tools", "2.0.0");
	const report = formatSkillDiagnostics([
		{ name: "brainstorm", reason: "source-order", skills: [upstream, fork, unrelated], duplicates: [] },
		{
			name: "review",
			reason: "source-order",
			skills: [kept],
			duplicates: [{ skill: hidden, retained: kept, match: "origin" }],
		},
	]);
	expect(report).toContain("Origin: github.com/acme/tools 2.0.0");
	expect(report).toContain("Origin: github.com/acme/tools 1.9.0");
	// Only the variant sharing the default's origin is flagged as hideable.
	expect(report.match(/skills\.dedupeSameOrigin would hide/g)).toHaveLength(1);
	expect(report).toMatch(/Variant: fork\/brainstorm[\s\S]*would hide[\s\S]*Variant: other\/brainstorm/);
	expect(report).toContain("Same-origin variant: review");
	expect(report).toContain("Hidden in favor of: review (/plugins/new/SKILL.md)");
	expect(report).not.toContain("Identical to: review");
});
