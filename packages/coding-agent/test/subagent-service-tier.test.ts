import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Api, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildServiceTierByFamily } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { runSubprocess, type ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT: AgentDefinition = {
	name: "task",
	description: "Tier test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

function makeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as unknown[] };
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
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

let childId = 0;

async function captureChildOptions(
	settings: Settings,
	extra: Partial<ExecutorOptions> = {},
): Promise<CreateAgentSessionOptions> {
	const session = createYieldingSession();
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as never);
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: AGENT,
		task: "work",
		index: 0,
		id: `tier-child-${++childId}`,
		settings,
		modelRegistry: { refresh: async () => {} } as never,
		enableLsp: false,
		...extra,
	});
	expect(result.exitCode).toBe(0);
	const options = createSpy.mock.calls[0]?.[0];
	if (!options) throw new Error("Expected child createAgentSession options");
	return options;
}

function childControls(options: CreateAgentSessionOptions): ModelControls {
	const settings = options.settings ?? Settings.isolated();
	const host = {
		agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
		settings,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {},
		providerSessionState: new Map(),
		model: () => undefined,
	} as unknown as ModelControlsHost;
	return new ModelControls(host, {
		serviceTierByFamily: buildServiceTierByFamily(
			settings.get("tier.openai"),
			settings.get("tier.anthropic"),
			settings.get("tier.google"),
		),
		serviceTierOverrides: options.serviceTierOverrides,
	});
}

const tempDirs: TempDir[] = [];
const sessionManagers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(sessionManagers.splice(0).map(manager => manager.close()));
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("subagent service-tier inheritance and revival", () => {
	it("resolves an inheriting child's requests from the explicit off ahead of the parent baseline", async () => {
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const options = await captureChildOptions(Settings.isolated({ "tier.subagent": "inherit" }), {
			parentServiceTier: { openai: "flex" },
			parentServiceTierOverrides: { openai: null },
		});
		expect(childControls(options).effectiveServiceTier(sol, Effort.Max)).toBeUndefined();
		expect(childControls({ ...options, serviceTierOverrides: undefined }).effectiveServiceTier(sol, Effort.Max)).toBe(
			"flex",
		);
	});

	it("does not forward parent choices to a pinned tier.subagent child", async () => {
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const options = await captureChildOptions(Settings.isolated({ "tier.subagent": "flex" }), {
			parentServiceTier: { openai: "priority" },
			parentServiceTierOverrides: { openai: null },
		});
		expect(options.serviceTierOverrides).toBeUndefined();
		expect(childControls(options).effectiveServiceTier(sol, Effort.Max)).toBe("flex");
	});

	it("re-resolves a model rule against the final auth-fallback model, not the parent's match", async () => {
		const luna = makeModel("openai-codex", "gpt-5.6-luna");
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const settings = Settings.isolated({
			"tier.subagent": "inherit",
			"tier.modelOverrides": { "openai-codex/gpt-5.6-luna:max": "priority" },
		});
		const options = await captureChildOptions(settings, {
			modelOverride: "openai-codex/gpt-5.6-luna",
			parentActiveModelPattern: "openai-codex/gpt-5.6-sol",
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [luna, sol],
				getApiKey: async (model: Model) => (model.id === luna.id ? undefined : "test-key"),
			} as never,
		});
		expect(options.model?.id).toBe(sol.id);
		const controls = childControls(options);
		expect(controls.effectiveServiceTier(sol, Effort.Max)).toBeUndefined();
		expect(controls.effectiveServiceTier(luna, Effort.Max)).toBe("priority");
	});

	it("lets an inherited explicit off suppress the child's exact model rule", async () => {
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const settings = Settings.isolated({
			"tier.subagent": "inherit",
			"tier.modelOverrides": { "openai-codex/gpt-5.6-sol:max": "priority" },
		});
		const options = await captureChildOptions(settings, {
			parentServiceTier: { openai: "flex" },
			parentServiceTierOverrides: { openai: null },
		});
		expect(childControls(options).effectiveServiceTier(sol, Effort.Max)).toBeUndefined();
		expect(childControls({ ...options, serviceTierOverrides: undefined }).effectiveServiceTier(sol, Effort.Max)).toBe(
			"priority",
		);
	});

	it("keeps a noninherit baseline below the exact model rule", async () => {
		const luna = makeModel("openai-codex", "gpt-5.6-luna");
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const settings = Settings.isolated({
			"tier.subagent": "flex",
			"tier.modelOverrides": { "openai-codex/gpt-5.6-sol:max": "priority" },
		});
		const options = await captureChildOptions(settings, {
			parentServiceTier: { openai: "priority" },
			parentServiceTierOverrides: { openai: null },
		});
		const controls = childControls(options);
		expect(controls.effectiveServiceTier(sol, Effort.Max)).toBe("priority");
		expect(controls.effectiveServiceTier(luna, Effort.Max)).toBe("flex");
	});
	it("uses persisted child tier overrides when reviving a parked child", async () => {
		const tempDir = TempDir.createSync("@tier-subagent-revive-");
		tempDirs.push(tempDir);
		const sol = makeModel("openai-codex", "gpt-5.6-sol");
		const id = "tier-revive-" + ++childId;
		const settings = Settings.isolated({
			"tier.subagent": "inherit",
			"task.agentIdleTtlMs": 0,
		});
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.sessionManager) sessionManagers.push(options.sessionManager);
			const session = createYieldingSession();
			if (options.expectedAgentRef == null) {
				// Stand in for createAgentSession's fresh-spawn registry claim;
				// revival passes the parked ref and must not re-claim the id.
				const registry = AgentRegistry.global();
				const sessionFile = options.sessionManager?.getSessionFile() ?? null;
				registry.register({
					id: options.agentId ?? id,
					displayName: AGENT.name,
					kind: "sub",
					session: null,
					sessionFile,
				});
				registry.attachSession(options.agentId ?? id, session, sessionFile);
			}
			return { session, extensionsResult: {}, setToolUIContext: () => {}, eventBus: new EventBus() } as never;
		});
		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: AGENT,
			task: "work",
			index: 0,
			id,
			settings,
			artifactsDir: tempDir.path(),
			parentServiceTier: { openai: "flex" },
			parentServiceTierOverrides: { openai: "priority" },
			modelRegistry: { refresh: async () => {} } as never,
			enableIrc: false,
			enableLsp: false,
		});
		expect(result.exitCode).toBe(0);
		const launchOptions = createSpy.mock.calls[0]?.[0];
		if (!launchOptions) throw new Error("Expected launch options");

		// Persist the child's later explicit off, then use the same park/revive
		// lifecycle seam as an IRC wake.
		const launchSessionManager = launchOptions.sessionManager as SessionManager | undefined;
		if (!launchSessionManager) throw new Error("Expected a persisted child session manager");
		launchSessionManager.appendServiceTierChange(null, { openai: null });
		await launchSessionManager.flush();
		await launchSessionManager.close();
		await AgentLifecycleManager.global().park(id);
		await AgentLifecycleManager.global().ensureLive(id);

		const revivedOptions = createSpy.mock.calls[1]?.[0];
		if (!revivedOptions) throw new Error("Expected lifecycle revival");
		createSpy.mockRestore();

		// Feed the executor's revived options into the real SDK. A stale launch
		// priority would win here; the persisted child off must instead remain off.
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const resumedManager = revivedOptions.sessionManager;
		if (!resumedManager) throw new Error("Expected revived session manager");
		const {
			agentId: _agentId,
			agentDisplayName: _agentDisplayName,
			expectedAgentRef: _expectedAgentRef,
			parentAgentId: _parentAgentId,
			parentTaskPrefix: _parentTaskPrefix,
			model: _launchModel,
			modelRegistry: _launchRegistry,
			authStorage: _launchAuthStorage,
			sessionManager: _launchSessionManager,
			...commonOptions
		} = revivedOptions;
		let resumed: AgentSession | undefined;
		try {
			({ session: resumed } = await sdkModule.createAgentSession({
				...commonOptions,
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				model: sol,
				modelRegistry,
				authStorage,
				sessionManager: resumedManager,
				agentRegistry: new AgentRegistry(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			}));
			expect(resumed.serviceTierByFamily).toEqual({});
		} finally {
			await resumed?.dispose();
			authStorage.close();
		}
	});
});
