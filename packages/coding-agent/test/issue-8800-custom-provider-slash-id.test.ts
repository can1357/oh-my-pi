import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseModelPattern, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

// Issue #8800: a custom (models.yml) provider model whose literal id contains a
// slash, e.g. "deepseek/deepseek-v4-flash", must resolve to the custom provider
// instead of being provider-locked and re-routed to the built-in provider named
// by the prefix. The provider lock exists to stop bundled aggregator copies
// (OpenRouter) from shadowing provider-qualified selectors; a user-configured
// custom provider carries no bundled catalog, so the lock must never fire on it.

const customProxyOpus = buildModel({
	id: "anthropic/claude-opus-5",
	name: "Claude Opus 5 (Custom Proxy)",
	api: "anthropic-messages",
	provider: "my-proxy",
	baseUrl: "https://proxy.example.com/v1",
	reasoning: true,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 200000,
	maxTokens: 32000,
});

const openRouterOpus = buildModel({
	id: "anthropic/claude-opus-5",
	name: "Claude Opus 5 (OpenRouter)",
	api: "anthropic-messages",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200000,
	maxTokens: 32000,
});

describe("custom provider model ids containing a slash (#8800)", () => {
	test("a custom provider's literal slash id resolves to the custom provider", () => {
		// "anthropic" is a bundled provider that carries "claude-opus-5", so the
		// pre-fix lock swallowed this exact-id match and resolution fell through
		// to the provider-prefix strip, misrouting the request to the built-in
		// provider instead of the custom one the user configured.
		const result = parseModelPattern("anthropic/claude-opus-5", [customProxyOpus]);
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
	});

	test("resolveCliModel routes the slash id to the custom provider", () => {
		const result = resolveCliModel({
			cliModel: "anthropic/claude-opus-5",
			modelRegistry: {
				getAll: () => [customProxyOpus],
				getAvailable: () => [customProxyOpus],
			},
		});
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
		expect(result.error).toBeUndefined();
	});

	test("the aggregator lock still holds for bundled providers (OpenRouter shadow)", () => {
		// The exemption is scoped to providers with no bundled catalog: the
		// OpenRouter copy of a provider-qualified selector stays locked out,
		// exactly as pinned by the existing aggregator-shadow tests.
		const result = parseModelPattern("anthropic/claude-opus-5", [openRouterOpus]);
		expect(result.model).toBeUndefined();
	});

	test("an explicit custom-provider reference keeps working", () => {
		const result = parseModelPattern("my-proxy/anthropic/claude-opus-5", [customProxyOpus]);
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
	});
});
