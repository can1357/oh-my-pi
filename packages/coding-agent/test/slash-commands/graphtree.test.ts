import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import { TRUNCATE_LENGTHS } from "@pk-nerdsaver-ai/pi-coding-agent/tools/render-utils";
import * as piUtils from "@pk-nerdsaver-ai/pi-utils";

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		const detail = stderr || stdout || `exit code ${result.exitCode}`;
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function createTempRepo(prefix: string, branch: string): Promise<string> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
	runGit(repoRoot, ["init", "-b", branch, repoRoot]);
	runGit(repoRoot, ["config", "user.name", "Test User"]);
	runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "base commit"]);
	return repoRoot;
}

function createHarness(cwd: string, customSettings?: Record<string, unknown>) {
	const showStatus = vi.fn();
	const setText = vi.fn();
	const getCwd = vi.fn(() => cwd);
	const getSetting = vi.fn((key: string) => customSettings?.[key]);

	const ctx = {
		collabGuest: false,
		showStatus,
		editor: { setText },
		sessionManager: { getCwd },
		settings: { get: getSetting },
	} as unknown as InteractiveModeContext;

	return { runtime: { ctx }, showStatus, setText };
}

function lastStatusText(showStatus: ReturnType<typeof vi.fn>): string {
	const call = showStatus.mock.calls.at(-1);
	if (!call) throw new Error("showStatus was never called");
	return call[0] as string;
}

/**
 * `getWorktreesDir()` resolves `OMP_WORKTREE_DIR` first, ahead of any on-disk
 * default or override, so pointing it at a per-test temp dir is sufficient to
 * isolate every graphtree worktree operation from the developer's real
 * `~/.ompk/wt` without touching internal resolver state.
 */
async function setupWorktreeBase(): Promise<{ base: string; cleanup: () => Promise<void> }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "graphtree-wtbase-"));
	vi.spyOn(piUtils, "getWorktreeDir").mockImplementation(name => path.join(base, name));
	return {
		base,
		cleanup: async () => {
			await piUtils.removeWithRetries(base);
		},
	};
}

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.restoreAllMocks();
	while (cleanups.length) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) await piUtils.removeWithRetries(dir);
	}
});

describe("/graphtree slash command", () => {
	it("renders graph tree status output", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-status", "main");
		tempDirs.push(repoRoot);

		const { runtime, showStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree", runtime);
		expect(showStatus).toHaveBeenCalled();
		expect(lastStatusText(showStatus)).toContain("Fractal GraphTree Workflows");
	});

	it("reports a friendly error outside a Git repository", async () => {
		const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "graphtree-nonrepo-"));
		tempDirs.push(nonRepo);

		const { runtime, showStatus } = createHarness(nonRepo);
		await executeBuiltinSlashCommand("/graphtree status", runtime);
		expect(lastStatusText(showStatus)).toContain("requires a Git repository");
	});

	it("identifies a detached root instead of fabricating the main branch", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-detached", "main");
		tempDirs.push(repoRoot);
		runGit(repoRoot, ["checkout", "--detach", "HEAD"]);

		const { runtime, showStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree status", runtime);
		const outputText = lastStatusText(showStatus);
		expect(outputText).toContain("detached@");
		expect(outputText).not.toContain("branch: main");
	});

	it("renders help output on /graphtree help", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-help", "main");
		tempDirs.push(repoRoot);

		const { runtime, showStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree help", runtime);
		const outputText = lastStatusText(showStatus);
		expect(outputText).toContain("Fractal GraphTree Workflow Commands:");
		expect(outputText).toContain("/graphtree init");
		expect(outputText).toContain("/graphtree run");
	});

	it("returns a prompt object for multi-agent execution on /graphtree run", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-run", "main");
		tempDirs.push(repoRoot);

		const { runtime } = createHarness(repoRoot);
		const result = await executeBuiltinSlashCommand("/graphtree run refactor system authentication", runtime);
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result).toContain("FRACTAL GRAPHTREE MULTI-AGENT WORKFLOW");
		expect(result).toContain("refactor system authentication");
	});

	it("status excludes another repository's managed worktree and displays the actual branch", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);

		const repoA = await createTempRepo("graphtree-repoa", "main");
		const repoB = await createTempRepo("graphtree-repob", "main");
		tempDirs.push(repoA, repoB);
		runGit(repoB, ["checkout", "-b", "feature/observed-branch"]);

		// Create a worktree node owned by repo A under the shared worktree base.
		const { runtime: runtimeA } = createHarness(repoA);
		await executeBuiltinSlashCommand("/graphtree init foreign-node", runtimeA);

		// Query status scoped to repo B; repo A's node must not leak into it.
		const { runtime: runtimeB, showStatus } = createHarness(repoB);
		await executeBuiltinSlashCommand("/graphtree status", runtimeB);
		const outputText = lastStatusText(showStatus);
		expect(outputText).not.toContain("foreign-node");
		expect(outputText).toContain("feature/observed-branch");
	});

	it("init rejects path separators and parent traversal, and creates a repo-qualified node for a valid name", async () => {
		const { base, cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-init", "main");
		tempDirs.push(repoRoot);

		const worktreesBefore = () => runGit(repoRoot, ["worktree", "list", "--porcelain"]);
		const initialWorktrees = worktreesBefore();

		const { runtime: runtimeSlash, showStatus: statusSlash } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init foo/bar", runtimeSlash);
		expect(lastStatusText(statusSlash).toLowerCase()).toMatch(/invalid|reject|not allowed/);
		expect(worktreesBefore()).toBe(initialWorktrees);

		const { runtime: runtimeDots, showStatus: statusDots } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init ../escape", runtimeDots);
		expect(lastStatusText(statusDots).toLowerCase()).toMatch(/invalid|reject|not allowed/);
		expect(worktreesBefore()).toBe(initialWorktrees);
		await expect(fs.access(path.join(base, "..", "escape"))).rejects.toThrow();

		const { runtime: runtimeFlag, showStatus: statusFlag } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init flag-node -u", runtimeFlag);
		expect(lastStatusText(statusFlag)).toContain("Failed to create branch");
		expect(worktreesBefore()).toBe(initialWorktrees);

		const { runtime: runtimeValid, showStatus: statusValid } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init valid-node", runtimeValid);
		expect(lastStatusText(statusValid)).not.toMatch(/invalid|reject|not allowed/i);
		expect(worktreesBefore()).not.toBe(initialWorktrees);

		// Repo-qualification: a second repo sharing the same worktree base can use
		// the identical node name without colliding with repo A's worktree.
		const repoOther = await createTempRepo("graphtree-init-other", "main");
		tempDirs.push(repoOther);
		const { runtime: runtimeOther, showStatus: statusOther } = createHarness(repoOther);
		await executeBuiltinSlashCommand("/graphtree init valid-node", runtimeOther);
		expect(lastStatusText(statusOther)).not.toMatch(/invalid|reject|not allowed/i);
		expect(runGit(repoOther, ["worktree", "list", "--porcelain"])).not.toBe(initialWorktrees);
	});

	it("uses the custom branch passed to init when merging the node", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-merge", "main");
		tempDirs.push(repoRoot);

		const customBranch = "feature/custom-merge-target";
		const { runtime: initRuntime, showStatus: initStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand(`/graphtree init merge-node ${customBranch}`, initRuntime);
		const initOutput = lastStatusText(initStatus);
		expect(initOutput).not.toMatch(/failed/i);

		// Find the worktree checked out on the custom branch and commit a marker
		// file there so a successful merge is independently observable.
		const worktreeList = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
		const entries = worktreeList.split("\n\n").filter(Boolean);
		const nodeEntry = entries.find(entry => entry.includes(`branch refs/heads/${customBranch}`));
		expect(nodeEntry).toBeDefined();
		const worktreePathLine = nodeEntry?.split("\n").find(line => line.startsWith("worktree "));
		const nodeWorktreePath = worktreePathLine?.slice("worktree ".length).trim();
		expect(nodeWorktreePath).toBeTruthy();
		if (!nodeWorktreePath) throw new Error("unreachable: asserted above");

		await fs.writeFile(path.join(nodeWorktreePath, "marker.txt"), "from custom branch\n");
		runGit(nodeWorktreePath, ["add", "marker.txt"]);
		runGit(nodeWorktreePath, ["commit", "-m", "marker commit on custom branch"]);

		const { runtime: mergeRuntime, showStatus: mergeStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree merge merge-node", mergeRuntime);
		const mergeOutput = lastStatusText(mergeStatus);
		expect(mergeOutput).not.toMatch(/failed/i);

		const markerContent = await fs.readFile(path.join(repoRoot, "marker.txt"), "utf8");
		expect(markerContent.trim()).toBe("from custom branch");
	});

	it("prune requires a node, refuses a dirty node without deleting it, and removes a clean named node", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-prune", "main");
		tempDirs.push(repoRoot);

		const { runtime: noArgRuntime, showStatus: noArgStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree prune", noArgRuntime);
		expect(lastStatusText(noArgStatus).toLowerCase()).toMatch(/usage|node name|required/);

		// Dirty node: init, then leave an uncommitted change in its worktree.
		const { runtime: dirtyInit } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init dirty-node", dirtyInit);
		const dirtyWorktreeList = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
		const dirtyEntry = dirtyWorktreeList
			.split("\n\n")
			.filter(Boolean)
			.find(entry => entry.includes("dirty-node"));
		expect(dirtyEntry).toBeDefined();
		const dirtyPathLine = dirtyEntry?.split("\n").find(line => line.startsWith("worktree "));
		const dirtyWorktreePath = dirtyPathLine?.slice("worktree ".length).trim();
		expect(dirtyWorktreePath).toBeTruthy();
		if (!dirtyWorktreePath) throw new Error("unreachable: asserted above");
		await fs.writeFile(path.join(dirtyWorktreePath, "uncommitted.txt"), "dirty\n");

		const { runtime: pruneDirtyRuntime, showStatus: pruneDirtyStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree prune dirty-node", pruneDirtyRuntime);
		expect(lastStatusText(pruneDirtyStatus).toLowerCase()).toMatch(/dirty|uncommitted|refus/);
		// The refusal must not delete the worktree.
		expect((await fs.stat(dirtyWorktreePath)).isDirectory()).toBe(true);
		expect(runGit(repoRoot, ["worktree", "list", "--porcelain"])).toContain("dirty-node");

		// Clean node: init, then remove with no pending changes.
		const { runtime: cleanInit } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree init clean-node", cleanInit);
		const cleanWorktreeList = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
		const cleanEntry = cleanWorktreeList
			.split("\n\n")
			.filter(Boolean)
			.find(entry => entry.includes("clean-node"));
		expect(cleanEntry).toBeDefined();
		const cleanPathLine = cleanEntry?.split("\n").find(line => line.startsWith("worktree "));
		const cleanWorktreePath = cleanPathLine?.slice("worktree ".length).trim();
		expect(cleanWorktreePath).toBeTruthy();
		if (!cleanWorktreePath) throw new Error("unreachable: asserted above");

		const { runtime: pruneCleanRuntime, showStatus: pruneCleanStatus } = createHarness(repoRoot);
		await executeBuiltinSlashCommand("/graphtree prune clean-node", pruneCleanRuntime);
		expect(lastStatusText(pruneCleanStatus).toLowerCase()).not.toMatch(/dirty|uncommitted|refus/);
		await expect(fs.access(cleanWorktreePath)).rejects.toThrow();
		expect(runGit(repoRoot, ["worktree", "list", "--porcelain"])).not.toContain("clean-node");
	});

	it("renders recursive AgentRegistry parent/child tree on /graphtree agents", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "running",
		});
		const sub1 = registry.register({
			id: "sub-1",
			displayName: "Worker 1",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
			cwd: "/tmp/worker1",
		});
		registry.setActivity(sub1.id, "building parser");

		const sub2 = registry.register({
			id: "sub-2",
			displayName: "Worker 2",
			kind: "sub",
			parentId: "sub-1",
			session: null,
			status: "idle",
		});
		registry.setAttention(sub2.id, "ask: confirmation needed");

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree agents", runtime);

		const text = lastStatusText(showStatus);
		expect(text).toContain("AgentRegistry Tree:");
		expect(text).toContain("Main [running] (main)");
		expect(text).toContain("Worker 1 (sub-1) [running] (sub)");
		expect(text).toContain('activity: "building parser"');
		expect(text).toContain("Worker 2 (sub-2) [idle] (sub)");
		expect(text).toContain("[ATTENTION: ask: confirmation needed]");
	});

	it("bounds and sanitizes the recursive AgentRegistry tree", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "running",
		});
		for (let index = 0; index < 15; index++) {
			const id = index === 0 ? "sub-\u001b[31munsafe" : `sub-${index}`;
			registry.register({
				id,
				displayName: index === 0 ? `Worker\t${"wide".repeat(40)}` : `Worker ${index}`,
				kind: "sub",
				parentId: index === 0 ? MAIN_AGENT_ID : index === 1 ? "sub-\u001b[31munsafe" : `sub-${index - 1}`,
				session: null,
				status: "idle",
			});
		}

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree agents", runtime);

		const text = lastStatusText(showStatus);
		expect(text).not.toContain("\u001b");
		expect(text).toContain("more agents not shown");
		expect(Math.max(...text.split("\n").map(line => Bun.stringWidth(line)))).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.LINE,
		);
	});

	it("injects configured hard bounds into the run prompt on /graphtree run", async () => {
		const { cleanup } = await setupWorktreeBase();
		cleanups.push(cleanup);
		const repoRoot = await createTempRepo("graphtree-bounds", "main");
		tempDirs.push(repoRoot);

		const customSettings = {
			"task.maxRecursionDepth": 4,
			"task.maxConcurrency": 16,
			"task.maxRuntimeMs": 600000,
			"task.isolation.mode": "auto",
		};
		const { runtime } = createHarness(repoRoot, customSettings);
		const result = await executeBuiltinSlashCommand("/graphtree run refactor system authentication", runtime);

		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result).toContain("maxRecursionDepth=4");
		expect(result).toContain("maxConcurrency=16");
		expect(result).toContain("maxRuntimeMs=600000");
		expect(result).toContain("isolationMode=auto");
	});
	it("aborts running session and releases agent on /graphtree stop", async () => {
		const registry = AgentRegistry.global();
		const mockSession = {
			abort: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSession;

		registry.register({
			id: "sub-target",
			displayName: "Target Agent",
			kind: "sub",
			session: mockSession,
			status: "running",
		});
		AgentLifecycleManager.global().adopt("sub-target", { idleTtlMs: 1000 });

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree stop sub-target", runtime);

		expect(mockSession.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(lastStatusText(showStatus)).toContain('Stopped and released GraphTree agent "sub-target"');
		expect(registry.get("sub-target")).toBeUndefined();
		expect(AgentLifecycleManager.global().has("sub-target")).toBe(false);
	});

	it("releases a running agent even when abort fails", async () => {
		const registry = AgentRegistry.global();
		const mockSession = {
			abort: vi.fn(async () => {
				throw new Error("abort\tfailed\n\u001b[31munsafe");
			}),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSession;
		registry.register({
			id: "sub-abort-failure",
			displayName: "Target Agent",
			kind: "sub",
			session: mockSession,
			status: "running",
		});
		AgentLifecycleManager.global().adopt("sub-abort-failure", { idleTtlMs: 1000 });

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree stop sub-abort-failure", runtime);

		expect(mockSession.dispose).toHaveBeenCalledTimes(1);
		expect(registry.get("sub-abort-failure")).toBeUndefined();
		expect(lastStatusText(showStatus)).toContain("after abort failed: abort failed [31munsafe");
		expect(lastStatusText(showStatus)).not.toContain("\u001b");
	});

	it("ensures live and steers agent on /graphtree steer", async () => {
		const registry = AgentRegistry.global();
		const mockSession = {
			steer: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSession;

		registry.register({
			id: "sub-steerable",
			displayName: "Steerable Agent",
			kind: "sub",
			session: null,
			status: "parked",
			sessionFile: "/tmp/session.json",
		});

		const reviver = vi.fn(async () => mockSession);
		AgentLifecycleManager.global().adopt("sub-steerable", { idleTtlMs: 1000, revive: reviver });

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree steer sub-steerable refocus on unit tests", runtime);

		expect(mockSession.steer).toHaveBeenCalledWith("refocus on unit tests");
		expect(lastStatusText(showStatus)).toContain('Steered agent "sub-steerable"');
		expect(reviver).toHaveBeenCalledTimes(1);
		expect(registry.get("sub-steerable")?.status).toBe("idle");
	});

	it("revives parked agent on /graphtree revive", async () => {
		const registry = AgentRegistry.global();
		const mockSession = {
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSession;

		registry.register({
			id: "sub-parked",
			displayName: "Parked Agent",
			kind: "sub",
			session: null,
			status: "parked",
			sessionFile: "/tmp/parked-session.json",
		});

		const reviver = async () => mockSession;
		AgentLifecycleManager.global().adopt("sub-parked", { idleTtlMs: 1000, revive: reviver });

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree revive sub-parked", runtime);

		expect(lastStatusText(showStatus)).toContain('Revived agent "sub-parked"');
		expect(registry.get("sub-parked")?.session).toBe(mockSession);
	});

	it("reports already-live agents without claiming a revival", async () => {
		const registry = AgentRegistry.global();
		const mockSession = {
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSession;
		registry.register({
			id: "sub-live",
			displayName: "Live Agent",
			kind: "sub",
			session: mockSession,
			status: "idle",
		});

		const { runtime, showStatus } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree revive sub-live", runtime);

		expect(lastStatusText(showStatus)).toContain('Agent "sub-live" is already idle');
		expect(registry.get("sub-live")?.session).toBe(mockSession);
	});

	it("refuses stop, steer, and revive on Main, advisor, or unknown agent IDs", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "advisor-1",
			displayName: "Advisor",
			kind: "advisor",
			session: null,
			status: "running",
		});

		const { runtime: runtimeStopMain, showStatus: statusStopMain } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree stop Main", runtimeStopMain);
		expect(lastStatusText(statusStopMain)).toContain("Refusing to stop agent");

		const { runtime: runtimeStopAdv, showStatus: statusStopAdv } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree stop advisor-1", runtimeStopAdv);
		expect(lastStatusText(statusStopAdv)).toContain("Refusing to stop agent");

		const { runtime: runtimeStopUnknown, showStatus: statusStopUnknown } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree stop ghost-id", runtimeStopUnknown);
		expect(lastStatusText(statusStopUnknown)).toContain("Refusing to stop agent");

		const { runtime: runtimeSteerMain, showStatus: statusSteerMain } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree steer Main pivot plan", runtimeSteerMain);
		expect(lastStatusText(statusSteerMain)).toContain("Refusing to steer agent");

		const { runtime: runtimeReviveMain, showStatus: statusReviveMain } = createHarness("/tmp");
		await executeBuiltinSlashCommand("/graphtree revive Main", runtimeReviveMain);
		expect(lastStatusText(statusReviveMain)).toContain("Refusing to revive agent");
	});
});
