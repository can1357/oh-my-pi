import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionAgentsApi,
	ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	createExtensionAgentActions,
	type ExtensionAgentActionsScope,
	initializeExtensions,
} from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

async function loadAgentsApi(
	cwd: string,
	agentId: string = MAIN_AGENT_ID,
	sessionFile?: string,
): Promise<ExtensionAgentsApi> {
	let agents: ExtensionAgentsApi | undefined;
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		api => {
			agents = api.agents;
		},
		cwd,
		new EventBus(),
		runtime,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(authStorage),
	);

	await initializeExtensions(
		{
			extensionRunner: runner,
			discoverStartupSkillPaths: async () => {},
			getAgentId: () => agentId,
			sessionManager: { getSessionFile: () => sessionFile },
		} as unknown as AgentSession,
		{
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
		},
	);
	if (!agents) throw new Error("Extension factory did not receive api.agents");
	return agents;
}

/**
 * Wires `api.agents` exactly as `acp-agent.ts` does — directly through
 * `ExtensionRunner.initialize`, not the `initializeExtensions` helper that
 * only non-ACP hosts use — so a `reviverFactory`/`idleTtlMs` override can be
 * supplied per session, mirroring an ACP host that cannot install one
 * process-global persisted-subagent reviver factory.
 */
async function loadAgentsApiAcpStyle(cwd: string, scope: ExtensionAgentActionsScope): Promise<ExtensionAgentsApi> {
	let agents: ExtensionAgentsApi | undefined;
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		api => {
			agents = api.agents;
		},
		cwd,
		new EventBus(),
		runtime,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(authStorage),
	);

	const actions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		...createExtensionAgentActions(scope),
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	};
	runner.initialize(actions, contextActions);
	if (!agents) throw new Error("Extension factory did not receive api.agents");
	return agents;
}

function sessionStub(
	options: { onPrompt?: (text: string, deliverAs: "steer" | "followUp") => void } = {},
): AgentSession {
	return {
		dispose: async () => {},
		prompt: async (text: string, promptOptions: { streamingBehavior: "steer" | "followUp" }) => {
			options.onPrompt?.(text, promptOptions.streamingBehavior);
		},
	} as unknown as AgentSession;
}

function persistedWorkerTranscript(): string {
	return [
		JSON.stringify({ type: "session", id: "session", parentId: null, timestamp: "2026-08-24T00:00:00.000Z" }),
		JSON.stringify({
			type: "session_init",
			id: "init",
			parentId: "session",
			timestamp: "2026-08-24T00:00:01.000Z",
			agent: "task",
			task: "persisted task",
		}),
	].join("\n");
}

describe("ExtensionAPI agents", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		MCPManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("agents.list exposes registry refs and ensureLive revives a parked agent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const registry = AgentRegistry.global();
		const sessionFile = path.join(tempDir.path(), "Worker1.jsonl");
		await Bun.write(sessionFile, "");
		const revived = sessionStub();
		registry.register({
			id: "Worker1",
			displayName: "Worker 1",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("Worker1", { idleTtlMs: 0, revive: async () => revived });

		expect(agents.list()).toEqual([{ id: "Worker1", status: "parked", kind: "sub", sessionFile }]);
		expect(agents.get("Worker1")).toEqual({ id: "Worker1", status: "parked", kind: "sub", sessionFile });

		expect(await agents.ensureLive("Worker1")).toEqual({ id: "Worker1", status: "idle", kind: "sub", sessionFile });
		expect(registry.get("Worker1")?.status).toBe("idle");
	});

	it("ensureLive rescans a parent transcript when its registry ref is absent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const parentSessionFile = path.join(tempDir.path(), "main.jsonl");
		const agents = await loadAgentsApi(tempDir.path(), MAIN_AGENT_ID, parentSessionFile);
		const sessionFile = path.join(tempDir.path(), "main", "Rescanned.jsonl");
		await Bun.write(parentSessionFile, "");
		await Bun.write(sessionFile, `${persistedWorkerTranscript()}\n`);
		const revived = sessionStub();
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async ref => {
			return ref.id === "Rescanned" ? async () => revived : undefined;
		}, 0);

		expect(await agents.ensureLive("Rescanned", { parentSessionFile })).toEqual({
			id: "Rescanned",
			status: "idle",
			kind: "sub",
			sessionFile,
		});
		expect(AgentRegistry.global().get("Rescanned")?.status).toBe("idle");
	});

	it("prompt delivers a follow-up turn to a revived agent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const registry = AgentRegistry.global();
		const sessionFile = path.join(tempDir.path(), "Worker2.jsonl");
		await Bun.write(sessionFile, "");
		let delivered: { text: string; deliverAs: "steer" | "followUp" } | undefined;
		const revived = sessionStub({
			onPrompt: (text, deliverAs) => {
				delivered = { text, deliverAs };
			},
		});
		registry.register({
			id: "Worker2",
			displayName: "Worker 2",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("Worker2", { idleTtlMs: 0, revive: async () => revived });

		await agents.prompt("Worker2", "continue from the saved transcript", { deliverAs: "followUp" });

		expect(delivered).toEqual({ text: "continue from the saved transcript", deliverAs: "followUp" });
		expect(registry.get("Worker2")?.status).toBe("idle");
	});

	it("scopes agents.list/get/ensureLive/prompt to the calling session's own family", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-scope-");
		const cwd = tempDir.path();
		const agentsA = await loadAgentsApi(cwd, "AcpSessionA");
		const agentsB = await loadAgentsApi(cwd, "AcpSessionB");
		const registry = AgentRegistry.global();

		const fileA = path.join(cwd, "ChildA.jsonl");
		const fileB = path.join(cwd, "ChildB.jsonl");
		await Bun.write(fileA, "");
		await Bun.write(fileB, "");
		registry.register({
			id: "ChildA",
			displayName: "Child A",
			kind: "sub",
			parentId: "AcpSessionA",
			session: null,
			sessionFile: fileA,
			status: "parked",
		});
		registry.register({
			id: "ChildB",
			displayName: "Child B",
			kind: "sub",
			parentId: "AcpSessionB",
			session: null,
			sessionFile: fileB,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("ChildA", { idleTtlMs: 0, revive: async () => sessionStub() });
		AgentLifecycleManager.global().adopt("ChildB", { idleTtlMs: 0, revive: async () => sessionStub() });

		expect(agentsA.list().map(ref => ref.id)).toEqual(["ChildA"]);
		expect(agentsB.list().map(ref => ref.id)).toEqual(["ChildB"]);
		expect(agentsA.get("ChildA")).toBeDefined();
		expect(agentsA.get("ChildB")).toBeUndefined();
		expect(agentsB.get("ChildA")).toBeUndefined();

		await expect(agentsA.ensureLive("ChildB")).rejects.toThrow(/not visible to this session/);
		await expect(agentsA.prompt("ChildB", "hi")).rejects.toThrow(/not visible to this session/);
		await expect(agentsB.ensureLive("ChildA")).rejects.toThrow(/not visible to this session/);

		expect(await agentsA.ensureLive("ChildA")).toMatchObject({ id: "ChildA", status: "idle" });
	});

	it("refuses ensureLive's rescan when parentSessionFile belongs to another session, keeping the foreign agent invisible", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-foreign-scan-");
		const cwd = tempDir.path();
		const parentFileA = path.join(cwd, "mainA.jsonl");
		const parentFileB = path.join(cwd, "mainB.jsonl");
		const childFileB = path.join(cwd, "mainB", "Secret.jsonl");
		await Bun.write(parentFileA, "");
		await Bun.write(parentFileB, "");
		await Bun.write(childFileB, `${persistedWorkerTranscript()}\n`);
		// A's own transcript is parentFileA; it never owns parentFileB.
		const agentsA = await loadAgentsApi(cwd, "AcpSessionA", parentFileA);
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async () => async () => sessionStub(), 0);

		// A points the rescan at B's transcript — a foreign path handed to a
		// compromised/buggy extension, or a stale path left over from a session
		// transition. Before the fix this scan ran unconditionally, attributed
		// B's persisted child to A's own `scopeAgentId`, and revived it.
		await expect(agentsA.ensureLive("Secret", { parentSessionFile: parentFileB })).rejects.toThrow(
			/not visible to this session/,
		);

		// The scan must never have run at all: no ref for "Secret" exists under
		// either the bare id or a disambiguated key, and A's own family stays empty.
		expect(AgentRegistry.global().get("Secret")).toBeUndefined();
		expect(agentsA.list()).toEqual([]);
	});

	it("ACP-safe reviver cold-revives a genuinely parked agent through a session-scoped persisted reviver", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-cold-");
		const cwd = tempDir.path();
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);

		// Real, on-disk parent + child transcripts — exactly what a live spawn
		// leaves behind — not an in-memory `revive: async () => stub` shortcut.
		const parentManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("Expected a persisted parent session file");
		await parentManager.close();
		const childManager = SessionManager.create(cwd, parentFile.slice(0, -6));
		const childFile = childManager.getSessionFile();
		if (!childFile) throw new Error("Expected a persisted child session file");
		childManager.appendSessionInit({
			systemPrompt: "persisted child prompt",
			task: "persisted child task",
			tools: ["read", "yield"],
		});
		childManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "persisted" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await childManager.close();
		const childId = path.basename(childFile, ".jsonl");

		const parentSessionStub = {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			get sessionFile() {
				return parentFile;
			},
		} as unknown as AgentSession;
		const reviverFactory = createPersistedSubagentReviverFactory({
			session: parentSessionStub,
			authStorage: {} as never,
			modelRegistry: { authStorage: {} } as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: true,
		});

		const revivedSession = {
			getAgentId: () => childId,
			getMountedXdevToolNames: () => [],
			setActiveToolsByName: async () => {},
			subscribe: () => () => {},
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			getLastAssistantMessage: () => undefined,
			extensionRunner: undefined,
		} as unknown as AgentSession;
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockImplementation(async () => ({ session: revivedSession }) as CreateAgentSessionResult);

		// Mirrors the ACP fix: bypass the process-global reviver-factory slot
		// entirely (which ACP never installs — see acp-agent.ts) with a
		// reviver scoped to just this call.
		const agents = await loadAgentsApiAcpStyle(cwd, {
			scopeAgentId: "AcpSessionA",
			scopeSessionFile: parentFile,
			reviverFactory,
			idleTtlMs: 0,
		});

		expect(AgentRegistry.global().get(childId)).toBeUndefined();

		const revivedRef = await agents.ensureLive(childId, { parentSessionFile: parentFile });

		expect(revivedRef).toEqual({ id: childId, status: "idle", kind: "sub", sessionFile: childFile });
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get(childId)?.status).toBe("idle");
		expect(AgentRegistry.global().get(childId)?.session).toBe(revivedSession);
	});

	it("resolves a bare persisted id that collides with an unrelated session's same-named agent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-collision-");
		const cwd = tempDir.path();
		const parentFileA = path.join(cwd, "mainA.jsonl");
		const childFileA = path.join(cwd, "mainA", "Worker.jsonl");
		const parentFileB = path.join(cwd, "mainB.jsonl");
		const childFileB = path.join(cwd, "mainB", "Worker.jsonl");
		await Bun.write(parentFileA, "");
		await Bun.write(childFileA, `${persistedWorkerTranscript()}\n`);
		await Bun.write(parentFileB, "");
		await Bun.write(childFileB, `${persistedWorkerTranscript()}\n`);
		const agentsA = await loadAgentsApi(cwd, "AcpSessionA", parentFileA);
		const agentsB = await loadAgentsApi(cwd, "AcpSessionB", parentFileB);
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async () => async () => sessionStub(), 0);

		const revivedA = await agentsA.ensureLive("Worker", { parentSessionFile: parentFileA });
		expect(revivedA).toEqual({ id: "Worker", status: "idle", kind: "sub", sessionFile: childFileA });

		// B's own "Worker" is a distinct, unrelated agent that happens to share
		// A's bare filename (`AgentRegistry` is a flat, process-global map, but
		// a subagent id is only unique within its owning session's own tree).
		// Before the fix this either never got scanned — the unscoped
		// `registry.get(id)` guard saw A's entry and skipped — or, once
		// scanned, silently failed to register under the id A already holds.
		const revivedB = await agentsB.ensureLive("Worker", { parentSessionFile: parentFileB });
		expect(revivedB.sessionFile).toBe(childFileB);
		expect(revivedB.id).not.toBe(revivedA.id);
		expect(revivedB.status).toBe("idle");

		// Neither session can see or clobber the other's "Worker".
		expect(agentsA.get("Worker")).toMatchObject({ sessionFile: childFileA });
		expect(agentsB.get("Worker")).toMatchObject({ sessionFile: childFileB });
		expect(agentsA.list().map(ref => ref.sessionFile)).toEqual([childFileA]);
		expect(agentsB.list().map(ref => ref.sessionFile)).toEqual([childFileB]);
		expect(AgentRegistry.global().get("Worker")?.sessionFile).toBe(childFileA);
	});

	it("propagates the ACP-safe reviver into a cold-revived subagent's own extension runtime so its persisted children stay cold-revivable", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-nested-cold-");
		const cwd = tempDir.path();
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);

		const assistantMessage = {
			role: "assistant" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			content: [{ type: "text" as const, text: "persisted" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages" as const,
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		// Top-level session → persisted child B → persisted grandchild C, all on
		// disk exactly as a live spawn tree would leave behind.
		const topManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const topFile = topManager.getSessionFile();
		if (!topFile) throw new Error("Expected a persisted top-level session file");
		await topManager.close();

		const bManager = SessionManager.create(cwd, topFile.slice(0, -6));
		const bFile = bManager.getSessionFile();
		if (!bFile) throw new Error("Expected a persisted child (B) session file");
		bManager.appendSessionInit({ systemPrompt: "B prompt", task: "B task", tools: ["read", "yield"] });
		bManager.appendMessage(assistantMessage);
		await bManager.close();
		const bId = path.basename(bFile, ".jsonl");

		const cManager = SessionManager.create(cwd, bFile.slice(0, -6));
		const cFile = cManager.getSessionFile();
		if (!cFile) throw new Error("Expected a persisted grandchild (C) session file");
		cManager.appendSessionInit({ systemPrompt: "C prompt", task: "C task", tools: ["read", "yield"] });
		cManager.appendMessage(assistantMessage);
		await cManager.close();
		const cId = path.basename(cFile, ".jsonl");

		const topSessionStub = {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			get sessionFile() {
				return topFile;
			},
		} as unknown as AgentSession;
		const reviverFactory = createPersistedSubagentReviverFactory({
			session: topSessionStub,
			authStorage: {} as never,
			modelRegistry: { authStorage: {} } as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: true,
		});

		// Real extension runtime for B's revived session — `initializeExtensions`
		// early-returns without an `extensionRunner`, which would hide the bug.
		let bAgents: ExtensionAgentsApi | undefined;
		const bRuntime = new ExtensionRuntime();
		const bExtension = await loadExtensionFromFactory(
			api => {
				bAgents = api.agents;
			},
			cwd,
			new EventBus(),
			bRuntime,
		);
		const bAuthStorage = await AuthStorage.create(":memory:");
		const bExtensionRunner = new ExtensionRunner(
			[bExtension],
			bRuntime,
			cwd,
			SessionManager.inMemory(cwd),
			new ModelRegistry(bAuthStorage),
		);
		const revivedBSession = {
			getAgentId: () => bId,
			getMountedXdevToolNames: () => [],
			setActiveToolsByName: async () => {},
			subscribe: () => () => {},
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			getLastAssistantMessage: () => undefined,
			extensionRunner: bExtensionRunner,
			sessionManager: { getSessionFile: () => bFile },
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === bId) return { session: revivedBSession } as CreateAgentSessionResult;
			// Grandchild C needs no extension capture of its own to prove the
			// fix: a stub without a real `ExtensionRunner` just confirms B's own
			// `ensureLive(cId, …)` reached `AgentLifecycleManager` and revived
			// successfully instead of throwing "no reviver registered".
			return {
				session: {
					getAgentId: () => options.agentId,
					getMountedXdevToolNames: () => [],
					setActiveToolsByName: async () => {},
					subscribe: () => () => {},
					setIrcWakeTurnObserver: () => {},
					subscribeRunState: () => () => {},
					getLastAssistantMessage: () => undefined,
					extensionRunner: undefined,
				} as unknown as AgentSession,
			} as CreateAgentSessionResult;
		});

		// Mirrors ACP exactly: no process-global `PersistedSubagentReviverFactory`
		// is ever installed (main.ts installs one only for non-ACP hosts) — B can
		// only cold-revive through the reviver scoped to `topAgents`.
		const topAgents = await loadAgentsApiAcpStyle(cwd, {
			scopeAgentId: "AcpTop",
			scopeSessionFile: topFile,
			reviverFactory,
			idleTtlMs: 0,
		});

		const bRef = await topAgents.ensureLive(bId, { parentSessionFile: topFile });
		expect(bRef).toMatchObject({ id: bId, status: "idle", sessionFile: bFile });
		if (!bAgents) throw new Error("Extension factory did not receive api.agents for the revived subagent");

		// The real assertion: B's OWN `api.agents.ensureLive` can cold-revive its
		// persisted grandchild C without any process-global reviver factory —
		// only reachable if `initializeExtensions` carried the scoped factory
		// through to B's own extension runtime.
		const cRef = await bAgents.ensureLive(cId, { parentSessionFile: bFile });
		expect(cRef).toMatchObject({ id: cId, status: "idle", sessionFile: cFile });
	});
});
