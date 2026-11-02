import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildSkillPromptMessage,
	loadSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";

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

	it("makes the helper location visible when one plugin skill reads another (#8740)", async () => {
		const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-cross-plugin-skills-")));
		tempDirs.push(tempDir);
		const skills: Skill[] = [];
		for (const [plugin, name] of [
			["plugin-a", "router-skill"],
			["plugin-b", "helper-skill"],
		]) {
			const pluginRoot = path.join(tempDir, plugin);
			const baseDir = path.join(pluginRoot, "skills", name);
			await fs.mkdir(baseDir, { recursive: true });
			const filePath = path.join(baseDir, "SKILL.md");
			await Bun.write(filePath, makeSkillMd(name, plugin));
			skills.push({
				name,
				description: name,
				filePath,
				baseDir,
				source: "agent-plugins:user",
				containRoot: pluginRoot,
			});
		}
		const helper = skills[1];
		await fs.mkdir(path.join(helper.baseDir, "scripts"));
		await Bun.write(
			path.join(helper.baseDir, "scripts", "helper.ts"),
			'process.stdout.write("helper from plugin-b");',
		);
		await Bun.write(
			helper.filePath,
			`${makeSkillMd(helper.name, "plugin-b")}Run scripts/helper.ts next to this skill file.\n`,
		);
		setActiveSkills(skills);
		const invocation = await buildSkillPromptMessage(skills[0], { args: "" });
		expect(invocation.message).toContain(`[Skill directory: ${skills[0].baseDir}]`);
		const session: ToolSession = {
			cwd: skills[0].baseDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const result = await new ReadTool(session).execute("read-cross-plugin-helper", { path: "skill://helper-skill" });
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		// Consume the visible provenance, not renderer-only details, to locate the sibling.
		const sourcePath = text.match(/\[Skill file: (.+)\]/)?.[1];
		expect(sourcePath).toBe(helper.filePath);
		const proc = Bun.spawn([process.execPath, path.join(path.dirname(sourcePath!), "scripts", "helper.ts")], {
			cwd: skills[0].baseDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(exitCode).toBe(0);
		expect(output).toBe("helper from plugin-b");
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "skill://helper-skill" });

		// Out-of-range selectors have no displayContent; the TUI uses the first text block.
		const outOfRangeArgs = { path: "skill://helper-skill:9999" };
		const outOfRange = await new ReadTool(session).execute("read-cross-plugin-helper-out-of-range", outOfRangeArgs);
		expect(outOfRange.details?.displayContent).toBeUndefined();
		const firstText = outOfRange.content.find(block => block.type === "text")?.text;
		expect(firstText).toContain(`[Skill file: ${helper.filePath}]`);
		expect(firstText).toContain("Line 9999 is beyond end of file");
		await initTheme(false, undefined, undefined, "dark", "light");
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("Failed to load dark theme");
		for (const expanded of [false, true]) {
			const rendered = readToolRenderer
				.renderResult(outOfRange, { expanded, isPartial: false }, uiTheme, outOfRangeArgs)
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("Line 9999 is beyond end of file");
		}

		// Raw reads remain verbatim for consumers using the skill URI as a file resource.
		const raw = await new ReadTool(session).execute("read-cross-plugin-helper-raw", {
			path: "skill://helper-skill:raw",
		});
		const rawText = raw.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(rawText).toBe(await Bun.file(helper.filePath).text());
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

	it("keeps the first-admitted custom directory on the bare name", async () => {
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

		const nsB = path.basename(dirB);
		const bareEntry = skills.find(s => s.name === "same-name");
		const skillBEntry = skills.find(s => s.name === `${nsB}/same-name`);
		expect(bareEntry).toBeDefined();
		expect(skillBEntry).toBeDefined();
		expect(bareEntry!.filePath).toBe(path.join(skillA, "SKILL.md"));
		expect(skillBEntry!.filePath).toBe(path.join(skillB, "SKILL.md"));
		expect(warnings.some(w => w.message.includes("collision"))).toBe(true);

		const handler = new SkillProtocolHandler();
		const bareResource = await handler.resolve(parseInternalUrl("skill://same-name/"));
		expect(bareResource.sourcePath).toBe(path.join(skillA, "SKILL.md"));
		const namespaced = await handler.resolve(parseInternalUrl(`skill://${nsB}/same-name/`));
		expect(namespaced.sourcePath).toBe(path.join(skillB, "SKILL.md"));
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

		// The custom-directory skill overrides onto the bare name (#7190); the
		// displaced provider skill stays reachable under its namespaced form.
		const bareEntry = skills.find(s => s.name === "shared-name");
		const defaultEntry = skills.find(s => s.name === "claude/shared-name");
		expect(bareEntry).toBeDefined();
		expect(defaultEntry).toBeDefined();
		expect(bareEntry!.filePath).toBe(path.join(customSkill, "SKILL.md"));
		expect(defaultEntry!.filePath).toBe(path.join(defaultSkill, "SKILL.md"));

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://shared-name/"));
		expect(resource.sourcePath).toBe(path.join(customSkill, "SKILL.md"));
		expect(resource.content).toContain("from custom");
	});

	it("overrides a default-path skill even when both bodies are byte-identical (#7190)", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-default-skill-identical-"));
		tempDirs.push(cwd);
		const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skill-identical-"));
		tempDirs.push(customDir);

		// A default discovery path (Claude project skills) claims the name first,
		// with the SAME body the custom-directory skill below will also carry.
		const defaultSkill = path.join(cwd, ".claude", "skills", "shared-name");
		await fs.mkdir(defaultSkill, { recursive: true });
		await Bun.write(path.join(defaultSkill, "SKILL.md"), makeSkillMd("shared-name", "same"));

		// The explicitly configured custom directory holds an identical body.
		const customSkill = path.join(customDir, "shared-name");
		await fs.mkdir(customSkill, { recursive: true });
		await Bun.write(path.join(customSkill, "SKILL.md"), makeSkillMd("shared-name", "same"));

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

		// An identical body must not short-circuit the override contract: the
		// custom-directory copy still has to be the one reachable on the bare
		// name, not whichever side happened to admit first. The provider copy
		// carries nothing the override lacks, so it is not re-admitted either.
		const sharedNames = skills.filter(s => s.name.endsWith("shared-name"));
		expect(sharedNames.map(s => s.name)).toEqual(["shared-name"]);
		const bareEntry = sharedNames[0];
		expect(bareEntry.filePath).toBe(path.join(customSkill, "SKILL.md"));

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://shared-name/"));
		expect(resource.sourcePath).toBe(path.join(customSkill, "SKILL.md"));
	});
});
