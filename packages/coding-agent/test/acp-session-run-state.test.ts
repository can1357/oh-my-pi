/**
 * An ACP session's registry ref must report what the session is actually doing,
 * in whichever registry the session was registered into.
 *
 * `createAgentSession` registers and attaches every ref as `running`, and only
 * the task and revival paths mirror run state back onto it. An ACP session
 * therefore read `running` for its whole life, between prompts included, which
 * is stale to the roster, to `notifications/agent_registry`, and to anything
 * that keys polling off live work.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, InitializeRequest, NewSessionRequest } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterAll(() => {
	authStorage.close();
});

interface RunStateSession {
	session: AgentSession;
	/** Drives the run-state transitions a real prompt would emit. */
	notify: (state: "running" | "idle") => void;
	subscribed: () => boolean;
}

function runStateSessionStub(): RunStateSession {
	let listener: ((state: "running" | "idle") => void) | undefined;
	const session = {
		isStreaming: false,
		subscribeRunState: (next: (state: "running" | "idle") => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		registerSessionChangeCallback: () => () => {},
		registerSessionIdentityChangeCallback: () => () => {},
		subscribe: () => () => {},
		getAllToolNames: () => [],
		dispose: async () => {},
		sessionId: "stub-session",
		sessionManager: { ensureOnDisk: async () => {} },
		setClientBridge: () => {},
		refreshMCPTools: async () => {},
		getPlanModeState: () => undefined,
		settings: { get: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
		isAutoThinking: false,
		getAvailableModels: () => [],
		getAvailableThinkingLevels: () => [],
	} as unknown as AgentSession;
	return {
		session,
		notify: state => listener?.(state),
		subscribed: () => listener !== undefined,
	};
}

/** What `createAgentSession` leaves behind for every caller: registered, attached, `running`. */
function registerAsCreateAgentSessionWould(registry: AgentRegistry, id: string, session: AgentSession): void {
	registry.register({
		id,
		displayName: "acp",
		kind: "main",
		session,
		status: "running",
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runner: undefined,
		} as unknown as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: {
			emit: () => {},
			on: () => () => {},
			off: () => {},
		} as unknown as CreateAgentSessionResult["eventBus"],
	};
}

function acpConnectionStub(aborter: AbortController): AgentSideConnection {
	return {
		sessionUpdate: async () => {},
		extNotification: async () => {},
		signal: aborter.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;
}

describe("ACP session run state", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else setAgentDir(path.join(getConfigRootDir(), "agent"));
	});

	it("mirrors run-state transitions onto the session's registry ref", async () => {
		const tempDir = TempDir.createSync("@pi-acp-run-state-");
		try {
			const registry = AgentRegistry.global();
			const stub = runStateSessionStub();
			const factory = createAcpSessionFactory({
				baseOptions: {} as CreateAgentSessionOptions,
				settings: Settings.isolated({}),
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession: async (options: CreateAgentSessionOptions) => {
					registerAsCreateAgentSessionWould(registry, options.agentId ?? "unset", stub.session);
					return createSessionResult(stub.session);
				},
			});
			await factory(tempDir.path());

			const ids = registry.list().map(ref => ref.id);
			expect(ids).toHaveLength(1);
			const id = ids[0] ?? "";
			expect(id.startsWith("acp:")).toBe(true);
			// Nobody has prompted this session yet.
			expect(registry.get(id)?.status).toBe("idle");

			// And a prompt's edges land on the ref rather than leaving it stale.
			expect(stub.subscribed()).toBe(true);
			stub.notify("running");
			expect(registry.get(id)?.status).toBe("running");
			stub.notify("idle");
			expect(registry.get(id)?.status).toBe("idle");
		} finally {
			await tempDir.remove();
		}
	});

	it("corrects the ref in the embedder's own registry, not the global one", async () => {
		const tempDir = TempDir.createSync("@pi-acp-run-state-isolated-");
		try {
			const isolated = new AgentRegistry();
			const stub = runStateSessionStub();
			const factory = createAcpSessionFactory({
				baseOptions: { agentRegistry: isolated } as CreateAgentSessionOptions,
				settings: Settings.isolated({}),
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession: async (options: CreateAgentSessionOptions) => {
					// createAgentSession registers into the registry it was given.
					registerAsCreateAgentSessionWould(
						options.agentRegistry ?? AgentRegistry.global(),
						options.agentId ?? "unset",
						stub.session,
					);
					return createSessionResult(stub.session);
				},
			});
			await factory(tempDir.path());

			const id = isolated.list()[0]?.id ?? "";
			expect(id.startsWith("acp:")).toBe(true);
			expect(isolated.get(id)?.status).toBe("idle");
			stub.notify("running");
			expect(isolated.get(id)?.status).toBe("running");
			// The global registry never held this session and was never written to.
			expect(AgentRegistry.global().list()).toHaveLength(0);
		} finally {
			await tempDir.remove();
		}
	});

	it("corrects an adopted initial session when the ACP agent initializes", async () => {
		const tempDir = TempDir.createSync("@pi-acp-run-state-adopted-");
		const aborter = new AbortController();
		let agent: AcpAgent | undefined;
		try {
			setAgentDir(tempDir.join("agent"));
			const registry = new AgentRegistry();
			const stub = runStateSessionStub();
			// An SDK embedder hands its own session to createAcpConnection, so it
			// never passes through the ACP factory.
			registerAsCreateAgentSessionWould(registry, "acp:adopted", stub.session);
			agent = new AcpAgent(
				acpConnectionStub(aborter),
				async () => ({ session: stub.session, setToolUIContext: () => {} }),
				stub.session,
				registry,
			);

			await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as InitializeRequest);

			expect(registry.get("acp:adopted")?.status).toBe("idle");
			expect(stub.subscribed()).toBe(true);
			stub.notify("running");
			expect(registry.get("acp:adopted")?.status).toBe("running");
		} finally {
			aborter.abort();
			await agent?.dispose();
			await tempDir.remove();
		}
	});

	it("corrects a session an embedder's own factory returned", async () => {
		const tempDir = TempDir.createSync("@pi-acp-run-state-custom-factory-");
		const aborter = new AbortController();
		let agent: AcpAgent | undefined;
		try {
			setAgentDir(tempDir.join("agent"));
			const registry = new AgentRegistry();
			const stub = runStateSessionStub();
			agent = new AcpAgent(
				acpConnectionStub(aborter),
				// An embedder's own AcpSessionFactory, built on createAgentSession, so
				// the session arrives registered `running` having never seen the
				// bundled ACP factory.
				async () => {
					registerAsCreateAgentSessionWould(registry, "acp:from-embedder", stub.session);
					return { session: stub.session, setToolUIContext: () => {} };
				},
				undefined,
				registry,
			);
			await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as InitializeRequest);

			await agent.newSession({ cwd: tempDir.path(), mcpServers: [] } as NewSessionRequest);

			expect(registry.get("acp:from-embedder")?.status).toBe("idle");
			expect(stub.subscribed()).toBe(true);
			stub.notify("running");
			expect(registry.get("acp:from-embedder")?.status).toBe("running");
		} finally {
			// The bootstrap updates are deferred behind a timer that bails on an
			// aborted signal; without this they reach the session after the test.
			aborter.abort();
			await agent?.dispose();
			await tempDir.remove();
		}
	});
});
