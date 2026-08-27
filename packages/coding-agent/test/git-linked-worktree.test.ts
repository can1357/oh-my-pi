import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { repo } from "@oh-my-pi/pi-coding-agent/utils/git";

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
		vi.restoreAllMocks();
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("names the worktree root and the shared primary checkout", () => {
		const project = path.join(tempRoot, "pi");
		const worktreeRoot = path.join(tempRoot, ".tree", "pi", "xx");
		linkWorktree(project, worktreeRoot);

		expect(repo.linkedWorktreeSync(worktreeRoot)).toEqual({ root: worktreeRoot, primaryRoot: project });
	});

	it("resolves from a subdirectory of the worktree to the worktree root", () => {
		const project = path.join(tempRoot, "pi");
		const worktreeRoot = path.join(tempRoot, ".tree", "pi", "xx");
		linkWorktree(project, worktreeRoot);
		const sub = path.join(worktreeRoot, "packages", "foo");
		fs.mkdirSync(sub, { recursive: true });

		expect(repo.linkedWorktreeSync(sub)).toEqual({ root: worktreeRoot, primaryRoot: project });
	});

	it("returns null for the primary checkout", () => {
		const project = path.join(tempRoot, "pi");
		linkWorktree(project, path.join(tempRoot, ".tree", "pi", "xx"));

		expect(repo.linkedWorktreeSync(project)).toBeNull();
	});

	it("returns null outside any repository", () => {
		const bare = path.join(tempRoot, "loose");
		fs.mkdirSync(bare, { recursive: true });

		expect(repo.linkedWorktreeSync(bare)).toBeNull();
	});

	it("stops at an inaccessible linked worktree instead of resolving an outer repository", async () => {
		const worktreeRoot = path.join(tempRoot, "foreign-worktree");
		const gitDir = path.join(tempRoot, "foreign-home", "repo", ".git", "worktrees", "foreign-worktree");
		fs.mkdirSync(worktreeRoot, { recursive: true });
		fs.mkdirSync(path.join(tempRoot, ".git"));
		fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");

		const statSync = fs.statSync;
		vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
			if (path.resolve(target.toString()) === gitDir) {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return statSync(target);
		}) as typeof fs.statSync);
		expect(repo.resolveSync(worktreeRoot)).toBeNull();

		vi.restoreAllMocks();
		const stat = fs.promises.stat;
		vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
			if (path.resolve(target.toString()) === gitDir) {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			}
			return stat(target);
		}) as typeof fs.promises.stat);
		expect(await repo.resolve(worktreeRoot)).toBeNull();
	});
});
