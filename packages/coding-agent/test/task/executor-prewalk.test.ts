/**
 * Per-agent prewalk resolution in `runSubprocess`: the agent definition's
 * `prewalk` frontmatter and the `task.agentPrewalk` settings override decide
 * whether the spawned session gets a `prewalk` hand-off config, which target
 * model it resolves to, and when the hand-off is skipped (override off,
 * target identical to the starting model).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AUTO_PREWALK_TIMEOUT_MS, type PrewalkRoute } from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgTaskAgentPrewalk, cfgTaskPrewalk } from "@oh-my-pi/pi-coding-agent/task/settings";

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
		...createSessionDefaults(),
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
			return true;
		},
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
		cfgTaskAgentPrewalk.set(settings, { task: "off" });
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
		cfgTaskAgentPrewalk.set(settings, { task: "on" });
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
		cfgTaskPrewalk.set(settings, true);
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

		cfgTaskPrewalk.set(settings, true);
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

/**
 * `task.agentPrewalkAuto`: when nothing arms prewalk unconditionally, the native
 * judge decides once per spawn whether this assignment fits the hand-off. The
 * judge is the real TypeSafe client against a stubbed `fetch`, so the whole
 * path — classifier, judge chain, spawn — runs without network.
 */
describe("runSubprocess task.agentPrewalkAuto", () => {
	const primary = modelOrThrow("claude-sonnet-4-5");
	const target = modelOrThrow("claude-sonnet-4-6");
	const ASSIGNMENT = "trace the sync engine, then fix the stale cursor";

	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-subagent-prewalk-auto-");
	});

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		vi.restoreAllMocks();
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	function verdict(prewalk: number, primaryRoute: number, direct: number) {
		const probabilities: Record<PrewalkRoute, number> = { prewalk, primary: primaryRoute, direct };
		const choice: PrewalkRoute =
			prewalk >= primaryRoute && prewalk >= direct ? "prewalk" : primaryRoute >= direct ? "primary" : "direct";
		return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
	}
	const PREWALK = verdict(0.9, 0.07, 0.03);
	const PRIMARY = verdict(0.1, 0.8, 0.1);
	const DIRECT = verdict(0.05, 0.1, 0.85);
	const WEAK_PREWALK = verdict(0.55, 0.35, 0.1);
	const MALFORMED = { type: "choice", choice: "prewalk" };

	type Reply = "http-400" | { type: string; [key: string]: unknown };
	interface JudgeCall {
		questions: string[];
		state: Record<string, string>;
	}

	/** Answer System One requests from `replies` (then `DIRECT`) and record each one. */
	function stubJudge(replies: Reply[] = []): JudgeCall[] {
		const calls: JudgeCall[] = [];
		const usage = { input_tokens: 8, output_tokens: 2 };
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).endsWith("/v1/systemone")) throw new Error(`unexpected request: ${String(input)}`);
				const body = JSON.parse(String(init?.body)) as {
					state: Record<string, string>;
					questions: Record<string, unknown>;
				};
				calls.push({ questions: Object.keys(body.questions), state: body.state });
				const reply = replies.shift() ?? DIRECT;
				if (reply === "http-400") return new Response("bad request", { status: 400 });
				return Response.json({ model: "jev", answers: { route: reply }, usage });
			}),
		);
		return calls;
	}

	const routeCalls = (calls: JudgeCall[]) => calls.filter(call => call.questions.includes("route"));

	interface FixtureOptions {
		/** `task.agentPrewalkAuto` record for this agent. */
		auto?: Record<string, string>;
		/** `task.agentPrewalk` record, which arms unconditionally. */
		unconditional?: Record<string, string>;
		/** `prewalk.autoTarget`; unset leaves the `@smol` default. */
		autoTarget?: string;
		/** Credential the native judge (default true). */
		judge?: boolean;
		tools?: string[];
		/** Spawn as a restricted-tool run (plan mode), which is never judged. */
		restrictToolNames?: boolean;
		/** Task and assignment text (default `ASSIGNMENT`). */
		assignment?: string;
	}

	function createFixture(options: FixtureOptions = {}) {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		if (options.judge !== false) authStorage.keys.setRuntime("typesafe", "ts-key");
		// Only the credentials set here exist. Ambient provider keys (TYPESAFE_API_KEY, OPENROUTER_API_KEY, …) must
		// neither conjure a native judge nor give the chain a fallback candidate that reaches the network.
		const credentialed = options.judge === false ? ["anthropic"] : ["anthropic", "typesafe"];
		const source = authStorage.keys.source.bind(authStorage.keys);
		vi.spyOn(authStorage.keys, "source").mockImplementation((provider, sourceOptions) =>
			credentialed.includes(provider) ? source(provider, sourceOptions) : undefined,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-1.14.0" },
			...(options.autoTarget ? { "prewalk.autoTarget": options.autoTarget } : {}),
			...(options.auto ? { "task.agentPrewalkAuto": options.auto } : {}),
			...(options.unconditional ? { "task.agentPrewalk": options.unconditional } : {}),
		});
		const session = yieldEmittingSession(options.tools ?? ["read", "yield"]);
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const assignment = options.assignment ?? ASSIGNMENT;
		const spawn = async () => {
			// `description` suppresses the tiny-model label pass, which would issue
			// a request this stub refuses.
			const result = await runSubprocess({
				cwd: tempDir.path(),
				task: assignment,
				assignment,
				description: "test",
				index: 0,
				id: "subagent-auto-prewalk",
				settings,
				modelRegistry,
				enableLsp: false,
				...(options.restrictToolNames ? { restrictToolNames: true } : {}),
				agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
			});
			return { result, forwarded: spy.mock.calls[0]?.[0], session };
		};
		return { spawn, session, spy, settings };
	}

	it("arms the judge-chosen prewalk and forwards the prewalk.autoTarget model", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({
			auto: { task: "on" },
			autoTarget: `${target.provider}/${target.id}`,
			tools: ["read", "todo", "yield"],
		});

		const { result, forwarded, session } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
		expect(forwarded?.prewalk?.target.provider).toBe(target.provider);
		const judged = routeCalls(calls);
		expect(judged).toHaveLength(1);
		expect(judged[0]?.state.request).toContain("trace the sync engine");
		expect(judged[0]?.state.previous_request).toBeUndefined();
		expect(session.getActiveToolNames()).toContain("todo");
	});

	it("resolves a configured pattern as the judged prewalk target", async () => {
		stubJudge([PREWALK]);
		const f = createFixture({ auto: { task: `${target.provider}/${target.id}` } });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
	});

	for (const [label, answer] of [
		["primary", PRIMARY],
		["direct", DIRECT],
		["a prewalk winner below the threshold", WEAK_PREWALK],
	] as const) {
		it(`spawns without prewalk when the judge answers ${label}`, async () => {
			const calls = stubJudge([answer]);
			const f = createFixture({
				auto: { task: "on" },
				autoTarget: `${target.provider}/${target.id}`,
				tools: ["read", "todo", "yield"],
			});

			const { result, forwarded, session } = await f.spawn();

			expect(result.exitCode).toBe(0);
			expect(forwarded?.prewalk).toBeUndefined();
			expect(routeCalls(calls)).toHaveLength(1);
			expect(session.getActiveToolNames()).not.toContain("todo");
		});
	}

	it("fails open without a native judge credential and asks nothing", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({ auto: { task: "on" }, autoTarget: `${target.provider}/${target.id}`, judge: false });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("fails open when the judge rejects the request", async () => {
		stubJudge(["http-400"]);
		const f = createFixture({ auto: { task: "on" }, autoTarget: `${target.provider}/${target.id}` });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
	});

	it("fails open on a malformed judge answer", async () => {
		stubJudge([MALFORMED]);
		const f = createFixture({ auto: { task: "on" }, autoTarget: `${target.provider}/${target.id}` });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
	});

	it("never judges an agent with no task.agentPrewalkAuto entry", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({ autoTarget: `${target.provider}/${target.id}` });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("never judges an agent whose task.agentPrewalkAuto entry is 'off'", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({ auto: { task: "off" }, autoTarget: `${target.provider}/${target.id}` });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("never judges a restricted-tool spawn", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({
			auto: { task: "on" },
			autoTarget: `${target.provider}/${target.id}`,
			restrictToolNames: true,
		});

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("never judges a target that matches the starting model", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({ auto: { task: `${primary.provider}/${primary.id}` } });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("keeps an unconditional task.agentPrewalk arm and asks the judge nothing", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({
			auto: { task: "on" },
			unconditional: { task: `${target.provider}/${target.id}` },
		});

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("never asks the judge about a low-signal assignment", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture({
			auto: { task: "on" },
			autoTarget: `${target.provider}/${target.id}`,
			assignment: "ok",
		});

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(0);
	});

	it("fails open when the judge never answers before the timeout fires", async () => {
		// The judgment deadline fires once the request is out, so the spawn gives up
		// without waiting the real AUTO_PREWALK_TIMEOUT_MS.
		const deadline = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === AUTO_PREWALK_TIMEOUT_MS ? deadline.signal : realTimeout(ms),
		);
		const calls: JudgeCall[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).endsWith("/v1/systemone")) throw new Error(`unexpected request: ${String(input)}`);
				const body = JSON.parse(String(init?.body)) as {
					state: Record<string, string>;
					questions: Record<string, unknown>;
				};
				calls.push({ questions: Object.keys(body.questions), state: body.state });
				const signal = init?.signal;
				if (!signal) throw new Error("judge request carries no abort signal");
				const stalled = Promise.withResolvers<Response>();
				signal.addEventListener("abort", () => stalled.reject(signal.reason), { once: true });
				if (signal.aborted) stalled.reject(signal.reason);
				else deadline.abort(new DOMException("timed out", "TimeoutError"));
				return stalled.promise;
			}),
		);
		const f = createFixture({ auto: { task: "on" }, autoTarget: `${target.provider}/${target.id}` });

		const { result, forwarded } = await f.spawn();

		expect(result.exitCode).toBe(0);
		expect(forwarded?.prewalk).toBeUndefined();
		expect(routeCalls(calls)).toHaveLength(1);
	});
});
