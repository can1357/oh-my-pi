import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsDiscover, vcsGitClone, vcsGitDiscover, vcsGitRepoInfo } from "../native/index.js";
import * as vcs from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

describe("in-process VCS bindings", () => {
	test("detects staged, unstaged, and untracked working-tree changes", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;

		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "restore", "tracked.txt");
		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "untracked.txt"), "new\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "add", "untracked.txt");
		expect(await repo.isDirty()).toBe(true);
	});

	test("discovers, diffs, applies, stages, and commits", async () => {
		const root = await repository();
		const nested = join(root, "nested");
		await mkdir(nested);
		await writeFile(join(nested, "untracked.txt"), "new\n");
		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");

		const repo = vcsGitDiscover(nested);
		expect(repo).not.toBeNull();
		const info = vcsGitRepoInfo(nested);
		expect(info?.repoRoot).toBe(root);
		expect(repo!.info().repoRoot).toBe(root);
		expect(repo!.headSync()).toMatchObject({ kind: "ref", branch: "main" });
		expect(await repo!.statusSummary()).toEqual({ staged: 0, unstaged: 1, untracked: 1 });

		const nativePatch = await repo!.diffText({});
		const cliPatch = await git(root, "diff", "--no-ext-diff", "--no-textconv");
		expect(nativePatch.trimEnd()).toBe(cliPatch);
		expect(nativePatch).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(nativePatch).toContain("@@");

		await git(root, "restore", "tracked.txt");
		expect(await repo!.canApplyPatch(nativePatch, {})).toBe(true);
		await repo!.applyPatch(nativePatch, {});
		expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("one\nchanged\n");

		await repo!.stageFiles(["tracked.txt"]);
		const sha = await repo!.commitCreate("native commit", {});
		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
	});

	test("throws rich VcsError objects", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const sha = await git(root, "rev-parse", "HEAD");
		try {
			await repo.cherryPick(sha);
			throw new Error("expected cherry-pick to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ name: "VcsError", code: "EmptyCherryPick" });
			expect((error as Error).message).toContain(sha);
		}
	});
	test("applies cached patches to an alternate index", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		await writeFile(join(root, "tracked.txt"), "one\nsynthetic\n");
		const patch = await repo.diffText({});
		const indexPath = join(root, "synthetic.index");
		await repo.readTree("HEAD", indexPath);
		await repo.applyPatch(patch, { cached: true, indexPath });

		const headTree = await git(root, "rev-parse", "HEAD^{tree}");
		expect(await git(root, "write-tree")).toBe(headTree);
		expect(await repo.writeTree(indexPath)).not.toBe(headTree);
		expect(await git(root, "diff", "--cached")).toBe("");
	});

	test("aborts clone promptly", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-clone-"));
		roots.push(root);
		const target = join(root, "clone");
		const controller = new AbortController();
		controller.abort();
		const started = performance.now();
		try {
			await vcsGitClone("https://10.255.255.1/never.git", target, { timeoutMs: 60_000 }, controller.signal);
			throw new Error("expected clone to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError" });
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			expect(["Canceled", "Cli", "CliTimeout"]).toContain(String(code));
			expect(performance.now() - started).toBeLessThan(2_000);
		}
	});
});

describe("VcsRepo", () => {
	test("dispatches portable Git operations", async () => {
		const root = await repository();
		await writeFile(join(root, "tracked.txt"), "one\nunstaged\n");
		await writeFile(join(root, "staged.txt"), "staged\n");
		await git(root, "add", "staged.txt");

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("git");
		expect(repo?.root()).toBe(root);
		expect(repo?.supports("stagedDiff")).toBe(true);
		expect(repo?.asGit()).not.toBeNull();
		expect(repo?.asJj()).toBeNull();
		expect((await repo?.uncommittedDiff([]))?.trimEnd()).toBe(await git(root, "diff", "HEAD"));

		const required = vcs.require(root, "stagedDiff");
		expect(required.kind()).toBe("git");
		expect(required.supports("revDiff")).toBe(true);
	});

	test("discovers Jujutsu and rejects unsupported features", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-jj-"));
		roots.push(root);
		await mkdir(join(root, ".jj", "repo"), { recursive: true });

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("jj");
		expect(repo?.supports("stagedDiff")).toBe(false);
		expect(repo?.asGit()).toBeNull();
		expect(repo?.asJj()).not.toBeNull();

		try {
			vcs.require(root, "stagedDiff");
			throw new Error("expected capability assertion to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Unsupported" });
		}

		try {
			repo?.supports("unknown");
			throw new Error("expected unknown feature to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Backend" });
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw error;
			expect(error.message).toContain("valid: stagedDiff, revDiff");
		}
	});
});
