/**
 * Contracts: `async.maxJobs` bounds the subagents the task tool starts in a
 * session, through the session `createAgentSession` builds (its job manager,
 * its live setting, its task tool). Only the subagent run itself is stubbed.
 *
 * 1. Spawns past the cap wait queued and start, in order, as running ones end.
 * 2. Raising the cap in the running session starts waiting spawns at once.
 * 3. A spawn cancelled while it waits never runs and frees no slot.
 * 4. The cap keeps its meaning: a fraction floors, 0 means one, above 100 means 100.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { cfgAsyncMaxJobs } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} done.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

async function pollUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

/**
 * Give a spawn that must NOT start the time it would need to start. Nothing
 * signals "did not start", so this negative check needs a real wait; at the
 * defect a surplus spawn starts within a few milliseconds of the batch.
 */
async function quietPeriod(): Promise<void> {
	await Bun.sleep(50);
}

describe("async.maxJobs through the task tool", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	/** Subagent runs in start order; `running` holds the ones not yet finished. */
	const started: string[] = [];
	const running = new Set<string>();
	const gates = new Map<string, PromiseWithResolvers<void>>();
	let peak = 0;

	const gate = (id: string): PromiseWithResolvers<void> => {
		let found = gates.get(id);
		if (!found) {
			found = Promise.withResolvers<void>();
			gates.set(id, found);
		}
		return found;
	};

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-async-max-jobs-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			running.add(id);
			peak = Math.max(peak, running.size);
			try {
				await gate(id).promise;
			} finally {
				running.delete(id);
			}
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const pending of gates.values()) pending.resolve();
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
		gates.clear();
		started.length = 0;
		running.clear();
		peak = 0;
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function openSession(values: Record<string, unknown>) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-async-max-jobs-${Snowflake.next()}-`));
		tempDirs.push(dir);
		const cwd = path.join(dir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const settings = Settings.isolated({
			"async.enabled": true,
			"async.widgets": false,
			"task.batch": true,
			"task.speculativeLaunch": false,
			...values,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(dir, "agent"),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry,
			toolNames: ["task"],
		});
		sessions.push(session);
		const task = session.getToolByName("task");
		const jobs = session.asyncJobManager;
		if (!task || !jobs) throw new Error("expected the task tool and the session's job manager");
		/** Spawn `names` as background agents in one batch call; returns their jobs by name. */
		const spawn = async (names: string[]): Promise<Map<string, AsyncJob>> => {
			await task.execute(`tc-${names.join("-")}`, {
				context: "Shared context.",
				tasks: names.map(name => ({ name, agent: "task", task: `Work ${name}.` })),
			});
			return new Map(
				names.map(name => {
					const job = jobs.getJob(name);
					if (!job) throw new Error(`no job for ${name}`);
					return [name, job];
				}),
			);
		};
		return { settings, jobs, spawn };
	}

	it("runs at most async.maxJobs spawns of a batch at once; the last waits queued until a slot frees", async () => {
		const { spawn } = await openSession({ "async.maxJobs": 2, "task.maxConcurrency": 32 });
		const jobs = await spawn(["Alpha", "Beta", "Gamma"]);

		await pollUntil(() => started.length >= 2);
		await quietPeriod();
		// Slots go out in call order; the two holders may reach the executor in either order.
		expect([...started].sort()).toEqual(["Alpha", "Beta"]);
		expect(jobs.get("Gamma")?.queued).toBe(true);

		gate("Alpha").resolve();
		await pollUntil(() => started.length === 3);
		expect(started[2]).toBe("Gamma");
		expect(jobs.get("Gamma")?.queued).toBe(false);

		gate("Beta").resolve();
		gate("Gamma").resolve();
		await Promise.all([...jobs.values()].map(job => job.promise));
		expect([...jobs.values()].map(job => job.status)).toEqual(["completed", "completed", "completed"]);
		expect(peak).toBe(2);
	});

	it("starts a waiting spawn as soon as async.maxJobs is raised in the running session", async () => {
		const { settings, spawn } = await openSession({ "async.maxJobs": 1 });
		const jobs = await spawn(["Alpha", "Beta"]);
		await pollUntil(() => started.length >= 1);
		await quietPeriod();
		expect(started).toEqual(["Alpha"]);

		cfgAsyncMaxJobs.override(settings, 2);
		await pollUntil(() => started.length === 2);
		expect(running).toEqual(new Set(["Alpha", "Beta"]));

		gate("Alpha").resolve();
		gate("Beta").resolve();
		await Promise.all([...jobs.values()].map(job => job.promise));
	});

	it("never runs a spawn cancelled while it waits for a slot, and frees no slot for it", async () => {
		const { jobs: manager, spawn } = await openSession({ "async.maxJobs": 1 });
		const jobs = await spawn(["Alpha", "Beta"]);
		await pollUntil(() => started.length >= 1);

		expect(manager.cancel("Beta")).toBe(true);
		await jobs.get("Beta")?.promise;
		expect(jobs.get("Beta")?.status).toBe("cancelled");

		const later = await spawn(["Gamma"]);
		await quietPeriod();
		expect(started).toEqual(["Alpha"]);

		gate("Alpha").resolve();
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["Alpha", "Gamma"]);
		gate("Gamma").resolve();
		await later.get("Gamma")?.promise;
		expect(peak).toBe(1);
	});

	it.each([
		{ value: 2.5, limit: 2 },
		{ value: 0, limit: 1 },
		{ value: 150, limit: 100 },
	])("caps running spawns at $limit when async.maxJobs is $value", async ({ value, limit }) => {
		const { spawn } = await openSession({ "async.maxJobs": value, "task.maxConcurrency": 0 });
		const names = Array.from({ length: limit + 1 }, (_, index) => `Worker${index}`);
		const jobs = await spawn(names);

		await pollUntil(() => started.length >= limit);
		await quietPeriod();
		expect(started.length).toBe(limit);

		gate(started[0]!).resolve();
		await pollUntil(() => started.length === limit + 1);
		for (const name of names) gate(name).resolve();
		await Promise.all([...jobs.values()].map(job => job.promise));
		expect(peak).toBe(limit);
	});
});
