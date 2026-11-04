import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { useTempWorktreesDir } from "../helpers/temp-worktrees";

/**
 * An isolated, kept-alive agent whose idle TTL expires is released, not
 * parked: its late writes are captured and delivered as the release path
 * does, and then its tree is removed. A capture that fails keeps the tree,
 * records why where `omp worktree list` shows it, and warns the user.
 * Real repositories, a real rcopy sandbox and the real capture and teardown;
 * only the child agent is a stand-in.
 */

/** The root bus channel the root session shows as a notice. */
const NOTICE_CHANNEL = "task:subagent:notice";

// Every sandbox goes under a root of this test's own.
useTempWorktreesDir();
const temporary: string[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(temporary.splice(0).map(dir => removeWithRetries(dir)));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	temporary.push(dir);
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

async function exists(target: string): Promise<boolean> {
	return fs.lstat(target).then(
		() => true,
		() => false,
	);
}

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
 * Run an isolated, kept-alive agent to the end of its run and hand it to the
 * lifecycle, as the executor does. Returns its sandbox and the bus notices.
 */
async function runKeptAliveAgent(id: string): Promise<{ mergedDir: string; artifactsDir: string; notices: unknown[] }> {
	const repo = await tempDir("omp-park-release-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "file.txt"), "base\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-q", "-m", "base");
	const artifactsDir = await tempDir("omp-park-release-artifacts-");
	const sessionDir = await tempDir("omp-park-release-session-");
	const bus = new EventBus();
	const notices: unknown[] = [];
	bus.on(NOTICE_CHANNEL, notice => notices.push(notice));
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	let mergedDir = "";
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		mergedDir = options.worktree ?? "";
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: path.join(sessionDir, `${options.id}.jsonl`),
			status: "running",
		});
		await fs.writeFile(path.join(mergedDir, "run.txt"), "written during the run\n");
		// No TTL timer: the test parks the agent itself, as the timer would.
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
	const run = await runIsolatedSubprocess({
		baseOptions: {
			cwd: repo,
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			subagentEventBus: bus,
		},
		context: { repoRoot: repo },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "patch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	expect(run.error).toBeUndefined();
	return { mergedDir, artifactsDir, notices };
}

describe("an isolated kept-alive agent at its idle TTL", () => {
	it("is released: its late writes are delivered, then its tree is removed", async () => {
		const id = "ParkReleased";
		const { mergedDir, artifactsDir } = await runKeptAliveAgent(id);
		// Written after the run ended: only a capture at park time saves it.
		await fs.writeFile(path.join(mergedDir, "late.txt"), "written after the run ended\n");

		await AgentLifecycleManager.global().park(id);

		expect(await exists(path.dirname(mergedDir))).toBe(false);
		const patch = await fs.readFile(path.join(artifactsDir, `${id}.patch`), "utf8");
		expect(patch).toContain("written after the run ended");
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		// A later message is told it was released and where its changes went.
		const revived = AgentLifecycleManager.global().ensureLive(id);
		await expect(revived).rejects.toThrow("was released when it went idle");
		await expect(revived).rejects.toThrow(path.join(artifactsDir, `${id}.patch`));
	}, 60_000);

	it("keeps its tree, records why for `omp worktree list`, and warns the user when the capture fails", async () => {
		const id = "ParkKept";
		const { mergedDir, notices } = await runKeptAliveAgent(id);
		// An untracked file nobody can read: the capture cannot carry it.
		const unreadable = path.join(mergedDir, "secret.txt");
		await fs.writeFile(unreadable, "the only copy\n");
		await fs.chmod(unreadable, 0o000);
		try {
			await AgentLifecycleManager.global().park(id);

			const keptAt = AgentRegistry.global().get(id)?.history?.keptWorkspace?.dir;
			expect(keptAt).toBeDefined();
			expect(await exists(keptAt ?? "")).toBe(true);
			const listed: string[] = [];
			vi.spyOn(console, "log").mockImplementation(text => listed.push(String(text)));
			await listWorktrees({ json: true });
			const entries = JSON.parse(listed.join("\n")) as Array<{ path: string; keptReason?: string }>;
			const entry = entries.find(candidate => candidate.path === path.dirname(keptAt ?? ""));
			expect(entry?.keptReason).toContain("could not be saved");
			expect(notices).toContainEqual(
				expect.objectContaining({ level: "warning", message: expect.stringContaining(keptAt ?? "") }),
			);
			await expect(AgentLifecycleManager.global().ensureLive(id)).rejects.toThrow(`kept at ${keptAt}`);
		} finally {
			const keptAt = AgentRegistry.global().get(id)?.history?.keptWorkspace?.dir;
			await fs.chmod(keptAt ? path.join(keptAt, "secret.txt") : unreadable, 0o600).catch(() => undefined);
			await fs.chmod(unreadable, 0o600).catch(() => undefined);
		}
	}, 60_000);
});
