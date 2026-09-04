import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import { runSplitCommit } from "@oh-my-pi/pi-coding-agent/commit/agentic";
import type { SplitCommitPlan } from "@oh-my-pi/pi-coding-agent/commit/agentic/state";
import { applyChangelogProposals } from "@oh-my-pi/pi-coding-agent/commit/changelog";
import * as changelogModule from "@oh-my-pi/pi-coding-agent/commit/changelog/generate";
import * as generateModule from "@oh-my-pi/pi-coding-agent/commit/conventional/generate";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function commitSpec(
	summary: string,
	changes: SplitCommitPlan["commits"][number]["changes"],
	type: "feat" | "fix" = "feat",
): SplitCommitPlan["commits"][number] {
	return {
		changes,
		type,
		scope: null,
		summary,
		details: [],
		issueRefs: [],
		dependencies: [],
	};
}

describe.serial("commit staging safety and non-mutating dry-run", () => {
	let tmp: TempDir;
	let origDir: string;
	let settingsState: SettingsTestState | undefined;
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		origDir = process.cwd();
		tmp = await TempDir.create("@commit-staging-safety-");
		setProjectDir(tmp.path());
		await $`git init --initial-branch=main`.cwd(tmp.path()).quiet();
		await $`git config user.name "Test"`.cwd(tmp.path()).quiet();
		await $`git config user.email "test@example.com"`.cwd(tmp.path()).quiet();

		await Bun.write(tmp.join("tracked.txt"), "initial content\n");
		await $`git add tracked.txt`.cwd(tmp.path()).quiet();
		await $`git commit -m "initial commit"`.cwd(tmp.path()).quiet();

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
		vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
			model: { name: "test-primary", provider: "test", id: "test" } as never,
			apiKey: "test-key",
		});
		vi.spyOn(modelSelection, "resolveSmolModel").mockResolvedValue({
			model: { name: "test-smol", provider: "test", id: "test" } as never,
			apiKey: "test-key",
			thinkingLevel: undefined,
		});
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);

		vi.spyOn(generateModule, "generateConventionalCommit").mockResolvedValue({
			commit: {
				type: "feat",
				scope: null,
				summary: "implement feature",
				body: [],
				footers: [],
			},
			validationError: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		delete process.env.PI_COMMIT_TEST_FALLBACK;
		restoreSettingsTestState(settingsState);
		setProjectDir(origDir);
		await tmp.remove();
	});

	it("refuses to auto-stage on clean index without --all flag", async () => {
		// Modify tracked file and add an untracked scratch file
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		const repo = vcs.requireGit(tmp.path());
		const stagedBefore = await repo.changedFiles({ cached: true });
		expect(stagedBefore).toEqual([]);

		// Run commit without --all
		const result = await runCommitCommand({
			push: false,
			dryRun: false,
			noChangelog: true,
			all: false,
		});

		expect(result).toEqual({ usedFallback: false });

		// Index MUST remain clean: no files auto-staged
		const stagedAfter = await repo.changedFiles({ cached: true });
		expect(stagedAfter).toEqual([]);

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("M tracked.txt\n?? scratch.txt");
	});

	it("dry-run is strictly non-mutating and does not stage changes", async () => {
		for (const legacy of [false, true]) {
			await Bun.write(tmp.join("tracked.txt"), "modified content\n");
			await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

			const repo = vcs.requireGit(tmp.path());

			// Dry-run should never alter the index even with --all
			await runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				all: true,
				legacy,
			});

			const stagedAfter = await repo.changedFiles({ cached: true });
			expect(stagedAfter).toEqual([]);

			const status = await $`git status --porcelain`.cwd(tmp.path()).text();
			expect(status.trim()).toBe("M tracked.txt\n?? scratch.txt");

			// Clean up scratch file and reset tracked.txt for next iteration
			await $`git checkout -- tracked.txt`.cwd(tmp.path()).quiet();
			await $`rm -f scratch.txt`.cwd(tmp.path()).quiet();
		}
	});

	it("dry-run with --push never pushes when nothing is staged", async () => {
		const remote = tmp.join("remote.git");
		await $`git init --bare ${remote}`.quiet();
		await $`git remote add origin ${remote}`.cwd(tmp.path()).quiet();
		await $`git push -q origin main`.cwd(tmp.path()).quiet();
		const pushedHead = (await $`git rev-parse HEAD`.cwd(tmp.path()).text()).trim();

		// Local is one commit ahead; a real push would advance the remote.
		await Bun.write(tmp.join("tracked.txt"), "ahead\n");
		await $`git commit -qam "ahead of remote"`.cwd(tmp.path()).quiet();

		for (const legacy of [false, true]) {
			await runCommitCommand({ all: false, push: true, dryRun: true, noChangelog: true, legacy });
			const remoteHead = (await $`git rev-parse main`.cwd(remote).text()).trim();
			expect(remoteHead).toBe(pushedHead);
		}
	});

	it("explicit --all stages all changes before committing", async () => {
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		// Run commit with --all and dryRun: false, forcing fallback to complete without LLM
		process.env.PI_COMMIT_TEST_FALLBACK = "true";

		const result = await runCommitCommand({
			push: false,
			dryRun: false,
			noChangelog: true,
			all: true,
		});

		expect(result).toEqual({ usedFallback: true });

		// Both files should have been staged and committed
		const repo = vcs.requireGit(tmp.path());
		const stagedAfter = await repo.changedFiles({ cached: true });
		expect(stagedAfter).toEqual([]);

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("");

		const log = await $`git log -n 1 --oneline`.cwd(tmp.path()).text();
		expect(log).toMatch(/docs:|chore:/);
	});

	it("legacy changelog flow does not sweep unstaged changelog edit adjacent in same hunk into commit", async () => {
		const changelogContent = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline feature\n";
		await Bun.write(tmp.join("CHANGELOG.md"), changelogContent);
		await $`git add CHANGELOG.md`.cwd(tmp.path()).quiet();
		await $`git commit -m "commit baseline changelog"`.cwd(tmp.path()).quiet();

		// Stage a code change
		await Bun.write(tmp.join("feature.txt"), "feature code\n");
		await $`git add feature.txt`.cwd(tmp.path()).quiet();

		// Add an unstaged user edit directly adjacent in the same Unreleased section
		const dirtyChangelog = `${changelogContent}- My private unstaged scratch note in same hunk\n`;
		await Bun.write(tmp.join("CHANGELOG.md"), dirtyChangelog);

		vi.spyOn(changelogModule, "generateChangelogEntries").mockResolvedValue({
			entries: {
				Fixed: ["Fixed bug in tracked file"],
			},
		});

		await runCommitCommand({
			legacy: true,
			dryRun: false,
			noChangelog: false,
			all: false,
			push: false,
		});

		// Committed changelog at HEAD must have generated entry, but NOT the unstaged scratch note
		const committedChangelog = await $`git show HEAD:CHANGELOG.md`.cwd(tmp.path()).text();
		expect(committedChangelog).toContain("Fixed bug in tracked file");
		expect(committedChangelog).not.toContain("My private unstaged scratch note in same hunk");

		// Worktree file on disk must retain the unstaged edit
		const onDisk = await Bun.file(tmp.join("CHANGELOG.md")).text();
		expect(onDisk).toContain("My private unstaged scratch note in same hunk");

		// Status must show MM CHANGELOG.md (or M)
		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status).toContain("CHANGELOG.md");

		// Unstaged diff must contain ONLY the scratch note
		const diff = await $`git diff CHANGELOG.md`.cwd(tmp.path()).text();
		expect(diff).toContain("+- My private unstaged scratch note in same hunk");
		expect(diff).not.toContain("+- Fixed bug in tracked file");
	});

	it("skips changelog staging when indexed baseline lacks [Unreleased] section, preserving unstaged worktree edits", async () => {
		const changelogPath = tmp.join("CHANGELOG.md");
		const releasedOnlyContent =
			"# Changelog\n\n## [1.0.0] - 2026-09-01\n\n### Added\n\n- Existing released feature\n";
		await Bun.write(changelogPath, releasedOnlyContent);
		await $`git add CHANGELOG.md`.cwd(tmp.path()).quiet();
		await $`git commit -m "init released changelog"`.cwd(tmp.path()).quiet();

		// Worktree adds an unstaged [Unreleased] section with private feature
		const dirtyWorktree = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- My unstaged worktree feature\n\n## [1.0.0] - 2026-09-01\n\n### Added\n\n- Existing released feature\n`;
		await Bun.write(changelogPath, dirtyWorktree);

		const repo = vcs.requireGit(tmp.path());

		await applyChangelogProposals({
			cwd: tmp.path(),
			proposals: [
				{
					path: changelogPath,
					entries: {
						Fixed: ["Fixed bug in tracked file"],
					},
				},
			],
			dryRun: false,
		});

		// Indexed blob must NOT contain [Unreleased] or the unstaged worktree feature
		const blob = await repo.showBlob(":CHANGELOG.md");
		const indexContent = blob.data.toString("utf8");
		expect(indexContent).not.toContain("## [Unreleased]");
		expect(indexContent).not.toContain("My unstaged worktree feature");
		expect(indexContent).toBe(releasedOnlyContent);

		// Worktree on disk must retain the unstaged worktree feature
		const onDisk = await Bun.file(changelogPath).text();
		expect(onDisk).toContain("My unstaged worktree feature");

		// Status must still show CHANGELOG.md as modified in the worktree
		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("M CHANGELOG.md");
	});

	it("user rejecting the split plan leaves HEAD, index, and changelog untouched", async () => {
		const changelogContent = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline feature\n";
		await Bun.write(tmp.join("CHANGELOG.md"), changelogContent);
		await $`git add CHANGELOG.md`.cwd(tmp.path()).quiet();
		await $`git commit -qm "baseline changelog"`.cwd(tmp.path()).quiet();
		await Bun.write(tmp.join("file1.txt"), "f1\n");
		await $`git add file1.txt`.cwd(tmp.path()).quiet();

		const repo = vcs.requireGit(tmp.path());
		const headBefore = (await $`git rev-parse HEAD`.cwd(tmp.path()).text()).trim();
		const stagedBefore = await repo.changedFiles({ cached: true });

		await runSplitCommit(
			{
				commits: [commitSpec("add file1", [{ path: "file1.txt", kind: "all" }])],
				warnings: [],
			},
			{
				cwd: tmp.path(),
				dryRun: false,
				push: false,
				changelogProposal: { entries: [{ path: tmp.join("CHANGELOG.md"), entries: { Added: ["Added file1"] } }] },
				confirm: async () => false,
			},
		);

		expect((await $`git rev-parse HEAD`.cwd(tmp.path()).text()).trim()).toBe(headBefore);
		expect(await repo.changedFiles({ cached: true })).toEqual(stagedBefore);
		expect(await Bun.file(tmp.join("CHANGELOG.md")).text()).toBe(changelogContent);
	});

	it("split commit creates one commit per plan entry atomically and leaves a clean index", async () => {
		await Bun.write(tmp.join("file1.txt"), "f1\n");
		await Bun.write(tmp.join("file2.txt"), "f2\n");
		await Bun.write(tmp.join("tracked.txt"), "modified tracked content\n");
		await $`git add file1.txt file2.txt tracked.txt`.cwd(tmp.path()).quiet();

		const countBefore = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);

		const plan: SplitCommitPlan = {
			commits: [
				commitSpec("add file1", [{ path: "file1.txt", kind: "all" }]),
				commitSpec("add file2", [{ path: "file2.txt", kind: "all" }]),
				commitSpec("update tracked", [{ path: "tracked.txt", kind: "all" }], "fix"),
			],
			warnings: [],
		};

		await runSplitCommit(plan, {
			cwd: tmp.path(),
			dryRun: false,
			push: false,
		});

		const countAfter = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);
		expect(countAfter - countBefore).toBe(3);

		const logSubjects = await $`git log --format=%s -n 3`.cwd(tmp.path()).text();
		expect(logSubjects).toContain("feat: add file1");
		expect(logSubjects).toContain("feat: add file2");
		expect(logSubjects).toContain("fix: update tracked");

		const commit1Files = (await $`git show --stat --format= HEAD~2`.cwd(tmp.path()).text()).trim();
		expect(commit1Files).toContain("file1.txt");
		expect(commit1Files).not.toContain("file2.txt");
		expect(commit1Files).not.toContain("tracked.txt");

		const status = (await $`git status --porcelain`.cwd(tmp.path()).text()).trim();
		expect(status).toBe("");
	});

	it("split commit with hunk-level selections routes each hunk to its commit", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		await Bun.write(tmp.join("multi.txt"), lines);
		await $`git add multi.txt`.cwd(tmp.path()).quiet();
		await $`git commit -m "add multi.txt"`.cwd(tmp.path()).quiet();

		const modifiedLines = lines.replace("line 2\n", "line 2 modified\n").replace("line 28\n", "line 28 modified\n");
		await Bun.write(tmp.join("multi.txt"), modifiedLines);
		await $`git add multi.txt`.cwd(tmp.path()).quiet();

		const plan: SplitCommitPlan = {
			commits: [
				commitSpec("update hunk 1", [{ path: "multi.txt", kind: "indices", indices: [1] }]),
				commitSpec("update hunk 2", [{ path: "multi.txt", kind: "indices", indices: [2] }]),
			],
			warnings: [],
		};

		await runSplitCommit(plan, {
			cwd: tmp.path(),
			dryRun: false,
			push: false,
		});

		const headMinusOneContent = await $`git show HEAD~1:multi.txt`.cwd(tmp.path()).text();
		expect(headMinusOneContent).toContain("line 2 modified");
		expect(headMinusOneContent).not.toContain("line 28 modified");
		expect(headMinusOneContent).toContain("line 28\n");

		const headContent = await $`git show HEAD:multi.txt`.cwd(tmp.path()).text();
		expect(headContent).toContain("line 2 modified");
		expect(headContent).toContain("line 28 modified");

		const status = (await $`git status --porcelain`.cwd(tmp.path()).text()).trim();
		expect(status).toBe("");
	});
});
