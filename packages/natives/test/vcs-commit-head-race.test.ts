import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "../native/index.js";
import { git, isVcsError } from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

/** Repository creation has no in-process API; later setup and checks use {@link VcsGitRepo}. */
async function initRepository(root: string): Promise<void> {
	const proc = Bun.spawn(["git", "-C", root, "init", "-q", "-b", "main"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git init failed (${code}): ${stderr}`);
}

async function repository(): Promise<{ root: string; repo: VcsGitRepo }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-head-race-"));
	roots.push(root);
	await initRepository(root);
	const repo = git(root);
	if (!repo) throw new Error("git init did not create a repository");
	await repo.configSet("user.name", "Head Race");
	await repo.configSet("user.email", "head-race@example.test");
	// The developer's global `core.hooksPath` would redirect hook lookup.
	await repo.configSet("core.hooksPath", ".git/hooks");
	await repo.configSet("commit.gpgSign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await repo.stageFiles(["tracked.txt"]);
	await repo.commitCreate("base", {});
	return { root, repo };
}

/** `commit-msg` runs after the expected-HEAD check and before the swap that updates HEAD. */
async function commitMsgHook(root: string, command: string): Promise<void> {
	const hook = path.join(root, ".git", "hooks", "commit-msg");
	await Bun.write(hook, `#!/bin/sh\n${command}\n`);
	await fs.chmod(hook, 0o755);
}

/** Stage a change so the commit has a tree to write before the hook moves HEAD. */
async function stageChange(root: string, repo: VcsGitRepo): Promise<void> {
	await Bun.write(path.join(root, "tracked.txt"), "one\ntwo\n");
	await repo.stageFiles(["tracked.txt"]);
}

async function headSha(repo: VcsGitRepo): Promise<string> {
	const sha = await repo.headSha();
	if (!sha) throw new Error("expected a born HEAD");
	return sha;
}

describe("commit compare-and-swap", () => {
	test.skipIf(process.platform === "win32")("reports a HEAD move inside the hook window as HeadMoved", async () => {
		const { root, repo } = await repository();
		const base = await headSha(repo);
		// A concurrent commit with the same tree: no worktree or index change.
		const moved = await repo.commitTree(base, [base], "concurrent");
		// The hook is the other process. It has to move the branch with Git while this commit is in flight.
		await commitMsgHook(root, `git update-ref refs/heads/main ${moved}`);
		await stageChange(root, repo);

		const error = await repo.commitCreate("raced", { expectedHead: base }).catch((err: unknown) => err);

		expect(isVcsError(error)).toBe(true);
		if (!isVcsError(error)) throw error;
		expect(error.code).toBe("HeadMoved");
		expect(error.message).toContain(base);
		expect(error.message).toContain(moved);
		expect(await repo.headSha()).toBe(moved);
	});

	test.skipIf(process.platform === "win32")(
		"reports a branch deleted inside the hook window as HeadMoved",
		async () => {
			const { root, repo } = await repository();
			const base = await headSha(repo);
			await commitMsgHook(root, "git update-ref -d refs/heads/main");
			await stageChange(root, repo);

			const error = await repo.commitCreate("raced", { expectedHead: base }).catch((err: unknown) => err);

			expect(isVcsError(error)).toBe(true);
			if (!isVcsError(error)) throw error;
			expect(error.code).toBe("HeadMoved");
			expect(error.message).toContain(base);
			expect(error.message).toContain("found unborn HEAD");
			expect((await repo.headSha()) ?? null).toBeNull();
		},
	);
});
