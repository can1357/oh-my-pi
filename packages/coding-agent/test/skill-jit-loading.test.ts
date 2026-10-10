import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import {
	loadSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
	setActiveSkillsRefresher,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";

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

describe("skill:// just-in-time discovery", () => {
	const tempDirs: string[] = [];

	async function tempRoot(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jit-skills-"));
		tempDirs.push(dir);
		return dir;
	}

	async function writeSkill(root: string, name: string): Promise<string> {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		await Bun.write(filePath, makeSkillMd(name, root));
		return filePath;
	}

	/** Mirrors a session's refresher: drop the FS cache, then re-discover from disk. */
	async function rediscover(root: string) {
		resetCapabilities();
		const { skills } = await loadSkills({ ...ALL_DEFAULT_SOURCES_DISABLED, customDirectories: [root] });
		setActiveSkills(skills);
		return skills;
	}

	afterEach(async () => {
		resetActiveSkillsForTests();
		resetCapabilities();
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("resolves a skill created after the startup snapshot", async () => {
		const root = await tempRoot();
		await writeSkill(root, "first-skill");
		setActiveSkills(await rediscover(root));
		setActiveSkillsRefresher(() => rediscover(root));

		const addedPath = await writeSkill(root, "added-skill");

		const resource = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://added-skill"));
		expect(resource.sourcePath).toBe(addedPath);
		expect(resource.content).toContain(`from ${root}`);
	});

	it("resolves a skill whose file moved to another directory after the snapshot", async () => {
		const root = await tempRoot();
		const originalPath = await writeSkill(root, "packed-skill");
		setActiveSkills(await rediscover(root));
		setActiveSkillsRefresher(() => rediscover(root));

		const movedPath = path.join(root, "relocated-skill", "SKILL.md");
		await fs.mkdir(path.dirname(movedPath), { recursive: true });
		await fs.rename(originalPath, movedPath);

		// The snapshot still maps `packed-skill` to the vanished path; the
		// re-discovery must re-read the directory, not serve the stale mapping.
		const resource = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://packed-skill"));
		expect(resource.sourcePath).toBe(movedPath);
		expect(resource.content).toContain(`from ${root}`);
	});

	it("reports a deleted skill as unknown rather than as a vanished file", async () => {
		const root = await tempRoot();
		await writeSkill(root, "doomed-skill");
		setActiveSkills(await rediscover(root));
		setActiveSkillsRefresher(() => rediscover(root));

		await fs.rm(path.join(root, "doomed-skill"), { recursive: true, force: true });

		await expect(new SkillProtocolHandler().resolve(parseInternalUrl("skill://doomed-skill"))).rejects.toThrow(
			/Unknown skill: doomed-skill/,
		);
	});

	it("keeps the cached snapshot when no session registered a refresher", async () => {
		const root = await tempRoot();
		await writeSkill(root, "solo-skill");
		setActiveSkills(await rediscover(root));

		await fs.rm(path.join(root, "solo-skill"), { recursive: true, force: true });

		// No re-discovery hook: the stale mapping surfaces as a missing file.
		await expect(new SkillProtocolHandler().resolve(parseInternalUrl("skill://solo-skill"))).rejects.toThrow(
			/File not found/,
		);
	});
});
