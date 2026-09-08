import { describe, expect, it } from "bun:test";
import { getPromptCacheExpiryMs } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const TOUCHED_AT_MS = 1_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const THIRTY_MINUTES_MS = 30 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

describe("getPromptCacheExpiryMs", () => {
	it("uses the short cache lifetime for models without a provider-specific policy", () => {
		const model = createMockModel();

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "short" })).toBe(
			TOUCHED_AT_MS + FIVE_MINUTES_MS,
		);
	});

	it("reports an explicitly disabled cache as cold at its last provider request", () => {
		const model = createMockModel();

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "none" })).toBe(
			TOUCHED_AT_MS,
		);
	});

	it("uses ChatGPT's one-hour cache lifetime", () => {
		const model = buildModel({
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		});

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "short" })).toBe(
			TOUCHED_AT_MS + ONE_HOUR_MS,
		);
	});

	it("uses the advertised 30-minute minimum lifetime for current GPT caches", () => {
		const model = buildModel({
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		});

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "short" })).toBe(
			TOUCHED_AT_MS + THIRTY_MINUTES_MS,
		);
		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "long" })).toBe(
			TOUCHED_AT_MS + THIRTY_MINUTES_MS,
		);
	});

	it("uses legacy OpenAI in-memory and extended retention lifetimes", () => {
		const model = buildModel({
			id: "gpt-4.1",
			name: "GPT 4.1",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		});

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "short" })).toBe(
			TOUCHED_AT_MS + FIVE_MINUTES_MS,
		);
		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "long" })).toBe(
			TOUCHED_AT_MS + ONE_DAY_MS,
		);
	});

	it("distinguishes Anthropic short and long cache retention", () => {
		const model = buildModel({
			id: "claude-test",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		});

		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "short" })).toBe(
			TOUCHED_AT_MS + FIVE_MINUTES_MS,
		);
		expect(getPromptCacheExpiryMs({ model, cacheTouchedAtMs: TOUCHED_AT_MS, cacheRetention: "long" })).toBe(
			TOUCHED_AT_MS + ONE_HOUR_MS,
		);
	});
});
