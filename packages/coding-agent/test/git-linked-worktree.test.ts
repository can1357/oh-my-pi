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

// Builds the on-disk shape of a linked worktree created *from within a
// checked-out submodule*: the submodule's own git dir lives at
// `<super>/.git/modules/<name>` (not `<checkout>/.git`) and points back at
// its checkout via `core.worktree` in its `config` file — the same
// indirection `git init --separate-git-dir` uses. A worktree of that
// submodule therefore has a common dir whose basename is the submodule
// name, not `.git`, and whose `core.worktree` (in the common dir's config)
// must be followed to reach the submodule checkout.
function linkSubmoduleWorktree(superRoot: string, submoduleCheckout: string, worktreeRoot: string): void {
	const commonDir = path.join(superRoot, ".git", "modules", path.basename(submoduleCheckout));
	fs.mkdirSync(commonDir, { recursive: true });
	fs.mkdirSync(submoduleCheckout, { recursive: true });
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(
		path.join(commonDir, "config"),
		`[core]\n\tworktree = ${path.relative(commonDir, submoduleCheckout)}\n`,
		"utf8",
	);
	fs.writeFileSync(
		path.join(submoduleCheckout, ".git"),
		`gitdir: ${path.relative(submoduleCheckout, commonDir)}\n`,
		"utf8",
	);

	const gitDir = path.join(commonDir, "worktrees", path.basename(worktreeRoot));
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(worktreeRoot, { recursive: true });
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

	it("resolves a worktree of a submodule to the submodule's own checkout, not the internal .git/modules store", () => {
		const superRoot = path.join(tempRoot, "super");
		const submoduleCheckout = path.join(superRoot, "sub");
		const worktreeRoot = path.join(tempRoot, ".tree", "sub", "xx");
		linkSubmoduleWorktree(superRoot, submoduleCheckout, worktreeRoot);

		expect(vcs.git(worktreeRoot)?.primaryRoot()).toBe(submoduleCheckout);
		expect(vcs.git(submoduleCheckout)?.primaryRoot()).toBe(submoduleCheckout);
	});
});
