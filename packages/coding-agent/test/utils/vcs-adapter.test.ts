import { afterEach, describe, expect, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

const repos: string[] = [];

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-vcs-adapter-"));
	repos.push(repo);
	await $`git init --initial-branch=main`.cwd(repo).quiet();
	await $`git config user.name "Test User"`.cwd(repo).quiet();
	await $`git config user.email "test@example.com"`.cwd(repo).quiet();
	return repo;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(repos.splice(0).map(repo => fs.rm(repo, { recursive: true, force: true })));
});

describe("native Git adapter regressions", () => {
	test("status collapses a populated untracked directory and ignores empty trees", async () => {
		const repo = await createRepo();
		await fs.mkdir(path.join(repo, "newdir"));
		await Promise.all([
			Bun.write(path.join(repo, "newdir", "a"), "a\n"),
			Bun.write(path.join(repo, "newdir", "b"), "b\n"),
			fs.mkdir(path.join(repo, "empty", "nested"), { recursive: true }),
		]);

		expect(await vcs.requireGit(repo).statusSummary()).toEqual({ staged: 0, unstaged: 0, untracked: 1 });
	});

	test("alternate-index tree synthesis leaves the real index untouched", async () => {
		const repo = await createRepo();
		await Bun.write(path.join(repo, "tracked.txt"), "before\n");
		await $`git add tracked.txt`.cwd(repo).quiet();
		await $`git commit -m baseline`.cwd(repo).quiet();

		const indexPath = path.join(repo, ".git", "synthetic.index");
		const repository = vcs.requireGit(repo);
		await repository.readTree("HEAD", indexPath);
		await repository.applyPatch(
			[
				"diff --git a/tracked.txt b/tracked.txt",
				"--- a/tracked.txt",
				"+++ b/tracked.txt",
				"@@ -1 +1 @@",
				"-before",
				"+after",
				"",
			].join("\n"),
			{ cached: true, indexPath },
		);
		const tree = await repository.writeTree(indexPath);

		expect(await $`git show ${tree}:tracked.txt`.cwd(repo).quiet().text()).toBe("after\n");
		expect(await $`git status --porcelain`.cwd(repo).quiet().text()).toBe("");
	});
	test("headSync stays authoritative when a JS read of HEAD raises EINTR", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-vcs-adapter-"));
		repos.push(repo);
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const gitDir = path.join(repo, ".git");
		await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(gitDir, "refs", "heads", "main"), `${commit}\n`);
		const headPath = path.join(gitDir, "HEAD");

		const realReadFileSync = nodeFs.readFileSync;
		vi.spyOn(nodeFs, "readFileSync").mockImplementation(((
			filePath: nodeFs.PathOrFileDescriptor,
			options?: unknown,
		) => {
			if (typeof filePath === "string" && filePath === headPath) {
				throw Object.assign(new Error("interrupted system call"), { code: "EINTR" });
			}
			return (realReadFileSync as (target: nodeFs.PathOrFileDescriptor, opts?: unknown) => string | Buffer)(
				filePath,
				options,
			);
		}) as typeof nodeFs.readFileSync);

		expect(vcs.requireGit(repo).headSync()).toMatchObject({
			kind: "ref",
			branch: "main",
			commit,
		});
	});

	test("recreates split commits when one commit contains a newly created file", async () => {
		const packageRoot = path.join(import.meta.dir, "..", "..");
		const script = `
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-split-commit-"));
try {
	await $\`git init --initial-branch=main\`.cwd(dir).quiet();
	await $\`git config user.email tester@example.com\`.cwd(dir).quiet();
	await $\`git config user.name Tester\`.cwd(dir).quiet();
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\n");
	await $\`git add tracked.txt\`.cwd(dir).quiet();
	await $\`git commit -m baseline\`.cwd(dir).quiet();
	let repo = vcs.requireGit(dir);
	// #10130: omp-vcs memoizes a gix index snapshot and only refreshes it when the
	// index mtime is strictly newer than the snapshot's own timestamp. Both of the
	// stage -> commit pairs below can land inside a single mtime tick on a fresh
	// tmpdir, so the second read is served the pre-stage index and commitCreate
	// reports "nothing to commit, working tree clean". Pushing the index mtime
	// forward after every mutation makes that staleness check fire every time.
	// PR CI runs against the published natives addon rather than a locally built
	// one (.github/workflows/ci.yml: "PRs never build"), so the pi-vcs-side fix in
	// #10132 cannot green this job until it ships in a release. Drop this helper
	// once a natives release carrying #10132 is the default for PR runs.
	// The tick keeps each bump strictly greater than the previous one even if two
	// bumps land in the same millisecond, so the comparison can never tie.
	const indexPath = path.join(dir, ".git", "index");
	let indexTick = 0;
	const freshenIndex = async () => {
		indexTick += 1;
		const when = new Date(Date.now() + indexTick * 1000);
		await fs.utimes(indexPath, when, when);
		// Re-acquire the handle too: the mtime bump only invalidates the snapshot
		// the next time a handle consults it, and a handle whose OnceLock already
		// resolved keeps the stale one for its whole lifetime. requireGit() builds
		// a brand new GitRepo (new OnceLock) on every call, so this is cheap.
		repo = vcs.requireGit(dir);
	};
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\ntracked change\\n");
	await fs.writeFile(path.join(dir, "new-file.txt"), "sample data\\n");
	await repo.stageFiles([]);
	await freshenIndex();
	const originalStagedDiff = await repo.diffText({ cached: true });
	await repo.unstage([]);
	await freshenIndex();
	await repo.stageHunks([{ path: "new-file.txt", kind: "all" }], originalStagedDiff);
	await freshenIndex();
	const firstStage = await repo.changedFiles({ cached: true });
	if (!Bun.deepEquals(firstStage, ["new-file.txt"])) {
		throw new Error("unexpected first stage: " + JSON.stringify(firstStage));
	}
	await repo.commitCreate("feat: add new file", {});
	await freshenIndex();
	await repo.stageHunks([{ path: "tracked.txt", kind: "all" }], originalStagedDiff);
	await freshenIndex();
	const secondStage = await repo.changedFiles({ cached: true });
	if (!Bun.deepEquals(secondStage, ["tracked.txt"])) {
		throw new Error("unexpected second stage: " + JSON.stringify(secondStage));
	}
	await repo.commitCreate("fix: update tracked file", {});
	await freshenIndex();
	const log = (await $\`git log --format=%s -2\`.cwd(dir).text()).trim().split("\\n");
	if (!Bun.deepEquals(log, ["fix: update tracked file", "feat: add new file"])) {
		throw new Error("unexpected log: " + JSON.stringify(log));
	}
	const summary = await repo.statusSummary();
	if (!Bun.deepEquals(summary, { staged: 0, unstaged: 0, untracked: 0 })) {
		throw new Error("unexpected status: " + JSON.stringify(summary));
	}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}
`;
		const result = await $`${process.execPath} --eval ${script}`.cwd(packageRoot).quiet().nothrow();
		// `.quiet()` captures the child's output; surface it when the child fails so a
		// red run names the actual VcsError instead of only "Expected: 0 / Received: 1".
		if (result.exitCode !== 0) {
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();
			throw new Error(`split-commit child exited ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}
		expect(result.exitCode).toBe(0);
	});
});
