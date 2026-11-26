import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RetryFallbackRole, ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/task-details";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createSessionDefaults } from "./helpers/session-defaults";

import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/**
 * Fake session that runs a turn on its primary, applies a retry fallback, and
 * yields.
 *
 * `servingModel` mirrors the real session contract: it names the model that
 * produced output and holds the previous one while a fallback is armed but
 * unproven, so the executor is exercised against the same shape production
 * gives it.
 *
 * `fallback` picks what the target does with the switch it was handed:
 * - `"served"` settles a real turn on it, which moves attribution.
 * - `"unproven"` errors on its first request, producing none of the run's work.
 */
function createYieldingSession(
	fallback: "served" | "unproven" | "none" = "served",
	beforeYield?: () => Promise<void>,
): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "bad-runtime-model"),
		servingModel: { selector: "primary/bad-runtime-model", isFallback: false } as ServingModel | undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			// Broadcast per event, not per subscriber: every observer must see the
			// same session state at the same point in the sequence.
			const emit = (event: { type: string; [key: string]: unknown }): void => {
				for (const listener of listeners) listener(event);
			};
			await beforeYield?.();
			if (fallback !== "none") {
				session.model = model("fallback", "working-model");
				emit({
					type: "retry_fallback_applied",
					from: "primary/bad-runtime-model",
					to: "fallback/working-model",
					role: "subagent:issue-2750",
				});
				if (fallback === "served") {
					session.servingModel = { selector: "fallback/working-model", isFallback: true };
					emit({ type: "retry_fallback_succeeded", model: "fallback/working-model", role: "subagent:issue-2750" });
				}
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
				isError: false,
			});
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const { level, collide } of [
		{ level: undefined, collide: false },
		{ level: ThinkingLevel.High, collide: false },
		{ level: undefined, collide: true },
	]) {
		it(`keeps literal suffix attribution distinct from thinking (${collide ? "colliding selector" : (level ?? "unset")})`, async () => {
			const literal = model("custom", "coding-router:max");
			const snapshots: AgentProgress[] = [];
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				if (!options?.model) throw new Error("Expected resolved model");
				let activeModel = options.model;
				let activeLevel: ThinkingLevel | undefined = level;
				const recovery = new TurnRecovery({
					model: () => activeModel,
					thinkingLevel: () => activeLevel,
					sessionManager: { getSessionId: () => "literal-model" },
					settings: Settings.isolated({}),
					modelRegistry: {},
					configWarnings: [],
				} as unknown as TurnRecoveryHost);
				const session = createYieldingSession("none", async () => {
					if (collide) {
						// Same concatenated selector, different identity and reasoning.
						activeModel = model("custom", "coding-router");
						activeLevel = ThinkingLevel.Max;
					}
					await recovery.onAssistantSettledSuccessfully({
						role: "assistant",
						content: [{ type: "text", text: "literal model produced this answer" }],
						stopReason: "stop",
					} as AssistantMessage);
					// A newly armed model must not steal the settled answer's identity.
					activeModel = model("custom", "unserved-candidate");
				});
				Object.defineProperty(session, "servingModel", { get: () => recovery.servingModel });
				expect(recovery.servingModel?.modelIdentity).toBe("custom/coding-router:max");
				expect(recovery.servingModel?.thinkingLevel).toBe(level);
				return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
			});
			const settings = Settings.isolated({});
			settings.setModelRole("default", "custom/coding-router:max");
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: "work",
				index: 0,
				id: "literal-model",
				modelOverride: level ? `custom/coding-router:max:${level}` : "custom/coding-router:max",
				settings,
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [literal],
					getApiKey: async () => "test-key",
				} as never,
				onProgress: progress => snapshots.push({ ...progress }),
				enableLsp: false,
			});
			const expectedSelector = level ? `custom/coding-router:max:${level}` : "custom/coding-router:max";
			const latest = snapshots.findLast(progress => progress.resolvedModel !== undefined);
			expect(latest?.resolvedModelIdentity).toBe(collide ? "custom/coding-router" : "custom/coding-router:max");
			expect(latest?.resolvedThinkingLevel).toBe(collide ? ThinkingLevel.Max : level);
			expect(result.resolvedModel).toBe(expectedSelector);
			expect(result.resolvedModelIdentity).toBe(collide ? "custom/coding-router" : "custom/coding-router:max");
			expect(result.resolvedThinkingLevel).toBe(collide ? ThinkingLevel.Max : level);
			expect(result.resolvedModelIsFallback).toBeFalsy();
		});
	}

	it("keeps a subagent fallback reachable when default uses the same primary model", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let candidates: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options?.settings || !options.sessionManager) throw new Error("Expected child settings and history");
			const recovery = new TurnRecovery({
				model: () => primary,
				thinkingLevel: () => undefined,
				sessionManager: options.sessionManager,
				settings: options.settings,
				modelRegistry: {
					find: (provider: string, id: string) =>
						[primary, fallback].find(m => m.provider === provider && m.id === id),
					hasProvider: () => true,
					getAvailable: () => [primary, fallback],
				},
				configWarnings: [],
			} as unknown as TurnRecoveryHost);
			return {
				session: createYieldingSession("none", async () => {
					const selector = "primary/bad-runtime-model";
					candidates = recovery
						.retryFallbackChainKeys(selector)
						.flatMap(role =>
							recovery.findRetryFallbackCandidates(role, selector).map(candidate => candidate.raw),
						);
				}),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});
		await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "shared-primary",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings: Settings.isolated({
				modelRoles: { default: "primary/bad-runtime-model" },
				"retry.fallbackChains": { default: [] },
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});
		expect(candidates).toEqual(["fallback/working-model"]);
	});

	it("passes ordered subagent candidates as a child retry fallback chain", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["global/inherited-model"],
			},
		});
		settings.setModelRole("default", "primary/bad-runtime-model");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		let firstFallbackRole: string | undefined;
		let subagentFallbackChain: string[] | undefined;
		let inheritedFallbackChain: string[] | undefined;
		for (const role in childFallbackChains) {
			const chain = childFallbackChains[role];
			if (!firstFallbackRole) {
				firstFallbackRole = role;
			}
			if (role === "subagent:issue-2750") {
				subagentFallbackChain = chain;
			}
			if (role === "default") {
				inheritedFallbackChain = chain;
			}
		}
		expect(firstFallbackRole).toBe("subagent:issue-2750");
		expect(subagentFallbackChain).toEqual(["fallback/working-model"]);
		expect(inheritedFallbackChain).toEqual(["global/inherited-model"]);
		expect(result.modelOverride).toEqual(["primary/bad-runtime-model", "fallback/working-model"]);
		expect(result.resolvedModel).toBe("fallback/working-model");
		expect(result.resolvedModelIsFallback).toBe(true);
	});

	it("persists the installed subagent fallback role for cold revival (#13789)", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let persisted: RetryFallbackRole | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const session = createYieldingSession("none");
			vi.spyOn(session.sessionManager, "appendSessionInit").mockImplementation(init => {
				persisted = init.retryFallback;
				return "session-init";
			});
			return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
		});
		await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "issue-13789",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings: Settings.isolated({}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});
		expect(persisted).toEqual({ primary: "primary/bad-runtime-model", chain: ["fallback/working-model"] });
	});

	it("does not attribute the run to a fallback that never served a turn", async () => {
		// The incident shape: the primary does all the work, a transient error
		// routes the child onto a chain candidate, and that candidate errors on its
		// first request. Crediting the run to it reports 0 tokens of its output as
		// the whole run — to the Agent Hub row and, via the hub job snapshot, to
		// the parent model.
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			return {
				session: createYieldingSession("unproven"),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({});
		settings.setModelRole("default", "primary/bad-runtime-model");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "unproven-fallback",
			modelOverride: ["primary/bad-runtime-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("primary/bad-runtime-model");
		expect(result.resolvedModelIsFallback).toBeFalsy();
	});

	it("inherits an explicitly configured default fallback chain for a single subagent model", async () => {
		const primary = model("lm-studio", "local-reviewer");
		const fallback = model("openai-codex", "gpt-5.6-sol");
		let childFallbackChains: Record<string, string[]> | undefined;
		let childFallbackChainKeys: string[] = [];
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			childFallbackChainKeys = Object.keys(childFallbackChains ?? {});
			childModelRole = options.settings?.getModelRoles()["subagent:single-model-configured-fallback"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "single-model-configured-fallback",
			modelOverride: "lm-studio/local-reviewer",
			settings: Settings.isolated({
				modelRoles: { "existing-local-role": "lm-studio/local-reviewer" },
				"retry.fallbackChains": {
					default: ["openai-codex/gpt-5.6-sol"],
					"existing-local-role": ["other-provider/other-model"],
				},
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBe("lm-studio/local-reviewer");
		expect(childFallbackChainKeys[0]).toBe("subagent:single-model-configured-fallback");
		expect(childFallbackChains?.["subagent:single-model-configured-fallback"]).toEqual(["openai-codex/gpt-5.6-sol"]);
		expect(childFallbackChains?.default).toEqual(["openai-codex/gpt-5.6-sol"]);
		expect(childFallbackChains?.["existing-local-role"]).toEqual(["other-provider/other-model"]);
	});

	it("inherits the aliased role's chain, not the default chain, for a role-alias subagent model", async () => {
		const fast = model("fast", "hy3");
		const slow = model("slow", "opus");
		let childFallbackChains: Record<string, string[]> | undefined;
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			childModelRole = options.settings?.getModelRoles()["subagent:role-alias-chain"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		// Direct executor callers may still pass an unexpanded agent role alias.
		const agent: AgentDefinition = {
			name: "scout",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
			model: ["@smol"],
		};
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "role-alias-chain",
			settings: Settings.isolated({
				modelRoles: { default: "slow/opus", smol: "fast/hy3" },
				"retry.fallbackChains": {
					default: ["slow/opus-backup"],
					smol: ["fast/composer"],
				},
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [fast, slow],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBe("fast/hy3");
		expect(childFallbackChains?.["subagent:role-alias-chain"]).toEqual(["fast/composer"]);
		expect(childFallbackChains?.default).toEqual(["slow/opus-backup"]);
	});

	it("inherits the aliased role's chain when the spawn path pre-expands the alias", async () => {
		// The real task flow (structured-subagent) resolves `@task` to a concrete
		// selector before calling the executor and carries the role identity in
		// `modelRole`. Re-deriving the role from the expanded patterns yields
		// nothing, so the child must route off `modelRole`, not `default`.
		const roleModel = model("task-provider", "sonnet");
		const defaultModel = model("default-provider", "opus");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = {
			name: "task",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
			model: ["@task"],
		};
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "pre-expanded-role",
			modelOverride: ["task-provider/sonnet"],
			modelRole: "task",
			settings: Settings.isolated({
				modelRoles: { default: "default-provider/opus", task: "task-provider/sonnet" },
				"retry.fallbackChains": {
					default: ["task-provider/sonnet", "default-provider/sol"],
					task: ["task-provider/sonnet"],
				},
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [roleModel, defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:pre-expanded-role"]).toEqual(["task-provider/sonnet"]);
	});

	it("inherits the default chain for a role alias whose role configures no chain", async () => {
		const fast = model("fast", "hy3");
		const slow = model("slow", "opus");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = {
			name: "scout",
			description: "test",
			systemPrompt: "test",
			source: "bundled",
			model: ["@smol"],
		};
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "role-alias-default-chain",
			settings: Settings.isolated({
				modelRoles: { default: "slow/opus", smol: "fast/hy3" },
				"retry.fallbackChains": { default: ["slow/opus-backup"] },
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [fast, slow],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:role-alias-default-chain"]).toEqual(["slow/opus-backup"]);
	});

	it("does not inherit the default chain when multiple requested models collapse to one candidate", async () => {
		const primary = model("lm-studio", "local-reviewer");
		const fallback = model("openai-codex", "gpt-5.6-sol");
		let childFallbackChains: unknown;
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined;
			childModelRole = options.settings?.getModelRoles()["subagent:collapsed-multiple-models"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["openai-codex/gpt-5.6-sol"],
			},
		});
		settings.setModelRole("default", "openai-codex/gpt-5.6-sol");
		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "collapsed-multiple-models",
			modelOverride: ["missing/provider", "lm-studio/local-reviewer"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBeUndefined();
		expect(childFallbackChains).toEqual({
			default: ["openai-codex/gpt-5.6-sol"],
		});
	});

	it("keeps a single local subagent model pinned without a configured fallback chain", async () => {
		const primary = model("lm-studio", "local-reviewer");
		const parent = model("openai-codex", "gpt-5.6-sol");
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModelRole = options.settings?.getModelRoles()["subagent:single-model-no-fallback"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "single-model-no-fallback",
			modelOverride: "lm-studio/local-reviewer",
			parentActiveModelPattern: "openai-codex/gpt-5.6-sol",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, parent],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBeUndefined();
	});

	it("leaves malformed default fallback entries for child validation", async () => {
		const primary = model("lm-studio", "local-reviewer");
		let childFallbackChains: unknown;
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined;
			childModelRole = options.settings?.getModelRoles()["subagent:single-model-invalid-default-fallback"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "single-model-invalid-default-fallback",
			modelOverride: "lm-studio/local-reviewer",
			settings: Settings.isolated({ "retry.fallbackChains": { default: [123] } as never }),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains).toEqual({ default: [123] });
		expect(childModelRole).toBeUndefined();
	});

	it("preserves upstream routing selectors in the child retry fallback chain", async () => {
		const routedModel = model("openrouter", "z-ai/glm-4.7");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = (options.settings ? cfgRetryFallbackChains.get(options.settings) : undefined) as
				| Record<string, string[]>
				| undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750-routed",
			modelOverride: ["openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@fireworks"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [routedModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:issue-2750-routed"]).toEqual(["openrouter/z-ai/glm-4.7@fireworks"]);
	});

	it("defers unresolved explicit subagent model selectors instead of picking an available default", async () => {
		const defaultModel = model("zai", "glm-5.2");
		let childModel: Model | undefined;
		let childModelPattern: unknown;
		let childModelPatternParentFallback: unknown;
		let childModelPatternFallbackRole: unknown;
		let childModelPatternDefaultFallbackChain: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			childModelPatternParentFallback = options.modelPatternParentFallback;
			childModelPatternFallbackRole = options.modelPatternFallbackRole;
			childModelPatternDefaultFallbackChain = options.modelPatternDefaultFallbackChain;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-4421",
			modelOverride: ["openai-codex/gpt-5.5:auto"],
			parentActiveModelPattern: "openai-codex/gpt-5.5",
			settings: Settings.isolated({
				"retry.fallbackChains": {
					default: ["openai-codex/gpt-5.6-sol"],
				},
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModel).toBeUndefined();
		expect(childModelPattern).toEqual(["openai-codex/gpt-5.5:auto"]);
		expect(childModelPatternParentFallback).toBe("openai-codex/gpt-5.5");
		expect(childModelPatternFallbackRole).toBe("subagent:issue-4421");
		expect(childModelPatternDefaultFallbackChain).toEqual(["openai-codex/gpt-5.6-sol"]);
	});
});

describe("subagent runtime fallback on a real provider error", () => {
	const MOCK_API_SOURCE = "test/issue-2750-subagent-runtime-fallback";
	const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const OVERLOADED = "overloaded_error: provider returned error 503";
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

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-empty-fallback-chain-"));
		// Project discovery walks up from cwd to os.homedir(); keep both inside the fake HOME.
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
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
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		// The child opened agent.db and models.db under root; Windows cannot delete open files.
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	/**
	 * Spawns a real `pinned-worker` child whose role shares the `default` model. The primary
	 * fails every request with a retryable error; `default`'s chain names a fallback that yields.
	 */
	async function runPinnedWorker(id: string, roleChain: string[] | undefined) {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("primary", "test-key");
		authStorage.keys.setRuntime("fallback", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const primary = createMockModel({
			provider: "primary",
			id: "bad-runtime-model",
			handler: () => ({ throw: OVERLOADED }),
		});
		const fallback = createMockModel({
			provider: "fallback",
			id: "working-model",
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["ok"] }
					: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "recovered" } }] },
		});
		const mocks = [primary, fallback];
		const find = modelRegistry.find.bind(modelRegistry);
		vi.spyOn(modelRegistry, "find").mockImplementation(
			(provider, modelId) => mocks.find(m => m.provider === provider && m.id === modelId) ?? find(provider, modelId),
		);
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(
			provider => mocks.some(m => m.provider === provider) || hasProvider(provider),
		);
		const available = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...available(kind)]);
		try {
			const result = await runSubprocess({
				cwd: path.join(root, "home", "work"),
				agent: {
					name: "pinned-worker",
					description: "test",
					systemPrompt: "test",
					tools: ["read"],
					source: "bundled",
					model: ["@pinned-worker"],
				},
				task: "work",
				index: 0,
				id,
				modelOverride: ["primary/bad-runtime-model"],
				modelRole: "pinned-worker",
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.baseDelayMs": 1,
					"retry.maxRetries": 2,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: {
						default: "primary/bad-runtime-model",
						"pinned-worker": "primary/bad-runtime-model",
					},
					"retry.fallbackChains": {
						default: ["fallback/working-model"],
						...(roleChain ? { "pinned-worker": roleChain } : {}),
					},
				}),
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			return { result, primaryRequests: primary.calls.length, fallbackRequests: fallback.calls.length };
		} finally {
			authStorage.close();
		}
	}

	it("surfaces the primary's error without a fallback request when the role chain is explicitly empty", async () => {
		const { result, primaryRequests, fallbackRequests } = await runPinnedWorker("EmptyRoleChain", []);
		expect(primaryRequests).toBeGreaterThan(0);
		expect(fallbackRequests).toBe(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.resolvedModelIsFallback).toBeFalsy();
		expect(result.error).toContain(OVERLOADED);
	});

	it("recovers on the inherited default fallback when the role has no chain", async () => {
		const { result, fallbackRequests } = await runPinnedWorker("UnsetRoleChain", undefined);
		expect(fallbackRequests).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe("fallback/working-model");
		expect(result.resolvedModelIsFallback).toBe(true);
	});

	const NAMED = "anthropic/claude-opus-4";
	const LISTED = "anthropic/claude-sonnet-4";
	const OTHER = "google/gemini-2.5-pro";

	/** A child model that fails every request with {@link OVERLOADED}, or yields at once. */
	function workerModel(selector: string, fails: boolean, contextWindow?: number): MockModel {
		const [provider, id] = selector.split("/");
		if (fails) return createMockModel({ provider, id, contextWindow, handler: () => ({ throw: OVERLOADED }) });
		return createMockModel({
			provider,
			id,
			contextWindow,
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["ok"] }
					: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "recovered" } }] },
		});
	}

	/** A child model that writes a file (the action that arms a prewalk hand-off), then yields. */
	function writerModel(selector: string): MockModel {
		const [provider, id] = selector.split("/");
		return createMockModel({
			provider,
			id,
			handler: context => {
				const results = context.messages.filter(message => message.role === "toolResult").length;
				if (results === 0) {
					return {
						content: [{ type: "toolCall", name: "write", arguments: { path: "notes.txt", content: "notes" } }],
					};
				}
				if (results === 1) {
					return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
				}
				return { content: ["ok"] };
			},
		});
	}

	/** Parent settings for a `named-worker` run; `extra` adds roles, chains and `task.namedModelFallback`. */
	function namedWorkerSettings(extra: Record<string, unknown>): Settings {
		return Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 2,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			...extra,
		});
	}

	/** An auth store with a key for each of `authedProviders`, and a registry that lists exactly `models`. */
	function namedWorkerRegistry(models: MockModel[], authedProviders = models.map(mock => mock.provider)) {
		const authStorage = createInMemoryAuthStorage();
		for (const provider of authedProviders) authStorage.keys.setRuntime(provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const find = modelRegistry.find.bind(modelRegistry);
		vi.spyOn(modelRegistry, "find").mockImplementation(
			(provider, modelId) =>
				models.find(m => m.provider === provider && m.id === modelId) ?? find(provider, modelId),
		);
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(
			provider => models.some(m => m.provider === provider) || hasProvider(provider),
		);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
		return { authStorage, modelRegistry };
	}

	/** Spawns a real child (`named-worker` unless `agentName` says otherwise) that can reach exactly `models`. */
	async function runNamedWorker(
		id: string,
		models: MockModel[],
		settings: Settings,
		spawn: {
			agentName?: string;
			agentModel?: string[];
			modelOverride?: string[];
			modelRole?: string;
			parentActiveModelPattern?: string;
			authedProviders?: string[];
			tools?: string[];
			prewalk?: string;
		},
	) {
		const { authStorage, modelRegistry } = namedWorkerRegistry(models, spawn.authedProviders);
		try {
			return await runSubprocess({
				cwd: path.join(root, "home", "work"),
				agent: {
					name: spawn.agentName ?? "named-worker",
					description: "test",
					systemPrompt: "test",
					tools: spawn.tools ?? ["read"],
					source: "bundled",
					model: spawn.agentModel,
					prewalk: spawn.prewalk,
				},
				task: "work",
				index: 0,
				id,
				modelOverride: spawn.modelOverride,
				modelRole: spawn.modelRole,
				parentActiveModelPattern: spawn.parentActiveModelPattern,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
		} finally {
			authStorage.close();
		}
	}

	/**
	 * Spawns a real child the way the task tool does, through `runStructuredSubagent`: an agent that names no
	 * model, from a parent session whose active model is `parentModel`, so the child inherits that model.
	 */
	async function runInheritingWorker(id: string, models: MockModel[], settings: Settings, parentModel: string) {
		const { authStorage, modelRegistry } = namedWorkerRegistry(models);
		const agent: AgentDefinition = {
			name: "inheriting-worker",
			description: "test",
			systemPrompt: "test",
			tools: ["read"],
			source: "bundled",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const parent = {
			cwd: path.join(root, "home", "work"),
			hasUI: false,
			settings,
			authStorage,
			modelRegistry,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getActiveModelString: () => parentModel,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		} as unknown as ToolSession;
		try {
			const settled = await runStructuredSubagent({
				session: parent,
				invocationKind: "task",
				assignment: "work",
				agent: agent.name,
				identity: { id },
			});
			return settled.result;
		} finally {
			authStorage.close();
		}
	}

	it("fails on a named agent model instead of walking its model-keyed chain when task.namedModelFallback is off", async () => {
		const named = workerModel(NAMED, true);
		const other = workerModel(OTHER, false);
		const result = await runNamedWorker(
			"NamedSingle",
			[named, other],
			namedWorkerSettings({
				"task.namedModelFallback": false,
				modelRoles: { default: NAMED },
				"retry.fallbackChains": { [NAMED]: [OTHER], "anthropic/*": [OTHER], default: [OTHER] },
			}),
			{ agentModel: [NAMED] },
		);
		expect(named.calls.length).toBeGreaterThan(0);
		expect(other.calls).toHaveLength(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.resolvedModelIsFallback).toBeFalsy();
		expect(result.error).toContain(`[${NAMED}]`);
		expect(result.error).toContain(OVERLOADED);
	});

	it("falls back only to the later entries of a named model list when task.namedModelFallback is off", async () => {
		const named = workerModel(NAMED, true);
		const listed = workerModel(LISTED, true);
		const other = workerModel(OTHER, false);
		const result = await runNamedWorker(
			"NamedList",
			[named, listed, other],
			namedWorkerSettings({
				"task.namedModelFallback": false,
				"retry.fallbackChains": { [NAMED]: [OTHER], [LISTED]: [OTHER], default: [OTHER] },
			}),
			{ modelOverride: [NAMED, LISTED] },
		);
		expect(named.calls.length).toBeGreaterThan(0);
		expect(listed.calls.length).toBeGreaterThan(0);
		expect(other.calls).toHaveLength(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.error).toContain(`[${LISTED}]`);
		expect(result.error).toContain(OVERLOADED);
	});

	it("keeps a role alias on its role's chain when task.namedModelFallback is off", async () => {
		const named = workerModel(NAMED, true);
		const other = workerModel(OTHER, false);
		const result = await runNamedWorker(
			"RoleAlias",
			[named, other],
			namedWorkerSettings({
				"task.namedModelFallback": false,
				modelRoles: { "worker-role": NAMED },
				"retry.fallbackChains": { "worker-role": [OTHER] },
			}),
			{ agentModel: ["@worker-role"], modelOverride: [NAMED], modelRole: "worker-role" },
		);
		expect(other.calls.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(OTHER);
		expect(result.resolvedModelIsFallback).toBe(true);
	});

	it("keeps an inherited parent model on its model-keyed chain when task.namedModelFallback is off", async () => {
		const named = workerModel(NAMED, true);
		const other = workerModel(OTHER, false);
		const result = await runInheritingWorker(
			"InheritedModel",
			[named, other],
			namedWorkerSettings({ "task.namedModelFallback": false, "retry.fallbackChains": { [NAMED]: [OTHER] } }),
			NAMED,
		);
		expect(named.calls.length).toBeGreaterThan(0);
		expect(other.calls.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(OTHER);
		expect(result.resolvedModelIsFallback).toBe(true);
	});

	it("keeps the parent session's own model-keyed chain while a named child runs held to its list", async () => {
		const named = workerModel(NAMED, true);
		const other = workerModel(OTHER, false);
		const models = [named, other];
		const settings = namedWorkerSettings({
			"task.namedModelFallback": false,
			modelRoles: { default: NAMED },
			"retry.fallbackChains": { [NAMED]: [OTHER] },
		});
		await runNamedWorker("NamedChildParent", models, settings, { agentModel: [NAMED] });
		const parent = new TurnRecovery(
			{
				model: () => named,
				thinkingLevel: () => undefined,
				sessionManager: {},
				settings,
				modelRegistry: {
					find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
					hasProvider: (provider: string) => models.some(m => m.provider === provider),
					getAvailable: () => models,
				},
				configWarnings: [],
			} as unknown as TurnRecoveryHost,
			{ deferFallbackChainValidation: true },
		);
		const candidates = parent
			.retryFallbackChainKeys(NAMED)
			.flatMap(role => parent.findRetryFallbackCandidates(role, NAMED).map(candidate => candidate.raw));
		expect(candidates).toEqual([OTHER]);
	});

	it("does not move a named model to its context promotion target when task.namedModelFallback is off", async () => {
		const named = Object.assign(
			createMockModel({
				provider: "anthropic",
				id: "claude-opus-4",
				contextWindow: 4_000,
				handler: () => ({ throw: "prompt is too long: 5000 tokens > 4000 maximum" }),
			}),
			{ contextPromotionTarget: OTHER },
		);
		const other = workerModel(OTHER, false, 1_000_000);
		const result = await runNamedWorker(
			"NamedPromotion",
			[named, other],
			namedWorkerSettings({ "task.namedModelFallback": false, "contextPromotion.enabled": true }),
			{ agentModel: [NAMED] },
		);
		expect(other.calls).toHaveLength(0);
		expect(result.exitCode).not.toBe(0);
	});

	it("still walks a named agent model's model-keyed chain by default", async () => {
		const named = workerModel(NAMED, true);
		const other = workerModel(OTHER, false);
		const result = await runNamedWorker(
			"NamedDefault",
			[named, other],
			namedWorkerSettings({ "retry.fallbackChains": { [NAMED]: [OTHER] } }),
			{ agentModel: [NAMED] },
		);
		expect(other.calls.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(OTHER);
		expect(result.resolvedModelIsFallback).toBe(true);
	});

	it("fails spawn naming a named model with no credential instead of substituting the parent when task.namedModelFallback is off", async () => {
		const named = workerModel(NAMED, false);
		const parent = workerModel(OTHER, false);
		const result = await runNamedWorker(
			"NamedNoCredOff",
			[named, parent],
			namedWorkerSettings({ "task.namedModelFallback": false }),
			{ agentModel: [NAMED], parentActiveModelPattern: OTHER, authedProviders: ["google"] },
		);
		expect(named.calls).toHaveLength(0);
		expect(parent.calls).toHaveLength(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.error).toContain(NAMED);
	});

	it("still substitutes the parent's model on missing spawn credentials by default", async () => {
		const named = workerModel(NAMED, false);
		const parent = workerModel(OTHER, false);
		const result = await runNamedWorker("NamedNoCredDefault", [named, parent], namedWorkerSettings({}), {
			agentModel: [NAMED],
			parentActiveModelPattern: OTHER,
			authedProviders: ["google"],
		});
		expect(named.calls).toHaveLength(0);
		expect(parent.calls.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(OTHER);
	});

	/** Each way prewalk reaches a subagent: its frontmatter, `task.agentPrewalk`, and `task.prewalk` (bundled `task` only). */
	const PREWALK_SOURCES = [
		["frontmatter", { prewalk: OTHER }, {}],
		["task.agentPrewalk", {}, { "task.agentPrewalk": { "named-worker": OTHER } }],
		["task.prewalk", { agentName: "task" }, { "task.prewalk": true, modelRoles: { smol: OTHER } }],
	] as const;

	it.each(PREWALK_SOURCES)(
		"does not prewalk a named model to another model when task.namedModelFallback is off (%s)",
		async (_label, spawn, extra) => {
			const named = writerModel(NAMED);
			const target = writerModel(OTHER);
			const result = await runNamedWorker(
				"NamedPrewalkOff",
				[named, target],
				namedWorkerSettings({ "task.namedModelFallback": false, ...extra }),
				{ agentModel: [NAMED], tools: ["read", "write"], ...spawn },
			);
			expect(target.calls).toHaveLength(0);
			expect(named.calls.length).toBeGreaterThan(1);
			expect(result.exitCode).toBe(0);
			expect(result.resolvedModel).toBe(NAMED);
		},
	);

	it.each(PREWALK_SOURCES)("still prewalks a named model by default (%s)", async (_label, spawn, extra) => {
		const named = writerModel(NAMED);
		const target = writerModel(OTHER);
		const result = await runNamedWorker("NamedPrewalkDefault", [named, target], namedWorkerSettings(extra), {
			agentModel: [NAMED],
			tools: ["read", "write"],
			...spawn,
		});
		expect(named.calls).toHaveLength(1);
		expect(target.calls.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModel).toBe(OTHER);
	});
});
