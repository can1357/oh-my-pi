import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";

/**
 * Regression test for #985.
 *
 * Reporter screenshot showed parent session on DeepSeek V4 Pro dispatching a
 * task subagent that resolved to `qwen3.6-plus-free` — an opencode-zen model
 * the user has no working credentials for. The dispatch hit a provider that
 * could not serve the model and surfaced a confusing API rejection.
 *
 * The fix: at dispatch time, walk the eligible ladder (all configured
 * patterns) looking for one with working credentials. If none found,
 * return the primary resolution unchanged so the caller's error path
 * surfaces a meaningful failure. NEVER silently inherit the parent's
 * model when explicit patterns were supplied.
 */

const parentModel: Model<Api> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedTaskModel: Model<Api> = buildModel({
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const sharedModel: Model<Api> = buildModel({
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
	} as unknown as ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> };
}

describe("issue #985: subagent dispatch auth fallback", () => {
	test("returns primary unchanged when resolved subagent model has no auth (no parent fallback for explicit patterns)", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Explicit patterns → NEVER parent fallback. Returns unauthed primary
		// so the caller's error path surfaces a meaningful failure.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("does not fall back when resolved subagent model has working auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek", "opencode-zen"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when parent active model also has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when no parent active model is provided", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], undefined, registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
	});

	test("does not fall back when subagent and parent resolve to the same model", async () => {
		const registry = createMockRegistry({
			models: [sharedModel],
			authedProviders: new Set(), // even with no auth, identical model means no benefit
		});

		const result = await resolveModelOverrideWithAuthFallback(["deepseek/shared-id"], "deepseek/shared-id", registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.id).toBe("shared-id");
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials. The helper treats this as authenticated so an explicitly
		// configured local model is never silently rerouted to the parent's
		// remote provider (see #1008).
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
});

describe("issue #5325: sessionId forwarded to getApiKey for session-sticky OAuth", () => {
	// The pre-flight auth check in resolveModelOverrideWithAuthFallback calls
	// getApiKey without a session id. For providers with session-sticky OAuth
	// credentials, this can return undefined even though the credential is
	// usable once the subagent session starts. The fix forwards a sessionId
	// so session-sticky credentials resolve during the pre-flight check.
	test("forwards sessionId to getApiKey for the primary model", async () => {
		let receivedSessionId: string | undefined;
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (model.provider === "opencode-zen") {
					receivedSessionId = sessionId;
					// Without sessionId, OAuth can't resolve; with it, it can.
					return sessionId ? "sk-resolved-token" : undefined;
				}
				if (model.provider === "deepseek") return "sk-test";
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-123",
		);

		expect(receivedSessionId).toBe("subagent-session-123");
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
	test("forwards sessionId to getApiKey for eligible ladder candidates", async () => {
		const receivedSessionIds: string[] = [];
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (sessionId) receivedSessionIds.push(`${model.provider}:${sessionId}`);
				if (model.provider === "opencode-zen") return undefined;
				return sessionId ? "sk-resolved-token" : undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-456",
		);

		// sessionId forwarded to the eligible ladder candidate. No parent
		// fallback for explicit patterns.
		expect(receivedSessionIds).toEqual(["opencode-zen:subagent-session-456"]);
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
	});
	test("preserves the requested model warning when no eligible candidate has auth", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => (model.provider === "deepseek" ? "sk-test" : undefined),
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free:invalid"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Warning preserved, primary returned, no parent fallback.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.warning).toBe(
			'Invalid thinking level "invalid" in pattern "qwen3.6-plus-free:invalid". Using default instead.',
		);
	});

	test("returns primary unchanged when getApiKey returns undefined even with sessionId", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, _sessionId?: string) => {
				if (model.provider === "deepseek") return "sk-test";
				// Genuinely broken: undefined even with sessionId (stale OAuth, revoked token)
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-456",
		);

		// Explicit patterns → no parent fallback even when primary has no auth.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
});

// --- Eligible-ladder boundary tests (subagent auth boundary fix) ---

const authedCheapModel: Model<Api> = buildModel({
	id: "glm-4.7",
	name: "GLM 4.7",
	api: "openai-completions",
	provider: "zhipu",
	baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const keylessLocalModel: Model<Api> = buildModel({
	id: "llama-3.3",
	name: "Llama 3.3",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const frontierModel: Model<Api> = buildModel({
	id: "claude-opus-4",
	name: "Claude Opus 4",
	api: "openai-completions",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});

describe("subagent auth boundary: eligible ladder walk", () => {
	test("cheap single pin missing auth + authenticated expensive parent: NOT parent, returns primary", async () => {
		// Subagent configured with single cheap model, no auth. Parent is
		// expensive but authed. Resolver walks ladder (1 entry, no auth),
		// returns primary unchanged. NEVER falls back to parent when
		// explicit patterns were supplied.
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Explicit patterns → no parent fallback. Returns unauthed primary.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("explicit eligible second cheap candidate: uses ladder candidate instead of parent", async () => {
		// Subagent configured with [cheap-unauthed, cheap-authed]. Resolver
		// walks ladder: first candidate has no auth, second has auth → uses
		// second. Never touches parent model.
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, authedCheapModel],
			authedProviders: new Set(["deepseek", "zhipu"]), // parent + second cheap
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "zhipu/glm-4.7"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Second eligible candidate has auth → uses it, no parent fallback.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("zhipu");
		expect(result.model?.id).toBe("glm-4.7");
	});

	test("all eligible absent: returns primary unchanged when parent also lacks auth", async () => {
		// All eligible candidates and parent have no auth. Resolver returns
		// first eligible candidate unchanged — error path surfaces downstream.
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, authedCheapModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "zhipu/glm-4.7"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// No auth anywhere → returns first eligible candidate unchanged.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("keyless allowed: kNoAuth model stays in eligible ladder without parent fallback", async () => {
		// Keyless local model (ollama) is treated as authenticated (kNoAuth).
		// Even when parent has auth, keyless model wins.
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, keylessLocalModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "ollama") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["ollama/llama-3.3"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Keyless model (kNoAuth) is treated as authenticated → no fallback.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("ollama");
		expect(result.model?.id).toBe("llama-3.3");
	});

	test("explicit frontier request unaffected: single authed pattern resolves directly", async () => {
		// Frontier model (Opus) with auth. No ladder walking needed.
		const registry = createMockRegistry({
			models: [parentModel, frontierModel],
			authedProviders: new Set(["deepseek", "anthropic"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["anthropic/claude-opus-4"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Frontier model has auth → resolves directly.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-opus-4");
	});

	test("eligible ladder skips unauthenticated models until finding authed one", async () => {
		// Three cheap candidates: first two unauthed, third authed.
		const thirdCheapModel: Model<Api> = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo v2.5 Pro",
			api: "openai-completions",
			provider: "xiaomi-token-plan-sgp",
			baseUrl: "https://api.xiaomi.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});

		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, authedCheapModel, thirdCheapModel],
			authedProviders: new Set(["deepseek", "xiaomi-token-plan-sgp"]), // parent + third cheap
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "zhipu/glm-4.7", "xiaomi-token-plan-sgp/mimo-v2.5-pro"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// First two have no auth, third has auth → uses third, no parent fallback.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("xiaomi-token-plan-sgp");
		expect(result.model?.id).toBe("mimo-v2.5-pro");
	});

	test("unresolved cheap selector + authenticated parent: NOT parent, returns undefined", async () => {
		// Model not in registry (stale registry). Resolver can't resolve it.
		// Even with authed parent, explicit patterns → no parent fallback.
		const registry = createMockRegistry({
			models: [parentModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["xiaomi-token-plan-sgp/mimo-v2.5-pro"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		// Model not in registry, no eligible candidate → returns undefined, NOT parent.
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model).toBeUndefined();
	});

	test("empty patterns + authenticated parent: permits parent inheritance", async () => {
		// No explicit patterns. Parent fallback is the ordinary path.
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback([], "deepseek/deepseek-v4-pro", registry);

		// No patterns → parent inheritance allowed.
		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});
});
