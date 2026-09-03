/**
 * Per-agent prewalk resolution in `runSubprocess`: the agent definition's
 * `prewalk` frontmatter and the `task.agentPrewalk` settings override decide
 * whether the spawned session gets a `prewalk` hand-off config, which target
 * model it resolves to, and when the hand-off is skipped (override off,
 * target identical to the starting model).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function yieldEmittingSession(
	initialTools: string[] = ["read", "yield"],
	modelSwitch?: { from: Model; to: Model },
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let activeTools = initialTools;
	// `servingModel` mirrors the real session: attribution names the model that
	// produced output, so a prewalk hand-off moves it along with `model`.
	const serving = (model: Model | undefined): { selector: string; isFallback: boolean } | undefined =>
		model ? { selector: `${model.provider}/${model.id}`, isFallback: false } : undefined;
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: modelSwitch?.from,
		servingModel: serving(modelSwitch?.from),
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => activeTools,
		getEnabledToolNames: () => activeTools,
		getAllToolNames: () => activeTools,
		setActiveToolsByName: async (toolNames: string[]) => {
			activeTools = toolNames;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			if (modelSwitch) {
				session.model = modelSwitch.to;
				session.servingModel = serving(modelSwitch.to);
				for (const listener of listeners) {
					listener({ type: "notice", level: "info", message: "Prewalk switched", source: "prewalk" });
				}
			}
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-prewalk",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
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

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function modelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model ${id}`);
	return model;
}

function createModelRegistry(models: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess per-agent prewalk", () => {
	const primary = modelOrThrow("claude-sonnet-4-5");
	const target = modelOrThrow("claude-sonnet-4-6");

	function baseOptions(id: string, settings: Settings) {
		return {
			cwd: "/tmp",
			task: "do work",
			index: 0,
			id,
			settings,
			modelRegistry: createModelRegistry([primary, target]),
			enableLsp: false,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a frontmatter prewalk pattern to a target for the spawned session", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-frontmatter", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
		expect(forwarded?.prewalk?.target.provider).toBe(target.provider);
	});

	it("waits for background discovery before resolving a configured prewalk target", async () => {
		const models = [primary];
		const registry = createModelRegistry(models);
		const refreshGate = Promise.withResolvers<void>();
		vi.spyOn(registry, "awaitBackgroundRefresh").mockImplementation(async () => {
			await refreshGate.promise;
			models.push(target);
		});
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const run = runSubprocess({
			...baseOptions("subagent-prewalk-discovery", Settings.isolated()),
			modelRegistry: registry,
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});
		expect(spy).not.toHaveBeenCalled();

		refreshGate.resolve();
		expect((await run).exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("reports the prewalk target as the active model after handoff", async () => {
		const progressModels: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(yieldEmittingSession(["read", "yield"], { from: primary, to: target })),
		);

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-progress-model", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
			onProgress: progress => {
				if (progress.resolvedModel) progressModels.push(progress.resolvedModel);
			},
		});

		expect(result.exitCode).toBe(0);
		expect(progressModels.at(-1)).toBe(`${target.provider}/${target.id}`);
	});

	it("resolves prewalk: true through the smol role default target", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-default-target", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`], prewalk: true },
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
	});

	it("task.agentPrewalk 'off' disables a frontmatter-enabled prewalk", async () => {
		const settings = Settings.isolated();
		settings.set("task.agentPrewalk", { task: "off" });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-off", settings),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
	});

	it("task.agentPrewalk 'on' enables prewalk for an agent without frontmatter", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		settings.set("task.agentPrewalk", { task: "on" });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-on", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("task.prewalk arms the bundled generic task agent without frontmatter", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		settings.set("task.prewalk", true);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-on", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("task.prewalk defaults off and leaves other bundled agents alone when on", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const offByDefault = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-default", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});
		expect(offByDefault.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();

		settings.set("task.prewalk", true);
		const otherAgent = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-other-agent", settings),
			agent: { ...baseAgent, name: "sonic", model: [`${primary.provider}/${primary.id}`] },
		});
		expect(otherAgent.exitCode).toBe(0);
		expect(spy.mock.calls[1]?.[0]?.prewalk).toBeUndefined();
	});

	it("skips prewalk when the target resolves to the starting model", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-same-model", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${primary.provider}/${primary.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
	});
	it("keeps the todo tool active for a prewalk-armed subagent (the todo gate needs it)", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-todo-kept", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).toContain("todo");
	});

	it("strips the parent-owned todo tool from non-prewalk subagents", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions("subagent-no-prewalk-todo-stripped", Settings.isolated()),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).not.toContain("todo");
		expect(session.getActiveToolNames()).toContain("read");
	});
});
// Plan-mode spawns are read-only exploration: the task tool must strip a
// prewalk-enabled agent definition before spawning so the hidden
// plan/implement nudges never reach an agent without edit tools.
describe("task tool plan-mode prewalk guard", () => {
	const prewalkAgent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
		prewalk: true,
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function toolSession(planMode: boolean): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getPlanModeState: () => (planMode ? { enabled: true, planFilePath: "local://PLAN.md" } : undefined),
		} as unknown as ToolSession;
	}

	async function spawnedAgentPrewalk(planMode: boolean): Promise<boolean | string | undefined> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [prewalkAgent],
			projectAgentsDir: null,
		});
		let forwarded: AgentDefinition | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options): Promise<SingleResult> => {
			forwarded = options.agent;
			return {
				index: options.index ?? 0,
				id: options.id ?? "X",
				agent: "task",
				agentSource: "bundled",
				task: "t",
				assignment: "do the thing",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			};
		});
		const tool = await TaskTool.create(toolSession(planMode));
		await tool.execute("tc", { task: "explore the thing" });
		expect(forwarded).toBeDefined();
		return forwarded?.prewalk;
	}

	it("strips prewalk from the agent definition while plan mode is active", async () => {
		expect(await spawnedAgentPrewalk(true)).toBeUndefined();
	});

	it("keeps the agent definition's prewalk outside plan mode", async () => {
		expect(await spawnedAgentPrewalk(false)).toBe(true);
	});
});
