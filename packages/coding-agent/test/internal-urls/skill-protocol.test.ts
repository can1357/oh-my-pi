import { afterEach, describe, expect, it } from "bun:test";
import { resetActiveSkillsForTests, setActiveSkills } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";

describe("SkillProtocolHandler bare listing", () => {
	afterEach(() => {
		resetActiveSkillsForTests();
	});

	it("lists visible skill names without descriptions for bare skill://", async () => {
		setActiveSkills([
			{
				name: "alpha",
				description: "First skill",
				filePath: "/skills/alpha/SKILL.md",
				baseDir: "/skills/alpha",
				source: "test",
			},
			{
				name: "hidden-one",
				description: "Opt-in only",
				filePath: "/skills/hidden-one/SKILL.md",
				baseDir: "/skills/hidden-one",
				source: "test",
				hide: true,
			},
		]);

		const resource = await InternalUrlRouter.instance().resolve("skill://");
		expect(resource.content).toContain("# Skills (1)");
		expect(resource.content).toContain("- alpha");
		expect(resource.content).not.toContain("First skill");
		expect(resource.content).not.toContain("hidden-one");
		expect(resource.content).toContain("skill://?q=<keywords>");
		expect(resource.content).toContain("skill://<name>");
	});

	it("reports an empty catalog without erroring", async () => {
		setActiveSkills([]);
		const resource = await InternalUrlRouter.instance().resolve("skill://");
		expect(resource.content).toContain("(no skills available)");
	});

	it("searches skill descriptions with a focused query", async () => {
		setActiveSkills([
			{
				name: "docker-repair",
				description: "Repair Docker Compose networking failures",
				filePath: "/skills/docker-repair/SKILL.md",
				baseDir: "/skills/docker-repair",
				source: "test",
			},
			{
				name: "calendar-audit",
				description: "Audit field calendar entries",
				filePath: "/skills/calendar-audit/SKILL.md",
				baseDir: "/skills/calendar-audit",
				source: "test",
			},
		]);

		const resource = await InternalUrlRouter.instance().resolve("skill://?q=compose");
		expect(resource.content).toContain("# Skill Search: compose");
		expect(resource.content).toContain("- docker-repair: Repair Docker Compose networking failures");
		expect(resource.content).not.toContain("calendar-audit");
	});
});
