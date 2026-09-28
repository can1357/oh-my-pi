import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { ShellFsOp, type ShellFsResponse } from "@oh-my-pi/pi-natives";

let tempDir: string;
let pluginRoot: string;
let skillDir: string;
let outsideFile: string;

/** Skill as loaded from an Agent Plugin: containment pinned to the plugin root. */
function pluginSkill(): Skill {
	return {
		name: "docs",
		description: "Test skill",
		filePath: path.join(skillDir, "SKILL.md"),
		baseDir: skillDir,
		source: "agent-plugins:user",
		containRoot: pluginRoot,
	};
}

beforeAll(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-contain-")));
	pluginRoot = path.join(tempDir, "plugin");
	skillDir = path.join(pluginRoot, "skills", "docs");
	await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
	await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: docs\ndescription: d\n---\nBody\n");
	await fs.writeFile(path.join(skillDir, "synthesized.md"), "Synthesized body\n");
	// A legitimate shared file elsewhere INSIDE the plugin root.
	await fs.mkdir(path.join(pluginRoot, "shared"), { recursive: true });
	await fs.writeFile(path.join(pluginRoot, "shared", "inside.md"), "inside contents\n");
	// A secret OUTSIDE the plugin root.
	outsideFile = path.join(tempDir, "secret.md");
	await fs.writeFile(outsideFile, "outside contents\n");
	// Symlinked resources shipped by the skill.
	await fs.symlink(path.join(pluginRoot, "shared", "inside.md"), path.join(skillDir, "references", "ok.md"));
	await fs.symlink(outsideFile, path.join(skillDir, "references", "leak.md"));
	// Dangling in-package symlink to a NOT-YET-EXISTING outside path: writing
	// through it (e.g. `tee`) would create the outside target.
	await fs.symlink(path.join(tempDir, "not-created.md"), path.join(skillDir, "references", "dangle.md"));
});

afterAll(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("shell filesystem skill:// containment", () => {
	const shellFs = (skill: Skill) => new InternalUrlFilesystem({ context: { skills: [skill] }, tier: "exec" });
	const readOpen = { read: true, write: false, append: false, truncate: false, create: false, createNew: false };
	const openRead = (skill: Skill, url: string): Promise<ShellFsResponse> =>
		shellFs(skill).handle({ op: ShellFsOp.Open, path: url, open: readOpen });

	it("serves a bare URI as the skill directory, never the instruction file", async () => {
		const skill: Skill = { ...pluginSkill(), filePath: path.join(skillDir, "synthesized.md") };

		await expect(shellFs(skill).handle({ op: ShellFsOp.Metadata, path: "skill://docs" })).resolves.toEqual({
			local: skillDir,
		});
		await expect(openRead(skill, "skill://docs/SKILL.md")).resolves.toEqual({
			local: path.join(skillDir, "SKILL.md"),
			readonly: true,
		});
	});

	it("refuses a bare URI whose base directory escapes the plugin root", async () => {
		const skill: Skill = { ...pluginSkill(), baseDir: tempDir };

		const response = await shellFs(skill).handle({ op: ShellFsOp.ReadDir, path: "skill://docs" });
		expect(response.error?.code).toBe("EACCES");
		expect(response.error?.message).toContain("resolves outside the plugin root");
	});

	it("opens in-root symlinks at their canonical target, read-only", async () => {
		await expect(openRead(pluginSkill(), "skill://docs/references/ok.md")).resolves.toEqual({
			local: path.join(pluginRoot, "shared", "inside.md"),
			readonly: true,
		});
	});

	it("refuses symlinks escaping the plugin root", async () => {
		// §4.1: the package boundary applies to every file the client reads or
		// executes, including skill resources opened by the shell.
		const response = await openRead(pluginSkill(), "skill://docs/references/leak.md");
		expect(response.local).toBeUndefined();
		expect(response.error?.code).toBe("EACCES");
		expect(response.error?.message).toContain("resolves outside the plugin root");
	});

	it("reports dangling symlinks as missing and never writes through them", async () => {
		expect((await openRead(pluginSkill(), "skill://docs/references/dangle.md")).error?.code).toBe("ENOENT");

		const write = await shellFs(pluginSkill()).handle({
			op: ShellFsOp.Open,
			path: "skill://docs/references/dangle.md",
			open: { ...readOpen, read: false, write: true, create: true, truncate: true },
		});
		expect(write.error?.code).toBe("EROFS");
		await expect(fs.lstat(path.join(tempDir, "not-created.md"))).rejects.toThrow();
	});

	it("keeps skill packages read-only, creating nothing", async () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };

		const mkdir = await shellFs(local).handle({
			op: ShellFsOp.CreateDir,
			path: "skill://docs/new-dir",
			recursive: true,
		});
		expect(mkdir.error?.code).toBe("EROFS");
		await expect(fs.stat(path.join(skillDir, "new-dir"))).rejects.toThrow();
	});

	it("leaves uncontained (non-plugin) skills unrestricted", async () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };

		await expect(openRead(local, "skill://docs/references/leak.md")).resolves.toEqual({
			local: path.join(skillDir, "references", "leak.md"),
			readonly: true,
		});
	});
});

describe("skill:// read containment", () => {
	const handler = new SkillProtocolHandler();

	it("reads in-root symlinked resources", async () => {
		const resource = await handler.resolve(parseInternalUrl("skill://docs/references/ok.md"), {
			skills: [pluginSkill()],
		});
		expect(resource.content).toBe("inside contents\n");
	});

	it("refuses to read escaping symlinked resources", async () => {
		await expect(
			handler.resolve(parseInternalUrl("skill://docs/references/leak.md"), { skills: [pluginSkill()] }),
		).rejects.toThrow("resolves outside the plugin root");
	});

	it("fails closed on dangling symlinks", async () => {
		await expect(
			handler.resolve(parseInternalUrl("skill://docs/references/dangle.md"), { skills: [pluginSkill()] }),
		).rejects.toThrow("File not found");
	});
	it("keeps reading escaping paths for uncontained skills", async () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };
		const resource = await handler.resolve(parseInternalUrl("skill://docs/references/leak.md"), {
			skills: [local],
		});
		expect(resource.content).toBe("outside contents\n");
	});
});
