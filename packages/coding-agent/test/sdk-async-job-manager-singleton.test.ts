import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager ownership across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). Manager
	// ownership is independent of model resolution, so we share a network-free registry.
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>, extensions: ExtensionFactory[] = []) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...extraSettings }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	/** A subagent under `root`, started as the task executor starts one: it uses the root's job manager. */
	async function spawnSubagent(root: AgentSession) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-subagent-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			settings: Settings.isolated(),
			parentTaskPrefix: "0-Sub",
			taskDepth: 1,
			agentId: "0-Sub",
			asyncJobManager: root.asyncJobManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	/**
	 * Registers `count` background jobs owned by `session`'s agent that record their
	 * start in `started` and run until `release` settles; returns their ids.
	 */
	function registerHeldJobs(
		session: AgentSession,
		ownerId: string,
		count: number,
		release: Promise<void>,
		started?: string[],
	): string[] {
		const manager = session.asyncJobManager!;
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(
				manager.register(
					"bash",
					`sleep 300 (${ownerId} ${i})`,
					async ({ jobId }) => {
						started?.push(jobId);
						await release;
						return "done";
					},
					{ ownerId },
				),
			);
		}
		return ids;
	}

	/** Resolves once `predicate` holds; throws after `timeoutMs`. */
	async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await scheduler.yield();
		}
	}

	it("runs 101 background jobs between a root session with async.maxJobs 0 and a subagent under it", async () => {
		const root = await spawnTopLevelSession({ "async.maxJobs": 0 });
		const subagent = await spawnSubagent(root);
		const release = Promise.withResolvers<void>();
		const started: string[] = [];
		try {
			expect(subagent.asyncJobManager).toBe(root.asyncJobManager!);
			const ids = [
				...registerHeldJobs(root, "Main", 50, release.promise, started),
				...registerHeldJobs(subagent, "0-Sub", 51, release.promise, started),
			];
			// Every body ran: with no cap, none of the 101 waits for a slot.
			await until(() => started.length === ids.length, "all 101 jobs to start");
			expect(started.sort()).toEqual([...ids].sort());
			expect(root.asyncJobManager!.getRunningJobs().map(job => job.id)).toEqual(ids);
		} finally {
			release.resolve();
			await root.asyncJobManager!.waitForAll();
			await subagent.dispose();
			await root.dispose();
		}
	}, 60000);

	it("lets a root session's async.maxJobs above 100 cap it and its subagent", async () => {
		const root = await spawnTopLevelSession({ "async.maxJobs": 101 });
		const subagent = await spawnSubagent(root);
		const release = Promise.withResolvers<void>();
		const started: string[] = [];
		try {
			registerHeldJobs(root, "Main", 50, release.promise, started);
			registerHeldJobs(subagent, "0-Sub", 51, release.promise, started);
			// 101 is above the old fixed ceiling of 100: all of them run.
			await until(() => started.length === 101, "all 101 jobs to start");
			const [overflowId] = registerHeldJobs(subagent, "0-Sub", 1, release.promise, started);
			expect(root.asyncJobManager!.getJob(overflowId!)?.waitingForSlot).toBe(true);
			expect(started).not.toContain(overflowId);
		} finally {
			release.resolve();
			await root.asyncJobManager!.waitForAll();
			await subagent.dispose();
			await root.dispose();
		}
	}, 60000);

	it("queues the 101st background job of a root session and its subagent at the async.maxJobs default", async () => {
		const root = await spawnTopLevelSession();
		const subagent = await spawnSubagent(root);
		const release = Promise.withResolvers<void>();
		const finisher = Promise.withResolvers<void>();
		const started: string[] = [];
		try {
			registerHeldJobs(root, "Main", 50, release.promise, started);
			registerHeldJobs(subagent, "0-Sub", 49, release.promise, started);
			const [finisherId] = registerHeldJobs(subagent, "0-Sub", 1, finisher.promise, started);
			await until(() => started.length === 100, "the first 100 jobs to start");
			const [overflowId] = registerHeldJobs(subagent, "0-Sub", 1, release.promise, started);
			const manager = root.asyncJobManager!;
			expect(manager.getJob(overflowId!)?.waitingForSlot).toBe(true);
			expect(started).not.toContain(overflowId);

			// It starts on its own as soon as one of the hundred ends.
			finisher.resolve();
			await manager.getJob(finisherId!)!.promise;
			await until(() => started.includes(overflowId!), "the queued job to start once a slot frees");
			expect(manager.getJob(overflowId!)?.waitingForSlot).toBe(false);
		} finally {
			release.resolve();
			await root.asyncJobManager!.waitForAll();
			await subagent.dispose();
			await root.dispose();
		}
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Secondary disposal must not cancel jobs registered by the primary (issue #1923).
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "Main" },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				expect(secondary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(false);
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("exposes the owning session's jobs through a production extension context", async () => {
		let observedSnapshot: AsyncJobSnapshot | null | undefined;
		const snapshotExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "capture_async_job_snapshot",
				label: "Capture async job snapshot",
				description: "Capture the session-owned async job snapshot for this test.",
				parameters: type({}),
				approval: "read",
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedSnapshot = ctx.getAsyncJobSnapshot();
					return { content: [{ type: "text", text: "captured" }] };
				},
			});
		};
		const session = await spawnTopLevelSession(undefined, [snapshotExtension]);
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const release = Promise.withResolvers<string>();
		const jobId = manager!.register("bash", "extension snapshot test", async () => release.promise, {
			ownerId: "Main",
		});

		try {
			const snapshotTool = session.getToolByName("capture_async_job_snapshot");
			expect(snapshotTool).toBeDefined();
			await snapshotTool!.execute("call-snapshot", {});

			expect(observedSnapshot?.running.some(job => job.id === jobId)).toBe(true);
		} finally {
			release.resolve("done");
			await manager!.waitForAll();
			await session.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
