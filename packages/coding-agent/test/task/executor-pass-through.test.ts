/**
 * Verifies parent-discovered rules, extensions, and custom tools are forwarded
 * to `createAgentSession` so subagents skip the FS scans the parent already
 * paid for. Regression guard for issue #2190.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult, PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
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
	});
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
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function createModelRegistry(model: Model): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards rules, extension-root policy, prepared extensions, and preloaded source paths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.omp/extensions/foo.ts"];
		const preloadedPreparedExtensions: PreparedExtension[] = [
			{
				path: preloadedExtensionPaths[0]!,
				resolvedPath: preloadedExtensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];
		const extensionRoots = () => ({
			explicit: ["/abs/parent/explicit-extension"],
			mode: "explicit-only" as const,
			configured: ["/abs/parent/configured-extension"],
			configuredLevel: "project" as const,
		});

		const result = await runSubprocess({
			...baseOptions,
			rules,
			extensionRoots,
			preloadedExtensionPaths,
			preloadedPreparedExtensions,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.extensionRoots).toBe(extensionRoots);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedPreparedExtensions).toBe(preloadedPreparedExtensions);
		expect(forwarded?.preloadedCustomToolPaths).toBe(preloadedCustomToolPaths);
	});

	it("forwards an exact credential resolver without replacing it", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const getApiKey = async () => "exact-account-key";

		const result = await runSubprocess({ ...baseOptions, getApiKey });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.getApiKey).toBe(getApiKey);
	});

	it("forwards undefined when the parent has not pre-discovered state", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.rules).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toBeUndefined();
		expect(forwarded?.preloadedCustomToolPaths).toBeUndefined();
	});
	it("preserves empty and absent agent tool declarations through session creation", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const emptyFields = parseAgentFields({ name: "quiet", description: "desc", tools: [] });
		const absentFields = parseAgentFields({ name: "default", description: "desc" });
		if (!emptyFields || !absentFields) throw new Error("agent fields did not parse");

		const emptyResult = await runSubprocess({
			...baseOptions,
			id: "empty-tools-child",
			agent: { ...baseAgent, ...emptyFields },
		});
		const absentResult = await runSubprocess({
			...baseOptions,
			id: "default-tools-child",
			agent: { ...baseAgent, ...absentFields },
		});

		expect(emptyResult.exitCode).toBe(0);
		expect(absentResult.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.toolNames).toEqual(["yield", "hub"]);
		expect(spy.mock.calls[1]?.[0]?.toolNames).toBeUndefined();
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The registry parent is the spawning agent — never the child itself (the
		// self-parent bug). The child's own id still drives both its agent id and
		// its artifact/output-id prefix; those must not double as the parent link.
		expect(forwarded?.parentAgentId).toBe("SpawnerAgent");
		expect(forwarded?.agentId).toBe("ChildAgent");
		expect(forwarded?.parentTaskPrefix).toBe("ChildAgent");
	});

	it("removes all MCP and discovered capability sources for a restricted child", async () => {
		const session = yieldEmittingSession();
		const persistedInits: Array<{ restrictToolNames?: boolean; tools: string[] }> = [];
		vi.spyOn(session.sessionManager, "appendSessionInit").mockImplementation(init => {
			persistedInits.push(init);
			return "session-init";
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const preloadedExtensionPaths = ["/hostile/extensions/read.ts"];
		const preloadedPreparedExtensions: PreparedExtension[] = [
			{
				path: preloadedExtensionPaths[0]!,
				resolvedPath: preloadedExtensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "/hostile/tools/read.ts", source: { provider: "test", providerName: "Test", level: "project" } },
		];
		const getTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		const mcpManager = { getTools } as unknown as MCPManager;

		const result = await runSubprocess({
			...baseOptions,
			id: "restricted-child",
			restrictToolNames: true,
			mcpManager,
			preloadedExtensionPaths,
			preloadedPreparedExtensions,
			preloadedCustomToolPaths,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			outputSchemaMode: "strict",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.restrictToolNames).toBe(true);
		expect(forwarded?.enableMCP).toBe(false);
		expect(forwarded?.mcpManager).toBeUndefined();
		expect(forwarded?.customTools).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toEqual([]);
		expect(forwarded?.preloadedPreparedExtensions).toEqual([]);
		expect(forwarded?.preloadedCustomToolPaths).toEqual([]);
		expect(getTools).not.toHaveBeenCalled();
		expect(forwarded?.outputSchemaMode).toBe("strict");
		expect(persistedInits).toHaveLength(1);
		expect(persistedInits[0]).toMatchObject({ restrictToolNames: true, tools: ["read", "yield"] });
	});

	it("persists bridge-only tools in the enabled Code Mode set", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["eval", "yield"]);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["eval", "read", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "code-mode-child" });

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["eval", "read", "yield"] }));
	});

	it("omits transport-only write from the persisted cold-revival contract", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "transport-only-child",
			agent: { ...baseAgent, tools: ["read"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "yield"] }));
	});

	it("persists write when the original subagent contract grants it", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "write", "yield"] }));
	});

	it("retains inherited MCP proxy tools for normal children", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const mcpManager = {
			getTools: () => [{ name: "mcp__private_read", label: "private/read" }],
		} as unknown as MCPManager;

		const result = await runSubprocess({ ...baseOptions, id: "normal-child", mcpManager });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.enableMCP).toBe(true);
		expect(forwarded?.mcpManager).toBe(mcpManager);
		expect(forwarded?.customTools?.map(tool => tool.name)).toEqual(["mcp__private_read"]);
	});

	it("preserves the legacy result shape when no output schema is selected", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "legacy-output-child" });

		expect(result.exitCode).toBe(0);
		expect(Object.hasOwn(result, "structuredOutput")).toBe(false);
	});

	it("caps caller-requested effort at task.maxEffort", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// The ceiling itself rides into the session so retry-fallback recovery
		// can re-clamp to it after model swaps.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBe(Effort.Low);
	});

	it("rejects a spawn when task.maxEffort is below the model floor", async () => {
		const baseModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!baseModel) throw new Error("Expected gpt-5.6-sol model to exist");
		const model = {
			...baseModel,
			id: "mock-high-only",
			provider: "mock",
			thinking: { mode: "effort", efforts: [Effort.High] },
		} as Model;
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
			"mock/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("preserves the model's full effort range by default", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-default-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Max);
	});

	it("resolves an explicit task-role effort suffix over the agent-definition default", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}:high`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-precedence",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The user's explicit `:high` suffix on the resolved role pattern wins over
		// the agent definition's default level (e.g. task's `auto`).
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("falls back to the agent-definition thinking level without an explicit suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-default",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
	});
	it("persists an explicit role from a caller model override", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			modelRoles: { reviewer: `${model.provider}/${model.id}` },
		});
		const session = yieldEmittingSession();
		const initSpy = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-model-override-role",
			modelOverride: "@reviewer",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ modelRole: "reviewer" }));
	});
});
