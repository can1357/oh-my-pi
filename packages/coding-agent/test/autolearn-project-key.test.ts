import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

it.skipIf(process.platform === "win32")(
	"keeps skills in a literal backslash directory separate from a nested project",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-key-"));
		try {
			const literal = path.join(root, "a\\b");
			const nested = path.join(root, "a", "b");
			await fs.mkdir(literal);
			await fs.mkdir(nested, { recursive: true });
			const profile = path.join(root, "profile");
			const skill = path.join("example", "SKILL.md");
			await Bun.write(path.join(getProjectManagedSkillsDir(literal, profile), skill), "# Example\n");
			expect(await Bun.file(path.join(getProjectManagedSkillsDir(nested, profile), skill)).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

it("shares the primary store with the registered worktree, not a checkout with a copy of its pointer", async () => {
	await using temp = await TempDir.create("@omp-skill-worktree-");
	const primary = temp.join("primary");
	const linked = temp.join("linked");
	const other = temp.join("other");
	const profile = temp.join("profile");
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
	await $`git init -q --template= ${primary}`.env(env).quiet();
	await $`git -C ${primary} -c user.name=Test -c user.email=test@example.com commit -q --allow-empty -m init`
		.env(env)
		.quiet();
	await $`git -C ${primary} worktree add -q --detach ${linked}`.env(env).quiet();
	await fs.mkdir(path.join(linked, "src"));
	await fs.mkdir(other);
	await fs.copyFile(path.join(linked, ".git"), path.join(other, ".git"));
	const store = getProjectManagedSkillsDir(primary, profile);
	expect(getProjectManagedSkillsDir(path.join(linked, "src"), profile)).toBe(store);
	expect(getProjectManagedSkillsDir(other, profile)).not.toBe(store);

	if (process.platform !== "win32") {
		await fs.unlink(path.join(other, ".git"));
		await fs.symlink(path.join(linked, ".git"), path.join(other, ".git"));
		expect(getProjectManagedSkillsDir(other, profile)).not.toBe(store);
	}
});

it("does not share a primary store on the strength of a gitdir or commondir pointer", async () => {
	await using temp = await TempDir.create("@omp-skill-pointer-");
	const common = temp.join("primary", ".git");
	const other = temp.join("other");
	const profile = temp.join("profile");
	await Bun.write(path.join(common, "HEAD"), "ref: refs/heads/main\n");
	const store = getProjectManagedSkillsDir(temp.join("primary"), profile);
	await Bun.write(path.join(other, ".git"), `gitdir: ${common}\n`);
	expect(getProjectManagedSkillsDir(other, profile)).not.toBe(store);

	const metadata = temp.join("metadata");
	await Bun.write(path.join(metadata, "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(path.join(metadata, "commondir"), `${common}\n`);
	await Bun.write(path.join(metadata, "gitdir"), `${path.join(other, ".git")}\n`);
	await Bun.write(path.join(other, ".git"), `gitdir: ${metadata}\n`);
	expect(getProjectManagedSkillsDir(other, profile)).not.toBe(store);

	if (process.platform !== "win32") {
		const registration = path.join(common, "worktrees", "other");
		await fs.mkdir(path.dirname(registration));
		await fs.symlink(metadata, registration);
		await Bun.write(path.join(other, ".git"), `gitdir: ${registration}\n`);
		expect(getProjectManagedSkillsDir(other, profile)).not.toBe(store);
	}
});

it("groups Jujutsu subdirectories by workspace, not by a repo pointer", async () => {
	await using temp = await TempDir.create("@omp-skill-jj-");
	const primary = temp.join("primary");
	const workspace = temp.join("workspace");
	const profile = temp.join("profile");
	const repo = path.join(primary, ".jj", "repo");
	await fs.mkdir(repo, { recursive: true });
	await Bun.write(path.join(workspace, ".jj", "repo"), `${repo}\n`);
	await fs.mkdir(path.join(workspace, "src"));
	const store = getProjectManagedSkillsDir(workspace, profile);
	expect(getProjectManagedSkillsDir(path.join(workspace, "src"), profile)).toBe(store);
	expect(store).not.toBe(getProjectManagedSkillsDir(primary, profile));
});
