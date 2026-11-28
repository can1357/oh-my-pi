import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TempDir } from "@oh-my-pi/pi-utils";

export interface WorktreeSpec {
	name: string;
	branch: string;
}

export interface WorktreeFixtureOptions {
	files?: Record<string, string>;
}

/**
 * Create a temporary Git repository on `main` with one initial commit and the
 * requested sibling worktrees attached to new branches.
 */
export async function initWorktreeFixture(
	temp: TempDir,
	worktrees: readonly WorktreeSpec[],
	options: WorktreeFixtureOptions = {},
): Promise<{ cwd: string; paths: Record<string, string> }> {
	const cwd = temp.join("main");
	const gitDir = path.join(cwd, ".git");
	await fs.mkdir(path.join(gitDir, "objects"), { recursive: true });
	await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
	await Bun.write(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(
		path.join(gitDir, "config"),
		[
			"[core]",
			"\trepositoryformatversion = 0",
			"\tfilemode = true",
			"\tbare = false",
			"\thooksPath = /dev/null",
			"[commit]",
			"\tgpgsign = false",
			"[user]",
			"\tname = Test",
			"\temail = test@example.com",
			"",
		].join("\n"),
	);
	const files = options.files ?? { "lesson.txt": "before\n" };
	const fileNames = Object.keys(files);
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(cwd, name), content);
	}
	const repo = vcs.requireGit(cwd);
	await repo.stageFiles(fileNames);
	const head = await repo.commitCreate("initial", {
		author: { name: "Test", email: "test@example.com" },
		noVerify: true,
	});
	const paths: Record<string, string> = {};
	for (const wt of worktrees) {
		const wtPath = temp.join(wt.name);
		await repo.createBranch(wt.branch, head, false);
		await repo.worktreeAdd(wtPath, wt.branch, { detach: false, clone: false });
		paths[wt.name] = wtPath;
	}
	return { cwd, paths };
}
