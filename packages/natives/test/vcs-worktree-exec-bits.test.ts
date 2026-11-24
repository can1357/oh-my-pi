import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
}

async function execBit(file: string): Promise<boolean> {
	return ((await fs.stat(file)).mode & 0o111) !== 0;
}

/**
 * plain.txt is committed 100644 and run.sh 100755. With core.filemode off, git ignores
 * exec-bit edits, so the source reads as clean while its disk modes disagree with the index:
 * plain.txt is 0755 on disk, run.sh is 0644.
 */
async function sourceWithExecBitEdits(): Promise<string> {
	const source = await tempDir("pi-natives-exec-bits-src-");
	await runGit(source, "init", "-q", "-b", "main");
	await runGit(source, "config", "user.name", "Exec Bits");
	await runGit(source, "config", "user.email", "exec-bits@example.test");
	await Bun.write(path.join(source, "plain.txt"), "plain\n");
	await Bun.write(path.join(source, "run.sh"), "#!/bin/sh\necho ok\n");
	await fs.chmod(path.join(source, "run.sh"), 0o755);
	await runGit(source, "add", "plain.txt", "run.sh");
	await runGit(source, "commit", "-q", "-m", "base");
	await runGit(source, "config", "core.filemode", "false");
	await fs.chmod(path.join(source, "plain.txt"), 0o755);
	await fs.chmod(path.join(source, "run.sh"), 0o644);
	return source;
}

function newWorktreePath(parent: string): string {
	return path.join(parent, "wt");
}

describe("worktreeAdd exec bits", () => {
	test("clone takes each tracked file's executable bit from the index, as git checkout does", async () => {
		const source = await sourceWithExecBitEdits();
		const worktree = newWorktreePath(await tempDir("pi-natives-exec-bits-clone-"));
		const repo = git(source);
		if (!repo) throw new Error("git init did not create a repository");

		await repo.worktreeAdd(worktree, "HEAD", { detach: true, clone: true });

		expect(await execBit(path.join(worktree, "plain.txt"))).toBe(false);
		expect(await execBit(path.join(worktree, "run.sh"))).toBe(true);
	});

	test("checkout takes each tracked file's executable bit from the index when core.filemode is off", async () => {
		const source = await sourceWithExecBitEdits();
		const worktree = newWorktreePath(await tempDir("pi-natives-exec-bits-checkout-"));
		const repo = git(source);
		if (!repo) throw new Error("git init did not create a repository");

		await repo.worktreeAdd(worktree, "HEAD", { detach: true, clone: false });

		expect(await execBit(path.join(worktree, "plain.txt"))).toBe(false);
		expect(await execBit(path.join(worktree, "run.sh"))).toBe(true);
	});
});
