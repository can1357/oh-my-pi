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

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trimEnd();
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-head-race-"));
	roots.push(root);
	await run(root, "init", "-q", "-b", "main");
	await run(root, "config", "user.name", "Head Race");
	await run(root, "config", "user.email", "head-race@example.test");
	// The developer's global `core.hooksPath` would redirect hook lookup.
	await run(root, "config", "core.hooksPath", ".git/hooks");
	await run(root, "config", "commit.gpgSign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await run(root, "add", "tracked.txt");
	await run(root, "commit", "-q", "-m", "base");
	return root;
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

describe("commit compare-and-swap", () => {
	test.skipIf(process.platform === "win32")("reports a HEAD move inside the hook window as HeadMoved", async () => {
		const root = await repository();
		const repo = git(root)!;
		const base = await run(root, "rev-parse", "HEAD");
		// A concurrent commit with the same tree: no worktree or index change.
		const moved = await run(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "concurrent");
		await commitMsgHook(root, `git update-ref refs/heads/main ${moved}`);
		await stageChange(root, repo);

		const error = await repo.commitCreate("raced", { expectedHead: base }).catch((err: unknown) => err);

		expect(isVcsError(error)).toBe(true);
		if (!isVcsError(error)) throw error;
		expect(error.code).toBe("HeadMoved");
		expect(error.message).toContain(base);
		expect(error.message).toContain(moved);
		expect(await run(root, "rev-parse", "HEAD")).toBe(moved);
	});

	test.skipIf(process.platform === "win32")(
		"reports a branch deleted inside the hook window as HeadMoved",
		async () => {
			const root = await repository();
			const repo = git(root)!;
			const base = await run(root, "rev-parse", "HEAD");
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
