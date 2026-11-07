import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentsApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";

async function loadAgentsApi(cwd: string, agentId: string = MAIN_AGENT_ID): Promise<ExtensionAgentsApi> {
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
			getAgentRegistry: () => AgentRegistry.global(),
			sessionManager: { getSessionFile: () => undefined },
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

describe("ExtensionAPI agents", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
		const agentsA = await loadAgentsApi(cwd, "SessionA");
		const agentsB = await loadAgentsApi(cwd, "SessionB");
		const registry = AgentRegistry.global();

		const fileA = path.join(cwd, "ChildA.jsonl");
		const fileB = path.join(cwd, "ChildB.jsonl");
		await Bun.write(fileA, "");
		await Bun.write(fileB, "");
		registry.register({
			id: "ChildA",
			displayName: "Child A",
			kind: "sub",
			parentId: "SessionA",
			session: null,
			sessionFile: fileA,
			status: "parked",
		});
		registry.register({
			id: "ChildB",
			displayName: "Child B",
			kind: "sub",
			parentId: "SessionB",
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
		expect(registry.get("ChildB")?.status).toBe("parked");
	});

	it("a grandchild of the scoped agent is visible, an unrelated session's descendant is not", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-family-");
		const cwd = tempDir.path();
		const agents = await loadAgentsApi(cwd, "SessionA");
		const registry = AgentRegistry.global();
		for (const [id, parentId] of [
			["Child", "SessionA"],
			["Grandchild", "Child"],
			["Foreign", "SessionB"],
		] as const) {
			const sessionFile = path.join(cwd, `${id}.jsonl`);
			await Bun.write(sessionFile, "");
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId,
				session: null,
				sessionFile,
				status: "parked",
			});
		}

		expect(
			agents
				.list()
				.map(ref => ref.id)
				.sort(),
		).toEqual(["Child", "Grandchild"]);
		expect(agents.get("Grandchild")).toBeDefined();
		expect(agents.get("Foreign")).toBeUndefined();
	});
});

/**
 * The same surface over real {@link createAgentSession} sessions, where the
 * registry the caller injected and the owning session's lifetime are real
 * rather than stubbed.
 */
describe("ExtensionAPI agents ownership", () => {
	const tempDirs: string[] = [];
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	function makeRoot(label: string): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `omp-ext-agents-${label}-${Snowflake.next()}-`));
		tempDirs.push(root);
		return root;
	}

	interface StartedSession {
		session: AgentSession;
		agents: ExtensionAgentsApi;
		sessionFile: string;
	}

	/** A real session whose single inline extension captures its `pi.agents`. */
	async function startSession(options: {
		root: string;
		name: string;
		agentId?: string;
		parentAgentId?: string;
		agentRegistry?: AgentRegistryApi;
	}): Promise<StartedSession> {
		const cwd = path.join(options.root, options.name);
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, path.join(options.root, `${options.name}-sessions`));
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		let agents: ExtensionAgentsApi | undefined;
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(options.root, `${options.name}-agent`),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sessionManager,
			agentRegistry: options.agentRegistry,
			agentId: options.agentId ?? MAIN_AGENT_ID,
			parentAgentId: options.parentAgentId,
			taskDepth: options.parentAgentId === undefined ? undefined : 1,
			extensions: [
				api => {
					agents = api.agents;
				},
			],
		});
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
		});
		if (!agents) throw new Error("Extension factory did not receive api.agents");
		return { session, agents, sessionFile };
	}

	it("addresses the registry the session was created with, not the process-global one", async () => {
		const root = makeRoot("injected-registry");
		const ownRegistry = new AgentRegistry();
		const global = await startSession({ root, name: "global" });
		const injected = await startSession({ root, name: "injected", agentRegistry: ownRegistry });
		try {
			// Each session registered its own `Main` in its own registry, and the
			// process-global one additionally carries a child the injected registry
			// has never heard of.
			AgentRegistry.global().register({
				id: "GlobalChild",
				displayName: "Global Child",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: null,
				sessionFile: path.join(root, "GlobalChild.jsonl"),
				status: "parked",
			});
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(global.session);
			expect(ownRegistry.get(MAIN_AGENT_ID)?.session).toBe(injected.session);

			const globalPrompt = spyOn(global.session, "prompt").mockResolvedValue(true);
			const injectedPrompt = spyOn(injected.session, "prompt").mockResolvedValue(true);

			expect(injected.agents.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
			expect(injected.agents.get(MAIN_AGENT_ID)?.sessionFile).toBe(injected.sessionFile);
			expect(injected.agents.get("GlobalChild")).toBeUndefined();
			expect((await injected.agents.ensureLive(MAIN_AGENT_ID)).sessionFile).toBe(injected.sessionFile);

			await injected.agents.prompt(MAIN_AGENT_ID, "work on your own transcript");
			expect(injectedPrompt).toHaveBeenCalledTimes(1);
			expect(globalPrompt).not.toHaveBeenCalled();
		} finally {
			await injected.session.dispose();
			await global.session.dispose();
		}
	});

	it("a disposed session's retained handle never reaches the agent that replaced it", async () => {
		const root = makeRoot("disposed-owner");
		const first = await startSession({ root, name: "first" });
		const firstGeneration = AgentRegistry.global().get(MAIN_AGENT_ID)?.generation;
		await first.session.dispose();
		expect(first.session.isDisposed).toBe(true);
		expect(AgentRegistry.global().get(MAIN_AGENT_ID)).toBeUndefined();
		// The owner's own ref is already gone, so the dead handle is refused on the
		// owning session's state alone, before any replacement exists to confuse it.
		expect(() => first.agents.list()).toThrow(/no longer live/);
		await expect(first.agents.prompt(MAIN_AGENT_ID, "keep going")).rejects.toThrow(/no longer live/);
		const second = await startSession({ root, name: "second" });
		try {
			const secondGeneration = AgentRegistry.global().get(MAIN_AGENT_ID)?.generation;
			expect(secondGeneration).toBeGreaterThan(firstGeneration ?? 0);
			const secondPrompt = spyOn(second.session, "prompt").mockResolvedValue(true);

			expect(() => first.agents.list()).toThrow(/no longer live/);
			expect(() => first.agents.get(MAIN_AGENT_ID)).toThrow(/no longer live/);
			await expect(first.agents.ensureLive(MAIN_AGENT_ID)).rejects.toThrow(/no longer live/);
			await expect(first.agents.prompt(MAIN_AGENT_ID, "keep going")).rejects.toThrow(/no longer live/);
			expect(secondPrompt).not.toHaveBeenCalled();

			// The replacement's own handle still works.
			expect(second.agents.get(MAIN_AGENT_ID)?.sessionFile).toBe(second.sessionFile);
		} finally {
			await second.session.dispose();
		}
	});

	it("a live session whose agent id another session took over addresses nothing", async () => {
		const root = makeRoot("id-takeover");
		// Two concurrent top-level sessions on one registry, both defaulting to
		// the `Main` id: the later registration replaces the earlier ref.
		const earlier = await startSession({ root, name: "earlier" });
		const later = await startSession({ root, name: "later" });
		try {
			expect(earlier.session.isDisposed).toBe(false);
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(later.session);
			const laterPrompt = spyOn(later.session, "prompt").mockResolvedValue(true);

			expect(() => earlier.agents.list()).toThrow(/belongs to a different session/);
			await expect(earlier.agents.prompt(MAIN_AGENT_ID, "keep going")).rejects.toThrow(
				/belongs to a different session/,
			);
			expect(laterPrompt).not.toHaveBeenCalled();

			expect(later.agents.get(MAIN_AGENT_ID)?.sessionFile).toBe(later.sessionFile);
		} finally {
			await later.session.dispose();
			await earlier.session.dispose();
		}
	});

	/**
	 * `ensureLive` and `prompt` yield before they project or deliver, and
	 * `AgentRegistry.register` replaces whatever ref holds an id. Each test here
	 * uses that ordinary public operation inside the yield, and each starts from
	 * a positive control proving the same call reaches the real child first.
	 */
	async function startFamily(label: string): Promise<{
		registry: AgentRegistry;
		owner: StartedSession;
		target: StartedSession;
		root: string;
	}> {
		const root = makeRoot(label);
		const registry = new AgentRegistry();
		const owner = await startSession({ root, name: "owner", agentRegistry: registry });
		const target = await startSession({
			root,
			name: "target",
			agentId: "Child",
			parentAgentId: MAIN_AGENT_ID,
			agentRegistry: registry,
		});
		return { registry, owner, target, root };
	}

	it("ensureLive never projects a replacement registered under another owner mid-call", async () => {
		const { registry, owner, target, root } = await startFamily("ensure-live-foreign");
		try {
			expect((await owner.agents.ensureLive("Child")).sessionFile).toBe(target.sessionFile);

			const pending = owner.agents.ensureLive("Child");
			const foreignFile = path.join(root, "foreign.jsonl");
			registry.register({
				id: "Child",
				displayName: "Foreign",
				kind: "sub",
				parentId: "OtherOwner",
				session: null,
				sessionFile: foreignFile,
				status: "parked",
			});

			await expect(pending).rejects.toThrow(/not visible to this session/);
			expect(registry.get("Child")?.sessionFile).toBe(foreignFile);
		} finally {
			await target.session.dispose();
			await owner.session.dispose();
		}
	});

	it("ensureLive never projects a same-parent replacement that is a different session", async () => {
		const { registry, owner, target, root } = await startFamily("ensure-live-sibling");
		try {
			expect((await owner.agents.ensureLive("Child")).sessionFile).toBe(target.sessionFile);

			const pending = owner.agents.ensureLive("Child");
			const replacementFile = path.join(root, "replacement.jsonl");
			// Still inside the owner's family, so visibility alone cannot catch it:
			// only the handle the revival returned distinguishes the two.
			registry.register({
				id: "Child",
				displayName: "Replacement",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: sessionStub(),
				sessionFile: replacementFile,
				status: "idle",
			});

			await expect(pending).rejects.toThrow(/was replaced while it was being revived/);
		} finally {
			await target.session.dispose();
			await owner.session.dispose();
		}
	});

	it("prompt delivers nothing once its owner is disposed during the revival await", async () => {
		const { owner, target } = await startFamily("prompt-disposal");
		try {
			const delivered = spyOn(target.session, "prompt").mockResolvedValue(true);
			await owner.agents.prompt("Child", "before disposal");
			expect(delivered).toHaveBeenCalledTimes(1);

			const pending = owner.agents.prompt("Child", "after disposal");
			const closing = owner.session.dispose();
			await expect(pending).rejects.toThrow(/no longer live/);
			await closing;

			expect(delivered).toHaveBeenCalledTimes(1);
		} finally {
			await target.session.dispose();
			await owner.session.dispose();
		}
	});
});
