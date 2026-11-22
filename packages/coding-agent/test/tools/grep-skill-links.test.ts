import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import type { ToolSession } from "../../src/tools";
import { ContentSearch } from "../../src/tools/jfind/content-search";

describe("grep through linked skill entries", () => {
	let dir: string;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "grep-skill-links-")));
		const source = path.join(dir, "dotfiles", "coord");
		const baseDir = path.join(dir, "skills", "coord");
		await Bun.write(path.join(source, "SKILL.md"), "---\nname: coord\ndescription: coord\n---\n## lock-req\n");
		await Bun.write(path.join(source, "scripts", "start-worker"), "echo start-worker\n");
		await fs.mkdir(baseDir, { recursive: true });
		await fs.symlink(path.join(source, "SKILL.md"), path.join(baseDir, "SKILL.md"));
		await fs.symlink(path.join(source, "scripts"), path.join(baseDir, "scripts"), "dir");
		const skill: Skill = {
			name: "coord",
			description: "coord",
			filePath: path.join(baseDir, "SKILL.md"),
			baseDir,
			source: "user",
		};
		session = {
			cwd: dir,
			skills: [skill],
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("searches linked files and directories under a skill root, as read resolves them", async () => {
		const result = await new ContentSearch(session).execute("skill-links", {
			pattern: "lock-req|start-worker",
			path: "skill://coord",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("# skill://coord/SKILL.md\n*5|## lock-req");
		expect(text).toContain("# skill://coord/scripts/start-worker\n*1|echo start-worker");
	});
});
