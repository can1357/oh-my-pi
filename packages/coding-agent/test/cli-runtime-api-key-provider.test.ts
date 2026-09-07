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

	test("parses provider from --model provider/id", () => {
		expect(resolveCliRuntimeApiKeyProvider({ model: "grokbot/composer-2.5" })).toBe("grokbot");
	});

	test("parses provider from the first --models selector", () => {
		expect(resolveCliRuntimeApiKeyProvider({ models: ["grokbot/sand-default", "openai/gpt-4o"] })).toBe("grokbot");
	});

	test("returns undefined for bare model ids without --provider", () => {
		expect(resolveCliRuntimeApiKeyProvider({ model: "composer-2.5" })).toBeUndefined();
	});
});
