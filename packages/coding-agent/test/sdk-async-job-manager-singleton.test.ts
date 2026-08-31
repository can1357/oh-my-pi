import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
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
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
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

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job on the primary's manager under the
			// MAIN_AGENT_ID owner — the same owner the secondary would inherit by
			// default. The secondary's dispose-time `cancelOwnAsyncJobs` must NOT
			// cancel this job (issue #1923).
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
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
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

	it("keeps fast auto-managed foreground Bash out of the public async snapshot", async () => {
		const session = await spawnTopLevelSession({ "bash.autoBackground.thresholdMs": 60_000 });
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const releaseMarker = Promise.withResolvers<string>();
		const markerId = manager!.register("task", "visible recent marker", async () => releaseMarker.promise, {
			ownerId: "Main",
		});
		manager!.acknowledgeDeliveries([markerId]);
		releaseMarker.resolve("done");
		await manager!.waitForAll();
		manager!.getJob(markerId)!.startTime = 0;
		const before = session.getAsyncJobSnapshot({ recentLimit: 1 });
		expect(before?.recent.map(job => job.id)).toEqual([markerId]);

		try {
			const bashTool = session.getToolByName("bash");
			expect(bashTool).toBeDefined();
			const result = await bashTool!.execute("call-fast-foreground", { command: "printf 'fast foreground'" });
			await manager!.waitForAll();

			expect(result.content.find(block => block.type === "text")?.text).toContain("fast foreground");
			expect(session.getAsyncJobSnapshot({ recentLimit: 1 })).toEqual(before);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("publishes auto-managed Bash when it actually backgrounds", async () => {
		const session = await spawnTopLevelSession({ "bash.autoBackground.thresholdMs": 10 });
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();

		try {
			const bashTool = session.getToolByName("bash");
			expect(bashTool).toBeDefined();
			// This exercises the real threshold race through BashTool, so the
			// command must remain alive long enough for the platform timer to win.
			const result = await bashTool!.execute("call-auto-background", {
				command: "sleep 30",
			});
			const snapshot = session.getAsyncJobSnapshot();

			expect(snapshot?.running).toHaveLength(1);
			expect(snapshot?.running[0]?.type).toBe("bash");
			const resultText = result.content.find(block => block.type === "text")?.text;
			expect(resultText).toContain(`Backgrounded as job ${snapshot!.running[0]!.id}`);
		} finally {
			await session.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
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
