import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentInfo, ExtensionAgentsApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
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

describe("ExtensionAPI agents", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("projects a registry ref as a detached snapshot, not the live ref", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const registry = AgentRegistry.global();
		const sessionFile = path.join(tempDir.path(), "Worker1.jsonl");
		await Bun.write(sessionFile, "");
		registry.register({
			id: "Worker1",
			displayName: "Worker 1",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});

		const snapshot: ExtensionAgentInfo = { id: "Worker1", status: "parked", kind: "sub", sessionFile };
		expect(agents.list()).toEqual([snapshot]);
		expect(agents.get("Worker1")).toEqual(snapshot);

		// Mutating what an extension was handed must not reach registry state.
		const projected = agents.get("Worker1");
		if (!projected) throw new Error("Expected a projection for Worker1");
		projected.status = "running";
		expect(registry.get("Worker1")?.status).toBe("parked");
		expect(agents.get("Worker1")?.status).toBe("parked");
	});

	it("scopes agents.list/get to the calling session's own family", async () => {
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

		expect(agentsA.list().map(ref => ref.id)).toEqual(["ChildA"]);
		expect(agentsB.list().map(ref => ref.id)).toEqual(["ChildB"]);
		expect(agentsA.get("ChildA")).toBeDefined();
		expect(agentsA.get("ChildB")).toBeUndefined();
		expect(agentsB.get("ChildA")).toBeUndefined();
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
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

			expect(injected.agents.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
			expect(injected.agents.get(MAIN_AGENT_ID)?.sessionFile).toBe(injected.sessionFile);
			expect(injected.agents.get("GlobalChild")).toBeUndefined();

			// The process-global session still sees its own registry's child.
			expect(global.agents.get("GlobalChild")?.status).toBe("parked");
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
		const second = await startSession({ root, name: "second" });
		try {
			const secondGeneration = AgentRegistry.global().get(MAIN_AGENT_ID)?.generation;
			expect(secondGeneration).toBeGreaterThan(firstGeneration ?? 0);

			expect(() => first.agents.list()).toThrow(/no longer live/);
			expect(() => first.agents.get(MAIN_AGENT_ID)).toThrow(/no longer live/);

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

			expect(() => earlier.agents.list()).toThrow(/belongs to a different session/);
			expect(() => earlier.agents.get(MAIN_AGENT_ID)).toThrow(/belongs to a different session/);

			expect(later.agents.get(MAIN_AGENT_ID)?.sessionFile).toBe(later.sessionFile);
		} finally {
			await later.session.dispose();
			await earlier.session.dispose();
		}
	});
});
