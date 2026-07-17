import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

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

	async function spawnTopLevelSession(agentId: string, extraSettings?: Record<string, unknown>) {
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
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			agentId,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession("root-a");
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession("root-b");
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
		const primary = await spawnTopLevelSession("root-a");
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job for the primary. Disposing the secondary
			// must only cancel jobs owned by the secondary's distinct root id.
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
				{ ownerId: "root-a" },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession("root-b");
			const secondaryRelease = Promise.withResolvers<string>();
			const secondaryJobId = primaryManager!.register(
				"bash",
				"root B sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([secondaryRelease.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: "root-b" },
			);
			expect(secondary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([secondaryJobId]);
			await secondary.dispose();
			expect(primaryManager!.getJob(secondaryJobId)?.status).toBe("cancelled");
			expect(primary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([jobId]);
			secondaryRelease.resolve("done");

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("shares async execution while filtering and routing two unique roots", async () => {
		const primary = await spawnTopLevelSession("root-a", { "async.enabled": true });
		try {
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();

			const secondary = await spawnTopLevelSession("root-b", { "async.enabled": true });
			try {
				expect(secondary.asyncJobManager).toBe(manager);
				const primaryEnqueue = primary.yieldQueue.enqueue.bind(primary.yieldQueue);
				const secondaryEnqueue = secondary.yieldQueue.enqueue.bind(secondary.yieldQueue);
				const primaryDeliveries: string[] = [];
				const secondaryDeliveries: string[] = [];
				primary.yieldQueue.enqueue = ((kind: string, entry: { jobId?: string }) => {
					if (kind === "async-result" && entry.jobId) primaryDeliveries.push(entry.jobId);
					primaryEnqueue(kind, entry);
				}) as typeof primary.yieldQueue.enqueue;
				secondary.yieldQueue.enqueue = ((kind: string, entry: { jobId?: string }) => {
					if (kind === "async-result" && entry.jobId) secondaryDeliveries.push(entry.jobId);
					secondaryEnqueue(kind, entry);
				}) as typeof secondary.yieldQueue.enqueue;
				const primaryArtifact = vi.spyOn(primary.sessionManager, "allocateArtifactPath");
				const secondaryArtifact = vi.spyOn(secondary.sessionManager, "allocateArtifactPath");

				const taskId = manager!.register("task", "root A task", async () => "task complete", {
					id: "root-a-task",
					ownerId: "root-a",
				});
				const bashId = manager!.register("bash", "root B bash", async () => "b".repeat(12_001), {
					id: "root-b-bash",
					ownerId: "root-b",
				});

				expect(primary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([taskId]);
				expect(secondary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([bashId]);
				const primaryList = await primary.getToolByName("job")!.execute("list-a", { list: true });
				const secondaryList = await secondary.getToolByName("job")!.execute("list-b", { list: true });
				expect((primaryList.details as { jobs: Array<{ id: string }> }).jobs.map(job => job.id)).toEqual([taskId]);
				expect((secondaryList.details as { jobs: Array<{ id: string }> }).jobs.map(job => job.id)).toEqual([
					bashId,
				]);
				await manager!.waitForAll();
				await manager!.drainDeliveries({ timeoutMs: 1_000 });
				expect(primaryDeliveries).toEqual([taskId]);
				expect(secondaryDeliveries).toEqual([bashId]);
				expect(primaryArtifact).not.toHaveBeenCalled();
				expect(secondaryArtifact).toHaveBeenCalledWith("async");
			} finally {
				await secondary.dispose();
			}

			expect(AsyncJobManager.instance()).toBe(manager);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("drops completion when the registered owner has vanished", async () => {
		const owner = await spawnTopLevelSession("vanishing-root");
		const manager = AsyncJobManager.instance();
		expect(manager).toBeDefined();
		const gate = Promise.withResolvers<string>();
		const warn = vi
			.spyOn(await import("@pk-nerdsaver-ai/pi-utils").then(module => module.logger), "warn")
			.mockImplementation(() => {});
		try {
			manager!.register("task", "vanishing task", async () => gate.promise, {
				id: "vanished-owner-job",
				ownerId: "vanishing-root",
			});
			AgentRegistry.global().unregister("vanishing-root");
			gate.resolve("must not be delivered");
			await manager!.waitForAll();
			await manager!.drainDeliveries({ timeoutMs: 1_000 });
			expect(owner.yieldQueue.has("async-result")).toBe(false);
			expect(warn).toHaveBeenCalledWith(
				"Dropping async completion because its owner session is unavailable",
				expect.objectContaining({ jobId: "vanished-owner-job", ownerId: "vanishing-root" }),
			);
		} finally {
			warn.mockRestore();
			await owner.dispose();
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

		const replacement = await spawnTopLevelSession("replacement");
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
