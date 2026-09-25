import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";

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

describe("bash skill:// expansion containment", () => {
	const expand = (command: string, skill: Skill, directory?: boolean) =>
		expandInternalUrls(command, { context: { skills: [skill] }, noEscape: true, create: true, directory });

	it("resolves a bare URI to the configured instruction file", async () => {
		const skill: Skill = { ...pluginSkill(), filePath: path.join(skillDir, "synthesized.md") };

		await expect(expand("skill://docs", skill)).resolves.toBe(skill.filePath);
	});

	it("rejects a bare URI whose instruction file escapes the plugin root", async () => {
		const skill: Skill = { ...pluginSkill(), filePath: outsideFile };

		await expect(expand("cat skill://docs", skill)).rejects.toThrow("resolves outside the plugin root");
	});

	it("fails closed on a bare URI whose instruction file is missing", async () => {
		const skill: Skill = { ...pluginSkill(), filePath: path.join(skillDir, "gone.md") };

		await expect(expand("cat skill://docs", skill)).rejects.toThrow("does not exist");
	});

	it("resolves a bare URI to the base directory for directory callers", async () => {
		const skill: Skill = { ...pluginSkill(), filePath: path.join(skillDir, "synthesized.md") };

		await expect(expand("skill://docs", skill, true)).resolves.toBe(skillDir);
	});

	it("rejects a directory bare URI whose base escapes the plugin root", async () => {
		const skill: Skill = { ...pluginSkill(), baseDir: tempDir };

		await expect(expand("skill://docs", skill, true)).rejects.toThrow("resolves outside the plugin root");
	});

	it("resolves in-root symlinks to their canonical target", async () => {
		// The canonical realpath is returned, never the symlink path.
		await expect(expand("skill://docs/references/ok.md", pluginSkill())).resolves.toBe(
			path.join(pluginRoot, "shared", "inside.md"),
		);
	});

	it("rejects symlinks escaping the plugin root", async () => {
		// §4.1: the package boundary applies to every file the client reads or
		// executes, including skill resources handed to bash.
		await expect(expand("cat skill://docs/references/leak.md", pluginSkill())).rejects.toThrow(
			"resolves outside the plugin root",
		);
	});

	it("fails closed on dangling symlinks instead of handing bash the raw token", async () => {
		await expect(expand("tee skill://docs/references/dangle.md", pluginSkill())).rejects.toThrow("does not exist");
	});

	it("fails closed on missing targets of non-plugin skills too, creating nothing", async () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };

		await expect(expand("mkdir -p skill://docs/new-dir", local)).rejects.toThrow("does not exist");
		await expect(fs.stat(path.join(skillDir, "new-dir"))).rejects.toThrow();
	});

	it("leaves uncontained (non-plugin) skills unrestricted", async () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };

		await expect(expand("skill://docs/references/leak.md", local)).resolves.toBe(
			path.join(skillDir, "references", "leak.md"),
		);
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
