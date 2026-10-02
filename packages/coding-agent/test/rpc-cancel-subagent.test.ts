import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { handleRpcCancelSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("handleRpcCancelSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let frames: RpcSubagentFrame[];
	let calls: string[];
	/** Real directory: releasing a tombstone persists `<sessionFile>.tombstone`. */
	let sessionDir: string;
	let ownSessionFile: string;

	beforeEach(() => {
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-cancel-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		calls = [];
		frames = [];
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
	});

	afterEach(() => {
		registry.dispose();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"], sessionFile = ownSessionFile): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register a live subagent whose session records abort/dispose calls. */
	function registerLiveAgent(id: string, sessionFile = ownSessionFile): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				abort: async () => {
					calls.push(`abort:${id}`);
				},
				dispose: async () => {
					calls.push(`dispose:${id}`);
				},
			} as never,
			sessionFile,
			status: "running",
		});
	}

	test("aborts a running subagent and leaves an aborted tombstone", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(true);

		expect(calls).toEqual(["abort:SubagentA", "dispose:SubagentA"]);
		const ref = AgentRegistry.global().get("SubagentA");
		expect(ref?.status).toBe("aborted");
		expect(ref?.session).toBeNull();
	});

	test("does not touch another session's same-name subagent", async () => {
		// This session's roster lists SubagentA, but the process-global registry
		// now holds a different session's agent under the same id.
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("running");
	});

	test("does not let the run's result be accepted while the abort settles", async () => {
		emitLifecycle("SubagentA", "started");
		let acceptedDuringAbort: boolean | undefined;
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: {
				// The executor may accept a yield that lands while the abort is in flight.
				abort: async () => {
					acceptedDuringAbort = AgentRegistry.global().markResultAccepted("SubagentA");
				},
				dispose: async () => {},
			} as never,
			sessionFile: ownSessionFile,
			status: "running",
		});

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(true);

		expect(acceptedDuringAbort).toBe(false);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("aborted");
	});

	test("reports a failed tombstone write as an error while the abort is still settling", async () => {
		// The tombstone sidecar lands next to the transcript; a missing directory
		// makes the write fail with ENOENT. release() disposes the session after
		// that failure and then rejects, so the abort stays pending until dispose
		// ran plus one macrotask hop: the release rejection lands mid-abort.
		const missingDirSessionFile = path.join(sessionDir, "missing", "SubagentA.jsonl");
		emitLifecycle("SubagentA", "started", missingDirSessionFile);
		const disposed = Promise.withResolvers<void>();
		const nextMacrotask = () => new Promise<void>(resolve => setImmediate(resolve));
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: {
				abort: async () => {
					await disposed.promise;
					await nextMacrotask();
					calls.push("abort:SubagentA");
				},
				dispose: async () => {
					calls.push("dispose:SubagentA");
					disposed.resolve();
				},
			} as never,
			sessionFile: missingDirSessionFile,
			status: "running",
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(handleRpcCancelSubagent(registry, "SubagentA")).rejects.toMatchObject({ code: "ENOENT" });
			await nextMacrotask();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
		expect(calls).toEqual(["dispose:SubagentA", "abort:SubagentA"]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("aborted");
	});

	test("is a no-op for a second cancel of the same subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		await handleRpcCancelSubagent(registry, "SubagentA");
		calls = [];

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	test("does not tombstone a subagent whose result was accepted before its terminal frame", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		// Yield acceptance flips the ref to idle while the roster still lists it.
		AgentRegistry.global().markResultAccepted("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("idle");
	});

	test("does not touch a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcCancelSubagent(registry, "Stranger")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("Stranger")?.status).toBe("running");
	});

	test("does not touch a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	test("settles a foreground nested task run as aborted and emits the aborted lifecycle frame", async () => {
		const id = "Worker.Child";
		const artifactsDir = sessionDir;
		const promptEntered = Promise.withResolvers<void>();
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		// Minimal session whose turn never finishes on its own: only a cancel can end the run.
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			model: undefined,
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			getToolByName: () => undefined,
			setActiveToolsByName: async () => {},
			setWorkPoolYieldItems: () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			prompt: async () => {
				promptEntered.resolve();
				await Promise.withResolvers<never>().promise;
			},
			waitForIdle: async () => {},
			isAdvisorActive: () => false,
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			getLastAssistantMessage: () => undefined,
			hasPendingAsyncWork: () => false,
			getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
			settleAsyncWork: async () => {},
			abort: async () => {},
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
			trackIrcReply: () => {},
			subscribeRunState: () => () => {},
			addDisposer: () => {},
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: path.join(artifactsDir, `${id}.jsonl`),
			status: "running",
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		registry.setSubscriptionLevel("progress");
		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

		// Foreground: awaited directly, with no async job behind it.
		const run = runSubprocess({ cwd: artifactsDir, agent, task: "work", index: 0, id, eventBus, artifactsDir });
		await promptEntered.promise;

		await expect(handleRpcCancelSubagent(registry, id)).resolves.toBe(true);

		const result = await run;
		expect(result.aborted).toBe(true);
		expect(frames.filter(frame => frame.type === "subagent_lifecycle").map(frame => frame.payload.status)).toEqual([
			"started",
			"aborted",
		]);
		expect(registry.getSubagents()).toEqual([]);
	});
});
