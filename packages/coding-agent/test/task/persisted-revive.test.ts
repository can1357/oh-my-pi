import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { buildWakeRelayBody } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function createRef(sessionFile: string): AgentRef {
	return {
		id: "persisted-restricted",
		displayName: "Persisted Restricted",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
	/** Reply obligations the wake monitor registered via `trackIrcReply`. */
	trackedReplies: Promise<void>[];
	/** Text the stubbed session reports as its last assistant message (a `stop`ped turn). */
	setLastAssistantText: (text: string) => void;
	/** Report a terminal wake turn: provider error, abort, or empty completion. */
	setLastAssistantStop: (stop: LastAssistantStop) => void;
}

/** Shape of a terminal assistant message the stub can report from a failed/cancelled wake turn. */
interface LastAssistantStop {
	stopReason: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	content?: Array<{ type: string; text?: string }>;
}

function createRevivedSession(activeToolNames: string[][], extensionRunner?: unknown): RevivedSessionHandle {
	let observer: IrcWakeObserver | undefined;
	let lastAssistant:
		| {
				role: "assistant";
				content: Array<{ type: string; text?: string }>;
				stopReason: string;
				errorMessage?: string;
				provider?: string;
				model?: string;
		  }
		| undefined;
	const trackedReplies: Promise<void>[] = [];
	const session = {
		...createSessionDefaults(),
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		trackIrcReply: (pending: Promise<void>) => {
			trackedReplies.push(pending);
		},
		subscribeRunState: () => () => {},
		getLastAssistantMessage: () => lastAssistant,
		extensionRunner,
	} as unknown as AgentSession;
	return {
		session,
		observer: () => observer,
		trackedReplies,
		setLastAssistantText: text => {
			lastAssistant = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
		},
		setLastAssistantStop: stop => {
			lastAssistant = {
				role: "assistant",
				content: stop.content ?? [],
				stopReason: stop.stopReason,
				errorMessage: stop.errorMessage,
				provider: stop.provider,
				model: stop.model,
			};
		},
	};
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	advisor?: string,
	contract?: {
		tools?: string[];
		readOnly?: boolean;
		agent?: string;
		isolated?: boolean;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
	},
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: contract?.tools ?? ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: modelRole ? "anthropic/claude-sonnet-4-5" : undefined,
		advisor,
		readOnly: contract?.readOnly,
		agent: contract?.agent,
		isolated: contract?.isolated,
		...(contract?.compactionThreshold !== undefined
			? { compactionThreshold: contract.compactionThreshold }
			: undefined),
	});
	manager.appendMessage({
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
	await manager.close();
	return sessionFile;
}

interface ReviveOwnerOptions {
	extensionRoots?: () => EffectiveExtensionRoots;
	preparedExtensions?: readonly PreparedExtension[];
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
}

function createFactory(cwd: string, eventBus?: EventBus, owner: ReviveOwnerOptions = {}) {
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		get sessionFile() {
			return path.join(cwd, "parent.jsonl");
		},
		get effectiveExtensionRoots() {
			return (
				owner.extensionRoots?.() ?? {
					explicit: [],
					mode: "merge",
					configured: [],
					configuredLevel: "user",
				}
			);
		},
		get preparedExtensions() {
			return owner.preparedExtensions;
		},
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: owner.authStorage ?? ({} as never),
		modelRegistry: owner.modelRegistry ?? ({ authStorage: {} } as ModelRegistry),
		settings: owner.settings ?? Settings.isolated(),
		enableLsp: true,
		eventBus,
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("initializes the extension runtime on cold revival so tool_call handlers are not fail-closed blocked", async () => {
		const cwd = makeTempDir("@pi-revive-ext-init-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		const initialize = vi.fn();
		const onError = vi.fn();
		const emit = vi.fn(async () => undefined);
		const extensionRunner = { initialize, onError, emit };
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createRevivedSession([], extensionRunner).session }) as CreateAgentSessionResult,
		);

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({ type: "session_start" });
	});

	it("loads only extensions allowed by the live owner's root policy", async () => {
		const cwd = makeTempDir("@pi-revive-owner-roots-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		const ownerExtension = path.join(cwd, "owner-extension.ts");
		const ambientExtension = path.join(cwd, "ambient-extension.ts");
		const blockedPath = path.join(cwd, "blocked.txt");
		const ambientMarker = path.join(cwd, "ambient-ran.txt");
		await Bun.write(blockedPath, "private fixture");
		await Bun.write(
			ownerExtension,
			`export default function (pi) { pi.on("tool_call", event => {
				if (event.toolName === "read" && event.input.path === ${JSON.stringify(blockedPath)})
					return { block: true, reason: "Owner policy denied the read" };
			}); }\n`,
		);
		await Bun.write(
			ambientExtension,
			`export default function (pi) { pi.on("session_start", () => Bun.write(${JSON.stringify(ambientMarker)}, "ran")); }\n`,
		);
		let extensionRoots: EffectiveExtensionRoots = {
			explicit: [ambientExtension],
			mode: "merge",
			configured: [],
			configuredLevel: "project",
		};
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		MCPManager.setInstance(new MCPManager(cwd));
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, {
			extensionRoots: () => extensionRoots,
			authStorage,
			modelRegistry,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		// The policy changes after the durable ref is discovered. Revival must
		// consult the live owner now, not retain an ambient/transcript snapshot.
		extensionRoots = {
			explicit: [ownerExtension],
			mode: "explicit-only",
			configured: [ambientExtension],
			configuredLevel: "project",
		};
		let revived: AgentSession | undefined;
		try {
			revived = await reviver(ref);
			const read = revived.getToolByName("read");
			if (!read) throw new Error("Missing revived read tool");
			await expect(read.execute("denied", { path: blockedPath })).rejects.toThrow("Owner policy denied the read");
			expect(await Bun.file(ambientMarker).exists()).toBe(false);
		} finally {
			await revived?.dispose();
			authStorage.close();
		}
	});

	it("rebinds owner policy hooks for restricted revival without widening its tools", async () => {
		const cwd = makeTempDir("@pi-revive-restricted-policy-");
		const sessionFile = await createPersistedSession(cwd, true, "default");
		const blockedPath = path.join(cwd, "blocked.txt");
		await Bun.write(blockedPath, "private fixture");
		const preparedExtensions: PreparedExtension[] = [
			{
				path: "<owner-policy>",
				resolvedPath: "<owner-policy>",
				factory: pi => {
					pi.registerTool({
						name: "owner_policy_escalation",
						label: "Owner Policy Escalation",
						description: "A policy fixture that must not widen the restricted tool set.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "unexpected" }] };
						},
					});
					pi.on("session_start", async () => {
						await pi.setActiveTools(["read", "bash", "owner_policy_escalation", "yield"]);
					});
					pi.on("tool_call", event => {
						if (event.toolName === "read" && event.input.path === blockedPath) {
							return { block: true, reason: "Inherited policy denied the read" };
						}
					});
				},
				error: null,
			},
		];
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, {
			preparedExtensions,
			authStorage,
			modelRegistry,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		let revived: AgentSession | undefined;
		try {
			revived = await reviver(ref);
			const read = revived.getToolByName("read");
			if (!read) throw new Error("Missing restricted read tool");
			await expect(read.execute("denied", { path: blockedPath })).rejects.toThrow(
				"Inherited policy denied the read",
			);
			expect(revived.getActiveToolNames()).toContain("read");
			expect(revived.getActiveToolNames()).toContain("yield");
			expect(revived.getEnabledToolNames()).not.toContain("bash");
			expect(revived.getEnabledToolNames()).not.toContain("owner_policy_escalation");
		} finally {
			await revived?.dispose();
			authStorage.close();
		}
	});

	it("anchors wake-turn artifacts to the revived ref's own dir, not the root session's (#11563)", async () => {
		AgentRegistry.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-artifacts-dir-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		// Run the real wake monitor (call through) so the assertion is tied to the
		// component that actually writes <id>.md, not a stubbed seam.
		const realAttach = executorModule.attachIrcWakeTurnMonitor;
		let capturedArtifactsDir: string | undefined;
		const attachSpy = vi.spyOn(executorModule, "attachIrcWakeTurnMonitor").mockImplementation((session, options) => {
			capturedArtifactsDir = options.artifactsDir;
			return realAttach(session, options);
		});
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// The real monitor ran and installed its observer...
		expect(attachSpy).toHaveBeenCalledTimes(1);
		expect(handle?.observer()).toBeDefined();
		// ...anchored to the revived ref's own tree (dirname of its session file),
		// which is where finalizeRunResult writes <id>.md, not the live root dir.
		expect(capturedArtifactsDir).toBe(path.dirname(sessionFile));
		expect(capturedArtifactsDir).not.toBe(path.join(cwd, "parent"));
		AgentRegistry.resetGlobalForTests();
	});

	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		const attemptedDiscovery: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			if (options?.preloadedExtensionPaths === undefined) attemptedDiscovery.push("extension:read");
			if (options?.preloadedCustomToolPaths === undefined) attemptedDiscovery.push("custom:read");
			if (options?.mcpManager !== undefined || options?.customTools !== undefined)
				attemptedDiscovery.push("mcp:read");
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("strips synthetic write from legacy read-only cold revival", async () => {
		const cwd = makeTempDir("@pi-read-only-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: true,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "yield"]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves explicitly writable cold-revival contracts", async () => {
		const cwd = makeTempDir("@pi-write-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: false,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "write", "yield"]);
		expect(activeToolNames).toEqual([["read", "write", "yield"]]);
	});

	it("preserves normal revival capability wiring for contracts without the marker", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
	});

	it("leaves isolated sessions transcript-only even when the workspace still exists", async () => {
		// Isolated runs are never resumable: the worktree is merged + cleaned,
		// and the parent is told messaging is impossible. A retained workspace
		// (capture/persist failure) still passes the cwd probe, so the stamped
		// contract — not directory existence — must gate revival. Otherwise a
		// restart + Hub message revives the agent in the parent cwd, outside
		// isolation.
		const cwd = makeTempDir("@pi-isolated-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { isolated: true });

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		expect(reviver).toBeUndefined();
	});

	it("restores the persisted agent definition name on cold revival so agent-scoped rules keep matching", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "scout" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// `ref.displayName` is the registry's generated label ("Persisted
		// Restricted") for a cold-revived ref, not the durable agent definition
		// name. `agents: [scout]` rule scoping must key on the latter.
		expect(capturedOptions?.agentName).toBe("scout");
	});

	it("falls back to the ref display name reviving a legacy session file without a persisted agent name", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-");
		const sessionFile = await createPersistedSession(cwd);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.agentName).toBe(ref.displayName);
	});
	it("treats a persisted legacy 'main'-named subagent as scoped to the ref display name, not the top-level sentinel", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-main-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "main" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// A parked transcript from before "main" was reserved as a definition
		// name could still carry `init.agent === "main"`. That must not resolve
		// to the top-level sentinel here, or `agents: [main]` rules documented
		// as top-level-only would load into this subagent.
		expect(capturedOptions?.agentName).toBe(ref.displayName);
		expect(capturedOptions?.agentName).not.toBe("main");
	});
	it("treats a persisted legacy 'sub'-named subagent as scoped to the ref display name, not the shared sub sentinel", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-sub-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "sub" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// A parked transcript from before "sub" was reserved as a definition
		// name could still carry `init.agent === "sub"`. That must not resolve
		// to the shared subagent-fallback sentinel here, or `agents: [sub]`
		// rules meant for that specific legacy definition would load into every
		// unnamed subagent session.
		expect(capturedOptions?.agentName).toBe(ref.displayName);
		expect(capturedOptions?.agentName).not.toBe("sub");
	});

	it("restores the persisted per-agent advisor opt-in on cold revival", async () => {
		const cwd = makeTempDir("@pi-advisor-revive-");
		const advisedFile = await createPersistedSession(cwd, undefined, undefined, "moonshot/k3");
		const roleAdvisedFile = await createPersistedSession(cwd, undefined, undefined, "on");
		const unadvisedFile = await createPersistedSession(cwd);
		const captured: Settings[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.settings) captured.push(options.settings);
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const factory = createFactory(cwd);
		for (const sessionFile of [advisedFile, roleAdvisedFile, unadvisedFile]) {
			const ref = createRef(sessionFile);
			const reviver = await factory(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
		}

		const [advised, roleAdvised, unadvised] = captured;
		expect(advised.get("advisor.enabled")).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(roleAdvised.get("advisor.enabled")).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(unadvised.get("advisor.enabled")).toBe(false);
	});

	it("restores the persisted custom model role before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("restores compaction threshold behavior after parent settings change", async () => {
		const cwd = makeTempDir("@pi-compaction-threshold-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			compactionThreshold: { thresholdPercent: 72, thresholdTokens: -1 },
		});
		const parentSettings = Settings.isolated({
			"compaction.thresholdPercent": 45,
			"compaction.thresholdTokens": 120_000,
		});
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { settings: parentSettings })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const revivedSettings = capturedOptions?.settings;
		if (!revivedSettings) throw new Error("Expected revived child settings");
		const parentCompaction = parentSettings.getGroup("compaction");
		const revivedCompaction = revivedSettings.getGroup("compaction");
		expect(shouldCompact(130_000, 200_000, parentCompaction)).toBe(true);
		expect(resolveThresholdTokens(200_000, revivedCompaction)).toBe(144_000);
		expect(shouldCompact(130_000, 200_000, revivedCompaction)).toBe(false);
		expect(shouldCompact(144_001, 200_000, revivedCompaction)).toBe(true);
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd, eventBus)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("preserves the completed output artifact when a revived subagent answers a hub message without yielding", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-artifact-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// The completed first run already wrote its report to <artifactsDir>/<id>.md
		// (artifactsDir = parent sessionFile sans ".jsonl"; see createFactory).
		const artifactPath = path.join(cwd, "parent", `${ref.id}.md`);
		const completedReport = "# Completed report\n\nfull multi-paragraph body\n\nZZEND";
		await Bun.write(artifactPath, completedReport);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "thanks",
			display: true,
			details: { id: "irc-1", from: "Main", message: "thanks" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		// A wake turn answering a hub message never calls yield; finalization must
		// not clobber the authoritative completion artifact with a warning body.
		const finish = observer?.([record]);
		await finish?.();

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	describe("wake-turn relay", () => {
		async function reviveWithWaker(cwd: string): Promise<{ ref: AgentRef; handle: RevivedSessionHandle }> {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			const sessionFile = await createPersistedSession(cwd);
			MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
			let handle: RevivedSessionHandle | undefined;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
				handle = createRevivedSession([]);
				return { session: handle.session } as CreateAgentSessionResult;
			});
			const ref = createRef(sessionFile);
			const registry = AgentRegistry.global();
			registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
			registry.register({
				id: ref.id,
				displayName: ref.displayName,
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
			if (!handle) throw new Error("Expected a revived session");
			return { ref, handle };
		}

		const wakeRecord = (from: string): CustomMessage => ({
			role: "custom",
			customType: "irc:incoming",
			content: "send me the full table",
			display: true,
			details: { id: "irc-42", from, message: "send me the full table" },
			attribution: "agent",
			timestamp: Date.now(),
		});

		it("delivers the turn's final text to the waker when the agent never replied itself", async () => {
			// A read-only scout has no `hub` tool: without the relay its answer to a
			// wake message is stranded in its own transcript.
			const cwd = makeTempDir("@pi-revive-relay-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			expect(handle.trackedReplies).toHaveLength(1);
			handle.setLastAssistantText("# Full table\n\n| tool | file |\n|---|---|\n| read | read.ts |");
			const reply = IrcBus.global().wait("Main", { from: ref.id }, 5000);
			await finish?.();
			await handle.trackedReplies[0];

			expect(await reply).toMatchObject({
				from: ref.id,
				to: "Main",
				replyTo: "irc-42",
				body: "# Full table\n\n| tool | file |\n|---|---|\n| read | read.ts |",
			});
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("relays the attributed provider error when the wake turn fails", async () => {
			// A failed wake turn (provider error / exhausted fallback chain) must not
			// look like a healthy peer that chose not to answer: the waiter needs the
			// attributed [provider/model] error, not a generic "stopped without replying".
			const cwd = makeTempDir("@pi-revive-relay-failed-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			handle.setLastAssistantStop({
				stopReason: "error",
				errorMessage: "402 usage balance exhausted",
				provider: "some-provider",
				model: "some-model",
			});
			const reply = IrcBus.global().wait("Main", { from: ref.id }, 5000);
			await finish?.();
			await handle.trackedReplies[0];

			const msg = await reply;
			expect(msg).not.toBeNull();
			expect(msg?.replyTo).toBe("irc-42");
			expect(msg?.body).toContain("[some-provider/some-model]");
			expect(msg?.body).toContain("402 usage balance exhausted");
			expect(msg?.body).toContain(`history://${ref.id}`);
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("relays a cancellation notice when the wake turn is aborted", async () => {
			const cwd = makeTempDir("@pi-revive-relay-aborted-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			handle.setLastAssistantStop({ stopReason: "aborted" });
			const reply = IrcBus.global().wait("Main", { from: ref.id }, 5000);
			await finish?.();
			await handle.trackedReplies[0];

			const msg = await reply;
			expect(msg).not.toBeNull();
			expect(msg?.replyTo).toBe("irc-42");
			expect(msg?.body.toLowerCase()).toContain("cancel");
			expect(msg?.body).toContain(`history://${ref.id}`);
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("relays a no-output notice when the wake turn completes without producing anything", async () => {
			const cwd = makeTempDir("@pi-revive-relay-empty-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			// No setLastAssistant* call: the turn completes with zero output and never
			// answers its waker. Previously the relay dropped the empty body silently.
			const finish = observer?.([wakeRecord("Main")]);
			const reply = IrcBus.global().wait("Main", { from: ref.id }, 5000);
			await finish?.();
			await handle.trackedReplies[0];

			const msg = await reply;
			expect(msg).not.toBeNull();
			expect(msg?.replyTo).toBe("irc-42");
			expect(msg?.body.toLowerCase()).toContain("no output");
			expect(msg?.body).toContain(`history://${ref.id}`);
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("stays silent when the agent already answered its waker during the turn", async () => {
			const cwd = makeTempDir("@pi-revive-relay-answered-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			const bus = IrcBus.global();
			const answered = bus.wait("Main", { from: ref.id }, 5000);
			await bus.send({ from: ref.id, to: "Main", body: "here you go" });
			expect((await answered)?.body).toBe("here you go");
			handle.setLastAssistantText("Sent the table via hub.");
			const duplicate = bus.wait("Main", { from: ref.id }, 200);
			await finish?.();
			await handle.trackedReplies[0];

			expect(await duplicate).toBeNull();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});
		it("never relays a wake turn woken by another relay", async () => {
			// Two idle subagents exchanging one message used to ping-pong forever:
			// each relay woke the peer, whose stop-text was relayed straight back.
			// Relay messages are answers, not wake sources, so the echo stops here.
			const cwd = makeTempDir("@pi-revive-relay-echo-");
			const { handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			// A live peer captures whatever the turn relays instead of a null
			// `bus.wait`: fully deterministic, no timer dependence.
			const delivered: IrcMessage[] = [];
			AgentRegistry.global().register({
				id: "Peer",
				displayName: "Peer",
				kind: "sub",
				status: "idle",
				session: {
					deliverIrcMessage: async (msg: IrcMessage) => {
						delivered.push(msg);
						return "injected" as const;
					},
				} as unknown as AgentSession,
			});
			const relayRecord: CustomMessage = {
				...wakeRecord("Peer"),
				details: { id: "irc-43", from: "Peer", message: "You hang up", wakeRelay: true },
			};
			const finish = observer?.([relayRecord]);
			handle.setLastAssistantText("No YOU hang up");
			await finish?.();
			await handle.trackedReplies[0];

			expect(delivered).toHaveLength(0);
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("reports the failure even after the agent sent a progress ping to the waker", async () => {
			// `sentSince` cannot tell "already answered" from "pinged 'on it'".
			// A progress ping is not an answer, so a failed wake turn must still
			// tell the waker it died instead of being suppressed as a duplicate.
			const cwd = makeTempDir("@pi-revive-relay-partial-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const delivered: IrcMessage[] = [];
			AgentRegistry.global().register({
				id: "Main",
				displayName: "Main",
				kind: "main",
				status: "idle",
				session: {
					deliverIrcMessage: async (msg: IrcMessage) => {
						delivered.push(msg);
						return "injected" as const;
					},
				} as unknown as AgentSession,
			});
			const bus = IrcBus.global();
			const finish = observer?.([wakeRecord("Main")]);
			await bus.send({ from: ref.id, to: "Main", body: "on it" });
			handle.setLastAssistantStop({
				stopReason: "error",
				errorMessage: "402 usage balance exhausted",
				provider: "some-provider",
				model: "some-model",
			});
			await finish?.();
			await handle.trackedReplies[0];

			expect(delivered).toHaveLength(2);
			expect(delivered[0]?.body).toBe("on it");
			const notice = delivered[1];
			expect(notice?.wakeRelay).toBe(true);
			expect(notice?.body).toContain("402 usage balance exhausted");
			expect(notice?.body.toLowerCase()).toContain("earlier in this turn");
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("relays the error message without the stack trace when the wake turn throws", async () => {
			// A thrown turn error's stack belongs in `done.error`/logs, not in the
			// waking peer's model context.
			const cwd = makeTempDir("@pi-revive-relay-thrown-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const boom = new Error("boom while waking");
			boom.stack = "boom while waking\n    at deepInternal (secret.ts:99:1)";
			const finish = observer?.([wakeRecord("Main")]);
			const reply = IrcBus.global().wait("Main", { from: ref.id }, 5000);
			await finish?.(boom);
			await handle.trackedReplies[0];

			const msg = await reply;
			expect(msg).not.toBeNull();
			expect(msg?.body).toContain("boom while waking");
			expect(msg?.body).not.toContain("secret.ts:99");
			expect(msg?.body).not.toContain("at deepInternal");
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});
	});
});

describe("buildWakeRelayBody", () => {
	// A wake turn can yield an artifact and then fail on a later provider call
	// (`finalizeRunResult` rewrites `<id>.md` on `hasYield`, and the error lane
	// does not exclude a prior yield). The observer seam cannot drive a real
	// yield, so pin the message contract here: the failure notice must report
	// the recorded artifact, never claim nothing was produced.
	it("reports the recorded artifact when a yielded turn then fails", () => {
		const result = {
			index: 0,
			id: "SmokeKid",
			agent: "scout",
			agentSource: "bundled",
			task: "follow up",
			exitCode: 1,
			output: "# Partial report\n\nrows written before the 402",
			stderr: "",
			truncated: false,
			durationMs: 1200,
			tokens: 0,
			requests: 2,
			error: "402 usage balance exhausted",
			outputPath: "/tmp/SmokeKid.md",
		} satisfies SingleResult;

		const body = buildWakeRelayBody({
			id: "SmokeKid",
			yielded: true,
			result,
			turnText: "",
			error: "[some-provider/some-model] 402 usage balance exhausted",
			aborted: false,
			abortReason: undefined,
			finalizeError: undefined,
			alreadyMessaged: false,
		});

		expect(body).toContain("Wake turn failed: [some-provider/some-model] 402 usage balance exhausted");
		expect(body).not.toContain("No answer was produced");
		expect(body).toContain("# Partial report");
		expect(body).toContain("history://SmokeKid");
	});

	describe("fail-closed revival", () => {
		function entryType(line: string): string | undefined {
			const parsed: { type?: string } = JSON.parse(line);
			return parsed.type;
		}

		async function entriesOfType(
			sessionFile: string,
			keep: (type: string | undefined) => boolean,
		): Promise<string[]> {
			return (await Bun.file(sessionFile).text())
				.split("\n")
				.filter(line => line.trim().length > 0 && keep(entryType(line)));
		}

		it("refuses a transcript that vanished between the peek and the locked open", async () => {
			const cwd = makeTempDir("@pi-revive-vanished-");
			const sessionFile = await createPersistedSession(cwd);
			const ref = createRef(sessionFile);
			// The factory's lock-free peek succeeds here; the file disappears
			// before the reviver takes the single-writer lock.
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await fs.promises.rm(sessionFile);

			await expect(reviver(ref)).rejects.toThrow(/ENOENT/);
			// Fail closed without minting: the missing path stays missing.
			expect(await Bun.file(sessionFile).exists()).toBe(false);
		});

		it("refuses a transcript deleted between open's snapshot read and its adoption", async () => {
			const cwd = makeTempDir("@pi-revive-stale-read-");
			const sessionFile = await createPersistedSession(cwd);
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			// Delete the transcript from inside its own snapshot read: open()
			// has resolved loadSessionFile but has not adopted the snapshot
			// yet, so the reviver must fail closed on the fresh state instead
			// of reviving stale history. Single-shot: only the snapshot read
			// mutates, so the publish-time re-read observes the deletion.
			const originalReadText = FileSessionStorage.prototype.readText;
			const readTextSpy = vi.spyOn(FileSessionStorage.prototype, "readText").mockImplementationOnce(async function (
				this: FileSessionStorage,
				p: string,
			) {
				const text = await originalReadText.call(this, p);
				await fs.promises.rm(p);
				return text;
			});
			try {
				await expect(reviver(ref)).rejects.toThrow(/ENOENT/);
				// Fail closed without minting: the missing path stays missing.
				expect(await Bun.file(sessionFile).exists()).toBe(false);
			} finally {
				readTextSpy.mockRestore();
			}
		});

		it("refuses a transcript truncated to header+session_init without rewriting it", async () => {
			const cwd = makeTempDir("@pi-revive-truncated-");
			const sessionFile = await createPersistedSession(cwd);
			const truncated = `${(await entriesOfType(sessionFile, type => type === "session" || type === "session_init")).join("\n")}\n`;
			await Bun.write(sessionFile, truncated);
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");

			await expect(reviver(ref)).rejects.toThrow(/no message history/);
			// The parked transcript is evidence, not scratch space: untouched.
			expect(await Bun.file(sessionFile).text()).toBe(truncated);
		});

		it("rebuilds the contract from the reopened file, not the stale peek capture", async () => {
			const cwd = makeTempDir("@pi-revive-contract-");
			const sessionFile = await createPersistedSession(cwd);
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			// The file is replaced after the peek: same messages, no session_init.
			const withoutInit = `${(await entriesOfType(sessionFile, type => type !== "session_init")).join("\n")}\n`;
			await Bun.write(sessionFile, withoutInit);

			await expect(reviver(ref)).rejects.toThrow(/no persisted session contract/);
			expect(await Bun.file(sessionFile).text()).toBe(withoutInit);
		});
	});
});
