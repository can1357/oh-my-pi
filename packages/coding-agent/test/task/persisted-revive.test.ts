import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createMockModel, type MockResponse, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	AgentLifecycleManager,
	type PersistedSubagentReviverFactory,
} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
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
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { RetryFallbackRole } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
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
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";
import {
	createTaskModelRoute,
	roleRouteFallbackSelectors,
	roleRouteMetadata,
	wrapRoleRouteStream,
	type RoleRouteMetadata,
} from "@oh-my-pi/pi-coding-agent/task/role-routing";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

const tempDirs: TempDir[] = [];
const authStores: AuthStorage[] = [];
const openedManagers: SessionManager[] = [];
const routeFixtures: TaskModelFixture[] = [];
const recordingSessions = new Set<AgentSession>();
const persistedSettings: Settings[] = [];
const persistedSelector = "anthropic/claude-sonnet-4-5";

beforeEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	const open = SessionManager.open;
	vi.spyOn(SessionManager, "open").mockImplementation(async (...args) => {
		const manager = await open(...args);
		openedManagers.push(manager);
		return manager;
	});
});

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

/** Inert shared manager exposing the members a revived subagent reads: its tools and change feed. */
function fakeMcpManager(getTools: () => Array<{ name: string; label: string }>): MCPManager {
	return { getTools, addToolsChangedListener: () => () => {} } as unknown as MCPManager;
}

function createRef(sessionFile: string, id = "persisted-restricted"): AgentRef {
	return {
		id,
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
		retryFallback?: RetryFallbackRole;
		resolvedModel?: string;
		roleRouting?: RoleRouteMetadata;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
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
		resolvedModel: contract?.resolvedModel ?? persistedSelector,
		advisor,
		readOnly: contract?.readOnly,
		agent: contract?.agent,
		isolated: contract?.isolated,
		retryFallback: contract?.retryFallback,
		roleRouting: contract?.roleRouting,
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
	session?: AgentSession;
	extensionRoots?: () => EffectiveExtensionRoots;
	preparedExtensions?: readonly PreparedExtension[];
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	agents?: AgentDefinition[];
	parentModel?: AgentSession["model"];
	parentThinkingLevel?: AgentSession["thinkingLevel"];
}

function createFactory(
	cwd: string,
	eventBus?: EventBus,
	owner: ReviveOwnerOptions = {},
): PersistedSubagentReviverFactory {
	const settings = owner.settings ?? Settings.isolated({ modelRoles: { revive: persistedSelector } });
	let modelRegistry = owner.modelRegistry;
	if (!modelRegistry) {
		const authStorage = owner.authStorage ?? createInMemoryAuthStorage();
		if (!owner.authStorage) authStores.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
	}
	const parentSession = {
		model: owner.parentModel,
		thinkingLevel: owner.parentThinkingLevel,
		getSessionAgents: () => owner.agents ?? [],
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
					mode: "explicit-only",
					configured: [],
					configuredLevel: "user",
				}
			);
		},
		get preparedExtensions() {
			return owner.preparedExtensions;
		},
	} as unknown as AgentSession;
	const factory = createPersistedSubagentReviverFactory({
		session: owner.session ?? parentSession,
		authStorage: modelRegistry.authStorage,
		modelRegistry,
		settings,
		enableLsp: true,
		eventBus,
	});
	return async (ref: AgentRef) => {
		const revive = await factory(ref);
		if (!revive) return undefined;
		return async (expectedRef: AgentRef) => {
			const session = await revive(expectedRef);
			recordingSessions.add(session);
			return session;
		};
	};
}

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	await Promise.all(Array.from(recordingSessions, session => session.dispose()));
	recordingSessions.clear();
	await Promise.all(openedManagers.splice(0).map(manager => manager.close()));
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	MCPManager.resetForTests();
	for (const fixture of routeFixtures.splice(0)) fixture.close();
	for (const authStorage of authStores.splice(0)) authStorage.close();
	if (persistedSettings.length > 0) {
		for (const settings of persistedSettings.splice(0)) settings.cancelPendingSaves();
		AgentStorage.close();
	}
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
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
	});

	it("strips synthetic write from legacy read-only cold revival", async () => {
		const cwd = makeTempDir("@pi-read-only-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: true,
		});
		const activeToolNames: string[][] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves explicitly writable cold-revival contracts", async () => {
		const cwd = makeTempDir("@pi-write-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: false,
		});
		const activeToolNames: string[][] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(activeToolNames).toEqual([["read", "write", "yield"]]);
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

	it("readmits a legacy exact model only from the currently selected agent's frontmatter", async () => {
		const cwd = makeTempDir("@pi-revive-current-grant-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const sessionFile = await createPersistedSession(cwd, true, undefined, undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.selectors.primary,
		});
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated(),
			modelRegistry: fixture.modelRegistry,
			agents: [
				{
					name: "ReviveWorker",
					description: "current",
					systemPrompt: "current",
					source: "user",
					model: [fixture.selectors.primary],
				},
			],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = await reviver(ref);
		try {
			expect(revived.model?.id).toBe(fixture.models.primary.id);
			expect(revived.model?.provider).toBe(fixture.models.primary.provider);
		} finally {
			await revived.dispose();
		}
	});

	it("denies a legacy model when only catalog, auth, and its old retry transcript authorize it", async () => {
		const cwd = makeTempDir("@pi-revive-transcript-grant-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const sessionFile = await createPersistedSession(cwd, true, "qa", undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.selectors.unassigned,
			retryFallback: { primary: fixture.selectors.unassigned, chain: [fixture.selectors.primary] },
		});
		const before = await Bun.file(sessionFile).text();
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ modelRoles: { qa: fixture.selectors.primary } }),
			modelRegistry: fixture.modelRegistry,
			agents: [{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" }],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await expect(reviver(ref)).rejects.toThrow(/not authorized/);
		expect(createSession).not.toHaveBeenCalled();
		expect(ref.status).toBe("parked");
		expect(await Bun.file(sessionFile).text()).toBe(before);
	});

	it("does not restore a legacy retry chain even when its exact primary is currently authorized", async () => {
		const cwd = makeTempDir("@pi-revive-legacy-retry-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const sessionFile = await createPersistedSession(cwd, true, undefined, undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.selectors.primary,
			retryFallback: { primary: fixture.selectors.primary, chain: [fixture.selectors.unassigned] },
		});
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated(),
			modelRegistry: fixture.modelRegistry,
			agents: [
				{
					name: "ReviveWorker",
					description: "current",
					systemPrompt: "current",
					source: "user",
					model: [fixture.selectors.primary],
				},
			],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = await reviver(ref);
		try {
			expect(revived.model?.id).toBe(fixture.models.primary.id);
			expect(roleRouteFallbackSelectors(revived.roleRoute!)).toEqual([]);
		} finally {
			await revived.dispose();
		}
	});

	it("readmits modern selected effort and governed retry occurrences under unchanged current roles", async () => {
		const cwd = makeTempDir("@pi-revive-modern-route-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const settings = Settings.isolated({
			modelRoles: { qa: `${fixture.selectors.primary}:high` },
			"retry.fallbackChains": { qa: [`${fixture.selectors.fallback}:high`] },
		});
		const route = await createTaskModelRoute({
			authority: { settings, agentName: "ReviveWorker" },
			modelRegistry: fixture.modelRegistry,
			selectors: ["@qa"],
			explicit: true,
		});
		const sessionFile = await createPersistedSession(cwd, true, "qa", undefined, {
			agent: "ReviveWorker",
			resolvedModel: `${fixture.selectors.primary}:high`,
			roleRouting: route.metadata,
		});
		const ref = AgentRegistry.global().register(createRef(sessionFile));
		const reviver = await createFactory(cwd, undefined, {
			settings,
			modelRegistry: fixture.modelRegistry,
			agents: [{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" }],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = await reviver(ref);
		try {
			expect(revived.model?.id).toBe(fixture.models.primary.id);
			expect(revived.thinkingLevel).toBe(Effort.High);
			expect(roleRouteFallbackSelectors(revived.roleRoute!)).toEqual([`${fixture.selectors.fallback}:high`]);
		} finally {
			await revived.dispose();
		}
	});

	it("rechecks the original operator instead of a parked nested owner's copied role and advisor grants", async () => {
		const cwd = makeTempDir("@pi-revive-nested-original-authority-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const primary = `${fixture.selectors.primary}:high`;
		const fallback = `${fixture.selectors.fallback}:high`;
		const configPath = path.join(cwd, "config.yml");
		await Bun.write(
			configPath,
			JSON.stringify({
				modelRoles: { outer: primary, nestedGrant: fallback, advisor: fallback },
				retry: { fallbackChains: { outer: [fallback] } },
			}),
		);
		const operatorSettings = await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false, "todo.enabled": false },
		});
		persistedSettings.push(operatorSettings);
		const ownerRoute = await createTaskModelRoute({
			authority: { settings: operatorSettings, agentName: "OuterWorker" },
			modelRegistry: fixture.modelRegistry,
			selectors: [primary],
			explicit: true,
		});
		const leafRoute = await createTaskModelRoute({
			authority: { settings: operatorSettings, agentName: "ReviveWorker" },
			modelRegistry: fixture.modelRegistry,
			selectors: [fallback],
			explicit: true,
		});
		const nestedOwner = new AgentSession({
			agent: new Agent({
				initialState: { model: fixture.models.primary, systemPrompt: ["nested owner"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(cwd),
			settings: executorModule.createSubagentSettings(operatorSettings, {
				modelRoles: { ...operatorSettings.getModelRoles(), advisor: fallback },
			}),
			modelRegistry: fixture.modelRegistry,
			roleRoute: ownerRoute.permit,
			inheritedSessionAgents: [
				{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" },
			],
			extensionRoots: () => ({ explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" }),
		});
		recordingSessions.add(nestedOwner);
		const registry = AgentRegistry.global();
		const ownerRef = registry.register({
			id: "OuterWorker",
			displayName: "OuterWorker",
			parentId: "Main",
			kind: "sub",
			status: "idle",
			session: nestedOwner,
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.adopt(ownerRef.id, { idleTtlMs: 0 }, ownerRef);
		await lifecycle.park(ownerRef.id);
		expect(ownerRef.session).toBeNull();
		expect(nestedOwner.isDisposed).toBe(true);
		const sessionFile = await createPersistedSession(cwd, true, undefined, undefined, {
			agent: "ReviveWorker",
			resolvedModel: fallback,
			roleRouting: leafRoute.metadata,
		});
		const ref = registry.register({ ...createRef(sessionFile, "OuterWorker.LeafWorker"), parentId: ownerRef.id });
		const reviver = await createFactory(cwd, undefined, {
			session: nestedOwner,
			settings: nestedOwner.settings,
			modelRegistry: fixture.modelRegistry,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const requests: Array<{ model: string; effort: Effort | undefined }> = [];
		const serve = async (session: AgentSession): Promise<void> => {
			const mock = createMockModel({ handler: { content: ["authorized nested work"] } });
			session.agent.streamFn = wrapRoleRouteStream(
				() => session.roleRoute,
				(model, context, options) => {
					requests.push({ model: `${model.provider}/${model.id}`, effort: options?.reasoning });
					return mock.stream(model, context, options);
				},
				fixture.modelRegistry,
			);
			await session.prompt("Continue the retained nested assignment", { runCommands: false, attribution: "agent" });
			await session.waitForIdle();
		};
		const authorized = await reviver(ref);
		await serve(authorized);
		expect(requests).toEqual([{ model: fixture.selectors.fallback, effort: Effort.High }]);
		expect(authorized.configuredThinkingLevel()).toBe(Effort.High);
		expect(authorized.isAutoThinking).toBe(false);
		expect(roleRouteMetadata(authorized.roleRoute)?.occurrences[0]).toMatchObject({
			identity: fixture.selectors.fallback,
			thinkingLevel: Effort.High,
			fixedEffort: true,
		});
		lifecycle.adopt(ref.id, { idleTtlMs: 0 }, ref);
		await lifecycle.park(ref.id);

		await Bun.write(configPath, JSON.stringify({ modelRoles: { outer: primary }, retry: { fallbackChains: {} } }));
		expect(operatorSettings.getModelRole("nestedGrant")).toBe(fallback);
		expect(nestedOwner.settings.getModelRole("nestedGrant")).toBe(fallback);
		expect(nestedOwner.settings.getModelRole("advisor")).toBe(fallback);
		const before = await Bun.file(sessionFile).text();
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		await expect(reviver(ref)).rejects.toThrow(/not authorized/);
		expect(createSession).not.toHaveBeenCalled();
		expect(operatorSettings.getModelRole("nestedGrant")).toBeUndefined();
		expect(operatorSettings.getModelRole("advisor")).toBeUndefined();
		expect(operatorSettings.getModelRole("outer")).toBe(primary);
		expect(cfgRetryFallbackChains.get(operatorSettings)).toEqual({});
		expect(nestedOwner.settings.getModelRole("nestedGrant")).toBe(fallback);
		expect(nestedOwner.settings.getModelRole("advisor")).toBe(fallback);
		expect(requests).toHaveLength(1);
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(await Bun.file(sessionFile).text()).toBe(before);

		cfgTaskAgentModelOverrides.override(operatorSettings, { ReviveWorker: fallback });
		const readmitted = await reviver(ref);
		await serve(readmitted);
		expect(requests).toEqual([
			{ model: fixture.selectors.fallback, effort: Effort.High },
			{ model: fixture.selectors.fallback, effort: Effort.High },
		]);
		expect(readmitted.configuredThinkingLevel()).toBe(Effort.High);
		expect(roleRouteMetadata(readmitted.roleRoute)?.selectedOccurrence).toBe(0);
	});

	for (const missing of ["current definition", "persisted name"] as const) {
		it(`denies modern revival with a missing ${missing} instead of trusting its role metadata`, async () => {
			const cwd = makeTempDir("@pi-revive-missing-agent-");
			const fixture = createTaskModelFixture();
			routeFixtures.push(fixture);
			const settings = Settings.isolated({ modelRoles: { qa: fixture.selectors.primary } });
			const route = await createTaskModelRoute({
				authority: { settings, agentName: "ReviveWorker" },
				modelRegistry: fixture.modelRegistry,
				selectors: ["@qa"],
				explicit: true,
			});
			const sessionFile = await createPersistedSession(cwd, true, "qa", undefined, {
				agent: missing === "persisted name" ? undefined : "ReviveWorker",
				resolvedModel: fixture.selectors.primary,
				roleRouting: route.metadata,
			});
			const createSession = vi.spyOn(sdkModule, "createAgentSession");
			const ref = createRef(sessionFile);
			const reviver = await createFactory(cwd, undefined, {
				settings,
				modelRegistry: fixture.modelRegistry,
				agents: [],
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await expect(reviver(ref)).rejects.toThrow(/agent/);
			expect(createSession).not.toHaveBeenCalled();
		});
	}

	it("denies a legacy pin after the selected agent frontmatter changes to another authenticated model", async () => {
		const cwd = makeTempDir("@pi-revive-changed-agent-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const sessionFile = await createPersistedSession(cwd, true, undefined, undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.selectors.primary,
		});
		const currentAgent: AgentDefinition = {
			name: "ReviveWorker",
			description: "current",
			systemPrompt: "current",
			source: "user",
			model: [fixture.selectors.primary],
		};
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated(),
			modelRegistry: fixture.modelRegistry,
			agents: [currentAgent],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		currentAgent.model = [fixture.selectors.fallback];
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		await expect(reviver(ref)).rejects.toThrow(/not authorized/);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("does not revive an unavailable recorded modern candidate onto another approved one", async () => {
		const cwd = makeTempDir("@pi-revive-unavailable-selection-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const settings = Settings.isolated({
			modelRoles: { qa: fixture.selectors.primary },
			"retry.fallbackChains": { qa: [fixture.selectors.fallback] },
		});
		const route = await createTaskModelRoute({
			authority: { settings, agentName: "ReviveWorker" },
			modelRegistry: fixture.modelRegistry,
			selectors: ["@qa"],
			explicit: true,
		});
		const sessionFile = await createPersistedSession(cwd, true, "qa", undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.selectors.primary,
			roleRouting: route.metadata,
		});
		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, {
			settings,
			modelRegistry: fixture.modelRegistry,
			agents: [{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" }],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		fixture.modelRegistry.suppressSelector(fixture.selectors.primary, Date.now() + 60_000);
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		await expect(reviver(ref)).rejects.toThrow(/cannot substitute/);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("denies an old live-parent selection after that parent is no longer live", async () => {
		const cwd = makeTempDir("@pi-revive-old-parent-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const settings = Settings.isolated();
		const route = await createTaskModelRoute({
			authority: {
				settings,
				agentName: "ReviveWorker",
				getParentModel: fixture.getActiveModel,
				getParentSelector: fixture.getActiveModelString,
			},
			modelRegistry: fixture.modelRegistry,
			selectors: ["@default"],
			explicit: true,
		});
		const sessionFile = await createPersistedSession(cwd, true, "default", undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.getActiveModelString(),
			roleRouting: route.metadata,
		});
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		const ref = { ...createRef(sessionFile), parentId: "OldParent" };
		AgentRegistry.global().unregister("OldParent");
		const reviver = await createFactory(cwd, undefined, {
			settings,
			modelRegistry: fixture.modelRegistry,
			agents: [{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" }],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await expect(reviver(ref)).rejects.toThrow(/not authorized|live parent/);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("can revive an old parent identity only when a current independent role grants it", async () => {
		const cwd = makeTempDir("@pi-revive-old-parent-current-grant-");
		const fixture = createTaskModelFixture();
		routeFixtures.push(fixture);
		const spawnSettings = Settings.isolated();
		const route = await createTaskModelRoute({
			authority: {
				settings: spawnSettings,
				agentName: "ReviveWorker",
				getParentModel: fixture.getActiveModel,
				getParentSelector: fixture.getActiveModelString,
			},
			modelRegistry: fixture.modelRegistry,
			selectors: ["@default"],
			explicit: true,
		});
		const sessionFile = await createPersistedSession(cwd, true, "default", undefined, {
			agent: "ReviveWorker",
			resolvedModel: fixture.getActiveModelString(),
			roleRouting: route.metadata,
		});
		const ref = AgentRegistry.global().register({ ...createRef(sessionFile), parentId: "AbsentParent" });
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated({ modelRoles: { qa: fixture.selectors.parent } }),
			modelRegistry: fixture.modelRegistry,
			agents: [{ name: "ReviveWorker", description: "current", systemPrompt: "current", source: "user" }],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = await reviver(ref);
		try {
			expect(revived.model?.id).toBe(fixture.models.parent.id);
			expect(revived.thinkingLevel).toBe(Effort.Medium);
		} finally {
			await revived.dispose();
		}
	});

	for (const change of ["effort", "duplicate", "order"] as const) {
		it(`invalidates modern revival after dependent role ${change} changes despite independent overlapping grants`, async () => {
			const cwd = makeTempDir("@pi-revive-role-change-");
			const fixture = createTaskModelFixture();
			routeFixtures.push(fixture);
			const settings = Settings.isolated({
				modelRoles: { qa: fixture.selectors.primary },
				"retry.fallbackChains": { qa: [fixture.selectors.fallback, fixture.selectors.unassigned] },
			});
			const currentAgent: AgentDefinition = {
				name: "ReviveWorker",
				description: "current",
				systemPrompt: "current",
				source: "user",
				model: [fixture.selectors.primary, fixture.selectors.fallback, fixture.selectors.unassigned],
			};
			const route = await createTaskModelRoute({
				authority: { settings, agentName: currentAgent.name, agentModel: currentAgent.model },
				modelRegistry: fixture.modelRegistry,
				selectors: ["@qa"],
				explicit: true,
			});
			const sessionFile = await createPersistedSession(cwd, true, "qa", undefined, {
				agent: currentAgent.name,
				resolvedModel: fixture.selectors.primary,
				roleRouting: route.metadata,
			});
			const before = await Bun.file(sessionFile).text();
			const ref = AgentRegistry.global().register(createRef(sessionFile, `persisted-role-${change}`));
			const reviver = await createFactory(cwd, undefined, {
				settings,
				modelRegistry: fixture.modelRegistry,
				agents: [currentAgent],
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			if (change === "effort") settings.setModelRole("qa", `${fixture.selectors.primary}:high`);
			else
				cfgRetryFallbackChains.override(settings, {
					qa:
						change === "duplicate"
							? [fixture.selectors.fallback, fixture.selectors.fallback, fixture.selectors.unassigned]
							: [fixture.selectors.unassigned, fixture.selectors.fallback],
				});
			const createSession = vi.spyOn(sdkModule, "createAgentSession");
			await expect(reviver(ref)).rejects.toThrow(/role configuration changed/);
			expect(createSession).not.toHaveBeenCalled();
			expect(ref.status).toBe("parked");
			expect(ref.session).toBeNull();
			expect(await Bun.file(sessionFile).text()).toBe(before);
		});
	}

	it("restores compaction threshold behavior after parent settings change", async () => {
		const cwd = makeTempDir("@pi-compaction-threshold-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			compactionThreshold: { thresholdPercent: 72, thresholdTokens: -1 },
		});
		const parentSettings = Settings.isolated({
			modelRoles: { revive: persistedSelector },
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

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
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
	});

	it("preserves the completed output artifact when a revived subagent answers a hub message without yielding", async () => {
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
	});

	describe("wake-turn relay", () => {
		async function reviveWithWaker(cwd: string): Promise<{ ref: AgentRef; handle: RevivedSessionHandle }> {
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
		});
	});
});

describe("cold revival replays the system prompt the last request sent", () => {
	let promptFixture: TaskModelFixture;
	const promptAgent: AgentDefinition = {
		name: "PromptWorker",
		description: "prompt replay fixture",
		systemPrompt: "charter",
		source: "user",
		model: ["routing-test/primary"],
	};
	beforeEach(() => {
		promptFixture = createTaskModelFixture();
		routeFixtures.push(promptFixture);
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
		options?: CreateAgentSessionOptions,
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
		const tools = [createTool("read"), yieldTool];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: options?.model ?? promptFixture.models.primary,
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
			modelRegistry: promptFixture.modelRegistry,
			roleRoute: options?.roleRoute,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner: {
				initialize: () => {},
				onError: () => () => {},
				disposeFileFallbacks: () => {},
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
		recordingSessions.add(session);
		return { session, requests, toolRequests };
	}

	const spawnResponses = (): MockResponse[] => [
		{ content: [{ type: "toolCall", name: "yield", arguments: {} }] },
		{ content: ["done"] },
	];

	/** Spawns through runSubprocess on a real session, then returns its live session and requests. */
	async function spawn(
		cwd: string,
		buildPrompt: (toolNames: string[]) => string[],
		responses: MockResponseSource,
		hooks?: ExtensionHooks,
	): Promise<RecordingSession> {
		let spawned: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			spawned = createRecordingSession(options!.sessionManager!, buildPrompt, responses, hooks, options);
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
			agent: promptAgent,
			task: "do work",
			index: 0,
			id: "prompt-blocks",
			settings: Settings.isolated(),
			modelRegistry: promptFixture.modelRegistry,
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
			revived = createRecordingSession(
				options!.sessionManager!,
				buildPrompt,
				[{ content: ["follow-up"] }],
				hooks,
				options,
			);
			return { session: revived.session } as CreateAgentSessionResult;
		});
		const registry = AgentRegistry.global();
		const existing = registry.get("prompt-blocks");
		const ref =
			existing ?? registry.register({ ...createRef(path.join(cwd, "prompt-blocks.jsonl")), id: "prompt-blocks" });
		if (existing) {
			registry.detachSession(existing.id, existing);
			registry.setStatus(existing.id, "parked", existing);
		}
		const reviver = await createFactory(cwd, undefined, {
			settings: Settings.isolated(),
			modelRegistry: promptFixture.modelRegistry,
			agents: [promptAgent],
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const session = await reviver(ref);
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
			warm = createRecordingSession(options!.sessionManager!, buildPrompt, [{ content: ["next"] }], {}, options);
			return { session: warm.session } as CreateAgentSessionResult;
		});
		const live = await lifecycle.ensureLive("prompt-blocks");
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
			const { session } = createRecordingSession(
				sessionManager,
				() => ["base"],
				spawnResponses(),
				{
					sessionStart: () => {
						for (let index = 0; index < 64; index++) sessionManager.appendCustomEntry("ext-state", { index });
					},
				},
				options,
			);
			return { session } as CreateAgentSessionResult;
		});
		const result = await executorModule.runSubprocess({
			cwd,
			agent: promptAgent,
			task: "do work",
			index: 0,
			id: "prompt-blocks",
			settings: Settings.isolated(),
			modelRegistry: promptFixture.modelRegistry,
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
