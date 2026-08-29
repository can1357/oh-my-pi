import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

describe("git reference directory fallback", () => {
	let repoDir: string;
	let commitSha: string;

	beforeAll(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ref-fallback-"));
		const initResult = await $`git init --initial-branch=main`.cwd(repoDir).quiet();
		if (initResult.exitCode !== 0) throw new Error("git init failed");
		await $`git config user.name "Test User"`.cwd(repoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(repoDir).quiet();
		await fs.writeFile(path.join(repoDir, "file.txt"), "hello world");
		await $`git add file.txt`.cwd(repoDir).quiet();
		await $`git commit -m "initial commit"`.cwd(repoDir).quiet();

		commitSha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet().text()).trim();

		// We will simulate a situation where:
		// There is a branch called "pi-flash" which is packed (in packed-refs).
		// But there is also a subdirectory created inside refs/heads under the same name:
		// refs/heads/pi-flash/... because a branch called "pi-flash/something" exists as a loose ref.
		// Thus:
		// 1. refs/heads/pi-flash is a directory on disk.
		// 2. packed-refs contains: <commitSha> refs/heads/pi-flash
		// In this case, trying to read refs/heads/pi-flash as a file throws EISDIR.
		// We want to verify that we gracefully handle this and fallback to resolving from packed-refs.

		// Let's pack the current main branch as refs/heads/pi-flash so we have it in packed-refs
		await $`git update-ref refs/heads/pi-flash ${commitSha}`.cwd(repoDir).quiet();
		// Also point HEAD to refs/heads/pi-flash so we exercise HEAD -> ref -> readRef / readRefSync
		await fs.writeFile(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/pi-flash\n");
		await $`git pack-refs --all`.cwd(repoDir).quiet();
		// Check that packed-refs exists
		const packedRefs = await fs.readFile(path.join(repoDir, ".git", "packed-refs"), "utf8");
		expect(packedRefs).toContain("refs/heads/pi-flash");

		// Delete the loose ref file for refs/heads/pi-flash if git pack-refs didn't already delete it (it usually does).
		await removeWithRetries(path.join(repoDir, ".git", "refs", "heads", "pi-flash"));

		// Now, create refs/heads/pi-flash as a directory to simulate another branch like "pi-flash/feature" existing.
		// We can just create the directory and a file inside it, or just the directory.
		await fs.mkdir(path.join(repoDir, ".git", "refs", "heads", "pi-flash"), { recursive: true });
		await fs.writeFile(path.join(repoDir, ".git", "refs", "heads", "pi-flash", "feature"), commitSha);
	});

	afterAll(async () => {
		await removeWithRetries(repoDir).catch(() => {});
	});

	test("resolves branch that has directory conflict via resolveSync on head", () => {
		const headStateSync = vcs.requireGit(repoDir).headSync();
		expect(headStateSync).not.toBeNull();
		if (!headStateSync) return;
		expect(headStateSync.commit).toBe(commitSha);
	});

	test("resolves branch that has directory conflict via resolve on ref", async () => {
		const repository = vcs.git(repoDir);
		expect(repository).not.toBeNull();
		if (!repository) return;
		const resolved = await repository.resolveRef("refs/heads/pi-flash");
		expect(resolved).toBe(commitSha);
	});
});
