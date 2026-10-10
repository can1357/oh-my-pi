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
import { cfgDisabledProviders, cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
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
import { resolveRoleRoute } from "@oh-my-pi/pi-coding-agent/task/role-routing";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";
import {
	buildStructuredSubagentRecoveryHint,
	invalidModelSelectorReason,
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

const modelFixtures: TaskModelFixture[] = [];

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
	const settings =
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
		});
	const fixture = createTaskModelFixture(settings);
	modelFixtures.push(fixture);
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings,
		modelRegistry: fixture.modelRegistry,
		getActiveModel: fixture.getActiveModel,
		getActiveModelString: fixture.getActiveModelString,
		getActiveModelSelector: fixture.getActiveModelSelector,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => options.sessionAgents ?? [],
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: overrides.session ?? session(),
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
	for (const fixture of modelFixtures.splice(0)) fixture.close();
});

describe("structured subagent primitive", () => {
	it("resolves user-tagged model agents for task and eval but rejects untagged names", async () => {
		mockDiscovery();
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["routing-test/primary"] }];
		for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: taggedSession, agent: "m1", invocationKind }),
			);
			expect(policy.agent.name).toBe("m1");
		}
		await expect(resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m9" }))).rejects.toThrow(
			'Unknown agent "m9". Available: worker, m1',
		);
	});

	it("keeps discovered agents authoritative on pseudonym collisions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["routing-test/fallback"] });
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["routing-test/primary"] }];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m1" }));
		expect(policy.agent).toMatchObject({ name: "m1", model: ["routing-test/fallback"] });
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
		const liveSession = session({ cwd: projectDir, settings: liveSettings });

		try {
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				"task:\n  agentModelOverrides:\n    hot-worker: routing-test/fallback:medium\n  enableEffort: false\nretry:\n  modelFallback: false\n",
			);
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				"---\nname: hot-worker\ndescription: Newly added worker.\nmodel: routing-test/primary\n---\n\nInspect the assignment.\n",
			);

			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: liveSession, agent: "hot-worker", model: "routing-test/fallback:medium" }),
			);

			expect(resolveRoleRoute(policy.roleRoute!, liveSession.modelRegistry)).toMatchObject({
				selector: "routing-test/fallback:medium",
				thinkingLevel: "medium",
				fixedEffort: true,
			});
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

	it("lets an explicit role win over the exact override and agent frontmatter", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({
			modelRoles: {
				request: "routing-test/primary",
				override: "routing-test/fallback:low",
				definition: "routing-test/plain",
			},
		});
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "@override" });
		const requested = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "@request:high" }),
		);
		expect(resolveRoleRoute(requested.roleRoute!, childSession.modelRegistry)).toMatchObject({
			selector: "routing-test/primary:high",
			role: "request",
			thinkingLevel: "high",
			fixedEffort: true,
		});
	});

	it("admits a configured custom role without an agent roster entry and fixes its requested effort", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { "project-review": "routing-test/primary:low" } });
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "@project-review:high" }),
		);
		expect(resolveRoleRoute(policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
			model: { provider: "routing-test", id: "primary" },
			selector: "routing-test/primary:high",
			role: "project-review",
			thinkingLevel: "high",
			fixedEffort: true,
			occurrence: 0,
		});
		expect(policy.agent.name).toBe("worker");
		expect(policy.effectiveAgent.tools).toEqual(AGENT.tools);
	});

	it("inherits @default model identity and effort rather than the configured default role", async () => {
		mockDiscovery({ ...AGENT, model: ["routing-test/plain"] });
		const childSession = session({ modelRoles: { default: "routing-test/fallback:low" } });
		for (const [model, thinkingLevel] of [
			["@default", "medium"],
			["@default:high", "high"],
		] as const) {
			const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model }));
			expect(resolveRoleRoute(policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
				model: { provider: "routing-test", id: "parent" },
				selector: `routing-test/parent:${thinkingLevel}`,
				thinkingLevel,
				fixedEffort: true,
			});
		}
	});

	it("requires model discovery and an actual parent rather than manufacturing inheritance", async () => {
		mockDiscovery();
		const noRegistry = session();
		noRegistry.modelRegistry = undefined;
		await expect(resolveEffectiveSubagentPolicy(request({ session: noRegistry, model: "@default" }))).rejects.toThrow(
			/Model discovery is required/,
		);
		const noParent = session({ modelRoles: { default: "routing-test/primary" } });
		noParent.getActiveModel = undefined;
		noParent.getActiveModelString = undefined;
		noParent.getActiveModelSelector = undefined;
		await expect(resolveEffectiveSubagentPolicy(request({ session: noParent, model: "@default" }))).rejects.toThrow(
			/actual live parent/,
		);
	});

	it("rejects blank, malformed, ambiguous, and inherited aliases without silently dropping a supplied selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { worker: "routing-test/primary" } });
		for (const model of ["", " , ", [], ["routing-test/primary", ""], [42], null]) {
			await expect(
				resolveEffectiveSubagentPolicy(
					request({ session: childSession, model: model as StructuredSubagentRequest["model"] }),
				),
			).rejects.toThrow(/invalid `model`/);
		}
		for (const model of [
			"default",
			"default:high",
			"DEFAULT:high",
			"inherit",
			"inherit:low",
			["routing-test/primary", "default"],
		]) {
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/"@default"/,
			);
		}
		for (const model of ["@inherit", "@inherit:high", "pi/inherit", "pi/inherit:low"]) {
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/cannot select @inherit/,
			);
		}
	});

	it("rejects unconfigured roles even alongside a usable authorized selection", async () => {
		mockDiscovery();
		const childSession = session();
		for (const model of ["@missing", "@missing:high", ["@default", "@missing"]]) {
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/not configured/,
			);
		}
	});

	it("does not turn catalog, authentication, or enabled scope into model authority", async () => {
		mockDiscovery();
		const childSession = session({ settings: Settings.isolated({ enabledModels: ["routing-test/*"] }) });
		const unassigned = childSession.modelRegistry!.find("routing-test", "unassigned")!;
		expect(childSession.modelRegistry!.hasConfiguredAuth(unassigned)).toBe(true);
		expect(childSession.modelRegistry!.getAvailable().some(model => model.id === "unassigned")).toBe(true);
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "routing-test/unassigned" })),
		).rejects.toThrow(/not authorized/);
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "routing-test/not-in-catalog" })),
		).rejects.toThrow(/no current operator grant/);
	});

	it("authorizes only the selected agent's exact case-sensitive settings override", async () => {
		mockDiscovery({ ...AGENT, model: ["routing-test/primary"] });
		const childSession = session();
		cfgTaskAgentModelOverrides.override(childSession.settings, {
			Worker: "routing-test/fallback",
			other: "routing-test/unassigned",
		});
		const defined = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "routing-test/primary" }),
		);
		expect(resolveRoleRoute(defined.roleRoute!, childSession.modelRegistry).model.id).toBe("primary");
		for (const model of ["routing-test/fallback", "routing-test/unassigned"]) {
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/not authorized/,
			);
		}
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "routing-test/fallback:high" });
		const overridden = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "routing-test/fallback:high" }),
		);
		expect(resolveRoleRoute(overridden.roleRoute!, childSession.modelRegistry)).toMatchObject({
			selector: "routing-test/fallback:high",
			role: undefined,
			fixedEffort: true,
		});
	});

	it("fails an authorized explicit selection outside provider, auth, or enabled scope instead of inheriting", async () => {
		mockDiscovery();
		for (const scope of ["enabled", "disabled"] as const) {
			const childSession = session({ modelRoles: { worker: "routing-test/primary" } });
			childSession.modelRegistry!.getAll();
			if (scope === "enabled") cfgEnabledModels.override(childSession.settings, ["routing-test/parent"]);
			else cfgDisabledProviders.override(childSession.settings, ["routing-test"]);
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: childSession, model: "routing-test/primary" })),
			).rejects.toThrow(scope === "disabled" ? /disabled|No usable model remains/ : /No usable model remains/);
		}
		const childSession = session({ modelRoles: { worker: "routing-test/primary" } });
		const unauthenticated = createTaskModelFixture(childSession.settings, { authenticated: false });
		modelFixtures.push(unauthenticated);
		Object.assign(childSession, {
			modelRegistry: unauthenticated.modelRegistry,
			getActiveModel: unauthenticated.getActiveModel,
			getActiveModelString: unauthenticated.getActiveModelString,
			getActiveModelSelector: unauthenticated.getActiveModelSelector,
		});
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "routing-test/primary" })),
		).rejects.toThrow(/No usable model remains/);
	});

	it("selects the first usable ordered role occurrence, retaining its own role and effort", async () => {
		mockDiscovery();
		const childSession = session({
			modelRoles: { leading: "routing-test/primary:high", trailing: "routing-test/fallback:low" },
		});
		childSession.modelRegistry!.suppressSelector("routing-test/primary", Date.now() + 60_000);
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: ["@leading", "@trailing"] }),
		);
		expect(resolveRoleRoute(policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
			model: { id: "fallback" },
			selector: "routing-test/fallback:low",
			role: "trailing",
			thinkingLevel: "low",
			fixedEffort: true,
			occurrence: 1,
		});
	});

	it("counts duplicate role candidates as ordered occurrences rather than collapsing their efforts", async () => {
		mockDiscovery();
		const childSession = session({
			settings: Settings.isolated({
				modelRoles: { "project-review": "routing-test/primary:low" },
				"retry.modelFallback": true,
				"retry.fallbackChains": { "project-review": ["routing-test/primary:high", "routing-test/fallback:medium"] },
			}),
		});
		childSession.modelRegistry!.suppressSelector("routing-test/primary", Date.now() + 60_000);
		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "@project-review" }));
		expect(resolveRoleRoute(policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
			selector: "routing-test/fallback:medium",
			role: "project-review",
			thinkingLevel: "medium",
			occurrence: 2,
		});
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "routing-test/primary" })),
		).rejects.toThrow(/No usable model remains/);
	});

	it("rejects unsupported requested efforts rather than clamping or falling through", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { worker: "routing-test/primary,routing-test/plain" } });
		for (const model of ["routing-test/primary:xhigh", ["routing-test/plain:high", "routing-test/primary:low"]]) {
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/not supported/,
			);
		}
	});

	it("preserves literal colon-containing IDs and recognizes only an appended effort suffix", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { local: "routing-test/colon:model" } });
		for (const model of ["routing-test/colon:model", "routing-test/colon:model:high"]) {
			const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model }));
			expect(resolveRoleRoute(policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
				model: { id: "colon:model" },
				selector: model,
				fixedEffort: model.endsWith(":high"),
			});
		}
	});

	it("lets spawn hooks narrow approved candidates without running during frontend preflight", async () => {
		mockDiscovery({ ...AGENT, model: ["@project-review"] });
		const childSession = session({ modelRoles: { "project-review": "routing-test/primary,routing-test/fallback" } });
		const events: BeforeSubagentSpawnEvent[] = [];
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "routing-test/fallback:high" };
		};
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());
		await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "@project-review" }));
		expect(events).toEqual([]);
		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "@project-review", retainArtifacts: true }),
		);
		expect(events).toHaveLength(1);
		expect(resolveRoleRoute(settled.policy.roleRoute!, childSession.modelRegistry)).toMatchObject({
			selector: "routing-test/fallback:high",
			role: "project-review",
			fixedEffort: true,
		});
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects a hook that widens a selection even to an independently authorized model", async () => {
		mockDiscovery();
		const childSession = session({
			modelRoles: { worker: "routing-test/primary", independent: "routing-test/fallback" },
		});
		childSession.emitBeforeSubagentSpawn = async () => ({ model: "routing-test/fallback" });
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		await expect(
			runStructuredSubagent(request({ session: childSession, model: "routing-test/primary:high" })),
		).rejects.toThrow(/escaped the approved model\/effort/);
		expect(dispatch).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("rejects a spawn hook that removes or downgrades a fixed requested effort", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { worker: "routing-test/primary" } });
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		for (const replacement of ["routing-test/primary", "routing-test/primary:low"]) {
			childSession.emitBeforeSubagentSpawn = async () => ({ model: replacement });
			await expect(
				runStructuredSubagent(request({ session: childSession, model: "routing-test/primary:high" })),
			).rejects.toThrow(/escaped the approved model\/effort/);
		}
		expect(dispatch).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
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

describe("per-call selector syntax", () => {
	it("rejects a comma-only selector instead of treating it as no selector", () => {
		expect(invalidModelSelectorReason(" , ", "The call")).toMatch(/invalid .*model/);
	});

	for (const model of [
		"routing-test/primary:heigh",
		["routing-test/primary:heigh", "routing-test/primary"],
		"@default,routing-test/primary:heigh",
	]) {
		it(`rejects an invalid thinking suffix instead of silently dropping it: ${JSON.stringify(model)}`, async () => {
			mockDiscovery();
			const childSession = session({ modelRoles: { worker: "routing-test/primary" } });
			await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(
				/Invalid thinking suffix/,
			);
		});
	}
});
