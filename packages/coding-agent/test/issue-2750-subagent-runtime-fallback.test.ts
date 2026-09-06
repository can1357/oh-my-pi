import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

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
function createYieldingSession(fallback: "served" | "unproven" = "served"): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "bad-runtime-model"),
		servingModel: { selector: "primary/bad-runtime-model", isFallback: false } as ServingModel | undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
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
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
				isError: false,
			});
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes ordered subagent candidates as a child retry fallback chain", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
			childFallbackChains = options.settings?.get("retry.fallbackChains");
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

	it("preserves malformed fallback configuration for child validation", async () => {
		const primary = model("lm-studio", "local-reviewer");
		let childFallbackChains: unknown;
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains");
			childModelRole = options.settings?.getModelRoles()["subagent:single-model-malformed-fallback"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "single-model-malformed-fallback",
			modelOverride: "lm-studio/local-reviewer",
			settings: Settings.isolated({ "retry.fallbackChains": null as never }),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains).toBeNull();
		expect(childModelRole).toBeUndefined();
	});

	it("leaves malformed default fallback entries for child validation", async () => {
		const primary = model("lm-studio", "local-reviewer");
		let childFallbackChains: unknown;
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains");
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
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
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
		let childModelPatternAuthFallback: unknown;
		let childModelPatternFallbackRole: unknown;
		let childModelPatternDefaultFallbackChain: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			childModelPatternAuthFallback = options.modelPatternAuthFallback;
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
		expect(childModelPatternAuthFallback).toBe("openai-codex/gpt-5.5");
		expect(childModelPatternFallbackRole).toBe("subagent:issue-4421");
		expect(childModelPatternDefaultFallbackChain).toEqual(["openai-codex/gpt-5.6-sol"]);
	});
});
