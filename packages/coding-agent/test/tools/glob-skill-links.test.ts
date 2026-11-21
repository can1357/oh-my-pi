import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { listFiles } from "../../src/tools/jfind/tree";

describe("glob through linked skill entries", () => {
	let dir: string;
	let skill: Skill;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glob-skill-links-")));
		const plugin = path.join(dir, "plugin");
		const baseDir = path.join(plugin, "skills", "fixture");
		const shared = path.join(plugin, "shared");
		await fs.mkdir(baseDir, { recursive: true });
		await fs.mkdir(path.join(shared, "one", "two"), { recursive: true });
		await Bun.write(path.join(baseDir, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\nFixture\n");
		await Bun.write(path.join(shared, "review_sequence.py"), "def sequence(): pass\n");
		await Bun.write(path.join(shared, "one", "test_sequence.py"), "def test_sequence(): pass\n");
		await Bun.write(path.join(shared, "one", "two", "deep_sequence.py"), "def deep_sequence(): pass\n");
		await fs.symlink(shared, path.join(baseDir, "lrhe"), "dir");
		await fs.symlink(baseDir, path.join(shared, "cycle"), "dir");
		skill = {
			name: "fixture",
			description: "fixture",
			filePath: path.join(baseDir, "SKILL.md"),
			baseDir,
			source: "agent-plugins:user",
			containRoot: plugin,
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

	it("finds zero-, one-, and many-directory globstar matches through a contained link without cycling", async () => {
		const result = await new GlobTool(session).execute("linked-recursion", {
			path: "skill://fixture/**/*sequence*",
			gitignore: false,
		});
		expect(result.details?.files?.toSorted()).toEqual([
			"skill://fixture/lrhe/one/test_sequence.py",
			"skill://fixture/lrhe/one/two/deep_sequence.py",
			"skill://fixture/lrhe/review_sequence.py",
		]);
	});

	it("keeps a direct-child glob nonrecursive and follows a linked skill root", async () => {
		const linkedRoot = path.join(dir, "plugin", "linked-skill");
		await fs.symlink(skill.baseDir, linkedRoot, "dir");
		const tool = new GlobTool({ ...session, skills: [{ ...skill, baseDir: linkedRoot }] });
		const direct = await tool.execute("linked-direct", {
			path: "skill://fixture/lrhe/*sequence*",
			gitignore: false,
		});
		expect(direct.details?.files).toEqual(["skill://fixture/lrhe/review_sequence.py"]);
		const recursive = await tool.execute("linked-root", { path: "skill://fixture/**/*sequence*", gitignore: false });
		expect(recursive.details?.fileCount).toBe(3);
	});

	it("does not descend directory links in an ordinary host tree", async () => {
		const result = await glob({ path: skill.baseDir, pattern: "**/*sequence*", gitignore: false });
		expect(result.matches).toEqual([]);
	});

	it("denies links outside the plugin root without losing contained matches", async () => {
		const outside = path.join(dir, "outside");
		await Bun.write(path.join(outside, "leaked_sequence.py"), "secret = True\n");
		await fs.symlink(outside, path.join(skill.baseDir, "escape"), "dir");
		const result = await new GlobTool(session).execute("contained-recursion", {
			path: "skill://fixture/**/*sequence*",
			gitignore: false,
		});
		expect(result.details?.fileCount).toBe(3);
		expect(result.details?.files?.some(file => file.includes("leaked"))).toBe(false);
	});

	it("bounds non-plugin skill links to the skill root and refuses URL-link escapes", async () => {
		await Bun.write(path.join(skill.baseDir, "owned", "own_sequence.py"), "def own_sequence(): pass\n");
		await fs.symlink(path.join(skill.baseDir, "owned"), path.join(skill.baseDir, "inside"), "dir");
		await fs.symlink("skill://external", path.join(skill.baseDir, "url-link"), "dir");
		const external: Skill = { ...skill, name: "external", baseDir: path.join(dir, "plugin", "shared") };
		const result = await new GlobTool({
			...session,
			skills: [{ ...skill, containRoot: undefined }, external],
		}).execute("local-skill-recursion", { path: "skill://fixture/**/*sequence*", gitignore: false });
		expect(result.details?.files?.toSorted()).toEqual([
			"skill://fixture/inside/own_sequence.py",
			"skill://fixture/owned/own_sequence.py",
		]);
	});

	it("lists linked skill candidates before any judge is constructed", async () => {
		const filesystem = new InternalUrlFilesystem({
			context: { skills: [skill], containSkillPaths: true },
			tier: "read",
		});
		const entries = await listFiles(
			{ path: "skill://fixture", type: "directory" },
			{ filesystem: filesystem.shellFilesystem(), includeHidden: false },
		);
		expect(entries.map(entry => entry.path)).toEqual([
			"skill://fixture/SKILL.md",
			"skill://fixture/lrhe/one/test_sequence.py",
			"skill://fixture/lrhe/one/two/deep_sequence.py",
			"skill://fixture/lrhe/review_sequence.py",
		]);
		expect(entries.every(entry => entry.size > 0)).toBe(true);
	});
});
