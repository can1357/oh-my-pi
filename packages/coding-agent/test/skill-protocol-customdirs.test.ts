import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSkillMd(name: string, dir: string) {
	return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name} from ${dir}\n`;
}

const ALL_DEFAULT_SOURCES_DISABLED = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

describe("skill:// resolution honors skills.customDirectories (#7190)", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		resetActiveSkillsForTests();
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("resolves a skill loaded from a custom directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skills-"));
		tempDirs.push(tempDir);
		const skillDir = path.join(tempDir, "my-custom-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), makeSkillMd("my-custom-skill", tempDir));

		const { skills } = await loadSkills({
			...ALL_DEFAULT_SOURCES_DISABLED,
			customDirectories: [tempDir],
		});
		setActiveSkills(skills);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://my-custom-skill/"));
		expect(resource.sourcePath).toBe(path.join(skillDir, "SKILL.md"));
		expect(resource.content).toContain(`from ${tempDir}`);
	});

	it("reads semicolon-delimited lists across routed URL schemes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-delimited-skills-"));
		tempDirs.push(tempDir);
		for (const name of ["first-skill", "second-skill"]) {
			const skillDir = path.join(tempDir, name);
			await fs.mkdir(skillDir, { recursive: true });
			await Bun.write(path.join(skillDir, "SKILL.md"), makeSkillMd(name, tempDir));
		}

		const { skills } = await loadSkills({
			...ALL_DEFAULT_SOURCES_DISABLED,
			customDirectories: [tempDir],
		});
		setActiveSkills(skills);
		const session: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const result = await new ReadTool(session).execute("read-delimited-skills", {
			path: "skill://first-skill:1-3; skill://second-skill:1-3",
		});
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(text).toContain("Note: interpreted as 2 paths: skill://first-skill:1-3, skill://second-skill:1-3");
		expect(text).toContain("first-skill skill.");
		expect(text).toContain("second-skill skill.");

		const historyResult = await new ReadTool(session).execute("read-delimited-history", {
			path: "history://missing-first:1-3; history://missing-second:1-3",
		});
		const historyText = historyResult.content
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(historyText).toContain(
			"Note: interpreted as 2 paths: history://missing-first:1-3, history://missing-second:1-3",
		);
		expect(historyText).toContain("Could not read history://missing-first:1-3");
		expect(historyText).toContain("Could not read history://missing-second:1-3");
	});

	it("tails an in-memory internal resource with :-N", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tail-skill-"));
		tempDirs.push(tempDir);
		const skillDir = path.join(tempDir, "tail-skill");
		await fs.mkdir(skillDir, { recursive: true });
		const body = Array.from({ length: 30 }, (_, i) => `body-line-${i + 1}`).join("\n");
		await Bun.write(path.join(skillDir, "SKILL.md"), `${makeSkillMd("tail-skill", tempDir)}${body}\n`);

		const { skills } = await loadSkills({ ...ALL_DEFAULT_SOURCES_DISABLED, customDirectories: [tempDir] });
		setActiveSkills(skills);
		const session: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const result = await new ReadTool(session).execute("read-skill-tail", { path: "skill://tail-skill:-4" });
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

		// Last 4 body lines plus one leading context line; nothing earlier.
		expect(text).not.toContain("body-line-25");
		expect(text).toContain("body-line-26");
		expect(text).toContain("body-line-27");
		expect(text).toContain("body-line-30");
		expect(text).not.toContain("tail-skill skill.");
	});

	it("keeps first-wins across multiple custom directories", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-a-"));
		tempDirs.push(dirA);
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-b-"));
		tempDirs.push(dirB);
		const skillA = path.join(dirA, "same-name");
		const skillB = path.join(dirB, "same-name");
		await fs.mkdir(skillA, { recursive: true });
		await fs.mkdir(skillB, { recursive: true });
		await Bun.write(path.join(skillA, "SKILL.md"), makeSkillMd("same-name", dirA));
		await Bun.write(path.join(skillB, "SKILL.md"), makeSkillMd("same-name", dirB));

		const { skills, warnings } = await loadSkills({
			...ALL_DEFAULT_SOURCES_DISABLED,
			customDirectories: [dirA, dirB],
		});
		setActiveSkills(skills);

		const dup = skills.find(s => s.name === "same-name");
		expect(dup).toBeDefined();
		// Same-source (custom) duplicates keep first-wins: dirA claims the name.
		expect(dup!.filePath).toBe(path.join(skillA, "SKILL.md"));
		expect(warnings.some(w => w.message.includes("collision"))).toBe(true);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://same-name/"));
		expect(resource.sourcePath).toBe(path.join(skillA, "SKILL.md"));
	});

	it("lets a custom-directory skill override a same-named default-path skill", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-default-skill-"));
		tempDirs.push(cwd);
		const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skill-"));
		tempDirs.push(customDir);

		// A default discovery path (Claude project skills) claims the name first.
		const defaultSkill = path.join(cwd, ".claude", "skills", "shared-name");
		await fs.mkdir(defaultSkill, { recursive: true });
		await Bun.write(path.join(defaultSkill, "SKILL.md"), makeSkillMd("shared-name", "default"));

		// The explicitly configured custom directory holds the same name.
		const customSkill = path.join(customDir, "shared-name");
		await fs.mkdir(customSkill, { recursive: true });
		await Bun.write(path.join(customSkill, "SKILL.md"), makeSkillMd("shared-name", "custom"));

		const { skills } = await loadSkills({
			cwd,
			enableCodexUser: false,
			enableClaudeUser: false,
			enableClaudeProject: true,
			enablePiUser: false,
			enablePiProject: false,
			enableAgentsUser: false,
			enableAgentsProject: false,
			customDirectories: [customDir],
		});
		setActiveSkills(skills);

		const dup = skills.find(s => s.name === "shared-name");
		expect(dup).toBeDefined();
		// The explicitly configured custom directory is the higher-priority source.
		expect(dup!.filePath).toBe(path.join(customSkill, "SKILL.md"));

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://shared-name/"));
		expect(resource.sourcePath).toBe(path.join(customSkill, "SKILL.md"));
		expect(resource.content).toContain("from custom");
	});
});
