import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

describe("issue #966 split commit restaging", () => {
	it("recreates split commits when one commit contains a newly created file", async () => {
		const packageRoot = path.join(import.meta.dir, "..");
		const script = `
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-966-"));
try {
	await $\`git init --initial-branch=main\`.cwd(dir).quiet();
	await $\`git config user.email tester@example.com\`.cwd(dir).quiet();
	await $\`git config user.name Tester\`.cwd(dir).quiet();
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\n");
	await $\`git add tracked.txt\`.cwd(dir).quiet();
	await $\`git commit -m baseline\`.cwd(dir).quiet();
	let repo = vcs.requireGit(dir);
	// #10130: pi-vcs memoizes a gix index snapshot and only refreshes it when the
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
		const result = await $`bun --eval ${script}`.cwd(packageRoot).quiet().nothrow();
		// `.quiet()` captures the child's output; surface it when the child fails so a
		// red run names the actual VcsError instead of only "Expected: 0 / Received: 1".
		if (result.exitCode !== 0) {
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();
			throw new Error(`issue-966 repro child exited ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}
		expect(result.exitCode).toBe(0);
	});
});
