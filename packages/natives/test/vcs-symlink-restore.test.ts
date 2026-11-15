import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { vcsGitDiscover } from "../native/index.js";

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

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-symlink-"));
	roots.push(root);
	const repo = join(root, "repo");
	const outside = join(root, "outside");
	mkdirSync(repo);
	mkdirSync(outside);
	await git(repo, "init", "-b", "main");
	await git(repo, "config", "user.name", "Native Test");
	await git(repo, "config", "user.email", "native@example.test");
	await git(repo, "config", "core.autocrlf", "false");
	return { repo, outside };
}

describe.skipIf(process.platform === "win32")("worktree symlink materialization", () => {
	test("restore replaces a retargeted symlink instead of writing through it", async () => {
		const { repo, outside } = await fixture();
		const victim = join(outside, "victim.txt");
		writeFileSync(victim, "secret");
		writeFileSync(join(repo, "original.txt"), "inside\n");
		symlinkSync("original.txt", join(repo, "link"), "file");
		await git(repo, "add", "original.txt", "link");
		await git(repo, "commit", "-qm", "link");
		rmSync(join(repo, "link"));
		symlinkSync(victim, join(repo, "link"), "file");

		await vcsGitDiscover(repo)!.restore({ files: ["link"], worktree: true });

		expect(readFileSync(victim, "utf8")).toBe("secret");
		expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(repo, "link"))).toBe("original.txt");
	});

	test("restore does not pass a symlink target through a smudge filter", async () => {
		const { repo, outside } = await fixture();
		const smudge = join(outside, "smudge.sh");
		writeFileSync(smudge, "#!/bin/sh\nsed 's/safe/SMUDGED/g'\n");
		chmodSync(smudge, 0o755);
		await git(repo, "config", "filter.corrupt.clean", "cat");
		await git(repo, "config", "filter.corrupt.smudge", smudge);
		await git(repo, "config", "filter.corrupt.required", "true");
		writeFileSync(join(repo, ".gitattributes"), "link filter=corrupt\ntext.txt filter=corrupt\n");
		symlinkSync("safe-target", join(repo, "link"), "file");
		writeFileSync(join(repo, "text.txt"), "safe\n");
		await git(repo, "add", ".gitattributes", "link", "text.txt");
		await git(repo, "commit", "-qm", "filtered");
		writeFileSync(join(repo, "text.txt"), "dirty\n");
		rmSync(join(repo, "link"));
		symlinkSync(join(outside, "missing"), join(repo, "link"), "file");

		await vcsGitDiscover(repo)!.restore({ files: ["link", "text.txt"], worktree: true });

		expect(readlinkSync(join(repo, "link"))).toBe("safe-target");
		expect(readFileSync(join(repo, "text.txt"), "utf8")).toBe("SMUDGED\n");
	});

	test("restore replaces a symlinked parent instead of writing outside the repository", async () => {
		const { repo, outside } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "index-bytes\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "nested");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		writeFileSync(join(linked, "file.txt"), "victim\n");
		rmSync(join(repo, "dir"), { recursive: true });
		symlinkSync(linked, join(repo, "dir"), "dir");

		await vcsGitDiscover(repo)!.restore({ files: ["dir/file.txt"], worktree: true });

		expect(readFileSync(join(linked, "file.txt"), "utf8")).toBe("victim\n");
		expect(lstatSync(join(repo, "dir")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(repo, "dir/file.txt"), "utf8")).toBe("index-bytes\n");
	});

	test("restore replaces an intermediate symlink instead of writing outside", async () => {
		const { repo, outside } = await fixture();
		mkdirSync(join(repo, "dir/nested"), { recursive: true });
		writeFileSync(join(repo, "dir/nested/deep.txt"), "deep-bytes\n");
		await git(repo, "add", "dir/nested/deep.txt");
		await git(repo, "commit", "-qm", "deep");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		writeFileSync(join(linked, "deep.txt"), "victim\n");
		rmSync(join(repo, "dir/nested"), { recursive: true });
		symlinkSync(linked, join(repo, "dir/nested"), "dir");

		await vcsGitDiscover(repo)!.restore({ files: ["dir/nested/deep.txt"], worktree: true });

		expect(readFileSync(join(linked, "deep.txt"), "utf8")).toBe("victim\n");
		expect(lstatSync(join(repo, "dir/nested")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(repo, "dir/nested/deep.txt"), "utf8")).toBe("deep-bytes\n");
	});

	test("cherry-pick replaces a symlink with a file instead of writing through it", async () => {
		const { repo, outside } = await fixture();
		const victim = join(outside, "victim.txt");
		writeFileSync(victim, "secret");
		symlinkSync(victim, join(repo, "link"), "file");
		await git(repo, "add", "link");
		await git(repo, "commit", "-qm", "symlink");
		await git(repo, "checkout", "-qb", "other");
		rmSync(join(repo, "link"));
		writeFileSync(join(repo, "link"), "picked\n");
		await git(repo, "add", "link");
		await git(repo, "commit", "-qm", "file");
		await git(repo, "checkout", "-q", "main");

		await vcsGitDiscover(repo)!.cherryPick("other");

		expect(readFileSync(victim, "utf8")).toBe("secret");
		expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(repo, "link"), "utf8")).toBe("picked\n");
	});

	test("applying a patch does not write a new file through a symlinked parent", async () => {
		const { repo, outside } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "kept\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "base");
		writeFileSync(join(repo, "dir/extra.txt"), "added\n");
		await git(repo, "add", "dir/extra.txt");
		await git(repo, "commit", "-qm", "add extra");
		const patch = await git(repo, "diff", "--no-ext-diff", "HEAD~1", "HEAD");
		await git(repo, "reset", "--hard", "-q", "HEAD~1");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		writeFileSync(join(linked, "file.txt"), "victim\n");
		rmSync(join(repo, "dir"), { recursive: true });
		symlinkSync(linked, join(repo, "dir"), "dir");

		await vcsGitDiscover(repo)!.applyPatch(patch, {});

		expect(lstatSync(join(linked, "file.txt")).isFile()).toBe(true);
		expect(readFileSync(join(linked, "file.txt"), "utf8")).toBe("victim\n");
		expect(() => lstatSync(join(linked, "extra.txt"))).toThrow();
		expect(readFileSync(join(repo, "dir/extra.txt"), "utf8")).toBe("added\n");
	});

	test("applying a deletion does not remove a file through a symlinked parent", async () => {
		const { repo, outside } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "gone\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "base");
		await git(repo, "rm", "-q", "dir/file.txt");
		await git(repo, "commit", "-qm", "delete");
		const patch = await git(repo, "diff", "--no-ext-diff", "HEAD~1", "HEAD");
		await git(repo, "reset", "--hard", "-q", "HEAD~1");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		writeFileSync(join(linked, "file.txt"), "gone\n");
		rmSync(join(repo, "dir"), { recursive: true });
		symlinkSync(linked, join(repo, "dir"), "dir");

		await vcsGitDiscover(repo)!.applyPatch(patch, {});

		expect(readFileSync(join(linked, "file.txt"), "utf8")).toBe("gone\n");
	});

	test("hard reset does not delete a file through a symlinked parent", async () => {
		const { repo, outside } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "tracked\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "base");
		await git(repo, "checkout", "-qb", "deleted");
		await git(repo, "rm", "-q", "dir/file.txt");
		await git(repo, "commit", "-qm", "delete");
		await git(repo, "checkout", "-q", "main");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		writeFileSync(join(linked, "file.txt"), "victim\n");
		rmSync(join(repo, "dir"), { recursive: true });
		symlinkSync(linked, join(repo, "dir"), "dir");

		await vcsGitDiscover(repo)!.reset("hard", "deleted");

		expect(readFileSync(join(linked, "file.txt"), "utf8")).toBe("victim\n");
	});

	test("applying a new gitlink does not follow a symlinked parent", async () => {
		const { repo, outside } = await fixture();
		writeFileSync(join(repo, "base.txt"), "base\n");
		await git(repo, "add", "base.txt");
		await git(repo, "commit", "-qm", "base");
		const commit = await git(repo, "rev-parse", "HEAD");
		await git(repo, "update-index", "--add", "--cacheinfo", `160000,${commit},dir/module`);
		const patch = await git(repo, "diff", "--cached", "--no-ext-diff");
		await git(repo, "reset", "-q");
		const linked = join(outside, "linked");
		mkdirSync(linked);
		symlinkSync(linked, join(repo, "dir"), "dir");

		await vcsGitDiscover(repo)!.applyPatch(patch, {});

		expect(lstatSync(join(repo, "dir/module")).isDirectory()).toBe(true);
		expect(lstatSync(join(repo, "dir")).isSymbolicLink()).toBe(false);
		expect(readdirSync(linked)).toEqual([]);
	});

	test("restore preserves private permissions and only adjusts executable bits", async () => {
		const { repo } = await fixture();
		const privateFile = join(repo, "private.txt");
		const tool = join(repo, "tool.sh");
		writeFileSync(privateFile, "old\n");
		chmodSync(privateFile, 0o600);
		writeFileSync(tool, "#!/bin/sh\nexit 0\n");
		chmodSync(tool, 0o755);
		await git(repo, "add", "private.txt", "tool.sh");
		await git(repo, "commit", "-qm", "permissions");
		writeFileSync(privateFile, "dirty\n");
		chmodSync(tool, 0o600);
		writeFileSync(tool, "dirty\n");

		await vcsGitDiscover(repo)!.restore({ files: ["private.txt", "tool.sh"], worktree: true });

		expect(readFileSync(privateFile, "utf8")).toBe("old\n");
		expect(statSync(privateFile).mode & 0o777).toBe(0o600);
		expect(statSync(tool).mode & 0o777).toBe(0o700);
	});

	test("restoring a missing file honors the process creation mask", async () => {
		const { repo } = await fixture();
		const privateFile = join(repo, "private.txt");
		writeFileSync(privateFile, "old\n");
		await git(repo, "add", "private.txt");
		await git(repo, "commit", "-qm", "private");
		rmSync(privateFile);
		const nativeUrl = pathToFileURL(join(import.meta.dir, "../native/index.js")).href;
		const driver = join(repo, "../restore-umask.mjs");
		writeFileSync(
			driver,
			`import { vcsGitDiscover } from ${JSON.stringify(nativeUrl)};\n` +
				`await vcsGitDiscover(process.argv[2]).restore({ files: ["private.txt"], worktree: true });\n`,
		);

		const child = Bun.spawn(["sh", "-c", 'umask 077; exec "$@"', "sh", process.execPath, driver, repo], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(stderr);

		expect(statSync(privateFile).mode & 0o777).toBe(0o600);
	});
});

describe("worktree materialization without symlink support", () => {
	test("hard reset skips a missing leaf whose parent is a regular file", async () => {
		const { repo } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "tracked\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "base");
		await git(repo, "checkout", "-qb", "deleted");
		await git(repo, "rm", "-q", "dir/file.txt");
		await git(repo, "commit", "-qm", "delete");
		await git(repo, "checkout", "-q", "main");
		rmSync(join(repo, "dir"), { recursive: true });
		writeFileSync(join(repo, "dir"), "blocking\n");

		await vcsGitDiscover(repo)!.reset("hard", "deleted");

		expect(lstatSync(join(repo, "dir")).isFile()).toBe(true);
		expect(readFileSync(join(repo, "dir"), "utf8")).toBe("blocking\n");
	});

	test("cherry-pick preserves an empty parent when a deleted leaf is already missing", async () => {
		const { repo } = await fixture();
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir/file.txt"), "tracked\n");
		await git(repo, "add", "dir/file.txt");
		await git(repo, "commit", "-qm", "base");
		await git(repo, "checkout", "-qb", "deleted");
		await git(repo, "rm", "-q", "dir/file.txt");
		await git(repo, "commit", "-qm", "delete");
		await git(repo, "checkout", "-q", "main");
		rmSync(join(repo, "dir/file.txt"));

		await vcsGitDiscover(repo)!.cherryPick("deleted");

		expect(lstatSync(join(repo, "dir")).isDirectory()).toBe(true);
		expect(readdirSync(join(repo, "dir"))).toEqual([]);
	});

	test("restore writes raw link text as a file when core.symlinks is false", async () => {
		const { repo } = await fixture();
		await git(repo, "config", "core.symlinks", "false");
		writeFileSync(join(repo, "original.txt"), "inside\n");
		writeFileSync(join(repo, "link-text"), "original.txt");
		const blob = await git(repo, "hash-object", "-w", "link-text");
		await git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
		await git(repo, "add", "original.txt");
		await git(repo, "commit", "-qm", "link");
		writeFileSync(join(repo, "link"), "other.txt");

		await vcsGitDiscover(repo)!.restore({ files: ["link"], worktree: true });

		expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(repo, "link"), "utf8")).toBe("original.txt");
	});
});
