import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	disableProvider,
	enableProvider,
	getDisabledProviders,
	isProviderEnabled,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentCompactionThresholdOverride } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import type {
	BeforeSubagentSpawnEvent,
	LoadExtensionsResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgRetryModelFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskAgentModelOverrides, cfgTaskEnableEffort } from "@oh-my-pi/pi-coding-agent/task/settings";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		cwd?: string;
		settings?: Settings;
		planMode?: boolean;
		parentSpawns?: string;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationEnabled?: boolean;
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
		agentServiceTierOverrides?: Record<string, string>;
		agentCompactionThresholdOverrides?: Record<string, AgentCompactionThresholdOverride>;
		sessionAgents?: readonly AgentDefinition[];
	} = {},
): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings:
			options.settings ??
			Settings.isolated({
				"task.maxRecursionDepth": options.maxDepth ?? 2,
				"task.isolation.enabled": options.isolationEnabled ?? false,
				"isolation.backend": "rcopy",
				"task.enableLsp": true,
				...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
				...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
				...(options.agentServiceTierOverrides
					? { "task.agentServiceTierOverrides": options.agentServiceTierOverrides }
					: {}),
				...(options.agentCompactionThresholdOverrides
					? { "task.agentCompactionThresholdOverrides": options.agentCompactionThresholdOverrides }
					: {}),
			}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getSessionAgents: () => options.sessionAgents ?? [],
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("resolves user-tagged model agents for task and eval but rejects untagged names", async () => {
		mockDiscovery();
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: taggedSession, agent: "m1", invocationKind }),
			);
			expect(policy.agent.name).toBe("m1");
			expect(policy.modelOverride).toEqual(["a/x"]);
		}
		await expect(resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m9" }))).rejects.toThrow(
			'Unknown agent "m9". Available: worker, m1',
		);
	});

	it("keeps discovered agents authoritative on pseudonym collisions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["b/y"] });
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m1" }));
		expect(policy.modelOverride).toEqual(["b/y"]);
	});

	it("rescans agents when a plugin provider is disabled while an earlier discovery is in flight", async () => {
		const previouslyDisabled = getDisabledProviders();
		enableProvider("omp-plugins");
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let scans = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => {
			const pluginsEnabled = isProviderEnabled("omp-plugins");
			if (++scans === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			const agents = pluginsEnabled ? [AGENT, { ...AGENT, name: "plugin-worker" }] : [AGENT];
			return { agents, projectAgentsDir: null };
		});
		try {
			const first = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			await firstEntered.promise;
			disableProvider("omp-plugins");
			const second = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			releaseFirst.resolve();

			expect((await first).agent.name).toBe("plugin-worker");
			await expect(second).rejects.toThrow('Unknown agent "plugin-worker"');
		} finally {
			setDisabledProviders(previouslyDisabled);
		}
	});

	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("uses saved seance models in active-role/default order and honors an explicit available override", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-policy-"));
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "source.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${[
				{ type: "session", version: 3, id: "saved-source", timestamp: "2026-10-01T00:00:00.000Z", cwd },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					model: "anthropic/claude-sonnet-4-5",
					role: "default",
				},
				{
					type: "model_change",
					id: "active-model",
					parentId: "default-model",
					timestamp: "2026-10-01T00:00:02.000Z",
					model: "anthropic/claude-sonnet-4-6",
					role: "fast",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const caller = Object.assign(session({ cwd }), { modelRegistry });
		try {
			const saved = await resolveEffectiveSubagentPolicy(
				request({ session: caller, agent: "seance", sourceSession: sourceFile }),
			);
			expect(saved.preparedSession?.fork.sourceFile).toBe(sourceFile);

			expect(saved.modelOverride).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
			expect(saved.enableLsp).toBe(false);
			expect(saved.enableIrc).toBe(false);

			const overridden = await resolveEffectiveSubagentPolicy(
				request({
					session: caller,
					agent: "seance",
					sourceSession: sourceFile,
					model: "anthropic/claude-sonnet-4-5",
				}),
			);
			expect(overridden.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed when the source has no saved model or an explicit model is unavailable", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-model-fail-"));
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "no-model.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${JSON.stringify({ type: "session", version: 3, id: "no-model-source", timestamp: "2026-10-01T00:00:00.000Z", cwd })}\n`,
		);
		const caller = Object.assign(session({ cwd }), { modelRegistry });
		try {
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: caller, agent: "seance", sourceSession: sourceFile })),
			).rejects.toThrow("The source session has no saved model.");
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: caller,
						agent: "seance",
						sourceSession: sourceFile,
						model: "missing-provider/missing-model",
					}),
				),
			).rejects.toThrow("No available saved model can serve this source.");
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");

		const planSession = session({ planMode: true });
		const customTools = createEvalCustomTools(planSession, [
			{
				name: "word_count",
				description: "Count words",
				parameters: { type: "object", properties: {} },
				language: "python",
			},
		]);
		await expect(resolveEffectiveSubagentPolicy(request({ session: planSession, customTools }))).rejects.toThrow(
			"Eval-defined tools are unavailable in plan mode.",
		);
		expect(discover).not.toHaveBeenCalled();
	});
	it("reloads project task and retry policy before resolving an agent added during the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-hot-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"task:\n  enableEffort: true\nretry:\n  modelFallback: true\n",
		);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = {
			...session(),
			cwd: projectDir,
			settings: liveSettings,
		} as ToolSession;

		try {
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				"task:\n  agentModelOverrides:\n    hot-worker: xai-oauth/grok-4.6:medium\n  enableEffort: false\nretry:\n  modelFallback: false\n",
			);
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				"---\nname: hot-worker\ndescription: Newly added worker.\nmodel: openai/gpt-4o\n---\n\nInspect the assignment.\n",
			);

			const policy = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "hot-worker" }));

			expect(policy.modelOverride).toEqual(["xai-oauth/grok-4.6:medium"]);
			expect(cfgTaskEnableEffort.get(liveSettings)).toBe(false);
			expect(cfgRetryModelFallback.get(liveSettings)).toBe(false);
		} finally {
			liveSettings.cancelPendingSaves();
			// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves only the exact case-sensitive service-tier override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });

		const exact = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { scout: "priority" } }), agent: "scout" }),
		);
		expect(exact.serviceTierOverride).toBe("priority");

		const differentCase = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { Scout: "priority" } }), agent: "scout" }),
		);
		expect(differentCase.serviceTierOverride).toBeUndefined();
	});

	it("resolves only the exact case-sensitive compaction threshold override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });
		const resolve = (overrides: Record<string, AgentCompactionThresholdOverride>) =>
			resolveEffectiveSubagentPolicy(
				request({ session: session({ agentCompactionThresholdOverrides: overrides }), agent: "scout" }),
			);

		expect((await resolve({ scout: "80%", task: 90000 })).compactionThresholdOverride).toEqual({
			thresholdPercent: 80,
			thresholdTokens: -1,
		});
		expect((await resolve({ Scout: "80%" })).compactionThresholdOverride).toBeUndefined();
		expect((await resolve({ task: 90000 })).compactionThresholdOverride).toBeUndefined();
	});

	it("reloads persisted per-agent service-tier overrides before each launch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-tier-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = session({ cwd: projectDir, settings: liveSettings });
		mockDiscovery({ ...AGENT, name: "scout" });
		const configPath = path.join(agentDir, "config.yml");

		try {
			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: priority\n");
			const first = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(first.serviceTierOverride).toBe("priority");

			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: none\n");
			const second = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(second.serviceTierOverride).toBe("none");
		} finally {
			liveSettings.cancelPendingSaves();
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("forwards parent-authorized model agents to nested subagent sessions", async () => {
		mockDiscovery();
		const inheritedAgent: AgentDefinition = { ...AGENT, name: "m1", model: ["b/y"] };
		const parentSession = session({ sessionAgents: [inheritedAgent] });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(request({ session: parentSession, retainArtifacts: true }));

		expect(dispatched[0]?.inheritedSessionAgents).toEqual([inheritedAgent]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("starts a level-tagged agent at its tagged effort and other agents at the capped hint", async () => {
		const model = buildModel({
			id: "effort-target",
			name: "Effort Target",
			api: "openai-responses",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const selector = `${model.provider}/${model.id}`;
		mockDiscovery({ ...AGENT, model: [selector], thinkingLevel: Effort.High });
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: [`${selector}:high`], thinkingLevel: Effort.High };
		const untagged: AgentDefinition = { ...AGENT, name: "m2", model: [selector], thinkingLevel: Effort.Medium };
		const settings = Settings.isolated({ "task.maxEffort": "low", "task.isolation.enabled": false });
		const parent = Object.assign(session({ settings, sessionAgents: [tagged, untagged] }), {
			modelRegistry: { authStorage: {}, refresh: async () => {}, getAvailable: () => [model] },
			getApiKey: async () => "test-key",
		});
		const create = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const child = {
				...createSessionDefaults(),
				state: { messages: [] },
				agent: { state: { systemPrompt: ["test"] } },
				sessionManager: { appendSessionInit: () => {} },
				getActiveToolNames: () => ["read", "yield"],
				getEnabledToolNames: () => ["read", "yield"],
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async () => {
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: { agent: true } } },
							isError: false,
						});
					}
					return true;
				},
			} as unknown as AgentSession;
			return {
				session: child,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			};
		});

		for (const agent of ["m1", "m2", "worker"]) {
			await runStructuredSubagent(request({ session: parent, agent, effort: "hi" }));
		}

		expect(create.mock.calls.map(([options]) => options?.thinkingLevel)).toEqual([
			Effort.High,
			Effort.Low,
			Effort.Low,
		]);
		expect(create.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBeUndefined();
	});
	it("holds the parent on an inline child until it settles, but not on a detached one", async () => {
		mockDiscovery();
		const awaits = AgentRegistry.global().awaits;
		const heldDuringRun: boolean[] = [];
		const childIds: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childIds.push(options.id);
			heldDuringRun.push(awaits.blocksOn("Main", options.id, Date.now()));
			return result();
		});

		const inline = await runStructuredSubagent(request({ detached: false, retainArtifacts: true }));
		const detached = await runStructuredSubagent(request({ detached: true, retainArtifacts: true }));

		expect(heldDuringRun).toEqual([true, false]);
		expect(awaits.blocksOn("Main", childIds[0]!, 0)).toBe(false);
		await fs.rm(inline.artifactsDir, { recursive: true, force: true });
		await fs.rm(detached.artifactsDir, { recursive: true, force: true });
	});
	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("does not treat a spawn handle as the HUD description", async () => {
		mockDiscovery();
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const handleOnly = await runStructuredSubagent(
			request({ identity: { id: "AuthLoader", label: "AuthLoader" }, retainArtifacts: true }),
		);
		expect(dispatched[0]?.description).toBeUndefined();
		expect(dispatched[0]?.id).toBe("AuthLoader");
		await fs.rm(handleOnly.artifactsDir, { recursive: true, force: true });

		dispatched.length = 0;
		const evalLabeled = await runStructuredSubagent(
			request({
				invocationKind: "eval",
				identity: { label: "Refactor the auth flow" },
				retainArtifacts: true,
			}),
		);
		expect(dispatched[0]?.description).toBe("Refactor the auth flow");
		await fs.rm(evalLabeled.artifactsDir, { recursive: true, force: true });
	});

	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(roleSession.settings, { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(concreteOverrideSession.settings, { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("lets before_subagent_spawn replace model patterns at dispatch without dropping role identity", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({ modelRoles: { definition: "anthropic/claude-opus-4-5" } });
		const events: BeforeSubagentSpawnEvent[] = [];
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "openai/gpt-4o", note: "pool test" };
		};
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		// Frontend preflight is side-effect free: stateful routers must not advance.
		await resolveEffectiveSubagentPolicy(request({ session: childSession }));
		expect(events).toEqual([]);

		const settled = await runStructuredSubagent(request({ session: childSession, retainArtifacts: true }));
		expect(dispatched[0]).toMatchObject({
			modelOverride: ["openai/gpt-4o"],
			modelRole: "definition",
			modelRoute: "pool test",
		});
		expect(events).toEqual([
			{
				type: "before_subagent_spawn",
				agent: "worker",
				invocationKind: "task",
				modelRole: "definition",
				patterns: ["anthropic/claude-opus-4-5"],
			},
		]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects dispatch before leasing artifacts when an extension blocks the spawn", async () => {
		mockDiscovery();
		const blockedSession = session();
		blockedSession.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "pool exhausted" });
		const run = vi.spyOn(executorModule, "runSubprocess");
		const error = await runStructuredSubagent(request({ session: blockedSession })).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect(error as StructuredSubagentError).toMatchObject({ kind: "preflight", message: "pool exhausted" });
		expect(run).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains temporary artifacts when the run failed but yielded schema-valid structured output", async () => {
		// Regression: a task can produce schema-valid data and then fail (or
		// exceed its runtime limit). The async notice still advertises the
		// full payload at `agent://<id>` for schema-valid output, so
		// retention must not require `exitCode === 0` too — otherwise the
		// directory is already gone by the time the model follows that URL
		// (PR #10625 review).
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			return {
				...result(),
				exitCode: 1,
				error: "runtime limit exceeded",
				structuredOutput: { source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			};
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("valid");
		await expect(fs.stat(settled.artifactsDir)).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns a prose answer in one turn when structured task results are disabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unstructured-forwarding-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "structured-subagent-unstructured-regression";
		registerMockApi(sourceId);
		const report = "The direct answer is complete without a yield call.";
		const model = createMockModel({
			id: "structured-subagent-unstructured",
			handler: () => ({ content: [report] }),
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
		modelRegistry.getAvailable = () => [model];
		mockDiscovery({
			...AGENT,
			tools: ["read", "yield"],
			model: [`mock/${model.id}`],
		});
		const parentSession = Object.assign(session({ cwd }), {
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		const agentId = "UnstructuredForwarding";
		let artifactsDir: string | undefined;

		try {
			const settled = await runStructuredSubagent(
				request({
					session: parentSession,
					structured: false,
					identity: { id: agentId },
					keepAlive: false,
				}),
			);
			artifactsDir = settled.artifactsDir;

			expect(model.calls).toHaveLength(1);
			expect(model.calls[0]?.context.tools?.some(tool => tool.name === "yield") ?? false).toBe(false);
			expect(settled.result.exitCode).toBe(0);
			expect(settled.result.output).toBe(report);
			expect(settled.result.structuredOutput).toBeUndefined();
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("runs the remaining permitted scout when a plan-mode task omits its agent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-default-scout-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "plan-default-scout-regression";
		registerMockApi(sourceId);
		const agentId = "PlanModeDefaultScout";
		let artifactDir: string | undefined;
		try {
			const report = "The permitted plan-mode scout returned this answer.";
			const model = createMockModel({
				id: "plan-default-scout",
				handler: () => ({ content: [report] }),
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
			modelRegistry.getAvailable = () => [model];
			const seanceAgent = getBundledAgent("seance");
			const scoutAgent = getBundledAgent("scout");
			if (!seanceAgent || !scoutAgent) throw new Error("Expected bundled seance and scout agents");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [
					seanceAgent,
					{
						...scoutAgent,
						model: [`mock/${model.id}`],
						tools: ["read", "yield"],
					},
				],
				projectAgentsDir: null,
			});
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.enabled": false,
				"task.batch": false,
				"task.structured": false,
				"task.enableLsp": false,
				"task.completionProbe": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"autolearn.enabled": false,
				"todo.enabled": false,
			});
			const parentSession = Object.assign(session({ cwd, settings, planMode: true, parentSpawns: "seance,scout" }), {
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			});
			const task = await TaskTool.create(parentSession);
			const result = await task.execute("plan-default-scout", {
				name: agentId,
				task: "Return the plan-mode scout answer.",
				solutionSpace: "The requested agent choice is a single permitted alternative.",
			});

			artifactDir = AgentRegistry.global().get(agentId)?.sessionFile
				? path.dirname(AgentRegistry.global().get(agentId)!.sessionFile!)
				: undefined;
			expect(result.details?.results).toHaveLength(1);
			expect(result.details?.results[0]?.agent).toBe("scout");
			expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(report);
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactDir) await fs.rm(artifactDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("names the failure when nested patches cannot be written as a fallback", async () => {
		// `Bun.write` creates missing parents, so a genuine failure needs a path
		// that cannot become a directory: a regular file in its place.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-unwritable-"));
		const artifactsDir = path.join(parent, "artifacts");
		await fs.writeFile(artifactsDir, "");
		const completed = result();
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);

		expect(hint).toMatch(/Nested patches could not be written: .*(ENOTDIR|EEXIST)/);
		expect(hint).not.toContain("Captured nested patch preserved");
		await fs.rm(parent, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution could not be prepared: not a repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const preparedExtensions = [
			{
				path: extensionPaths[0]!,
				resolvedPath: extensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		] as NonNullable<ToolSession["preparedExtensions"]>;
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		let explicitRoot = "/plugins/explicit";
		const extensionRoots = () => ({
			explicit: [explicitRoot],
			mode: "explicit-only" as const,
			configured: ["/plugins/configured"],
			configuredLevel: "project" as const,
		});
		Object.assign(nonPlanSession, {
			mcpManager,
			extensionPaths,
			customToolPaths,
			preparedExtensions,
			effectiveExtensionRoots: extensionRoots,
		});
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedPreparedExtensions: preparedExtensions,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[1]?.extensionRoots?.()).toEqual(extensionRoots());
		explicitRoot = "/plugins/explicit-after-spawn";
		expect(options[1]?.extensionRoots?.().explicit).toEqual([explicitRoot]);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("reports a run that failed before yielding as unavailable, not schema-invalid", async () => {
		// Production 2026-09-21: a scout whose model stream died mid-prose
		// ("Anthropic stream envelope error: stream ended before message_stop")
		// was delivered as `Structured output: schema invalid: <provider error>`
		// with its half-streamed text as the offending payload. No payload was
		// ever validated, so the status is "unavailable", the error is the
		// provider's, and the partial prose is not presented as data.
		mockDiscovery();
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue({
			...result(),
			exitCode: 1,
			output: "I'll systematically investigate the codebase",
			stderr: error,
			error,
		});

		const settled = await runStructuredSubagent(request());

		expect(settled.result.structuredOutput).toEqual({
			source: "agent",
			mode: "permissive",
			status: "unavailable",
			error,
		});
		expect(settled.result.structuredOutput).not.toHaveProperty("data");
	});

	it("retains a detached task's artifacts on failure even without valid structured output", async () => {
		// Regression: a detached (async) task job that fails without a valid
		// structured payload previously had its temp dir wiped immediately,
		// breaking the "failed agent stays interrogable" invariant
		// (task/index.ts) — the model could no longer read the failure via
		// agent://<id> or history://<id> (PR #10625 review).
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true, detached: true }));

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("unavailable");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		await expect(fs.stat(artifactsDir ?? "")).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("names the preserved branch when nested persistence fails after a branch commit", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async () => ({
			...result(),
			branchName: "omp/task/Worker",
			branchBaseSha: "base",
			nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
			error: "Nested patch capture failed: ENOSPC. Isolation workspace retained at /wt/abc.",
		}));

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(settled.mergeSummary).toContain("omp/task/Worker");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

describe("agent frontmatter structured opt-in", () => {
	const MOCK_API_SOURCE = "test/structured-subagent-opt-in";
	const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	function restoreEnvValue(key: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[key];
			delete Bun.env[key];
			return;
		}
		process.env[key] = value;
		Bun.env[key] = value;
	}

	/** A user agent whose `output` requires `verdict`; only the frontmatter `structured` flag varies. */
	function agentFile(name: string, structured: boolean): string {
		return [
			"---",
			`name: ${name}`,
			"description: Reports a verdict",
			"model: mock/mock-model",
			...(structured ? ["structured: true"] : []),
			"output:",
			"  properties:",
			"    verdict:",
			"      type: string",
			"  optionalProperties:",
			"    note:",
			"      type: string",
			"---",
			"",
			`Role marker ${name}.`,
		].join("\n");
	}

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-opt-in-"));
		const home = path.join(root, "home");
		await fs.mkdir(home, { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registerMockApi(MOCK_API_SOURCE);
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		// The child sessions opened agent.db and models.db under root; Windows cannot delete open files.
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	it.each([
		{ setting: false, structured: { reporter: true, plain: false } },
		{ setting: true, structured: { reporter: true, plain: true } },
	])(
		"task.structured=$setting: yield and schema follow the agent opt-in",
		async ({ setting, structured }) => {
			// Under the isolated HOME so project discovery stops before the developer's real ~/.omp.
			const cwd = path.join(root, "home", "work");
			await fs.mkdir(cwd, { recursive: true });
			const agentsDir = path.join(root, "home", ".omp", "agent", "agents");
			await Bun.write(path.join(agentsDir, "reporter.md"), agentFile("reporter", true));
			await Bun.write(path.join(agentsDir, "plain.md"), agentFile("plain", false));

			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("mock", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const childTools = new Map<string, string[]>();
			const rejections = new Map<string, string>();
			const mock = createMockModel({
				handler: context => {
					const system = context.systemPrompt?.join("\n") ?? "";
					const agent = ["reporter", "plain"].find(name => system.includes(`Role marker ${name}.`));
					if (!agent) return { content: ["label"] };
					const tools = (context.tools ?? []).map(tool => tool.name);
					if (!childTools.has(agent)) childTools.set(agent, tools);
					if (!tools.includes("yield")) return { content: [`${agent} prose report`] };
					const last = context.messages.at(-1);
					if (last?.role === "toolResult" && last.toolName === "yield") {
						if (!last.isError) return { content: ["ok"] };
						rejections.set(agent, last.content.map(part => (part.type === "text" ? part.text : "")).join(""));
						return { content: [{ type: "toolCall", name: "yield", arguments: { data: { verdict: agent } } }] };
					}
					// First attempt omits the required `verdict`.
					return {
						content: [{ type: "toolCall", name: "yield", arguments: { data: { note: "no verdict yet" } } }],
					};
				},
			});
			const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

			const tool = await TaskTool.create({
				cwd,
				hasUI: false,
				settings: Settings.isolated({
					"task.structured": setting,
					"async.enabled": false,
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: "mock/mock-model" },
				}),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				modelRegistry,
				authStorage,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			} as unknown as ToolSession);
			try {
				const result = await tool.execute("tc-opt-in", {
					context: "Report a verdict.",
					tasks: [
						{ agent: "reporter", name: "Reporter", task: "Report.", solutionSpace: "one fix: verdict given" },
						{ agent: "plain", name: "Plain", task: "Report.", solutionSpace: "one fix: verdict given" },
					],
				} as TaskParams);
				const results = new Map((result.details?.results ?? []).map(child => [child.agent, child]));
				for (const [agent, expectStructured] of Object.entries(structured)) {
					const child = results.get(agent);
					expect(child?.exitCode).toBe(0);
					if (expectStructured) {
						expect(childTools.get(agent)).toContain("yield");
						expect(rejections.get(agent)).toContain("does not match schema: verdict: is required");
						expect(child?.structuredOutput).toMatchObject({
							source: "agent",
							status: "valid",
							data: { verdict: agent },
						});
					} else {
						expect(childTools.get(agent)).not.toContain("yield");
						expect(rejections.has(agent)).toBe(false);
						expect(child?.output).toBe(`${agent} prose report`);
						expect(child?.structuredOutput).toBeUndefined();
					}
				}
			} finally {
				authStorage.close();
			}
		},
		30_000,
	);
});

describe("per-call model preflight", () => {
	const target = createMockModel({ id: "target" });
	const painter = { ...createMockModel({ id: "painter" }), kind: "image" as const };
	function perCallSession(settings: Record<string, unknown>, warm = true, refreshPending = false): ToolSession {
		return Object.assign(
			session({
				settings: Settings.isolated({ "task.isolation.enabled": false, "task.maxRecursionDepth": 2, ...settings }),
			}),
			{
				getActiveModelString: () => "mock/parent",
				modelRegistry: {
					getAll: () => [target, painter],
					getAvailable: (kind?: string) => (!warm ? [] : kind === "chat" ? [target] : [target, painter]),
					isBackgroundRefreshPending: () => refreshPending,
				},
			},
		);
	}

	// `off` refuses every kind and `eval` refuses task calls. The selector is invalid on purpose:
	// the disabled gate is reported first, so a caller is never told to fix a selector it may not send.
	it.each([
		["off", "eval"],
		["eval", "task"],
	] as const)("rejects model under task.perCallModel: %s for %s calls", async (mode, invocationKind) => {
		mockDiscovery();
		await expect(
			resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession({ "task.perCallModel": mode }),
					invocationKind,
					perCallModel: "@smol",
				}),
			),
		).rejects.toThrow(`task.perCallModel: ${mode}`);
	});

	it.each([
		["on", "task"],
		["eval", "eval"],
	] as const)("routes an approved model above the agent's own under %s for %s calls", async (mode, invocationKind) => {
		mockDiscovery({ ...AGENT, model: ["mock/agent-own"] });
		const policy = await resolveEffectiveSubagentPolicy(
			request({
				session: perCallSession({ "task.perCallModel": mode, modelRoles: { review: "mock/target" } }),
				invocationKind,
				perCallModel: "mock/target:high",
			}),
		);
		expect(policy.modelOverride).toEqual(["mock/target:high"]);
		// A requested model never falls back to the parent's.
		expect(policy.parentActiveModelPattern).toBeUndefined();
	});

	it.each(["SDK overlay", "nested subagent"])("reloads removed on-disk role grants through an %s", async kind => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-grant-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		const configPath = path.join(agentDir, "config.yml");
		const taskConfig = 'task:\n  perCallModel: "on"\n  isolation:\n    enabled: false\n';
		await Bun.write(configPath, `${taskConfig}modelRoles:\n  review: mock/target\n`);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const child = executorModule.createSubagentSettings(liveSettings, {
			modelRoles: { ...liveSettings.getModelRoles(), advisor: "mock/other" },
		});
		const settings = kind === "SDK overlay" ? liveSettings.overlay({}) : executorModule.createSubagentSettings(child);
		const liveSession = Object.assign(perCallSession({}), { cwd: projectDir, settings });
		const call = request({ session: liveSession, perCallModel: "mock/target:high" });
		mockDiscovery();

		try {
			expect((await resolveEffectiveSubagentPolicy(call)).modelOverride).toEqual(["mock/target:high"]);
			await Bun.write(configPath, taskConfig);
			await expect(resolveEffectiveSubagentPolicy(call)).rejects.toThrow(
				'Per-call model mock/target is not approved for agent "worker"',
			);
		} finally {
			liveSettings.cancelPendingSaves();
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["a selector that is not provider/model-id", "@smol", {}, false, /invalid `model`/],
		// Shaped like provider/model-id, but names the configured custom role `review`.
		["a legacy alias of a custom role", "pi/review", {}, false, /invalid `model`/],
		["an unavailable model", "mock/missing", {}, false, /No available model matches/],
		["a non-chat model", "mock/painter", {}, false, /image model; a subagent needs a chat model/],
		["a non-chat model while discovery is running", "mock/painter", {}, true, /image model/],
		["an unapproved model", "mock/target", { modelRoles: {} }, false, /not approved/],
		[
			"a model for an agent with an override",
			"mock/target",
			{ "task.agentModelOverrides": { worker: "mock/target" } },
			false,
			/conflicts with task\.agentModelOverrides/,
		],
	] as const)("rejects %s", async (_name, perCallModel, settings, refreshPending, error) => {
		mockDiscovery();
		await expect(
			resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession(
						{ "task.perCallModel": "on", modelRoles: { review: "mock/x" }, ...settings },
						true,
						refreshPending,
					),
					perCallModel,
				}),
			),
		).rejects.toThrow(error);
	});

	// Both defer to the executor's post-refresh check: an unloaded model while discovery runs,
	// and availability plus approval while the registry is cold.
	it.each([
		["a model discovery has not loaded yet", "mock/missing", true, true],
		["an unapproved model while the registry is cold", "mock/target", false, false],
	] as const)("defers %s to the executor", async (_name, perCallModel, warm, refreshPending) => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: perCallSession({ "task.perCallModel": "on" }, warm, refreshPending), perCallModel }),
		);
		expect(policy.modelOverride).toEqual([perCallModel]);
		expect(policy.perCallModelGrants).toBeDefined();
	});

	it("leaves calls without model on their configured routing", async () => {
		mockDiscovery({ ...AGENT, model: ["mock/agent-own"] });
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: perCallSession({ "task.perCallModel": "on" }) }),
		);
		expect(policy.modelOverride).toEqual(["mock/agent-own"]);
		expect(policy.perCallModelGrants).toBeUndefined();
		expect(policy.parentActiveModelPattern).toBe("mock/parent");
	});

	it("rejects a per-call model for a level-tagged agent, even its own selector", async () => {
		mockDiscovery();
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: ["mock/target:high"], thinkingLevel: Effort.High };
		const taggedSession = Object.assign(perCallSession({ "task.perCallModel": "on", "task.maxEffort": "low" }), {
			getSessionAgents: () => [tagged],
		});
		const error = await resolveEffectiveSubagentPolicy(
			request({ session: taggedSession, agent: "m1", perCallModel: "mock/target:high" }),
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect((error as StructuredSubagentError).kind).toBe("preflight");
		expect((error as Error).message).toContain('agent "m1"');
		expect((error as Error).message).toContain("Omit model");
	});

	it("routes a per-call model for an untagged mention through its own model grant", async () => {
		mockDiscovery();
		const untagged: AgentDefinition = { ...AGENT, name: "m2", model: ["mock/target"], thinkingLevel: "auto" };
		const untaggedSession = Object.assign(perCallSession({ "task.perCallModel": "on" }), {
			getSessionAgents: () => [untagged],
		});
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: untaggedSession, agent: "m2", perCallModel: "mock/target:low" }),
		);
		expect(policy.modelOverride).toEqual(["mock/target:low"]);
	});

	it("treats a discovered agent's frontmatter level as its own, not a user tag", async () => {
		mockDiscovery({ ...AGENT, name: "m1", source: "project", thinkingLevel: Effort.High });
		const tagged: AgentDefinition = { ...AGENT, name: "m1", model: ["mock/target:high"], thinkingLevel: Effort.High };
		const shadowedSession = Object.assign(
			perCallSession({ "task.perCallModel": "on", modelRoles: { review: "mock/target" } }),
			{ getSessionAgents: () => [tagged] },
		);
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: shadowedSession, agent: "m1", perCallModel: "mock/target:low" }),
		);
		expect(policy.modelOverride).toEqual(["mock/target:low"]);
	});

	describe("an agent shadowing the seance name", () => {
		const shadow: AgentDefinition = { ...AGENT, name: "seance", source: "project", model: ["mock/agent-own"] };

		it.each([
			["the per-call gate", "off", "mock/target", "task.perCallModel: off"],
			["exact-selector validation", "on", ["mock/target"], /invalid `model`/],
		] as const)("holds its model to %s", async (_name, mode, seanceModel, error) => {
			mockDiscovery(shadow);
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: perCallSession({ "task.perCallModel": mode, modelRoles: { review: "mock/target" } }),
						agent: "seance",
						seanceModel: typeof seanceModel === "string" ? seanceModel : [...seanceModel],
					}),
				),
			).rejects.toThrow(error);
		});

		it("routes an approved model as a per-call worker", async () => {
			mockDiscovery(shadow);
			const policy = await resolveEffectiveSubagentPolicy(
				request({
					session: perCallSession({ "task.perCallModel": "on", modelRoles: { review: "mock/target" } }),
					agent: "seance",
					seanceModel: "mock/target",
				}),
			);
			expect(policy.modelOverride).toEqual(["mock/target"]);
			expect(policy.perCallModelGrants?.agentName).toBe("seance");
		});
	});
});
