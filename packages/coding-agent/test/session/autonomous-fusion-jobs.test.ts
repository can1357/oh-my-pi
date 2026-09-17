import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { OperationalStore } from "../../src/operational/store";
import type { DurableJob } from "../../src/operational/types";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import {
	collectAutonomousTaskHandoffs,
	controlSessionNativeTasks,
	formatAutonomousTaskHandoff,
	sessionNativeTasks,
} from "../../src/session/fusion-autonomous-jobs";
import { SessionManager } from "../../src/session/session-manager";
import { handleFusionCommand } from "../../src/slash-commands/helpers/fusion";
import { showFusionMenu } from "../../src/slash-commands/helpers/fusion-tui";

const SESSION_ID = "parent-session-1";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	// LIFO: stores must close before their temp directory is removed (Windows EBUSY).
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
});

async function removeDir(dir: TempDir): Promise<void> {
	try {
		await dir.remove();
	} catch {
		// ignore cleanup races on Windows (WAL shm handles release asynchronously)
	}
}

function withIsolatedAgentDir(): TempDir {
	const dir = TempDir.createSync("@omp-autonomous-jobs-");
	setAgentDir(dir.path());
	expect(getAgentDir()).toBe(dir.path());
	cleanups.push(() => removeDir(dir));
	return dir;
}

function openStore(dir: TempDir): OperationalStore {
	const store = OperationalStore.open({ dbPath: path.join(dir.path(), "operational.db"), durability: "normal" });
	cleanups.push(() => store.close());
	return store;
}

function createNativeJob(
	store: OperationalStore,
	options: {
		parentSessionId?: string | null;
		agentId?: string;
		status?: "completed" | "failed" | "cancelled" | "paused";
	} = {},
): DurableJob {
	const job = store.createJob({
		type: "native_task",
		payload: {
			parentSessionId: options.parentSessionId === undefined ? SESSION_ID : options.parentSessionId,
			agentId: options.agentId ?? "WorkerA",
		},
	});
	// Terminal states require a running hop (with a lease owner) per the
	// store's transition graph.
	const settle = (input: Parameters<OperationalStore["transitionJob"]>[1]): DurableJob => {
		if (!store.claimJobById(job.id, "test-worker", 60_000)) throw new Error("claim failed");
		return store.transitionJob(job.id, { ...input, leaseOwner: "test-worker" });
	};
	switch (options.status) {
		case "completed":
			return settle({
				to: "completed",
				result: { mergeSummary: "merged 2 files", output: "worker output" },
			});
		case "failed":
			return settle({ to: "failed", error: "worker exploded" });
		case "cancelled":
			return store.transitionJob(job.id, { to: "cancelled", error: "cancelled" });
		case "paused":
			return store.transitionJob(job.id, { to: "paused" });
		default:
			return job;
	}
}

function makeRuntime(dir: TempDir, sessionId: string = SESSION_ID) {
	const outputs: string[] = [];
	const settings = Settings.isolated({ "fusion.enabled": true, "fusion.mode": "autonomous" });
	const runtime = {
		settings,
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => dir.path(),
		},
		session: {
			getFusionSidekickId: () => undefined,
			getFusionUsageSplit: () => ({
				total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		},
		output: async (text: string) => {
			outputs.push(text);
		},
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as unknown as Parameters<typeof handleFusionCommand>[1];
	return { runtime, outputs, settings };
}

describe("autonomous durable task surfaces", () => {
	it("scopes native task listing to the owning session", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const mine = createNativeJob(store, { agentId: "Mine" });
		createNativeJob(store, { parentSessionId: "other-session", agentId: "Theirs" });
		createNativeJob(store, { parentSessionId: null, agentId: "Orphan" });
		store.createJob({ type: "scheduled_other", payload: { parentSessionId: SESSION_ID } });
		const jobs = sessionNativeTasks(store, SESSION_ID);
		expect(jobs.map(job => job.id)).toEqual([mine.id]);
		expect(sessionNativeTasks(store, "other-session")).toHaveLength(1);
		expect(sessionNativeTasks(store, undefined)).toEqual([]);
	});

	it("collects hidden handoffs only for unreported terminal session jobs", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const done = createNativeJob(store, { status: "completed", agentId: "Finisher" });
		createNativeJob(store, { status: "paused", agentId: "Paused" });
		createNativeJob(store, { agentId: "Queued" });
		createNativeJob(store, { status: "completed", parentSessionId: "other-session" });
		const reported = new Set<string>();
		const first = collectAutonomousTaskHandoffs({ store, sessionId: SESSION_ID, reported });
		expect(first.messages).toHaveLength(1);
		expect(first.reportedIds).toEqual([done.id]);
		const message = first.messages[0]!;
		expect(message.role).toBe("custom");
		expect(message.customType).toBe("autonomous-task-update");
		expect(message.display).toBe(false);
		expect(String(message.content)).toContain(done.id);
		expect(String(message.content)).toContain("Finisher");
		expect(String(message.content)).toContain('finished with status "completed"');
		expect(String(message.content)).toContain("merged 2 files");
		expect(String(message.content)).toContain("into the plan");
		for (const id of first.reportedIds) reported.add(id);
		const second = collectAutonomousTaskHandoffs({ store, sessionId: SESSION_ID, reported });
		expect(second.messages).toHaveLength(0);
	});

	it("formats failure handoffs with the error detail and recovery guidance", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const failed = createNativeJob(store, { status: "failed", agentId: "Breaker" });
		const text = formatAutonomousTaskHandoff(failed);
		expect(text).toContain(failed.id);
		expect(text).toContain("Breaker");
		expect(text).toContain('"failed"');
		expect(text).toContain("worker exploded");
		expect(text).toContain("checkpoint");
	});

	it("pauses, resumes, and cancels only this session's eligible jobs", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const queued = createNativeJob(store, { agentId: "Queued" });
		const other = createNativeJob(store, { parentSessionId: "other-session", agentId: "Theirs" });
		const paused = controlSessionNativeTasks({ store, sessionId: SESSION_ID, action: "pause" });
		expect(paused.changed.map(job => job.id)).toEqual([queued.id]);
		expect(paused.failures).toEqual([]);
		expect(store.getJob(queued.id)?.status).toBe("paused");
		expect(store.getJob(other.id)?.status).toBe("queued");

		const resumed = controlSessionNativeTasks({ store, sessionId: SESSION_ID, action: "resume" });
		expect(resumed.changed.map(job => job.id)).toEqual([queued.id]);
		expect(store.getJob(queued.id)?.status).toBe("queued");
		expect(store.getJob(other.id)?.status).toBe("queued");

		const stopped = controlSessionNativeTasks({ store, sessionId: SESSION_ID, action: "cancel" });
		expect(stopped.changed.map(job => job.id)).toEqual([queued.id]);
		expect(store.getJob(queued.id)?.status).toBe("cancelled");
		expect(store.getJob(other.id)?.status).toBe("queued");
	});

	it("targets a single job by id or agent id and reports misses", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const byAgent = createNativeJob(store, { agentId: "NamedWorker" });
		const targeted = controlSessionNativeTasks({
			store,
			sessionId: SESSION_ID,
			action: "cancel",
			jobId: "NamedWorker",
		});
		expect(targeted.changed.map(job => job.id)).toEqual([byAgent.id]);
		const miss = controlSessionNativeTasks({
			store,
			sessionId: SESSION_ID,
			action: "cancel",
			jobId: "nope",
		});
		expect(miss.changed).toEqual([]);
		expect(miss.failures[0]).toContain("nope");
	});

	it("refuses to resume a job still leased by a live worker", () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const job = createNativeJob(store, { agentId: "Leased" });
		store.claimJobById(job.id, "other-worker", 60_000);
		store.transitionJob(job.id, { to: "paused", leaseOwner: "other-worker" });
		const result = controlSessionNativeTasks({ store, sessionId: SESSION_ID, action: "resume" });
		expect(result.changed).toEqual([]);
		expect(result.failures[0]).toContain("acknowledges the pause");
	});

	it("lists and controls durable jobs through /fusion verbs", async () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		const queued = createNativeJob(store, { agentId: "WorkerListed" });
		const { runtime, outputs } = makeRuntime(dir);
		const run = (args: string) => handleFusionCommand({ name: "fusion", args, text: `/fusion ${args}` }, runtime);

		await run("jobs");
		expect(outputs.at(-1)).toContain("WorkerListed");
		expect(outputs.at(-1)).toContain(queued.id);
		expect(outputs.at(-1)).toContain("queued");

		await run("pause");
		expect(store.getJob(queued.id)?.status).toBe("paused");
		expect(outputs.at(-1)).toContain("Paused 1 job(s)");

		await run("resume");
		expect(store.getJob(queued.id)?.status).toBe("queued");

		await run("stop");
		expect(store.getJob(queued.id)?.status).toBe("cancelled");
		expect(outputs.at(-1)).toContain("Stopped 1 job(s)");

		await run("jobs");
		expect(outputs.at(-1)).toContain("cancelled");
	});

	it("keeps other sessions' jobs untouched through /fusion stop", async () => {
		const dir = withIsolatedAgentDir();
		const store = openStore(dir);
		createNativeJob(store, { parentSessionId: "other-session", agentId: "NotMine" });
		const { runtime } = makeRuntime(dir);
		await handleFusionCommand({ name: "fusion", args: "stop", text: "/fusion stop" }, runtime);
		expect(sessionNativeTasks(store, "other-session")[0]?.status).toBe("queued");
	});
});

describe("autonomous planner handoff injection", () => {
	async function createAutonomousSession(overrides: Record<string, unknown> = {}) {
		const directory = TempDir.createSync("@omp-autonomous-drain-");
		const authStorage = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(directory.path(), "models.yml"));
		const model = modelRegistry.getAll()[0];
		if (!model) throw new Error("Missing bundled model");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "autonomous",
			"async.enabled": false,
			"task.batch": false,
			"task.prefetch.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"tools.approvalMode": "yolo",
			"tools.discoveryMode": "off",
			...overrides,
		});
		const sessionManager = SessionManager.inMemory(directory.path());
		const created = await createAgentSession({
			cwd: directory.path(),
			agentDir: directory.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			model,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		cleanups.push(async () => {
			await created.session.dispose();
			authStorage.close();
			await removeDir(directory);
		});
		return { session: created.session, sessionManager };
	}

	it("drains externally settled durable jobs into planner handoffs exactly once", async () => {
		const dir = withIsolatedAgentDir();
		const { session, sessionManager } = await createAutonomousSession();
		const store = openStore(dir);
		const sid = sessionManager.getSessionId();
		const job = createNativeJob(store, { parentSessionId: sid, status: "completed", agentId: "Settled" });
		const handoffs = session.drainAutonomousTaskHandoffs();
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.customType).toBe("autonomous-task-update");
		expect(String(handoffs[0]?.content)).toContain(job.id);
		expect(String(handoffs[0]?.content)).toContain("merged 2 files");
		expect(session.drainAutonomousTaskHandoffs()).toHaveLength(0);
	});

	it("suppresses handoffs for jobs already reported by an inline dispatch", async () => {
		const dir = withIsolatedAgentDir();
		const { session, sessionManager } = await createAutonomousSession();
		const store = openStore(dir);
		const job = createNativeJob(store, {
			parentSessionId: sessionManager.getSessionId(),
			status: "failed",
			agentId: "Inline",
		});
		session.markAutonomousTaskJobReported(job.id);
		expect(session.drainAutonomousTaskHandoffs()).toHaveLength(0);
	});

	it("does not drain outside the autonomous planning root", async () => {
		const dir = withIsolatedAgentDir();
		const { session, sessionManager } = await createAutonomousSession({ "fusion.mode": "token-savings" });
		const store = openStore(dir);
		createNativeJob(store, { parentSessionId: sessionManager.getSessionId(), status: "completed" });
		expect(session.drainAutonomousTaskHandoffs()).toHaveLength(0);
	});
});

describe("autonomous mode in the TUI fusion menu", () => {
	it("offers and applies autonomous through the mode picker", async () => {
		const dir = TempDir.createSync("@omp-fusion-tui-");
		cleanups.push(() => removeDir(dir));
		// No fusion.mode seed: isolated() lands overrides in the override layer,
		// which would shadow the menu's settings.set() writes. "escalate" is the
		// schema default the menu label reads.
		const settings = Settings.isolated({ "fusion.enabled": true });
		const shown: Array<{ title: string; labels: string[] }> = [];
		const picks = ["Mode: escalate", "autonomous", undefined];
		const statuses: string[] = [];
		const ctx = {
			settings,
			sessionManager: { getCwd: () => dir.path(), getSessionId: () => SESSION_ID },
			session: {
				getFusionSidekickId: () => undefined,
				getFusionUsageSplit: () => ({
					total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			},
			showHookSelector: async (title: string, items: Array<{ label: string }>) => {
				shown.push({ title, labels: items.map(item => item.label) });
				return picks.shift();
			},
			ensureFusionSidekick: () => {},
			reconcileFusionSidekickModel: async () => "",
			statusLine: { invalidate: () => {} },
			updateEditorTopBorder: () => {},
			ui: { requestRender: () => {} },
			showStatus: (text: string) => statuses.push(text),
			editor: { setText: () => {} },
			refreshSlashCommandState: () => {},
		} as unknown as InteractiveModeContext;

		await showFusionMenu(ctx);
		const modePicker = shown.find(entry => entry.title === "Fusion mode");
		expect(modePicker?.labels).toContain("autonomous");
		expect(settings.get("fusion.mode")).toBe("autonomous");
	});
});
