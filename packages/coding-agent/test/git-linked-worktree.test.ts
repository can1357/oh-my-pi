import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vcs from "@oh-my-pi/pi-natives/vcs";

// Builds the on-disk shape of a linked git worktree without invoking git:
//   <project>/.git/                      ← shared common dir (basename ".git")
//   <project>/.git/worktrees/<name>/     ← this worktree's gitdir
//   <worktreeRoot>/.git                  ← file: `gitdir: <…/worktrees/<name>>`
function linkWorktree(project: string, worktreeRoot: string): void {
	const commonDir = path.join(project, ".git");
	const gitDir = path.join(commonDir, "worktrees", path.basename(worktreeRoot));
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(worktreeRoot, { recursive: true });
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`, "utf8");
	fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`, "utf8");
}

describe("git linked worktree resolution", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-linked-worktree-")));
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("names the worktree root and the shared primary checkout", () => {
		const project = path.join(tempRoot, "pi");
		const worktreeRoot = path.join(tempRoot, ".tree", "pi", "xx");
		linkWorktree(project, worktreeRoot);

		expect(vcs.git(worktreeRoot)?.linkedWorktree()).toEqual({ root: worktreeRoot, primaryRoot: project });
	});

	it("resolves from a subdirectory of the worktree to the worktree root", () => {
		const project = path.join(tempRoot, "pi");
		const worktreeRoot = path.join(tempRoot, ".tree", "pi", "xx");
		linkWorktree(project, worktreeRoot);
		const sub = path.join(worktreeRoot, "packages", "foo");
		fs.mkdirSync(sub, { recursive: true });

		expect(vcs.git(sub)?.linkedWorktree()).toEqual({ root: worktreeRoot, primaryRoot: project });
	});

	it("returns null for the primary checkout", () => {
		const project = path.join(tempRoot, "pi");
		linkWorktree(project, path.join(tempRoot, ".tree", "pi", "xx"));

		expect(vcs.git(project)?.linkedWorktree()).toBeNull();
	});

	it("returns null outside any repository", () => {
		const bare = path.join(tempRoot, "loose");
		fs.mkdirSync(bare, { recursive: true });

		expect(vcs.git(bare)?.linkedWorktree() ?? null).toBeNull();
	});
});
