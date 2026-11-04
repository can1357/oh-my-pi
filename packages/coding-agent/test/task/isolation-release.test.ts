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
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];
/** Order of worktree captures and the run's IRC wake release. */
let events: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	events = [];
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
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
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
		// A held peer message would wake a turn in the worktree once released.
		options.deferIrcWakeRelease?.(() => events.push("irc wakes released"));
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

	it("lets held peer messages wake the agent only after the run-end branch is committed", async () => {
		await commitsAcrossRelease("ReleaseAfterCapture", patch, patch);
		expect(events).toEqual(["commit", "irc wakes released"]);
	});
});

describe("a one-shot isolated run whose capture could not read everything", () => {
	async function git(cwd: string, ...args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.trim()}`);
	}

	it("keeps the workspace and names it, instead of deleting the only copy", async () => {
		// Failure mode: the run's one file could not be read, the capture
		// reported an empty patch, and the teardown deleted the workspace that
		// held the only copy, with no error in the result.
		if (process.platform === "win32") return;
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-capture-repo-"));
		const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-capture-wt-"));
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-capture-artifacts-"));
		tempRoots.push(repo, worktreeBase, artifactsDir);
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "src@example.com");
		await git(repo, "config", "user.name", "Source User");
		await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
		await git(repo, "add", "tracked.txt");
		await git(repo, "commit", "-q", "-m", "base");
		const id = "CaptureRefused";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const unreadable = path.join(options.worktree ?? "", "must-preserve.txt");
			await fs.writeFile(unreadable, "work nobody else has\n");
			await fs.chmod(unreadable, 0o000);
			return result(options.id);
		});
		const originalWorktreeDir = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(worktreeBase);
		let outcome: SingleResult;
		try {
			outcome = await runIsolatedSubprocess({
				baseOptions: {
					cwd: repo,
					agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
					task: "Do work",
					index: 0,
					id,
					keepAlive: false,
				},
				context: { repoRoot: repo },
				preferredBackend: natives.IsoBackendKind.Rcopy,
				agentId: id,
				mergeMode: "patch",
				artifactsDir,
				buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
			});
		} finally {
			setWorktreesDir(undefined);
			if (originalWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
			else process.env.OMP_WORKTREE_DIR = originalWorktreeDir;
		}

		expect(outcome.error ?? "").toMatch(/^Patch capture failed: Could not read 1 untracked file.*must-preserve\.txt/);
		const retained = /Isolation workspace retained at (\S+) —/.exec(outcome.error ?? "")?.[1];
		expect(retained).toBeDefined();
		const kept = path.join(retained ?? "", "must-preserve.txt");
		await fs.chmod(kept, 0o600);
		expect(await fs.readFile(kept, "utf8")).toBe("work nobody else has\n");
	});
});
