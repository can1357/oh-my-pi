import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { A2aAgentBridge, spawnA2aAgent } from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import { IncomingRequests } from "@oh-my-pi/pi-coding-agent/a2a/incoming-requests";
import { A2A_ARTIFACT_MAX_CHARS } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelMentionRegistry } from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	type RetryFallbackRole,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { PerCallModelError, PerCallModelUnavailableError } from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { cfgTaskMaxEffort } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { TeamIdentity } from "@oh-my-pi/pi-coding-agent/task/team-runtime";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { buildWakeRelayBody } from "@oh-my-pi/pi-coding-agent/task/executor";
import { settleA2aReplies } from "@oh-my-pi/pi-coding-agent/a2a/reply-relay";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { localSession } from "../helpers/local-session";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

/** Inert shared manager exposing the members a revived subagent reads: its tools and change feed. */
function fakeMcpManager(getTools: () => Array<{ name: string; label: string }>): MCPManager {
	return { getTools, addToolsChangedListener: () => () => {} } as unknown as MCPManager;
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
		generation: 0,
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
	emit: (event: AgentSessionEvent) => void;
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
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const trackedReplies: Promise<void>[] = [];
	const session = {
		...createSessionDefaults(),
		a2aBridge: new A2aAgentBridge(),
		settings: Settings.isolated(),
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
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
		emit: event => {
			for (const listener of listeners) listener(event);
		},
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
		coordinationOnlyWrite?: boolean;
		teamIdentity?: TeamIdentity;
		agent?: string;
		isolated?: boolean;
		retryFallback?: RetryFallbackRole;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
		perCallModel?: boolean;
		resolvedModel?: string;
		perCallModelIdentity?: string;
		perCallThinkingLevel?: ConfiguredThinkingLevel | null;
	},
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: ["persisted prompt"],
		task: "persisted task",
		tools: contract?.tools ?? ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: contract?.resolvedModel ?? (modelRole ? "anthropic/claude-sonnet-4-5" : undefined),
		advisor,
		readOnly: contract?.readOnly,
		coordinationOnlyWrite: contract?.coordinationOnlyWrite,
		teamIdentity: contract?.teamIdentity,
		agent: contract?.agent,
		isolated: contract?.isolated,
		retryFallback: contract?.retryFallback,
		perCallModel: contract?.perCallModel,
		perCallModelIdentity: contract?.perCallModelIdentity,
		perCallThinkingLevel: contract?.perCallThinkingLevel,
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
	sessionAgents?: readonly AgentDefinition[];
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
		getSessionAgents: () => owner.sessionAgents ?? [],
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
	IncomingRequests.resetGlobalForTests();
	MCPManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("initializes the extension runtime on cold revival so tool_call handlers are not fail-closed blocked", async () => {
		const cwd = makeTempDir("@pi-revive-ext-init-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance(fakeMcpManager(() => []));
		const initialize = vi.fn();
		const onError = vi.fn();
		const emit = vi.fn(async () => undefined);
		const emitBeforeAgentStart = vi.fn(async () => undefined);
		const extensionRunner = { initialize, onError, emit, emitBeforeAgentStart };
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
			revived = localSession(await reviver(ref));
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
			revived = localSession(await reviver(ref));
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
		MCPManager.setInstance(fakeMcpManager(() => []));
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
		MCPManager.setInstance(fakeMcpManager(hostileMcpGetTools));
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
		expect(capturedOptions?.mcpTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("revives a coordination-only writer without granting filesystem or xd writes", async () => {
		const cwd = makeTempDir("@pi-coordination-real-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default", undefined, {
			tools: ["read", "bash", "write", "yield"],
			readOnly: false,
			coordinationOnlyWrite: true,
		});
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		MCPManager.setInstance(new MCPManager(cwd));
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, { authStorage, modelRegistry })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		let revived: AgentSession | undefined;
		try {
			revived = localSession(await reviver(ref));
			const write = revived.getToolByName("write");
			if (!write) throw new Error("Missing coordination write");
			for (const target of [path.join(cwd, "blocked"), "local://blocked", "xd://anything"]) {
				await expect(write.execute("blocked", { path: target, content: "x" })).rejects.toThrow("coordination-only");
			}
			expect(await Bun.file(path.join(cwd, "blocked")).exists()).toBe(false);
		} finally {
			await revived?.dispose();
			authStorage.close();
		}
	});

	it("retains a stale team identity on cold revival and blocks actual session dispatch", async () => {
		const cwd = makeTempDir("@pi-team-plan-real-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default", undefined, {
			tools: ["read", "write", "bash"],
			teamIdentity: { team: "audit", generation: -1, memberId: "persisted-restricted" },
		});
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		MCPManager.setInstance(new MCPManager(cwd));
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, { authStorage, modelRegistry })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		let revived: AgentSession | undefined;
		try {
			revived = localSession(await reviver(ref));
			const write = revived.getToolByName("write");
			if (!write) throw new Error("Missing revived write tool");
			const args = { path: path.join(cwd, "must-not-exist.txt"), content: "unsafe" };
			const mock = createMockModel({
				responses: [{ content: [{ type: "toolCall", name: "write", arguments: args }] }, { content: ["stopped"] }],
			});
			revived.agent.streamFn = mock.stream;
			revived.agent.setModel(mock.model);
			await revived.agent.prompt("Attempt a write after cold revival");
			expect(await Bun.file(args.path).exists()).toBe(false);
			const result = revived.agent.state.messages.find(message => message.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("plan approval required: send it via write team://audit/plan");
		} finally {
			await revived?.dispose();
			authStorage.close();
		}
	});

	it("cold-revives an ungated former teammate with usable read and disk write tools", async () => {
		const cwd = makeTempDir("@pi-ungated-team-real-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default", undefined, {
			tools: ["read", "write", "bash"],
			teamIdentity: { team: "audit", generation: -1, memberId: "persisted-restricted", planApproval: false },
		});
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		MCPManager.setInstance(new MCPManager(cwd));
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, { authStorage, modelRegistry })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		let revived: AgentSession | undefined;
		try {
			revived = localSession(await reviver(ref));
			const input = path.join(cwd, "source.txt");
			const output = path.join(cwd, "result.txt");
			await Bun.write(input, "readable former team source\n");
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "read", arguments: { path: input } }] },
					{
						content: [
							{ type: "toolCall", name: "write", arguments: { path: output, content: "ordinary output" } },
						],
					},
					{ content: ["finished"] },
				],
			});
			revived.agent.streamFn = mock.stream;
			revived.agent.setModel(mock.model);
			await revived.agent.prompt("Read and write after the ungated team's runtime has ended");
			const results = revived.agent.state.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results.every(result => result.isError !== true)).toBe(true);
			expect(JSON.stringify(results[0])).toContain("readable former team source");
			expect(await Bun.file(output).text()).toBe("ordinary output");
		} finally {
			await revived?.dispose();
			authStorage.close();
		}
	});

	for (const readOnly of [false, true]) {
		it(`preserves coordination-only write on cold revival with readOnly ${readOnly}`, async () => {
			const cwd = makeTempDir("@pi-coordination-revive-");
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				tools: ["read", "write", "yield"],
				readOnly,
				coordinationOnlyWrite: true,
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
			expect(capturedOptions?.coordinationOnlyWrite).toBe(true);
			expect(capturedOptions?.toolNames).toContain("write");
			expect(activeToolNames[0]).toContain("write");
		});
	}

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
		const hostileMcp = fakeMcpManager(() => [{ name: "mcp__server_read", label: "server/read" }]);
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
		expect(capturedOptions?.mcpTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
		expect(capturedOptions?.customTools).toBeUndefined();
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

	it("keys a revived subagent's soft request budget on its persisted agent name, not the ref display name", async () => {
		const cwd = makeTempDir("@pi-revive-soft-budget-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "scout" });
		let capturedBudget: number | undefined;
		vi.spyOn(executorModule, "attachIrcWakeTurnMonitor").mockImplementation((_session, options) => {
			capturedBudget = options.softRequestBudget;
		});
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createRevivedSession([]).session }) as CreateAgentSessionResult,
		);

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedBudget).toBe(100);
	});

	it("forwards the configured token budget to the revived agent's wake monitor", async () => {
		const cwd = makeTempDir("@pi-revive-token-budget-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "scout" });
		let capturedBudget: number | undefined;
		vi.spyOn(executorModule, "attachIrcWakeTurnMonitor").mockImplementation((_session, options) => {
			capturedBudget = options.tokenBudget;
		});
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createRevivedSession([]).session }) as CreateAgentSessionResult,
		);

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ "task.tokenBudget": 64000 }),
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedBudget).toBe(64000);
	});

	it("restores the live account pool for the persisted agent name, so a revived agent stays restricted", async () => {
		const cwd = makeTempDir("@pi-revive-account-pool-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "scout" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});
		const settings = Settings.isolated({
			"task.agentAccountPools": {
				scout: { anthropic: ["email:a@example.com|org:org-a"] },
				other: { anthropic: [] },
			},
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { settings })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.oauthAccountPools).toEqual({ anthropic: ["email:a@example.com|org:org-a"] });
	});

	const perCallModelFixture = (id: string, efforts: Effort[] = [Effort.Low, Effort.High]) =>
		buildModel({
			id,
			name: id,
			api: "anthropic-messages",
			provider: "mock",
			reasoning: true,
			thinking: { mode: "effort", efforts },
			baseUrl: "https://example.invalid",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});

	/** A warm registry stub holding exactly `models`. */
	const stubRegistry = (models: Model[]) =>
		({
			authStorage: {},
			awaitBackgroundRefresh: async () => {},
			getAvailable: () => models,
			getAll: () => models,
		}) as unknown as ModelRegistry;

	it("re-checks a revived per-call worker against current grants and keeps it off fallbacks", async () => {
		const own = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!own) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const reviewer: AgentDefinition = {
			name: "reviewer",
			description: "reviewer",
			systemPrompt: "review",
			source: "user",
			model: [`${own.provider}/${own.id}`],
		};
		const discover = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [reviewer], projectAgentsDir: null });
		let options: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
			options = created;
			return {
				session: Object.assign(createRevivedSession([]).session, { model: own }),
			} as CreateAgentSessionResult;
		});
		const modelRegistry = stubRegistry([own]);
		const revive = async (settings: Settings) => {
			const cwd = makeTempDir("@pi-revive-per-call-");
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				agent: "reviewer",
				perCallModel: true,
				resolvedModel: `${own.provider}/${own.id}`,
				perCallModelIdentity: `${own.provider}/${own.id}`,
				perCallThinkingLevel: Effort.Low,
			});
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd, undefined, { settings, modelRegistry })(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
			const check = options?.assertDispatchModel;
			if (!check) throw new Error("Expected a per-call dispatch check");
			expect(options?.disableModelFallback).toBe(true);
			expect(options?.disableServerSideFallback).toBe(true);
			return check;
		};

		// The spawn approved the model through the agent's frontmatter; revival keeps that grant.
		expect((await revive(Settings.isolated()))(own)).toBeUndefined();
		// A disabled, removed or project-sourced agent no longer grants its model.
		await expect(revive(Settings.isolated({ "task.disabledAgents": ["reviewer"] }))).rejects.toThrow(/not approved/);
		discover.mockResolvedValue({ agents: [{ ...reviewer, source: "project" }], projectAgentsDir: null });
		await expect(revive(Settings.isolated())).rejects.toThrow(/not approved/);
		discover.mockResolvedValue({ agents: [], projectAgentsDir: null });
		await expect(revive(Settings.isolated())).rejects.toThrow(/not approved/);
	});

	it("refuses before session creation when a per-call model cannot run at or below task.maxEffort", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const highOnly = perCallModelFixture("mock-high-only", [Effort.High]);
		const disposed: boolean[] = [];
		const settings = Settings.isolated({ "task.maxEffort": "low", modelRoles: { review: "mock/mock-high-only" } });
		let options: CreateAgentSessionOptions | undefined;
		let sessionModel: typeof highOnly | undefined = highOnly;
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
			options = created;
			const session = Object.assign(createRevivedSession([]).session, {
				model: sessionModel,
				dispose: async () => {
					disposed.push(true);
				},
			});
			return { session } as CreateAgentSessionResult;
		});
		const revive = async (perCallModel: boolean) => {
			const cwd = makeTempDir("@pi-revive-per-call-floor-");
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				agent: "task",
				perCallModel,
				resolvedModel: "mock/mock-high-only",
				perCallModelIdentity: "mock/mock-high-only",
				perCallThinkingLevel: Effort.High,
			});
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd, undefined, { settings, modelRegistry: stubRegistry([highOnly]) })(
				ref,
			);
			if (!reviver) throw new Error("Expected a persisted reviver");
			return reviver(ref);
		};

		await expect(revive(true)).rejects.toThrow(
			"mock/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(create).not.toHaveBeenCalled();
		expect(disposed).toEqual([]);
		await expect(revive(false)).resolves.toBeDefined();

		// A model the worker reaches later (e.g. an extension swap) is held to the same floor at dispatch.
		cfgTaskMaxEffort.override(settings, Effort.High);
		sessionModel = undefined;
		await expect(revive(true)).rejects.toThrow("is no longer available");
		cfgTaskMaxEffort.override(settings, Effort.Low);
		const check = options?.assertDispatchModel;
		if (!check) throw new Error("Expected a per-call dispatch check");
		expect(() => check(highOnly)).toThrow("no supported thinking effort at or below task.maxEffort=low");
	});

	it.each([
		{ identity: "mock/coding-router:low", level: Effort.High, availableId: "coding-router" },
		{ identity: "mock/coding-router", level: Effort.Low, availableId: "coding-router:low" },
	])("refuses to revive $identity onto its level-shaped sibling", async ({ identity, level, availableId }) => {
		const sibling = perCallModelFixture(availableId);
		const create = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: Object.assign(createRevivedSession([]).session, { model: sibling }),
		} as CreateAgentSessionResult);
		const cwd = makeTempDir("@pi-revive-per-call-sibling-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			perCallModel: true,
			resolvedModel: "mock/coding-router:low",
			perCallModelIdentity: identity,
			perCallThinkingLevel: level,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { modelRegistry: stubRegistry([sibling]) })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		await expect(reviver(ref)).rejects.toBeInstanceOf(PerCallModelError);
		expect(create).not.toHaveBeenCalled();
	});

	it.each([
		{ identity: "mock/coding-router", level: Effort.Low },
		{ identity: "mock/coding-router:low", level: Effort.High },
	])("restores $identity and its separate $level thinking level exactly", async ({ identity, level }) => {
		const models = [perCallModelFixture("coding-router"), perCallModelFixture("coding-router:low")];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const selector = Array.isArray(options?.modelPattern) ? options.modelPattern[0] : options?.modelPattern;
			const parsed = selector ? parseModelPattern(selector, models) : undefined;
			return {
				session: Object.assign(createRevivedSession([]).session, {
					model: options?.model ?? parsed?.model,
					thinkingLevel: options?.thinkingLevel ?? parsed?.thinkingLevel ?? Effort.High,
				}),
			} as CreateAgentSessionResult;
		});
		const cwd = makeTempDir("@pi-revive-per-call-level-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			perCallModel: true,
			resolvedModel: "mock/coding-router:low",
			perCallModelIdentity: identity,
			perCallThinkingLevel: level,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ modelRoles: { review: identity } }),
			modelRegistry: stubRegistry(models),
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		const revived = await reviver(ref);
		expect(`${revived.model?.provider}/${revived.model?.id}`).toBe(identity);
		expect(revived.thinkingLevel).toBe(level);
	});

	it("revives a per-call worker on its exact model, not on a session-local switch", async () => {
		const models = [perCallModelFixture("coding-router"), perCallModelFixture("switched")];
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: Object.assign(createRevivedSession([]).session, { model: options?.model }),
				}) as CreateAgentSessionResult,
		);
		const cwd = makeTempDir("@pi-revive-per-call-switched-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			perCallModel: true,
			resolvedModel: "mock/coding-router",
			perCallModelIdentity: "mock/coding-router",
			perCallThinkingLevel: Effort.Low,
		});
		// A focused worker can still be switched by hand; that persists a session-local model change.
		const manager = await SessionManager.open(sessionFile);
		manager.appendModelChange("mock/switched", "temporary");
		await manager.close();
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ modelRoles: { review: "mock/coding-router" } }),
			modelRegistry: stubRegistry(models),
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		const revived = await reviver(ref);
		expect(`${revived.model?.provider}/${revived.model?.id}`).toBe("mock/coding-router");
		expect(create.mock.calls[0]?.[0]?.modelPattern).toBeUndefined();
	});

	it.each([
		{ identity: undefined, level: Effort.Low },
		{ identity: "mock/coding-router", level: undefined },
		{ identity: undefined, level: undefined },
	])("refuses legacy per-call revival without separate identity/level fields (%j)", async ({ identity, level }) => {
		const model = perCallModelFixture("coding-router");
		const create = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: Object.assign(createRevivedSession([]).session, { model }),
		} as CreateAgentSessionResult);
		const cwd = makeTempDir("@pi-revive-per-call-legacy-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			perCallModel: true,
			resolvedModel: "mock/coding-router:low",
			perCallModelIdentity: identity,
			perCallThinkingLevel: level,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		await expect(reviver(ref)).rejects.toBeInstanceOf(PerCallModelError);
		expect(create).not.toHaveBeenCalled();
	});

	it("waits for pending background discovery before looking up a per-call worker's model", async () => {
		const model = perCallModelFixture("discovered-model");
		const refresh = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let warm = false;
		const awaitBackgroundRefresh = vi.fn(async () => {
			started.resolve();
			await refresh.promise;
			warm = true;
		});
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: Object.assign(createRevivedSession([]).session, { model: options?.model }),
				}) as CreateAgentSessionResult,
		);
		const cwd = makeTempDir("@pi-revive-per-call-discovery-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			perCallModel: true,
			resolvedModel: "mock/discovered-model:low",
			perCallModelIdentity: "mock/discovered-model",
			perCallThinkingLevel: Effort.Low,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ modelRoles: { review: "mock/discovered-model" } }),
			modelRegistry: {
				authStorage: {},
				awaitBackgroundRefresh,
				getDiscoverableProviders: () => [],
				getAvailable: () => (warm ? [model] : []),
				getAll: () => (warm ? [model] : []),
			} as unknown as ModelRegistry,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");

		const pending = reviver(ref);
		try {
			const outcome = await Promise.race([
				started.promise.then(() => "waiting"),
				pending.then(
					() => "completed",
					() => "failed",
				),
			]);
			expect(outcome).toBe("waiting");
			expect(create).not.toHaveBeenCalled();
			refresh.resolve();
			expect((await pending).model).toBe(model);
			expect(awaitBackgroundRefresh).toHaveBeenCalledTimes(1);
		} finally {
			refresh.resolve();
			await pending.catch(() => {});
		}
	});

	it("revives a killed per-call worker with its live parent's local mention and discovery scope", async () => {
		const cwd = makeTempDir("@pi-revive-local-mention-root-");
		const parentCwd = makeTempDir("@pi-revive-local-mention-parent-");
		const target = perCallModelFixture("mentioned");
		const parentModel = perCallModelFixture("parent");
		const rootMentionModel = perCallModelFixture("root-mention");
		const models = [target, parentModel, rootMentionModel];
		const modelRegistry = stubRegistry(models);
		const parentMentions = new ModelMentionRegistry({
			sessionManager: SessionManager.inMemory(parentCwd),
			modelRegistry,
			scopedModels: () => models,
		});
		parentMentions.syncFromBranch();
		parentMentions.expandMentions("^mock/mentioned");
		const parentAgents = parentMentions.sessionAgents();
		const parentRoots: EffectiveExtensionRoots = {
			explicit: [parentCwd],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const discover = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		let options: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
			options = created;
			return {
				session: Object.assign(createRevivedSession([]).session, {
					model: created?.model,
					dispose: async () => created?.sessionManager?.close(),
				}),
			} as CreateAgentSessionResult;
		});
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			agent: "m1",
			perCallModel: true,
			perCallModelIdentity: "mock/mentioned",
			perCallThinkingLevel: Effort.Low,
		});
		const registry = AgentRegistry.global();
		const parentId = "persisted-local-mention-parent";
		const childId = "persisted-local-mention-child";
		registry.register({
			id: parentId,
			displayName: parentId,
			kind: "sub",
			parentId: "Main",
			status: "idle",
			sessionFile: null,
			session: {
				model: parentModel,
				sessionManager: { getCwd: () => parentCwd },
				effectiveExtensionRoots: parentRoots,
				getSessionAgents: () => parentAgents,
			} as unknown as AgentSession,
		});
		registry.register({
			...createRef(sessionFile),
			id: childId,
			parentId,
			status: "aborted",
		});
		const lifecycle = new AgentLifecycleManager(registry);
		lifecycle.setPersistedSubagentReviverFactory(
			createFactory(cwd, undefined, {
				modelRegistry,
				sessionAgents: [{ ...parentAgents[0]!, model: ["mock/root-mention"] }],
			}),
			() => 0,
		);
		try {
			expect((await lifecycle.ensureLive(childId)).model).toBe(target);
			expect(discover).toHaveBeenCalledWith(parentCwd, undefined, parentRoots);
			expect(options?.assertDispatchModel).toBeDefined();
			expect(options!.assertDispatchModel!(target)).toBeUndefined();
			expect(() => options!.assertDispatchModel!(rootMentionModel)).toThrow(/not approved/);
		} finally {
			await lifecycle.dispose();
			registry.unregister(childId);
			registry.unregister(parentId);
		}
	});

	it.each(["parked", "missing"] as const)(
		"refuses a nested %s parent's local grant at revival rather than borrowing a root mention",
		async parentStatus => {
			const cwd = makeTempDir("@pi-revive-unavailable-local-mention-");
			const target = perCallModelFixture("mentioned");
			const parentModel = perCallModelFixture("parent");
			const models = [target, parentModel];
			const modelRegistry = stubRegistry(models);
			const mentions = new ModelMentionRegistry({
				sessionManager: SessionManager.inMemory(cwd),
				modelRegistry,
				scopedModels: () => models,
			});
			mentions.syncFromBranch();
			mentions.expandMentions("^mock/mentioned");
			const agents = mentions.sessionAgents();
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
			let options: CreateAgentSessionOptions | undefined;
			const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
				options = created;
				return {
					session: Object.assign(createRevivedSession([]).session, {
						model: created?.model,
						dispose: async () => created?.sessionManager?.close(),
					}),
				} as CreateAgentSessionResult;
			});
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				agent: "m1",
				perCallModel: true,
				perCallModelIdentity: "mock/mentioned",
				perCallThinkingLevel: Effort.Low,
			});
			const registry = AgentRegistry.global();
			const parentId = "persisted-unavailable-mention-parent";
			const childId = "persisted-unavailable-mention-child";
			if (parentStatus === "parked") {
				registry.register({
					id: parentId,
					displayName: parentId,
					kind: "sub",
					parentId: "Main",
					status: "parked",
					session: null,
					sessionFile: path.join(cwd, "parent.jsonl"),
				});
			}
			registry.register({ ...createRef(sessionFile), id: childId, parentId });
			const factory = createFactory(cwd, undefined, { modelRegistry, sessionAgents: agents });
			const probes: string[] = [];
			const lifecycle = new AgentLifecycleManager(registry);
			lifecycle.setPersistedSubagentReviverFactory(
				async ref => {
					probes.push(ref.id);
					return factory(ref);
				},
				() => 0,
			);
			try {
				await expect(lifecycle.ensureLive(childId)).rejects.toThrow(
					"parent-local agent grants are unavailable until the parent is revived",
				);
				expect(create).not.toHaveBeenCalled();
				expect(probes).toEqual([childId]);
				expect(registry.get(parentId)?.status).toBe(parentStatus === "parked" ? "parked" : undefined);
				// The failed approval releases the writer and cold adoption, so an explicit
				// parent revival can restore its own authorization before retrying the child.
				const reopened = await SessionManager.open(sessionFile);
				await reopened.close();
				registry.register({
					id: parentId,
					displayName: parentId,
					kind: "sub",
					parentId: "Main",
					status: "idle",
					sessionFile: null,
					session: {
						model: parentModel,
						sessionManager: { getCwd: () => cwd },
						effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
						getSessionAgents: () => agents,
					} as unknown as AgentSession,
				});
				await lifecycle.ensureLive(childId);
				expect(options?.assertDispatchModel).toBeDefined();
				expect(options!.assertDispatchModel!(target)).toBeUndefined();
			} finally {
				await lifecycle.dispose();
				registry.unregister(childId);
				registry.unregister(parentId);
			}
		},
	);

	// Bundled and user frontmatter share one trust branch; bundled stands for both.
	it.each(["bundled", "role"] as const)(
		"keeps current %s grants when a nested worker's parent is unavailable",
		async grant => {
			const cwd = makeTempDir("@pi-revive-independent-grant-");
			const target = perCallModelFixture("independent");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [
					{
						name: "selected",
						description: "selected",
						systemPrompt: "work",
						source: "bundled",
						model: grant === "role" ? undefined : ["mock/independent"],
					},
				],
				projectAgentsDir: null,
			});
			let options: CreateAgentSessionOptions | undefined;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
				options = created;
				return {
					session: Object.assign(createRevivedSession([]).session, { model: target }),
				} as CreateAgentSessionResult;
			});
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				agent: "selected",
				perCallModel: true,
				perCallModelIdentity: "mock/independent",
				perCallThinkingLevel: Effort.Low,
			});
			const ref = { ...createRef(sessionFile), parentId: "unavailable-parent" };
			const reviver = await createFactory(cwd, undefined, {
				settings: Settings.isolated(grant === "role" ? { modelRoles: { review: "mock/independent" } } : {}),
				modelRegistry: stubRegistry([target]),
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			try {
				expect((await reviver(ref)).model).toBe(target);
				expect(options?.assertDispatchModel).toBeDefined();
				expect(options!.assertDispatchModel!(target)).toBeUndefined();
			} finally {
				await options?.sessionManager?.close();
			}
		},
	);

	it("keeps root-local mention agents for the root's direct children", async () => {
		const cwd = makeTempDir("@pi-revive-direct-mention-");
		const target = perCallModelFixture("mentioned");
		const modelRegistry = stubRegistry([target]);
		const mentions = new ModelMentionRegistry({
			sessionManager: SessionManager.inMemory(cwd),
			modelRegistry,
			scopedModels: () => [target],
		});
		mentions.syncFromBranch();
		mentions.expandMentions("^mock/mentioned");
		const agents = mentions.sessionAgents();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		let options: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
			options = created;
			return {
				session: Object.assign(createRevivedSession([]).session, { model: target }),
			} as CreateAgentSessionResult;
		});
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			agent: "m1",
			perCallModel: true,
			perCallModelIdentity: "mock/mentioned",
			perCallThinkingLevel: Effort.Low,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { modelRegistry, sessionAgents: agents })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		try {
			await reviver(ref);
			expect(options?.assertDispatchModel).toBeDefined();
			expect(options!.assertDispatchModel!(target)).toBeUndefined();
		} finally {
			await options?.sessionManager?.close();
		}
	});

	it("grants a revived per-call worker its real live parent's model, never the root session's", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const parentModel = perCallModelFixture("parent-model");
		const rootModel = perCallModelFixture("root-model");
		let options: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
			options = created;
			return {
				session: Object.assign(createRevivedSession([]).session, { model: created?.model }),
			} as CreateAgentSessionResult;
		});
		const registry = AgentRegistry.global();
		const parentId = "persisted-per-call-parent";
		const childOf = async (parent: string, model = parentModel) => {
			const cwd = makeTempDir("@pi-revive-per-call-parent-");
			const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
				agent: "task",
				perCallModel: true,
				resolvedModel: `mock/${model.id}`,
				perCallModelIdentity: `mock/${model.id}`,
				perCallThinkingLevel: Effort.Low,
			});
			const ref = { ...createRef(sessionFile), parentId: parent };
			const factory = createPersistedSubagentReviverFactory({
				session: {
					sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
					effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
					getSessionAgents: () => [],
					model: rootModel,
				} as unknown as AgentSession,
				authStorage: {} as never,
				modelRegistry: stubRegistry([parentModel, rootModel]),
				settings: Settings.isolated(),
				enableLsp: true,
			});
			const reviver = await factory(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
			const check = options?.assertDispatchModel;
			if (!check) throw new Error("Expected a per-call dispatch check");
			return check;
		};

		registry.register({
			id: parentId,
			displayName: parentId,
			kind: "sub",
			parentId: "Main",
			session: {
				model: parentModel,
				sessionManager: { getCwd: () => "/tmp" },
				effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
				getSessionAgents: () => [],
			} as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
		try {
			const nested = await childOf(parentId);
			expect(nested(parentModel)).toBeUndefined();
			expect(() => nested(rootModel)).toThrow(/not approved/);

			// A parked parent grants nothing; the root's model is not substituted.
			registry.unregister(parentId);
			expect(() => nested(parentModel)).toThrow(`Parent agent "${parentId}"`);
			// An unavailable model is not an approval denial, so the parked parent is not blamed for it.
			const missing = perCallModelFixture("missing-model");
			expect(() => nested(missing)).toThrow(PerCallModelUnavailableError);
			expect(() => nested(missing)).not.toThrow(`Parent agent "${parentId}"`);
			await expect(childOf(parentId)).rejects.toThrow(`Parent agent "${parentId}"`);
			await expect(childOf(parentId, rootModel)).rejects.toThrow(/not approved/);

			// The root session is the real parent of its direct children.
			const direct = await childOf("Main", rootModel);
			expect(direct(rootModel)).toBeUndefined();
			expect(() => direct(parentModel)).toThrow(/not approved/);
		} finally {
			registry.unregister(parentId);
		}
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
		expect(cfgAdvisorEnabled.get(advised)).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(cfgAdvisorEnabled.get(roleAdvised)).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(cfgAdvisorEnabled.get(unadvised)).toBe(false);
	});

	it("keeps a nested spawn's owner-resolved advisor when reviving under root settings with a different advisor", async () => {
		const cwd = makeTempDir("@pi-nested-advisor-revive-");
		// What spawn persists for `@advisor:high` under a parent subagent whose advisor role is Sonnet.
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, "anthropic/claude-sonnet-4-5:high");
		const rootSettings = Settings.isolated({ modelRoles: { advisor: "anthropic/claude-haiku-4-5" } });
		let captured: Settings | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			captured = options?.settings;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { settings: rootSettings })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(captured?.getModelRole("advisor")).toBe("anthropic/claude-sonnet-4-5:high");
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
		const parentCompaction = cfgCompaction.get(parentSettings);
		const revivedCompaction = cfgCompaction.get(revivedSettings);
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

	it("reinstalls the spawn's subagent fallback chain so it still routes at a changed effort (#13789)", async () => {
		const cwd = makeTempDir("@pi-revive-retry-fallback-");
		const sessionFile = await createPersistedSession(cwd, false, "task", undefined, {
			retryFallback: { primary: "xai-oauth/grok-4.7:high", chain: ["openai/gpt-4o-mini"] },
		});
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const revivedSettings = capturedOptions?.settings;
		if (!revivedSettings) throw new Error("Expected revived child settings");
		const grok = getBundledModel("xai-oauth", "grok-4.7");
		const context: RetryFallbackResolutionContext = {
			chains: getRetryFallbackChains(revivedSettings),
			getModelRole: role => revivedSettings.getModelRole(role),
			modelLookup: {
				find: (provider, id) => (provider === grok.provider && id === grok.id ? grok : undefined),
				hasProvider: provider => provider === grok.provider,
			},
		};
		const live = "xai-oauth/grok-4.7:xhigh";
		const chainKey = resolveRetryFallbackChainKey(context, live, grok);
		expect(chainKey).toBe("subagent:persisted-restricted");
		if (!chainKey) throw new Error("Expected the revived subagent chain");
		expect(findRetryFallbackCandidates(context, chainKey, live, grok).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini",
		]);
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance(fakeMcpManager(() => []));
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
		MCPManager.setInstance(fakeMcpManager(() => []));
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
		// The relay's rescan reads the live-bridge registry under the session's
		// agentDir. Point it at an empty temp dir so the machine's real bridges
		// (other omp sessions) can never leak discovery fetches into these
		// tests — the unmatched-URL test asserts zero network calls.
		let agentDirBackup: string | undefined;
		beforeAll(() => {
			agentDirBackup = process.env.PI_CODING_AGENT_DIR;
			const dir = makeTempDir("@pi-revive-a2a-agentdir-");
			setAgentDir(dir);
		});
		afterAll(() => {
			// Restore the default resolver state the process started with.
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			if (agentDirBackup === undefined) delete process.env.PI_CODING_AGENT_DIR;
		});
		async function reviveWithWaker(cwd: string): Promise<{ ref: AgentRef; handle: RevivedSessionHandle }> {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			const sessionFile = await createPersistedSession(cwd);
			MCPManager.setInstance(fakeMcpManager(() => []));
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

		const wakeRecord = (from: string, hops?: string[]): CustomMessage => ({
			role: "custom",
			customType: "irc:incoming",
			content: "send me the full table",
			display: true,
			details: { id: "irc-42", from, message: "send me the full table", ...(hops ? { hops } : {}) },
			attribution: "agent",
			timestamp: Date.now(),
		});

		const externalRecord = (messageId: string, extra: Record<string, unknown> = {}): CustomMessage => ({
			...wakeRecord("a2a"),
			details: { id: `irc-${messageId}`, from: "a2a", external: true, a2aMessageId: messageId, ...extra },
		});

		async function externalHarness(blockSend = false) {
			const cwd = makeTempDir("@pi-revive-a2a-wake-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const calls: Array<{
				method: string;
				params: { message: { parts: Array<{ text: string }> }; metadata: Record<string, unknown> };
			}> = [];
			const { promise: blocked, resolve: unblock } = Promise.withResolvers<void>();
			const { promise: called, resolve: notifyCall } = Promise.withResolvers<void>();
			const { promise: calledTwice, resolve: notifySecondCall } = Promise.withResolvers<void>();
			/** Switched on by a test: every RPC answers with a JSON-RPC error, so the send fails. */
			let failRpc = false;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const body = (await request.json()) as {
						id: unknown;
						method: string;
						params: (typeof calls)[number]["params"];
					};
					calls.push(body);
					notifyCall();
					if (calls.length === 2) notifySecondCall();
					if (failRpc)
						return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } });
					if (blockSend) await blocked;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							task: {
								id: "peer",
								status: { state: "TASK_STATE_WORKING" },
								metadata: { delivery: { outcome: "injected" } },
							},
						},
					});
				},
			});
			handle.session.a2aBridge.add({
				name: "a2a:peer",
				skillId: "peer",
				description: "peer",
				cardName: "peer",
				url: `http://127.0.0.1:${server.port}/`,
			});
			const busSend = vi.spyOn(IrcBus.global(), "send");
			const note = (messageId: string, fromUrl?: string) =>
				IncomingRequests.global().note({
					to: ref.id,
					from: "peer",
					messageId,
					at: Date.now(),
					...(fromUrl !== undefined ? { fromUrl } : {}),
				});
			const finish = async (
				records: CustomMessage[],
				stop: LastAssistantStop = { stopReason: "stop", content: [{ type: "text", text: "answer" }] },
				duringTurn?: () => Promise<void>,
			) => {
				const observer = handle.observer();
				if (!observer) throw new Error("wake observer missing");
				const complete = observer(records);
				await duringTurn?.();
				handle.setLastAssistantStop(stop);
				await complete?.();
			};
			return {
				ref,
				handle,
				calls,
				server,
				busSend,
				note,
				finish,
				called,
				calledTwice,
				unblock,
				fail: () => (failRpc = true),
			};
		}

		it("sends an external wake answer to the peer without relaying to the pseudo-sender", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				await h.finish([externalRecord("req-1")]);
				await h.called;
				expect(h.calls).toHaveLength(1);
				expect(h.calls[0]).toMatchObject({
					method: "SendMessage",
					params: { metadata: { to: "peer", inReplyTo: "req-1" }, message: { parts: [{ text: "answer" }] } },
				});
				expect(h.busSend.mock.calls.some(([message]) => message.to === "a2a")).toBe(false);
				expect(await IncomingRequests.global().list(h.ref.id)).toEqual([]);
				await settleA2aReplies();
			} finally {
				h.server.stop(true);
			}
		});

		it("sends capped published output rather than the local yield summary to an external peer", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				const report = "x".repeat(A2A_ARTIFACT_MAX_CHARS + 1000);
				const localReply = IrcBus.global().wait("Main", { from: h.ref.id }, 5000);
				await h.finish([externalRecord("req-1"), wakeRecord("Main")], { stopReason: "aborted" }, async () => {
					h.handle.emit({
						type: "tool_execution_end",
						toolCallId: "yield-1",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { report } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				const local = await localReply;
				expect(local?.body).toContain("agent://");
				await h.called;
				expect(h.calls).toHaveLength(1);
				const published = await Bun.file(path.join(path.dirname(h.ref.sessionFile!), `${h.ref.id}.md`)).text();
				expect(published.length).toBeGreaterThan(A2A_ARTIFACT_MAX_CHARS);
				expect(h.calls[0]).toMatchObject({
					params: {
						metadata: { inReplyTo: "req-1" },
						message: { parts: [{ text: published.slice(0, A2A_ARTIFACT_MAX_CHARS) }] },
					},
				});
				await settleA2aReplies();
			} finally {
				h.server.stop(true);
			}
		});

		it("wake relay published output uses the same code-point cap", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				// The wake harness publishes the yielded report inside a JSON
				// envelope (`{\n  "report": "…"`), so the filler is sized to put
				// the astral code point exactly at the 100_000th code point of
				// the *published* text: a UTF-16-unit slice at the cap would cut
				// the emoji in half and emit an unpaired high surrogate, the
				// code-point cap keeps the whole 😀 and drops the trailing "z".
				const envelopePrefixLength = [...JSON.stringify({ report: "" }, null, 2)].length - 3;
				const fillerLength = A2A_ARTIFACT_MAX_CHARS - envelopePrefixLength - 1;
				const report = "a".repeat(fillerLength) + "😀" + "z";
				const expectedPrefix = "a".repeat(fillerLength) + "😀";
				const localReply = IrcBus.global().wait("Main", { from: h.ref.id }, 5000);
				await h.finish([externalRecord("req-1"), wakeRecord("Main")], { stopReason: "aborted" }, async () => {
					h.handle.emit({
						type: "tool_execution_end",
						toolCallId: "yield-1",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { report } },
						},
						isError: false,
					} as AgentSessionEvent);
				});
				const local = await localReply;
				expect(local?.body).toContain("agent://");
				await h.called;
				expect(h.calls).toHaveLength(1);
				const published = await Bun.file(path.join(path.dirname(h.ref.sessionFile!), `${h.ref.id}.md`)).text();
				// The published artifact keeps the whole report (the JSON envelope
				// the schema-less wake harness writes around the yielded data).
				expect(published).toContain(report);
				const emitted = h.calls[0]?.params.message.parts[0]?.text;
				// The emitted answer is the code-point prefix of the published
				// JSON envelope: it must end in the complete 😀 (not its high
				// surrogate half) and drop everything after the cap.
				expect(emitted).toBe(`{\n  "report": "${expectedPrefix}`);
				expect([...(emitted ?? "")]).toHaveLength(A2A_ARTIFACT_MAX_CHARS);
				expect(emitted).not.toContain("z");
				// No new unpaired surrogate at the cut (the whole emoji survived).
				expect(emitted?.endsWith("😀")).toBe(true);
				for (let index = 0; index < (emitted?.length ?? 0); index++) {
					const unit = emitted.charCodeAt(index);
					if (unit >= 0xd800 && unit <= 0xdbff) {
						const next = emitted.charCodeAt(index + 1);
						expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
						index += 1;
					} else {
						expect(unit < 0xdc00 || unit > 0xdfff).toBe(true);
					}
				}
				await settleA2aReplies();
			} finally {
				h.server.stop(true);
			}
		});

		it("settles the relay without waiting for an unresponsive peer", async () => {
			const h = await externalHarness(true);
			try {
				await h.note("req-1");
				const finished = h.finish([externalRecord("req-1")]);
				await h.called;
				const settled = await Promise.race([finished.then(() => true), Bun.sleep(250).then(() => false)]);
				expect(settled).toBe(true);
				expect(
					await Promise.race([h.handle.trackedReplies[0].then(() => true), Bun.sleep(250).then(() => false)]),
				).toBe(true);
			} finally {
				// The turn settled without waiting for the blocked transport; release
				// the send, then drain it so the fixture teardown resets globals with
				// no send still in flight.
				h.unblock();
				await settleA2aReplies();
				h.server.stop(true);
			}
		});

		it("answers each distinct request from the same peer", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				await h.note("req-2");
				await h.finish([externalRecord("req-1"), externalRecord("req-1"), externalRecord("req-2")]);
				await h.calledTwice;
				expect(h.calls.map(call => call.params.metadata.inReplyTo).sort()).toEqual(["req-1", "req-2"]);
				expect(h.calls.map(call => call.params.message.parts[0]?.text)).toEqual(["answer", "answer"]);
				expect(await IncomingRequests.global().list(h.ref.id)).toEqual([]);
				await settleA2aReplies();
			} finally {
				h.server.stop(true);
			}
		});

		it("does not automatically answer a request explicitly claimed during the wake", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				await h.finish([externalRecord("req-1")], undefined, async () => {
					// An explicit task-tool claim leases the request while the
					// turn is live; the automatic relay must not take it back.
					const lease = await IncomingRequests.global().consume({
						to: h.ref.id,
						from: "peer",
						messageId: "req-1",
					});
					expect(lease?.request.messageId).toBe("req-1");
				});
				await settleA2aReplies();
				expect(h.calls).toEqual([]);
				expect(h.busSend.mock.calls.some(([message]) => message.to === "a2a")).toBe(false);
			} finally {
				h.server.stop(true);
			}
		});

		it("keeps a failed automatic answer open for a manual reply", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				// The peer accepts the connection but answers with a JSON-RPC
				// error, so the send fails and the lease must be released.
				h.fail();
				await h.finish([externalRecord("req-1")]);
				await h.called;
				await settleA2aReplies();
				expect((await IncomingRequests.global().list(h.ref.id)).map(request => request.messageId)).toEqual([
					"req-1",
				]);
			} finally {
				h.server.stop(true);
			}
		});

		it("refuses an ambiguous sender through the subagent relay and keeps it manually answerable", async () => {
			const h = await externalHarness();
			try {
				// A second registration advertises the same skill id from a
				// different endpoint, and the request carries no fromUrl to
				// disambiguate: the executor relay must refuse to pick one.
				h.handle.session.a2aBridge.add({
					name: "a2a:peer",
					skillId: "peer",
					description: "peer twin",
					cardName: "peer",
					url: "http://127.0.0.1:1/",
				});
				await h.note("req-amb");
				await h.finish([externalRecord("req-amb")]);
				await settleA2aReplies();
				expect(h.calls).toEqual([]);
				expect((await IncomingRequests.global().list(h.ref.id)).map(request => request.messageId)).toEqual([
					"req-amb",
				]);
				// The manual escape hatch still works: a deliberately selected
				// runtime agent (the reachable server registration, whose base
				// name the twin's suffixing left untouched) closes it once.
				const lease = await IncomingRequests.global().consume({
					to: h.ref.id,
					from: "peer",
					messageId: "req-amb",
				});
				expect(lease?.request.messageId).toBe("req-amb");
				const manualTarget = h.handle.session.a2aBridge.get("a2a:peer")!;
				expect(manualTarget.url).toBe(`http://127.0.0.1:${h.server.port}/`);
				const outcome = await spawnA2aAgent({
					agent: manualTarget,
					prompt: "manual twin answer",
					inReplyTo: "req-amb",
				});
				expect(outcome.exitCode).toBe(0);
				expect(h.calls).toHaveLength(1);
				expect(h.calls[0]).toMatchObject({
					params: { metadata: { inReplyTo: "req-amb" }, message: { parts: [{ text: "manual twin answer" }] } },
				});
				await IncomingRequests.global().confirm(lease!.leaseId);
				expect(await IncomingRequests.global().list(h.ref.id)).toEqual([]);
				await settleA2aReplies();
			} finally {
				h.server.stop(true);
			}
		});

		it("never contacts an unmatched sender URL through the default transport", async () => {
			const h = await externalHarness();
			try {
				// The executor relay uses the real spawnA2aAgent (no send seam):
				// a request whose fromUrl matches no registered endpoint must
				// produce no network call at all — the URL is bookkeeping, never
				// a destination.
				const fetches: string[] = [];
				const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
					fetches.push(String(input));
					throw new Error("network must not be used");
				}) as unknown as typeof fetch);
				try {
					await h.note("req-unmatched", "http://127.0.0.1:7603/");
					await h.finish([externalRecord("req-unmatched")]);
					await settleA2aReplies();
					expect(h.calls).toEqual([]);
					expect(fetches).toEqual([]);
					expect((await IncomingRequests.global().list(h.ref.id)).map(request => request.messageId)).toEqual([
						"req-unmatched",
					]);
				} finally {
					fetchSpy.mockRestore();
				}
			} finally {
				h.server.stop(true);
			}
		});

		for (const [name, stop] of [
			[
				"failed",
				{ stopReason: "error", errorMessage: "provider failed", content: [{ type: "text", text: "partial" }] },
			],
			["aborted", { stopReason: "aborted", content: [{ type: "text", text: "partial" }] }],
			["empty", { stopReason: "stop", content: [] }],
		] satisfies Array<[string, LastAssistantStop]>) {
			it(`leaves external requests open after a ${name} turn`, async () => {
				const h = await externalHarness();
				try {
					await h.note("req-1");
					await h.finish([externalRecord("req-1")], stop);
					await settleA2aReplies();
					expect(h.calls).toEqual([]);
					expect((await IncomingRequests.global().list(h.ref.id)).map(request => request.messageId)).toEqual([
						"req-1",
					]);
					expect(h.busSend.mock.calls.some(([message]) => message.to === "a2a")).toBe(false);
				} finally {
					h.server.stop(true);
				}
			});
		}

		it("does not answer external replies or misidentified records", async () => {
			const h = await externalHarness();
			try {
				await h.note("req-1");
				await h.note("req-2");
				await h.finish([
					externalRecord("req-1", { a2aInReplyTo: "earlier" }),
					{ ...wakeRecord("a2a"), details: { from: "a2a", external: true } },
					{ ...wakeRecord("Main"), details: { from: "Main", a2aMessageId: "req-2" } },
				]);
				await settleA2aReplies();
				expect(h.calls).toEqual([]);
				expect(h.busSend.mock.calls.some(([message]) => message.to === "a2a")).toBe(false);
				expect(await IncomingRequests.global().list(h.ref.id)).toHaveLength(2);
			} finally {
				h.server.stop(true);
			}
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

		it("settles the turn exactly once on the registry when a wake turn finishes", async () => {
			// The wake-turn observer's finish publishes the turn's settle: one
			// `final: true` status_changed carrying the turn's answer text as the
			// summary. The harness's run-state mirror never delivers idle, so the
			// settle's reconciliation must terminalize the ref itself.
			const cwd = makeTempDir("@pi-revive-settle-");
			const { ref, handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();
			// The spy bypasses real registration: bind the revived session and
			// mark the turn running, as the live createAgentSession + revive flow
			// would, so the settle's ref-ownership check passes.
			const registry = AgentRegistry.global();
			expect(registry.attachSession(ref.id, handle.session as never, ref.sessionFile, registry.get(ref.id))).toBe(
				true,
			);
			registry.setStatus(ref.id, "running", registry.get(ref.id));
			const finals: Array<{ id: string; summary?: string }> = [];
			const unsubscribe = registry.onChange(event => {
				if (event.type === "status_changed" && event.final === true)
					finals.push({ id: event.ref.id, summary: event.summary });
			});
			try {
				const finish = observer?.([wakeRecord("Main")]);
				handle.setLastAssistantText("Turn answer");
				await finish?.();
				await handle.trackedReplies[0];

				expect(finals).toEqual([{ id: ref.id, summary: "Turn answer" }]);
				expect(AgentRegistry.global().get(ref.id)?.status).toBe("idle");
			} finally {
				unsubscribe();
				AgentLifecycleManager.resetGlobalForTests();
				AgentRegistry.resetGlobalForTests();
				IrcBus.resetGlobalForTests();
			}
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
		it("does not relay the output of a turn woken by a progress notice", async () => {
			const cwd = makeTempDir("@pi-revive-relay-progress-");
			const { handle } = await reviveWithWaker(cwd);
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
			const record: CustomMessage = {
				...wakeRecord("Peer"),
				details: { id: "idle-1", from: "Peer", message: "Peer is idle", progress: true },
			};
			const finish = handle.observer()?.([record]);
			handle.setLastAssistantText("Acknowledged");
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
			// The waker's chain rides along, so the relay extends it instead of
			// starting a fresh one (`irc.maxHops` is what stops an agent loop).
			const finish = observer?.([wakeRecord("Main", ["Upstream"])]);
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
			expect(notice?.hops).toEqual(["Upstream", ref.id]);
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

describe("cold revival replays the system prompt the last request sent", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.global().unregister("prompt-blocks");
		AgentRegistry.global().unregister("Peer");
	});

	function createTool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: `${name} tool`,
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: { status: "success", data: {} } };
			},
		};
	}

	interface RecordingSession {
		session: AgentSession;
		/** System blocks of each provider request, in order. */
		requests: string[][];
		/** Tool names and descriptions of each provider request, in order. */
		toolRequests: string[];
	}

	interface ExtensionHooks {
		sessionStart?: () => void;
		/** A `before_agent_start` handler; a returned prompt replaces the turn's system prompt. */
		beforeAgentStart?: (session: AgentSession, systemPrompt: string[]) => Promise<string[] | undefined>;
		/** Runs right before each model call reads the system prompt. */
		beforeModelCall?: (session: AgentSession) => Promise<void>;
	}

	/**
	 * A real AgentSession on a scripted model, recording each request's system blocks. The prompt
	 * builder renders the active tool names into its own block, as the SDK's builder does.
	 */
	function createRecordingSession(
		sessionManager: SessionManager,
		buildPrompt: (toolNames: string[]) => string[],
		responses: MockResponseSource,
		hooks: ExtensionHooks = {},
		toolNames: string[] = ["read"],
	): RecordingSession {
		const mock = createMockModel({ responses, handler: { content: ["done"] } });
		const requests: string[][] = [];
		const toolRequests: string[] = [];
		const owner: { session?: AgentSession } = {};
		// Like the real yield tool, its wire definition carries the active work-pool items.
		const yieldTool: AgentTool = {
			...createTool("yield"),
			get description() {
				const items = owner.session?.getWorkPoolYieldItems() ?? [];
				return `yield tool${items.map(item => ` ${item.id}#${item.index}`).join("")}`;
			},
		};
		const tools = [...toolNames.map(createTool), yieldTool];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: buildModel({
					id: "mock",
					name: "mock",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 2048,
				}),
				systemPrompt: buildPrompt(tools.map(tool => tool.name)),
				tools,
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				requests.push([...(context.systemPrompt ?? [])]);
				toolRequests.push(JSON.stringify(context.tools?.map(tool => [tool.name, tool.description])));
				return mock.stream(model, context, streamOptions);
			},
		});
		const session: AgentSession = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: {
				getApiKey: async () => "test-key",
				getAvailable: () => [],
				find: () => agent.state.model,
				hasConfiguredAuth: () => true,
			} as never,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner: {
				initialize: () => {},
				onError: () => () => {},
				hasHandlers: () => false,
				emit: async (event: { type: string }) => {
					if (event.type === "session_start") hooks.sessionStart?.();
				},
				emitBeforeAgentStart: async (_prompt: string, _images: unknown, systemPrompt: string[]) => {
					const override = await hooks.beforeAgentStart?.(session, systemPrompt);
					return override ? { systemPrompt: override } : undefined;
				},
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: buildPrompt(toolNames) }),
		});
		owner.session = session;
		const { beforeModelCall } = hooks;
		if (beforeModelCall) agent.addBeforeModelCallHook(() => beforeModelCall(session));
		sessions.push(session);
		return { session, requests, toolRequests };
	}

	const spawnResponses = (): MockResponse[] => [
		{ content: [{ type: "toolCall", name: "yield", arguments: {} }] },
		{ content: ["done"] },
	];

	/** Spawns through runSubprocess on a real session, then returns its live session and requests. */
	async function spawn(
		cwd: string,
		buildPrompt: (toolNames: string[], options?: CreateAgentSessionOptions) => string[],
		responses: MockResponseSource,
		hooks?: ExtensionHooks,
		toolNames?: string[],
	): Promise<RecordingSession> {
		let spawned: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			spawned = createRecordingSession(
				options!.sessionManager!,
				names => buildPrompt(names, options),
				responses,
				hooks,
				toolNames,
			);
			// The SDK registers a spawned child, which keeps it live after it yields.
			AgentRegistry.global().register({
				id: "prompt-blocks",
				displayName: "prompt-blocks",
				kind: "sub",
				session: spawned.session,
				sessionFile: options!.sessionManager!.getSessionFile() ?? null,
				status: "running",
			});
			return { session: spawned.session } as CreateAgentSessionResult;
		});
		const result = await executorModule.runSubprocess({
			cwd,
			agent: { name: "task", description: "test", systemPrompt: "charter", source: "bundled" },
			task: "do work",
			index: 0,
			id: "prompt-blocks",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: cwd,
		});
		expect(result.exitCode).toBe(0);
		if (!spawned) throw new Error("Expected the spawn to create a session");
		return spawned;
	}

	/** Cold-revives the parked transcript the way the Agent Hub does and returns the follow-up's request. */
	async function reviveAndFollowUp(cwd: string, hooks?: ExtensionHooks): Promise<{ system: string[]; tools: string }> {
		let revived: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			const build = options!.systemPrompt;
			if (typeof build !== "function") throw new Error("Expected a system prompt builder");
			// The SDK hands every rebuild's fresh default prompt to this builder.
			const buildPrompt = (toolNames: string[]) => [build([`fresh default: ${toolNames.join(",")}`])].flat();
			revived = createRecordingSession(options!.sessionManager!, buildPrompt, [{ content: ["follow-up"] }], hooks);
			return { session: revived.session } as CreateAgentSessionResult;
		});
		const ref = { ...createRef(path.join(cwd, "prompt-blocks.jsonl")), id: "prompt-blocks" };
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const session = localSession(await reviver(ref));
		await session.prompt("follow-up");
		await session.waitForIdle();
		if (!revived) throw new Error("Expected the revive to create a session");
		return { system: revived.requests[0]!, tools: revived.toolRequests[0]! };
	}

	it("replays the blocks after a first-turn before_agent_start tool change", async () => {
		const cwd = makeTempDir("@pi-revive-first-turn-tools-");
		const buildPrompt = (toolNames: string[]) => ["base", "rules", `tools: ${toolNames.join(",")}`];
		const dropRead = {
			beforeAgentStart: async (session: AgentSession) => {
				await session.setActiveToolsByName(["yield"]);
				return undefined;
			},
		};
		const spawned = await spawn(cwd, buildPrompt, spawnResponses(), dropRead);
		expect(spawned.requests[0]).toEqual(["base", "rules", "tools: yield"]);
		await spawned.session.dispose();

		expect((await reviveAndFollowUp(cwd, dropRead)).system).toEqual(spawned.requests.at(-1)!);
	});

	it("replays the blocks after a later work-pool rebuild in the live session", async () => {
		const cwd = makeTempDir("@pi-revive-explicit-rebuild-");
		let batch = 1;
		const buildPrompt = (toolNames: string[]) => ["base", `batch ${batch}`, `tools: ${toolNames.join(",")}`];
		const spawned = await spawn(cwd, buildPrompt, spawnResponses());
		// The next work-pool batch installs its yield contract, which rebuilds the base prompt.
		batch = 2;
		await spawned.session.setWorkPoolYieldItems([{ id: "item", index: 0 }]);
		await spawned.session.prompt("next batch");
		await spawned.session.waitForIdle();
		expect(spawned.requests.at(-1)).toEqual(["base", "batch 2", "tools: read,yield"]);
		await spawned.session.dispose();

		expect((await reviveAndFollowUp(cwd)).system).toEqual(spawned.requests.at(-1)!);
	});

	it("replays the blocks after a warm revive rebuilds the base and runs a request, without the finished batch's items", async () => {
		const cwd = makeTempDir("@pi-revive-warm-rebuild-");
		let batch = 1;
		const buildPrompt = (toolNames: string[]) => ["base", `batch ${batch}`, `tools: ${toolNames.join(",")}`];
		await spawn(cwd, buildPrompt, spawnResponses());
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park("prompt-blocks");
		let warm: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			warm = createRecordingSession(options!.sessionManager!, buildPrompt, [{ content: ["next"] }]);
			return { session: warm.session } as CreateAgentSessionResult;
		});
		const live = localSession(await lifecycle.ensureLive("prompt-blocks"));
		if (!warm || live !== warm.session) throw new Error("Expected a warm revive through the lifecycle");
		// The next work-pool batch installs its yield contract, which rebuilds the base prompt.
		batch = 2;
		await live.setWorkPoolYieldItems([{ id: "item", index: 0 }]);
		await live.prompt("next batch");
		await live.waitForIdle();
		expect(warm.requests.at(-1)).toEqual(["base", "batch 2", "tools: read,yield"]);
		expect(warm.toolRequests.at(-1)).toContain("yield tool item#0");
		// The pool clears the contract when the batch finishes, without a model call.
		await live.setWorkPoolYieldItems([]);
		await lifecycle.park("prompt-blocks");

		const revived = await reviveAndFollowUp(cwd);
		expect(revived.system).toEqual(warm.requests.at(-1)!);
		expect(revived.tools).not.toContain("item#0");
	});

	it("warm-revives with the tools its spawn enabled, without the parent-owned todo", async () => {
		const cwd = makeTempDir("@pi-revive-warm-tools-");
		const buildPrompt = (toolNames: string[]) => ["base", `tools: ${toolNames.join(",")}`];
		const spawned = await spawn(cwd, buildPrompt, spawnResponses(), {}, ["read", "todo"]);
		const spawnedTools = spawned.session.getEnabledToolNames();
		expect(spawnedTools).not.toContain("todo");
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park("prompt-blocks");
		let warm: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			warm = createRecordingSession(options!.sessionManager!, buildPrompt, [{ content: ["next"] }], {}, [
				"read",
				"todo",
			]);
			return { session: warm.session } as CreateAgentSessionResult;
		});
		const live = localSession(await lifecycle.ensureLive("prompt-blocks"));
		if (!warm || live !== warm.session) throw new Error("Expected a warm revive through the lifecycle");
		expect(live.getEnabledToolNames()).toEqual(spawnedTools);
		await live.prompt("next");
		await live.waitForIdle();
		expect(warm.requests.at(-1)).toEqual(spawned.requests.at(-1)!);
		expect(warm.toolRequests.at(-1)).toBe(spawned.toolRequests.at(-1)!);
	});

	/** The executor's own subagent prompt over a default block listing the active tools. */
	function subagentPrompt(toolNames: string[], options?: CreateAgentSessionOptions): string[] {
		const build = options?.systemPrompt;
		if (typeof build !== "function") throw new Error("Expected a system prompt builder");
		return [build([`default: ${toolNames.join(",")}`])].flat();
	}

	function registerPeer(): void {
		AgentRegistry.global().register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "running",
		});
	}

	/** Parks the spawned subagent, lets `whileParked` change the registry, and warm-revives it. */
	async function parkAndRevive(
		whileParked: () => void,
		hooks?: ExtensionHooks,
	): Promise<{ live: AgentSession; warm: RecordingSession }> {
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park("prompt-blocks");
		whileParked();
		let warm: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			warm = createRecordingSession(
				options!.sessionManager!,
				names => subagentPrompt(names, options),
				[{ content: ["next"] }],
				hooks,
			);
			return { session: warm.session } as CreateAgentSessionResult;
		});
		const live = localSession(await lifecycle.ensureLive("prompt-blocks"));
		if (!warm || live !== warm.session) throw new Error("Expected a warm revive through the lifecycle");
		await live.prompt("next");
		await live.waitForIdle();
		return { live, warm };
	}

	it("warm-revives with the system prompt it was sent with after a peer joins, and keeps it on rebuild", async () => {
		const cwd = makeTempDir("@pi-revive-warm-roster-");
		const spawned = await spawn(cwd, subagentPrompt, spawnResponses());
		expect(spawned.requests.at(-1)!.join("\n")).toContain("(no other agents)");
		const { live, warm } = await parkAndRevive(registerPeer);
		expect(warm.requests[0]).toEqual(spawned.requests.at(-1)!);
		// A rebuild after the revive keeps the roster too: a live one would rewrite the cached conversation.
		const revivedPrompt = [...live.systemPrompt];
		await live.refreshBaseSystemPrompt();
		expect(live.systemPrompt).toEqual(revivedPrompt);
	});

	// Peer rows carry live activity, so a rebuild that collected the roster again changed the prompt's
	// bytes and the provider wrote the whole conversation to its prompt cache again. A rebuild whose
	// default blocks change loses the cached prefix anyway, so the roster catches up there.
	it("keeps a live subagent's roster across a rebuild until the rest of its prompt changes", async () => {
		const cwd = makeTempDir("@pi-live-rebuild-roster-");
		AgentRegistry.global().register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "running",
			activity: "reading a.ts",
		});
		const spawned = await spawn(cwd, subagentPrompt, spawnResponses());
		const sentPrompt = spawned.requests.at(-1)!;
		expect(sentPrompt.join("\n")).toContain("`Peer` — Peer (sub, running): reading a.ts");

		AgentRegistry.global().setActivity("Peer", "editing b.ts");
		await spawned.session.refreshBaseSystemPrompt();
		await spawned.session.prompt("next");
		await spawned.session.waitForIdle();
		expect(spawned.requests.at(-1)).toEqual(sentPrompt);

		await spawned.session.setActiveToolsByName(["read"]);
		expect(spawned.session.systemPrompt.join("\n")).toContain("`Peer` — Peer (sub, running): editing b.ts");
	});

	it("warm-revives with the roster its prompt held, not one a discarded rebuild rendered", async () => {
		const cwd = makeTempDir("@pi-revive-discarded-roster-");
		const spawned = await spawn(cwd, subagentPrompt, spawnResponses());
		registerPeer();
		await spawned.session.refreshBaseSystemPrompt(() => false);
		expect(spawned.session.systemPrompt.join("\n")).not.toContain("`Peer`");
		const { warm } = await parkAndRevive(() => AgentRegistry.global().unregister("Peer"));
		expect(warm.requests[0]).toEqual(spawned.requests.at(-1)!);
	});

	it("warm-revives with the roster its base held when a before_agent_start hook rewrites the prompt", async () => {
		const cwd = makeTempDir("@pi-revive-hooked-roster-");
		const mergeBlocks = {
			beforeAgentStart: async (_session: AgentSession, systemPrompt: string[]) => [
				`${systemPrompt.join("\n\n")}\n\nhooked`,
			],
		};
		const spawned = await spawn(cwd, subagentPrompt, spawnResponses(), mergeBlocks);
		expect(spawned.requests.at(-1)).toHaveLength(1);
		const { warm } = await parkAndRevive(registerPeer, mergeBlocks);
		expect(warm.requests[0]).toEqual(spawned.requests.at(-1)!);
	});

	it("replays the base a before_agent_start override was built from when the base rebuilds in the request window", async () => {
		const cwd = makeTempDir("@pi-revive-override-window-");
		let batch = 1;
		const buildPrompt = (toolNames: string[]) => ["base", `batch ${batch}`, `tools: ${toolNames.join(",")}`];
		const appendPolicy = async (_session: AgentSession, systemPrompt: string[]) => [...systemPrompt, "policy"];
		let rebuildInWindow = false;
		const spawned = await spawn(cwd, buildPrompt, [...spawnResponses(), { content: ["next"] }], {
			beforeAgentStart: appendPolicy,
			// A rebuild between the hook and the request leaves the turn's override on the wire.
			beforeModelCall: async session => {
				if (!rebuildInWindow) return;
				rebuildInWindow = false;
				batch = 2;
				await session.refreshBaseSystemPrompt();
			},
		});
		rebuildInWindow = true;
		await spawned.session.prompt("next");
		await spawned.session.waitForIdle();
		expect(spawned.requests.at(-1)).toEqual(["base", "batch 1", "tools: read,yield", "policy"]);
		await spawned.session.dispose();

		expect((await reviveAndFollowUp(cwd, { beforeAgentStart: appendPolicy })).system).toEqual(
			spawned.requests.at(-1)!,
		);
	});

	it("re-reads the contract after a same-path reload restores an older one", async () => {
		const cwd = makeTempDir("@pi-revive-same-path-reload-");
		let batch = 1;
		const buildPrompt = (toolNames: string[]) => ["base", `batch ${batch}`, `tools: ${toolNames.join(",")}`];
		const spawned = await spawn(cwd, buildPrompt, [
			...spawnResponses(),
			{ content: ["next"] },
			{ content: ["again"] },
		]);
		const sessionFile = path.join(cwd, "prompt-blocks.jsonl");
		await spawned.session.sessionManager.flush();
		const beforeBatch = await Bun.file(sessionFile).text();
		batch = 2;
		await spawned.session.setWorkPoolYieldItems([{ id: "item", index: 0 }]);
		await spawned.session.prompt("next batch");
		await spawned.session.waitForIdle();
		// An older transcript, whose latest contract is the batch-1 one, is restored and reloaded.
		await spawned.session.sessionManager.flush();
		await Bun.write(sessionFile, beforeBatch);
		await spawned.session.reload();
		await spawned.session.prompt("again");
		await spawned.session.waitForIdle();
		expect(spawned.requests.at(-1)).toEqual(["base", "batch 2", "tools: read,yield"]);
		await spawned.session.dispose();

		const revived = await reviveAndFollowUp(cwd);
		expect(revived.system).toEqual(spawned.requests.at(-1)!);
		expect(revived.tools).toBe(spawned.toolRequests.at(-1)!);
	});

	it("keeps a finished child in the Agent Hub when startup extensions append many entries", async () => {
		const cwd = makeTempDir("@pi-revive-hub-prefix-");
		const parentFile = path.join(cwd, "parent.jsonl");
		await Bun.write(
			parentFile,
			`${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd })}\n`,
		);
		const childrenDir = path.join(cwd, "parent");
		fs.mkdirSync(childrenDir);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			const sessionManager = options!.sessionManager!;
			// A session_start extension that records its own state on startup.
			const { session } = createRecordingSession(sessionManager, () => ["base"], spawnResponses(), {
				sessionStart: () => {
					for (let index = 0; index < 64; index++) sessionManager.appendCustomEntry("ext-state", { index });
				},
			});
			return { session } as CreateAgentSessionResult;
		});
		const result = await executorModule.runSubprocess({
			cwd,
			agent: { name: "task", description: "test", systemPrompt: "charter", source: "bundled" },
			task: "do work",
			index: 0,
			id: "prompt-blocks",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			sessionFile: parentFile,
			artifactsDir: childrenDir,
		});
		expect(result.exitCode).toBe(0);

		const restored = new AgentRegistry();
		await registerPersistedSubagents(restored, parentFile);
		expect(restored.get("prompt-blocks")?.status).toBe("parked");
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
