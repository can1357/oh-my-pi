import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAgentInfo, ExtensionAgentsApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";

/**
 * `ExtensionAPI.agents` over real {@link createAgentSession} sessions, so the
 * registry the caller injected, the owning session's lifetime and the ref
 * proving it owns its agent id are all real rather than stubbed. A stubbed
 * session has no registered ref, which is exactly the state the ownership
 * guard must refuse — it would pass every projection assertion below without
 * the guard ever being exercised.
 */
describe("ExtensionAPI agents", () => {
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

	/** A parked registry row of the kind that outlives the session that spawned it. */
	async function registerParked(
		registry: AgentRegistryApi,
		root: string,
		id: string,
		parentId: string,
	): Promise<string> {
		const sessionFile = path.join(root, `${id}.jsonl`);
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
		return sessionFile;
	}

	interface CreatedSession {
		session: AgentSession;
		/** The `pi.agents` handle the session's inline extension was given. */
		agents: ExtensionAgentsApi;
		sessionFile: string;
	}

	interface SessionOptions {
		root: string;
		name: string;
		agentId?: string;
		parentAgentId?: string;
		agentRegistry?: AgentRegistryApi;
	}

	/**
	 * A real session whose single inline extension captures its `pi.agents`.
	 * The extension runner is left uninitialized so each host below can wire
	 * its own {@link ExtensionActions}.
	 */
	async function createSession(options: SessionOptions): Promise<CreatedSession> {
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
		if (!agents) throw new Error("Extension factory did not receive api.agents");
		return { session, agents, sessionFile };
	}

	/** {@link createSession} wired by the print/rpc host (`initializeExtensions`). */
	async function startSession(options: SessionOptions): Promise<CreatedSession> {
		const created = await createSession(options);
		await initializeExtensions(created.session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
		});
		return created;
	}

	it("projects a registry ref as a detached snapshot, not the live ref", async () => {
		const root = makeRoot("projection");
		const owner = await startSession({ root, name: "owner" });
		try {
			const registry = AgentRegistry.global();
			const sessionFile = await registerParked(registry, root, "Worker1", MAIN_AGENT_ID);

			const snapshot: ExtensionAgentInfo = { id: "Worker1", status: "parked", kind: "sub", sessionFile };
			expect(owner.agents.get("Worker1")).toEqual(snapshot);
			expect(owner.agents.list().find(ref => ref.id === "Worker1")).toEqual(snapshot);

			// Mutating what an extension was handed must not reach registry state.
			const projected = owner.agents.get("Worker1");
			if (!projected) throw new Error("Expected a projection for Worker1");
			projected.status = "running";
			expect(registry.get("Worker1")?.status).toBe("parked");
			expect(owner.agents.get("Worker1")?.status).toBe("parked");
		} finally {
			await owner.session.dispose();
		}
	});

	it("scopes agents.list/get to the calling session's own family", async () => {
		const root = makeRoot("scope");
		const a = await startSession({ root, name: "a", agentId: "SessionA" });
		const b = await startSession({ root, name: "b", agentId: "SessionB" });
		try {
			const registry = AgentRegistry.global();
			await registerParked(registry, root, "ChildA", "SessionA");
			await registerParked(registry, root, "ChildB", "SessionB");

			expect(
				a.agents
					.list()
					.map(ref => ref.id)
					.sort(),
			).toEqual(["ChildA", "SessionA"]);
			expect(
				b.agents
					.list()
					.map(ref => ref.id)
					.sort(),
			).toEqual(["ChildB", "SessionB"]);
			expect(a.agents.get("ChildA")).toBeDefined();
			expect(a.agents.get("ChildB")).toBeUndefined();
			expect(b.agents.get("ChildA")).toBeUndefined();
		} finally {
			await b.session.dispose();
			await a.session.dispose();
		}
	});

	it("a grandchild of the scoped agent is visible, an unrelated session's descendant is not", async () => {
		const root = makeRoot("family");
		const owner = await startSession({ root, name: "owner", agentId: "SessionA" });
		try {
			const registry = AgentRegistry.global();
			await registerParked(registry, root, "Child", "SessionA");
			await registerParked(registry, root, "Grandchild", "Child");
			await registerParked(registry, root, "Foreign", "SessionB");

			expect(
				owner.agents
					.list()
					.map(ref => ref.id)
					.sort(),
			).toEqual(["Child", "Grandchild", "SessionA"]);
			expect(owner.agents.get("Grandchild")).toBeDefined();
			expect(owner.agents.get("Foreign")).toBeUndefined();
		} finally {
			await owner.session.dispose();
		}
	});

	it("addresses the registry the session was created with, not the process-global one", async () => {
		const root = makeRoot("injected-registry");
		const ownRegistry = new AgentRegistry();
		const global = await startSession({ root, name: "global" });
		const injected = await startSession({ root, name: "injected", agentRegistry: ownRegistry });
		try {
			// Each session registered its own `Main` in its own registry, and the
			// process-global one additionally carries a child the injected registry
			// has never heard of.
			await registerParked(AgentRegistry.global(), root, "GlobalChild", MAIN_AGENT_ID);
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

	it("a live session whose own ref the registry no longer holds reaches no other session's agents", async () => {
		const root = makeRoot("vacated-owner");
		// Two concurrent top-level sessions on one registry, both on the `Main`
		// id, plus a parked child of `Main` of the kind that outlives its parent.
		const earlier = await startSession({ root, name: "earlier" });
		const later = await startSession({ root, name: "later" });
		await registerParked(AgentRegistry.global(), root, "LaterChild", MAIN_AGENT_ID);
		try {
			// `later` owns the `Main` ref; its teardown takes the ref with it
			// (sdk.ts `unregisterUnlessParked`) and spares the parked child.
			await later.session.dispose();
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)).toBeUndefined();
			expect(AgentRegistry.global().get("LaterChild")?.status).toBe("parked");

			// `earlier` is live and undisposed, so the disposal guard passes, but
			// the registry holds no ref proving it owns `Main`. It must be refused,
			// not handed every global ref whose parent chain reaches `Main`.
			expect(earlier.session.isDisposed).toBe(false);
			expect(() => earlier.agents.list()).toThrow(/no longer registered/);
			expect(() => earlier.agents.get("LaterChild")).toThrow(/no longer registered/);
		} finally {
			await earlier.session.dispose();
		}
	});

	it("the ACP host serves agents actions instead of an unsupported-action error", async () => {
		const root = makeRoot("acp-host");
		const created = await createSession({ root, name: "acp" });
		// Until a host wires `ExtensionActions.agentsList`/`agentsGet`, every call
		// lands on `throwUnsupportedAgentsAction` — and `ConcreteExtensionAPI.agents`
		// is always defined, so an unwired host is indistinguishable from a wired
		// one until that first call.

		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client: Client = {
			async requestPermission(): Promise<RequestPermissionResponse> {
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			},
			async sessionUpdate(_params: SessionNotification): Promise<void> {},
		};
		const clientConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const agentConnection = createAcpConnection(
			ndJsonStream(agentToClient.writable, clientToAgent.readable),
			async () => ({ session: created.session, setToolUIContext: () => {} }),
		);

		try {
			await clientConnection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			await clientConnection.newSession({ cwd: path.join(root, "acp"), mcpServers: [] });

			const childFile = await registerParked(AgentRegistry.global(), root, "AcpChild", MAIN_AGENT_ID);
			expect(created.agents.get("AcpChild")).toEqual({
				id: "AcpChild",
				status: "parked",
				kind: "sub",
				sessionFile: childFile,
			});
			expect(
				created.agents
					.list()
					.map(ref => ref.id)
					.sort(),
			).toEqual(["AcpChild", MAIN_AGENT_ID]);
		} finally {
			await closeTransport(clientToAgent.writable);
			await closeTransport(agentToClient.writable);
			await Promise.allSettled([clientConnection.closed, agentConnection.closed]);
			await created.session.dispose();
		}
	});
});

/**
 * Close one direction of the in-memory ACP transport. `ndJsonStream` acquires a
 * transient writer per message, so right after the final response resolves the
 * writer release is still a queued microtask; closing while it is held rejects
 * and leaves the peer's readable open.
 */
async function closeTransport(writable: WritableStream<unknown>): Promise<void> {
	for (let i = 0; i < 100 && writable.locked; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	await Promise.allSettled([writable.close()]);
}
