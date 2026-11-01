/** Pausing cancels work, not the worker's only in-memory conversation; kills remain terminal. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { restoreEnvValue } from "../helpers/settings-test-state";

const OWNER = "vibe-pause-parent";
const MOCK_API_SOURCE = "test/vibe-pause-scope";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let parent: ToolSession;

/** Serve `mock` from the registry so the real executor resolves `mock/mock-model`. */
function installMockModel(mock: MockModel): void {
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vibe-pause-"));
	// Under the isolated HOME: project discovery walks up from cwd and stops at
	// os.homedir(), so a cwd outside it would load the developer's real plugins.
	const home = path.join(root, "home");
	const cwd = path.join(home, "work");
	await fs.mkdir(cwd, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ onJobComplete: () => {} });
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	parent = {
		cwd,
		settings: Settings.isolated({
			// No TTL timer: parking an untranscripted worker is exactly what these tests forbid.
			"task.agentIdleTtlMs": 0,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "mock/mock-model", smol: "mock/mock-model", task: "mock/mock-model" },
		}),
		asyncJobManager: manager,
		getAgentId: () => OWNER,
		getSessionId: () => "vibe-pause-session",
		// No parent session file: the worker is a --no-session worker with no transcript.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
		authStorage,
		modelRegistry,
	} as unknown as ToolSession;
});

afterEach(async () => {
	await manager?.dispose({ timeoutMs: 100 });
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	authStorage?.close();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

describe("vibe scope pause", () => {
	it("cancels the in-flight turn and queued directives, then resumes the same conversation", async () => {
		const started = Promise.withResolvers<void>();
		const firstPrompt = "Keep the migration format.";
		const laterDirective = "Continue with the agreed format.";
		const mock = createMockModel({
			handler: context => {
				const transcript = JSON.stringify(context.messages);
				// Only the follow-up that carries the later directive ends the run.
				if (transcript.includes(laterDirective)) {
					return {
						content: [
							{ type: "toolCall", name: "yield", arguments: { type: "result", data: "second turn done" } },
						],
					};
				}
				if (!transcript.includes(firstPrompt)) return { content: ["ack"] };
				started.resolve();
				// Hold the first turn open until the scope is paused; the delay honours the abort signal.
				return { content: ["working"], delayMs: 60_000 };
			},
		});
		installMockModel(mock);
		// Hold the first turn before its session exists, so a second directive queues deterministically.
		const gate = Promise.withResolvers<void>();
		const realRunSubprocess = executorModule.runSubprocess;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return realRunSubprocess(options);
		});

		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(parent);
		const spawned = await registry.spawn(parent, {
			cli: "fast",
			name: "PauseWorker",
			prompt: firstPrompt,
		});
		const queued = await registry.send(parent, { session: spawned.id, message: "queued directive" });
		expect(queued.mode).toBe("queued");
		expect(registry.screens(parent)).toEqual([
			expect.objectContaining({ id: spawned.id, state: "running", queued: 1 }),
		]);

		gate.resolve();
		await started.promise;
		const live = AgentRegistry.global().get(spawned.id)?.session;
		if (!live) throw new Error("expected the worker to own a live session");

		expect(await registry.pauseScope(scope, manager)).toBe(1);
		expect(manager.getRunningJobs({ ownerId: OWNER })).toEqual([]);
		expect(registry.screens(parent)).toEqual([
			expect.objectContaining({ id: spawned.id, state: "idle", queued: 0, turnStartedAt: undefined }),
		]);
		// The paused record keeps its agent ref and its in-memory conversation.
		expect(AgentRegistry.global().get(spawned.id)?.session).toBe(live);
		expect(JSON.stringify(live.state.messages)).toContain(firstPrompt);
		expect(registry.listIds(parent)).toEqual([spawned.id]);
		await expect(registry.send(parent, { session: spawned.id, message: "too early" })).rejects.toThrow(/paused/);

		registry.activateScope(scope);
		// Resuming does not replay the cancelled turn: the scope stays quiescent until the next directive.
		expect(manager.getRunningJobs({ ownerId: OWNER })).toEqual([]);
		const sent = await registry.send(parent, { session: spawned.id, message: laterDirective });
		expect(sent.mode).toBe("turn");
		const job = sent.jobId ? manager.getJob(sent.jobId) : undefined;
		if (!job) throw new Error("expected a follow-up turn job");
		await job.promise;
		expect(job.status).toBe("completed");

		// The follow-up ran on the retained conversation: both directives are in its context.
		const transcript = JSON.stringify(mock.calls.at(-1)?.context.messages);
		expect(transcript).toContain(firstPrompt);
		expect(transcript).toContain(laterDirective);
		// The queued directive died with the cancelled turn instead of starting one.
		expect(transcript).not.toContain("queued directive");
		expect(AgentRegistry.global().get(spawned.id)?.session).toBe(live);
	});

	it("drops a steered directive that is still queued when the scope pauses", async () => {
		const started = Promise.withResolvers<void>();
		const firstPrompt = "Keep the migration format.";
		const steeredDirective = "Apply the steered override.";
		const laterDirective = "Continue with the agreed format.";
		const mock = createMockModel({
			handler: context => {
				const transcript = JSON.stringify(context.messages);
				if (transcript.includes(laterDirective)) {
					return {
						content: [
							{ type: "toolCall", name: "yield", arguments: { type: "result", data: "second turn done" } },
						],
					};
				}
				if (!transcript.includes(firstPrompt)) return { content: ["ack"] };
				started.resolve();
				// Hold the turn open so the steer stays queued instead of being delivered.
				return { content: ["working"], delayMs: 60_000 };
			},
		});
		installMockModel(mock);

		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(parent);
		const spawned = await registry.spawn(parent, { cli: "fast", name: "SteerWorker", prompt: firstPrompt });
		await started.promise;
		const live = AgentRegistry.global().get(spawned.id)?.session;
		if (!live) throw new Error("expected the worker to own a live session");

		const steered = await registry.send(parent, { session: spawned.id, message: steeredDirective });
		expect(steered.mode).toBe("steered");
		// A steered directive lives in the child agent's queue until the round ends,
		// so `record.queue.length = 0` alone would leave it to restart the turn.
		expect(live.agent.hasQueuedMessages()).toBe(true);

		expect(await registry.pauseScope(scope, manager)).toBe(1);
		expect(live.agent.hasQueuedMessages()).toBe(false);
		expect(manager.getRunningJobs({ ownerId: OWNER })).toEqual([]);

		registry.activateScope(scope);
		const resumed = await registry.send(parent, { session: spawned.id, message: laterDirective });
		expect(resumed.mode).toBe("turn");
		const job = resumed.jobId ? manager.getJob(resumed.jobId) : undefined;
		if (!job) throw new Error("expected a follow-up turn job");
		await job.promise;
		expect(job.status).toBe("completed");

		const transcript = JSON.stringify(mock.calls.at(-1)?.context.messages);
		expect(transcript).toContain(firstPrompt);
		expect(transcript).toContain(laterDirective);
		expect(transcript).not.toContain(steeredDirective);
		expect(AgentRegistry.global().get(spawned.id)?.session).toBe(live);
	});

	it("releases a paused worker's conversation on an explicit kill", async () => {
		const started = Promise.withResolvers<void>();
		const prompt = "Do the migration.";
		const mock = createMockModel({
			handler: context => {
				if (!JSON.stringify(context.messages).includes(prompt)) return { content: ["ack"] };
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		});
		installMockModel(mock);

		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(parent);
		const spawned = await registry.spawn(parent, { cli: "fast", name: "KillWorker", prompt });
		await started.promise;
		if (!AgentRegistry.global().get(spawned.id)?.session) {
			throw new Error("expected the worker to own a live session");
		}

		expect(await registry.pauseScope(scope, manager)).toBe(1);
		registry.activateScope(scope);

		expect(await registry.kill(parent, spawned.id)).toEqual({ id: spawned.id, cancelledTurn: false });
		expect(AgentRegistry.global().get(spawned.id)).toBeUndefined();
		expect(AgentLifecycleManager.global().has(spawned.id)).toBe(false);
		expect(registry.listIds(parent)).toEqual([]);
		expect(registry.screens(parent).find(screen => screen.id === spawned.id)?.state).toBe("dead");
	});
});
