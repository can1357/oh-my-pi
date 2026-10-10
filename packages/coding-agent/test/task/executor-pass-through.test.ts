import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";
import { manyToolName } from "../fixtures/many-tools-mcp";
import { TempDir, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function createMockSession(
	onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void | Promise<void>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: SessionManager.inMemory(baseOptions.cwd),
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		dispose: async () => {
			await session.sessionManager.close();
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await onPrompt({ emit });
			return true;
		},
	};
	sessionManagers.push(session.sessionManager);
	return session as unknown as AgentSession;
}

function emitYield(emit: (event: AgentSessionEvent) => void): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "tool-pass-through",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	});
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => emitYield(emit));
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
	model: ["routing-test/primary"],
};

let baseOptions: ExecutorOptions;
let modelFixture: TaskModelFixture;
const resources: Array<{ dir: TempDir; authStorage?: AuthStorage }> = [];
const sessionManagers: SessionManager[] = [];

beforeEach(() => {
	modelFixture = createTaskModelFixture();
	const dir = TempDir.createSync("omp-subagent-executor-");
	resources.push({ dir });
	baseOptions = {
		cwd: dir.path(),
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-contract",
		settings: Settings.isolated(),
		modelRegistry: modelFixture.modelRegistry,
		enableLsp: false,
	};
});

afterEach(async () => {
	await Promise.all(sessionManagers.splice(0).map(manager => manager.close()));
	vi.restoreAllMocks();
	modelFixture.close();
	for (const { dir, authStorage } of resources.splice(0)) {
		authStorage?.close();
		await dir.remove();
	}
});

function createModelRegistry(
	model: NonNullable<ProviderConfigInput["models"]>[number] & { provider: string },
): ModelRegistry {
	const dir = TempDir.createSync("omp-executor-model-floor-");
	const authStorage = createInMemoryAuthStorage();
	resources.push({ dir, authStorage });
	const registry = new ModelRegistry(authStorage, dir.join("models.yml"));
	registry.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "test-key",
		models: [model],
	});
	return registry;
}

describe("runSubprocess persisted worker contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists bridge-only tools in the enabled Code Mode set", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["eval", "yield"]);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["eval", "read", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "code-mode-child" });

		expect(result.exitCode).toBe(0);
		const init = session.sessionManager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("Missing persisted worker contract");
		expect(init.tools).toEqual(["eval", "read", "yield"]);
	});

	it("omits transport-only write from the persisted cold-revival contract", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "transport-only-child",
			agent: { ...baseAgent, tools: ["read"] },
		});

		expect(result.exitCode).toBe(0);
		const init = session.sessionManager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("Missing persisted worker contract");
		expect(init.tools).toEqual(["read", "yield"]);
	});

	it("persists write when the original subagent contract grants it", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write"] },
		});

		expect(result.exitCode).toBe(0);
		const init = session.sessionManager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("Missing persisted worker contract");
		expect(init.tools).toEqual(["read", "write", "yield"]);
	});

	it("preserves the legacy result shape when no output schema is selected", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "legacy-output-child" });

		expect(result.exitCode).toBe(0);
		expect(Object.hasOwn(result, "structuredOutput")).toBe(false);
	});

	it("rejects a spawn when task.maxEffort is below the model floor", async () => {
		const model = {
			id: "mock-high-only",
			name: "High-only fixture",
			provider: "executor-floor-test",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High] },
			input: ["text"],
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		} satisfies NonNullable<ProviderConfigInput["models"]>[number] & { provider: string };
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling-below-floor",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"executor-floor-test/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("denies an authenticated unconfigured explicit model before starting a child", async () => {
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		const result = await runSubprocess({
			...baseOptions,
			modelOverride: modelFixture.selectors.unassigned,
			explicitModelSelection: true,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not authorized");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("does not treat settings default as the live parent of an agent without a model", async () => {
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: undefined },
			settings: Settings.isolated({ modelRoles: { default: modelFixture.selectors.parent } }),
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("actual live parent");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("reports a supported exact suffix without downgrading it to the coarse effort ceiling", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const result = await runSubprocess({
			...baseOptions,
			modelOverride: `${modelFixture.selectors.primary}:high`,
			effort: "lo",
			settings: Settings.isolated({ "task.maxEffort": "low" }),
		});
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(`${modelFixture.selectors.primary}:high`);
		expect(result.resolvedThinkingLevel).toBe(Effort.High);
	});

	it("rejects unsupported exact effort instead of silently lowering it", async () => {
		const createSession = vi.spyOn(sdkModule, "createAgentSession");
		const result = await runSubprocess({
			...baseOptions,
			modelOverride: `${modelFixture.selectors.primary}:max`,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no downgrade");
		expect(createSession).not.toHaveBeenCalled();
	});
});

describe("runSubprocess per-agent compaction threshold overrides", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies the override to the named child only, not to agents that child spawns", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()))
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()));
		const rootSettings = Settings.isolated({ "compaction.thresholdTokens": 40_000 });

		const child = await runSubprocess({
			...baseOptions,
			id: "compaction-override-child",
			settings: rootSettings,
			compactionThresholdOverride: { thresholdPercent: 80, thresholdTokens: -1 },
		});
		expect(child.exitCode).toBe(0);
		const childSettings = createSession.mock.calls[0]?.[0]?.settings;
		if (!childSettings) throw new Error("Expected child settings");
		const childCompaction = cfgCompaction.get(childSettings);
		expect(resolveThresholdTokens(200_000, childCompaction)).toBe(160_000);
		expect(shouldCompact(50_000, 200_000, childCompaction)).toBe(false);
		expect(shouldCompact(160_001, 200_000, childCompaction)).toBe(true);

		// A grandchild without its own entry is spawned from the child's settings.
		const grandchild = await runSubprocess({
			...baseOptions,
			id: "compaction-override-grandchild",
			settings: childSettings,
		});
		expect(grandchild.exitCode).toBe(0);
		const grandchildSettings = createSession.mock.calls[1]?.[0]?.settings;
		if (!grandchildSettings) throw new Error("Expected grandchild settings");
		const grandchildCompaction = cfgCompaction.get(grandchildSettings);
		expect(resolveThresholdTokens(200_000, grandchildCompaction)).toBe(40_000);
		expect(shouldCompact(50_000, 200_000, grandchildCompaction)).toBe(true);
	});
});

describe("runSubprocess follows the parent's MCP manager", () => {
	const FIXTURE_PATH = path.join(import.meta.dir, "..", "fixtures", "many-tools-mcp.ts");
	const fixtureConfig = (): MCPStdioServerConfig => ({
		type: "stdio",
		command: process.execPath,
		args: [FIXTURE_PATH],
	});
	const toolOf = (server: string) => `mcp__${server}_${manyToolName(0)}`;
	let workDir: string;
	let manager: MCPManager;

	/**
	 * Connects and awaits the initial tool loads. `connectServers` alone returns after
	 * its startup window (250 ms by default), which a loaded runner outlasts while the
	 * stdio fixture spawns, leaving the server's tools unregistered.
	 */
	const connectReady = async (configs: Record<string, MCPStdioServerConfig>): Promise<void> => {
		await manager.connectServers(configs, {});
		expect(await manager.waitForStartup(0)).toEqual({ connected: Object.keys(configs), pending: [], failed: [] });
	};

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-mcp-follow-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	/** A live child that records MCP rebinds and the teardowns it registers. */
	function followingChild(onPrompt: (child: { refreshedWith: (names: string[]) => Promise<void> }) => Promise<void>) {
		const refreshed: string[][] = [];
		const disposers: Array<() => void> = [];
		const waiters: Array<{ names: string[]; resolve: () => void }> = [];
		const covers = (tools: string[], names: string[]) => names.every(name => tools.includes(name));
		/** Resolves once a rebind carries every name — awaits the signal, not a guessed delay. */
		const refreshedWith = (names: string[]): Promise<void> => {
			if (covers(refreshed.at(-1) ?? [], names)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ names, resolve });
			return promise;
		};
		const session = createMockSession(async ({ emit }) => {
			await onPrompt({ refreshedWith });
			emitYield(emit);
		});
		Object.assign(session, {
			refreshMCPTools: async (tools: CustomTool[]) => {
				const names = tools.map(tool => tool.name);
				refreshed.push(names);
				for (const waiter of waiters.splice(0)) {
					if (covers(names, waiter.names)) waiter.resolve();
					else waiters.push(waiter);
				}
			},
			addDisposer: (dispose: () => void) => {
				disposers.push(dispose);
			},
		});
		return { session, refreshed, disposers };
	}

	it("rebinds a live subagent's MCP tools when the parent adds a server and reloads mid-run", async () => {
		await connectReady({ alpha: fixtureConfig() });
		const child = followingChild(async ({ refreshedWith }) => {
			// `/mcp add bravo` then `/mcp reload` in the parent while the child runs.
			await manager.disconnectAll();
			await manager.connectServers({ alpha: fixtureConfig(), bravo: fixtureConfig() }, {});
			await refreshedWith([toolOf("alpha"), toolOf("bravo")]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(child.session));

		const result = await runSubprocess({ ...baseOptions, id: "mcp-follow-reload", mcpManager: manager });

		expect(result.exitCode).toBe(0);
		const spawnTools = spy.mock.calls[0]?.[0]?.mcpTools?.map(tool => tool.name) ?? [];
		expect(spawnTools).toContain(toolOf("alpha"));
		expect(spawnTools).not.toContain(toolOf("bravo"));

		// Session teardown releases the subscription: later reloads leave it alone.
		// disconnectAll emits synchronously, and a still-subscribed follower would
		// rebind in the microtask queued before this await resumes.
		for (const dispose of child.disposers) dispose();
		const refreshCount = child.refreshed.length;
		await manager.disconnectAll();
		expect(child.refreshed).toHaveLength(refreshCount);
	}, 20_000);

	it("replays a manager change that lands while the subagent session is still being created", async () => {
		const child = followingChild(async ({ refreshedWith }) => {
			await refreshedWith([toolOf("alpha")]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			// The server finishes connecting after proxies were minted but before bind.
			await connectReady({ alpha: fixtureConfig() });
			return createSessionResult(child.session);
		});

		const result = await runSubprocess({ ...baseOptions, id: "mcp-follow-startup", mcpManager: manager });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.mcpTools).toBeUndefined();
		expect(child.refreshed.at(-1)).toContain(toolOf("alpha"));
	}, 20_000);

	it("never rebinds an MCP proxy over an explicitly supplied same-name child tool", async () => {
		// Kernel-defined (eval) tools reach children through `customTools` and may
		// carry `mcp__…` names; the child's own tool must keep the name on reload.
		const kernelTool: CustomTool = {
			name: toolOf("alpha"),
			label: toolOf("alpha"),
			description: "Kernel-defined tool sharing an MCP tool's minted name.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "kernel" }] }),
		};
		const siblingProxy = `mcp__alpha_${manyToolName(1)}`;
		await connectReady({ alpha: fixtureConfig() });
		const child = followingChild(async ({ refreshedWith }) => {
			await manager.disconnectAll();
			await manager.connectServers({ alpha: fixtureConfig() }, {});
			await refreshedWith([siblingProxy]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(child.session));

		const result = await runSubprocess({
			...baseOptions,
			id: "mcp-follow-collision",
			mcpManager: manager,
			customTools: [kernelTool],
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.customTools).toEqual([kernelTool]);
		expect(child.refreshed.at(-1)).not.toContain(toolOf("alpha"));
	}, 20_000);
});
