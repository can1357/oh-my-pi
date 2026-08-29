import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const gitInitHelp = await $`git init -h`.quiet().nothrow().text();
const supportsReftable = gitInitHelp.includes("--ref-format");

describe.skipIf(!supportsReftable)("git reftable support", () => {
	// All git plumbing (init, commits, branch, worktree) is real I/O that exercises
	// the reftable backend, but none of it is the contract under test in the bodies
	// below — the bodies test our *resolution* code against an already-built reftable
	// repo. So the heavy plumbing is built once in beforeAll and shared:
	//   - `sharedRepoDir`: a reftable repo with two committed branches (main +
	//     feature-branch, HEAD on feature-branch), reused by the repository and
	//     worktree tests. Neither test mutates it, so one fixture is safe.
	//   - `worktreeDir`: a linked worktree (wt-branch) off the shared repo.
	//   - `configRepoDir`: a separate reftable repo for the config-comment test,
	//     which rewrites `.git/config` on disk and therefore must not share state.
	let sharedRepoDir: string;
	let worktreeDir: string;
	let configRepoDir: string;
	let headSha: string;

	beforeAll(async () => {
		// Shared reftable repo: two distinct commits on two branches so ref
		// resolution has independent main/feature-branch targets to resolve.
		sharedRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reftable-"));
		const initResult = await $`git init --ref-format=reftable --initial-branch=main`.cwd(sharedRepoDir).quiet();
		if (initResult.exitCode !== 0) throw new Error(`reftable git init failed (exit ${initResult.exitCode})`);
		await $`git config user.name "Test User"`.cwd(sharedRepoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(sharedRepoDir).quiet();
		await fs.writeFile(path.join(sharedRepoDir, "file.txt"), "hello world");
		await $`git add file.txt`.cwd(sharedRepoDir).quiet();
		await $`git commit -m "initial commit"`.cwd(sharedRepoDir).quiet();
		await $`git checkout -b feature-branch`.cwd(sharedRepoDir).quiet();
		await fs.writeFile(path.join(sharedRepoDir, "file2.txt"), "hello feature");
		await $`git add file2.txt`.cwd(sharedRepoDir).quiet();
		await $`git commit -m "feature commit"`.cwd(sharedRepoDir).quiet();
		// Ground-truth HEAD sha, resolved independently of our utilities.
		headSha = (await $`git rev-parse HEAD`.cwd(sharedRepoDir).quiet().text()).trim();

		// Linked worktree on its own branch, off the shared repo's HEAD.
		worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reftable-wt-"));
		await $`git worktree add ${worktreeDir} -b wt-branch`.cwd(sharedRepoDir).quiet();

		// Independent reftable repo for the config-comment test (no commits needed;
		// it only inspects/rewrites the freshly-initialized config).
		configRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reftable-cfg-"));
		const cfgInit = await $`git init --ref-format=reftable --initial-branch=main`.cwd(configRepoDir).quiet();
		if (cfgInit.exitCode !== 0) throw new Error(`reftable git init (config) failed (exit ${cfgInit.exitCode})`);
	});

	afterAll(async () => {
		await $`git worktree remove ${worktreeDir} -f`.cwd(sharedRepoDir).quiet().nothrow();
		await removeWithRetries(worktreeDir).catch(() => {});
		await removeWithRetries(sharedRepoDir).catch(() => {});
		await removeWithRetries(configRepoDir).catch(() => {});
	});

	test("resolves references in a reftable repository", async () => {
		const repository = vcs.git(sharedRepoDir);
		expect(repository).not.toBeNull();
		if (!repository) return;

		const currentBranch = await repository.currentBranch();
		expect(currentBranch).toBe("feature-branch");

		const resolvedHeadSha = await repository.headSha();
		expect(resolvedHeadSha).not.toBeNull();
		expect(resolvedHeadSha).toHaveLength(40);
		expect(resolvedHeadSha).toBe(headSha);

		// Resolve refs/heads/main and refs/heads/feature-branch
		const mainSha = await repository.resolveRef("refs/heads/main");
		const featureSha = await repository.resolveRef("refs/heads/feature-branch");
		expect(mainSha).not.toBeNull();
		expect(featureSha).not.toBeNull();
		expect(mainSha).toHaveLength(40);
		expect(featureSha).toHaveLength(40);
		expect(featureSha).toBe(headSha);

		// Test HEAD resolution (object shape)
		const headState = await repository.head();
		expect(headState).not.toBeNull();
		if (headState?.kind !== "ref") throw new Error("expected ref head");
		expect(headState.branch).toBe("feature-branch");
		expect(headState.commit).toBe(headSha);

		// Test HEAD resolution sync
		const headStateSync = repository.headSync();
		expect(headStateSync).not.toBeNull();
		if (headStateSync?.kind !== "ref") throw new Error("expected ref head sync");
		expect(headStateSync.branch).toBe("feature-branch");
		expect(headStateSync.commit).toBe(headSha);

		// Test exists check
		const mainExists = await repository.refExists("refs/heads/main");
		const nonexistentExists = await repository.refExists("refs/heads/nonexistent");
		expect(mainExists).toBe(true);
		expect(nonexistentExists).toBe(false);
	});

	test("handles git config trailing comments correctly", async () => {
		const repository = vcs.git(configRepoDir);
		expect(repository).not.toBeNull();
		if (!repository) return;
		expect(repository.info().isReftable).toBe(true);

		// Now let's manually write to .git/config with comments and test
		const configPath = path.join(repository.info().commonDir, "config");
		const baseConfig = await fs.readFile(configPath, "utf8");

		// Test trailing semicolon comment
		const newConfigWithSemicolon = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable ; trailing comment",
		);
		await fs.writeFile(configPath, newConfigWithSemicolon);

		const repository2 = vcs.git(configRepoDir);
		expect(repository2).not.toBeNull();
		if (repository2) {
			expect(repository2.info().isReftable).toBe(true);
			expect(repository2.info().isReftable).toBe(true);
		}

		// Test trailing hash comment
		const newConfigWithHash = baseConfig.replace("refstorage = reftable", "refstorage = reftable # trailing hash");
		await fs.writeFile(configPath, newConfigWithHash);

		const repository3 = vcs.git(configRepoDir);
		expect(repository3).not.toBeNull();
		if (repository3) {
			expect(repository3.info().isReftable).toBe(true);
			expect(repository3.info().isReftable).toBe(true);
		}

		// Test double-quoted value containing semicolon (not a comment)
		const newConfigWithQuotes = baseConfig.replace("refstorage = reftable", 'refstorage = "reftable ; not comment"');
		await fs.writeFile(configPath, newConfigWithQuotes);

		const repository4 = vcs.git(configRepoDir);
		expect(repository4).not.toBeNull();
		if (repository4) {
			// This value would be "reftable ; not comment", which shouldn't match "reftable"
			expect(repository4.info().isReftable).toBe(false);
			expect(repository4.info().isReftable).toBe(false);
		}

		// Test adjacent hash comment (no preceding space)
		const newConfigWithAdjacentHash = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable#adjacenthash",
		);
		await fs.writeFile(configPath, newConfigWithAdjacentHash);

		const repository5 = vcs.git(configRepoDir);
		expect(repository5).not.toBeNull();
		if (repository5) {
			expect(repository5.info().isReftable).toBe(true);
			expect(repository5.info().isReftable).toBe(true);
		}

		// Test adjacent semicolon comment (no preceding space)
		const newConfigWithAdjacentSemicolon = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable;adjacentsemi",
		);
		await fs.writeFile(configPath, newConfigWithAdjacentSemicolon);

		const repository6 = vcs.git(configRepoDir);
		expect(repository6).not.toBeNull();
		if (repository6) {
			expect(repository6.info().isReftable).toBe(true);
			expect(repository6.info().isReftable).toBe(true);
		}

		// Test section header with trailing comment
		const newConfigWithSectionComment = baseConfig.replace(
			"[extensions]",
			"[extensions] # extensions section comment",
		);
		await fs.writeFile(configPath, newConfigWithSectionComment);

		const repository7 = vcs.git(configRepoDir);
		expect(repository7).not.toBeNull();
		if (repository7) {
			expect(repository7.info().isReftable).toBe(true);
			expect(repository7.info().isReftable).toBe(true);
		}
	});

	test("resolves references in a reftable worktree", async () => {
		// Resolve the repository for the worktree (built in beforeAll)
		const repository = vcs.git(worktreeDir);
		expect(repository).not.toBeNull();
		if (!repository) return;

		expect(repository.info().gitDir).not.toBe(repository.info().commonDir);
		expect(repository.info().isReftable).toBe(true);

		// Check current branch on worktree
		const currentBranch = await repository.currentBranch();
		expect(currentBranch).toBe("wt-branch");

		// Check that HEAD resolves correctly in the worktree
		const headState = await repository.head();
		expect(headState).not.toBeNull();
		if (headState?.kind !== "ref") throw new Error("expected ref head in worktree");
		expect(headState.branch).toBe("wt-branch");
	});
});
