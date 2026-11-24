import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
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

	it("runs a .git/info/attributes filter when a linked worktree falls back to a plain checkout", async () => {
		const repo = path.join(tempRoot, "repo");
		const filter = path.join(tempRoot, "filter.sh");
		fs.writeFileSync(filter, `#!/bin/sh
if [ "$1" = smudge ]; then sed 's/TOKEN/REAL/'; else sed 's/REAL/TOKEN/'; fi
`);
		await $`git init -q -b main ${repo}`.quiet();
		await $`git -C ${repo} config filter.t.smudge ${`sh '${filter}' smudge`}`.quiet();
		await $`git -C ${repo} config filter.t.clean ${`sh '${filter}' clean`}`.quiet();
		await $`git -C ${repo} config filter.t.required true`.quiet();
		fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "*.txt filter=t\n");
		fs.writeFileSync(path.join(repo, "b.txt"), "REAL two\n");
		await $`git -C ${repo} add -A`.quiet();
		await $`git -C ${repo} -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit -qm init`.quiet();
		// core.sparseCheckout makes the clone refuse, so worktreeAdd takes the plain-checkout fallback.
		await $`git -C ${repo} config core.sparseCheckout true`.quiet();

		const worktree = path.join(tempRoot, "wt");
		const result = await vcs.requireGit(repo).worktreeAdd(worktree, "HEAD", { detach: true, clone: true });

		expect(result.cloneError).toBeDefined();
		expect(fs.readFileSync(path.join(worktree, "b.txt"), "utf8")).toBe("REAL two\n");
	});
});
