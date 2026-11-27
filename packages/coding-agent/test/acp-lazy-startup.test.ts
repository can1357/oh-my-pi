import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAsyncEnabled, cfgAsyncMaxJobs } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	cfgBashAutoBackgroundEnabled,
	cfgBashAutoBackgroundThresholdMs,
} from "@oh-my-pi/pi-coding-agent/exec/settings";

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

let startupDir: TempDir;
let startupAuthStorage: AuthStorage;

beforeAll(() => {
	startupDir = TempDir.createSync("@omp-acp-startup-shared-");
	startupAuthStorage = createInMemoryAuthStorage();
});

afterAll(async () => {
	startupAuthStorage.close();
	await startupDir.remove();
});

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

class TestClient implements Client {
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

class LazyFakeSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	settings = Settings.isolated({ "plan.enabled": false });
	scopedModels: AgentSession["scopedModels"] = [];
	#disposers: Array<() => void> = [];
	refreshScopedModels?: () => Promise<void>;

	addDisposer(disposer: () => void): void {
		this.#disposers.push(disposer);
	}

	setScopedModelsRefresher(refresh: () => Promise<void>): void {
		this.refreshScopedModels = refresh;
	}

	setScopedModels(models: AgentSession["scopedModels"]): void {
		this.scopedModels = models;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	constructor(cwd: string) {
		this.sessionManager = SessionManager.inMemory(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(): void {}
	setSlashCommands(): void {}
	async setModel(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {}
	async promptCustomMessage(): Promise<void> {}
	async refreshMCPTools(): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	async switchSession(): Promise<boolean> {
		return false;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const dispose of this.#disposers) dispose();
		await this.sessionManager.close();
	}
	async reload(): Promise<void> {}
	async newSession(): Promise<boolean> {
		return false;
	}
	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	getActiveToolNames(): string[] {
		return [];
	}
	getAllToolNames(): string[] {
		return [];
	}
	setActiveToolsByName(): void {}
	setClientBridge(): void {}
	setMcpServerInstructionsSource(): void {}
	registerSessionChangeCallback(): () => void {
		return () => {};
	}
	getPlanModeState(): undefined {
		return undefined;
	}
	setPlanModeState(): void {}
	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<boolean> {
		return false;
	}
}

/**
 * Close one direction of the in-memory transport used by these tests. The ACP
 * SDK's `ndJsonStream` acquires a transient writer per message, so immediately
 * after the final response resolves on the peer the writer-release is still a
 * queued microtask. Closing while that writer is held rejects with "WritableStream
 * .close ... locked", which leaves the peer's readable open and hangs
 * `connection.closed`. Wait for the lock to clear (bounded) before closing.
 */
async function closeTransport(writable: WritableStream<unknown>): Promise<void> {
	for (let i = 0; i < 100 && writable.locked; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	await Promise.allSettled([writable.close()]);
}

// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
});

describe("ACP lazy startup", () => {
	it("applies schema defaults for ACP background jobs", async () => {
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");

		type ObservedBackgroundSettings = {
			asyncEnabled: boolean;
			asyncMaxJobs: number;
			bashAutoBackground: boolean;
			bashAutoBackgroundThresholdMs: number;
		};

		const runAcpStartup = async (settings: Settings): Promise<ObservedBackgroundSettings> => {
			const cwd = startupDir.path();
			let observed: ObservedBackgroundSettings | undefined;
			const stopMessage = "stop test ACP mode";
			try {
				await runRootCommand(
					{
						mode: "acp",
						messages: [],
						fileArgs: [],
						unknownFlags: new Map(),
						unrecognizedFlags: [],
						invalidFlagValues: [],
						noSkills: true,
						noRules: true,
						noTools: true,
						noLsp: true,
						sessionDir: cwd,
					},
					[],
					{
						discoverAuthStorage: async () => startupAuthStorage,
						settings,
						runAcpMode: async () => {
							observed = {
								asyncEnabled: cfgAsyncEnabled.get(settings),
								asyncMaxJobs: cfgAsyncMaxJobs.get(settings),
								bashAutoBackground: cfgBashAutoBackgroundEnabled.get(settings),
								bashAutoBackgroundThresholdMs: cfgBashAutoBackgroundThresholdMs.get(settings),
							};
							throw new Error(stopMessage);
						},
					},
				);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== stopMessage) {
					throw error;
				}
			}

			if (!observed) {
				throw new Error("Expected ACP mode to start");
			}
			return observed;
		};

		// An unset ACP config observes the background-job schema defaults.
		await expect(runAcpStartup(Settings.isolated())).resolves.toEqual({
			asyncEnabled: true,
			asyncMaxJobs: 100,
			bashAutoBackground: true,
			bashAutoBackgroundThresholdMs: 60000,
		});
	});

	it("honors explicit host-defaulted and todo settings for protocol hosts", async () => {
		// Regression for #3207: in RPC/ACP startup, runtime overrides applied via
		// `applyDefaultSettingOverrides` previously clobbered any explicitly
		// configured value (caller, project, --config overlay, or global) with the
		// schema default. The fix (re-)added an `isConfigured` guard so explicit
		// configuration survives, and the schema default only fills holes.
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");

		const explicit = {
			"task.isolation.enabled": true,
			"isolation.backend": "rcopy",
			"task.isolation.apply": false,
			"task.isolation.merge": "branch",
			"task.isolation.commits": "ai",
			"task.eager": "always",
			"task.batch": false,
			"task.maxConcurrency": 4,
			"task.maxRecursionDepth": 5,
			"task.disabledAgents": ["scout"],
			"task.agentModelOverrides": { task: "claude-sonnet-4-20250514" },
			"task.agentAdvisor": { task: "on" },
			"memory.backend": "local",
			"memories.enabled": true,
			"advisor.enabled": true,
			"advisor.syncBacklog": "5",
			"advisor.immuneTurns": 7,
			"todo.enabled": false,
			"todo.reminders": false,
			"todo.eager": "always",
		} as const;
		const rpcOnlyExplicit = {
			"async.enabled": false,
			"async.maxJobs": 7,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 5_000,
		} as const;
		const allPaths = [
			...(Object.keys(explicit) as (keyof typeof explicit)[]),
			...(Object.keys(rpcOnlyExplicit) as (keyof typeof rpcOnlyExplicit)[]),
		];
		type ObservedSettings = Record<string, unknown>;

		const runProtocolStartup = async (mode: "rpc" | "rpc-ui" | "acp"): Promise<ObservedSettings> => {
			const cwd = startupDir.path();
			const settings = Settings.isolated({ ...explicit, ...rpcOnlyExplicit });
			let observed: ObservedSettings | undefined;
			const stopMessage = "stop test host-defaulted settings";
			const observe = () => {
				observed = {};
				for (const key of allPaths) {
					const setting = lookup(key);
					if (!setting) throw new Error(`Unknown setting: ${key}`);
					observed[key] = setting.get(settings);
				}
				throw new Error(stopMessage);
			};

			try {
				await runRootCommand(
					{
						mode,
						messages: [],
						fileArgs: [],
						unknownFlags: new Map(),
						unrecognizedFlags: [],
						invalidFlagValues: [],
						noSkills: true,
						noRules: true,
						noTools: true,
						noLsp: true,
						noExtensions: true,
						sessionDir: cwd,
					},
					[],
					{
						discoverAuthStorage: async () => startupAuthStorage,
						settings,
						createAgentSession: async () => observe(),
						runAcpMode: async () => observe(),
					},
				);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== stopMessage) {
					throw error;
				}
			}

			if (!observed) {
				throw new Error("Expected protocol mode to start");
			}
			return observed;
		};

		for (const mode of ["rpc", "rpc-ui", "acp"] as const) {
			await expect(runProtocolStartup(mode)).resolves.toEqual({ ...explicit, ...rpcOnlyExplicit });
		}
	});

	it("answers initialize before creating the first AgentSession", async () => {
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client = new TestClient();
		let createCalls = 0;
		const creationStarted = Promise.withResolvers<void>();
		const blockedCreation = Promise.withResolvers<{
			session: AgentSession;
			setToolUIContext: () => void;
		}>();

		const agentConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(
			ndJsonStream(agentToClient.writable, clientToAgent.readable),
			async cwd => {
				creationStarted.resolve();
				createCalls++;
				if (createCalls === 1) {
					return await blockedCreation.promise;
				}
				return {
					session: new LazyFakeSession(cwd) as unknown as AgentSession,
					setToolUIContext: () => {},
				};
			},
		);

		try {
			const initializeResponse = await agentConnection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			expect(initializeResponse).toEqual(
				expect.objectContaining({
					protocolVersion: 1,
				}),
			);
			expect(createCalls).toBe(0);

			const newSessionPromise = agentConnection.newSession({ cwd: "/tmp/acp-lazy-startup", mcpServers: [] });
			await creationStarted.promise;
			expect(createCalls).toBe(1);

			blockedCreation.resolve({
				session: new LazyFakeSession("/tmp/acp-lazy-startup") as unknown as AgentSession,
				setToolUIContext: () => {},
			});
			const sessionResponse = await newSessionPromise;
			expect(sessionResponse.sessionId).toEqual(expect.any(String));
		} finally {
			await closeTransport(clientToAgent.writable);
			await closeTransport(agentToClient.writable);
			await Promise.allSettled([agentConnection.closed, serverConnection.closed]);
		}
	});

	it.each([false, true])("uses the workspace scope unless --models is explicit (%s)", async explicit => {
		using launch = TempDir.createSync("@omp-acp-scope-launch-");
		using workspace = TempDir.createSync("@omp-acp-scope-workspace-");
		const launchSelector = "openrouter/z-ai/glm-4.7";
		const workspaceSelector = "openrouter/deepseek/deepseek-chat";
		await Bun.write(launch.join(".omp/config.yml"), `enabledModels:\n  - ${launchSelector}\n`);
		await Bun.write(workspace.join(".omp/config.yml"), `enabledModels:\n  - ${workspaceSelector}\n`);
		const settings = await Settings.loadIsolated({ cwd: launch.path(), agentDir: launch.join("agent") });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("openrouter", "test-key");
		if (!explicit) authStorage.keys.setRuntime("anthropic", "other-provider-key");
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		const rawArgs = explicit ? ["--models", launchSelector] : ["--api-key", "workspace-cli-key"];
		let created: LazyFakeSession | undefined;
		try {
			await expect(
				runRootCommand(
					{
						...parseArgs(rawArgs),
						mode: "acp",
						offline: true,
						noExtensions: true,
						sessionDir: launch.join("sessions"),
					},
					rawArgs,
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async options => {
							const session = new LazyFakeSession(workspace.path());
							session.model = options?.model;
							session.settings = options?.settings ?? session.settings;
							session.scopedModels = options?.scopedModels ?? [];
							created = session;
							return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
						},
						runAcpMode: async createSession => {
							if (!explicit) {
								const other = workspace.join("other-provider");
								await Bun.write(
									path.join(other, ".omp/config.yml"),
									"enabledModels:\n  - anthropic/claude-sonnet-4-5\n",
								);
								await expect(createSession(other)).rejects.toThrow("bound to openrouter, not anthropic");
								expect(await authStorage.keys.get("anthropic")).toBe("other-provider-key");
							}
							await createSession(workspace.path());
							throw new Error("stop test ACP mode");
						},
					},
				),
			).rejects.toThrow("stop test ACP mode");
			if (!created?.model) throw new Error("Expected ACP startup model");
			const selector = explicit ? launchSelector : workspaceSelector;
			expect(formatModelString(created.model)).toBe(selector);
			if (!explicit) expect(await authStorage.keys.get(created.model.provider)).toBe("workspace-cli-key");
			expect(created.scopedModels.map(entry => formatModelString(entry.model))).toEqual([selector]);

			cfgEnabledModels.override(created.settings, explicit ? [] : [launchSelector]);
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			expect(created.scopedModels.map(entry => formatModelString(entry.model))).toEqual([launchSelector]);
		} finally {
			await created?.dispose();
			authStorage.close();
			settings.cancelPendingSaves();
		}
	});

	it.each([
		[":high", "high"],
		["", "low"],
	])("seeds a workspace session's thinking level only when --model%s sets none", async (suffix, expected) => {
		using launch = TempDir.createSync("@omp-acp-thinking-launch-");
		using workspace = TempDir.createSync("@omp-acp-thinking-workspace-");
		const selector = "openrouter/z-ai/glm-4.7";
		await Bun.write(workspace.join(".omp/config.yml"), `enabledModels:\n  - ${selector}:low\n`);
		const settings = await Settings.loadIsolated({ cwd: launch.path(), agentDir: launch.join("agent") });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("openrouter", "test-key");
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		const rawArgs = ["--model", `${selector}${suffix}`];
		let thinkingLevel: string | undefined;
		try {
			await expect(
				runRootCommand(
					{
						...parseArgs(rawArgs),
						mode: "acp",
						offline: true,
						noExtensions: true,
						sessionDir: launch.join("sessions"),
					},
					rawArgs,
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async options => {
							thinkingLevel = options?.thinkingLevel;
							return {
								session: new LazyFakeSession(workspace.path()),
								setToolUIContext: () => {},
							} as unknown as CreateAgentSessionResult;
						},
						runAcpMode: async createSession => {
							await createSession(workspace.path());
							throw new Error("stop test ACP mode");
						},
					},
				),
			).rejects.toThrow("stop test ACP mode");
			expect(thinkingLevel).toBe(expected);
		} finally {
			authStorage.close();
			settings.cancelPendingSaves();
		}
	});

	it("binds --api-key to the launch scope provider without a stored credential", async () => {
		using launch = TempDir.createSync("@omp-acp-key-launch-");
		using other = TempDir.createSync("@omp-acp-key-other-");
		using match = TempDir.createSync("@omp-acp-key-match-");
		const selector = "openrouter/z-ai/glm-4.7";
		await Bun.write(launch.join(".omp/config.yml"), `enabledModels:\n  - ${selector}\n`);
		await Bun.write(other.join(".omp/config.yml"), "enabledModels:\n  - anthropic/claude-sonnet-4-5\n");
		await Bun.write(match.join(".omp/config.yml"), `enabledModels:\n  - ${selector}\n`);
		const settings = await Settings.loadIsolated({ cwd: launch.path(), agentDir: launch.join("agent") });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "own-anthropic-key");
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		const rawArgs = ["--api-key", "fake-launch-key"];
		let created: LazyFakeSession | undefined;
		try {
			await expect(
				runRootCommand(
					{ ...parseArgs(rawArgs), mode: "acp", offline: true, noExtensions: true, sessionDir: launch.join("s") },
					rawArgs,
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async options => {
							const session = new LazyFakeSession(match.path());
							session.model = options?.model;
							created = session;
							return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
						},
						runAcpMode: async createSession => {
							await expect(createSession(other.path())).rejects.toThrow("bound to openrouter, not anthropic");
							expect(await authStorage.keys.get("anthropic")).toBe("own-anthropic-key");
							await createSession(match.path());
							throw new Error("stop test ACP mode");
						},
					},
				),
			).rejects.toThrow("stop test ACP mode");
			if (!created?.model) throw new Error("Expected ACP startup model");
			expect(formatModelString(created.model)).toBe(selector);
			expect(await authStorage.keys.get("openrouter")).toBe("fake-launch-key");
		} finally {
			await created?.dispose();
			authStorage.close();
			settings.cancelPendingSaves();
		}
	});

	it("opens a workspace without a scope on its own default once --api-key is bound", async () => {
		using launch = TempDir.createSync("@omp-acp-key-default-launch-");
		using plain = TempDir.createSync("@omp-acp-key-default-plain-");
		const selector = "openrouter/z-ai/glm-4.7";
		const openrouterModel = getBundledModel("openrouter", "z-ai/glm-4.7");
		await Bun.write(launch.join(".omp/config.yml"), `enabledModels:\n  - ${selector}\n`);
		const settings = await Settings.loadIsolated({ cwd: launch.path(), agentDir: launch.join("agent") });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "own-anthropic-key");
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		const rawArgs = ["--api-key", "fake-launch-key"];
		const sessions: LazyFakeSession[] = [];
		// Stands in for the SDK's own default-role resolution in a workspace without a startup model.
		let workspaceDefault: Model | undefined;
		try {
			await expect(
				runRootCommand(
					{ ...parseArgs(rawArgs), mode: "acp", offline: true, noExtensions: true, sessionDir: launch.join("s") },
					rawArgs,
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async options => {
							const session = new LazyFakeSession(plain.path());
							session.model = options?.model ?? workspaceDefault;
							sessions.push(session);
							return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
						},
						runAcpMode: async createSession => {
							workspaceDefault = TEST_MODEL;
							await expect(createSession(plain.path())).rejects.toThrow("bound to openrouter, not anthropic");
							workspaceDefault = openrouterModel;
							await createSession(plain.path());
							throw new Error("stop test ACP mode");
						},
					},
				),
			).rejects.toThrow("stop test ACP mode");
			expect(sessions.map(session => session.disposed)).toEqual([true, false]);
			expect(sessions[1]?.model && formatModelString(sessions[1].model)).toBe(selector);
			expect(await authStorage.keys.get("openrouter")).toBe("fake-launch-key");
			expect(await authStorage.keys.get("anthropic")).toBe("own-anthropic-key");
		} finally {
			for (const session of sessions) if (!session.disposed) await session.dispose();
			authStorage.close();
			settings.cancelPendingSaves();
		}
	});

	it("refuses --api-key at launch when neither a model nor the launch scope names its provider", async () => {
		using launch = TempDir.createSync("@omp-acp-key-unnamed-launch-");
		using workspace = TempDir.createSync("@omp-acp-key-unnamed-workspace-");
		await Bun.write(workspace.join(".omp/config.yml"), "enabledModels:\n  - openrouter/z-ai/glm-4.7\n");
		const settings = await Settings.loadIsolated({ cwd: launch.path(), agentDir: launch.join("agent") });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("openrouter", "own-openrouter-key");
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		const rawArgs = ["--api-key", "fake-launch-key"];
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		let opened = false;
		try {
			await expect(
				runRootCommand(
					{ ...parseArgs(rawArgs), mode: "acp", offline: true, noExtensions: true, sessionDir: launch.join("s") },
					rawArgs,
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async () => {
							throw new Error("session constructed");
						},
						runAcpMode: async createSession => {
							opened = true;
							await createSession(workspace.path());
							throw new Error("ACP mode started");
						},
					},
				),
			).rejects.toThrow("exit 1");
			expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("--api-key requires a model");
			expect(opened).toBe(false);
			expect(await authStorage.keys.get("openrouter")).toBe("own-openrouter-key");
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
			authStorage.close();
			settings.cancelPendingSaves();
		}
	});

	it("applies CLI runtime API keys after ACP lazy session creation resolves extension models", async () => {
		using tempDir = TempDir.createSync("@omp-acp-lazy-api-key-");
		const cwd = tempDir.path();

		await Bun.write(
			path.join(cwd, "runtime-provider.ts"),
			`export default function(pi) {
	pi.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "extension-key",
		api: "openai-completions",
		models: [{
			id: "runtime-model",
			name: "Runtime Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		}],
	});
}
`,
		);

		const authStorage = createInMemoryAuthStorage();
		try {
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
			const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
			let session: AgentSession | undefined;
			let sessionHasUI: boolean | undefined;
			let deferredUsageReserveConfirmation: boolean | undefined;

			const stopped = runRootCommand(
				{
					mode: "acp",
					apiKey: "cli-runtime-key",
					messages: [],
					fileArgs: [],
					unknownFlags: new Map(),
					unrecognizedFlags: [],
					invalidFlagValues: [],
					noSkills: true,
					noRules: true,
					noLsp: true,
					sessionDir: cwd,
					extensions: [path.join(cwd, "runtime-provider.ts")],
					model: "runtime-provider/runtime-model",
				},
				[],
				{
					discoverAuthStorage: async () => authStorage,
					createAgentSession: options => {
						const sessionOptions = options ?? {};
						sessionHasUI = sessionOptions.hasUI;
						deferredUsageReserveConfirmation = sessionOptions.deferUsageReserveConfirmation;
						return createAgentSession({
							...sessionOptions,
							workspaceTree: sessionOptions.workspaceTree ?? emptyWorkspaceTree(sessionOptions.cwd ?? cwd),
						});
					},
					settings,
					runAcpMode: async createAcpSession => {
						session = (await createAcpSession(cwd)).session;
						throw new Error("stop test ACP mode");
					},
				},
			);
			await expect(stopped).rejects.toThrow("stop test ACP mode");

			if (!session?.model) {
				throw new Error("Expected extension model to resolve");
			}
			expect(session.model.provider).toBe("runtime-provider");
			expect(await session.modelRegistry.getApiKey(session.model)).toBe("cli-runtime-key");
			expect(sessionHasUI).toBe(false);
			expect(deferredUsageReserveConfirmation).toBe(true);
			await session.dispose();
		} finally {
			authStorage.close();
		}
	}, 15_000);
});
