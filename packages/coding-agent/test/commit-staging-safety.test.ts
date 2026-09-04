import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { CommitAbortedError, runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import { runSplitCommit } from "@oh-my-pi/pi-coding-agent/commit/agentic";
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
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		const repo = vcs.requireGit(tmp.path());

		// Dry-run should never alter the index even with --all
		await runCommitCommand({
			push: false,
			dryRun: true,
			noChangelog: true,
			all: true,
		});

		const stagedAfter = await repo.changedFiles({ cached: true });
		expect(stagedAfter).toEqual([]);

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("M tracked.txt\n?? scratch.txt");
	});

	it("legacy dry-run is strictly non-mutating", async () => {
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		const repo = vcs.requireGit(tmp.path());

		await runCommitCommand({
			all: true,
			push: false,
			dryRun: true,
			noChangelog: true,
			legacy: true,
		});

		const stagedAfter = await repo.changedFiles({ cached: true });
		expect(stagedAfter).toEqual([]);

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("M tracked.txt\n?? scratch.txt");
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

	it("applyChangelogProposals preserves both pre-staged and unstaged edits on proposal failure", async () => {
		const changelogPath = tmp.join("CHANGELOG.md");
		const changelog2Path = tmp.join("CHANGELOG2.md");
		const initialContent = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline entry\n";
		await Bun.write(changelogPath, initialContent);
		await Bun.write(changelog2Path, initialContent);
		await $`git add -A`.cwd(tmp.path()).quiet();
		await $`git commit -m "add baselines"`.cwd(tmp.path()).quiet();

		// 1. Add a pre-staged edit to CHANGELOG.md
		const preStagedContent =
			"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline entry\n\n### Fixed\n\n- Pre-staged fix\n";
		await Bun.write(changelogPath, preStagedContent);
		await $`git add CHANGELOG.md`.cwd(tmp.path()).quiet();
		const userDirtyContent = `${preStagedContent}\n- Unstaged user note\n`;
		await Bun.write(changelogPath, userDirtyContent);

		// Verify pre-call status is MM (both staged and unstaged edits on CHANGELOG.md)
		const statusBefore = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(statusBefore.trim()).toBe("MM CHANGELOG.md");

		const diffCachedBefore = await $`git diff --cached CHANGELOG.md`.cwd(tmp.path()).text();
		expect(diffCachedBefore).toContain("+### Fixed");
		expect(diffCachedBefore).toContain("+- Pre-staged fix");

		await fs.chmod(changelog2Path, 0o444);
		// Proposal 1 updates CHANGELOG.md; Proposal 2 fails on write to read-only CHANGELOG2.md
		await expect(
			applyChangelogProposals({
				cwd: tmp.path(),
				expectedTree: await vcs.requireGit(tmp.path()).indexTreeId(),
				proposals: [
					{
						path: changelogPath,
						entries: { Added: ["Generated feature entry"] },
					},
					{
						path: changelog2Path,
						entries: { Fixed: ["Fails on write"] },
					},
				],
				dryRun: false,
			}),
		).rejects.toThrow();

		// Restore write permissions for cleanup
		await fs.chmod(changelog2Path, 0o644);

		// 1. Worktree content MUST be restored to exact pre-call content (including unstaged note)
		const onDisk = await Bun.file(changelogPath).text();
		expect(onDisk).toBe(userDirtyContent);

		// 2. Index state MUST be restored: pre-staged fix is STILL staged!
		const statusAfter = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(statusAfter.trim()).toBe("MM CHANGELOG.md");

		const diffCachedAfter = await $`git diff --cached CHANGELOG.md`.cwd(tmp.path()).text();
		expect(diffCachedAfter).toBe(diffCachedBefore);
	});

	it("fallback commit rejects when index shifts concurrently after capture", async () => {
		await Bun.write(tmp.join("feature.txt"), "feature v1\n");
		await $`git add feature.txt`.cwd(tmp.path()).quiet();

		const realRequireGit = vcs.requireGit.bind(vcs);
		let shifted = false;
		// Relies on runAgenticCommit capturing indexTreeId() before its first diffText(); staging inside diffText must therefore trip the commitCreate expectedTree check.
		vi.spyOn(vcs, "requireGit").mockImplementation(dir => {
			const repo = realRequireGit(dir);
			const realDiffText = repo.diffText.bind(repo);
			repo.diffText = async opts => {
				if (!shifted) {
					shifted = true;
					await Bun.write(tmp.join("concurrent.txt"), "concurrently staged\n");
					const r = realRequireGit(dir);
					await r.stageFiles(["concurrent.txt"]);
				}
				return realDiffText(opts);
			};
			return repo;
		});

		process.env.PI_COMMIT_TEST_FALLBACK = "true";
		await expect(
			runCommitCommand({
				all: false,
				dryRun: false,
				noChangelog: true,
				push: false,
			}),
		).rejects.toThrow(CommitAbortedError);

		const log = await $`git log -n 1 --oneline`.cwd(tmp.path()).text();
		expect(log).toContain("initial commit");
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
			expectedTree: await repo.indexTreeId(),
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

	it("rejects commit when unrelated file is staged concurrently during changelog application", async () => {
		const changelogContent = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline feature\n";
		await Bun.write(tmp.join("CHANGELOG.md"), changelogContent);
		await Bun.write(tmp.join("tracked.txt"), "v1\n");
		await $`git add -A`.cwd(tmp.path()).quiet();
		await $`git commit -m "init"`.cwd(tmp.path()).quiet();

		await Bun.write(tmp.join("tracked.txt"), "v2\n");
		await $`git add tracked.txt`.cwd(tmp.path()).quiet();

		vi.spyOn(changelogModule, "generateChangelogEntries").mockResolvedValue({
			entries: {
				Fixed: ["Fixed bug in tracked file"],
			},
		});

		const realRequireGit = vcs.requireGit.bind(vcs);
		let shifted = false;
		// Relies on applyChangelogProposals reading the staged baseline via showBlob(":CHANGELOG.md") after the legacy pipeline captured indexTreeId(); staging there must trip the stageContent CAS.
		vi.spyOn(vcs, "requireGit").mockImplementation(dir => {
			const repo = realRequireGit(dir);
			const realShowBlob = repo.showBlob.bind(repo);
			repo.showBlob = async (spec, maxBytes) => {
				const res = await realShowBlob(spec, maxBytes);
				if (!shifted && spec.includes("CHANGELOG.md")) {
					shifted = true;
					await Bun.write(tmp.join("unrelated.txt"), "concurrently staged\n");
					const r = realRequireGit(dir);
					await r.stageFiles(["unrelated.txt"]);
				}
				return res;
			};
			return repo;
		});

		await expect(
			runCommitCommand({
				legacy: true,
				dryRun: false,
				noChangelog: false,
				all: false,
				push: false,
			}),
		).rejects.toThrow(CommitAbortedError);

		const headLog = await $`git log -n 1 --oneline`.cwd(tmp.path()).text();
		expect(headLog).toContain("init");

		const headTree = await $`git ls-tree -r HEAD --name-only`.cwd(tmp.path()).text();
		expect(headTree).not.toContain("unrelated.txt");
	});

	it("rejects split commit and preserves index when index shifts concurrently during split preparation", async () => {
		await Bun.write(tmp.join("file1.txt"), "f1\n");
		await Bun.write(tmp.join("file2.txt"), "f2\n");
		await $`git add file1.txt file2.txt`.cwd(tmp.path()).quiet();

		const repo = vcs.requireGit(tmp.path());
		const initialTree = await repo.indexTreeId();

		const plan = {
			commits: [
				{
					changes: [{ path: "file1.txt", kind: "all" as const }],
					type: "feat" as const,
					scope: null,
					summary: "add file1",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
				{
					changes: [{ path: "file2.txt", kind: "all" as const }],
					type: "feat" as const,
					scope: null,
					summary: "add file2",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
			],
			warnings: [],
		};

		await expect(
			runSplitCommit(plan, {
				cwd: tmp.path(),
				dryRun: false,
				push: false,
				expectedTree: initialTree,
				confirm: async () => {
					// Simulate concurrent external staging during user confirmation
					await Bun.write(tmp.join("unrelated.txt"), "concurrently staged\n");
					await repo.stageFiles(["unrelated.txt"]);
					return true;
				},
			}),
		).rejects.toThrow(CommitAbortedError);

		const headLog = await $`git log -n 1 --oneline`.cwd(tmp.path()).text();
		expect(headLog).toContain("initial commit");

		const headTree = await $`git ls-tree -r HEAD --name-only`.cwd(tmp.path()).text();
		expect(headTree).not.toContain("unrelated.txt");
		// Existing staged files were preserved and NOT wiped by unstage
		const stagedFiles = await repo.changedFiles({ cached: true });
		expect(stagedFiles).toContain("file1.txt");
		expect(stagedFiles).toContain("file2.txt");
		expect(stagedFiles).toContain("unrelated.txt");

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		const statusLines = status
			.trim()
			.split("\n")
			.map(l => l.trimEnd());
		expect(statusLines).toContain("A  file1.txt");
		expect(statusLines).toContain("A  file2.txt");
		expect(statusLines).toContain("A  unrelated.txt");
		for (const line of statusLines) {
			expect(line.startsWith("A  ")).toBe(true);
		}

		const unstagedDiff = await $`git diff`.cwd(tmp.path()).text();
		expect(unstagedDiff).toBe("");
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
		const initialTree = await repo.indexTreeId();

		await runSplitCommit(
			{
				commits: [
					{
						changes: [{ path: "file1.txt", kind: "all" as const }],
						type: "feat" as const,
						scope: null,
						summary: "add file1",
						details: [],
						issueRefs: [],
						dependencies: [],
					},
				],
				warnings: [],
			},
			{
				cwd: tmp.path(),
				dryRun: false,
				push: false,
				expectedTree: initialTree,
				changelogProposal: { entries: [{ path: tmp.join("CHANGELOG.md"), entries: { Added: ["Added file1"] } }] },
				confirm: async () => false,
			},
		);

		expect((await $`git rev-parse HEAD`.cwd(tmp.path()).text()).trim()).toBe(headBefore);
		expect(await repo.indexTreeId()).toBe(initialTree);
		expect(await Bun.file(tmp.join("CHANGELOG.md")).text()).toBe(changelogContent);
	});

	it("split commit creates one commit per plan entry atomically and leaves a clean index", async () => {
		await Bun.write(tmp.join("file1.txt"), "f1\n");
		await Bun.write(tmp.join("file2.txt"), "f2\n");
		await Bun.write(tmp.join("tracked.txt"), "modified tracked content\n");
		await $`git add file1.txt file2.txt tracked.txt`.cwd(tmp.path()).quiet();

		const repo = vcs.requireGit(tmp.path());
		const expectedTree = await repo.indexTreeId();

		const countBefore = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);

		const plan = {
			commits: [
				{
					changes: [{ path: "file1.txt", kind: "all" as const }],
					type: "feat" as const,
					scope: null,
					summary: "add file1",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
				{
					changes: [{ path: "file2.txt", kind: "all" as const }],
					type: "feat" as const,
					scope: null,
					summary: "add file2",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
				{
					changes: [{ path: "tracked.txt", kind: "all" as const }],
					type: "fix" as const,
					scope: null,
					summary: "update tracked",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
			],
			warnings: [],
		};

		await runSplitCommit(plan, {
			cwd: tmp.path(),
			dryRun: false,
			push: false,
			expectedTree,
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

		const repo = vcs.requireGit(tmp.path());
		const expectedTree = await repo.indexTreeId();

		const plan = {
			commits: [
				{
					changes: [{ path: "multi.txt", kind: "indices" as const, indices: [1] }],
					type: "feat" as const,
					scope: null,
					summary: "update hunk 1",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
				{
					changes: [{ path: "multi.txt", kind: "indices" as const, indices: [2] }],
					type: "feat" as const,
					scope: null,
					summary: "update hunk 2",
					details: [],
					issueRefs: [],
					dependencies: [],
				},
			],
			warnings: [],
		};

		await runSplitCommit(plan, {
			cwd: tmp.path(),
			dryRun: false,
			push: false,
			expectedTree,
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
