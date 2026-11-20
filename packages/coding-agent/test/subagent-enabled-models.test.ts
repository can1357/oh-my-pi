import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { normalizeModelPatternList, resolveModelOverrideWithAuthFallback } from "../src/config/model-resolver";
import { cfgEnabledModels } from "../src/config/model-settings";
import { Settings } from "../src/config/settings";
import * as sdkModule from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { installRetryFallbackRole } from "../src/session/retry-fallback-chains";
import { cfgRetryFallbackChains } from "../src/session/settings";
import { TurnRecovery, type TurnRecoveryHost } from "../src/session/turn-recovery";
import * as discovery from "../src/task/discovery";
import { runSubprocess } from "../src/task/executor";
import { cfgTaskAgentModelOverrides } from "../src/task/settings";
import { resolveEffectiveSubagentPolicy } from "../src/task/structured-subagent";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createSessionDefaults } from "./helpers/session-defaults";

let tempDir: string;
let authStorage: AuthStorage;
let registry: ModelRegistry;
let settings: Settings;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-enabled-models-"));
	authStorage = createInMemoryAuthStorage();
	registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	registerModels("scope-test", ["forbidden", "allowed"]);
	settings = Settings.isolated({ enabledModels: ["scope-test/allowed"] });
});

function registerModels(provider: string, ids: string[]): void {
	registry.registerProvider(provider, {
		baseUrl: "https://example.test/v1",
		api: "openai-completions",
		apiKey: `${provider}-key`,
		models: ids.map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const provider of ["scope-test", "scope-disc", "late-provider"]) registry.unregisterProvider(provider);
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function session(agentModel: string[] = ["scope-test/allowed"]): ToolSession {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "worker",
				description: "Test worker",
				systemPrompt: "Inspect the target.",
				source: "bundled",
				model: agentModel,
			},
		],
		projectAgentsDir: null,
	});
	return {
		cwd: tempDir,
		hasUI: false,
		settings,
		modelRegistry: registry,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "scope-test/allowed",
	};
}

test.each(["request", "settings override", "frontmatter"] as const)(
	"rejects a forbidden %s selection before spawning",
	async source => {
		const toolSession = session(source === "frontmatter" ? ["scope-test/forbidden"] : undefined);
		if (source === "settings override") {
			cfgTaskAgentModelOverrides.override(settings, { worker: "scope-test/forbidden" });
		}
		await expect(
			resolveEffectiveSubagentPolicy({
				session: toolSession,
				invocationKind: "task",
				assignment: "Inspect the target.",
				agent: "worker",
				model: source === "request" ? "scope-test/forbidden" : undefined,
			}),
		).rejects.toMatchObject({ kind: "preflight" });
	},
);

test.each([
	["the enabled scope", undefined, undefined],
	["the requested model", "late-provider/ready", "ready"],
] as const)(
	"defers to execution while %s may still be registered by an extension",
	async (_label, requested, expected) => {
		// An unrelated model is already available; the scoped target registers later, during child setup.
		cfgEnabledModels.override(settings, ["late-provider/ready"]);
		const policy = await resolveEffectiveSubagentPolicy({
			session: session(),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "worker",
			model: requested,
		});
		registerModels("late-provider", ["ready"]);
		const result = await resolveModelOverrideWithAuthFallback(
			normalizeModelPatternList(policy.modelOverride),
			policy.parentActiveModelPattern,
			registry,
			settings,
		);
		// The frontmatter model stays outside the late scope, so execution surfaces no model rather than running it.
		expect(result.model?.id).toBe(expected);
	},
);

test("defers preflight while discovery may add a model matching both the selection and the scope", async () => {
	registerModels("scope-disc", ["preferred-old", "target"]);
	cfgEnabledModels.override(settings, ["scope-disc/preferred-*"]);
	vi.spyOn(registry, "isBackgroundRefreshPending").mockReturnValue(true);
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		model: "target",
	});
	registry.unregisterProvider("scope-disc");
	registerModels("scope-disc", ["preferred-old", "target", "preferred-target"]);
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("preferred-target");
});

function yieldingChild(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	return {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
	} as unknown as AgentSession;
}

test.each<[string, string[], Record<string, string[]>, string[] | undefined]>([
	["a later ordered candidate", ["scope-test/allowed", "scope-test/forbidden"], {}, undefined],
	["an inherited default chain entry", ["scope-test/allowed"], { default: ["scope-test/forbidden"] }, []],
])("keeps %s outside enabledModels out of the child retry chain", async (_label, modelOverride, chains, expected) => {
	let childChain: unknown;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		childChain = options?.settings ? cfgRetryFallbackChains.get(options.settings)["subagent:scope-retry"] : undefined;
		return { session: yieldingChild(), extensionsResult: {}, setToolUIContext: () => {} } as never;
	});
	cfgRetryFallbackChains.override(settings, chains);
	await runSubprocess({
		cwd: tempDir,
		agent: { name: "worker", description: "Test worker", systemPrompt: "Inspect the target.", source: "bundled" },
		task: "Inspect the target.",
		index: 0,
		id: "scope-retry",
		modelOverride,
		settings,
		modelRegistry: registry,
		enableLsp: false,
	});
	expect(childChain).toEqual(expected);
});

test("keeps an inherited entry the registry cannot resolve yet in the child retry chain", async () => {
	let childChain: unknown;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		childChain = options?.settings ? cfgRetryFallbackChains.get(options.settings)["subagent:late-retry"] : undefined;
		return { session: yieldingChild(), extensionsResult: {}, setToolUIContext: () => {} } as never;
	});
	cfgEnabledModels.override(settings, ["scope-test/allowed", "late-provider/ready"]);
	cfgRetryFallbackChains.override(settings, { default: ["late-provider/ready", "scope-test/forbidden"] });
	await runSubprocess({
		cwd: tempDir,
		agent: { name: "worker", description: "Test worker", systemPrompt: "Inspect the target.", source: "bundled" },
		task: "Inspect the target.",
		index: 0,
		id: "late-retry",
		modelOverride: ["scope-test/allowed"],
		settings,
		modelRegistry: registry,
		enableLsp: false,
	});
	expect(childChain).toEqual(["late-provider/ready"]);
});

test.each([
	["a subagent session", true, ["late-provider/ready"]],
	["a main session", false, ["late-provider/ready", "late-provider/outside"]],
] as const)("checks late-registered retry fallbacks against enabledModels in %s", (_label, scoped, expected) => {
	cfgEnabledModels.override(settings, ["scope-test/allowed", "late-provider/ready"]);
	installRetryFallbackRole(settings, "subagent:late-switch", {
		primary: "scope-test/allowed",
		chain: ["late-provider/ready", "late-provider/outside"],
	});
	const current = registry.find("scope-test", "allowed");
	const recovery = new TurnRecovery({
		model: () => current,
		thinkingLevel: () => undefined,
		sessionManager: { getSessionId: () => "late-switch" },
		settings,
		modelRegistry: registry,
		configWarnings: [],
		retryFallbackScopedToEnabledModels: () => scoped,
	} as unknown as TurnRecoveryHost);
	// The child registers both chain models only after the chain was installed.
	registerModels("late-provider", ["ready", "outside"]);
	const candidates = recovery.findRetryFallbackCandidates("subagent:late-switch", "scope-test/allowed", current);
	expect(candidates.map(candidate => candidate.raw)).toEqual([...expected]);
});

test("still rejects at preflight once the scoped model is registered and the selection is outside it", async () => {
	cfgEnabledModels.override(settings, ["scope-test/allowed"]);
	await expect(
		resolveEffectiveSubagentPolicy({
			session: session(["scope-test/forbidden"]),
			invocationKind: "task",
			assignment: "Inspect the target.",
			agent: "worker",
		}),
	).rejects.toMatchObject({ kind: "preflight" });
});

test("skips a forbidden ordered candidate at execution after shared preflight", async () => {
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "eval",
		assignment: "Inspect the target.",
		agent: "worker",
		model: ["scope-test/forbidden", "scope-test/allowed"],
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("inherits the allowed live parent rather than the forbidden configured default", async () => {
	settings.setModelRole("default", "scope-test/forbidden");
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(["*"]),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("an empty internal selector still uses allowed agent frontmatter", async () => {
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		model: "",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		policy.parentActiveModelPattern,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
});

test("does not use an authenticated parent outside the scope as auth fallback", async () => {
	vi.spyOn(registry, "getApiKey").mockImplementation(async model =>
		model.id === "allowed" ? undefined : "parent-key",
	);
	const result = await resolveModelOverrideWithAuthFallback(
		["scope-test/allowed"],
		"scope-test/forbidden",
		registry,
		settings,
	);
	expect(result.model?.id).toBe("allowed");
	expect(result.authFallbackUsed).toBe(false);
});

test("an unmatched enabledModels scope cannot recover through the global catalog", async () => {
	cfgEnabledModels.override(settings, ["scope-test/missing"]);
	const result = await resolveModelOverrideWithAuthFallback(
		["scope-test/forbidden"],
		"scope-test/allowed",
		registry,
		settings,
	);
	expect(result.model).toBeUndefined();
});

test("an empty enabledModels list keeps unrestricted selection", async () => {
	cfgEnabledModels.override(settings, []);
	const policy = await resolveEffectiveSubagentPolicy({
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		model: "scope-test/forbidden",
	});
	const result = await resolveModelOverrideWithAuthFallback(
		normalizeModelPatternList(policy.modelOverride),
		undefined,
		registry,
		settings,
	);
	expect(result.model?.id).toBe("forbidden");
});
