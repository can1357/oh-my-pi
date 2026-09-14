import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { RETAINED_BACKEND_FILE } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import {
	applyEligibleNestedPatches,
	mergeIsolatedChanges,
	persistNestedPatches,
	retainIsolationWorkspace,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.text();
}

async function seedFooRepo(finalContent: string): Promise<{ repoRoot: string; patchPath: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
	tempRoots.push(repoRoot);

	await git(repoRoot, "init", "-q", "-b", "main");
	await git(repoRoot, "config", "user.email", "repro@example.com");
	await git(repoRoot, "config", "user.name", "Repro");
	await Bun.write(path.join(repoRoot, "foo.txt"), finalContent);
	await git(repoRoot, "add", "foo.txt");
	await git(repoRoot, "commit", "-q", "-m", "fixture state");

	// The merge contract needs a valid old→new patch, not a second commit and
	// diff-tree subprocess for every scenario.
	const patchPath = path.join(repoRoot, "task.patch");
	await Bun.write(
		patchPath,
		"diff --git a/foo.txt b/foo.txt\n" +
			"--- a/foo.txt\n" +
			"+++ b/foo.txt\n" +
			"@@ -1 +1 @@\n" +
			"-old\n" +
			"+new\n",
	);
	return { repoRoot, patchPath };
}

describe("runIsolatedSubprocess", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("preserves branch-mode output as a patch when branch transfer fails", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-run-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "PreserveBranchFailure" }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("remote: object corrupt"));
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		AgentRegistry.global().register({
			id: "PreserveBranchFailure",
			displayName: "PreserveBranchFailure",
			kind: "sub",
			session: null,
			status: "parked",
		});
		// No branch was ever created, so the rescue probe finds nothing to keep.
		const deleteSpy = vi.fn(async () => true);
		const repository = {
			deleteBranch: deleteSpy,
			refExists: async () => false,
			revListRange: async () => {
				throw new Error("unknown revision");
			},
		} as unknown as natives.VcsGitRepo;
		vi.spyOn(vcs, "git").mockReturnValue(repository);
		vi.spyOn(vcs, "requireGit").mockReturnValue(repository);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "PreserveBranchFailure",
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId: "PreserveBranchFailure",
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		const patchPath = path.join(artifactsDir, "PreserveBranchFailure.patch");
		expect(outcome.error).toContain("Merge failed: remote: object corrupt");
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(outcome.nestedPatches).toEqual([]);
		expect(captureSpy).toHaveBeenCalledWith(isolationDir, baseline);
		expect(deleteSpy).toHaveBeenCalledWith("omp/task/PreserveBranchFailure", true);
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get("PreserveBranchFailure")?.history?.patchPath).toBe(patchPath);
	});

	it("keeps the task branch when it already carries the agent's commits", async () => {
		// Regression for #8868: `commitToBranch` fetches the agent's commits into
		// the parent ODB and creates `omp/task/<id>` before it commits the leftover
		// working-tree delta. A throw from that trailing step used to delete the
		// branch while the isolation worktree — the only other copy — was torn
		// down in `finally`, losing committed work outright.
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-rescue-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "RescueBranchCommits" }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(
			new Error("git apply --3way failed for task RescueBranchCommits"),
		);
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		AgentRegistry.global().register({
			id: "RescueBranchCommits",
			displayName: "RescueBranchCommits",
			kind: "sub",
			session: null,
			status: "parked",
		});
		const rangeSpy = vi.fn(async () => {
			throw new Error("object database unavailable");
		});
		const refSpy = vi.fn(async () => true);
		const deleteSpy = vi.fn(async () => true);
		const repository = {
			deleteBranch: deleteSpy,
			refExists: refSpy,
			revListRange: rangeSpy,
		} as unknown as natives.VcsGitRepo;
		vi.spyOn(vcs, "git").mockReturnValue(repository);
		vi.spyOn(vcs, "requireGit").mockReturnValue(repository);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "RescueBranchCommits",
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId: "RescueBranchCommits",
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(rangeSpy).toHaveBeenCalledWith("base", "omp/task/RescueBranchCommits");
		expect(refSpy).toHaveBeenCalledWith("refs/heads/omp/task/RescueBranchCommits");
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(outcome.error).toContain("git apply --3way failed");
		expect(outcome.error).toContain("preserved on branch omp/task/RescueBranchCommits");
		expect(outcome.error).toContain("cherry-pick");
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps an isolated worktree until deferred child cleanup settles", async () => {
		const cleanupGate = Promise.withResolvers<void>();
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" });
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "DeferredCleanup",
			},
			context: {
				repoRoot: "/repo",
				baseline: {
					root: {
						repoRoot: "/repo",
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "DeferredCleanup",
			mergeMode: "patch",
			artifactsDir: "/artifacts",
			buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
		});

		expect(outcome.exitCode).toBe(1);
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		await cleanupGate.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("captures a successful yield's patch when child cleanup is deferred (issue #9670)", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-defer-ok-"));
		tempRoots.push(artifactsDir);
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";
		const cleanupGate = Promise.withResolvers<void>();
		const baseline = {
			root: {
				repoRoot: "/repo",
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		// A successful yield whose teardown drains past the grace window returns
		// exitCode 0 with a pending deferred cleanup.
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ id: "DeferredSuccess", exitCode: 0 });
		});
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredSuccess",
			},
			context: { repoRoot: "/repo", baseline },
			preferredBackend: undefined,
			agentId: "DeferredSuccess",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		// Capture waits until every deferred writer has settled.
		await Promise.resolve();
		expect(captureSpy).not.toHaveBeenCalled();
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		const outcome = await run;

		const patchPath = path.join(artifactsDir, "DeferredSuccess.patch");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(captureSpy).toHaveBeenCalledWith("/repo/isolated", baseline);
		await Promise.resolve();
		await Promise.resolve();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("observes real child usage before fallible isolation cleanup", async () => {
		const childResult = result({
			exitCode: 1,
			error: "agent failed",
			usage: {
				input: 9_000,
				output: 1_234,
				cacheRead: 8_000,
				cacheWrite: 7_000,
				totalTokens: 25_234,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, true);
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(childResult);
		vi.spyOn(worktreeModule, "cleanupIsolation").mockRejectedValue(new Error("cleanup failed"));
		const onSubprocessResult = vi.fn((child: SingleResult) => {
			sessionManager.recordEvalSubagentOutput(child.usage?.output ?? 0);
		});

		await expect(
			runIsolatedSubprocess({
				baseOptions: {
					cwd: "/repo",
					agent: {
						name: "task",
						description: "Task agent",
						systemPrompt: "test",
						source: "bundled",
					},
					task: "Do work",
					index: 0,
					id: "UsageAccounting",
				},
				context: {
					repoRoot: "/repo",
					baseline: {
						root: {
							repoRoot: "/repo",
							headCommit: "base",
							staged: "",
							unstaged: "",
							untracked: [],
							untrackedPatch: "",
						},
						nested: [],
					},
				},
				preferredBackend: undefined,
				agentId: "UsageAccounting",
				mergeMode: "patch",
				artifactsDir: "/artifacts",
				buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
				onSubprocessResult,
			}),
		).rejects.toThrow("cleanup failed");

		expect(onSubprocessResult).toHaveBeenCalledTimes(1);
		expect(sessionManager.getTurnBudget()).toEqual({
			total: 100_000,
			spent: 1_234,
			hard: true,
		});
	});

	it("writes nested-repo patches to disk before the workspace is torn down", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-nested-"));
		tempRoots.push(artifactsDir);
		const nestedPatch =
			"diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hi\n";
		const baseline = {
			root: {
				repoRoot: "/repo",
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [
				{
					relativePath: "inner",
					baseline: {
						repoRoot: "/repo/inner",
						headCommit: "inner-base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
				},
			],
		};
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "NestedPersist" }));
		// The agent only touched the nested repo: the root diff is empty.
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "",
			nestedPatches: [{ relativePath: "inner", patch: nestedPatch }],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		AgentRegistry.global().register({
			id: "NestedPersist",
			displayName: "NestedPersist",
			kind: "sub",
			session: null,
			status: "parked",
		});

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do nested work",
				index: 0,
				id: "NestedPersist",
			},
			context: { repoRoot: "/repo", baseline },
			preferredBackend: undefined,
			agentId: "NestedPersist",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		const nestedPath = path.join(artifactsDir, "NestedPersist.nested-0-inner.patch");
		expect(outcome.error).toBeUndefined();
		expect(outcome.hasRootChanges).toBe(false);
		expect(outcome.nestedPatchPaths).toEqual([nestedPath]);
		expect(await Bun.file(nestedPath).text()).toBe(nestedPatch);
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		// `agent://NestedPersist` and the Hub read the history record, not the result.
		expect(AgentRegistry.global().get("NestedPersist")?.history?.nestedPatchPaths).toEqual([nestedPath]);
	});

	it("retains the workspace when captured changes cannot be written", async () => {
		const blockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-blocked-"));
		tempRoots.push(blockedDir);
		// A regular file where the artifacts directory should be: every write fails.
		const artifactsDir = path.join(blockedDir, "artifacts");
		await Bun.write(artifactsDir, "not a directory");
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "RetainOnWriteFailure" }));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "",
			nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do nested work",
				index: 0,
				id: "RetainOnWriteFailure",
			},
			context: {
				repoRoot: "/repo",
				baseline: {
					root: {
						repoRoot: "/repo",
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "RetainOnWriteFailure",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(outcome.error).toContain("Patch capture failed");
		expect(outcome.error).toContain("Isolation workspace retained at /repo/isolated");
		expect(outcome.error).not.toContain("mount metadata");
		expect(outcome.nestedPatchPaths).toBeUndefined();
		expect(cleanupSpy).not.toHaveBeenCalled();
	});

	it("removes partial nested patches when a later write fails", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-partial-"));
		tempRoots.push(artifactsDir);
		const originalWrite = Bun.write.bind(Bun);
		let calls = 0;
		vi.spyOn(Bun, "write").mockImplementation(async (destination: unknown, content: unknown) => {
			calls += 1;
			if (calls === 2) {
				// Simulate a mid-write failure (ENOSPC, quota): the destination
				// exists but holds truncated content when the write rejects.
				await originalWrite(destination as string, "truncated-partial");
				throw new Error("ENOSPC");
			}
			return originalWrite(destination as string, content as string | Blob);
		});

		await expect(
			persistNestedPatches(artifactsDir, "Partial", [
				{ relativePath: "a", patch: "diff --git a/a b/a\n" },
				{ relativePath: "b", patch: "diff --git a/b b/b\n" },
			]),
		).rejects.toThrow("ENOSPC");
		expect(await Bun.file(path.join(artifactsDir, "Partial.nested-0-a.patch")).exists()).toBe(false);
		expect(await Bun.file(path.join(artifactsDir, "Partial.nested-1-b.patch")).exists()).toBe(false);
	});
});

describe("retainIsolationWorkspace", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("moves the workspace to a unique sibling out of the deterministic slot", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-retain-"));
		tempRoots.push(parent);
		const baseDir = path.join(parent, "wt_abc123");
		const isolationDir = path.join(baseDir, "m");
		await fs.mkdir(isolationDir, { recursive: true });
		await Bun.write(path.join(isolationDir, "work.txt"), "unrecovered");

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Overlayfs);

		expect(retained).toEqual({ dir: expect.any(String), sidecarOk: true });
		expect(retained.dir).not.toBe(isolationDir);
		expect(path.dirname(retained.dir)).toContain(".retained-");
		expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("unrecovered");
		expect(await Bun.file(baseDir).exists()).toBe(false);
		const sidecar = await Bun.file(path.join(path.dirname(retained.dir), RETAINED_BACKEND_FILE)).json();
		expect(sidecar.backend).toBe(natives.IsoBackendKind.Overlayfs);
		tempRoots.push(path.dirname(retained.dir));
	});

	it("records no sidecar for copy backends that need no unmount", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-retain-copy-"));
		tempRoots.push(parent);
		const isolationDir = path.join(parent, "wt_abc123", "m");
		await fs.mkdir(isolationDir, { recursive: true });

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Rcopy);

		expect(retained.sidecarOk).toBe(true);
		expect(await Bun.file(path.join(path.dirname(retained.dir), RETAINED_BACKEND_FILE)).exists()).toBe(false);
		tempRoots.push(path.dirname(retained.dir));
	});

	it("reports the original dir when the move fails", async () => {
		// The helper moves the workspace base dir; point it at a base that
		// does not exist so the rename rejects.
		const missingParent = path.join(os.tmpdir(), `omp-isolation-retain-missing-${Date.now()}`);
		const isolationDir = path.join(missingParent, "wt_abc123", "m");

		await expect(retainIsolationWorkspace(isolationDir)).resolves.toEqual({
			dir: isolationDir,
			sidecarOk: true,
		});
		await expect(fs.stat(missingParent)).rejects.toThrow();
	});

	it("reports missing metadata when the sidecar cannot be written", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-retain-sidecar-"));
		tempRoots.push(parent);
		const isolationDir = path.join(parent, "wt_abc123", "m");
		await fs.mkdir(isolationDir, { recursive: true });
		await Bun.write(path.join(isolationDir, "work.txt"), "unrecovered");
		const originalWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (destination: unknown, content: unknown) => {
			if (typeof destination === "string" && destination.endsWith(RETAINED_BACKEND_FILE)) {
				throw new Error("ENOSPC");
			}
			return originalWrite(destination as string, content as string | Blob);
		});

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Overlayfs);

		expect(retained.sidecarOk).toBe(false);
		expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("unrecovered");
		tempRoots.push(path.dirname(retained.dir));
	});
});

describe("mergeIsolatedChanges", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({} as natives.VcsGitRepo);
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("surfaces branch preparation errors instead of reporting no changes", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({} as natives.VcsGitRepo);
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: git apply --3way failed for task dirty-context: conflict",
				patchPath: "/repo/artifacts/dirty-context.patch",
				nestedPatchPaths: ["/repo/artifacts/dirty-context.nested-0-inner.patch"],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
		expect(outcome.summary).toContain("Branch merge failed while capturing the task branch");
		expect(outcome.summary).toContain("git apply --3way failed");
		expect(outcome.summary).toContain("/repo/artifacts/dirty-context.patch");
		expect(outcome.summary).toContain("/repo/artifacts/dirty-context.nested-0-inner.patch");
		expect(outcome.summary).not.toContain("No changes to apply");
	});

	it("lists captured artifacts when the merge phase throws", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({} as natives.VcsGitRepo);
		vi.spyOn(worktreeModule, "mergeTaskBranches").mockRejectedValue(new Error("EACCES"));
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				branchName: "omp/task/Throwing",
				patchPath: "/repo/artifacts/task.patch",
				nestedPatchPaths: ["/repo/artifacts/task.nested-0-inner.patch"],
			}),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Merge phase failed");
		expect(outcome.summary).toContain("omp/task/Throwing");
		expect(outcome.summary).toContain("/repo/artifacts/task.patch");
		expect(outcome.summary).toContain("/repo/artifacts/task.nested-0-inner.patch");
	});

	it("relays the rescued task branch into the merge summary", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({} as natives.VcsGitRepo);
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: conflict. The agent's commits are preserved on branch omp/task/Rescued — merge or cherry-pick it manually.",
			}),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("omp/task/Rescued");
		expect(outcome.summary).toContain("cherry-pick");
	});

	it("treats already-applied patch-mode diffs as successful no-ops", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("new\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.summary).not.toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
	});

	it("rejects patch-mode conflicts without dirtying the worktree", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("other\n");
		expect(await git(repoRoot, "ls-files", "-u", "--", "foo.txt")).toBe("");
	});

	it("names the persisted nested patches when the root patch cannot be applied", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");
		const nestedPatchPath = "/artifacts/NestedOnly.nested-0-inner.patch";

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({
				patchPath,
				nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
				nestedPatchPaths: [nestedPatchPath],
			}),
		});

		// Nested apply is skipped after a root failure, so the files are the
		// parent's only route to that work — the notification must point at them.
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(outcome.summary).toContain(`Patch artifact:\n- ${patchPath}`);
		expect(outcome.summary).toContain(`Nested repository patches (not applied):\n- ${nestedPatchPath}`);
	});

	it("applies a fresh patch-mode diff when context matches", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("old\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("new\n");
	});

	it("prefers forward apply when both reverse-check and forward-check succeed", async () => {
		// If git-apply's fuzz ever lets `--reverse --check` succeed while forward
		// `--check` also succeeds (e.g. repeated context with the postimage present
		// elsewhere), the outcome must NOT be a silent no-op.
		const { repoRoot, patchPath } = await seedFooRepo("old\n");
		const canApplySpy = vi.spyOn(natives.VcsGitRepo.prototype, "canApplyPatch").mockResolvedValue(true);
		const applySpy = vi.spyOn(natives.VcsGitRepo.prototype, "applyPatch").mockResolvedValue(undefined);

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(canApplySpy).toHaveBeenCalledTimes(2);
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		vi.spyOn(vcs, "requireGit").mockReturnValue({} as natives.VcsGitRepo);
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
