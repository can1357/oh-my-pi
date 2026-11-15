import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
	return stdout.trimEnd();
}

async function expectUnmerged(run: () => Promise<unknown>, filePath: string, context: string): Promise<void> {
	let error: unknown;
	try {
		await run();
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ name: "VcsError", code: "Backend" });
	const message = error instanceof Error ? error.message : String(error);
	expect(message.startsWith(context)).toBe(true);
	expect(message).toContain("unmerged entries");
	expect(message).toContain(filePath);
}

/** Content conflict on `conflicted.txt` (stages 1-3, no stage 0) plus a staged `extra.txt`. */
async function conflictedCheckout(): Promise<{ root: string; head: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-unmerged-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	await git(root, "config", "core.hooksPath", ".git/hooks");
	await Bun.write(path.join(root, "conflicted.txt"), "base\n");
	await Bun.write(path.join(root, "kept.txt"), "kept\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "base");
	await git(root, "checkout", "-b", "side");
	await Bun.write(path.join(root, "conflicted.txt"), "side\n");
	await git(root, "commit", "-am", "side");
	await git(root, "checkout", "main");
	await Bun.write(path.join(root, "conflicted.txt"), "main\n");
	await git(root, "commit", "-am", "main");
	const head = await git(root, "rev-parse", "HEAD");
	const merge = Bun.spawn(["git", "merge", "side"], { cwd: root, stderr: "ignore", stdout: "ignore" });
	const mergeCode = await merge.exited;
	if (mergeCode === 0) throw new Error("expected a content conflict");
	const stages = await git(root, "ls-files", "-s", "--", "conflicted.txt");
	if (!stages.split("\n").some(line => line.split(/\s+/)[2] === "1")) {
		throw new Error(`conflict must keep stage 1: ${stages}`);
	}
	if (stages.split("\n").some(line => line.split(/\s+/)[2] === "0")) {
		throw new Error(`deletion bug requires no stage 0: ${stages}`);
	}
	await Bun.write(path.join(root, "extra.txt"), "extra\n");
	await git(root, "add", "extra.txt");
	const unmerged = await git(root, "ls-files", "-u", "--", "conflicted.txt");
	if (!unmerged.includes("conflicted.txt")) throw new Error("staging extra resolved the conflict");
	return { root, head };
}

async function installHook(root: string, body: string): Promise<void> {
	const hookPath = path.join(root, ".git/hooks/pre-commit");
	await Bun.write(hookPath, `#!/bin/sh\n${body}\n`);
	await fs.chmod(hookPath, 0o755);
}

describe("unresolved index commits", () => {
	test("refuses to commit an unresolved index and commits once resolved", async () => {
		const { root, head } = await conflictedCheckout();
		await installHook(root, "echo ran > hook-ran\nexit 0");
		const repo = vcsGitDiscover(root)!;
		const treeBefore = await git(root, "rev-parse", "HEAD^{tree}");
		const hookMarker = Bun.file(path.join(root, "hook-ran"));

		await expectUnmerged(() => repo.commitCreate("should refuse", {}), "conflicted.txt", "git commit:");
		expect(await hookMarker.exists()).toBe(false);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "rev-parse", "HEAD^{tree}")).toBe(treeBefore);
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");

		await expectUnmerged(() => repo.commitCreate("empty", { allowEmpty: true }), "conflicted.txt", "git commit:");
		await expectUnmerged(() => repo.commitCreate("amend", { amend: true }), "conflicted.txt", "git commit:");
		await expectUnmerged(() => repo.commitCreate("unverified", { noVerify: true }), "conflicted.txt", "git commit:");
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");

		await git(root, "add", "conflicted.txt");
		const sha = await repo.commitCreate("resolved", {});
		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(sha).not.toBe(head);
		expect(await hookMarker.exists()).toBe(true);
		const names = (await git(root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
		expect(names).toContain("conflicted.txt");
		expect(names).toContain("extra.txt");
		expect(await git(root, "ls-files", "-u")).toBe("");
	});

	test("refuses to write a tree from an unresolved index", async () => {
		const { root, head } = await conflictedCheckout();
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(() => repo.writeTree(), "conflicted.txt", "git write-tree:");
		const alternate = path.join(root, "conflicted.index");
		await fs.copyFile(path.join(root, ".git/index"), alternate);
		await expectUnmerged(() => repo.writeTree(alternate), "conflicted.txt", "git write-tree:");
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");
	});

	test("refuses a pathspec commit when another index entry is unresolved", async () => {
		const { root, head } = await conflictedCheckout();
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(
			() => repo.commitCreate("partial", { files: ["extra.txt"] }),
			"conflicted.txt",
			"git commit:",
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");
	});

	test("refuses a pathspec commit from an alternate index that still has conflicts", async () => {
		const { root, head } = await conflictedCheckout();
		const alternate = path.join(root, "conflicted.index");
		await fs.copyFile(path.join(root, ".git/index"), alternate);
		await git(root, "add", "conflicted.txt");
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(
			() => repo.commitCreate("partial", { files: ["extra.txt"], indexPath: alternate }),
			"conflicted.txt",
			"git commit:",
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
	});

	test("refuses a pathspec commit when a pre-commit hook leaves unresolved stages", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-unmerged-hook-"));
		roots.push(root);
		await git(root, "init", "-b", "main");
		await git(root, "config", "user.name", "Native Test");
		await git(root, "config", "user.email", "native@example.test");
		await git(root, "config", "core.autocrlf", "false");
		await git(root, "config", "core.hooksPath", ".git/hooks");
		await Bun.write(path.join(root, "tracked.txt"), "base\n");
		await git(root, "add", "tracked.txt");
		await git(root, "commit", "-m", "base");
		await Bun.write(path.join(root, "extra.txt"), "extra\n");
		await git(root, "add", "extra.txt");
		const head = await git(root, "rev-parse", "HEAD");
		await installHook(
			root,
			[
				"set -e",
				"base=$(git rev-parse HEAD:tracked.txt)",
				"ours=$(printf 'ours\\n' | git hash-object -w --stdin)",
				"git update-index --force-remove tracked.txt",
				'printf \'100644 %s 1\\ttracked.txt\\n100644 %s 2\\ttracked.txt\\n\' "$base" "$ours" | git update-index --index-info',
				"echo ran > hook-ran",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(() => repo.commitCreate("partial", { files: ["extra.txt"] }), "tracked.txt", "git commit:");
		expect(await Bun.file(path.join(root, "hook-ran")).exists()).toBe(true);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
		expect(await git(root, "ls-files", "-u", "--", "tracked.txt")).toContain("tracked.txt");
	});
});
