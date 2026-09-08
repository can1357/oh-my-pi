import { describe, expect, test } from "bun:test";
import { resolveCliRuntimeApiKeyProvider } from "../src/cli/runtime-api-key";

describe("resolveCliRuntimeApiKeyProvider", () => {
	test("prefers --provider over model path segments", () => {
		expect(
			resolveCliRuntimeApiKeyProvider({
				provider: "grokbot",
				model: "openai/gpt-4o",
			}),
		).toBe("grokbot");
	});

	test("requires --model when binding via --provider", () => {
		expect(resolveCliRuntimeApiKeyProvider({ provider: "grokbot" })).toBeUndefined();
		expect(
			resolveCliRuntimeApiKeyProvider({
				provider: "grokbot",
				models: ["grokbot/sand-default"],
			}),
		).toBeUndefined();
		expect(
			resolveCliRuntimeApiKeyProvider({
				provider: "grokbot",
				models: ["openai/gpt-4o"],
			}),
		).toBeUndefined();
		expect(
			resolveCliRuntimeApiKeyProvider({
				provider: "grokbot",
				model: "sand-default",
			}),
		).toBe("grokbot");
	});

	test("parses provider from --model provider/id", () => {
		expect(resolveCliRuntimeApiKeyProvider({ model: "grokbot/composer-2.5" })).toBe("grokbot");
		expect(resolveCliRuntimeApiKeyProvider({ model: "GrokBot/composer-2.5" })).toBe("grokbot");
	});

	test("normalizes --provider casing for AuthStorage keys", () => {
		expect(
			resolveCliRuntimeApiKeyProvider({
				provider: "GrokBot",
				model: "sand-default",
			}),
		).toBe("grokbot");
	});

	test("binds --models only when every selector is qualified and shares one provider", () => {
		expect(resolveCliRuntimeApiKeyProvider({ models: ["grokbot/sand-default", "grokbot/composer-2.5"] })).toBe(
			"grokbot",
		);
		expect(resolveCliRuntimeApiKeyProvider({ models: ["grokbot/sand-default", "openai/gpt-4o"] })).toBeUndefined();
		expect(resolveCliRuntimeApiKeyProvider({ models: ["grokbot/sand-default", "gpt-4o"] })).toBeUndefined();
	});

	test("returns undefined for bare model ids without --provider", () => {
		expect(resolveCliRuntimeApiKeyProvider({ model: "composer-2.5" })).toBeUndefined();
	});

	test("does not derive key ownership from --models when --model is bare", () => {
		expect(
			resolveCliRuntimeApiKeyProvider({
				model: "gpt-4o",
				models: ["grokbot/sand-default"],
			}),
		).toBeUndefined();
	});
});
