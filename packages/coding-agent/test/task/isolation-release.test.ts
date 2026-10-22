import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(id: string, runEndPatch: string, releasePatch: string): Promise<number> {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
	tempRoots.push(artifactsDir);
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: "/repo/isolated",
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
		branchName: `omp/task/${id}`,
		baseSha: "base",
		rootPatch: runEndPatch,
		nestedPatches: [],
	});
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${options.id}.jsonl`,
			status: "running",
		});
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			reviveSession: async () => session,
			onRelease: options.onRelease,
		});
		return result(options.id);
	});

	await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
		},
		context: { repoRoot: "/repo" },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "branch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	await AgentLifecycleManager.global().release(id);
	return commitSpy.mock.calls.length;
}

describe("isolated agent release", () => {
	const patch = "diff --git a/task.txt b/task.txt\n+work\n";

	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", patch, patch)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", patch, `${patch}+follow-up\n`)).toBe(2);
	});

	it("repairs a borrowed workspace package before starting the isolated worker", async () => {
		const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-workspace-link-"));
		tempRoots.push(fixtureRoot);
		const oldCheckout = path.join(fixtureRoot, "old");
		const currentCheckout = path.join(fixtureRoot, "current");
		const workerCheckout = path.join(fixtureRoot, "worker");
		const artifactsDir = path.join(fixtureRoot, "artifacts");
		const workspaceName = "@oh-my-pi/pi-ai";
		for (const [checkout, source] of [
			[oldCheckout, "old"],
			[currentCheckout, "current"],
		]) {
			await fs.mkdir(path.join(checkout, "packages", "ai"), { recursive: true });
			await fs.mkdir(path.join(checkout, "packages", "app"), { recursive: true });
			await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
			await fs.writeFile(
				path.join(checkout, "packages", "ai", "package.json"),
				JSON.stringify({ name: workspaceName, type: "module", exports: "./index.js" }),
			);
			await fs.writeFile(
				path.join(checkout, "packages", "ai", "index.js"),
				`export const source = ${JSON.stringify(source)};\n`,
			);
			await fs.writeFile(
				path.join(checkout, "packages", "app", "resolve.mjs"),
				`import { source } from "${workspaceName}";\nconsole.log(source);\n`,
			);
		}
		const oldNodeModules = path.join(oldCheckout, "node_modules");
		await fs.mkdir(path.join(oldNodeModules, "@oh-my-pi"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "packages", "ai"),
			path.join(oldNodeModules, "@oh-my-pi", "pi-ai"),
			"dir",
		);
		await fs.symlink(oldNodeModules, path.join(currentCheckout, "node_modules"), "dir");
		await fs.cp(currentCheckout, workerCheckout, { recursive: true });
		await fs.mkdir(artifactsDir);

		const baseline = {
			root: {
				repoRoot: currentCheckout,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: workerCheckout,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		let observed: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const workerRoot = options.worktree;
			if (!workerRoot) throw new Error("isolated worker has no worktree");
			const entry = path.join(workerRoot, "packages", "app", "resolve.mjs");
			const child = Bun.spawn([process.execPath, "run", entry], {
				cwd: workerRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			const exitCode = await child.exited;
			if (exitCode !== 0) throw new Error(stderr);
			observed = stdout.trim();
			return { ...result(options.id), output: observed };
		});

		const run = await runIsolatedSubprocess({
			baseOptions: {
				cwd: currentCheckout,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Resolve workspace dependencies",
				index: 0,
				id: "BorrowedWorkspace",
			},
			context: { repoRoot: currentCheckout },
			preferredBackend: undefined,
			agentId: "BorrowedWorkspace",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result("BorrowedWorkspace"), exitCode: 1, error: String(error) }),
		});

		expect(run.exitCode).toBe(0);
		expect(observed).toBe("current");
	});
});
