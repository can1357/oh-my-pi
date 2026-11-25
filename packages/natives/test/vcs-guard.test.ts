import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vcs from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	vcs.setRepoGuard(undefined);
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

async function repository(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-natives-vcs-guard-")));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await writeFile(join(root, "tracked.txt"), "one\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

/** Guard that refuses any repository whose git entry, git dir or common dir lies under `refused`. */
function refuseUnder(refused: string): void {
	vcs.setRepoGuard(paths => !paths.some(candidate => candidate === refused || candidate.startsWith(`${refused}/`)));
}

describe("repo guard coverage", () => {
	test("headSync throws a Refused VcsError synchronously, for handles created before the guard", async () => {
		const root = await repository();
		const handle = vcs.requireGit(root);
		expect(handle.headSync()).toMatchObject({ kind: "ref", branch: "main" });

		refuseUnder(root);
		let thrown: unknown;
		try {
			handle.headSync();
		} catch (error) {
			thrown = error;
		}
		expect(vcs.isVcsError(thrown)).toBe(true);
		expect(thrown).toMatchObject({ code: "Refused" });
		// Pure metadata stays readable.
		expect(handle.info().repoRoot).toBe(root);

		vcs.setRepoGuard(undefined);
		expect(handle.headSync()).toMatchObject({ kind: "ref", branch: "main" });
	});

	test("headSync of an unrefused repository is untouched by a guard refusing another", async () => {
		const refused = await repository();
		const allowed = await repository();
		refuseUnder(refused);
		expect(vcs.requireGit(allowed).headSync()).toMatchObject({ kind: "ref", branch: "main" });
	});

	test("detachGitDir refuses when the worktree's git metadata is refused", async () => {
		const source = await repository();
		const iso = await repository();
		const sourceCommonDir = vcs.requireGit(source).info().commonDir;

		refuseUnder(iso);
		await expect(vcs.detachGitDir(iso, sourceCommonDir)).rejects.toMatchObject({ code: "Refused" });
		expect(existsSync(join(iso, ".git"))).toBe(true);
	});

	test("detachGitDir refuses when the source common dir is refused", async () => {
		const source = await repository();
		const iso = await repository();
		const sourceCommonDir = vcs.requireGit(source).info().commonDir;

		refuseUnder(source);
		await expect(vcs.detachGitDir(iso, sourceCommonDir)).rejects.toMatchObject({ code: "Refused" });
	});

	test("detachGitDir proceeds when nothing is refused", async () => {
		const source = await repository();
		const iso = await repository();
		const sourceCommonDir = vcs.requireGit(source).info().commonDir;

		refuseUnder(await mkdtemp(join(tmpdir(), "pi-natives-vcs-guard-unrelated-")));
		expect(await vcs.detachGitDir(iso, sourceCommonDir)).toBe("independent");
	});

	test("copyGitObjects refuses when the isolation root is refused", async () => {
		const source = await repository();
		const iso = await repository();
		await writeFile(join(iso, "blob.txt"), "isolated only\n");
		const oid = await git(iso, "hash-object", "-w", "blob.txt");

		refuseUnder(iso);
		await expect(vcs.copyGitObjects(iso, source)).rejects.toMatchObject({ code: "Refused" });
		expect(existsSync(join(vcs.requireGit(source).info().commonDir, "objects", oid.slice(0, 2), oid.slice(2)))).toBe(
			false,
		);
	});

	test("copyGitObjects refuses when the source root is refused and copies nothing", async () => {
		const source = await repository();
		const iso = await repository();
		const blob = join(iso, "blob.txt");
		await writeFile(blob, "isolated only\n");
		const oid = await git(iso, "hash-object", "-w", blob);

		refuseUnder(source);
		await expect(vcs.copyGitObjects(iso, source)).rejects.toMatchObject({ code: "Refused" });
		expect(existsSync(join(vcs.requireGit(source).info().commonDir, "objects", oid.slice(0, 2), oid.slice(2)))).toBe(
			false,
		);
	});

	test("copyGitObjects copies real objects when unrefused", async () => {
		const source = await repository();
		const iso = await repository();
		const blob = join(iso, "blob.txt");
		await writeFile(blob, "isolated only\n");
		const oid = await git(iso, "hash-object", "-w", blob);

		await vcs.copyGitObjects(iso, source);
		expect(await git(source, "cat-file", "-p", oid)).toBe("isolated only");
	});
});

describe("copyGitObjects symlinks", () => {
	test("does not copy the target of a symlinked loose object", async () => {
		const source = await repository();
		const iso = await repository();
		const secret = join(await realpath(await mkdtemp(join(tmpdir(), "pi-natives-vcs-secret-"))), "secret.txt");
		roots.push(join(secret, ".."));
		await writeFile(secret, "host secret\n");

		const fan = "ab";
		const name = "c".repeat(38);
		const isoFan = join(vcs.requireGit(iso).info().commonDir, "objects", fan);
		await mkdir(isoFan, { recursive: true });
		await symlink(secret, join(isoFan, name));

		// A real object alongside proves the walk still copies regular files.
		const blob = join(iso, "blob.txt");
		await writeFile(blob, "isolated only\n");
		const oid = await git(iso, "hash-object", "-w", blob);

		await vcs.copyGitObjects(iso, source);

		const sourceObjects = join(vcs.requireGit(source).info().commonDir, "objects");
		expect(existsSync(join(sourceObjects, fan, name))).toBe(false);
		expect(await git(source, "cat-file", "-p", oid)).toBe("isolated only");
	});

	test("does not copy the target of a symlinked pack file", async () => {
		const source = await repository();
		const iso = await repository();
		const secret = join(await realpath(await mkdtemp(join(tmpdir(), "pi-natives-vcs-secret-"))), "secret.bin");
		roots.push(join(secret, ".."));
		await writeFile(secret, "host secret\n");

		const packName = `pack-${"d".repeat(40)}.pack`;
		const isoPack = join(vcs.requireGit(iso).info().commonDir, "objects", "pack");
		await mkdir(isoPack, { recursive: true });
		await symlink(secret, join(isoPack, packName));

		await vcs.copyGitObjects(iso, source);

		expect(existsSync(join(vcs.requireGit(source).info().commonDir, "objects", "pack", packName))).toBe(false);
		expect(await readFile(secret, "utf8")).toBe("host secret\n");
	});

	test("does not follow a symlinked objects root", async () => {
		const source = await repository();
		const iso = await repository();
		const store = await realpath(await mkdtemp(join(tmpdir(), "pi-natives-vcs-store-")));
		roots.push(store);
		const fan = "ab";
		const name = "c".repeat(38);
		await mkdir(join(store, fan), { recursive: true });
		await writeFile(join(store, fan, name), "host-only object\n");

		const isoObjects = join(vcs.requireGit(iso).info().commonDir, "objects");
		await rm(isoObjects, { force: true, recursive: true });
		await symlink(store, isoObjects);

		await vcs.copyGitObjects(iso, source);

		expect(existsSync(join(vcs.requireGit(source).info().commonDir, "objects", fan, name))).toBe(false);
	});
});
