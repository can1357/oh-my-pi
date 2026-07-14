import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { kNoAuth } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/model-resolver";

/**
 * Regression test for #985.
 *
 * Reporter screenshot showed parent session on DeepSeek V4 Pro dispatching a
 * task subagent that resolved to `qwen3.6-plus-free` — an opencode-zen model
 * the user has no working credentials for. The dispatch hit a provider that
 * could not serve the model and surfaced a confusing API rejection instead of
 * silently using the parent's already-authenticated model.
 *
 * The fix: at dispatch time, if the resolved subagent model has no working
 * credentials, fall back to the parent session's active model (which by
 * definition has working auth — the parent turn is using it).
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
	test("falls back to parent active model when resolved subagent model has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
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

/**
 * Priority-list auth walk: `modelRoles.task` (and any subagent model role)
 * already supports a comma-separated ordered list of up to 3 candidates —
 * `normalizeModelPatternList` splits it, `resolveModelOverride` walks it for
 * catalog existence. This block covers the credential-aware counterpart:
 * when priority 1 resolves to a real model with no working credentials,
 * the walk must continue to priority 2, then priority 3, before ever
 * touching the parent's active model — "1 being most intelligent" only
 * behaves as a graceful priority fallback if auth failures are handled the
 * same way catalog-existence failures already are.
 */
const priorityTwoModel: Model<Api> = buildModel({
	id: "priority-two",
	name: "Priority Two",
	api: "openai-completions",
	provider: "nine-router",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const priorityThreeModel: Model<Api> = buildModel({
	id: "priority-three",
	name: "Priority Three",
	api: "openai-completions",
	provider: "minimax-code",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

describe("task role priority list (up to 3 models, priority 1 = most intelligent)", () => {
	test("falls through to priority 2 when priority 1 has no working credentials", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, priorityTwoModel, priorityThreeModel],
			authedProviders: new Set(["deepseek", "nine-router"]), // priority 1 (opencode-zen) unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "nine-router/priority-two", "minimax-code/priority-three"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.fallbackKind).toBe("priority-list");
		expect(result.model?.provider).toBe("nine-router");
		expect(result.model?.id).toBe("priority-two");
	});

	test("falls through to priority 3 when priority 1 and priority 2 both lack credentials", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, priorityTwoModel, priorityThreeModel],
			authedProviders: new Set(["deepseek", "minimax-code"]), // only priority 3 + parent authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "nine-router/priority-two", "minimax-code/priority-three"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.fallbackKind).toBe("priority-list");
		expect(result.model?.provider).toBe("minimax-code");
		expect(result.model?.id).toBe("priority-three");
	});

	test("falls back to the parent model only after every priority-list entry lacks credentials", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, priorityTwoModel, priorityThreeModel],
			authedProviders: new Set(["deepseek"]), // only the parent's provider is authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "nine-router/priority-two", "minimax-code/priority-three"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.fallbackKind).toBe("parent");
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});

	test("does not walk the list when priority 1 already has working credentials", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, priorityTwoModel, priorityThreeModel],
			authedProviders: new Set(["deepseek", "opencode-zen", "nine-router", "minimax-code"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "nine-router/priority-two", "minimax-code/priority-three"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.fallbackKind).toBeUndefined();
		expect(result.model?.provider).toBe("opencode-zen");
	});

	test("skips a duplicate priority-list entry pointing at the same model as priority 1", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, priorityTwoModel],
			authedProviders: new Set(["deepseek", "nine-router"]),
		});

		// Priority 2 is a literal duplicate of priority 1 (same provider/id);
		// the walk must skip it and land on priority 3.
		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "opencode-zen/qwen3.6-plus-free", "nine-router/priority-two"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.fallbackKind).toBe("priority-list");
		expect(result.model?.provider).toBe("nine-router");
		expect(result.model?.id).toBe("priority-two");
	});
});
