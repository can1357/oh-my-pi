import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { $ } from "bun";
import { createSessionDefaults } from "../helpers/session-defaults";

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

type FailedExit = "throw" | "abort" | "timeout";

interface FailedRun {
	result: SingleResult;
	repo: string;
	workspace: string;
	artifactsDir: string;
}

/**
 * Runs a real isolated subagent (real git repository, real isolation backend,
 * real executor) whose session writes `work.txt` into its workspace and then
 * fails the way `exit` names, then ends its lifecycle.
 */
async function runFailedIsolated(
	id: string,
	exit: FailedExit,
	options: {
		keepAlive?: boolean;
		mergeMode: "patch" | "branch";
		writes?: boolean;
		captureDir?: (root: string) => Promise<string>;
		/** False: no session transcript, so an abort cannot park the agent and the lifecycle releases it in-run. */
		resumable?: boolean;
	},
): Promise<FailedRun> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-failed-run-"));
	tempRoots.push(root);
	const repo = path.join(root, "repo");
	await fs.mkdir(repo);
	await $`git init -q -b main && git config user.email test@example.com && git config user.name Test && git config commit.gpgsign false`
		.cwd(repo)
		.quiet();
	await Bun.write(path.join(repo, "base.txt"), "base\n");
	await $`git add . && git commit -qm base`.cwd(repo).quiet();
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(artifactsDir);
	process.env.OMP_WORKTREE_DIR = path.join(root, "wt");

	let workspace = "";
	const controller = new AbortController();
	const { promise: hang, resolve: endHang } = Promise.withResolvers<void>();
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async sessionOptions => {
		workspace = sessionOptions?.cwd ?? "";
		const session = {
			...createSessionDefaults(),
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			subscribe: () => () => {},
			prompt: async () => {
				if (options.writes !== false) await Bun.write(path.join(workspace, "work.txt"), "child work\n");
				if (exit === "throw") throw new Error("provider stream failed");
				if (exit === "abort") controller.abort();
				await hang;
				return true;
			},
			waitForIdle: async () => {
				await hang;
			},
			abort: async () => {
				endHang();
			},
		} as unknown as AgentSession;
		// `createAgentSession` registers the agent; the lifecycle adopts only a registered session.
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
		return {
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
	});

	const runResult = await runIsolatedSubprocess({
		baseOptions: {
			cwd: repo,
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			artifactsDir: options.resumable === false ? undefined : artifactsDir,
			keepAlive: options.keepAlive,
			signal: controller.signal,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			settings: Settings.isolated({ "task.maxRuntimeMs": exit === "timeout" ? 100 : 0 }),
		},
		context: { repoRoot: repo },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: options.mergeMode,
		artifactsDir: options.captureDir ? await options.captureDir(root) : artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	if (AgentLifecycleManager.global().has(id)) await AgentLifecycleManager.global().release(id);
	return { result: runResult, repo, workspace, artifactsDir };
}

describe("failed isolated run", () => {
	const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
	afterEach(() => {
		if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	});

	for (const exit of ["throw", "abort", "timeout"] as const) {
		it(`one-shot ${exit}: saves the work to the patch the result names`, async () => {
			const run = await runFailedIsolated(`OneShot${exit}`, exit, { keepAlive: false, mergeMode: "patch" });

			expect(run.result.exitCode).toBe(1);
			expect(await Bun.file(path.join(run.workspace, "work.txt")).exists()).toBe(false);
			expect(run.result.patchPath).toBe(path.join(run.artifactsDir, `OneShot${exit}.patch`));
			expect(await Bun.file(run.result.patchPath ?? "").text()).toContain("+child work");
		});

		it(`kept-alive ${exit}: commits the work to the task branch the result names`, async () => {
			const run = await runFailedIsolated(`KeptAlive${exit}`, exit, { mergeMode: "branch" });

			expect(run.result.exitCode).toBe(1);
			expect(run.result.branchName).toBe(`omp/task/KeptAlive${exit}`);
			const committed = await $`git show ${run.result.branchName}:work.txt`.cwd(run.repo).quiet().text();
			expect(committed).toBe("child work\n");
		});
	}

	it("names the changes the lifecycle captured when it released a failed run that cannot resume", async () => {
		const run = await runFailedIsolated("NotResumable", "abort", { mergeMode: "patch", resumable: false });

		expect(run.result.aborted).toBe(true);
		expect(await Bun.file(run.result.patchPath ?? "").text()).toContain("+child work");
		const committed = await $`git show ${run.result.branchName}:work.txt`.cwd(run.repo).quiet().text();
		expect(committed).toBe("child work\n");
	});

	it("removes the workspace of a failed run that changed nothing and names no capture", async () => {
		const run = await runFailedIsolated("NoChange", "throw", { keepAlive: false, mergeMode: "patch", writes: false });

		expect(run.result.exitCode).toBe(1);
		expect(run.result.patchPath).toBeUndefined();
		expect(await fs.readdir(run.artifactsDir)).not.toContain("NoChange.patch");
		await expect(fs.stat(run.workspace)).rejects.toThrow();
	});

	it("retains and names the workspace when the failed run's capture throws", async () => {
		const run = await runFailedIsolated("CaptureThrows", "throw", {
			keepAlive: false,
			mergeMode: "patch",
			// A regular file where the patch directory should be: the patch write fails.
			captureDir: async root => {
				await Bun.write(path.join(root, "not-a-dir"), "");
				return path.join(root, "not-a-dir", "artifacts");
			},
		});

		expect(run.result.error).toContain("provider stream failed");
		const retained = run.result.error?.match(/Isolation workspace retained at (\S+) —/)?.[1];
		expect(retained).toBeDefined();
		expect(await Bun.file(path.join(retained ?? "", "work.txt")).text()).toBe("child work\n");
	});
});
