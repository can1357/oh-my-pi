import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import * as agentModule from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import type {
	ChangelogProposal,
	CommitAgentState,
	SplitCommitPlan,
} from "@oh-my-pi/pi-coding-agent/commit/agentic/state";
import { createSplitCommitTool } from "@oh-my-pi/pi-coding-agent/commit/agentic/tools/split-commit";
import * as changelogModule from "@oh-my-pi/pi-coding-agent/commit/changelog/generate";
import * as generateModule from "@oh-my-pi/pi-coding-agent/commit/conventional/generate";
import { CommitAbortedError } from "@oh-my-pi/pi-coding-agent/commit/execute";
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
	dependencies: number[] = [],
): SplitCommitPlan["commits"][number] {
	return {
		changes,
		type,
		scope: null,
		summary,
		details: [],
		issueRefs: [],
		dependencies,
	};
}

describe.serial("commit staging safety and non-mutating dry-run", () => {
	let tmp: TempDir;
	let origDir: string;
	let settingsState: SettingsTestState | undefined;
	let remote: TempDir | undefined;
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
		await remote?.remove();
		remote = undefined;
	});

	it("auto-stages all changes when index is empty before committing", async () => {
		// Modify tracked file and add an untracked scratch file
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		// Run commit without pre-staging, forcing fallback to complete without LLM
		process.env.PI_COMMIT_TEST_FALLBACK = "true";

		const result = await runCommitCommand({
			push: false,
			dryRun: false,
			noChangelog: true,
		});

		expect(result).toEqual({ usedFallback: true });

		// Both files should have been auto-staged and committed
		const repo = vcs.requireGit(tmp.path());
		const stagedAfter = await repo.changedFiles({ cached: true });
		expect(stagedAfter).toEqual([]);

		const status = await $`git status --porcelain`.cwd(tmp.path()).text();
		expect(status.trim()).toBe("");

		expect((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim()).toBe("2");
	});

	it("dry-run neither stages nor pushes, in both flows", async () => {
		remote = await TempDir.create("@commit-staging-remote-");
		await $`git init --bare ${remote.path()}`.quiet();
		await $`git remote add origin ${remote.path()}`.cwd(tmp.path()).quiet();
		await $`git push -q origin main`.cwd(tmp.path()).quiet();
		const pushedHead = (await $`git rev-parse HEAD`.cwd(tmp.path()).text()).trim();

		// Local is one commit ahead; a real push would advance the remote.
		await Bun.write(tmp.join("tracked.txt"), "ahead\n");
		await $`git commit -qam "ahead of remote"`.cwd(tmp.path()).quiet();
		await Bun.write(tmp.join("tracked.txt"), "modified content\n");
		await Bun.write(tmp.join("scratch.txt"), "untracked file\n");

		for (const legacy of [false, true]) {
			await runCommitCommand({ push: true, dryRun: true, noChangelog: true, legacy });

			const status = await $`git status --porcelain`.cwd(tmp.path()).text();
			expect(status.trim()).toBe("M tracked.txt\n?? scratch.txt");
			const remoteHead = (await $`git rev-parse main`.cwd(remote.path()).text()).trim();
			expect(remoteHead).toBe(pushedHead);
		}
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

	it("split plan from the agent yields one commit per group with hunk-level routing and a clean index", async () => {
		const lines = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		await Bun.write(tmp.join("multi.txt"), lines);
		await $`git add multi.txt`.cwd(tmp.path()).quiet();
		await $`git commit -qm "add multi.txt"`.cwd(tmp.path()).quiet();

		await Bun.write(
			tmp.join("multi.txt"),
			lines.replace("line 2\n", "line 2 modified\n").replace("line 28\n", "line 28 modified\n"),
		);
		await Bun.write(tmp.join("file1.txt"), "f1\n");
		await $`git add multi.txt file1.txt`.cwd(tmp.path()).quiet();
		const countBefore = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);

		// Proposal order is hunk 2, file1, hunk 1; hunk 2 depends on hunk 1, so
		// execution must reorder to file1, hunk 1, hunk 2.
		const splitProposal: SplitCommitPlan = {
			commits: [
				commitSpec("update hunk 2", [{ path: "multi.txt", kind: "indices", indices: [2] }], "fix", [2]),
				commitSpec("add file1", [{ path: "file1.txt", kind: "all" }]),
				commitSpec("update hunk 1", [{ path: "multi.txt", kind: "indices", indices: [1] }], "fix"),
			],
			warnings: [],
		};
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({ splitProposal } as never);
		}) as never);

		const result = await runCommitCommand({ push: false, dryRun: false, noChangelog: true });
		expect(result).toEqual({ usedFallback: false });

		const countAfter = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);
		expect(countAfter - countBefore).toBe(3);
		expect((await $`git log --format=%s -n 3`.cwd(tmp.path()).text()).trim().split("\n")).toEqual([
			"fix: update hunk 2",
			"fix: update hunk 1",
			"feat: add file1",
		]);

		expect(await $`git show HEAD~2:file1.txt`.cwd(tmp.path()).text()).toBe("f1\n");
		expect((await $`git show --stat --format= HEAD~2`.cwd(tmp.path()).text()).trim()).not.toContain("multi.txt");
		const afterHunk1 = await $`git show HEAD~1:multi.txt`.cwd(tmp.path()).text();
		expect(afterHunk1).toContain("line 2 modified");
		expect(afterHunk1).toContain("line 28\n");
		expect(await $`git show HEAD:multi.txt`.cwd(tmp.path()).text()).toContain("line 28 modified");
		expect((await $`git status --porcelain`.cwd(tmp.path()).text()).trim()).toBe("");
	});

	// 12 filler entries keep the staged note and the generated entry in separate hunks.
	const changelog = (added: string[]) =>
		[
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			...added,
			...Array.from({ length: 12 }, (_, i) => `- Existing ${i + 1}`),
			"",
			"### Changed",
			"",
			"- Existing change",
			"",
		].join("\n");

	/** Committed baseline changelog; then `feature.txt` and a changelog note staged on top. */
	async function seedStagedChangelog(): Promise<{ stagedChangelog: string; countBefore: number }> {
		await Bun.write(tmp.join("CHANGELOG.md"), changelog([]));
		await $`git add CHANGELOG.md`.cwd(tmp.path()).quiet();
		await $`git commit -m "commit baseline changelog"`.cwd(tmp.path()).quiet();

		const stagedChangelog = changelog(["- Staged note"]);
		await Bun.write(tmp.join("feature.txt"), "feature code\n");
		await Bun.write(tmp.join("CHANGELOG.md"), stagedChangelog);
		await $`git add feature.txt CHANGELOG.md`.cwd(tmp.path()).quiet();
		const countBefore = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);
		return { stagedChangelog, countBefore };
	}

	const generatedEntry = (): ChangelogProposal => ({
		entries: [{ path: tmp.join("CHANGELOG.md"), entries: { Fixed: ["Generated entry"] } }],
	});

	// One owner with partial hunks: without the upgrade to `all`, commitSplit rejects the plan as not
	// covering the staged tree after the changelog was already written. Two owners: rejected up front,
	// before anything is written.
	it.each([
		["upgrades the owning commit to all", [1]],
		["is rejected before writing when split across commits", [1, 2]],
	])("changelog in the split plan %s", async (_label, parts) => {
		const { stagedChangelog, countBefore } = await seedStagedChangelog();

		const changelogCommits = parts.map((hunk, position) =>
			commitSpec(
				`update changelog part ${hunk}`,
				[{ path: "CHANGELOG.md", kind: "indices", indices: [hunk] }],
				"feat",
				position === 0 ? [] : [position],
			),
		);
		const splitProposal: SplitCommitPlan = {
			commits: [commitSpec("add feature", [{ path: "feature.txt", kind: "all" }]), ...changelogCommits],
			warnings: [],
		};
		const changelogProposal = generatedEntry();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({ splitProposal, changelogProposal } as never);
		}) as never);

		const run = runCommitCommand({ push: false, dryRun: false, noChangelog: false });

		if (parts.length > 1) {
			const error = await run.then(
				() => null,
				(cause: unknown) => cause,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/split across 2 commits/);
			expect(await Bun.file(tmp.join("CHANGELOG.md")).text()).toBe(stagedChangelog);
			expect((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim()).toBe(String(countBefore));
			expect((await $`git status --porcelain`.cwd(tmp.path()).text()).trim()).toBe(
				"M  CHANGELOG.md\nA  feature.txt",
			);
			return;
		}

		await run;
		const countAfter = Number.parseInt((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim(), 10);
		expect(countAfter - countBefore).toBe(2);
		expect((await $`git log --format=%s -n 2`.cwd(tmp.path()).text()).trim().split("\n")).toEqual([
			"feat: update changelog part 1",
			"feat: add feature",
		]);

		const committedChangelog = await $`git show HEAD:CHANGELOG.md`.cwd(tmp.path()).text();
		expect(committedChangelog).toContain("Staged note");
		expect(committedChangelog).toContain("Generated entry");

		expect((await $`git show --stat --format= HEAD~1`.cwd(tmp.path()).text()).trim()).not.toContain("CHANGELOG.md");
		expect((await $`git status --porcelain`.cwd(tmp.path()).text()).trim()).toBe("");
	});

	/** Drive the real `split_commit` tool the way the agent does, echoing the absolute changelog target. */
	async function planViaSplitCommitTool(): Promise<SplitCommitPlan> {
		const state: CommitAgentState = {};
		const tool = createSplitCommitTool(tmp.path(), state, [tmp.join("CHANGELOG.md")]);
		const result = await tool.execute(
			"split-commit",
			{
				commits: [
					{
						changes: [{ path: "feature.txt", kind: "all" }],
						type: "feat",
						scope: null,
						summary: "Added feature",
					},
					{
						changes: [{ path: tmp.join("CHANGELOG.md"), kind: "all" }],
						type: "docs",
						scope: null,
						summary: "Updated changelog",
						dependencies: [0],
					},
				],
			},
			undefined,
			{} as never,
		);
		expect(result.details.errors).toEqual([]);
		if (!state.splitProposal) throw new Error("split_commit produced no plan");
		return state.splitProposal;
	}

	it("reverts generated changelog entries when a pre-commit hook rejects the split", async () => {
		const { stagedChangelog, countBefore } = await seedStagedChangelog();
		// An unstaged user edit must survive the rollback untouched.
		const dirtyChangelog = `${stagedChangelog}- Unstaged scratch note\n`;
		await Bun.write(tmp.join("CHANGELOG.md"), dirtyChangelog);
		const statusBefore = (await $`git status --porcelain`.cwd(tmp.path()).text()).trim();
		const indexBefore = await $`git show :CHANGELOG.md`.cwd(tmp.path()).text();

		const hookPath = tmp.join(".git/hooks/pre-commit");
		await Bun.write(hookPath, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
		await fs.chmod(hookPath, 0o755);

		const splitProposal = await planViaSplitCommitTool();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({ splitProposal, changelogProposal: generatedEntry() } as never);
		}) as never);

		const error = await runCommitCommand({ push: false, dryRun: false, noChangelog: false }).then(
			() => null,
			(cause: unknown) => cause,
		);
		expect(error).toBeInstanceOf(CommitAbortedError);

		expect((await $`git rev-list --count HEAD`.cwd(tmp.path()).text()).trim()).toBe(String(countBefore));
		expect(await $`git show :CHANGELOG.md`.cwd(tmp.path()).text()).toBe(indexBefore);
		expect(await Bun.file(tmp.join("CHANGELOG.md")).text()).toBe(dirtyChangelog);
		expect((await $`git status --porcelain`.cwd(tmp.path()).text()).trim()).toBe(statusBefore);
	});
});
