import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadSkillshareSkills } from "@oh-my-pi/pi-coding-agent/discovery/skillshare";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	getSkillshareStoreDir,
	getSkillStorePath,
	STORE_INTEGRITY_FILE,
	type SkillsLock,
	writeSkillsLock,
} from "@oh-my-pi/pi-coding-agent/skillshare/manifest";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

function lockEntry(scope: string, name: string, version: string) {
	return {
		version,
		integrity: `sha512-${scope}-${name}-${version}`,
		resolved: `/api/v1/skills/@${scope}/${name}/versions/${version}/tarball`,
	};
}

/** Unpack a fake installed version into the store, marker included. */
async function storeSkill(scope: string, name: string, version: string, description: string): Promise<string> {
	const dir = getSkillStorePath(scope, name, version);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
	await Bun.write(path.join(dir, STORE_INTEGRITY_FILE), `${lockEntry(scope, name, version).integrity}\n`);
	return dir;
}

describe("skillshare discovery provider", () => {
	let tempHome: string;
	let project: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skillshare-disco-"));
		project = path.join(tempHome, "work", "proj");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
	});

	afterEach(async () => {
		clearFsCache();
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("loads locked skills from the store and skips entries missing from it", async () => {
		const projectLock: SkillsLock = {
			version: 1,
			skills: {
				"@alice/pdf-tools": lockEntry("alice", "pdf-tools", "1.2.0"),
				"@alice/gone": lockEntry("alice", "gone", "0.1.0"),
			},
		};
		const userLock: SkillsLock = { version: 1, skills: { "@bob/review": lockEntry("bob", "review", "2.0.0") } };
		await writeSkillsLock(path.join(project, ".omp", "skills.lock.json"), projectLock);
		await writeSkillsLock(path.join(getAgentDir(), "skills.lock.json"), userLock);
		const pdfDir = await storeSkill("alice", "pdf-tools", "1.2.0", "PDF helpers");
		await storeSkill("bob", "review", "2.0.0", "Code review");
		// A different version in the store must not satisfy the lock.
		await storeSkill("alice", "gone", "0.0.9", "Old");

		const result = await loadSkillshareSkills({ cwd: project, home: tempHome, repoRoot: project });

		const summary = result.items.map(skill => ({
			name: skill.name,
			level: skill.level,
			origin: skill._source.origin,
			path: skill.path,
		}));
		expect(summary).toEqual([
			{
				name: "pdf-tools",
				level: "project",
				origin: "skillshare:@alice/pdf-tools@1.2.0",
				path: path.join(await fs.realpath(pdfDir), "SKILL.md"),
			},
			{
				name: "review",
				level: "user",
				origin: "skillshare:@bob/review@2.0.0",
				path: path.join(await fs.realpath(getSkillStorePath("bob", "review", "2.0.0")), "SKILL.md"),
			},
		]);
		expect(result.warnings).toEqual([]);
	});

	it("keeps skills readable through skill:// when the store sits behind a symlink", async () => {
		if (process.platform === "win32") return;
		const realStore = path.join(tempHome, "dotfiles", "skillshare");
		await fs.mkdir(realStore, { recursive: true });
		await fs.mkdir(path.dirname(getSkillshareStoreDir()), { recursive: true });
		await fs.symlink(realStore, getSkillshareStoreDir());
		await writeSkillsLock(path.join(project, ".omp", "skills.lock.json"), {
			version: 1,
			skills: { "@alice/pdf-tools": lockEntry("alice", "pdf-tools", "1.2.0") },
		});
		const storeDir = await storeSkill("alice", "pdf-tools", "1.2.0", "PDF helpers");
		await Bun.write(path.join(storeDir, "references", "a.md"), "reference body\n");

		const { skills } = await loadSkills({ cwd: project });
		const handler = new SkillProtocolHandler();
		const read = (url: string) => handler.resolve(parseInternalUrl(url), { skills });

		expect((await read("skill://pdf-tools")).content).toContain("# pdf-tools");
		expect((await read("skill://pdf-tools/references/a.md")).content).toBe("reference body\n");
		expect(await handler.locate(parseInternalUrl("skill://pdf-tools/missing.md"), { skills })).toBeNull();
	});

	it("lets an authored project skill win a name collision", async () => {
		await writeSkillsLock(path.join(project, ".omp", "skills.lock.json"), {
			version: 1,
			skills: { "@alice/pdf-tools": lockEntry("alice", "pdf-tools", "1.2.0") },
		});
		await storeSkill("alice", "pdf-tools", "1.2.0", "Registry PDF helpers");
		const authored = path.join(project, ".omp", "skills", "pdf-tools", "SKILL.md");
		await fs.mkdir(path.dirname(authored), { recursive: true });
		await Bun.write(authored, "---\nname: pdf-tools\ndescription: Local PDF helpers\n---\n# local\n");

		const { skills } = await loadSkills({ cwd: project });
		const pdf = skills.filter(skill => skill.name === "pdf-tools");

		expect(pdf).toHaveLength(1);
		expect(pdf[0]?.source).toBe("native:project");
		expect(pdf[0]?.description).toBe("Local PDF helpers");
	});
});
