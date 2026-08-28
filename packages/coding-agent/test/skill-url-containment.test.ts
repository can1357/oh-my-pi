import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { resolveSkillUrlToPath } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";

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
	it("resolves in-root symlinks to their canonical target", () => {
		const resolved = resolveSkillUrlToPath("skill://docs/references/ok.md", [pluginSkill()]);
		// The canonical realpath is returned, never the symlink path.
		expect(resolved).toBe(path.join(pluginRoot, "shared", "inside.md"));
	});

	it("rejects symlinks escaping the plugin root", () => {
		// §4.1: the package boundary applies to every file the client reads or
		// executes, including skill resources handed to bash.
		expect(() => resolveSkillUrlToPath("skill://docs/references/leak.md", [pluginSkill()])).toThrow(
			"resolves outside the plugin root",
		);
	});

	it("fails closed on dangling symlinks instead of handing bash a writable outside path", () => {
		expect(() => resolveSkillUrlToPath("skill://docs/references/dangle.md", [pluginSkill()])).toThrow(
			"does not exist",
		);
	});

	it("leaves uncontained (non-plugin) skills unrestricted", () => {
		const local: Skill = { ...pluginSkill(), containRoot: undefined };
		const resolved = resolveSkillUrlToPath("skill://docs/references/leak.md", [local]);
		expect(resolved).toBe(path.join(skillDir, "references", "leak.md"));
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
