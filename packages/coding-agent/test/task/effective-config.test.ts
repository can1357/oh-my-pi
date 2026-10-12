/**
 * `omp agents show` must report what a spawn of the agent runs with. Each case
 * dispatches the agent through the real task path, captures what the spawn
 * hands `createAgentSession`, and checks the view reports the same values and
 * names the layer that set them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Model, resolveModelServiceTier } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import * as agentsCli from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { buildServiceTierByFamily } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { describeModelCompactionPoint } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { cfgTierAnthropic, cfgTierGoogle, cfgTierOpenai } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveEffectiveAgentConfig } from "@oh-my-pi/pi-coding-agent/task/effective-config";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { rejectionOf } from "../helpers/rejection";
import { createSessionDefaults } from "../helpers/session-defaults";

function bundled(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model ${id}`);
	return model;
}

const haiku = bundled("claude-haiku-4-5");
const sonnet = bundled("claude-sonnet-4-5");
const opus = bundled("claude-opus-4-5");
const models = [haiku, sonnet, opus];

// A real registry with one Anthropic key: the view and the spawn see the same auth and catalog.
const fixtureDir = path.join(os.tmpdir(), `pi-agents-show-fixture-${Snowflake.next()}`);
const fixtureAuth = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(fixtureAuth, path.join(fixtureDir, "models.yml"));

beforeAll(async () => {
	await fs.mkdir(fixtureDir, { recursive: true });
	await fixtureAuth.credentials.set("anthropic", [{ type: "api_key", key: "sk-test-anthropic" }]);
});

afterAll(async () => {
	fixtureAuth.close();
	await fs.rm(fixtureDir, { recursive: true, force: true });
});

/** A child session that yields on its first prompt, so the run settles. */
function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-call",
					toolName: "yield",
					result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
					isError: false,
				});
			}
			return true;
		},
	} as unknown as AgentSession;
}

/** Dispatch `agent` as the task tool would from a top-level session on `modelRoles.default`. */
async function spawn(
	agent: AgentDefinition,
	settings: Settings,
	registry: ModelRegistry = modelRegistry,
): Promise<CreateAgentSessionOptions> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	const create = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: yieldingSession(),
		extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		modelRegistry: registry,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
		getActiveModelString: () => settings.getModelRole("default"),
		getModelString: () => settings.getModelRole("default"),
	} as unknown as ToolSession;
	const settled = await runStructuredSubagent({
		session,
		invocationKind: "task",
		assignment: "Look.",
		agent: agent.name,
	});
	await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	const options = create.mock.calls[0]?.[0];
	if (!options) throw new Error("spawn never created a session");
	return options;
}

/** The values the spawned session starts from, in the view's terms. */
function spawnedValues(options: CreateAgentSessionOptions) {
	const model = options.model as Model;
	const settings = options.settings as Settings;
	const tiers =
		options.resolveServiceTierByFamily?.(model) ??
		buildServiceTierByFamily(
			cfgTierOpenai.get(settings),
			cfgTierAnthropic.get(settings),
			cfgTierGoogle.get(settings),
		);
	const advisor = cfgAdvisorEnabled.get(settings) ? resolveAdvisorRoleSelection(settings, models) : undefined;
	return {
		model: formatModelStringWithRouting(model),
		thinking: options.thinkingLevel ?? null,
		serviceTier: resolveModelServiceTier(tiers, model) ?? null,
		compaction: describeModelCompactionPoint(settings, model).tokens ?? null,
		tools: options.toolNames ?? null,
		prewalk: options.prewalk ? formatModelStringWithRouting(options.prewalk.target) : null,
		advisor: advisor ? [formatModelStringWithRouting(advisor.model)] : null,
		accountPools: options.oauthAccountPools ?? null,
	};
}

const worker: AgentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "test",
	source: "user",
	model: ["anthropic/claude-opus-4-5"],
	thinkingLevel: Effort.Low,
	tools: ["read", "bash"],
	prewalk: "anthropic/claude-sonnet-4-5",
	advisor: true,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("omp agents show", () => {
	it("reports the agent's task.agent* entries over its frontmatter, as the spawn applies them", async () => {
		const pools = { anthropic: ["email:a@example.com|org:1"] };
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5", advisor: "anthropic/claude-opus-4-5" },
			"task.softRequestBudget": 50,
			"task.agentModelOverrides": { worker: "anthropic/claude-haiku-4-5:high" },
			"task.agentServiceTierOverrides": { worker: "priority" },
			"task.agentCompactionThresholdOverrides": { worker: "40%" },
			"task.agentAccountPools": { worker: pools },
			"task.agentPrewalk": { worker: "anthropic/claude-opus-4-5" },
			"task.agentAdvisor": { worker: "anthropic/claude-sonnet-4-5" },
		});
		const view = await resolveEffectiveAgentConfig(worker, settings, modelRegistry, "/tmp");
		const spawned = spawnedValues(await spawn(worker, settings));

		expect(spawned).toMatchObject({
			model: "anthropic/claude-haiku-4-5",
			thinking: "high",
			serviceTier: "priority",
			tools: ["read", "bash", "wait"],
			prewalk: "anthropic/claude-opus-4-5",
			advisor: ["anthropic/claude-sonnet-4-5"],
			accountPools: pools,
		});
		for (const field of [
			"model",
			"thinking",
			"serviceTier",
			"compaction",
			"prewalk",
			"advisor",
			"accountPools",
		] as const) {
			expect(view[field].value).toEqual(spawned[field]);
			expect(view[field].source.layer).toBe("agent-entry");
		}
		expect(view.model.source.key).toBe("task.agentModelOverrides.worker");
		expect(view.compaction.note).toBe("40% of window");
		expect(view.requestBudget).toEqual({
			value: 50,
			source: { layer: "setting", key: "task.softRequestBudget", scope: "runtime" },
		});
	});

	it("falls back to frontmatter and settings when the agent has no entries", async () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
				advisor: "anthropic/claude-opus-4-5",
			},
			"tier.subagent": "priority",
			"compaction.thresholdPercent": 70,
		});
		const agent: AgentDefinition = { ...worker, name: "scout", model: ["@smol"] };
		const view = await resolveEffectiveAgentConfig(agent, settings, modelRegistry, "/tmp");
		const spawned = spawnedValues(await spawn(agent, settings));

		expect(spawned).toMatchObject({ model: "anthropic/claude-haiku-4-5", thinking: "low", serviceTier: "priority" });
		for (const field of ["model", "thinking", "serviceTier", "compaction", "prewalk", "advisor"] as const) {
			expect(view[field].value).toEqual(spawned[field]);
		}
		expect(view.model.source).toEqual({ layer: "frontmatter", key: "model" });
		expect(view.model.note).toBe("@smol via modelRoles.smol");
		expect(view.thinking.source).toEqual({ layer: "frontmatter", key: "thinkingLevel" });
		expect(view.serviceTier.source).toMatchObject({ layer: "setting", key: "tier.subagent" });
		expect(view.compaction.source).toMatchObject({ layer: "setting", key: "compaction.thresholdPercent" });
		expect(view.prewalk.source).toEqual({ layer: "frontmatter", key: "prewalk" });
		expect(view.advisor.source).toEqual({ layer: "frontmatter", key: "advisor" });
		expect(view.accountPools).toEqual({ value: null, source: { layer: "default" } });
		// scout's built-in budget is tighter than the 200 default setting.
		expect(view.requestBudget).toEqual({ value: 100, source: { layer: "default", key: "built-in scout budget" } });
	});

	it("reports the session's model and default tools for an agent that sets neither", async () => {
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const agent: AgentDefinition = { name: "plain", description: "test", systemPrompt: "test", source: "project" };
		const view = await resolveEffectiveAgentConfig(agent, settings, modelRegistry, "/tmp");
		const spawned = spawnedValues(await spawn(agent, settings));

		expect(spawned).toMatchObject({ model: "anthropic/claude-sonnet-4-5", thinking: null, tools: null });
		for (const field of ["model", "serviceTier", "compaction", "prewalk", "advisor"] as const) {
			expect(view[field].value).toEqual(spawned[field]);
		}
		expect(view.model.source).toEqual({ layer: "session", key: "modelRoles.default" });
		expect(view.tools.source).toEqual({ layer: "session" });
		expect(view.serviceTier.source).toEqual({ layer: "default", key: "tier.anthropic" });
		expect(view.prewalk.source).toEqual({ layer: "default" });
	});
});

/**
 * Parity with the real session: the spawn's captured options go to the real
 * `createAgentSession`, and the view must match what that session starts on.
 */
describe("omp agents show against the session a spawn starts", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	afterEach(async () => {
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function setup(): Promise<void> {
		tempDir = path.join(os.tmpdir(), `pi-agents-show-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set("anthropic", [{ type: "api_key", key: "sk-test-anthropic" }]);
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	}

	async function startSpawn(agent: AgentDefinition, settings: Settings) {
		const options = await spawn(agent, settings, registry);
		vi.restoreAllMocks();
		const { session } = await sdkModule.createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			enableMCP: false,
			hasUI: false,
			settings: options.settings,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			toolNames: options.toolNames,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth,
			spawns: options.spawns,
			enableLsp: options.enableLsp,
			skipPythonPreflight: options.skipPythonPreflight,
			prewalk: options.prewalk,
		});
		return { options, session };
	}

	it("reports the startup fallback model when no default role is set", async () => {
		await setup();
		const settings = Settings.isolated({});
		const agent: AgentDefinition = { name: "plain", description: "test", systemPrompt: "test", source: "project" };
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { session } = await startSpawn(agent, settings);
		try {
			expect(session.model).toBeDefined();
			expect(view.model.value).toBe(formatModelStringWithRouting(session.model!));
			expect(view.model.source).toEqual({ layer: "default", key: "first available model" });
		} finally {
			await session.dispose();
		}
	});

	it("clamps the thinking level to what the model supports", async () => {
		await setup();
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const agent: AgentDefinition = {
			name: "clamped",
			description: "test",
			systemPrompt: "test",
			source: "project",
			model: ["anthropic/claude-haiku-4-5"],
			thinkingLevel: Effort.Max,
		};
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { session } = await startSpawn(agent, settings);
		try {
			expect(session.thinkingLevel).not.toBe(Effort.Max);
			expect(view.thinking.value).toBe(session.thinkingLevel ?? null);
			expect(view.thinking.note).toBe("clamped from max");
		} finally {
			await session.dispose();
		}
	});

	it("reports the built-ins the session constructs, not the requested list", async () => {
		await setup();
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"bash.enabled": false,
		});
		const agent: AgentDefinition = {
			name: "nobash",
			description: "test",
			systemPrompt: "test",
			source: "project",
			tools: ["read", "bash"],
		};
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { session } = await startSpawn(agent, settings);
		try {
			const active = session.getActiveToolNames().sort();
			expect(active).not.toContain("bash");
			expect([...(view.tools.value as string[])].sort()).toEqual(active);
			expect(view.tools.note).toContain("write is granted for xd:// devices only");
		} finally {
			await session.dispose();
		}
	});

	it("reports `todo` for a yield-gated child whose prewalk is armed", async () => {
		await setup();
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const agent: AgentDefinition = {
			name: "walker",
			description: "test",
			systemPrompt: "test",
			source: "project",
			model: ["anthropic/claude-opus-4-5"],
			tools: ["read", "todo"],
			prewalk: "anthropic/claude-haiku-4-5",
		};
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { options, session } = await startSpawn(agent, settings);
		try {
			expect(options.prewalk).toBeDefined();
			expect(session.getActiveToolNames()).toContain("todo");
			expect([...(view.tools.value as string[])].sort()).toEqual(session.getActiveToolNames().sort());
		} finally {
			await session.dispose();
		}
	});

	it("attributes compaction to compaction.enabled=false over the agent's threshold entry", async () => {
		await setup();
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": false,
			"task.agentCompactionThresholdOverrides": { plain: "40%" },
		});
		const agent: AgentDefinition = { name: "plain", description: "test", systemPrompt: "test", source: "project" };
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { options, session } = await startSpawn(agent, settings);
		try {
			expect(cfgCompactionEnabled.get(options.settings as Settings)).toBe(false);
			expect(view.compaction.source).toEqual({ layer: "setting", key: "compaction.enabled", scope: "runtime" });
		} finally {
			await session.dispose();
		}
	});

	it("attributes the bundled task agent's prewalk to an explicit task.prewalk=false", async () => {
		await setup();
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"task.prewalk": false,
		});
		const agent = getBundledAgent("task");
		if (!agent) throw new Error("Expected bundled task agent");
		const view = await resolveEffectiveAgentConfig(agent, settings, registry, tempDir);
		const { options, session } = await startSpawn(agent, settings);
		try {
			expect(options.prewalk).toBeUndefined();
			expect(view.prewalk.value).toBeNull();
			expect(view.prewalk.source).toEqual({ layer: "setting", key: "task.prewalk", scope: "runtime" });
		} finally {
			await session.dispose();
		}
	});
});

describe("omp agents show inputs", () => {
	it("runs one discovery pass when a cold models.yml cache resolves no model", async () => {
		let refreshed = false;
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (refreshed ? models : []));
		vi.spyOn(modelRegistry, "getDiscoverableProviders").mockReturnValue(["local"]);
		vi.spyOn(modelRegistry, "refresh").mockImplementation(async () => {
			refreshed = true;
		});
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const view = await resolveEffectiveAgentConfig(worker, settings, modelRegistry, "/tmp");
		expect(refreshed).toBe(true);
		expect(view.model.value).toBe("anthropic/claude-opus-4-5");
	});

	it("refreshes discovery for an unresolved default role even when a fallback model is available", async () => {
		let refreshed = false;
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (refreshed ? models : [haiku]));
		vi.spyOn(modelRegistry, "getDiscoverableProviders").mockReturnValue(["local"]);
		vi.spyOn(modelRegistry, "refresh").mockImplementation(async () => {
			refreshed = true;
		});
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		const agent: AgentDefinition = { name: "plain", description: "test", systemPrompt: "test", source: "project" };
		const view = await resolveEffectiveAgentConfig(agent, settings, modelRegistry, "/tmp");
		expect(refreshed).toBe(true);
		expect(view.model.value).toBe("anthropic/claude-sonnet-4-5");
		expect(view.model.source).toEqual({ layer: "session", key: "modelRoles.default" });
	});

	it("lists each enabled WATCHDOG.yml advisor on its model", async () => {
		const dir = path.join(os.tmpdir(), `pi-agents-show-advisors-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		try {
			await Bun.write(
				path.join(dir, "WATCHDOG.yml"),
				[
					"advisors:",
					"  - name: fast",
					"    model: anthropic/claude-haiku-4-5",
					"  - name: role",
					"  - name: off",
					"    enabled: false",
				].join("\n"),
			);
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5", advisor: "anthropic/claude-opus-4-5" },
			});
			const view = await resolveEffectiveAgentConfig(worker, settings, modelRegistry, dir);
			expect(view.advisor.value).toEqual(["fast: anthropic/claude-haiku-4-5", "role: anthropic/claude-opus-4-5"]);
			expect(view.advisor.note).toBe("roster from WATCHDOG.yml");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("opens settings read-only and touches no auth storage for an unknown agent", async () => {
		const init = vi.spyOn(Settings, "init");
		const readOnly = vi.spyOn(Settings, "loadReadOnly");
		const auth = vi.spyOn(sdkModule, "discoverAuthStorage");
		const error = await rejectionOf(agentsCli.runAgentsCommand({ action: "show", name: "no-such-agent", flags: {} }));
		expect((error as Error).message).toContain('Unknown agent "no-such-agent"');
		expect(init).not.toHaveBeenCalled();
		expect(readOnly).toHaveBeenCalled();
		expect(auth).not.toHaveBeenCalled();
	});
});
