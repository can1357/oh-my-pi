import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type ActiveRepoContext,
	resolveActiveRepoContext,
	resolveActiveRepoContextSync,
} from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";

const itWithSymlinkPrivilege = process.platform === "win32" ? it.skip : it;

function createGitDirectory(repoRoot: string): void {
	const gitDir = path.join(repoRoot, ".git");
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
}

function createLinkedWorktreeGitFile(worktreeRoot: string, gitDir: string, commonDir: string): void {
	fs.mkdirSync(worktreeRoot, { recursive: true });
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(commonDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`, "utf8");
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`, "utf8");
}

async function expectResolvers(cwd: string, expected: ActiveRepoContext | null): Promise<void> {
	expect(resolveActiveRepoContextSync(cwd)).toEqual(expected);
	expect(await resolveActiveRepoContext(cwd)).toEqual(expected);
}

describe("resolveActiveRepoContext", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-active-repo-context-"));
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("returns null when cwd is already inside a repository", async () => {
		const repoRoot = path.join(tempRoot, "repo");
		const cwd = path.join(repoRoot, "nested");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(repoRoot);

		await expectResolvers(cwd, null);
	});

	it("returns null when no direct child repository exists", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(path.join(cwd, "not-a-repo"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "plain-file.txt"), "ignored\n", "utf8");

		await expectResolvers(cwd, null);
	});

	it("returns the sole direct child repository context", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "repo");
		fs.mkdirSync(path.join(cwd, "not-a-repo"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "plain-file.txt"), "ignored\n", "utf8");
		createGitDirectory(repoRoot);

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "repo",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});

	itWithSymlinkPrivilege("treats a direct child symlink to a repository directory as that child", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const targetRoot = path.join(tempRoot, "target-repo");
		const repoRoot = path.join(cwd, "linked-repo");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(targetRoot);
		fs.symlinkSync(targetRoot, repoRoot, "junction");

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "linked-repo",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});

	it("returns null when two direct child repositories exist", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(path.join(cwd, "alpha"));
		createGitDirectory(path.join(cwd, "beta"));

		await expectResolvers(cwd, null);
	});

	it("accepts a direct child linked-worktree .git file", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "worktree");
		const gitDir = path.join(tempRoot, "admin", "worktrees", "worktree");
		const commonDir = path.join(tempRoot, "admin", "common.git");
		fs.mkdirSync(cwd, { recursive: true });
		createLinkedWorktreeGitFile(repoRoot, gitDir, commonDir);

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "worktree",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});
});
