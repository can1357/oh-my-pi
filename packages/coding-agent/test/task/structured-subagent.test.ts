import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import {
	disableProvider,
	enableProvider,
	getDisabledProviders,
	isProviderEnabled,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentCompactionThresholdOverride } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
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
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
		getSessionSpawns: () => "*",
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

function routingSession(decision: unknown) {
	const base = session();
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const alternate = getBundledModel("openai", "gpt-4o-mini");
	if (!primary || !alternate) throw new Error("Expected bundled routing test models");
	base.modelRegistry = { getAvailable: () => [primary, alternate] } as ToolSession["modelRegistry"];
	const emit = vi.fn(async (_event: BeforeSubagentSpawnEvent, _signal?: AbortSignal) => decision);
	base.emitBeforeSubagentSpawn = emit as ToolSession["emitBeforeSubagentSpawn"];
	return { session: base, emit };
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
				assignment: "Inspect the target.",
				modelLocked: false,
				effortLocked: false,
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

	it("forwards assignment, context, solutionSpace, and the effort or baseline thinking level, and omits solutionSpace for eval", async () => {
		mockDiscovery({ ...AGENT, thinkingLevel: ThinkingLevel.High });
		const events: BeforeSubagentSpawnEvent[] = [];
		const childSession = session();
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
		};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => result());

		const taskSettled = await runStructuredSubagent(
			request({
				session: childSession,
				assignment: "Rename the helper.",
				context: "  shared batch  ",
				solutionSpace: "  one fix: rename, names given  ",
				retainArtifacts: true,
			}),
		);
		const evalSettled = await runStructuredSubagent(
			request({
				session: childSession,
				invocationKind: "eval",
				assignment: "Classify this.",
				context: "   ",
				solutionSpace: "should not leak",
				retainArtifacts: true,
			}),
		);
		const effortSettled = await runStructuredSubagent(
			request({ session: childSession, effort: "lo", retainArtifacts: true }),
		);
		mockDiscovery({ ...AGENT, thinkingLevel: AUTO_THINKING });
		const autoSettled = await runStructuredSubagent(
			request({ session: childSession, solutionSpace: "still task", retainArtifacts: true }),
		);

		expect(events[0]).toMatchObject({
			assignment: "Rename the helper.",
			context: "shared batch",
			solutionSpace: "one fix: rename, names given",
			thinkingLevel: ThinkingLevel.High,
			invocationKind: "task",
		});
		expect(events[0]).not.toHaveProperty("signal");
		expect(events[0]).not.toHaveProperty("effort");
		expect(events[1]).toMatchObject({ assignment: "Classify this.", invocationKind: "eval", thinkingLevel: "high" });
		expect(events[1]).not.toHaveProperty("solutionSpace");
		expect(events[1]).not.toHaveProperty("context");
		// The executor maps `effort` onto the final model, overriding the agent's `high`; the event must not report it.
		expect(events[2]).toMatchObject({ effort: "lo" });
		expect(events[2]).not.toHaveProperty("thinkingLevel");
		expect(events[3]).toMatchObject({ invocationKind: "task", solutionSpace: "still task" });
		expect(events[3]).not.toHaveProperty("thinkingLevel");
		expect(events[3]).not.toHaveProperty("effort");
		await fs.rm(taskSettled.artifactsDir, { recursive: true, force: true });
		await fs.rm(evalSettled.artifactsDir, { recursive: true, force: true });
		await fs.rm(effortSettled.artifactsDir, { recursive: true, force: true });
		await fs.rm(autoSettled.artifactsDir, { recursive: true, force: true });
	});

	it("ignores a hook model when a per-agent override locks the spawn, and still honors block", async () => {
		mockDiscovery({ ...AGENT, model: ["openai/gpt-4o"] });
		const lockedSession = session();
		cfgTaskAgentModelOverrides.override(lockedSession.settings, { worker: "anthropic/claude-sonnet-4-5" });
		const events: BeforeSubagentSpawnEvent[] = [];
		lockedSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "openai/gpt-4o-mini", note: "should ignore" };
		};
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const locked = await runStructuredSubagent(request({ session: lockedSession, retainArtifacts: true }));

		expect(events[0]).toMatchObject({ modelLocked: true, effortLocked: true });
		expect(dispatched[0]?.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(dispatched[0]?.modelRoute).toBeUndefined();

		const blockedSession = session();
		cfgTaskAgentModelOverrides.override(blockedSession.settings, { worker: ["anthropic/claude-sonnet-4-5"] });
		blockedSession.emitBeforeSubagentSpawn = async () => ({
			block: true,
			reason: "held",
			model: "openai/gpt-4o-mini",
		});
		const error = await runStructuredSubagent(request({ session: blockedSession })).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect(error as StructuredSubagentError).toMatchObject({ kind: "preflight", message: "held" });
		expect(dispatched).toHaveLength(1);
		await fs.rm(locked.artifactsDir, { recursive: true, force: true });
	});

	it("does not lock on request.model, explicit effort alone, or a blank override", async () => {
		mockDiscovery({ ...AGENT, model: ["openai/gpt-4o"] });
		const events: BeforeSubagentSpawnEvent[] = [];
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});
		const hook = async (event: BeforeSubagentSpawnEvent) => {
			events.push(event);
			return { model: "openai/gpt-4o-mini", note: "routed" };
		};

		const explicitModel = session();
		explicitModel.emitBeforeSubagentSpawn = hook;
		const explicitEffort = session();
		explicitEffort.emitBeforeSubagentSpawn = hook;
		const blank = session();
		cfgTaskAgentModelOverrides.override(blank.settings, { worker: "   ", other: "" });
		blank.emitBeforeSubagentSpawn = hook;

		const explicitModelRun = await runStructuredSubagent(
			request({ session: explicitModel, model: "anthropic/claude-sonnet-4-5", retainArtifacts: true }),
		);
		const explicitEffortRun = await runStructuredSubagent(
			request({ session: explicitEffort, effort: "hi", retainArtifacts: true }),
		);
		const blankRun = await runStructuredSubagent(request({ session: blank, retainArtifacts: true }));

		expect(events[0]).toMatchObject({ modelLocked: false, effortLocked: false });
		expect(dispatched[0]?.modelOverride).toEqual(["openai/gpt-4o-mini"]);
		expect(dispatched[0]?.modelRoute).toBe("routed");
		expect(events[1]).toMatchObject({ modelLocked: false, effortLocked: true });
		expect(dispatched[1]?.modelOverride).toEqual(["openai/gpt-4o-mini"]);
		expect(events[2]).toMatchObject({ modelLocked: false, effortLocked: false });
		expect(dispatched[2]?.modelOverride).toEqual(["openai/gpt-4o-mini"]);
		await fs.rm(explicitModelRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(explicitEffortRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(blankRun.artifactsDir, { recursive: true, force: true });
	});

	it("applies an unlocked model and thinking route exactly once before dispatch", async () => {
		mockDiscovery();
		const alternate = getBundledModel("openai", "gpt-4o-mini");
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!alternate || !primary) throw new Error("Expected bundled routing test models");
		const route = routingSession({
			model: `${alternate.provider}/${alternate.id}`,
			thinkingLevel: ThinkingLevel.Off,
			note: "pool",
		});
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		await runStructuredSubagent(request({ session: route.session, retainArtifacts: true }));

		expect(route.emit).toHaveBeenCalledTimes(1);
		expect(dispatched[0]?.modelOverride).toEqual([`${alternate.provider}/${alternate.id}`]);
		expect(dispatched[0]?.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(dispatched[0]?.modelRoute).toBe("pool");

		const supported = routingSession({
			model: `${primary.provider}/${primary.id}`,
			thinkingLevel: ThinkingLevel.Low,
		});
		await runStructuredSubagent(request({ session: supported.session, retainArtifacts: true }));
		expect(dispatched[1]?.modelOverride).toEqual([`${primary.provider}/${primary.id}`]);
		expect(dispatched[1]?.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("canonicalizes an effort-only route against a model selector with an inherited suffix", async () => {
		mockDiscovery({ ...AGENT, model: ["openai/gpt-4o-mini:high"] });
		const route = routingSession({ thinkingLevel: ThinkingLevel.Off });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		await runStructuredSubagent(request({ session: route.session, retainArtifacts: true }));

		expect(dispatched[0]?.modelOverride).toEqual(["openai/gpt-4o-mini"]);
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(dispatched[0]?.thinkingLevel).toBe(ThinkingLevel.Off);
	});

	it("keeps role identity when an effort-only thinking level strips the role suffix", async () => {
		const reviewer = getBundledModel("openai", "gpt-4o");
		if (!reviewer) throw new Error("Expected bundled reviewer model");
		mockDiscovery({ ...AGENT, model: ["@reviewer:high"] });
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		childSession.modelRegistry = { getAvailable: () => [reviewer] } as ToolSession["modelRegistry"];
		childSession.emitBeforeSubagentSpawn = vi.fn(async () => ({ thinkingLevel: ThinkingLevel.Off }));
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		await runStructuredSubagent(request({ session: childSession, retainArtifacts: true }));

		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelOverride).toEqual(["openai/gpt-4o"]);
		expect(dispatched[0]?.thinkingLevel).toBe(ThinkingLevel.Off);
	});

	it("keeps routed backups after a thinking-level pin", async () => {
		mockDiscovery();
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const backup = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !backup) throw new Error("Expected bundled routing test models");
		const route = routingSession({
			model: [`${primary.provider}/${primary.id}:high`, `${backup.provider}/${backup.id}`],
			thinkingLevel: ThinkingLevel.Low,
		});
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		await runStructuredSubagent(request({ session: route.session, retainArtifacts: true }));

		expect(dispatched[0]?.modelOverride).toEqual([
			`${primary.provider}/${primary.id}`,
			`${backup.provider}/${backup.id}`,
		]);
		expect(dispatched[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("ignores a thinking level when effort is locked and still applies an unlocked model", async () => {
		mockDiscovery();
		const route = routingSession({
			model: "openai/gpt-4o-mini:high",
			thinkingLevel: ThinkingLevel.Off,
			note: "kept",
		});
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		await runStructuredSubagent(request({ session: route.session, effort: "hi", retainArtifacts: true }));

		expect(route.emit.mock.calls[0]?.[0].effortLocked).toBe(true);
		expect(route.emit.mock.calls[0]?.[0].modelLocked).toBe(false);
		expect(dispatched[0]?.modelOverride).toEqual(["openai/gpt-4o-mini:high"]);
		expect(dispatched[0]?.thinkingLevel).toBeUndefined();
		expect(dispatched[0]?.modelRoute).toBe("kept");
	});

	it("fails preflight when the thinking level is unknown or unsupported", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => result());
		const unsupported = routingSession({
			model: "openai/gpt-4o-mini",
			thinkingLevel: ThinkingLevel.High,
		});
		const invalid = routingSession({ thinkingLevel: "not-a-thinking-level" });

		await expect(runStructuredSubagent(request({ session: unsupported.session }))).rejects.toThrow(
			/unsupported thinking level "high" for openai\/gpt-4o-mini/,
		);
		await expect(runStructuredSubagent(request({ session: invalid.session }))).rejects.toThrow(
			/invalid thinking level/,
		);
		expect(dispatch).not.toHaveBeenCalled();
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
