import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseRetryFallbackSelector } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { resolveRoleRoute } from "@oh-my-pi/pi-coding-agent/task/role-routing";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { createSessionDefaults } from "./helpers/session-defaults";

type RuntimeModelDefinition = NonNullable<ProviderConfigInput["models"]>[number] & { provider: string };

function modelDefinition(provider: string, id: string): RuntimeModelDefinition {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test/v1`,
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const primary = modelDefinition("issue2750-primary", "bad-runtime-model");
const fallback = modelDefinition("issue2750-fallback", "working-model");
const unrelated = modelDefinition("issue2750-global", "other-model");
const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;
const unrelatedSelector = `${unrelated.provider}/${unrelated.id}`;
const resources: Array<{ dir: TempDir; authStorage: AuthStorage }> = [];

async function createRegistry(models: RuntimeModelDefinition[] = [primary, fallback, unrelated]) {
	const dir = TempDir.createSync("omp-subagent-runtime-route-");
	const authStorage = await AuthStorage.create(":memory:");
	resources.push({ dir, authStorage });
	const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	for (const provider of new Set(models.map(candidate => candidate.provider))) {
		const candidates = models.filter(candidate => candidate.provider === provider);
		registry.registerProvider(provider, {
			api: candidates[0]!.api,
			baseUrl: candidates[0]!.baseUrl,
			apiKey: "test-key",
			models: candidates,
		});
	}
	return { registry, cwd: dir.path() };
}

function answer(model: Model): AssistantMessage {
	return {
		role: "assistant",
		provider: model.provider,
		model: model.id,
		api: model.api,
		content: [{ type: "text", text: "work completed" }],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Real retry recovery, with only the provider turn and SDK construction replaced. */
function createYieldingSession(
	options: CreateAgentSessionOptions,
	retry: "served" | "unproven" | "if-available" | "none" = "none",
	attempt?: string,
): AgentSession {
	if (!options.roleRoute || !options.modelRegistry || !options.sessionManager)
		throw new Error("Expected admitted worker");
	const selection = resolveRoleRoute(options.roleRoute, options.modelRegistry);
	let activeModel = selection.model;
	let activeLevel = selection.thinkingLevel as ThinkingLevel | undefined;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const emit = async (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	// Only direct route validation, retry adoption and served-turn attribution are
	// exercised; compaction, continuation and provider-error recovery are not driven.
	const recoveryHost = {
		roleRoute: options.roleRoute,
		modelRegistry: options.modelRegistry,
		settings: options.settings!,
		sessionManager: options.sessionManager,
		model: () => activeModel,
		thinkingLevel: () => activeLevel,
		configuredThinkingLevel: () => activeLevel,
		thinkingLevelCeiling: () => options.thinkingLevelCeiling,
		setThinkingLevel: level => {
			activeLevel = level as ThinkingLevel | undefined;
		},
		setModelWithProviderSessionReset: async (next, nextOptions) => {
			activeModel = next;
			if (nextOptions) activeLevel = nextOptions.thinkingLevel as ThinkingLevel | undefined;
		},
		sessionId: () => options.sessionManager!.getSessionId(),
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		emitSessionEvent: emit,
		configWarnings: [],
	} satisfies Pick<
		TurnRecoveryHost,
		| "roleRoute"
		| "modelRegistry"
		| "settings"
		| "sessionManager"
		| "model"
		| "thinkingLevel"
		| "configuredThinkingLevel"
		| "thinkingLevelCeiling"
		| "setThinkingLevel"
		| "setModelWithProviderSessionReset"
		| "sessionId"
		| "resolveActiveEditMode"
		| "syncAfterModelChange"
		| "emitSessionEvent"
		| "configWarnings"
	>;
	const recovery = new TurnRecovery(recoveryHost as unknown as TurnRecoveryHost);
	return {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		get model() {
			return activeModel;
		},
		get thinkingLevel() {
			return activeLevel;
		},
		get servingModel() {
			return recovery.servingModel;
		},
		extensionRunner: undefined,
		sessionManager: options.sessionManager,
		dispose: async () => {
			await options.sessionManager!.close();
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		prompt: async () => {
			await recovery.onAssistantSettledSuccessfully(answer(activeModel));
			if (retry !== "none" || attempt) {
				const role = recovery.retryFallbackChainKeys(selection.selector)[0]!;
				const candidate = attempt
					? parseRetryFallbackSelector(attempt, options.modelRegistry!)
					: recovery.findRetryFallbackCandidates(role, selection.selector)[0];
				if (!candidate && retry !== "if-available") throw new Error("Expected an approved retry candidate");
				if (candidate) {
					await recovery.applyRetryFallbackCandidate(role, candidate, selection.selector);
					if (retry !== "unproven") await recovery.onAssistantSettledSuccessfully(answer(activeModel));
				}
			}
			await emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { completed: true } },
				},
				isError: false,
			});
			return true;
		},
	} as unknown as AgentSession;
}

function installSession(retry: "served" | "unproven" | "if-available" | "none" = "none", attempt?: string) {
	return vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Expected worker options");
		return {
			session: createYieldingSession(options, retry, attempt),
			extensionsResult: {},
			setToolUIContext: () => {},
		} as never;
	});
}

const agent = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled" as const,
	model: [primarySelector],
};

afterEach(async () => {
	vi.restoreAllMocks();
	for (const { dir, authStorage } of resources.splice(0)) {
		authStorage.close();
		await dir.remove();
	}
});

describe("subagent runtime model resolution", () => {
	for (const level of [undefined, ThinkingLevel.High]) {
		it(`keeps a literal model-id colon separate from effort (${level ?? "unset"})`, async () => {
			const literal = modelDefinition("issue2750-literal", "coding-router:max");
			const { registry, cwd } = await createRegistry([literal]);
			const selector = `${literal.provider}/${literal.id}${level ? `:${level}` : ""}`;
			const snapshots: AgentProgress[] = [];
			installSession();
			const result = await runSubprocess({
				cwd,
				agent: { ...agent, model: [`${literal.provider}/${literal.id}`] },
				task: "work",
				index: 0,
				id: "literal-model",
				modelOverride: selector,
				settings: Settings.isolated(),
				modelRegistry: registry,
				enableLsp: false,
				onProgress: progress => snapshots.push({ ...progress }),
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.resolvedModel).toBe(selector);
			expect(result.resolvedModelIdentity).toBe(`${literal.provider}/${literal.id}`);
			expect(result.resolvedThinkingLevel).toBe(level);
			expect(snapshots.findLast(progress => progress.resolvedModel)?.resolvedModelIdentity).toBe(
				`${literal.provider}/${literal.id}`,
			);
		});
	}

	it("retries inside the actual selected role chain even when default shares its primary", async () => {
		const { registry, cwd } = await createRegistry();
		const settings = Settings.isolated({
			modelRoles: { qa: primarySelector, default: primarySelector },
			"retry.fallbackChains": { qa: [`${fallbackSelector}:high`], default: [unrelatedSelector] },
			"task.maxEffort": "low",
		});
		const snapshots: AgentProgress[] = [];
		installSession("served");
		const result = await runSubprocess({
			cwd,
			agent,
			task: "work",
			index: 0,
			id: "configured-role",
			modelOverride: "@qa",
			settings,
			modelRegistry: registry,
			enableLsp: false,
			onProgress: progress => snapshots.push({ ...progress }),
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.resolvedModel).toBe(`${fallbackSelector}:high`);
		expect(result.resolvedThinkingLevel).toBe(ThinkingLevel.High);
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(snapshots.findLast(progress => progress.resolvedModel)?.resolvedModel).toBe(`${fallbackSelector}:high`);
	});

	it("keeps a literal pin closed instead of inheriting the default retry chain", async () => {
		const { registry, cwd } = await createRegistry();
		installSession("if-available");
		const result = await runSubprocess({
			cwd,
			agent,
			task: "work",
			index: 0,
			id: "literal-pin",
			modelOverride: primarySelector,
			settings: Settings.isolated({
				modelRoles: { default: primarySelector },
				"retry.fallbackChains": { default: [unrelatedSelector] },
			}),
			modelRegistry: registry,
			enableLsp: false,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.resolvedModel).toBe(primarySelector);
	});

	it("blocks a retry outside the literal closure even when another role authorizes its model", async () => {
		const { registry, cwd } = await createRegistry();
		installSession("served", unrelatedSelector);
		const result = await runSubprocess({
			cwd,
			agent,
			task: "work",
			index: 0,
			id: "escaped-retry",
			modelOverride: primarySelector,
			settings: Settings.isolated({ modelRoles: { other: unrelatedSelector } }),
			modelRegistry: registry,
			enableLsp: false,
		});
		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("remaining approved occurrence");
		expect(result.resolvedModel).toBe(primarySelector);
	});

	it("does not credit an approved fallback that was armed but never served a turn", async () => {
		const { registry, cwd } = await createRegistry();
		installSession("unproven");
		const result = await runSubprocess({
			cwd,
			agent,
			task: "work",
			index: 0,
			id: "unproven-fallback",
			modelOverride: "@qa",
			settings: Settings.isolated({
				modelRoles: { qa: primarySelector },
				"retry.fallbackChains": { qa: [fallbackSelector] },
			}),
			modelRegistry: registry,
			enableLsp: false,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.resolvedModel).toBe(primarySelector);
	});

	it("persists role-routing selection diagnostics instead of a transcript retry grant (#13789)", async () => {
		const { registry, cwd } = await createRegistry();
		installSession();
		const result = await runSubprocess({
			cwd,
			agent,
			task: "work",
			index: 0,
			id: "persisted-route",
			modelOverride: "@qa",
			settings: Settings.isolated({
				modelRoles: { qa: primarySelector },
				"retry.fallbackChains": { qa: [fallbackSelector] },
			}),
			modelRegistry: registry,
			enableLsp: false,
			artifactsDir: cwd,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		const persisted = (await SessionManager.peekSessionInit(path.join(cwd, "persisted-route.jsonl")))?.init;
		expect(persisted?.roleRouting?.occurrences.map(candidate => candidate.pattern)).toEqual([
			primarySelector,
			fallbackSelector,
		]);
		expect(persisted?.roleRouting?.dependencies).toContainEqual({
			role: "qa",
			value: primarySelector,
			fallbacks: [fallbackSelector],
			fallbacksConfigured: true,
		});
		expect(persisted?.retryFallback).toBeUndefined();
	});
});
